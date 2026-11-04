import { describe, expect, it } from 'vitest';
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

  it('is part of the default test tool context', () => {
    expect(createTestToolContext().azure.contexts.active()).toBe('prod');
  });
});
