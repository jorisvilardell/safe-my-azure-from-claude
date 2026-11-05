import {
  InteractiveBrowserCredential,
  useIdentityPlugin,
  type IdentityPlugin,
  type InteractiveBrowserCredentialNodeOptions,
} from '@azure/identity';
import { AppError } from '../errors/index.js';
import {
  createDeviceCodeCredential,
  type AuthMode,
  type CredentialFactory,
  type LoginCredential,
} from './credential-manager.js';

/**
 * Kept in a variable so TypeScript does not resolve it: `@azure/identity-broker` is an
 * optionalDependency (native WAM bindings), absent from the Docker image (`npm ci --omit=optional`).
 */
const BROKER_MODULE = '@azure/identity-broker';

export interface BrokerLoaderDeps {
  readonly platform?: NodeJS.Platform;
  /** Loads `@azure/identity-broker`. Tests replace it; it must never be imported eagerly. */
  readonly importBroker?: () => Promise<unknown>;
  readonly useIdentityPlugin?: (plugin: IdentityPlugin) => void;
  readonly newCredential?: (options: InteractiveBrowserCredentialNodeOptions) => LoginCredential;
}

const isPluginModule = (mod: unknown): mod is { nativeBrokerPlugin: IdentityPlugin } =>
  typeof mod === 'object' &&
  mod !== null &&
  typeof (mod as { nativeBrokerPlugin?: unknown }).nativeBrokerPlugin === 'function';

/**
 * The credential factory for an `AUTH_MODE`. `device-code` returns the default one and loads
 * nothing. `broker` checks the platform first, then loads the WAM plugin; it throws an `AppError`
 * whose message is ours and safe to print at startup (no path, no SDK text).
 */
export async function loadCredentialFactory(
  mode: AuthMode,
  deps: BrokerLoaderDeps = {},
): Promise<CredentialFactory> {
  if (mode === 'device-code') return createDeviceCodeCredential;

  const platform = deps.platform ?? process.platform;
  if (platform !== 'win32') {
    throw new AppError(
      'BrokerUnsupportedPlatform',
      'AUTH_MODE=broker needs native Windows (WAM). Use AUTH_MODE=device-code (the default) here.',
    );
  }

  let mod: unknown;
  try {
    mod = await (deps.importBroker ?? (() => import(BROKER_MODULE)))();
  } catch {
    // The loader error is dropped: it names local paths and native binding details.
    mod = undefined;
  }
  if (!isPluginModule(mod)) {
    throw new AppError(
      'BrokerNotInstalled',
      'AUTH_MODE=broker needs the optional package @azure/identity-broker. Install it with `npm install @azure/identity-broker`, or use AUTH_MODE=device-code.',
    );
  }
  (deps.useIdentityPlugin ?? useIdentityPlugin)(mod.nativeBrokerPlugin);

  const newCredential = deps.newCredential ?? ((o) => new InteractiveBrowserCredential(o));
  // Same rules as the device-code credential: no `tokenCachePersistenceOptions` (the MSAL cache
  // stays in memory, R8) and no silent re-login behind a tool call. WAM itself keeps the account
  // in the Windows account store: that is the broker's design, see docs/WINDOWS.md.
  return ({ tenantId }) =>
    newCredential({
      tenantId,
      disableAutomaticAuthentication: true,
      brokerOptions: {
        enabled: true,
        // A console process has no window of its own: WAM opens a top-level window instead.
        parentWindowHandle: new Uint8Array(0),
        // Never sign in silently with the Windows default account: the human picks the account.
        useDefaultBrokerAccount: false,
      },
    });
}
