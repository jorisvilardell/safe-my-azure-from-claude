import { describe, expect, it, vi } from 'vitest';
import { createFakeAzureAccess, createFakeTokenCredential } from '../../../../test/helpers/index.js';
import { AppError } from '../../errors/index.js';
import {
  HARD_MAX_ROWS,
  createClientFactory,
  createResourceGraph,
  kqlString,
  type AzureSession,
  type ResourceGraphQueryClient,
} from '../index.js';

type Request = Parameters<ResourceGraphQueryClient['resources']>[0];

function stubClient(pages: readonly { data: unknown; skipToken?: string }[]): {
  client: ResourceGraphQueryClient;
  requests: Request[];
} {
  const requests: Request[] = [];
  let i = 0;
  return {
    requests,
    client: {
      resources(request) {
        requests.push(request);
        const page = pages[Math.min(i++, pages.length - 1)] ?? { data: [] };
        return Promise.resolve(page);
      },
    },
  };
}

const rows = (from: number, count: number): { n: number }[] =>
  Array.from({ length: count }, (_, k) => ({ n: from + k }));

describe('kqlString', () => {
  it('quotes plain values', () => {
    expect(kqlString('vm-web-01')).toBe("'vm-web-01'");
  });

  it('escapes quotes and backslashes so the literal cannot be closed', () => {
    expect(kqlString("x' or 1==1 //")).toBe("'x\\' or 1==1 //'");
    expect(kqlString('a"b\\c')).toBe("'a\\\"b\\\\c'");
    expect(kqlString("\\' | project id")).toBe("'\\\\\\' | project id'");
  });

  it('rejects control characters (a newline could start a new statement)', () => {
    expect(() => kqlString('x\n| take 1')).toThrow(AppError);
  });
});

describe('createResourceGraph', () => {
  const azure = createFakeAzureAccess();
  const session = (): AzureSession => azure.session();

  it('scopes queries to the active context subscriptions by default', async () => {
    const { client, requests } = stubClient([{ data: [{ a: 1 }] }]);
    const rg = createResourceGraph({ session, clients: createClientFactory(), createClient: () => client });

    await expect(rg.query('resources')).resolves.toEqual([{ a: 1 }]);
    expect(requests[0]?.subscriptions).toEqual([
      '00000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-000000000002',
    ]);
    expect(requests[0]?.options?.resultFormat).toBe('objectArray');
  });

  it('refuses subscriptions outside the active context', async () => {
    const { client, requests } = stubClient([{ data: [] }]);
    const rg = createResourceGraph({ session, clients: createClientFactory(), createClient: () => client });

    await expect(
      rg.query('resources', { subscriptions: ['00000000-0000-0000-0000-000000000003'] }),
    ).rejects.toMatchObject({ code: 'UnknownSubscription' });
    expect(requests).toHaveLength(0);
  });

  it('follows skipToken pages', async () => {
    const { client, requests } = stubClient([
      { data: rows(0, 2), skipToken: 't1' },
      { data: rows(2, 2), skipToken: 't2' },
      { data: rows(4, 1) },
    ]);
    const rg = createResourceGraph({ session, clients: createClientFactory(), createClient: () => client });

    const result = await rg.query<{ n: number }>('resources');
    expect(result.map((r) => r.n)).toEqual([0, 1, 2, 3, 4]);
    expect(requests.map((r) => r.options?.skipToken)).toEqual([undefined, 't1', 't2']);
    expect(new Set(requests.map((r) => r.query))).toEqual(new Set(['resources']));
  });

  it('stops at the row cap even when more pages exist', async () => {
    const { client, requests } = stubClient([{ data: rows(0, 3), skipToken: 'more' }]);
    const rg = createResourceGraph({ session, clients: createClientFactory(), createClient: () => client });

    const result = await rg.query('resources', { maxRows: 7 });
    expect(result).toHaveLength(7);
    expect(requests.map((r) => r.options?.top)).toEqual([7, 4, 1]);
  });

  it('clamps maxRows to the hard cap', async () => {
    const { client, requests } = stubClient([{ data: rows(0, 1000), skipToken: 'more' }]);
    const rg = createResourceGraph({ session, clients: createClientFactory(), createClient: () => client });

    const result = await rg.query('resources', { maxRows: 1_000_000 });
    expect(result).toHaveLength(HARD_MAX_ROWS);
    expect(requests).toHaveLength(HARD_MAX_ROWS / 1000);
  });

  it('rejects non-array data', async () => {
    const { client } = stubClient([{ data: { columns: [], rows: [] } }]);
    const rg = createResourceGraph({ session, clients: createClientFactory(), createClient: () => client });
    await expect(rg.query('resources')).rejects.toMatchObject({ code: 'UnexpectedResponse' });
  });

  it('fails with NotLoggedIn before building a client', async () => {
    const loggedOut = createFakeAzureAccess({ loggedIn: [] });
    const createClient = vi.fn();
    const rg = createResourceGraph({
      session: () => loggedOut.session(),
      clients: createClientFactory(),
      createClient,
    });
    await expect(rg.query('resources')).rejects.toMatchObject({ code: 'NotLoggedIn' });
    expect(createClient).not.toHaveBeenCalled();
  });
});

describe('createClientFactory', () => {
  it('caches per context and key, and rebuilds when the credential changes', () => {
    const clients = createClientFactory();
    const credA = createFakeTokenCredential();
    const credB = createFakeTokenCredential();
    const create = vi.fn(() => ({}));

    const a1 = clients.getClient({ contextAlias: 'prod', credential: credA }, 'rg', create);
    const a2 = clients.getClient({ contextAlias: 'prod', credential: credA }, 'rg', create);
    const lab = clients.getClient({ contextAlias: 'lab', credential: credA }, 'rg', create);
    const other = clients.getClient({ contextAlias: 'prod', credential: credA }, 'monitor', create);
    expect(a2).toBe(a1);
    expect(lab).not.toBe(a1);
    expect(other).not.toBe(a1);

    const relogin = clients.getClient({ contextAlias: 'prod', credential: credB }, 'rg', create);
    expect(relogin).not.toBe(a1);
    expect(create).toHaveBeenLastCalledWith(credB);
  });

  it('invalidates one context or all of them', () => {
    const clients = createClientFactory();
    const credential = createFakeTokenCredential();
    const create = (): object => ({});
    const prod = clients.getClient({ contextAlias: 'prod', credential }, 'rg', create);
    const lab = clients.getClient({ contextAlias: 'lab', credential }, 'rg', create);

    clients.invalidate('prod');
    expect(clients.getClient({ contextAlias: 'prod', credential }, 'rg', create)).not.toBe(prod);
    expect(clients.getClient({ contextAlias: 'lab', credential }, 'rg', create)).toBe(lab);
    clients.invalidate();
    expect(clients.getClient({ contextAlias: 'lab', credential }, 'rg', create)).not.toBe(lab);
  });
});
