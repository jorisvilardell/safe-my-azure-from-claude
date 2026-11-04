import type { InventoryIndex } from './inventory-index.js';

/**
 * Maps public IPs to the name of their Azure public IP resource, so the anonymiser can show
 * a name instead of the address. Structurally compatible with the anonymiser's `PublicIpIndex`.
 */
export interface PublicIpLookup {
  /** Name of the public IP resource holding `ip`, from the active context's snapshot. Never blocks. */
  lookup(ip: string): string | undefined;
  /** Rebuilds the active context's inventory snapshot. */
  refresh(): Promise<void>;
}

/**
 * A view over the inventory index (#33): no query of its own. `lookup()` runs inside the
 * synchronous scrubber, so a missing or stale snapshot only starts a background build, and the
 * IP stays unresolved (the anonymiser then redacts it). Over the cap, every public IP is redacted.
 */
export function createPublicIpIndex(inventory: Pick<InventoryIndex, 'current' | 'refresh'>): PublicIpLookup {
  return {
    lookup: (ip) => inventory.current()?.publicIpName(ip),
    refresh: () => inventory.refresh(),
  };
}
