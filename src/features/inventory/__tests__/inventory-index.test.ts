import { describe, expect, it } from 'vitest';
import * as v from '../../../../test/fixtures/azure/index.js';
import {
  createFakeAzureAccess,
  createTestToolContext,
  expectNoLeak,
  FAKE_CONTEXTS,
  parseToolText,
  toolText,
  type FakeAzureAccess,
} from '../../../../test/helpers/index.js';
import { createAnonymizer } from '../../../core/anonymizer/index.js';
import { INVENTORY_QUERY, INVENTORY_TTL_MS } from '../../../core/azure/index.js';
import { contextIdAliases } from '../../../core/config/index.js';
import { executeTool } from '../../../core/mcp/index.js';
import { createInventoryFeature } from '../index.js';

const SUB_APP = FAKE_CONTEXTS.prod?.subscriptions['prod-app'] ?? '';
const SUB_NET = FAKE_CONTEXTS.prod?.subscriptions['prod-network'] ?? '';
const TAGS = { owner: v.OWNER_EMAIL, env: 'prod', app: `checkout from ${v.PUBLIC_IP_CLIENT}` };

function resource(sub: string, rg: string, type: string, name: string, extra: object = {}): object {
  return {
    id: `/subscriptions/${sub}/resourceGroups/${rg}/providers/${type}/${name}`,
    name,
    type: type.toLowerCase(),
    resourceGroup: rg,
    subscriptionId: sub,
    location: 'westeurope',
    tags: TAGS,
    ...extra,
  };
}

function group(sub: string, name: string): object {
  return {
    id: `/subscriptions/${sub}/resourceGroups/${name}`,
    name,
    type: 'microsoft.resources/subscriptions/resourcegroups',
    resourceGroup: name,
    subscriptionId: sub,
    location: 'westeurope',
    tags: TAGS,
    provisioningState: 'Succeeded',
  };
}

// Already in the live queries' order, so live and index answers can be compared as-is.
const GROUPS = [group(SUB_APP, 'rg-app'), group(SUB_NET, 'rg-net')];
const RESOURCES = [
  resource(SUB_APP, 'rg-app', 'Microsoft.Compute/virtualMachines', 'vm-web-01', {
    sku: { name: 'Standard_D2s_v5', tier: 'Standard' },
  }),
  resource(SUB_APP, 'rg-app', 'Microsoft.Web/sites', 'app-api', { kind: 'app,linux' }),
  resource(SUB_NET, 'rg-net', 'Microsoft.Network/publicIPAddresses', 'pip-web', {
    ipAddress: v.PUBLIC_IP_CLIENT,
  }),
];

const subscriptionOf = (row: object): unknown => (row as { subscriptionId?: unknown }).subscriptionId;
const nameOf = (row: object): unknown => (row as { name?: unknown }).name;

/**
 * `liveNames`: the rows Azure would return for the live query (the fake does not run KQL). The
 * fake does apply the subscription scope, like Azure.
 */
function setup(
  inventory: boolean,
  liveNames?: readonly string[],
): {
  azure: FakeAzureAccess;
  clock: { now: number };
  call: (name: string, args?: Record<string, unknown>) => Promise<unknown>;
} {
  const clock = { now: 1_000_000 };
  const azure = createFakeAzureAccess({
    ...(inventory ? { inventory: { now: () => clock.now } } : {}),
    resourceGraphRows: ({ query, subscriptions }) => {
      if (query === INVENTORY_QUERY) return [...GROUPS, ...RESOURCES];
      const rows = query.startsWith('resourcecontainers') ? GROUPS : RESOURCES;
      return rows.filter(
        (r) =>
          subscriptions.includes(String(subscriptionOf(r))) &&
          (liveNames === undefined || liveNames.includes(String(nameOf(r)))),
      );
    },
  });
  const ctx = createTestToolContext({
    azure,
    anonymizer: createAnonymizer({ aliases: contextIdAliases(FAKE_CONTEXTS), safeTagKeys: ['env', 'app'] }),
  });
  const feature = createInventoryFeature();
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<unknown> => {
    const tool = feature.tools.find((t) => t.name === name);
    if (tool === undefined) throw new Error(`missing tool ${name}`);
    const result = await executeTool(tool, args, ctx);
    expectNoLeak(toolText(result));
    return parseToolText(result);
  };
  return { azure, clock, call };
}

interface Case {
  readonly tool: string;
  readonly args: Record<string, unknown>;
  readonly live?: readonly string[];
}

const CASES: readonly Case[] = [
  { tool: 'search_resources', args: {} },
  { tool: 'search_resources', args: { name: 'WEB' }, live: ['vm-web-01', 'pip-web'] },
  {
    tool: 'search_resources',
    args: { type: 'virtualMachines', resourceGroup: 'RG-APP', location: 'westeurope' },
    live: ['vm-web-01'],
  },
  { tool: 'search_resources', args: { type: 'Microsoft.Web/sites' }, live: ['app-api'] },
  { tool: 'search_resources', args: { subscription: 'prod-network' } },
  { tool: 'search_resources', args: { limit: 2 } },
  { tool: 'list_resource_groups', args: {} },
  { tool: 'list_resource_groups', args: { subscription: 'prod-app' } },
  { tool: 'search_resources', args: { subscription: 'nope' } },
];

describe('inventory tools served from the in-memory index', () => {
  it.each(CASES)(
    '$tool $args: same output as the live query, without one',
    async ({ tool, args, live: names }) => {
      const live = setup(false, names);
      const expected = await live.call(tool, args);

      const indexed = setup(true);
      await indexed.azure.inventory.refresh();
      const actual = await indexed.call(tool, args);

      expect(actual).toEqual(expected);
      expect(indexed.azure.resourceGraphQueries.map((q) => q.query)).toEqual([INVENTORY_QUERY]);
    },
  );

  it('falls back to the live query while the index is building, and once it is stale', async () => {
    const { azure, clock, call } = setup(true, ['vm-web-01']);
    const live = (): number => azure.resourceGraphQueries.filter((q) => q.query !== INVENTORY_QUERY).length;

    await call('search_resources', { name: 'vm' });
    expect(live()).toBe(1);
    await call('search_resources', { name: 'vm' });
    expect(live()).toBe(1);

    clock.now += INVENTORY_TTL_MS;
    expect(await call('search_resources', { name: 'vm' })).toMatchObject({
      resources: [{ name: 'vm-web-01', subscription: 'prod-app', tags: { owner: '[masked]', env: 'prod' } }],
    });
    expect(live()).toBe(2);
  });

  it('is empty after logout: the next call is NotLoggedIn, not served from memory', async () => {
    const { azure, call } = setup(true);
    await azure.inventory.refresh();
    azure.logout('prod');
    expect(azure.inventory.status('prod')).toBeUndefined();
    expect(await call('search_resources', {})).toMatchObject({ code: 'NotLoggedIn' });
  });
});
