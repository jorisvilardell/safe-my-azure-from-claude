import type { TokenCredential } from '@azure/core-auth';
import { z } from 'zod';
import { sanitizeError } from '../errors/index.js';
import type { Logger } from '../logging/index.js';
import type { AzureSession } from './contracts.js';
import type { ResourceGraphScan } from './resource-graph.js';

/**
 * In-memory inventory index (#33): one snapshot per context, built from ONE paged Resource Graph
 * query, and the single source for the resolver, the public IP index and the inventory tools.
 *
 * Lifecycle (decided, non-negotiable): the snapshot lives ONLY in this process's memory. It is
 * never written to a file, a volume, a tmpfs database or anywhere else. It is dropped on logout,
 * when the context's credential changes, and with the process. After a restart the AI simply
 * lists again and the index is rebuilt. ARM IDs inside it stay server-side (AGENTS.md G2).
 */

export const INVENTORY_TTL_MS = 5 * 60_000;
export const DEFAULT_INVENTORY_MAX_RESOURCES = 50_000;
/** Once a snapshot is this old (fraction of the TTL), the next use refreshes it in the background. */
const REFRESH_AHEAD = 0.8;
/** After a failed build, wait this long before trying again. */
const RETRY_MS = 30_000;
/** Over the cap, a rebuild downloads `maxResources` rows for nothing: retry rarely. */
const OVER_CAP_RETRY_FACTOR = 6;

const RESOURCE_GROUP_TYPE = 'microsoft.resources/subscriptions/resourcegroups';
const PUBLIC_IP_TYPE = 'microsoft.network/publicipaddresses';

/** Resources plus resource groups, in one query. `order by id` keeps paging stable. */
export const INVENTORY_QUERY = [
  'resources',
  `union (resourcecontainers | where type =~ '${RESOURCE_GROUP_TYPE}')`,
  [
    'project id, name, type, resourceGroup, subscriptionId, location, sku, kind, tags',
    `provisioningState = iff(type =~ '${RESOURCE_GROUP_TYPE}', tostring(properties.provisioningState), '')`,
    `ipAddress = iff(type =~ '${PUBLIC_IP_TYPE}', tostring(properties.ipAddress), '')`,
  ].join(', '),
  'order by id asc',
].join('\n| ');

/** One resource or resource group, shaped like a Resource Graph row so feature mappers reuse it. */
export interface InventoryEntry {
  /** ARM ID. Server-side only: never return it from a tool (G2). */
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly resourceGroup: string;
  /** Real subscription ID. Server-side only. */
  readonly subscriptionId: string;
  readonly location: string;
  readonly sku?: { readonly name?: string; readonly tier?: string; readonly capacity?: number };
  readonly kind?: string;
  /** Raw tag values: mask them (`maskTags`) before they leave the server. */
  readonly tags?: Readonly<Record<string, string>>;
  /** Resource groups only. */
  readonly provisioningState?: string;
  /** Public IP address resources only. */
  readonly ipAddress?: string;
}

export interface InventoryFilter {
  /** `resources` (default) or `resourceGroups`. */
  readonly table?: 'resources' | 'resourceGroups';
  /** Exact name, case-insensitive (KQL `=~`). */
  readonly name?: string | undefined;
  /** Part of the name, case-insensitive (KQL `contains`). */
  readonly nameContains?: string | undefined;
  /** Full type (exact, case-insensitive) or its last segment. Ignored for resource groups. */
  readonly type?: string | undefined;
  readonly resourceGroup?: string | undefined;
  readonly location?: string | undefined;
  /** Real subscription IDs. Omitted means every subscription of the context. */
  readonly subscriptionIds?: readonly string[] | undefined;
}

export interface InventorySnapshot {
  readonly contextAlias: string;
  /** Epoch ms of the Resource Graph read. */
  readonly builtAt: number;
  readonly resources: readonly InventoryEntry[];
  readonly resourceGroups: readonly InventoryEntry[];
  /** Name of the public IP resource holding `ip`. */
  publicIpName(ip: string): string | undefined;
  /** Entries matching every given filter, in snapshot order. */
  find(filter: InventoryFilter): InventoryEntry[];
}

export interface InventoryStatus {
  readonly builtAt: number;
  /** More resources than `maxResources`: no snapshot is kept, callers query live. */
  readonly overCap: boolean;
  readonly resourceCount: number;
}

export interface InventoryIndex {
  /** False when disabled (`maxResources: 0`): every caller always queries live. */
  readonly enabled: boolean;
  /**
   * Fresh snapshot of the active context, or `undefined` (none yet, stale, over the cap, not
   * logged in). Then callers query Resource Graph live. Never throws, never blocks: it starts a
   * build, or a refresh of a snapshot nearing its TTL, in the background.
   */
  current(): InventorySnapshot | undefined;
  /** Fresh snapshot of `contextAlias`, building it first if needed. `undefined` like `current()`. */
  load(contextAlias: string): Promise<InventorySnapshot | undefined>;
  /** (Re)builds the snapshot of `contextAlias` (default: the active context) now. Never rejects. */
  refresh(contextAlias?: string): Promise<void>;
  /** Forgets everything about `contextAlias` (logout). An in-flight build for it is discarded. */
  drop(contextAlias: string): void;
  status(contextAlias: string): InventoryStatus | undefined;
}

export interface InventoryIndexOptions {
  readonly ttlMs?: number;
  /** Per context. Over it, no snapshot is kept and callers fall back to live queries. 0 disables. */
  readonly maxResources?: number;
  readonly now?: () => number;
}

export interface InventoryIndexDeps extends InventoryIndexOptions {
  /** Session of any declared context. Throws `NotLoggedIn` when it has no credential. */
  readonly sessionFor: (contextAlias: string) => AzureSession;
  readonly activeContext: () => string | undefined;
  readonly isLoggedIn: (contextAlias: string) => boolean;
  readonly scan: ResourceGraphScan;
  readonly logger?: Logger;
}

const Row = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  type: z.string().min(1),
  resourceGroup: z.string().catch(''),
  subscriptionId: z.string().catch(''),
  location: z.string().catch(''),
  sku: z.unknown().optional(),
  kind: z.unknown().optional(),
  tags: z.unknown().optional(),
  provisioningState: z.unknown().optional(),
  ipAddress: z.unknown().optional(),
});

const nonEmpty = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Keeps only the fields we serve, so the snapshot holds less than Azure sent. */
function toEntry(raw: unknown): InventoryEntry | undefined {
  const parsed = Row.safeParse(raw);
  if (!parsed.success) return undefined;
  const r = parsed.data;
  const kind = nonEmpty(r.kind);
  const provisioningState = nonEmpty(r.provisioningState);
  const ipAddress = nonEmpty(r.ipAddress);
  let sku: InventoryEntry['sku'];
  if (isRecord(r.sku)) {
    const name = nonEmpty(r.sku.name);
    const tier = nonEmpty(r.sku.tier);
    const capacity = typeof r.sku.capacity === 'number' ? r.sku.capacity : undefined;
    sku = {
      ...(name === undefined ? {} : { name }),
      ...(tier === undefined ? {} : { tier }),
      ...(capacity === undefined ? {} : { capacity }),
    };
  }
  const tags = isRecord(r.tags)
    ? Object.fromEntries(
        Object.entries(r.tags).filter((e): e is [string, string] => typeof e[1] === 'string'),
      )
    : undefined;
  return {
    id: r.id,
    name: r.name,
    type: r.type,
    resourceGroup: r.resourceGroup,
    subscriptionId: r.subscriptionId,
    location: r.location,
    ...(sku === undefined ? {} : { sku }),
    ...(kind === undefined ? {} : { kind }),
    ...(tags === undefined ? {} : { tags }),
    ...(provisioningState === undefined ? {} : { provisioningState }),
    ...(ipAddress === undefined ? {} : { ipAddress }),
  };
}

const lower = (s: string): string => s.toLowerCase();

/** Same semantics as the KQL filters of the live queries (`=~`, `contains`, `endswith`). */
function matches(entry: InventoryEntry, f: InventoryFilter, isGroup: boolean): boolean {
  if (f.name !== undefined && lower(entry.name) !== lower(f.name)) return false;
  if (f.nameContains !== undefined && !lower(entry.name).includes(lower(f.nameContains))) return false;
  if (!isGroup && f.type !== undefined && f.type !== '') {
    const type = lower(f.type);
    const ok = type.includes('/') ? lower(entry.type) === type : lower(entry.type).endsWith(`/${type}`);
    if (!ok) return false;
  }
  if (f.resourceGroup !== undefined && lower(entry.resourceGroup) !== lower(f.resourceGroup)) return false;
  if (f.location !== undefined && lower(entry.location) !== lower(f.location)) return false;
  if (
    f.subscriptionIds !== undefined &&
    !f.subscriptionIds.some((s) => lower(s) === lower(entry.subscriptionId))
  ) {
    return false;
  }
  return true;
}

export function buildInventorySnapshot(
  contextAlias: string,
  builtAt: number,
  rows: readonly unknown[],
): InventorySnapshot {
  const resources: InventoryEntry[] = [];
  const resourceGroups: InventoryEntry[] = [];
  const publicIps = new Map<string, string>();
  for (const raw of rows) {
    const entry = toEntry(raw);
    if (entry === undefined) continue;
    if (lower(entry.type) === RESOURCE_GROUP_TYPE) {
      resourceGroups.push(entry);
      continue;
    }
    resources.push(entry);
    if (entry.ipAddress !== undefined && lower(entry.type) === PUBLIC_IP_TYPE) {
      publicIps.set(entry.ipAddress, entry.name);
    }
  }
  return {
    contextAlias,
    builtAt,
    resources,
    resourceGroups,
    publicIpName: (ip) => publicIps.get(ip),
    find(filter) {
      const isGroup = filter.table === 'resourceGroups';
      return (isGroup ? resourceGroups : resources).filter((e) => matches(e, filter, isGroup));
    },
  };
}

interface State {
  /** The credential the snapshot was read with: another one means a new login, so it is dropped. */
  readonly credential: TokenCredential;
  readonly builtAt: number;
  readonly resourceCount: number;
  /** Undefined when over the cap. */
  readonly snapshot: InventorySnapshot | undefined;
}

export function createInventoryIndex(deps: InventoryIndexDeps): InventoryIndex {
  const ttlMs = deps.ttlMs ?? INVENTORY_TTL_MS;
  const maxResources = Math.max(0, Math.floor(deps.maxResources ?? DEFAULT_INVENTORY_MAX_RESOURCES));
  const now = deps.now ?? Date.now;
  const enabled = maxResources > 0;

  // Process memory only (see the module comment). Nothing here is ever serialised.
  const states = new Map<string, State>();
  const generations = new Map<string, number>();
  const inFlight = new Map<string, Promise<void>>();
  const nextAttemptAt = new Map<string, number>();

  const generation = (alias: string): number => generations.get(alias) ?? 0;

  const drop = (alias: string): void => {
    states.delete(alias);
    nextAttemptAt.delete(alias);
    generations.set(alias, generation(alias) + 1);
  };

  const sessionOrUndefined = (alias: string): AzureSession | undefined => {
    try {
      return deps.sessionFor(alias);
    } catch {
      return undefined;
    }
  };

  /** Forgets logged-out contexts, and stale snapshots of contexts no longer in use. */
  const sweep = (active: string | undefined): void => {
    for (const [alias, state] of states) {
      if (!deps.isLoggedIn(alias)) drop(alias);
      else if (alias !== active && now() - state.builtAt >= ttlMs) drop(alias);
    }
  };

  /** The state of `alias`, if it was read with the context's current credential. */
  const validState = (alias: string, session: AzureSession): State | undefined => {
    const state = states.get(alias);
    if (state !== undefined && state.credential !== session.credential) {
      drop(alias);
      return undefined;
    }
    return state;
  };

  const build = async (alias: string): Promise<void> => {
    const gen = generation(alias);
    nextAttemptAt.set(alias, now() + RETRY_MS);
    try {
      const session = deps.sessionFor(alias);
      // One more row than the cap, to tell "exactly at the cap" from "over it".
      const { rows, truncated } = await deps.scan<unknown>(session, INVENTORY_QUERY, {
        maxRows: maxResources + 1,
      });
      // Logged out, or logged in again, while the query ran: the result is not ours to keep.
      if (generation(alias) !== gen || sessionOrUndefined(alias)?.credential !== session.credential) return;
      const builtAt = now();
      if (truncated || rows.length > maxResources) {
        states.set(alias, {
          credential: session.credential,
          builtAt,
          resourceCount: rows.length,
          snapshot: undefined,
        });
        nextAttemptAt.set(alias, builtAt + ttlMs * OVER_CAP_RETRY_FACTOR);
        deps.logger?.warn('inventory index over its cap, using live queries', {
          context: alias,
          maxResources,
        });
        return;
      }
      const snapshot = buildInventorySnapshot(alias, builtAt, rows);
      states.set(alias, { credential: session.credential, builtAt, resourceCount: rows.length, snapshot });
      nextAttemptAt.delete(alias);
      deps.logger?.debug('inventory index built', { context: alias, resources: rows.length });
    } catch (err) {
      // Not logged in yet, throttled, …: callers keep using live queries. The SDK error is not
      // logged, it may carry URLs and IDs (AGENTS.md R5).
      deps.logger?.warn('inventory index build failed', { context: alias, code: sanitizeError(err).code });
    }
  };

  const start = (alias: string): Promise<void> => {
    const running = inFlight.get(alias);
    if (running !== undefined) return running;
    const promise = build(alias).finally(() => inFlight.delete(alias));
    inFlight.set(alias, promise);
    return promise;
  };

  const isFresh = (state: State | undefined): state is State =>
    state !== undefined && now() - state.builtAt < ttlMs;

  const needsRefresh = (alias: string, state: State | undefined): boolean => {
    if (inFlight.has(alias) || now() < (nextAttemptAt.get(alias) ?? 0)) return false;
    return state === undefined || now() - state.builtAt >= ttlMs * REFRESH_AHEAD;
  };

  return {
    enabled,

    current() {
      if (!enabled) return undefined;
      const alias = deps.activeContext();
      sweep(alias);
      if (alias === undefined) return undefined;
      const session = sessionOrUndefined(alias);
      if (session === undefined) return undefined;
      const state = validState(alias, session);
      if (needsRefresh(alias, state)) void start(alias);
      return isFresh(state) ? state.snapshot : undefined;
    },

    async load(alias) {
      if (!enabled) return undefined;
      sweep(deps.activeContext());
      const session = sessionOrUndefined(alias);
      if (session === undefined) return undefined;
      let state = validState(alias, session);
      if (!isFresh(state)) {
        await start(alias);
        state = states.get(alias);
      } else if (needsRefresh(alias, state)) {
        void start(alias);
      }
      return isFresh(state) && state.credential === session.credential ? state.snapshot : undefined;
    },

    refresh(alias) {
      const target = alias ?? deps.activeContext();
      if (!enabled || target === undefined) return Promise.resolve();
      return start(target);
    },

    drop,

    status(alias) {
      const state = states.get(alias);
      if (state === undefined) return undefined;
      return {
        builtAt: state.builtAt,
        overCap: state.snapshot === undefined,
        resourceCount: state.resourceCount,
      };
    },
  };
}
