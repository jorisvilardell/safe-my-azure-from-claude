import {
  LogsQueryClient,
  LogsQueryResultStatus,
  type LogsQueryOptions,
  type LogsQueryResult,
  type QueryTimeInterval,
} from '@azure/monitor-query-logs';
import type { Anonymizer } from '../../core/anonymizer/index.js';
import { kqlString, type AzureAccess, type AzureSession } from '../../core/azure/index.js';
import { AppError, sanitizeError, type SafeError } from '../../core/errors/index.js';
import { guardKql, type KqlTimespan } from '../../core/safety/index.js';
import {
  kindOf,
  MAX_ROWS,
  toQueryTable,
  toWorkspaceDto,
  WORKSPACE_TYPES,
  WorkspaceRow,
  type FieldScrubber,
  type LogKind,
  type QueryTable,
  type RawTable,
  type WorkspaceDto,
} from './logs.mapper.js';

/** `ClientFactory` key of the logs query client (not bound to a subscription). */
export const LOGS_CLIENT_KEY = 'logs-query';
/** Server-side limit sent to Log Analytics (`Prefer: wait=…`). */
export const SERVER_TIMEOUT_SECONDS = 60;
/** Client-side backstop, a little longer than the server timeout. */
export const CLIENT_TIMEOUT_MS = (SERVER_TIMEOUT_SECONDS + 15) * 1000;
export const MAX_WORKSPACES = 500;
const MAX_CANDIDATES = 10;
const MAX_TABLES = 200;

/** The read-only subset of `LogsQueryClient` we use. Lets tests stub it. */
export type LogsClient = Pick<LogsQueryClient, 'queryWorkspace' | 'queryResource'>;

export interface WorkspaceRef {
  readonly workspace: string;
  readonly resourceGroup?: string | undefined;
  readonly subscription?: string | undefined;
}

export interface WorkspaceList {
  readonly workspaces: readonly WorkspaceDto[];
  readonly truncated: boolean;
}

export interface TableList {
  readonly workspace: string;
  readonly kind: LogKind;
  /** Tables with at least one row in the last 24 h, busiest first. */
  readonly tables: readonly { readonly name: string; readonly rowCount24h: number }[];
  readonly truncated: boolean;
  readonly note: string;
}

export interface KqlResult extends QueryTable {
  readonly workspace: string;
  readonly kind: LogKind;
  /** The window actually applied by the query API. */
  readonly timespan: KqlTimespan;
  /** Set when Azure returned only part of the result. */
  readonly partialFailure?: SafeError;
}

/** Where a query goes. The customerId and the ARM ID stay server-side. */
interface Target {
  readonly name: string;
  readonly kind: LogKind;
  /** Log Analytics customerId (workspace GUID), or the App Insights ARM ID. */
  readonly key: string;
}

const TYPE_FILTER = `type in~ (${Object.keys(WORKSPACE_TYPES).map(kqlString).join(', ')})`;
const PROJECTION =
  'project id, name, type, resourceGroup, subscriptionId, location, ' +
  'customerId = tostring(properties.customerId), ' +
  'retentionInDays = toint(coalesce(properties.retentionInDays, properties.RetentionInDays))';

function parseRows(raw: readonly unknown[]): (WorkspaceRow & { kind: LogKind })[] {
  return raw.flatMap((r) => {
    const parsed = WorkspaceRow.safeParse(r);
    if (!parsed.success) return [];
    const kind = kindOf(parsed.data);
    return kind === undefined ? [] : [{ ...parsed.data, kind }];
  });
}

/** Real subscription ID → alias, for the active context only. */
function aliasesOf(azure: AzureAccess, session: AzureSession): Map<string, string> {
  const aliases = azure.contexts.list().find((c) => c.alias === session.contextAlias)?.subscriptions ?? [];
  return new Map(aliases.map((a) => [session.subscriptionId(a).toLowerCase(), a]));
}

function scopeOf(session: AzureSession, subscription: string | undefined): { subscriptions?: string[] } {
  return subscription === undefined ? {} : { subscriptions: [session.subscriptionId(subscription)] };
}

export async function listWorkspaces(
  azure: AzureAccess,
  input: { subscription?: string | undefined },
): Promise<WorkspaceList> {
  const session = azure.session();
  const { rows, truncated } = await azure.resourceGraph.queryResult<unknown>(
    `resources\n| where ${TYPE_FILTER}\n| ${PROJECTION}\n| order by name asc`,
    { maxRows: MAX_WORKSPACES, ...scopeOf(session, input.subscription) },
  );
  const aliases = aliasesOf(azure, session);
  const workspaces = parseRows(rows).map((r) =>
    toWorkspaceDto(r, r.kind, aliases.get(r.subscriptionId.toLowerCase())),
  );
  return { workspaces, truncated };
}

/** Resolves a workspace NAME to its query target. Exactly one match, else a clear AppError. */
async function resolveTarget(azure: AzureAccess, ref: WorkspaceRef): Promise<Target> {
  const session = azure.session();
  const filters = [TYPE_FILTER, `name =~ ${kqlString(ref.workspace)}`];
  if (ref.resourceGroup !== undefined) filters.push(`resourceGroup =~ ${kqlString(ref.resourceGroup)}`);
  const raw = await azure.resourceGraph.query<unknown>(
    `resources\n| where ${filters.join(' and ')}\n| ${PROJECTION}\n| order by subscriptionId asc, resourceGroup asc\n| take ${MAX_CANDIDATES + 1}`,
    { maxRows: MAX_CANDIDATES + 1, ...scopeOf(session, ref.subscription) },
  );
  const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
  const rows = parseRows(raw).filter(
    (r) =>
      same(r.name, ref.workspace) &&
      (ref.resourceGroup === undefined || same(r.resourceGroup, ref.resourceGroup)),
  );

  const [first, ...rest] = rows;
  if (first === undefined) {
    throw new AppError(
      'ResourceNotFound',
      `Workspace "${ref.workspace}" not found in context "${session.contextAlias}". Run list_workspaces to see the names.`,
    );
  }
  if (rest.length > 0) {
    const aliases = aliasesOf(azure, session);
    // Names and aliases only: never the ARM ID, subscription ID or customerId (G2).
    const candidates = rows
      .slice(0, MAX_CANDIDATES)
      .map(
        (r) =>
          `${r.resourceGroup}/${r.kind}/${r.name} (subscription ${aliases.get(r.subscriptionId.toLowerCase()) ?? 'unknown'})`,
      );
    const count = rows.length > MAX_CANDIDATES ? `more than ${MAX_CANDIDATES}` : String(rows.length);
    throw new AppError(
      'AmbiguousResource',
      `Workspace "${ref.workspace}" matches ${count} resources: ${candidates.join(', ')}. Add a resourceGroup or subscription.`,
    );
  }

  if (first.kind === 'app-insights') return { name: first.name, kind: first.kind, key: first.id };
  if (!first.customerId) {
    throw new AppError(
      'UnexpectedResponse',
      `Workspace "${first.name}" has no workspace ID in Resource Graph.`,
    );
  }
  return { name: first.name, kind: first.kind, key: first.customerId };
}

function toInterval(t: KqlTimespan): QueryTimeInterval {
  return 'duration' in t
    ? { duration: t.duration }
    : { startTime: new Date(t.start), endTime: new Date(t.end) };
}

const isTimeout = (err: unknown): boolean => {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { name?: unknown; statusCode?: unknown; code?: unknown };
  return (
    e.name === 'AbortError' ||
    e.name === 'TimeoutError' ||
    e.statusCode === 504 ||
    e.statusCode === 408 ||
    e.code === 'GatewayTimeout'
  );
};

/** Turns an SDK failure into an AppError with OUR message: the SDK's message is never forwarded (R4). */
function toQueryError(err: unknown): unknown {
  if (err instanceof AppError) return err;
  if (isTimeout(err)) {
    return new AppError(
      'QueryTimeout',
      `The query did not finish within ${SERVER_TIMEOUT_SECONDS} seconds. Narrow the timespan, filter earlier or summarize.`,
    );
  }
  const safe = sanitizeError(err);
  const status = (err as { statusCode?: unknown } | null)?.statusCode;
  if (status === 400) {
    return new AppError(
      'KqlQueryFailed',
      `The query was rejected by Azure (HTTP 400, ${safe.code}). Check the syntax and the table and column names ` +
        '(list_tables). Details were withheld to avoid leaking sensitive data.',
    );
  }
  return err;
}

async function execute(
  azure: AzureAccess,
  target: Target,
  query: string,
  timespan: KqlTimespan,
): Promise<LogsQueryResult> {
  const session = azure.session();
  const client = azure.clients.getClient<LogsClient>(
    session,
    LOGS_CLIENT_KEY,
    (credential) => new LogsQueryClient(credential),
  );
  const options: LogsQueryOptions = {
    serverTimeoutInSeconds: SERVER_TIMEOUT_SECONDS,
    abortSignal: AbortSignal.timeout(CLIENT_TIMEOUT_MS),
  };
  try {
    return target.kind === 'app-insights'
      ? await client.queryResource(target.key, query, toInterval(timespan), options)
      : await client.queryWorkspace(target.key, query, toInterval(timespan), options);
  } catch (err) {
    throw toQueryError(err);
  }
}

function primaryTable(result: LogsQueryResult): { table: RawTable | undefined; partialFailure?: SafeError } {
  if (result.status === LogsQueryResultStatus.PartialFailure) {
    const safe = sanitizeError(result.partialError);
    return {
      table: result.partialTables[0],
      partialFailure: {
        code: safe.code,
        message:
          'Azure returned partial results: the query failed part-way (for example a result too large or a timeout). ' +
          'Narrow the timespan or the query. Details were withheld to avoid leaking sensitive data.',
      },
    };
  }
  return { table: result.tables[0] };
}

const fieldScrubber =
  (anonymizer: Anonymizer): FieldScrubber =>
  (key, value) =>
    // Scrubbed as `{ [column]: value }` so field-name rules apply; scrub() also rewrites the key, so
    // read the single value back positionally.
    Object.values(anonymizer.scrub({ [key]: value }) as Record<string, unknown>)[0];

export async function runKql(
  azure: AzureAccess,
  anonymizer: Anonymizer,
  input: WorkspaceRef & { readonly query: string; readonly timespan?: string | undefined },
): Promise<KqlResult> {
  // Guard first: a rejected query never costs an Azure call. One extra row tells us if more exist.
  const guarded = guardKql(input.query, {
    maxRows: MAX_ROWS + 1,
    ...(input.timespan === undefined ? {} : { timespan: input.timespan }),
  });
  const target = await resolveTarget(azure, input);
  const result = await execute(azure, target, guarded.query, guarded.timespan);
  const { table, partialFailure } = primaryTable(result);
  const mapped = toQueryTable(table, fieldScrubber(anonymizer));
  const truncation = [
    ...(partialFailure === undefined ? [] : ['Azure returned partial results (see partialFailure).']),
    ...(mapped.truncation ?? []),
  ];
  return {
    workspace: target.name,
    kind: target.kind,
    timespan: guarded.timespan,
    ...mapped,
    truncated: truncation.length > 0,
    ...(truncation.length > 0 ? { truncation } : {}),
    ...(partialFailure === undefined ? {} : { partialFailure }),
  };
}

/** Counts rows per table over the last 24 h. Fixed query, still sent through the guard. */
const TABLE_COUNT_QUERY = [
  'union withsource=TableName *',
  'summarize RowCount = count() by TableName',
  'sort by RowCount desc',
].join('\n| ');

export async function listTables(azure: AzureAccess, input: WorkspaceRef): Promise<TableList> {
  const guarded = guardKql(TABLE_COUNT_QUERY, { maxRows: MAX_TABLES + 1, timespan: 'P1D' });
  const target = await resolveTarget(azure, input);
  const result = await execute(azure, target, guarded.query, guarded.timespan);
  const { table, partialFailure } = primaryTable(result);
  const tables = (table?.rows ?? []).flatMap((row) => {
    const [name, count] = row;
    if (typeof name !== 'string') return [];
    return [
      { name: name.slice(0, 256), rowCount24h: typeof count === 'number' ? count : Number(count) || 0 },
    ];
  });
  return {
    workspace: target.name,
    kind: target.kind,
    tables: tables.slice(0, MAX_TABLES),
    truncated: tables.length > MAX_TABLES || partialFailure !== undefined,
    note:
      'Only tables with rows in the last 24 hours are listed.' +
      (partialFailure === undefined ? '' : ' Azure returned partial results, so the list may be incomplete.'),
  };
}
