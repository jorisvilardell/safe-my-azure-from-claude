import { z } from 'zod';
import { AppError } from '../errors/index.js';
import type { AzureSession, ContextStore, ResourceRef, ResourceResolver } from './contracts.js';
import { kqlString, type ResourceGraph } from './resource-graph.js';

export const RESOLVER_TTL_MS = 5 * 60_000;
/** Candidates listed in an `AmbiguousResource` error. */
export const MAX_CANDIDATES = 10;
const MAX_CACHE_ENTRIES = 1000;

const RESOURCE_GROUP_TYPES = new Set([
  'resourcegroups',
  'microsoft.resources/resourcegroups',
  'microsoft.resources/subscriptions/resourcegroups',
]);

const Row = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  resourceGroup: z.string(),
  subscriptionId: z.string(),
});
type Row = z.infer<typeof Row>;

export interface ResolverDeps {
  readonly resourceGraph: ResourceGraph;
  /** Usually `() => azure.session()`. */
  readonly session: () => AzureSession;
  /** Used to show subscriptions by alias (never by ID) in ambiguity errors. */
  readonly contexts: ContextStore;
  readonly ttlMs?: number;
  readonly now?: () => number;
}

function buildQuery(ref: ResourceRef): string {
  const type = ref.type?.trim();
  const isResourceGroup = type !== undefined && RESOURCE_GROUP_TYPES.has(type.toLowerCase());
  const filters = [`name =~ ${kqlString(ref.name)}`];

  if (isResourceGroup) {
    filters.unshift(`type =~ 'microsoft.resources/subscriptions/resourcegroups'`);
  } else if (type !== undefined && type !== '') {
    // `Microsoft.Compute/virtualMachines` matches exactly; `virtualMachines` matches the last segment.
    filters.push(
      type.includes('/') ? `type =~ ${kqlString(type)}` : `type endswith ${kqlString(`/${type}`)}`,
    );
  }
  if (ref.resourceGroup !== undefined) filters.push(`resourceGroup =~ ${kqlString(ref.resourceGroup)}`);

  const table = isResourceGroup ? 'resourcecontainers' : 'resources';
  return [
    table,
    `where ${filters.join(' and ')}`,
    'project id, name, type, resourceGroup, subscriptionId',
    'order by subscriptionId asc, resourceGroup asc, name asc',
    `take ${MAX_CANDIDATES + 1}`,
  ].join('\n| ');
}

function cacheKey(contextAlias: string, ref: ResourceRef): string {
  return [contextAlias, ref.subscription ?? '', ref.resourceGroup ?? '', ref.type ?? '', ref.name]
    .map((s) => s.toLowerCase())
    .join('\u0000');
}

/** `ResourceResolver` backed by Azure Resource Graph, with a short per-context TTL cache. */
export function createResourceResolver(deps: ResolverDeps): ResourceResolver {
  const ttlMs = deps.ttlMs ?? RESOLVER_TTL_MS;
  const now = deps.now ?? Date.now;
  const cache = new Map<string, { id: string; expiresAt: number }>();

  const subscriptionAliases = (session: AzureSession): Map<string, string> => {
    const aliases = deps.contexts.list().find((c) => c.alias === session.contextAlias)?.subscriptions ?? [];
    return new Map(aliases.map((alias) => [session.subscriptionId(alias).toLowerCase(), alias]));
  };

  const ambiguous = (ref: ResourceRef, rows: readonly Row[], session: AzureSession): AppError => {
    const shown = rows.slice(0, MAX_CANDIDATES);
    const multiSub = new Set(shown.map((r) => r.subscriptionId.toLowerCase())).size > 1;
    const aliases = multiSub ? subscriptionAliases(session) : new Map<string, string>();
    // Names only: the ARM ID and the subscription ID never go into the message (G2).
    const candidates = shown.map((r) => {
      const label = `${r.resourceGroup}/${r.type}/${r.name}`;
      if (!multiSub) return label;
      return `${label} (subscription ${aliases.get(r.subscriptionId.toLowerCase()) ?? 'unknown'})`;
    });
    const count = rows.length > MAX_CANDIDATES ? `more than ${MAX_CANDIDATES}` : String(rows.length);
    return new AppError(
      'AmbiguousResource',
      `Resource "${ref.name}" matches ${count} resources: ${candidates.join(', ')}. ` +
        'Add a resourceGroup, subscription or type.',
    );
  };

  return {
    async resolve(ref: ResourceRef): Promise<string> {
      const session = deps.session();
      const key = cacheKey(session.contextAlias, ref);
      const hit = cache.get(key);
      if (hit !== undefined && hit.expiresAt > now()) return hit.id;
      cache.delete(key);

      const subscriptions =
        ref.subscription === undefined ? undefined : [session.subscriptionId(ref.subscription)];
      const raw = await deps.resourceGraph.query<unknown>(buildQuery(ref), {
        maxRows: MAX_CANDIDATES + 1,
        ...(subscriptions === undefined ? {} : { subscriptions }),
      });
      const rows = raw.flatMap((r) => {
        const parsed = Row.safeParse(r);
        return parsed.success ? [parsed.data] : [];
      });

      const [first, ...rest] = rows;
      if (first === undefined) {
        throw new AppError(
          'ResourceNotFound',
          `Resource "${ref.name}" not found in context "${session.contextAlias}". Check the name, resourceGroup, subscription and type.`,
        );
      }
      if (rest.length > 0) throw ambiguous(ref, rows, session);

      if (cache.size >= MAX_CACHE_ENTRIES) cache.clear();
      cache.set(key, { id: first.id, expiresAt: now() + ttlMs });
      return first.id;
    },
  };
}
