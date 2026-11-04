import { describe, expect, it, vi, type Mock } from 'vitest';
import { createFakeAzureAccess } from '../../../../test/helpers/index.js';
import { createAnonymizer } from '../../anonymizer/index.js';
import { PUBLIC_IP_TTL_MS, createPublicIpIndex, type ResourceGraph } from '../index.js';

function setup(rows: unknown[]): {
  query: Mock<(kql: string) => Promise<unknown[]>>;
  index: ReturnType<typeof createPublicIpIndex>;
  clock: { now: number; context: string };
} {
  const query = vi.fn<(kql: string) => Promise<unknown[]>>(() => Promise.resolve(rows));
  const clock = { now: 1_000_000, context: 'prod' };
  const index = createPublicIpIndex(
    { query: query as ResourceGraph['query'] },
    {
      now: () => clock.now,
      contextAlias: () => clock.context,
    },
  );
  return { query, index, clock };
}

describe('createPublicIpIndex', () => {
  it('maps public IPs to resource names after a refresh', async () => {
    const { index, query } = setup([
      { name: 'pip-web', ipAddress: '203.0.113.10' },
      { name: 'pip-bad', ipAddress: 42 },
      null,
    ]);
    expect(index.lookup('203.0.113.10')).toBeUndefined();
    await index.refresh();
    expect(index.lookup('203.0.113.10')).toBe('pip-web');
    expect(index.lookup('198.51.100.1')).toBeUndefined();
    expect(String(query.mock.calls[0]?.[0])).toContain("type =~ 'microsoft.network/publicipaddresses'");
  });

  it('refreshes in the background once the TTL expires', async () => {
    const { index, query, clock } = setup([{ name: 'pip-web', ipAddress: '203.0.113.10' }]);
    await index.refresh();
    index.lookup('203.0.113.10');
    expect(query).toHaveBeenCalledTimes(1);

    clock.now += PUBLIC_IP_TTL_MS;
    expect(index.lookup('203.0.113.10')).toBe('pip-web');
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('never serves an index built for another context', async () => {
    const { index, clock } = setup([{ name: 'pip-web', ipAddress: '203.0.113.10' }]);
    await index.refresh();
    clock.context = 'lab';
    expect(index.lookup('203.0.113.10')).toBeUndefined();
  });

  it('swallows background failures and backs off', async () => {
    const { index, query } = setup([]);
    query.mockImplementation(() => Promise.reject(new Error('boom')));
    expect(index.lookup('203.0.113.10')).toBeUndefined();
    await Promise.resolve();
    expect(index.lookup('203.0.113.10')).toBeUndefined();
    expect(query).toHaveBeenCalledTimes(1);
    await expect(index.refresh()).rejects.toThrow('boom');
  });
});

describe('public IP index wired into the anonymizer (as in main.ts)', () => {
  it('shows our own public IPs by resource name, per active context, and masks the rest', async () => {
    const azure = createFakeAzureAccess({
      resourceGraphRows: ({ subscriptions }) =>
        subscriptions.includes(azure.session().subscriptionId('prod-app'))
          ? [{ name: 'pip-web', ipAddress: '203.0.113.10' }]
          : [],
    });
    const index = createPublicIpIndex(azure.resourceGraph, {
      contextAlias: () => azure.contexts.list().find((c) => c.active)?.alias,
    });
    const anonymizer = createAnonymizer({ publicIpIndex: index });

    // First sight starts a background refresh: until it lands, the IP is masked.
    expect(anonymizer.scrubString('from 203.0.113.10')).toBe('from public-ip-external-001');
    await index.refresh();
    expect(anonymizer.scrubString('from 203.0.113.10 and 198.51.100.7')).toBe(
      'from public-ip-pip-web and public-ip-external-002',
    );
    expect(azure.resourceGraphQueries[0]?.query).toMatch(/publicipaddresses/);

    azure.contexts.use('lab');
    expect(anonymizer.scrubString('from 203.0.113.10')).toBe('from public-ip-external-001');
  });
});
