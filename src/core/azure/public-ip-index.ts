import { HARD_MAX_ROWS, type ResourceGraph } from './resource-graph.js';

export const PUBLIC_IP_TTL_MS = 5 * 60_000;
/** After a failed refresh, `lookup()` waits this long before trying again. */
const RETRY_MS = 30_000;

const PUBLIC_IP_QUERY = [
  'resources',
  "where type =~ 'microsoft.network/publicipaddresses'",
  'where isnotempty(properties.ipAddress)',
  'project name, ipAddress = tostring(properties.ipAddress)',
].join('\n| ');

/**
 * Maps public IPs to the name of their Azure public IP resource, so the anonymiser can show
 * a name instead of the address. Structurally compatible with the anonymiser's `PublicIpIndex`.
 */
export interface PublicIpLookup {
  /** Name of the public IP resource holding `ip`, from the last refresh. Never blocks. */
  lookup(ip: string): string | undefined;
  /** Reloads the index for the active context. */
  refresh(): Promise<void>;
}

export interface PublicIpIndexOptions {
  readonly ttlMs?: number;
  readonly now?: () => number;
  /** Alias of the active context, so an index built for one context is never used for another. */
  readonly contextAlias?: () => string | undefined;
}

export function createPublicIpIndex(
  resourceGraph: Pick<ResourceGraph, 'query'>,
  opts: PublicIpIndexOptions = {},
): PublicIpLookup {
  const ttlMs = opts.ttlMs ?? PUBLIC_IP_TTL_MS;
  const now = opts.now ?? Date.now;
  const currentContext = opts.contextAlias ?? (() => undefined);

  let index = new Map<string, string>();
  let builtFor: string | undefined;
  let attemptedFor: string | undefined;
  let nextAttemptAt = 0;
  let inFlight: Promise<void> | undefined;

  const refresh = (): Promise<void> => {
    inFlight ??= (async () => {
      const context = currentContext();
      attemptedFor = context;
      nextAttemptAt = now() + RETRY_MS;
      try {
        const rows = await resourceGraph.query<unknown>(PUBLIC_IP_QUERY, { maxRows: HARD_MAX_ROWS });
        const next = new Map<string, string>();
        for (const row of rows) {
          if (typeof row !== 'object' || row === null) continue;
          const { name, ipAddress } = row as { name?: unknown; ipAddress?: unknown };
          if (typeof name === 'string' && typeof ipAddress === 'string' && ipAddress !== '') {
            next.set(ipAddress, name);
          }
        }
        index = next;
        builtFor = context;
        nextAttemptAt = now() + ttlMs;
      } finally {
        inFlight = undefined;
      }
    })();
    return inFlight;
  };

  return {
    lookup(ip: string): string | undefined {
      const context = currentContext();
      const stale = nextAttemptAt <= now() || attemptedFor !== context;
      // Refresh in the background: lookup() runs inside the synchronous scrubber.
      // Failures (not logged in, …) just leave the IP unresolved, and the anonymiser redacts it.
      if (stale) refresh().catch(() => undefined);
      return builtFor === context ? index.get(ip) : undefined;
    },
    refresh,
  };
}
