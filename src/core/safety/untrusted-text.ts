/**
 * Text copied from Azure (names, tag values, descriptions, log cells, Advisor text) is written by
 * anyone with write access to the tenant. It is data for the AI, never instructions (issue #39).
 * These helpers neutralise characters that hide text from a human reviewer but not from a model,
 * and cap the length so one field cannot flood the AI's context.
 *
 * NFKC is deliberately NOT applied to returned values: it rewrites data (`ﬁ` → `fi`, fullwidth →
 * ASCII, `²` → `2`), which would break names the AI sends back to look a resource up. It is only
 * applied to the private copy that `detectInjection()` matches against.
 */

/**
 * Invisible characters: zero-width (U+200B–U+200F), word joiner (U+2060), BOM (U+FEFF), bidi
 * embeddings/overrides (U+202A–U+202E) and isolates (U+2066–U+2069), Unicode tag characters
 * (U+E0000–U+E007F, "ASCII smuggling"), and C0/C1 control characters except `\t` and `\n`.
 * `\r`, `\v`, `\f` and NEL are line breaks: they are turned into `\n` first.
 */
const INVISIBLE_RANGES: readonly (readonly [number, number])[] = [
  [0x00, 0x08],
  [0x0e, 0x1f],
  [0x7f, 0x84],
  [0x86, 0x9f],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x2060],
  [0x2066, 0x2069],
  [0xfeff, 0xfeff],
  [0xe0000, 0xe007f],
];
const LINE_BREAK_CHARS = [0x0b, 0x0c, 0x0d, 0x85, 0x2028, 0x2029];

// Built from code points so this source file never contains an invisible character itself.
const cp = (n: number): string => String.fromCodePoint(n);
const INVISIBLE = new RegExp(`[${INVISIBLE_RANGES.map(([a, b]) => `${cp(a)}-${cp(b)}`).join('')}]`, 'gu');
const LINE_BREAKS = new RegExp(`${cp(0x0d)}${cp(0x0a)}|[${LINE_BREAK_CHARS.map(cp).join('')}]`, 'gu');

export interface NeutralizeOptions {
  /**
   * Keep line breaks and tabs (log messages, stack traces). Runs of other whitespace become one
   * space and more than two blank lines in a row are collapsed. Default: every whitespace run,
   * line breaks included, becomes one space and the result is trimmed.
   */
  readonly multiline?: boolean;
}

/** Removes invisible and control characters only. Everything else is kept as-is. */
export function stripInvisible(text: string): string {
  return text.replace(LINE_BREAKS, '\n').replace(INVISIBLE, '');
}

/** `stripInvisible()` plus whitespace collapsing. Never caps. */
export function neutralizeText(text: string, opts: NeutralizeOptions = {}): string {
  const visible = stripInvisible(text);
  if (opts.multiline === true) {
    return visible
      .replace(/[^\S\n\t]+/gu, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
  return visible.replace(/\s+/gu, ' ').trim();
}

export interface TruncateOptions {
  /** Appended when the text is cut, inside the `max` budget. Default `…`. */
  readonly ellipsis?: string;
  /**
   * `word` (default): cut at the last whitespace and drop the partial word. Use it for text that
   * is scrubbed AFTER it is capped: cutting through a GUID, email or token would leave a fragment
   * the anonymizer no longer recognises. `char`: cut anywhere, for text that was scrubbed first.
   */
  readonly at?: 'word' | 'char';
}

export interface Truncated {
  readonly text: string;
  readonly cut: boolean;
}

/** Caps `text` at `max` UTF-16 code units, ellipsis included. Never splits a surrogate pair. */
export function truncateText(text: string, max: number, opts: TruncateOptions = {}): Truncated {
  if (text.length <= max) return { text, cut: false };
  const ellipsis = opts.ellipsis ?? '…';
  let end = Math.max(0, max - ellipsis.length);
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end--;
  let head = text.slice(0, end);
  if ((opts.at ?? 'word') === 'word') {
    // The character right after the cut decides: if it is whitespace, the last word is complete.
    const next = text.charAt(end);
    if (!/\s/u.test(next)) {
      const cut = head.search(/\s\S*$/u);
      head = cut === -1 ? '' : head.slice(0, cut);
    }
    head = head.trimEnd();
  }
  return { text: `${head}${ellipsis}`, cut: true };
}

export interface UntrustedTextOptions extends NeutralizeOptions, TruncateOptions {
  /** Length cap (UTF-16 code units, ellipsis included). */
  readonly max: number;
}

/**
 * Normalises one free-text value copied from Azure: invisible and control characters removed,
 * whitespace collapsed, length capped. Returns `undefined` for a non-string or for text that is
 * empty once cleaned. Use it in every mapper for free text (AGENTS.md feature checklist).
 */
export function untrustedText(value: unknown, opts: UntrustedTextOptions): string | undefined {
  if (typeof value !== 'string') return undefined;
  const clean = neutralizeText(value, opts);
  if (clean === '') return undefined;
  return truncateText(clean, opts.max, opts).text;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date);
}

/**
 * `stripInvisible()` on every string of a JSON-like value, object keys included. `executeTool`
 * runs it on every result BEFORE scrubbing, so `jane<U+200B>@contoso.com` is seen as an email.
 */
export function stripInvisibleDeep(value: unknown): unknown {
  if (typeof value === 'string') return stripInvisible(value);
  if (Array.isArray(value)) return value.map(stripInvisibleDeep);
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [stripInvisible(k), stripInvisibleDeep(v)] as const),
    );
  }
  return value;
}
