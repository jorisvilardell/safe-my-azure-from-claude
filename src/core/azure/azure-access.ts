import type { AzureContext } from '../config/index.js';
import { AppError } from '../errors/index.js';
import { createClientFactory, type ClientFactory } from './client-factory.js';
import type {
  AzureAccess,
  AzureSession,
  ContextStore,
  CredentialProvider,
  ResourceResolver,
} from './contracts.js';
import { createResourceGraph } from './resource-graph.js';
import { createResourceResolver } from './resolver.js';

export interface AzureAccessDeps {
  readonly contexts: Readonly<Record<string, AzureContext>>;
  readonly store: ContextStore;
  readonly credentials: CredentialProvider;
  /** SDK client cache. Defaults to a new `createClientFactory()`. Tests pass a fake one to stub clients. */
  readonly clients?: ClientFactory;
  /** Defaults to the Resource Graph backed resolver. Tests may pass an in-memory one. */
  readonly resolver?: ResourceResolver;
}

/**
 * Builds the one `AzureAccess` handed to tools: sessions for the active context, plus the shared
 * SDK client cache, Resource Graph client and resolver, all bound to those sessions.
 */
export function createAzureAccess(deps: AzureAccessDeps): AzureAccess {
  const session = (): AzureSession => {
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
  };

  const clients = deps.clients ?? createClientFactory();
  const resourceGraph = createResourceGraph({ session, clients });
  const resolver = deps.resolver ?? createResourceResolver({ resourceGraph, session, contexts: deps.store });

  return { contexts: deps.store, session, resolver, resourceGraph, clients };
}
