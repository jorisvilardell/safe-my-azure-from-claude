import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as v from '../../../../test/fixtures/azure/index.js';
import {
  createFakeAzureAccess,
  createTestToolContext,
  expectNoLeak,
  FAKE_CONTEXTS,
  FAKE_RESOURCES,
  parseToolText,
  toolText,
  type FakeAzureAccess,
} from '../../../../test/helpers/index.js';
import { createAnonymizer } from '../../../core/anonymizer/index.js';
import { contextIdAliases } from '../../../core/config/index.js';
import { executeTool, type ToolDefinition } from '../../../core/mcp/index.js';
import { createInventoryFeature } from '../index.js';
import { MAX_TEXT_LENGTH } from '../inventory.mapper.js';
import { GetResourceInput, SearchResourcesInput } from '../inventory.schemas.js';

const SUB_APP = FAKE_CONTEXTS.prod?.subscriptions['prod-app'] ?? '';
const SUB_NET = FAKE_CONTEXTS.prod?.subscriptions['prod-network'] ?? '';
const VM = FAKE_RESOURCES[0];
if (VM === undefined) throw new Error('missing fake VM');

const feature = createInventoryFeature();

function tool(name: string): ToolDefinition {
  const t = feature.tools.find((x) => x.name === name);
  if (t === undefined) throw new Error(`missing tool ${name}`);
  return t;
}

function setup(rows: readonly unknown[] = []): {
  azure: FakeAzureAccess;
  call: (name: string, args?: Record<string, unknown>) => Promise<CallToolResult>;
} {
  const azure = createFakeAzureAccess({ resourceGraphRows: rows });
  const ctx = createTestToolContext({
    azure,
    anonymizer: createAnonymizer({ aliases: contextIdAliases(FAKE_CONTEXTS), safeTagKeys: ['env', 'app'] }),
  });
  // executeTool skips the MCP SDK's zod validation, so these calls also probe the service's own defences.
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> => {
    const result = await executeTool(tool(name), args, ctx);
    expectNoLeak(toolText(result));
    return result;
  };
  return { azure, call };
}

const TAGS = {
  owner: v.OWNER_EMAIL,
  'created-by': v.CALLER_EMAIL,
  env: 'prod',
  app: `checkout from ${v.PUBLIC_IP_CLIENT}`,
  costCenter: 'CC-1234',
};

function resourceRow(name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `/subscriptions/${SUB_APP}/resourceGroups/rg-app/providers/Microsoft.Compute/virtualMachines/${name}`,
    name,
    type: 'microsoft.compute/virtualmachines',
    resourceGroup: 'rg-app',
    subscriptionId: SUB_APP,
    tenantId: v.TENANT_ID,
    location: 'westeurope',
    tags: TAGS,
    ...extra,
  };
}

describe('inventory feature', () => {
  it('exposes the four inventory tools', () => {
    expect(feature.tools.map((t) => t.name)).toEqual([
      'list_subscriptions',
      'list_resource_groups',
      'search_resources',
      'get_resource',
    ]);
  });

  describe('list_subscriptions', () => {
    it('returns aliases and states, never the Azure display name', async () => {
      const { call } = setup([
        { subscriptionId: SUB_APP, state: 'Enabled', displayName: 'Contoso Payments Production' },
      ]);
      const result = await call('list_subscriptions');
      expect(result.isError).toBeUndefined();
      expect(parseToolText(result)).toEqual({
        context: 'prod',
        subscriptions: [
          { alias: 'prod-app', state: 'Enabled' },
          { alias: 'prod-network', state: 'NotVisible' },
        ],
      });
      expect(toolText(result)).not.toContain('Contoso');
    });

    it('reports NotLoggedIn without querying Azure', async () => {
      const { azure, call } = setup();
      azure.logout('prod');
      const result = await call('list_subscriptions');
      expect(result.isError).toBe(true);
      expect(toolText(result)).toContain('NotLoggedIn');
      expect(azure.resourceGraphQueries).toHaveLength(0);
    });
  });

  describe('list_resource_groups', () => {
    it('masks tag values except safe keys, and caps free text', async () => {
      const { call } = setup([
        {
          id: `/subscriptions/${SUB_APP}/resourceGroups/rg-app`,
          name: 'rg-app',
          location: 'westeurope',
          subscriptionId: SUB_APP,
          provisioningState: 'Succeeded',
          tags: { ...TAGS, env: 'word '.repeat(200) },
        },
      ]);
      const result = await call('list_resource_groups');
      const body = parseToolText(result) as {
        resourceGroups: { name: string; tags: Record<string, string> }[];
        truncated: boolean;
      };
      expect(body.truncated).toBe(false);
      const [rg] = body.resourceGroups;
      expect(rg).toMatchObject({
        name: 'rg-app',
        subscription: 'prod-app',
        location: 'westeurope',
        provisioningState: 'Succeeded',
      });
      expect(rg?.tags.owner).toBe('[masked]');
      expect(rg?.tags['created-by']).toBe('[masked]');
      expect(rg?.tags.costCenter).toBe('[masked]');
      expect(rg?.tags.env?.length).toBeLessThanOrEqual(MAX_TEXT_LENGTH);
      expect(rg?.tags.env).toMatch(/^word( word)+…$/);
      // Safe tag values are shown, but still scrubbed.
      expect(rg?.tags.app).toMatch(/^checkout from public-ip-/);
    });

    // #53 item 1: the mapper caps BEFORE executeTool scrubs; a cut must never leave a fragment.
    it.each([
      ['GUID', v.SUBSCRIPTION_ID],
      ['email', v.OWNER_EMAIL],
      ['JWT', v.FAKE_ID_TOKEN],
    ])('never cuts a %s that straddles the tag value cap', async (_label, secret) => {
      // Glued to the previous word by a non-space separator too: the whole word goes, never a part.
      for (const glue of [' ', '/', ',', '=', ':']) {
        for (const shift of [-8, -1, 0, 1, 8]) {
          const prefix = 'x'.repeat(MAX_TEXT_LENGTH - Math.floor(secret.length / 2) + shift);
          const { call } = setup([
            {
              id: `/subscriptions/${SUB_APP}/resourceGroups/rg-app`,
              name: 'rg-app',
              location: 'westeurope',
              subscriptionId: SUB_APP,
              tags: { env: `${prefix.slice(0, 10)} ${prefix.slice(10)}${glue}${secret} end` },
            },
          ]);
          const body = parseToolText(await call('list_resource_groups')) as {
            resourceGroups: { tags: Record<string, string> }[];
          };
          const env = body.resourceGroups[0]?.tags.env ?? '';
          expect(env.length).toBeLessThanOrEqual(MAX_TEXT_LENGTH);
          expect(env).not.toContain(secret.slice(0, 6));
          expect(env).not.toContain(secret.slice(-6));
        }
      }
    });

    it('scopes the query to the requested subscription alias', async () => {
      const { azure, call } = setup();
      await call('list_resource_groups', { subscription: 'prod-network' });
      expect(azure.resourceGraphQueries[0]?.subscriptions).toEqual([SUB_NET]);
      expect(azure.resourceGraphQueries[0]?.query).toContain(
        'microsoft.resources/subscriptions/resourcegroups',
      );
    });

    it('rejects a subscription outside the active context', async () => {
      const { azure, call } = setup();
      const result = await call('list_resource_groups', { subscription: 'lab' });
      expect(result.isError).toBe(true);
      expect(toolText(result)).toContain('UnknownSubscription');
      expect(azure.resourceGraphQueries).toHaveLength(0);
    });
  });

  describe('search_resources', () => {
    it('returns allowlisted fields with a name-only ref', async () => {
      const { call } = setup([
        resourceRow('vm-web-01', {
          sku: { name: 'Standard_D2s_v5', tier: 'Standard', secret: v.CLIENT_SECRET },
          kind: 'linux',
          properties: { vmId: v.VM_ID, osProfile: { adminUsername: 'azureuser' } },
          identity: { principalId: v.CALLER_OBJECT_ID },
        }),
      ]);
      const result = await call('search_resources', { name: 'web', limit: 50 });
      const body = parseToolText(result) as { resources: Record<string, unknown>[]; truncated: boolean };
      expect(body.truncated).toBe(false);
      expect(body.resources).toEqual([
        {
          ref: 'rg-app/virtualMachines/vm-web-01',
          name: 'vm-web-01',
          resourceGroup: 'rg-app',
          subscription: 'prod-app',
          type: 'microsoft.compute/virtualmachines',
          location: 'westeurope',
          sku: { name: 'Standard_D2s_v5', tier: 'Standard' },
          kind: 'linux',
          tags: expect.objectContaining({ owner: '[masked]', env: 'prod' }) as unknown,
        },
      ]);
      const text = toolText(result);
      expect(text).not.toContain('azureuser');
      expect(text).not.toContain('identity');
    });

    it('escapes injection attempts in every filter', async () => {
      const { azure, call } = setup();
      const evil = "x' or 1==1 //";
      await call('search_resources', {
        name: evil,
        type: "a' | project tenantId",
        resourceGroup: 'rg" or true',
        location: "w'",
        limit: 10,
      });
      const query = azure.resourceGraphQueries[0]?.query ?? '';
      expect(query).toContain(String.raw`name contains 'x\' or 1==1 //'`);
      expect(query).toContain(String.raw`type endswith '/a\' | project tenantId'`);
      expect(query).toContain(String.raw`resourceGroup =~ 'rg\" or true'`);
      expect(query).toContain(String.raw`location =~ 'w\''`);
      // The only pipes are our own stages.
      expect(query.replace(/'(?:\\.|[^'\\])*'/g, "''").match(/\|/g)).toHaveLength(3);
    });

    it('matches a full type exactly and a short type by its last segment', async () => {
      const { azure, call } = setup();
      await call('search_resources', { type: 'Microsoft.Web/sites', limit: 5 });
      await call('search_resources', { type: 'virtualMachines', limit: 5 });
      expect(azure.resourceGraphQueries[0]?.query).toContain("type =~ 'Microsoft.Web/sites'");
      expect(azure.resourceGraphQueries[1]?.query).toContain("type endswith '/virtualMachines'");
    });

    it('caps results at the limit and reports truncated', async () => {
      const rows = Array.from({ length: 60 }, (_, i) => resourceRow(`vm-${String(i).padStart(2, '0')}`));
      const { call } = setup(rows);
      const result = await call('search_resources', { limit: 50 });
      const body = parseToolText(result) as { resources: unknown[]; truncated: boolean };
      expect(body.resources).toHaveLength(50);
      expect(body.truncated).toBe(true);

      const capped = parseToolText(await call('search_resources', { limit: 10_000 })) as {
        resources: unknown[];
      };
      expect(capped.resources).toHaveLength(60);
    });

    it('rejects control characters even when schema validation is bypassed', async () => {
      const { call } = setup();
      const result = await call('search_resources', { name: 'a\nresources', limit: 5 });
      expect(result.isError).toBe(true);
      expect(toolText(result)).toContain('InvalidInput');
    });
  });

  describe('input validation', () => {
    const search = z.object(SearchResourcesInput);
    const get = z.object(GetResourceInput);

    it('defaults limit to 50 and caps it at 200', () => {
      expect(search.parse({}).limit).toBe(50);
      expect(search.safeParse({ limit: 201 }).success).toBe(false);
      expect(search.safeParse({ limit: 0 }).success).toBe(false);
    });

    it.each([
      ['name', "x' or 1==1 //"],
      ['name', 'a'.repeat(261)],
      ['name', 'rg-app/vm-web-01'],
      ['type', 'Microsoft.Compute/virtualMachines | take 1'],
      ['resourceGroup', 'rg app'],
      ['location', 'west europe'],
      ['subscription', v.VM_ARM_ID],
      ['subscription', 'Prod-App'],
    ])('rejects unsafe %s', (key, value) => {
      expect(search.safeParse({ [key]: value }).success).toBe(false);
    });

    it('accepts real-looking names', () => {
      expect(
        search.safeParse({
          name: 'vm-web_01.(blue)',
          type: 'Microsoft.Sql/servers/databases',
          resourceGroup: 'rg-app',
          location: 'westeurope',
          subscription: 'prod-app',
        }).success,
      ).toBe(true);
      expect(get.safeParse({ resourceGroup: 'rg-app', name: 'vm-web-01' }).success).toBe(true);
      expect(get.safeParse({ name: 'vm-web-01' }).success).toBe(false);
    });
  });

  describe('get_resource', () => {
    const vmRow = resourceRow('vm-web-01', {
      sku: null,
      properties: {
        vmId: v.VM_ID,
        provisioningState: 'Succeeded',
        hardwareProfile: { vmSize: 'Standard_D2s_v5' },
        storageProfile: { osDisk: { osType: 'Linux', managedDisk: { id: v.VM_ARM_ID } } },
        osProfile: { adminUsername: 'azureuser', customData: v.CLIENT_SECRET },
        extended: { instanceView: { powerState: { code: 'PowerState/running' } } },
        networkProfile: { networkInterfaces: [{ id: v.VM_ARM_ID }] },
      },
    });

    it('resolves by name and returns common fields plus the type allowlist', async () => {
      const { azure, call } = setup([vmRow]);
      const result = await call('get_resource', { resourceGroup: 'rg-app', name: 'vm-web-01' });
      expect(result.isError).toBeUndefined();
      expect(parseToolText(result)).toEqual({
        resource: expect.objectContaining({
          ref: 'rg-app/virtualMachines/vm-web-01',
          name: 'vm-web-01',
          subscription: 'prod-app',
          provisioningState: 'Succeeded',
          properties: { vmSize: 'Standard_D2s_v5', osType: 'Linux', powerState: 'PowerState/running' },
        }) as unknown,
      });
      const text = toolText(result);
      expect(text).not.toContain('azureuser');
      expect(text).not.toContain('networkInterfaces');
      // The resolved ID is only used inside the KQL, as a literal.
      expect(azure.resourceGraphQueries[0]?.query).toContain(`where id =~ '${azure.armId(VM)}'`);
    });

    it('returns only the common fields for unknown types', async () => {
      const row = {
        ...resourceRow('vm-web-01'),
        type: 'microsoft.contoso/widgets',
        properties: { provisioningState: 'Failed', connectionString: v.STORAGE_CONNECTION_STRING },
      };
      const { call } = setup([row]);
      const result = await call('get_resource', { resourceGroup: 'rg-app', name: 'vm-web-01' });
      const body = parseToolText(result) as { resource: Record<string, unknown> };
      expect(body.resource.properties).toEqual({});
      expect(body.resource.provisioningState).toBe('Failed');
      expect(toolText(result)).not.toContain('AccountName');
    });

    it.each([
      [
        'microsoft.web/sites',
        { state: 'Running', defaultHostName: 'app-api.azurewebsites.net', httpsOnly: true, siteConfig: {} },
        { state: 'Running', defaultHostName: 'app-api.azurewebsites.net', httpsOnly: true },
      ],
      [
        'microsoft.containerservice/managedclusters',
        { kubernetesVersion: '1.30.2', powerState: { code: 'Running' }, fqdn: v.PUBLIC_IP_PEER },
        { kubernetesVersion: '1.30.2', powerState: 'Running' },
      ],
      [
        'microsoft.storage/storageaccounts',
        { accessTier: 'Hot', primaryEndpoints: { blob: v.SAS_URL } },
        { accessTier: 'Hot' },
      ],
      [
        'microsoft.sql/servers/databases',
        { status: 'Online', currentServiceObjectiveName: 'S0', collation: 'x' },
        { status: 'Online', currentServiceObjectiveName: 'S0' },
      ],
    ])('allowlists %s properties', async (type, properties, expected) => {
      const { call } = setup([{ ...resourceRow('vm-web-01'), type, properties }]);
      const result = await call('get_resource', { resourceGroup: 'rg-app', name: 'vm-web-01' });
      const body = parseToolText(result) as { resource: { properties: unknown } };
      expect(body.resource.properties).toEqual(expected);
    });

    it('builds a ref with the child path for nested resources', async () => {
      const row = {
        ...resourceRow('db1'),
        id: `/subscriptions/${SUB_APP}/resourceGroups/rg-app/providers/Microsoft.Sql/servers/sql-01/databases/db1`,
        type: 'microsoft.sql/servers/databases',
      };
      const { call } = setup([row]);
      const body = parseToolText(await call('search_resources', { limit: 5 })) as {
        resources: { ref: string }[];
      };
      expect(body.resources[0]?.ref).toBe('rg-app/servers/sql-01/databases/db1');
    });

    it('returns ResourceNotFound when the resolver or the row lookup misses', async () => {
      const { azure, call } = setup();
      const missing = await call('get_resource', { resourceGroup: 'rg-app', name: 'nope' });
      expect(toolText(missing)).toContain('ResourceNotFound');
      expect(azure.resourceGraphQueries).toHaveLength(0);

      const noRow = await call('get_resource', { resourceGroup: 'rg-app', name: 'vm-web-01' });
      expect(noRow.isError).toBe(true);
      expect(toolText(noRow)).toContain('ResourceNotFound');
    });
  });
});
