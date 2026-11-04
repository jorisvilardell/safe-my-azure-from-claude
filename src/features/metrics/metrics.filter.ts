import { AppError } from '../../core/errors/index.js';

export const MAX_FILTER_CLAUSES = 10;
const MAX_VALUE_LENGTH = 256;

const DIMENSION = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const OPERATORS = new Set(['eq', 'ne']);
const JOINERS = new Set(['and', 'or']);
// eslint-disable-next-line no-control-regex -- control characters are exactly what we reject.
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export interface FilterClause {
  readonly dimension: string;
  readonly operator: 'eq' | 'ne';
  readonly value: string;
}

export interface ParsedFilter {
  readonly clauses: readonly FilterClause[];
  /** `and` / `or` between clause i and i + 1. */
  readonly joiners: readonly ('and' | 'or')[];
}

type Token =
  { readonly kind: 'word'; readonly text: string } | { readonly kind: 'string'; readonly text: string };

function invalid(reason: string): AppError {
  return new AppError(
    'InvalidFilter',
    `Invalid metric filter: ${reason}. Use clauses like Dimension eq 'value' joined by and / or ` +
      "(value '*' splits by that dimension; double a quote to escape it).",
  );
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input.charAt(i);
    if (ch === ' ') {
      i++;
      continue;
    }
    if (ch === "'") {
      let value = '';
      i++;
      for (;;) {
        if (i >= input.length) throw invalid('unterminated quoted value');
        const c = input.charAt(i);
        if (c === "'") {
          if (input.charAt(i + 1) === "'") {
            value += "'";
            i += 2;
            continue;
          }
          i++;
          break;
        }
        value += c;
        i++;
      }
      tokens.push({ kind: 'string', text: value });
      continue;
    }
    const start = i;
    while (i < input.length && input.charAt(i) !== ' ' && input.charAt(i) !== "'") i++;
    tokens.push({ kind: 'word', text: input.slice(start, i) });
  }
  return tokens;
}

/**
 * Strict parser for the Azure Monitor `$filter` grammar we allow: `Dim eq|ne 'value'` clauses
 * joined by `and` / `or`. Anything else (parentheses, functions, bare values, other operators) is
 * rejected, so AI input can never smuggle extra syntax into the query.
 */
export function parseFilter(input: string): ParsedFilter {
  if (CONTROL_CHARS.test(input)) throw invalid('control characters are not allowed');
  const tokens = tokenize(input);
  if (tokens.length === 0) throw invalid('the filter is empty');

  const clauses: FilterClause[] = [];
  const joiners: ('and' | 'or')[] = [];
  let i = 0;
  for (;;) {
    const [dim, op, value] = [tokens[i], tokens[i + 1], tokens[i + 2]];
    if (dim?.kind !== 'word' || !DIMENSION.test(dim.text)) throw invalid('expected a dimension name');
    const operator = op?.kind === 'word' ? op.text.toLowerCase() : '';
    if (!OPERATORS.has(operator)) throw invalid(`expected eq or ne after ${dim.text}`);
    if (value?.kind !== 'string') throw invalid(`expected a quoted value after ${dim.text} ${operator}`);
    if (value.text.length > MAX_VALUE_LENGTH) throw invalid('a value is too long');
    clauses.push({ dimension: dim.text, operator: operator as 'eq' | 'ne', value: value.text });
    if (clauses.length > MAX_FILTER_CLAUSES) throw invalid(`at most ${MAX_FILTER_CLAUSES} clauses`);
    i += 3;

    const joiner = tokens[i];
    if (joiner === undefined) break;
    const word = joiner.kind === 'word' ? joiner.text.toLowerCase() : '';
    if (!JOINERS.has(word)) throw invalid('expected and / or between clauses');
    joiners.push(word as 'and' | 'or');
    i++;
  }
  return { clauses, joiners };
}

const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`;

/** Renders a parsed filter back to canonical `$filter` text, re-escaping every value. */
export function renderFilter(filter: ParsedFilter, mapValue: (v: string) => string = (v) => v): string {
  return filter.clauses
    .map((c, idx) => {
      const clause = `${c.dimension} ${c.operator} ${quote(mapValue(c.value))}`;
      const joiner = filter.joiners[idx];
      return joiner === undefined ? clause : `${clause} ${joiner}`;
    })
    .join(' ');
}
