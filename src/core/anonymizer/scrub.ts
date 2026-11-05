import {
  isAppIdKey,
  isIdentityContext,
  isNonSecretObjectKey,
  isSecretKey,
  isTagsKey,
  isUserKey,
  isVersionKey,
  normalizeKey,
} from './fields.js';
import { maskPublicIPv4, maskPublicIPv6, type PublicIpIndex } from './ip.js';
import {
  ARM_ID,
  BASIC,
  BEARER,
  EMAIL,
  GUID,
  GUID_NO_DASHES,
  GUID_ONLY,
  HEADER_SECRET,
  JSON_SECRET_FIELD,
  JWT,
  KEY_VALUE_SECRET,
  KNOWN_TOKEN,
  PEM,
  PEM_UNTERMINATED,
  PERCENT_RUN,
  QUERY_SECRET,
  SAS_CONNECTION_STRING,
  SAS_TOKEN,
  URL_USERINFO,
} from './patterns.js';
import type { PseudonymKind, Pseudonymizer } from './pseudonymizer.js';
import { MASKED, maskTags, normalizeTagKeys } from './tags.js';

export const REDACTED = '[REDACTED]';

/**
 * Optional knobs for `scrub()` / `scrubString()`. Every default is the most restrictive one:
 * with no options, every tag value is masked and every public IP becomes `public-ip-external-NNN`.
 */
export interface ScrubOptions {
  /** Tag keys whose VALUES may be shown (`safeTagKeys` in contexts.yaml). Case-insensitive. */
  readonly safeTagKeys?: Iterable<string>;
  /** Maps our own public IPs to their Public IP resource name (`public-ip-<name>`). */
  readonly publicIpIndex?: PublicIpIndex;
  /**
   * For data whose keys and wording the AI controls (KQL results): no field-name exception
   * lowers the masking. Today that is the `*Version` exception for IPv4, which
   * `bag_pack('xversion', ClientIP)` or `strcat('version ', ip)` would otherwise exploit.
   */
  readonly strict?: boolean;
}

interface Resolved {
  readonly safeTagKeys: ReadonlySet<string>;
  readonly publicIpIndex: PublicIpIndex | undefined;
  readonly strict: boolean;
}

interface TextMode {
  /** Kind used for bare GUIDs (`app` inside `appId`/`clientId` fields). */
  readonly guidKind: PseudonymKind;
  /** False for `*Version` fields, whose dotted values (`1.10.2.0`) are not IPs. */
  readonly maskIPv4: boolean;
}

const DEFAULT_MODE: TextMode = { guidKind: 'id', maskIPv4: true };

function resolve(options: ScrubOptions): Resolved {
  return {
    safeTagKeys: normalizeTagKeys(options.safeTagKeys),
    publicIpIndex: options.publicIpIndex,
    strict: options.strict === true,
  };
}

/** Control and invisible characters must not come back through a decoded escape. */
// eslint-disable-next-line no-control-regex -- control characters are exactly what we refuse.
const UNSAFE_DECODED = /[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/;

function decodeRun(run: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(run);
  } catch {
    // Not UTF-8: decode byte by byte, which is enough to expose ASCII identifiers.
    decoded = run.replace(/%([0-9a-f]{2})/gi, (_m, h: string) => String.fromCharCode(Number.parseInt(h, 16)));
  }
  return UNSAFE_DECODED.test(decoded) ? run : decoded;
}

/**
 * Percent-decodes `%XX` runs (up to 3 levels, for double-encoded URLs) so encoded IDs, emails,
 * IPs and secrets (`%2Fsubscriptions%2F<guid>`, `jane%40contoso.com`) are seen by the patterns.
 * The decoded text is what the AI gets: URLs stay readable, and nothing hides behind an escape.
 */
function percentDecode(input: string): string {
  let out = input;
  for (let i = 0; i < 3 && out.includes('%'); i++) {
    const next = out.replace(PERCENT_RUN, decodeRun);
    if (next === out) break;
    out = next;
  }
  return out;
}

const quoted = (value: string): string =>
  value.startsWith('"') ? `"${REDACTED}"` : value.startsWith("'") ? `'${REDACTED}'` : REDACTED;

/**
 * `/subscriptions/<sub>/resourceGroups/<rg>/providers/<ns>/<type>/<name>[/<childType>/<child>]`
 * → `<rg>/<type>/<name>[/<childType>/<child>]` (names only, no IDs).
 */
export function shortenArmId(armId: string, p: Pseudonymizer): string {
  const segments = armId.split('/').filter(Boolean);
  const lower = segments.map((s) => s.toLowerCase());

  const rgIdx = lower.indexOf('resourcegroups');
  const provIdx = lower.indexOf('providers');

  if (rgIdx === -1) {
    // Subscription-scoped ID: keep only the subscription alias/pseudonym.
    const sub = segments[1] ?? '';
    const rest = provIdx === -1 ? [] : segments.slice(provIdx + 2);
    return [`sub:${p.pseudonym('id', sub)}`, ...rest].join('/');
  }

  const rg = segments[rgIdx + 1] ?? '';
  // After "providers/<namespace>" come alternating type/name pairs.
  const tail = provIdx === -1 ? [] : segments.slice(provIdx + 2);
  return [rg, ...tail].join('/');
}

/**
 * Order matters:
 * 0. Percent-escapes are decoded, so nothing hides behind `%2F`, `%40` or `%3D`.
 * 1. Secrets first (PEM, JWT, known token formats, SAS, Bearer/Basic, URL passwords, headers,
 *    key=value, JSON fields): they are removed whole, before any later pass could rewrite part
 *    of them and break the match.
 * 2. ARM IDs before bare GUIDs: an ARM ID contains the subscription GUID and must be shortened
 *    to names as a unit.
 * 3. GUIDs, then emails.
 * 4. IPs LAST. By then GUIDs and ARM IDs are placeholders, so digits inside them can no longer
 *    look like an IP; IPv6 runs before IPv4 so `::ffff:203.0.113.5` is replaced whole.
 */
function scrubText(input: string, p: Pseudonymizer, r: Resolved, mode: TextMode): string {
  const s = percentDecode(input)
    .replace(PEM, REDACTED)
    .replace(PEM_UNTERMINATED, REDACTED)
    .replace(JWT, REDACTED)
    .replace(KNOWN_TOKEN, REDACTED)
    .replace(SAS_CONNECTION_STRING, `SharedAccessSignature=${REDACTED}`)
    .replace(SAS_TOKEN, `SharedAccessSignature ${REDACTED}`)
    .replace(BEARER, `Bearer ${REDACTED}`)
    .replace(BASIC, `Basic ${REDACTED}`)
    .replace(URL_USERINFO, (_m, scheme: string, user: string) => `${scheme}${user}:${REDACTED}@`)
    .replace(HEADER_SECRET, (_m, name: string, sep: string) => `${name}${sep}${REDACTED}`)
    .replace(
      KEY_VALUE_SECRET,
      (_m, key: string, sep: string, value: string) => `${key}${sep}${quoted(value)}`,
    )
    .replace(QUERY_SECRET, (_m, key: string) => `${key}=${REDACTED}`)
    .replace(JSON_SECRET_FIELD, (_m, prefix: string) => `${prefix}"${REDACTED}"`)
    .replace(ARM_ID, (id) => shortenArmId(id, p))
    .replace(GUID, (g) => p.pseudonym(mode.guidKind, g))
    .replace(GUID_NO_DASHES, (g) => p.pseudonym(mode.guidKind, g))
    .replace(EMAIL, (e) => p.pseudonym('user', e));
  const v6 = maskPublicIPv6(s, p, r.publicIpIndex);
  return mode.maskIPv4 || r.strict ? maskPublicIPv4(v6, p, r.publicIpIndex, r.strict) : v6;
}

export function scrubString(input: string, p: Pseudonymizer, options: ScrubOptions = {}): string {
  return scrubText(input, p, resolve(options), DEFAULT_MODE);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date);
}

/** A person/caller field: a bare GUID is a service principal, anything else is a user. */
function pseudonymizeIdentity(value: string, p: Pseudonymizer): string {
  const trimmed = value.trim();
  if (trimmed === '') return value;
  return p.pseudonym(GUID_ONLY.test(trimmed) ? 'app' : 'user', trimmed);
}

function walk(value: unknown, p: Pseudonymizer, r: Resolved, key: string | undefined): unknown {
  if (typeof value === 'string') {
    const mode =
      key === undefined
        ? DEFAULT_MODE
        : ({ guidKind: isAppIdKey(key) ? 'app' : 'id', maskIPv4: !isVersionKey(key) } as const);
    return scrubText(value, p, r, mode);
  }
  if (Array.isArray(value)) return value.map((v) => walk(v, p, r, key));
  if (value instanceof Date) return value.toISOString();
  if (value !== null && typeof value === 'object') {
    const inIdentity = isIdentityContext(key, value);
    return Object.fromEntries(
      Object.entries(value).map(
        ([k, v]) => [scrubText(k, p, r, DEFAULT_MODE), field(k, v, p, r, inIdentity)] as const,
      ),
    );
  }
  return value;
}

/** Everything under a secret key: keeps the shape (keys are still scrubbed), redacts every value. */
function redactLeaves(value: unknown, p: Pseudonymizer, r: Resolved): unknown {
  if (Array.isArray(value)) return value.map((v) => redactLeaves(v, p, r));
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(
        ([k, v]) => [scrubText(k, p, r, DEFAULT_MODE), redactLeaves(v, p, r)] as const,
      ),
    );
  }
  // Booleans and null carry no secret (`enabled: true`) and help the AI read the shape.
  return typeof value === 'boolean' || value === null ? value : REDACTED;
}

/** Applies the field-name rules (fields.ts) to the value of key `rawKey`. */
function field(rawKey: string, value: unknown, p: Pseudonymizer, r: Resolved, inIdentity: boolean): unknown {
  // Arrays inherit their key's rules: `owners: ['Jane Doe']`, `secrets: ['…']`.
  if (Array.isArray(value)) return value.map((v) => field(rawKey, v, p, r, inIdentity));

  const nk = normalizeKey(rawKey);

  if (isSecretKey(rawKey)) {
    if (typeof value === 'string' || typeof value === 'number') return REDACTED;
    // `secrets: [{ name, value }]`, `credentials: { value }`: the leaves are the secret, whatever their key.
    if (isPlainObject(value) && !isNonSecretObjectKey(nk)) return redactLeaves(value, p, r);
  }

  if (isTagsKey(nk) && isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(maskTags(value, r.safeTagKeys)).map(
        ([tk, tv]) =>
          // Allowlisted values are shown, but still go through the full scrubber.
          [scrubText(tk, p, r, DEFAULT_MODE), tv === MASKED ? MASKED : walk(tv, p, r, undefined)] as const,
      ),
    );
  }

  if (typeof value === 'string' && isUserKey(nk, inIdentity)) return pseudonymizeIdentity(value, p);

  return walk(value, p, r, nk);
}

/**
 * Deep-scrubs any JSON-like value. This is the single choke point that enforces
 * guarantees G1/G2 (AGENTS.md). Object KEYS are scrubbed too (tags, dynamic maps).
 *
 * On top of the string patterns, field names drive extra rules (see fields.ts):
 * - secret-looking keys (`password`, `clientSecret`, `x-ms-token-*`, …) → `[REDACTED]`, including
 *   every value nested in an array or object under them (`secrets: [{ name, value }]`);
 * - objects under a `tags` key → values `[masked]` unless the key is in `options.safeTagKeys`;
 * - `appId`/`clientId`/… → `app-NNN`; `caller`/`userPrincipalName`/… (and `displayName`/`name`
 *   inside an identity object) → `user-NNN`, or `app-NNN` when the value is a bare GUID;
 * - `*Version` fields are not scanned for IPv4 (`1.10.2.0` is a version, not an address).
 */
export function scrub(value: unknown, p: Pseudonymizer, options: ScrubOptions = {}): unknown {
  return walk(value, p, resolve(options), undefined);
}
