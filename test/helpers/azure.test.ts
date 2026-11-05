import { describe, expect, it } from 'vitest';
import { azureClients } from '../../src/core/azure/index.js';
import { AppError } from '../../src/core/errors/index.js';
import { FAKE_ACCESS_TOKEN, createFakeAzureAccess, createTestToolContext } from './index.js';

describe('createFakeAzureAccess', () => {
  it('starts on prod, logged in everywhere', async () => {
    const azure = createFakeAzureAccess();
    expect(azure.contexts.active()).toBe('prod');
    expect(azure.contexts.list().every((c) => c.loggedIn)).toBe(true);

    const token = await azure.session().credential.getToken('https://management.azure.com/.default');
    expect(token?.token).toBe(FAKE_ACCESS_TOKEN);
  });

  it('honours loggedIn and login/logout', () => {
    const azure = createFakeAzureAccess({ loggedIn: [] });
    expect(() => azure.session()).toThrow(AppError);

    azure.login('prod');
    expect(azure.session().contextAlias).toBe('prod');

    azure.logout('prod');
    expect(() => azure.session()).toThrow(/not logged in/);
  });

  it('resolves a resource within the active context', async () => {
    const azure = createFakeAzureAccess();
    await expect(azure.resolver.resolve({ name: 'VNET-HUB' })).resolves.toBe(
      '/subscriptions/00000000-0000-0000-0000-000000000002/resourceGroups/rg-net/providers/Microsoft.Network/virtualNetworks/vnet-hub',
    );

    azure.contexts.use('lab');
    await expect(azure.resolver.resolve({ name: 'vm-web-01' })).resolves.toContain(
      '00000000-0000-0000-0000-000000000003',
    );
    await expect(azure.resolver.resolve({ name: 'vnet-hub' })).rejects.toMatchObject({
      code: 'ResourceNotFound',
    });
  });

  it('reports ambiguity and unknown subscriptions', async () => {
    const azure = createFakeAzureAccess({
      resources: [
        { subscription: 'prod-app', resourceGroup: 'rg-a', name: 'kv', type: 'Microsoft.KeyVault/vaults' },
        { subscription: 'prod-app', resourceGroup: 'rg-b', name: 'kv', type: 'Microsoft.KeyVault/vaults' },
      ],
    });
    await expect(azure.resolver.resolve({ name: 'kv' })).rejects.toMatchObject({ code: 'AmbiguousResource' });
    await expect(azure.resolver.resolve({ name: 'kv', resourceGroup: 'rg-b' })).resolves.toContain('/rg-b/');
    await expect(azure.resolver.resolve({ name: 'kv', subscription: 'lab' })).rejects.toMatchObject({
      code: 'UnknownSubscription',
    });
  });

  it('serves stubbed Resource Graph rows through the real client, and records queries', async () => {
    const azure = createFakeAzureAccess({ resourceGraphRows: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] });
    await expect(azure.resourceGraph.queryResult('resources', { maxRows: 2 })).resolves.toEqual({
      rows: [{ name: 'a' }, { name: 'b' }],
      truncated: true,
    });

    azure.setResourceGraphRows(({ query }) => (query.includes('publicipaddresses') ? [{ ip: 1 }] : []));
    await expect(azure.resourceGraph.query("resources | where type =~ 'publicipaddresses'")).resolves.toEqual(
      [{ ip: 1 }],
    );
    await expect(azure.resourceGraph.query('resources')).resolves.toEqual([]);

    expect(azure.resourceGraphQueries.map((q) => q.query)).toEqual([
      'resources',
      "resources | where type =~ 'publicipaddresses'",
      'resources',
    ]);
    expect(azure.resourceGraphQueries[0]?.subscriptions).toEqual(azure.session().subscriptionIds());
  });

  it('pages large row sets like Azure', async () => {
    const many = Array.from({ length: 1500 }, (_, n) => ({ n }));
    const azure = createFakeAzureAccess({ resourceGraphRows: many });
    await expect(azure.resourceGraph.queryResult('resources', { maxRows: 2000 })).resolves.toMatchObject({
      truncated: false,
    });
    expect((await azure.resourceGraph.query('resources', { maxRows: 2000 })).length).toBe(1500);
  });

  it('stubs other SDK clients by key, and refuses unstubbed ones', () => {
    const azure = createFakeAzureAccess();
    const session = azure.session();
    const fake = { list: () => [] };
    azure.stubClient(/^alerts:/, fake);

    // The fake never runs the spec: no real SDK client is built in tests.
    const create = azureClients.monitor();
    expect(azure.clients.getClient(session, 'alerts:00000000-0000-0000-0000-000000000001', create)).toBe(
      fake,
    );
    expect(() => azure.clients.getClient(session, 'monitor', create)).toThrow(/No fake Azure SDK client/);
  });

  it('is part of the default test tool context', () => {
    expect(createTestToolContext().azure.contexts.active()).toBe('prod');
  });
});
