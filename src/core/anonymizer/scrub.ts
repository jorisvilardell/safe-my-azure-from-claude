import { ARM_ID, BEARER, EMAIL, GUID, JWT, KEY_VALUE_SECRET, PEM } from './patterns.js';
import type { Pseudonymizer } from './pseudonymizer.js';

export const REDACTED = '[REDACTED]';

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

export function scrubString(input: string, p: Pseudonymizer): string {
  return input
    .replace(PEM, REDACTED)
    .replace(JWT, REDACTED)
    .replace(BEARER, `Bearer ${REDACTED}`)
    .replace(KEY_VALUE_SECRET, (_m, key: string) => `${key}=${REDACTED}`)
    .replace(ARM_ID, (id) => shortenArmId(id, p))
    .replace(GUID, (g) => p.pseudonym('id', g))
    .replace(EMAIL, (e) => p.pseudonym('user', e));
}

/**
 * Deep-scrubs any JSON-like value. This is the single choke point that enforces
 * guarantees G1/G2 (AGENTS.md). Object KEYS are scrubbed too (tags, dynamic maps).
 */
export function scrub(value: unknown, p: Pseudonymizer): unknown {
  if (typeof value === 'string') return scrubString(value, p);
  if (Array.isArray(value)) return value.map((v) => scrub(v, p));
  if (value instanceof Date) return value.toISOString();
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [scrubString(k, p), scrub(v, p)] as const),
    );
  }
  return value;
}
