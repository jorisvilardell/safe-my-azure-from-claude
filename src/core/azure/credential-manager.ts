import type { AccessToken, GetTokenOptions, TokenCredential } from '@azure/core-auth';
import { DeviceCodeCredential, type DeviceCodeInfo } from '@azure/identity';
import type { AzureContext } from '../config/index.js';
import { AppError } from '../errors/index.js';
import type { Logger } from '../logging/index.js';
import type { CredentialProvider } from './contracts.js';

export const ARM_SCOPE = 'https://management.azure.com/.default';

/** Entra ID device codes expire after 15 minutes; `DeviceCodeInfo` does not carry the expiry. */
const DEVICE_CODE_TTL_MS = 15 * 60_000;

/**
 * `@azure/identity` keeps one in-memory MSAL cache for CAE requests and another for non-CAE ones.
 * The Azure SDK pipelines always ask with `enableCae: true`, so the login must fill that cache and
 * every token request must use it: otherwise the first SDK call finds no account and fails.
 */
const CAE = { enableCae: true } as const;

/** What the credential factory must return. `DeviceCodeCredential` satisfies it. */
export interface LoginCredential extends TokenCredential {
  /** Runs the interactive (device-code) flow. */
  authenticate(scopes: string | string[], options?: GetTokenOptions): Promise<unknown>;
}

export interface CredentialFactoryOptions {
  readonly tenantId: string;
  /** Receives the user code. It must only ever reach the admin API (ADR 0001 §2, AGENTS.md G1). */
  readonly onDeviceCode: (info: DeviceCodeInfo) => void;
}

export type CredentialFactory = (opts: CredentialFactoryOptions) => LoginCredential;

/**
 * Default public client (no app registration). No `tokenCachePersistenceOptions`: the MSAL
 * cache stays in this object's memory (AGENTS.md R8). `disableAutomaticAuthentication` makes
 * `getToken` fail instead of silently starting a new device-code flow behind a tool call.
 */
export const createDeviceCodeCredential: CredentialFactory = ({ tenantId, onDeviceCode }) =>
  new DeviceCodeCredential({
    tenantId,
    userPromptCallback: onDeviceCode,
    disableAutomaticAuthentication: true,
  });

export type LoginState = 'starting' | 'waiting' | 'failed' | 'expired';

/** A login in progress. Holds the user code: server-side and admin API only, never a tool result. */
export interface PendingLogin {
  readonly alias: string;
  readonly state: LoginState;
  readonly userCode?: string;
  readonly verificationUri?: string;
  /** Epoch ms. */
  readonly expiresOn?: number;
}

/** Safe to return to the AI: flags and minutes only, no token, code or account. */
export interface LoginStatus {
  readonly alias: string;
  readonly loggedIn: boolean;
  readonly loginPending: boolean;
  readonly loginFailed: boolean;
  readonly expiresInMinutes?: number;
}

export type StartLoginResult = 'started' | 'already-pending' | 'already-logged-in';

/**
 * The login lifecycle, as the contexts feature (AI-facing) sees it: it cannot start a device-code
 * flow, and nothing here exposes a code or token.
 */
export interface LoginController {
  logout(alias: string): void;
  status(alias: string): LoginStatus;
}

/** What `GET /admin/login/:context` reports. `none`: no login was started (or it was logged out). */
export type AdminLoginState = 'none' | 'pending' | 'succeeded' | 'failed' | 'expired';

/** Admin API only (`/admin/*`, human CLI). This is the only interface that hands out a user code. */
export interface AdminLogins extends LoginController {
  /** Starts a device-code flow. Throws `AppError('UnknownContext')`. */
  startLogin(alias: string): StartLoginResult;
  /** The pending login of a context, with its user code once Entra ID sent it. */
  pendingLogin(alias: string): PendingLogin | undefined;
  /**
   * Resolves once the pending login of `alias` has its user code, has failed, or after
   * `timeoutMs`, with the pending login at that time.
   */
  waitForDeviceCode(alias: string, timeoutMs: number): Promise<PendingLogin | undefined>;
  loginState(alias: string): AdminLoginState;
}

/** `logout` also covers a session that expired (the refresh token is no longer valid). */
export type SessionChange = 'login' | 'logout';

export interface CredentialManager extends CredentialProvider, AdminLogins {
  /** Called after a context logs in or out, e.g. to build or drop its inventory index. */
  onSessionChange(listener: (alias: string, change: SessionChange) => void): void;
}

export interface CredentialManagerDeps {
  readonly contexts: Readonly<Record<string, AzureContext>>;
  readonly logger: Logger;
  readonly factory?: CredentialFactory;
  readonly now?: () => number;
}

interface Entry {
  readonly credential: LoginCredential;
  readonly wrapped: TokenCredential;
  readonly abort: AbortController;
  loggedIn: boolean;
  pending: PendingLogin | undefined;
  tokenExpiresOn: number | undefined;
  /** Called when the user code arrives or the login settles (see waitForDeviceCode). */
  readonly codeWaiters: Set<() => void>;
}

const isAuthRequired = (err: unknown): boolean =>
  err instanceof Error && err.name === 'AuthenticationRequiredError';

/** One in-memory device-code credential per context alias. */
export function createCredentialManager(deps: CredentialManagerDeps): CredentialManager {
  const factory = deps.factory ?? createDeviceCodeCredential;
  const now = deps.now ?? Date.now;
  const entries = new Map<string, Entry>();
  const listeners: ((alias: string, change: SessionChange) => void)[] = [];

  const emit = (alias: string, change: SessionChange): void => {
    for (const listener of listeners) {
      try {
        listener(alias, change);
      } catch {
        // A listener must never break a login or a logout.
        deps.logger.warn('session listener failed', { context: alias });
      }
    }
  };

  const tenantOf = (alias: string): string => {
    const ctx = Object.hasOwn(deps.contexts, alias) ? deps.contexts[alias] : undefined;
    if (ctx === undefined) {
      const known = Object.keys(deps.contexts).join(', ') || '(none)';
      throw new AppError('UnknownContext', `Unknown context "${alias}". Known contexts: ${known}.`);
    }
    return ctx.tenantId;
  };

  const isCurrent = (alias: string, entry: Entry): boolean => entries.get(alias) === entry;

  const recordToken = (entry: Entry, token: AccessToken | null): void => {
    if (token !== null) entry.tokenExpiresOn = token.expiresOnTimestamp;
  };

  const createEntry = (alias: string, tenantId: string): Entry => {
    const abort = new AbortController();
    const entry: Entry = {
      abort,
      loggedIn: false,
      pending: { alias, state: 'starting' },
      tokenExpiresOn: undefined,
      codeWaiters: new Set(),
      credential: factory({
        tenantId,
        onDeviceCode: (info) => {
          // Deliberately not logged: the user code is a login secret (AGENTS.md G1).
          if (!isCurrent(alias, entry)) return;
          entry.pending = {
            alias,
            state: 'waiting',
            userCode: info.userCode,
            verificationUri: info.verificationUri,
            expiresOn: now() + DEVICE_CODE_TTL_MS,
          };
          notifyCode(entry);
        },
      }),
      wrapped: {
        getToken: async (scopes, options) => {
          try {
            const token = await entry.credential.getToken(scopes, { ...options, ...CAE });
            recordToken(entry, token);
            return token;
          } catch (err) {
            if (!isAuthRequired(err)) throw err;
            if (isCurrent(alias, entry) && entry.loggedIn) {
              entry.loggedIn = false;
              emit(alias, 'logout');
            }
            throw new AppError(
              'NotLoggedIn',
              `The session for context "${alias}" has expired. Ask the user to run \`safe-azure login ${alias}\` in their own terminal.`,
            );
          }
        },
      },
    };
    return entry;
  };

  const notifyCode = (entry: Entry): void => {
    for (const waiter of entry.codeWaiters) waiter();
    entry.codeWaiters.clear();
  };

  const runLogin = async (alias: string, entry: Entry): Promise<void> => {
    try {
      await authenticate(alias, entry);
    } finally {
      notifyCode(entry);
    }
  };

  const authenticate = async (alias: string, entry: Entry): Promise<void> => {
    try {
      await entry.credential.authenticate(ARM_SCOPE, { abortSignal: entry.abort.signal, ...CAE });
      recordToken(
        entry,
        await entry.credential.getToken(ARM_SCOPE, { abortSignal: entry.abort.signal, ...CAE }),
      );
      if (!isCurrent(alias, entry)) return;
      entry.loggedIn = true;
      entry.pending = undefined;
      deps.logger.info('login succeeded', { context: alias });
      emit(alias, 'login');
    } catch {
      // The SDK error is dropped on purpose: it may echo the device-code response.
      if (!isCurrent(alias, entry)) return;
      const expiresOn = entry.pending?.expiresOn;
      const expired = expiresOn !== undefined && now() >= expiresOn;
      entry.pending = { alias, state: expired ? 'expired' : 'failed' };
      deps.logger.warn('login failed', { context: alias, reason: expired ? 'expired' : 'failed' });
    }
  };

  const loggedInEntry = (alias: string): Entry | undefined => {
    const entry = entries.get(alias);
    return entry?.loggedIn === true ? entry : undefined;
  };

  return {
    isLoggedIn: (alias) => loggedInEntry(alias) !== undefined,

    getCredential(alias) {
      tenantOf(alias);
      const entry = loggedInEntry(alias);
      if (entry === undefined) {
        throw new AppError(
          'NotLoggedIn',
          `Context "${alias}" is not logged in. Ask the user to run \`safe-azure login ${alias}\` in their own terminal.`,
        );
      }
      return entry.wrapped;
    },

    startLogin(alias) {
      const tenantId = tenantOf(alias);
      const existing = entries.get(alias);
      if (existing?.loggedIn === true) return 'already-logged-in';
      const pending = existing?.pending;
      const codeExpired = pending?.expiresOn !== undefined && now() >= pending.expiresOn;
      if ((pending?.state === 'starting' || pending?.state === 'waiting') && !codeExpired) {
        return 'already-pending';
      }

      existing?.abort.abort();
      const entry = createEntry(alias, tenantId);
      entries.set(alias, entry);
      deps.logger.info('login started', { context: alias });
      void runLogin(alias, entry);
      return 'started';
    },

    logout(alias) {
      tenantOf(alias);
      const entry = entries.get(alias);
      if (entry === undefined) return;
      entries.delete(alias);
      entry.abort.abort();
      notifyCode(entry);
      deps.logger.info('logged out', { context: alias });
      emit(alias, 'logout');
    },

    onSessionChange(listener) {
      listeners.push(listener);
    },

    status(alias) {
      tenantOf(alias);
      const entry = entries.get(alias);
      const state = entry?.pending?.state;
      const status: LoginStatus = {
        alias,
        loggedIn: entry?.loggedIn === true,
        loginPending: state === 'starting' || state === 'waiting',
        loginFailed: state === 'failed' || state === 'expired',
      };
      const expiresOn = entry?.loggedIn === true ? entry.tokenExpiresOn : undefined;
      if (expiresOn === undefined) return status;
      return { ...status, expiresInMinutes: Math.max(0, Math.floor((expiresOn - now()) / 60_000)) };
    },

    pendingLogin(alias) {
      tenantOf(alias);
      return entries.get(alias)?.pending;
    },

    waitForDeviceCode(alias, timeoutMs) {
      tenantOf(alias);
      const entry = entries.get(alias);
      if (entry?.pending?.state !== 'starting') return Promise.resolve(entry?.pending);
      return new Promise((resolve) => {
        const done = (): void => {
          clearTimeout(timer);
          entry.codeWaiters.delete(done);
          resolve(entries.get(alias)?.pending);
        };
        const timer = setTimeout(done, timeoutMs);
        entry.codeWaiters.add(done);
      });
    },

    loginState(alias) {
      tenantOf(alias);
      const entry = entries.get(alias);
      if (entry === undefined) return 'none';
      if (entry.loggedIn) return 'succeeded';
      const pending = entry.pending;
      if (pending === undefined) return 'none';
      if (pending.state === 'failed' || pending.state === 'expired') return pending.state;
      return pending.expiresOn !== undefined && now() >= pending.expiresOn ? 'expired' : 'pending';
    },
  };
}
