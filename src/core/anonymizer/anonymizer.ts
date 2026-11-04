import type { PublicIpIndex } from './ip.js';
import { Pseudonymizer } from './pseudonymizer.js';
import { scrub, scrubString, type ScrubOptions } from './scrub.js';

export interface AnonymizerConfig {
  /** Real id → alias (contexts.yaml), shown instead of a pseudonym (`sub:prod-app`). */
  readonly aliases?: ReadonlyMap<string, string>;
  /** Tag keys whose values may be shown. Default: none. */
  readonly safeTagKeys?: readonly string[];
  readonly publicIpIndex?: PublicIpIndex;
}

/** A pseudonymizer bundled with its scrub options, so callers cannot forget the config. */
export interface Anonymizer {
  readonly pseudonymizer: Pseudonymizer;
  readonly options: ScrubOptions;
  scrub(value: unknown): unknown;
  scrubString(input: string): string;
}

export function createAnonymizer(config: AnonymizerConfig = {}): Anonymizer {
  const pseudonymizer = new Pseudonymizer(config.aliases);
  const options: ScrubOptions = {
    safeTagKeys: [...(config.safeTagKeys ?? [])],
    ...(config.publicIpIndex === undefined ? {} : { publicIpIndex: config.publicIpIndex }),
  };
  return {
    pseudonymizer,
    options,
    scrub: (value) => scrub(value, pseudonymizer, options),
    scrubString: (input) => scrubString(input, pseudonymizer, options),
  };
}
