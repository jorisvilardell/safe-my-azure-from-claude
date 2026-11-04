import { kqlString, type AzureAccess, type AzureSession } from '../../core/azure/index.js';
import { AppError } from '../../core/errors/index.js';
import {
  toResourceDetailsDto,
  toResourceDto,
  toResourceGroupDto,
  toSubscriptionStates,
  type MapperDeps,
  type ResourceDetailsDto,
  type ResourceDto,
  type ResourceGroupDto,
  type SubscriptionAliases,
  type SubscriptionDto,
} from './inventory.mapper.js';
import { DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT } from './inventory.schemas.js';

/** Resource groups returned by one call; more sets `truncated`. */
export const MAX_RESOURCE_GROUPS = 500;

export interface InventoryDeps {
  readonly azure: AzureAccess;
  /** `safeTagKeys` from contexts.yaml (via `ctx.anonymizer.options`). */
  readonly safeTagKeys: Iterable<string>;
}

export interface SubscriptionsResult {
  readonly context: string;
  readonly subscriptions: readonly SubscriptionDto[];
}

export interface ResourceGroupsResult {
  readonly resourceGroups: readonly ResourceGroupDto[];
  readonly truncated: boolean;
}

export interface SearchResult {
  readonly resources: readonly ResourceDto[];
  readonly truncated: boolean;
}

export interface SearchInput {
  readonly name?: string | undefined;
  readonly type?: string | undefined;
  readonly resourceGroup?: string | undefined;
  readonly location?: string | undefined;
  readonly subscription?: string | undefined;
  readonly limit?: number | undefined;
}

export interface GetResourceInput {
  readonly resourceGroup: string;
  readonly name: string;
  readonly type?: string | undefined;
  readonly subscription?: string | undefined;
}

function aliasesOf(azure: AzureAccess, session: AzureSession): readonly string[] {
  return azure.contexts.list().find((c) => c.alias === session.contextAlias)?.subscriptions ?? [];
}

function subscriptionAliases(azure: AzureAccess, session: AzureSession): SubscriptionAliases {
  return new Map(aliasesOf(azure, session).map((a) => [session.subscriptionId(a).toLowerCase(), a]));
}

function mapperDeps(deps: InventoryDeps, session: AzureSession): MapperDeps {
  return { subscriptionAliases: subscriptionAliases(deps.azure, session), safeTagKeys: deps.safeTagKeys };
}

function scope(session: AzureSession, subscription: string | undefined): { subscriptions?: string[] } {
  return subscription === undefined ? {} : { subscriptions: [session.subscriptionId(subscription)] };
}

/** `Microsoft.Compute/virtualMachines` matches exactly; `virtualMachines` matches the last segment. */
function typeFilter(type: string): string {
  return type.includes('/') ? `type =~ ${kqlString(type)}` : `type endswith ${kqlString(`/${type}`)}`;
}

/**
 * Subscriptions are shown by their contexts.yaml ALIAS only. The Azure display name is NOT
 * returned: it is chosen by whoever created the subscription and often names the company,
 * customer or project, which the alias already covers without that risk (AGENTS.md "reveal less").
 */
export async function listSubscriptions(deps: InventoryDeps): Promise<SubscriptionsResult> {
  const session = deps.azure.session();
  const rows = await deps.azure.resourceGraph.query<unknown>(
    [
      'resourcecontainers',
      "where type =~ 'microsoft.resources/subscriptions'",
      'project subscriptionId, state = tostring(properties.state)',
    ].join('\n| '),
  );
  const states = toSubscriptionStates(rows);
  return {
    context: session.contextAlias,
    subscriptions: aliasesOf(deps.azure, session).map((alias) => ({
      alias,
      // No row: the signed-in identity cannot see it, or the ID in contexts.yaml is wrong.
      state: states.get(session.subscriptionId(alias).toLowerCase()) ?? 'NotVisible',
    })),
  };
}

export async function listResourceGroups(
  deps: InventoryDeps,
  input: { readonly subscription?: string | undefined },
): Promise<ResourceGroupsResult> {
  const session = deps.azure.session();
  const { rows, truncated } = await deps.azure.resourceGraph.queryResult<unknown>(
    [
      'resourcecontainers',
      "where type =~ 'microsoft.resources/subscriptions/resourcegroups'",
      'project name, location, tags, subscriptionId, provisioningState = tostring(properties.provisioningState)',
      'order by subscriptionId asc, name asc',
    ].join('\n| '),
    { maxRows: MAX_RESOURCE_GROUPS, ...scope(session, input.subscription) },
  );
  const md = mapperDeps(deps, session);
  return {
    resourceGroups: rows.flatMap((r) => toResourceGroupDto(r, md) ?? []),
    truncated,
  };
}

export function buildSearchQuery(input: SearchInput): string {
  const filters: string[] = [];
  if (input.name !== undefined) filters.push(`name contains ${kqlString(input.name)}`);
  if (input.type !== undefined) filters.push(typeFilter(input.type));
  if (input.resourceGroup !== undefined) filters.push(`resourceGroup =~ ${kqlString(input.resourceGroup)}`);
  if (input.location !== undefined) filters.push(`location =~ ${kqlString(input.location)}`);
  return [
    'resources',
    ...(filters.length === 0 ? [] : [`where ${filters.join(' and ')}`]),
    'project id, name, type, resourceGroup, subscriptionId, location, sku, kind, tags',
    'order by resourceGroup asc, type asc, name asc',
  ].join('\n| ');
}

export async function searchResources(deps: InventoryDeps, input: SearchInput): Promise<SearchResult> {
  const session = deps.azure.session();
  // No `take` in the KQL: the row cap is applied by queryResult, which then reports `truncated`.
  const limit = Math.max(1, Math.min(Math.floor(input.limit ?? DEFAULT_SEARCH_LIMIT), MAX_SEARCH_LIMIT));
  const { rows, truncated } = await deps.azure.resourceGraph.queryResult<unknown>(buildSearchQuery(input), {
    maxRows: limit,
    ...scope(session, input.subscription),
  });
  const md = mapperDeps(deps, session);
  return { resources: rows.flatMap((r) => toResourceDto(r, md) ?? []), truncated };
}

export async function getResource(
  deps: InventoryDeps,
  input: GetResourceInput,
): Promise<{ readonly resource: ResourceDetailsDto }> {
  const session = deps.azure.session();
  const id = await deps.azure.resolver.resolve({
    name: input.name,
    resourceGroup: input.resourceGroup,
    ...(input.type === undefined ? {} : { type: input.type }),
    ...(input.subscription === undefined ? {} : { subscription: input.subscription }),
  });
  // The ID stays server-side: it only goes into the query, as an escaped literal.
  const rows = await deps.azure.resourceGraph.query<unknown>(
    [
      'resources',
      `where id =~ ${kqlString(id)}`,
      'project id, name, type, resourceGroup, subscriptionId, location, sku, kind, tags, properties',
      'take 1',
    ].join('\n| '),
    { maxRows: 1, ...scope(session, input.subscription) },
  );
  const resource = rows.length === 0 ? undefined : toResourceDetailsDto(rows[0], mapperDeps(deps, session));
  if (resource === undefined) {
    throw new AppError(
      'ResourceNotFound',
      `Resource "${input.name}" in resource group "${input.resourceGroup}" was not found in context "${session.contextAlias}".`,
    );
  }
  return { resource };
}
