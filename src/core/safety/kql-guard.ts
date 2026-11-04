import { AppError } from '../errors/index.js';
import { normalizeTimespan, type KqlTimespan, type KqlTimespanInput } from './kql-timespan.js';
import { tokenizeKql, type KqlToken } from './kql-tokenizer.js';

export const KQL_DEFAULT_MAX_ROWS = 500;
export const KQL_DEFAULT_MAX_TIMESPAN_DAYS = 7;
export const KQL_MAX_QUERY_LENGTH = 10_000;

export interface KqlGuardOptions {
  /** Row cap appended as `| take N`. Default 500. */
  maxRows?: number;
  /** Longest allowed query window. Default 7 days. */
  maxTimespanDays?: number;
  /** ISO 8601 duration (`PT1H`), `<start>/<end>` interval, or `{ start, end }`. Default `P1D`. */
  timespan?: KqlTimespanInput;
}

export interface GuardedKql {
  /** Query to send: comments removed, row cap applied. */
  query: string;
  /** Normalised window to pass to the query API (it bounds the data regardless of the KQL). */
  timespan: KqlTimespan;
}

/**
 * Functions that reach outside the resolved workspace / app (other clusters, databases,
 * workspaces, Azure Resource Graph, ADX, external storage).
 */
const CROSS_SCOPE_FUNCTIONS = new Set([
  'cluster',
  'database',
  'workspace',
  'app',
  'resource',
  'adx',
  'arg',
  'external_table',
  'externaldata',
]);

/**
 * `evaluate` plugins that only transform data already in the query. Everything else is denied,
 * notably http_request*, sql_request, cosmosdb_sql_request, python, r and other plugins that call
 * out of the service or run arbitrary code.
 */
const SAFE_PLUGINS = new Set([
  'autocluster',
  'bag_unpack',
  'basket',
  'diffpatterns',
  'narrow',
  'pivot',
  'preview',
]);

/** Operators that emit several result tables, which would escape the single row cap. */
const MULTI_RESULT_OPERATORS = new Set(['fork', 'facet']);

/** Statement kinds other than `let` and a tabular expression. */
const OTHER_STATEMENTS = new Set(['set', 'alias', 'declare', 'pattern', 'restrict', 'execute']);

const ROW_LIMIT_OPERATORS = new Set(['take', 'limit', 'top']);

const reject = (reason: string): never => {
  throw new AppError('KqlRejected', reason);
};

const isPunct = (t: KqlToken | undefined, p: string): boolean => t?.kind === 'punct' && t.text === p;
const isKeyword = (t: KqlToken | undefined, w: string): boolean =>
  t?.kind === 'word' && !t.quoted && t.value === w;

function assertPositive(name: string, v: number, integer: boolean): void {
  if (!Number.isFinite(v) || v <= 0 || (integer && !Number.isInteger(v))) {
    throw new RangeError(`${name} must be a positive ${integer ? 'integer' : 'number'}`);
  }
}

/** Splits on top-level `;`. Lambda bodies `{ let a = 1; … }` contain nested semicolons. */
function splitStatements(tokens: KqlToken[]): KqlToken[][] {
  const statements: KqlToken[][] = [];
  let current: KqlToken[] = [];
  let depth = 0;
  for (const t of tokens) {
    if (t.kind === 'punct') {
      if ('([{'.includes(t.text)) depth++;
      else if (')]}'.includes(t.text)) depth--;
      if (depth < 0) reject('The query has unbalanced brackets.');
      if (t.text === ';' && depth === 0) {
        if (current.length > 0) statements.push(current);
        current = [];
        continue;
      }
    }
    current.push(t);
  }
  if (depth !== 0) reject('The query has unbalanced brackets.');
  if (current.length > 0) statements.push(current);
  return statements;
}

/** Splits a statement on top-level `|`, returning the index of the first token of each stage. */
function stageStarts(statement: KqlToken[]): number[] {
  const starts = [0];
  let depth = 0;
  statement.forEach((t, i) => {
    if (t.kind !== 'punct') return;
    if ('([{'.includes(t.text)) depth++;
    else if (')]}'.includes(t.text)) depth--;
    else if (t.text === '|' && depth === 0) starts.push(i + 1);
  });
  return starts;
}

function checkTokens(tokens: KqlToken[]): void {
  tokens.forEach((t, i) => {
    const next = tokens[i + 1];
    if (t.kind === 'punct' && (t.text === '.' || t.text === '#') && t.lineStart && next?.kind === 'word') {
      // A line starting with `.word` is a control command even without a `;` before it.
      reject('Management commands (starting with ".") are not allowed.');
    }
    if (t.kind !== 'word') return;
    const bareExternal = t.value === 'externaldata' && !t.quoted;
    if (CROSS_SCOPE_FUNCTIONS.has(t.value) && (isPunct(next, '(') || bareExternal)) {
      reject(
        'Cross-scope or external data functions (cluster(), workspace(), externaldata, …) are not allowed.',
      );
    }
    if (isKeyword(t, 'evaluate')) checkEvaluate(tokens, i + 1);
    if (MULTI_RESULT_OPERATORS.has(t.value) && !t.quoted && isPunct(tokens[i - 1], '|')) {
      reject('Operators returning several result tables (fork, facet) are not allowed.');
    }
  });
}

function checkEvaluate(tokens: KqlToken[], from: number): void {
  let i = from;
  // Skip operator hints: `evaluate hint.distribution = per_node bag_unpack(…)`.
  while (isKeyword(tokens[i], 'hint') && isPunct(tokens[i + 1], '.')) {
    if (tokens[i + 2]?.kind !== 'word' || !isPunct(tokens[i + 3], '=')) break;
    i += 5;
  }
  const plugin = tokens[i];
  if (plugin?.kind !== 'word' || !SAFE_PLUGINS.has(plugin.value) || !isPunct(tokens[i + 1], '(')) {
    reject(`This evaluate plugin is not allowed. Allowed plugins: ${[...SAFE_PLUGINS].join(', ')}.`);
  }
}

function checkStatements(statements: KqlToken[][]): KqlToken[] {
  const last = statements.length - 1;
  statements.forEach((s, i) => {
    const first = s[0];
    if (isPunct(first, '.') || isPunct(first, '#')) {
      reject('Management commands (starting with ".") are not allowed.');
    }
    if (isKeyword(first, 'set')) reject('Query options ("set" statements) are not allowed.');
    if (first?.kind === 'word' && !first.quoted && OTHER_STATEMENTS.has(first.value)) {
      reject('Only "let" statements followed by one tabular expression are allowed.');
    }
    if (i < last && !isKeyword(first, 'let')) {
      reject('Only "let" statements may precede the final query; multiple result sets are not allowed.');
    }
    if (i === last && isKeyword(first, 'let')) reject('The query must end with a tabular expression.');
  });
  const final = statements[last];
  if (final === undefined) return reject('The query is empty.');
  return final;
}

/** Literal row count of a final `take N` / `limit N` / `top N by …` stage, if any. */
function literalRowLimit(stage: KqlToken[]): number | undefined {
  const [op, n] = stage;
  if (op?.kind !== 'word' || op.quoted || !ROW_LIMIT_OPERATORS.has(op.value)) return undefined;
  if (n?.kind !== 'number' || !/^\d+$/.test(n.text)) return undefined;
  if (op.value !== 'top' && stage.length !== 2) return undefined;
  return Number(n.text);
}

/** Removes comment ranges and maps original offsets to offsets in the stripped text. */
function stripComments(src: string, comments: [number, number][]) {
  let out = '';
  let pos = 0;
  for (const [s, e] of comments) {
    out += src.slice(pos, s);
    pos = e;
  }
  out += src.slice(pos);
  const map = (offset: number): number => {
    let removed = 0;
    for (const [s, e] of comments) if (e <= offset) removed += e - s;
    return offset - removed;
  };
  return { text: out, map };
}

/**
 * Validates AI-written KQL before it is sent to Log Analytics / App Insights (AGENTS.md R6).
 * Rejections throw `AppError('KqlRejected')` with a message that never echoes the query.
 *
 * Row cap: when the final tabular expression doesn't already end with a literal
 * `take`/`limit`/`top` ≤ maxRows, `| take maxRows` is appended (before a trailing `render`).
 * A larger take is wrapped rather than rewritten in place: appending keeps the query's own
 * semantics (sort order, `top` ranking) and avoids editing tokens we only lexed, never parsed.
 */
export function guardKql(query: string, opts: KqlGuardOptions = {}): GuardedKql {
  const maxRows = opts.maxRows ?? KQL_DEFAULT_MAX_ROWS;
  const maxDays = opts.maxTimespanDays ?? KQL_DEFAULT_MAX_TIMESPAN_DAYS;
  assertPositive('maxRows', maxRows, true);
  assertPositive('maxTimespanDays', maxDays, false);

  if (query.length > KQL_MAX_QUERY_LENGTH) {
    reject(`The query is too long (max ${KQL_MAX_QUERY_LENGTH} characters).`);
  }
  const { tokens, comments } = tokenizeKql(query);
  if (tokens.length === 0) reject('The query is empty.');

  checkTokens(tokens);
  const final = checkStatements(splitStatements(tokens));

  const starts = stageStarts(final);
  const stages = starts.map((s, i) => {
    const next = starts[i + 1];
    return final.slice(s, next === undefined ? undefined : next - 1);
  });
  let capIndex = stages.length - 1;
  if (isKeyword(stages[capIndex]?.[0], 'render') && capIndex > 0) capIndex--;
  const capStage = stages[capIndex] ?? [];
  if (stages.some((s) => s.length === 0)) reject('The query has an empty pipe stage.');
  const lastToken = final[final.length - 1];
  const capEnd = capStage[capStage.length - 1];
  if (lastToken === undefined || capEnd === undefined) return reject('The query is empty.');

  const { text, map } = stripComments(query, comments);
  const end = map(lastToken.end);
  const limit = literalRowLimit(capStage);
  let out: string;
  if (limit !== undefined && limit <= maxRows) {
    out = text.slice(0, end);
  } else {
    const at = map(capEnd.end);
    out = `${text.slice(0, at).trimEnd()}\n| take ${maxRows}${text.slice(at, end).trimEnd()}`;
  }
  return { query: out.trim(), timespan: normalizeTimespan(opts.timespan, maxDays) };
}
