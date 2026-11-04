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
  }): Promise<{ data: unknown; skipToken?: string; resultTruncated?: 'true' | 'false' }>;
}

export interface ResourceQueryOptions {
  /** Real subscription IDs (from `session.subscriptionId(alias)`). Must belong to the active context. */
  readonly subscriptions?: readonly string[];
  /** Row cap for this call. Clamped to `HARD_MAX_ROWS`. */
  readonly maxRows?: number;
}

export interface ResourceQueryResult<T> {
  readonly rows: T[];
  /** True when more rows matched than were returned (row cap hit, or Azure truncated the result). */
  readonly truncated: boolean;
}

export interface ResourceGraph {
  /** Runs a read-only Resource Graph query, scoped to the active context's subscriptions by default. */
  query<T>(kql: string, opts?: ResourceQueryOptions): Promise<T[]>;
  /** Same as `query()`, and also says whether rows were cut off, so a tool can tell the AI. */
  queryResult<T>(kql: string, opts?: ResourceQueryOptions): Promise<ResourceQueryResult<T>>;
}

export interface ResourceGraphDeps {
  /** Usually `() => azure.session()`. Throws `NoActiveContext` / `NotLoggedIn`. */
  readonly session: () => AzureSession;
  readonly clients: ClientFactory;
  readonly createClient?: (credential: TokenCredential) => ResourceGraphQueryClient;
}

/** `ClientFactory` key of the Resource Graph client. Fakes register their stub under it. */
export const RESOURCE_GRAPH_CLIENT_KEY = 'resource-graph';

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

export interface ResourceScanOptions {
  /** Row cap, NOT clamped to `HARD_MAX_ROWS`: the caller enforces its own bound. */
  readonly maxRows: number;
  readonly subscriptions?: readonly string[];
}

/**
 * Server-internal bulk read for the inventory index: same scoping and paging as `queryResult()`,
 * for an explicit session and without the `HARD_MAX_ROWS` clamp. Deliberately not part of
 * `ResourceGraph`, so features cannot pull unbounded result sets.
 */
export type ResourceGraphScan = <T>(
  session: AzureSession,
  kql: string,
  opts: ResourceScanOptions,
) => Promise<ResourceQueryResult<T>>;

export function createResourceGraphScan(
  deps: Pick<ResourceGraphDeps, 'clients' | 'createClient'>,
): ResourceGraphScan {
  const createClient =
    deps.createClient ?? ((credential: TokenCredential) => new ResourceGraphClient(credential));

  return async <T>(
    session: AzureSession,
    kql: string,
    opts: ResourceScanOptions,
  ): Promise<ResourceQueryResult<T>> => {
    const allowed = session.subscriptionIds();
    const subscriptions = opts.subscriptions ?? allowed;
    // Never query outside the declared subscriptions: an empty list would mean "whole tenant".
    if (subscriptions.some((s) => !allowed.includes(s))) {
      throw new AppError(
        'UnknownSubscription',
        'The query targets a subscription outside the active context.',
      );
    }
    if (subscriptions.length === 0) return { rows: [], truncated: false };

    const maxRows = Math.max(1, Math.floor(opts.maxRows));
    const client = deps.clients.getClient(session, RESOURCE_GRAPH_CLIENT_KEY, createClient);
    const rows: T[] = [];
    let skipToken: string | undefined;
    let truncated = false;

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
      const data = page.data as T[];
      const room = maxRows - rows.length;
      rows.push(...data.slice(0, room));
      if (data.length > room || page.resultTruncated === 'true') truncated = true;
      skipToken = page.skipToken === '' ? undefined : page.skipToken;
    } while (skipToken !== undefined && rows.length < maxRows);

    // A skip token left over means Azure had more rows than the cap let us fetch.
    return { rows, truncated: truncated || skipToken !== undefined };
  };
}

export function createResourceGraph(deps: ResourceGraphDeps): ResourceGraph {
  const scan = createResourceGraphScan(deps);

  const queryResult = async <T>(
    kql: string,
    opts: ResourceQueryOptions = {},
  ): Promise<ResourceQueryResult<T>> => {
    const session = deps.session();
    const maxRows = Math.max(1, Math.min(Math.floor(opts.maxRows ?? DEFAULT_MAX_ROWS), HARD_MAX_ROWS));
    return scan<T>(session, kql, {
      maxRows,
      ...(opts.subscriptions === undefined ? {} : { subscriptions: opts.subscriptions }),
    });
  };

  return {
    queryResult,
    async query<T>(kql: string, opts?: ResourceQueryOptions): Promise<T[]> {
      return (await queryResult<T>(kql, opts)).rows;
    },
  };
}
