import type { TokenCredential } from '@azure/core-auth';
import type { AzureSession } from './contracts.js';

/** Caches Azure SDK clients per (context alias, credential). Shared by every feature. */
export interface ClientFactory {
  /**
   * Returns the cached client for `key` in this session's context, or builds it with `create`.
   * Clients are dropped as soon as the context's credential changes (logout/login).
   */
  getClient<T>(
    session: Pick<AzureSession, 'contextAlias' | 'credential'>,
    key: string,
    create: (credential: TokenCredential) => T,
  ): T;
  /** Drops cached clients for one context, or for all of them. */
  invalidate(contextAlias?: string): void;
}

interface ContextClients {
  readonly credential: TokenCredential;
  readonly clients: Map<string, unknown>;
}

export function createClientFactory(): ClientFactory {
  const byContext = new Map<string, ContextClients>();

  return {
    getClient<T>(
      session: Pick<AzureSession, 'contextAlias' | 'credential'>,
      key: string,
      create: (credential: TokenCredential) => T,
    ): T {
      let entry = byContext.get(session.contextAlias);
      // A new credential object means a new login: never reuse a client bound to the old one.
      if (entry?.credential !== session.credential) {
        entry = { credential: session.credential, clients: new Map() };
        byContext.set(session.contextAlias, entry);
      }
      if (entry.clients.has(key)) {
        // Safe: each key is only ever populated by its own `create`, so callers agree on T per key.
        return entry.clients.get(key) as T;
      }
      const client = create(session.credential);
      entry.clients.set(key, client);
      return client;
    },
    invalidate(contextAlias?: string): void {
      if (contextAlias === undefined) byContext.clear();
      else byContext.delete(contextAlias);
    },
  };
}
