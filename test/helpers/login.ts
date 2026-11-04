import type { AccessToken, GetTokenOptions } from '@azure/core-auth';
import { createAnonymizer } from '../../src/core/anonymizer/index.js';
import {
  createAzureAccess,
  createContextStore,
  createCredentialManager,
  type AzureAccess,
  type CredentialFactory,
  type CredentialManager,
  type LoginCredential,
} from '../../src/core/azure/index.js';
import { contextIdAliases } from '../../src/core/config/index.js';
import { createLogger } from '../../src/core/logging/index.js';
import type { ToolContext } from '../../src/core/mcp/index.js';
import { createFakeClientFactory, FAKE_ACCESS_TOKEN, FAKE_CONTEXTS } from './azure.js';

/** Device-code-shaped but fake. Tests assert it never reaches a tool result or a log. */
export const FAKE_USER_CODE = 'FAKEUC7Q2';
export const FAKE_VERIFICATION_URI = 'https://microsoft.com/devicelogin';

interface PendingAuth {
  readonly tenantId: string;
  readonly resolve: () => void;
  readonly reject: (err: Error) => void;
}

export interface StubLogin {
  readonly factory: CredentialFactory;
  /** Tenant IDs of every credential the factory created. */
  readonly created: string[];
  /** Completes the oldest pending device-code flow (the user signed in). */
  approve(): void;
  /** Fails the oldest pending device-code flow. */
  fail(err?: Error): void;
  /** Makes subsequent silent `getToken` calls fail as if the refresh token expired. */
  expireSession(): void;
  readonly pendingCount: () => number;
}

export interface StubLoginOptions {
  readonly userCode?: string;
  readonly verificationUri?: string;
  readonly tokenLifetimeMs?: number;
}

/** Replaces `DeviceCodeCredential`: no network, no MSAL. */
export function createStubLogin(opts: StubLoginOptions = {}): StubLogin {
  const userCode = opts.userCode ?? FAKE_USER_CODE;
  const verificationUri = opts.verificationUri ?? FAKE_VERIFICATION_URI;
  const lifetime = opts.tokenLifetimeMs ?? 30.5 * 60_000;
  const pending: PendingAuth[] = [];
  const created: string[] = [];
  let sessionExpired = false;

  const factory: CredentialFactory = ({ tenantId, onDeviceCode }) => {
    created.push(tenantId);
    let authenticated = false;
    const credential: LoginCredential = {
      authenticate: (_scopes, options?: GetTokenOptions) =>
        new Promise<void>((resolve, reject) => {
          onDeviceCode({
            userCode,
            verificationUri,
            message: `To sign in, open ${verificationUri} and enter the code ${userCode}.`,
          });
          options?.abortSignal?.addEventListener('abort', () => {
            reject(new Error('aborted'));
          });
          pending.push({
            tenantId,
            resolve: () => {
              authenticated = true;
              resolve();
            },
            reject,
          });
        }),
      getToken: (): Promise<AccessToken> => {
        if (!authenticated || sessionExpired) {
          const err = new Error(`Token for ${tenantId} requires interaction, code ${userCode}`);
          err.name = 'AuthenticationRequiredError';
          return Promise.reject(err);
        }
        return Promise.resolve({
          token: FAKE_ACCESS_TOKEN,
          expiresOnTimestamp: Date.now() + lifetime,
          tokenType: 'Bearer',
        });
      },
    };
    return credential;
  };

  return {
    factory,
    created,
    approve: () => pending.shift()?.resolve(),
    fail: (err = new Error(`AADSTS70016 device code ${userCode} for tenant`)) => pending.shift()?.reject(err),
    expireSession: () => {
      sessionExpired = true;
    },
    pendingCount: () => pending.length,
  };
}

export interface LoginRig {
  readonly stub: StubLogin;
  readonly manager: CredentialManager;
  readonly azure: AzureAccess;
  readonly ctx: ToolContext;
  /** Every log line written by the manager and the tool pipeline. */
  readonly logs: string[];
}

/** The real credential manager + context store, wired like main.ts, over a stubbed credential. */
export function createLoginRig(opts: StubLoginOptions & { readonly initialActive?: string } = {}): LoginRig {
  const stub = createStubLogin(opts);
  const logs: string[] = [];
  const aliases = contextIdAliases(FAKE_CONTEXTS);
  const logger = createLogger('debug', {
    anonymizer: createAnonymizer({ aliases }),
    write: (line) => logs.push(line),
  });
  const manager = createCredentialManager({ contexts: FAKE_CONTEXTS, logger, factory: stub.factory });
  const store = createContextStore({
    contexts: FAKE_CONTEXTS,
    isLoggedIn: (alias) => manager.isLoggedIn(alias),
    initialActive: opts.initialActive ?? 'prod',
  });
  // Fake clients: the contexts tools never call Azure, and nothing here may reach the network.
  const azure = createAzureAccess({
    contexts: FAKE_CONTEXTS,
    store,
    credentials: manager,
    clients: createFakeClientFactory(),
  });
  const ctx: ToolContext = { anonymizer: createAnonymizer({ aliases }), logger, azure };
  return { stub, manager, azure, ctx, logs };
}

/** Lets the manager's background login promise settle. */
export const flushLogin = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
