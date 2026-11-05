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
 *
 * There is ONE pseudonymizer per server process (`main.ts`), shared by every context and every
 * MCP client: the same value gets the same placeholder whatever context is active, and a
 * placeholder from one context still resolves after `use_context`. It is never persisted, so
 * placeholders (alert refs, `id-NNN`, `user-NNN`) start over on restart and an old one no longer
 * resolves. The AI can therefore tell that a value seen in two contexts is the same one (same
 * placeholder), never what it is. Documented in docs/SECURITY.md (#53).
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

  /**
   * Makes a placeholder chosen outside the counters (`public-ip-<resource name>`) resolve to
   * `value`, without making it THE placeholder of `value`: `pseudonym()` is unchanged. The last
   * binding wins, so it follows what the AI was shown most recently. Refused (false) when
   * `placeholder` is a counter placeholder or an alias of another value.
   */
  bind(value: string, placeholder: string): boolean {
    const key = value.toLowerCase();
    const owner = this.#reverse.get(placeholder);
    if (owner !== undefined && owner !== key && this.#forward.get(owner) === placeholder) return false;
    this.#reverse.set(placeholder, key);
    return true;
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
