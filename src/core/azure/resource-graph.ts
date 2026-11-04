import type { TokenCredential } from '@azure/core-auth';
import { ResourceGraphClient } from '@azure/arm-resourcegraph';
import { AppError } from '../errors/index.js';
import type { ClientFactory } from './client-factory.js';
import type { AzureSession } from './contracts.js';

/** Default and absolute row caps for one `query()` call. */
export const DEFAULT_MAX_ROWS = 1000;
export const HARD_MAX_ROWS = 5000;
/** Resource Graph returns at most 1000 rows per page. */
const PAGE_SIZE = 1000;

/** The subset of `ResourceGraphClient` we use (read-only query). Lets tests stub it. */
export interface ResourceGraphQueryClient {
  resources(request: {
    query: string;
    subscriptions?: string[];
    options?: { skipToken?: string; top?: number; resultFormat?: 'objectArray' };
  }): Promise<{ data: unknown; skipToken?: string }>;
}

export interface ResourceQueryOptions {
  /** Real subscription IDs (from `session.subscriptionId(alias)`). Must belong to the active context. */
  readonly subscriptions?: readonly string[];
  /** Row cap for this call. Clamped to `HARD_MAX_ROWS`. */
  readonly maxRows?: number;
}

export interface ResourceGraph {
  /** Runs a read-only Resource Graph query, scoped to the active context's subscriptions by default. */
  query<T>(kql: string, opts?: ResourceQueryOptions): Promise<T[]>;
}

export interface ResourceGraphDeps {
  /** Usually `() => azure.session()`. Throws `NoActiveContext` / `NotLoggedIn`. */
  readonly session: () => AzureSession;
  readonly clients: ClientFactory;
  readonly createClient?: (credential: TokenCredential) => ResourceGraphQueryClient;
}

const CLIENT_KEY = 'resource-graph';

// eslint-disable-next-line no-control-regex -- control characters are exactly what we reject.
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * Renders an untrusted value (AI input) as a KQL single-quoted string literal.
 * Backslashes and both quote kinds are escaped so the value can never close the literal.
 * Always use this to put values in a query, never string interpolation.
 */
export function kqlString(value: string): string {
  if (CONTROL_CHARS.test(value)) {
    throw new AppError('InvalidInput', 'Names must not contain control characters.');
  }
  return `'${value.replace(/[\\'"]/g, (c) => `\\${c}`)}'`;
}

export function createResourceGraph(deps: ResourceGraphDeps): ResourceGraph {
  const createClient =
    deps.createClient ?? ((credential: TokenCredential) => new ResourceGraphClient(credential));

  return {
    async query<T>(kql: string, opts: ResourceQueryOptions = {}): Promise<T[]> {
      const session = deps.session();
      const allowed = session.subscriptionIds();
      const subscriptions = opts.subscriptions ?? allowed;
      // Never query outside the declared subscriptions: an empty list would mean "whole tenant".
      if (subscriptions.some((s) => !allowed.includes(s))) {
        throw new AppError(
          'UnknownSubscription',
          'The query targets a subscription outside the active context.',
        );
      }
      if (subscriptions.length === 0) return [];

      const maxRows = Math.max(1, Math.min(Math.floor(opts.maxRows ?? DEFAULT_MAX_ROWS), HARD_MAX_ROWS));
      const client = deps.clients.getClient(session, CLIENT_KEY, createClient);
      const rows: T[] = [];
      let skipToken: string | undefined;

      do {
        const top = Math.min(PAGE_SIZE, maxRows - rows.length);
        const page = await client.resources({
          query: kql,
          subscriptions: [...subscriptions],
          options: { top, resultFormat: 'objectArray', ...(skipToken === undefined ? {} : { skipToken }) },
        });
        if (!Array.isArray(page.data)) {
          throw new AppError('UnexpectedResponse', 'Resource Graph returned an unexpected response.');
        }
        // Rows are untyped JSON from Azure; callers map them through an allowlist.
        rows.push(...(page.data as T[]).slice(0, maxRows - rows.length));
        skipToken = page.skipToken === '' ? undefined : page.skipToken;
      } while (skipToken !== undefined && rows.length < maxRows);

      return rows;
    },
  };
}
