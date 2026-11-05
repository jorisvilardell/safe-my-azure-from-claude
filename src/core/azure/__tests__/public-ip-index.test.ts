import { describe, expect, it } from 'vitest';
import { createFakeAzureAccess, expectNoLeak } from '../../../../test/helpers/index.js';
import { createAnonymizer } from '../../anonymizer/index.js';
import { createPublicIpIndex, INVENTORY_QUERY, INVENTORY_TTL_MS } from '../index.js';

const SUB_APP = '00000000-0000-0000-0000-000000000001';
const SUB_LAB = '00000000-0000-0000-0000-000000000003';

const pip = (sub: string, name: string, ipAddress: string): Record<string, unknown> => ({
  id: `/subscriptions/${sub}/resourceGroups/rg-net/providers/Microsoft.Network/publicIPAddresses/${name}`,
  name,
  type: 'microsoft.network/publicipaddresses',
  resourceGroup: 'rg-net',
  subscriptionId: sub,
  location: 'westeurope',
  ipAddress,
});

function setup(): { azure: ReturnType<typeof createFakeAzureAccess>; clock: { now: number } } {
  const clock = { now: 1_000_000 };
  const azure = createFakeAzureAccess({
    inventory: { now: () => clock.now },
    resourceGraphRows: ({ query, subscriptions }) => {
      if (query !== INVENTORY_QUERY) return [];
      return subscriptions.includes(SUB_APP)
        ? [pip(SUB_APP, 'pip-web', '203.0.113.10'), { name: 'pip-bad', ipAddress: 42 }, null]
        : [pip(SUB_LAB, 'pip-lab', '203.0.113.20')];
    },
  });
  return { azure, clock };
}

describe('createPublicIpIndex (a view over the inventory snapshot)', () => {
  it('maps public IPs to resource names, with no query of its own', async () => {
    const { azure } = setup();
    const index = createPublicIpIndex(azure.inventory);
    expect(index.lookup('203.0.113.10')).toBeUndefined();
    await index.refresh();
    expect(index.lookup('203.0.113.10')).toBe('pip-web');
    expect(index.lookup('198.51.100.1')).toBeUndefined();
    expect(azure.resourceGraphQueries.map((q) => q.query)).toEqual([INVENTORY_QUERY]);
  });

  it('refreshes the snapshot in the background as it ages', async () => {
    const { azure, clock } = setup();
    const index = createPublicIpIndex(azure.inventory);
    await index.refresh();
    index.lookup('203.0.113.10');
    expect(azure.resourceGraphQueries).toHaveLength(1);

    clock.now += INVENTORY_TTL_MS * 0.9;
    expect(index.lookup('203.0.113.10')).toBe('pip-web');
    expect(azure.resourceGraphQueries).toHaveLength(2);
  });

  it('never serves the snapshot of another context', async () => {
    const { azure } = setup();
    const index = createPublicIpIndex(azure.inventory);
    await index.refresh();
    azure.contexts.use('lab');
    expect(index.lookup('203.0.113.10')).toBeUndefined();
  });

  it('never throws, even when Azure fails or nobody is logged in', async () => {
    const { azure } = setup();
    azure.setResourceGraphRows(() => {
      throw new Error('boom /subscriptions/00000000-0000-0000-0000-000000000001');
    });
    const index = createPublicIpIndex(azure.inventory);
    expect(index.lookup('203.0.113.10')).toBeUndefined();
    await expect(index.refresh()).resolves.toBeUndefined();
    azure.logout('prod');
    expect(index.lookup('203.0.113.10')).toBeUndefined();
  });
});

describe('public IP index wired into the anonymizer (as in main.ts)', () => {
  it('shows our own public IPs by resource name, per active context, and masks the rest', async () => {
    const { azure } = setup();
    const index = createPublicIpIndex(azure.inventory);
    const anonymizer = createAnonymizer({ publicIpIndex: index });

    // First sight starts a background build: until it lands, the IP is masked.
    expect(anonymizer.scrubString('from 203.0.113.10')).toBe('from public-ip-external-001');
    await index.refresh();
    const out = anonymizer.scrubString('from 203.0.113.10 and 198.51.100.7');
    expect(out).toBe('from public-ip-pip-web and public-ip-external-002');
    expectNoLeak(out);

    azure.contexts.use('lab');
    expect(anonymizer.scrubString('from 203.0.113.10')).toBe('from public-ip-external-001');
    // #53: both placeholders of the IP resolve to it (metrics filters).
    expect(anonymizer.pseudonymizer.resolve('public-ip-pip-web')).toBe('203.0.113.10');
    expect(anonymizer.pseudonymizer.resolve('public-ip-external-001')).toBe('203.0.113.10');
  });

  it('never lets a resource name take over a counter placeholder', async () => {
    const { azure } = setup();
    const index = createPublicIpIndex(azure.inventory);
    await index.refresh();
    const anonymizer = createAnonymizer({ publicIpIndex: index });
    expect(anonymizer.scrubString('from 198.51.100.7')).toBe('from public-ip-external-001');
    // A public IP resource literally named `external-001` must not hijack that placeholder.
    const p = anonymizer.pseudonymizer;
    expect(p.bind('203.0.113.99', 'public-ip-external-001')).toBe(false);
    expect(p.resolve('public-ip-external-001')).toBe('198.51.100.7');
  });
});
