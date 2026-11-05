/**
 * `id` generic GUIDs, `user` people (emails, UPNs, display names), `app` service principals and
 * app registrations, `public-ip-external` public IPs that are not one of our Public IP resources.
 * `ip` is kept for backward compatibility.
 */
export type PseudonymKind = 'id' | 'user' | 'app' | 'ip' | 'public-ip-external';

/**
 * Maps sensitive values to stable, meaningless placeholders (`id-001`, `user-002`).
 * The reverse map lives in memory only and is never exposed to the AI.
 * Known aliases (from contexts.yaml) take precedence so the AI sees `sub:prod-app`.
 */
export class Pseudonymizer {
  readonly #forward = new Map<string, string>();
  readonly #reverse = new Map<string, string>();
  readonly #counters = new Map<PseudonymKind, number>();

  constructor(aliases: ReadonlyMap<string, string> = new Map()) {
    for (const [value, alias] of aliases) this.#set(value.toLowerCase(), alias);
  }

  pseudonym(kind: PseudonymKind, value: string): string {
    const key = value.toLowerCase();
    const existing = this.#forward.get(key);
    if (existing !== undefined) return existing;

    let next = this.#counters.get(kind) ?? 0;
    let placeholder: string;
    // Skip numbers already taken, e.g. by a contexts.yaml alias spelled `id-001`.
    do {
      next++;
      placeholder = `${kind}-${String(next).padStart(3, '0')}`;
    } while (this.#reverse.has(placeholder));
    this.#counters.set(kind, next);
    this.#set(key, placeholder);
    return placeholder;
  }

  /** Resolves a placeholder back to the real value (used for tool INPUTS only). */
  resolve(placeholder: string): string | undefined {
    return this.#reverse.get(placeholder);
  }

  #set(key: string, placeholder: string): void {
    this.#forward.set(key, placeholder);
    this.#reverse.set(placeholder, key);
  }
}
