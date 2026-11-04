import type { AzureContext } from '../config/index.js';
import { AppError } from '../errors/index.js';
import type {
  AzureAccess,
  AzureSession,
  ContextStore,
  CredentialProvider,
  ResourceResolver,
} from './contracts.js';

export interface AzureAccessDeps {
  readonly contexts: Readonly<Record<string, AzureContext>>;
  readonly store: ContextStore;
  readonly credentials: CredentialProvider;
  readonly resolver: ResourceResolver;
}

/** Composes the store, credentials and resolver into the `AzureAccess` handed to tools. */
export function createAzureAccess(deps: AzureAccessDeps): AzureAccess {
  return {
    contexts: deps.store,
    resolver: deps.resolver,
    session(): AzureSession {
      const contextAlias = deps.store.active();
      const credential = deps.credentials.getCredential(contextAlias);
      const subscriptions = deps.contexts[contextAlias]?.subscriptions ?? {};
      return {
        contextAlias,
        credential,
        subscriptionIds: () => Object.values(subscriptions),
        subscriptionId(alias: string): string {
          const id = Object.hasOwn(subscriptions, alias) ? subscriptions[alias] : undefined;
          if (id === undefined) {
            const known = Object.keys(subscriptions).join(', ') || '(none)';
            throw new AppError(
              'UnknownSubscription',
              `Unknown subscription "${alias}" in context "${contextAlias}". Known subscriptions: ${known}.`,
            );
          }
          return id;
        },
      };
    },
  };
}
