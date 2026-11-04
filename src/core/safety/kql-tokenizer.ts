import { AppError } from '../errors/index.js';

export type KqlTokenKind = 'word' | 'string' | 'number' | 'punct';

export interface KqlToken {
  kind: KqlTokenKind;
  /** Raw source text of the token. */
  text: string;
  /** Lower-cased text for words (KQL keywords are matched case-insensitively here, on purpose). */
  value: string;
  start: number;
  end: number;
  /** True when a line break separates this token from the previous one (or it is the first token). */
  lineStart: boolean;
  /** True for bracket-quoted identifiers such as `['name']`. */
  quoted: boolean;
}

export interface KqlTokens {
  tokens: KqlToken[];
  /** [start, end) ranges of `//` comments, newline excluded. */
  comments: [number, number][];
}

const reject = (reason: string): never => {
  throw new AppError('KqlRejected', reason);
};

const isWordStart = (c: string): boolean => /[A-Za-z_$]/.test(c);
const isWordPart = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
const isDigit = (c: string): boolean => c >= '0' && c <= '9';

/**
 * If a string literal starts at `pos`, returns the index just after it; otherwise undefined.
 * Handles '…', "…" (backslash escapes), @'…' / @"…" (verbatim, doubled quote escapes),
 * h'…' / h@'…' (obfuscated) and ```…``` / ~~~…~~~ (multi-line).
 */
function readString(src: string, pos: number): number | undefined {
  let i = pos;
  const fence = src.slice(i, i + 3);
  if (fence === '```' || fence === '~~~') {
    const close = src.indexOf(fence, i + 3);
    if (close === -1) reject('The query contains an unterminated string literal.');
    return close + 3;
  }
  if (src[i] === 'h' || src[i] === 'H') {
    const next = src[i + 1];
    if (next !== "'" && next !== '"' && next !== '@') return undefined;
    if (next === '@' && src[i + 2] !== "'" && src[i + 2] !== '"') return undefined;
    i++;
  }
  let verbatim = false;
  if (src[i] === '@') {
    if (src[i + 1] !== "'" && src[i + 1] !== '"') return undefined;
    verbatim = true;
    i++;
  }
  const quote = src[i];
  if (quote !== "'" && quote !== '"') return undefined;
  i++;
  while (i < src.length) {
    const c = src[i];
    if (!verbatim && c === '\\') {
      i += 2;
      continue;
    }
    if (c === quote) {
      if (verbatim && src[i + 1] === quote) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i++;
  }
  return reject('The query contains an unterminated string literal.');
}

const skipSpaces = (src: string, pos: number): number => {
  let i = pos;
  while (i < src.length && /\s/.test(src[i] ?? '')) i++;
  return i;
};

/**
 * Lightweight KQL lexer. It is not a parser: it only knows enough to tell code apart from
 * comments and string literals, so the guard never matches keywords hidden in either.
 */
export function tokenizeKql(src: string): KqlTokens {
  const tokens: KqlToken[] = [];
  const comments: [number, number][] = [];
  let i = 0;
  let newline = true;

  const push = (
    kind: KqlTokenKind,
    start: number,
    end: number,
    quoted = false,
    text = src.slice(start, end),
  ) => {
    tokens.push({
      kind,
      text,
      value: kind === 'word' ? text.toLowerCase() : text,
      start,
      end,
      lineStart: newline,
      quoted,
    });
    newline = false;
  };

  while (i < src.length) {
    const c = src[i] ?? '';
    if (c === '\n' || c === '\r') {
      newline = true;
      i++;
      continue;
    }
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      let end = src.indexOf('\n', i);
      if (end === -1) end = src.length;
      if (src[end - 1] === '\r') end--;
      comments.push([i, end]);
      i = end;
      continue;
    }
    const strEnd = readString(src, i);
    if (strEnd !== undefined) {
      push('string', i, strEnd);
      i = strEnd;
      continue;
    }
    if (c === '[') {
      // Bracket-quoted identifier: ['name'] / ["name"]. Treated as a word so that ['cluster'](…)
      // cannot dodge the cross-scope check.
      const s = skipSpaces(src, i + 1);
      const sEnd = readString(src, s);
      if (sEnd !== undefined) {
        const close = skipSpaces(src, sEnd);
        if (src[close] === ']') {
          const inner = src.slice(s, sEnd).replace(/^[hH]?@?/, '');
          push('word', i, close + 1, true, inner.slice(1, -1));
          i = close + 1;
          continue;
        }
      }
      push('punct', i, i + 1);
      i++;
      continue;
    }
    if (isWordStart(c)) {
      let j = i + 1;
      while (j < src.length && isWordPart(src[j] ?? '')) j++;
      push('word', i, j);
      i = j;
      continue;
    }
    if (isDigit(c)) {
      let j = i + 1;
      while (j < src.length && /[A-Za-z0-9_.]/.test(src[j] ?? '')) j++;
      push('number', i, j);
      i = j;
      continue;
    }
    push('punct', i, i + 1);
    i++;
  }
  return { tokens, comments };
}
