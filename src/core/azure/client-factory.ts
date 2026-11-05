import { MonitorClient } from '@azure/arm-monitor';
import { ResourceGraphClient } from '@azure/arm-resourcegraph';
import { MicrosoftResourceHealth } from '@azure/arm-resourcehealth';
import type { TokenCredential } from '@azure/core-auth';
import type { HttpClient, Pipeline } from '@azure/core-rest-pipeline';
import { LogsQueryClient } from '@azure/monitor-query-logs';
import { AppError } from '../errors/index.js';
import type { AzureSession } from './contracts.js';
import { createReadOnlyPolicies } from './read-only-policy.js';

/** Options the factory hands to every SDK constructor. Tests may set `httpClient`; nothing else. */
interface SdkClientOptions {
  httpClient?: HttpClient;
}

const BUILD: unique symbol = Symbol('safe-azure.client-spec');

/**
 * How to build one Azure SDK client. Opaque: only `azureClients` below can make one, and only
 * `getClient` can run it, so the read-only guard is always installed (AGENTS.md R2).
 */
export interface ClientSpec<T> {
  readonly sdk: string;
  readonly [BUILD]: (credential: TokenCredential, options: SdkClientOptions) => T;
}

function spec<T extends { readonly pipeline: Pipeline }>(
  sdk: string,
  build: (credential: TokenCredential, options: SdkClientOptions) => T,
): ClientSpec<T> {
  return { sdk, [BUILD]: build };
}

/**
 * Every Azure SDK client the server uses. This file is the ONLY place allowed to `new` one
 * (enforced by `test/read-only/read-only.test.ts`). A new client goes here, and its calls must be
 * GETs or a POST in `READ_ONLY_POSTS` (`read-only-policy.ts`).
 */
export const azureClients = {
  /** Resource Graph queries (`core/azure/resource-graph.ts`). */
  resourceGraph: (): ClientSpec<ResourceGraphClient> =>
    spec('ResourceGraphClient', (credential, options) => new ResourceGraphClient(credential, options)),
  /** Azure Monitor: activity log (bound to a subscription), metrics and metric definitions (unbound). */
  monitor: (subscriptionId?: string): ClientSpec<MonitorClient> =>
    spec('MonitorClient', (credential, options) =>
      subscriptionId === undefined
        ? new MonitorClient(credential, options)
        : new MonitorClient(credential, subscriptionId, options),
    ),
  /** Resource Health availability statuses and Service Health events, for one subscription. */
  resourceHealth: (subscriptionId: string): ClientSpec<MicrosoftResourceHealth> =>
    spec(
      'MicrosoftResourceHealth',
      (credential, options) => new MicrosoftResourceHealth(credential, subscriptionId, options),
    ),
  /** Log Analytics / App Insights KQL queries. */
  logsQuery: (): ClientSpec<LogsQueryClient> =>
    spec('LogsQueryClient', (credential, options) => new LogsQueryClient(credential, options)),
} as const;

/** Caches Azure SDK clients per (context alias, credential). Shared by every feature. */
export interface ClientFactory {
  /**
   * Returns the cached client for `key` in this session's context, or builds it from `spec`
   * (one of `azureClients`) with the read-only guard installed.
   * Clients are dropped as soon as the context's credential changes (logout/login).
   */
  getClient<T>(
    session: Pick<AzureSession, 'contextAlias' | 'credential'>,
    key: string,
    spec: ClientSpec<T>,
  ): T;
  /** Drops cached clients for one context, or for all of them. */
  invalidate(contextAlias?: string): void;
}

export interface ClientFactoryDeps {
  /** Test seam: the transport under the pipeline. The read-only guard runs before it either way. */
  readonly httpClient?: HttpClient;
}

interface ContextClients {
  readonly credential: TokenCredential;
  readonly clients: Map<string, unknown>;
}

const guardMissing = (): AppError =>
  new AppError('ReadOnlyGuardMissing', 'An Azure client could not be given the read-only guard.');

/**
 * Installs the read-only guard on a freshly built client, then checks it is really there: first
 * and last of the pipeline the client sends through. A client without a pipeline is refused.
 */
function guard(client: unknown): void {
  const pipeline = (client as { pipeline?: Partial<Pipeline> } | null)?.pipeline;
  if (typeof pipeline?.addPolicy !== 'function' || typeof pipeline.getOrderedPolicies !== 'function') {
    throw guardMissing();
  }
  const { first, last } = createReadOnlyPolicies();
  pipeline.addPolicy(first, { phase: 'Serialize' });
  pipeline.addPolicy(last, { afterPhase: 'Sign' });
  const ordered = pipeline.getOrderedPolicies();
  if (ordered[0] !== first || ordered.at(-1) !== last) throw guardMissing();
}

export function createClientFactory(deps: ClientFactoryDeps = {}): ClientFactory {
  const byContext = new Map<string, ContextClients>();
  const options: SdkClientOptions = deps.httpClient === undefined ? {} : { httpClient: deps.httpClient };

  return {
    getClient<T>(
      session: Pick<AzureSession, 'contextAlias' | 'credential'>,
      key: string,
      clientSpec: ClientSpec<T>,
    ): T {
      let entry = byContext.get(session.contextAlias);
      // A new credential object means a new login: never reuse a client bound to the old one.
      if (entry?.credential !== session.credential) {
        entry = { credential: session.credential, clients: new Map() };
        byContext.set(session.contextAlias, entry);
      }
      if (entry.clients.has(key)) {
        // Safe: each key is only ever populated by its own spec, so callers agree on T per key.
        return entry.clients.get(key) as T;
      }
      const client = clientSpec[BUILD](session.credential, { ...options });
      guard(client);
      entry.clients.set(key, client);
      return client;
    },
    invalidate(contextAlias?: string): void {
      if (contextAlias === undefined) byContext.clear();
      else byContext.delete(contextAlias);
    },
  };
}
