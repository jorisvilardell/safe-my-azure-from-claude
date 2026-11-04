import { z } from 'zod';
import {
  neutralizeText,
  stripInvisibleDeep,
  truncateText,
  untrustedText,
  type Truncated,
} from '../../core/safety/index.js';

/** Rows returned to the AI. The guard appends `| take MAX_ROWS + 1` so we can tell when more exist. */
export const MAX_ROWS = 500;
/** Wide outputs (`pivot`, `bag_unpack`, `project *`) are cut to this many columns. */
export const MAX_COLUMNS = 100;
/** Free-text cells (log messages, URLs, dynamic JSON) are cut to this many characters. */
export const MAX_CELL_CHARS = 1024;
/** Budget for the serialised rows of one response (JSON characters). */
export const MAX_RESULT_CHARS = 64 * 1024;

const CUT_MARK = '…[truncated]';

const COLUMN_TYPES = new Set([
  'bool',
  'datetime',
  'dynamic',
  'int',
  'long',
  'real',
  'string',
  'guid',
  'decimal',
  'timespan',
]);

export type LogKind = 'log-analytics' | 'app-insights';

export const WORKSPACE_TYPES: Readonly<Record<string, LogKind>> = {
  'microsoft.operationalinsights/workspaces': 'log-analytics',
  'microsoft.insights/components': 'app-insights',
};

/** A Resource Graph row for a workspace or an App Insights component. Server-side only. */
export const WorkspaceRow = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  resourceGroup: z.string(),
  subscriptionId: z.string(),
  location: z.string().nullish(),
  customerId: z.string().nullish(),
  retentionInDays: z.number().nullish(),
});
export type WorkspaceRow = z.infer<typeof WorkspaceRow>;

export interface WorkspaceDto {
  readonly name: string;
  readonly kind: LogKind;
  readonly resourceGroup: string;
  /** Subscription ALIAS. */
  readonly subscription?: string;
  readonly location?: string;
  readonly retentionInDays?: number;
}

export function kindOf(row: Pick<WorkspaceRow, 'type'>): LogKind | undefined {
  return WORKSPACE_TYPES[row.type.toLowerCase()];
}

/** Allowlist: the customerId (workspace GUID) and the ARM ID never leave the server. */
export function toWorkspaceDto(
  row: WorkspaceRow,
  kind: LogKind,
  subscription: string | undefined,
): WorkspaceDto {
  return {
    name: row.name,
    kind,
    resourceGroup: row.resourceGroup,
    ...(subscription === undefined ? {} : { subscription }),
    ...(row.location === null || row.location === undefined ? {} : { location: row.location }),
    ...(row.retentionInDays === null || row.retentionInDays === undefined
      ? {}
      : { retentionInDays: row.retentionInDays }),
  };
}

/** The table shape we need from the SDK (`LogsTable`). */
export interface RawTable {
  readonly columnDescriptors: readonly { readonly name?: unknown; readonly type?: unknown }[];
  readonly rows: readonly (readonly unknown[])[];
}

export interface QueryColumn {
  readonly name: string;
  readonly type: string;
}

export interface QueryTable {
  readonly columns: readonly QueryColumn[];
  /**
   * Cell values copied from the logs: attacker-controllable text (#39). Invisible characters are
   * removed and `executeTool` flags instruction-like cells in `warnings` (`rows[i][j]`).
   */
  readonly rows: readonly unknown[][];
  readonly rowCount: number;
  readonly truncated: boolean;
  /** Why the result is incomplete, in words the AI can act on. Present only when truncated. */
  readonly truncation?: readonly string[];
}

/** Scrubs one value as if it were the field `key` of an object (field-name rules apply). */
export type FieldScrubber = (key: string, value: unknown) => unknown;

/** Already scrubbed, so the cut may fall anywhere (never inside a surrogate pair). */
function cut(text: string): Truncated {
  return truncateText(text, MAX_CELL_CHARS, { ellipsis: CUT_MARK, at: 'char' });
}

interface CellResult {
  readonly value: unknown;
  readonly cut: boolean;
}

/**
 * Normalises and caps one cell. Invisible characters go first (`untrustedText` rules, line breaks
 * kept), so they cannot hide an email from the scrubber. The cell is scrubbed BEFORE it is cut:
 * cutting first could split a GUID, email, JWT or key into a fragment the scrubber no longer
 * recognises, and leak it. `executeTool` scrubs the whole result again (scrubbing is idempotent).
 */
function toCell(raw: unknown, column: string, scrub: FieldScrubber): CellResult {
  const value = typeof raw === 'string' ? neutralizeText(raw, { multiline: true }) : stripInvisibleDeep(raw);
  if (value === null || value === undefined) return { value: null, cut: false };
  if (value instanceof Date) {
    return { value: Number.isNaN(value.getTime()) ? null : value.toISOString(), cut: false };
  }
  if (typeof value === 'bigint') return toCell(value.toString(), column, scrub);
  if (typeof value === 'number' && !Number.isFinite(value)) return { value: String(value), cut: false };
  // The column name is the field key, so `password`/`clientSecret` columns are redacted and
  // `UserPrincipalName`/`caller` columns are pseudonymised even without an email pattern.
  const scrubbed = scrub(column, value);
  if (typeof scrubbed === 'string') {
    const c = cut(scrubbed);
    return { value: c.text, cut: c.cut };
  }
  if (typeof scrubbed === 'object' && scrubbed !== null) {
    const json = JSON.stringify(scrubbed);
    if (json.length > MAX_CELL_CHARS) return { value: cut(json).text, cut: true };
  }
  return { value: scrubbed, cut: false };
}

function toColumn(c: RawTable['columnDescriptors'][number], index: number): QueryColumn {
  const name = untrustedText(c.name, { max: 256 }) ?? `column${index + 1}`;
  const type = typeof c.type === 'string' && COLUMN_TYPES.has(c.type) ? c.type : 'unknown';
  return { name, type };
}

/** Maps the primary result table to a capped, allowlisted DTO (rows, columns, cell size, bytes). */
export function toQueryTable(table: RawTable | undefined, scrub: FieldScrubber): QueryTable {
  if (table === undefined) return { columns: [], rows: [], rowCount: 0, truncated: false };

  const reasons: string[] = [];
  const allColumns = table.columnDescriptors.map(toColumn);
  const columns = allColumns.slice(0, MAX_COLUMNS);
  if (allColumns.length > columns.length) {
    reasons.push(
      `Only the first ${MAX_COLUMNS} of ${allColumns.length} columns are returned. Use "project" to pick columns.`,
    );
  }

  const source = table.rows.slice(0, MAX_ROWS);
  if (table.rows.length > MAX_ROWS) {
    reasons.push(
      `More than ${MAX_ROWS} rows matched; only the first ${MAX_ROWS} are returned. Filter or summarize to see the rest.`,
    );
  }

  const rows: unknown[][] = [];
  let size = JSON.stringify(columns).length;
  let cutCells = 0;
  for (const raw of source) {
    let rowCut = 0;
    const row = columns.map((col, i) => {
      const c = toCell(raw[i], col.name, scrub);
      if (c.cut) rowCut++;
      return c.value;
    });
    size += JSON.stringify(row).length + 1;
    if (size > MAX_RESULT_CHARS) {
      reasons.push(
        `The response size limit (${MAX_RESULT_CHARS / 1024} KB) was reached: ${rows.length} of ${source.length} rows are returned. ` +
          'Project fewer columns or summarize.',
      );
      break;
    }
    cutCells += rowCut;
    rows.push(row);
  }
  if (cutCells > 0) {
    reasons.push(
      `${cutCells} cell(s) longer than ${MAX_CELL_CHARS} characters were cut (marked "${CUT_MARK}"). ` +
        'Use substring() or extract() to read a specific part.',
    );
  }

  return {
    columns,
    rows,
    rowCount: rows.length,
    truncated: reasons.length > 0,
    ...(reasons.length > 0 ? { truncation: reasons } : {}),
  };
}
