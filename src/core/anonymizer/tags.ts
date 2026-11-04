export const MASKED = '[masked]';

/** Lowercased set for case-insensitive tag key matching (Azure tag keys are case-insensitive). */
export function normalizeTagKeys(keys: Iterable<string> | undefined): ReadonlySet<string> {
  return new Set([...(keys ?? [])].map((k) => k.toLowerCase()));
}

/**
 * Masks tag VALUES unless their key is allowlisted (`safeTagKeys` in contexts.yaml). Keys are kept:
 * they describe the schema (`env`, `owner`, `costCenter`), values are where people put emails,
 * ticket numbers, cost centres and the occasional secret.
 *
 * For mappers. `scrub()` applies the same rule to any object under a `tags` key, and still
 * scrubs the kept values and every key (ARM IDs in `hidden-link:` keys, emails, IPs…).
 */
export function maskTags<V>(
  tags: Readonly<Record<string, V>> | null | undefined,
  safeKeys: Iterable<string> = [],
): Record<string, V | typeof MASKED> {
  if (tags === null || tags === undefined) return {};
  const safe = normalizeTagKeys(safeKeys);
  // fromEntries defines own properties, so a `__proto__` tag key cannot touch the prototype.
  return Object.fromEntries(
    Object.entries(tags).map(([k, v]) => [k, safe.has(k.toLowerCase()) ? v : MASKED] as const),
  );
}
