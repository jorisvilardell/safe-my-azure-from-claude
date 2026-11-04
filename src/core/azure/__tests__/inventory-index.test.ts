import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as v from '../../../../test/fixtures/azure/index.js';
import {
  FAKE_CONTEXTS,
  createFakeAzureAccess,
  createFakeClientFactory,
  createFakeTokenCredential,
  createStubLogin,
  flushLogin,
  expectNoLeak,
  type FakeAzureAccess,
  type FakeResourceGraphQuery,
} from '../../../../test/helpers/index.js';
import { AppError } from '../../errors/index.js';
import { createLogger } from '../../logging/index.js';
import {
  INVENTORY_QUERY,
  INVENTORY_TTL_MS,
  RESOURCE_GRAPH_CLIENT_KEY,
  createAzureAccess,
  createContextStore,
  createCredentialManager,
  createResourceResolver,
  type CredentialProvider,
  type InventoryIndexOptions,
} from '../index.js';

const SUB_APP = '00000000-0000-0000-0000-000000000001';
const SUB_NET = '00000000-0000-0000-0000-000000000002';
const SUB_LAB = '00000000-0000-0000-0000-000000000003';

function armId(sub: string, rg: string, type: string, name: string): string {
  return `/subscriptions/${sub}/resourceGroups/${rg}/providers/${type}/${name}`;
}

function resource(sub: string, rg: string, type: string, name: string, extra: object = {}): object {
  return {
    id: armId(sub, rg, type, name),
    name,
    type: type.toLowerCase(),
    resourceGroup: rg,
    subscriptionId: sub,
    tenantId: v.TENANT_ID,
    location: 'westeurope',
    tags: { owner: v.OWNER_EMAIL },
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
    provisioningState: 'Succeeded',
  };
}

const PROD_ROWS = [
  group(SUB_APP, 'rg-app'),
  resource(SUB_APP, 'rg-app', 'Microsoft.Compute/virtualMachines', 'vm-web-01', {
    sku: { name: 'Standard_D2s_v5', secret: 'x' },
  }),
  resource(SUB_APP, 'rg-app', 'Microsoft.Web/sites', 'app-api', { kind: 'app' }),
  resource(SUB_NET, 'rg-net', 'Microsoft.Network/publicIPAddresses', 'pip-web', {
    ipAddress: v.PUBLIC_IP_CLIENT,
  }),
  // Same name in two resource groups: ambiguous by name alone.
  resource(SUB_APP, 'rg-app', 'Microsoft.Storage/storageAccounts', 'stshared'),
  resource(SUB_NET, 'rg-net', 'Microsoft.Storage/storageAccounts', 'stshared'),
  { name: 'no-id' },
  null,
];
const LAB_ROWS = [resource(SUB_LAB, 'rg-lab', 'Microsoft.Compute/virtualMachines', 'vm-lab-01')];

/** A live row for the resolver query: whatever the KQL asked, it answers with this one. */
const LIVE_ROW = resource(SUB_APP, 'rg-live', 'Microsoft.Web/sites', 'app-new');

interface Rig {
  readonly azure: FakeAzureAccess;
  readonly clock: { now: number };
  readonly logs: string[];
  readonly queries: () => readonly string[];
  readonly flush: () => Promise<void>;
}

function setup(opts: InventoryIndexOptions = {}): Rig {
  const clock = { now: 1_000_000 };
  const logs: string[] = [];
  const azure = createFakeAzureAccess({
    inventory: { now: () => clock.now, ...opts },
    resourceGraphRows: ({ query, subscriptions }: FakeResourceGraphQuery) => {
      if (query !== INVENTORY_QUERY) return [LIVE_ROW];
      return subscriptions.includes(SUB_LAB) ? LAB_ROWS : PROD_ROWS;
    },
  });
  return {
    azure,
    clock,
    logs,
    queries: () => azure.resourceGraphQueries.map((q) => (q.query === INVENTORY_QUERY ? 'index' : 'live')),
    flush: () => new Promise((resolve) => setImmediate(resolve)),
  };
}

describe('inventory index: build', () => {
  it('builds lazily with ONE Resource Graph query over resources and resource groups', async () => {
    const { azure, queries, flush } = setup();
    expect(azure.inventory.current()).toBeUndefined();
    expect(queries()).toEqual(['index']);
    expect(INVENTORY_QUERY).toMatch(/^resources\n\| union \(resourcecontainers/);
    await flush();

    const snap = azure.inventory.current();
    expect(snap?.contextAlias).toBe('prod');
    expect(snap?.resources.map((r) => r.name)).toEqual([
      'vm-web-01',
      'app-api',
      'pip-web',
      'stshared',
      'stshared',
    ]);
    expect(snap?.resourceGroups.map((r) => r.name)).toEqual(['rg-app']);
    expect(snap?.resourceGroups[0]?.provisioningState).toBe('Succeeded');
    expect(snap?.publicIpName(v.PUBLIC_IP_CLIENT)).toBe('pip-web');
    // Allowlisted copy: unknown fields (tenantId, sku.secret) are not kept.
    expect(snap?.resources[0]).not.toHaveProperty('tenantId');
    expect(snap?.resources[0]?.sku).toEqual({ name: 'Standard_D2s_v5' });
    expect(queries()).toEqual(['index']);
  });

  it('finds entries with the live queries semantics', async () => {
    const { azure } = setup();
    await azure.inventory.refresh();
    const snap = azure.inventory.current();
    if (snap === undefined) throw new Error('no snapshot');
    expect(snap.find({ nameContains: 'WEB' }).map((r) => r.name)).toEqual(['vm-web-01', 'pip-web']);
    expect(snap.find({ type: 'virtualMachines' }).map((r) => r.name)).toEqual(['vm-web-01']);
    expect(snap.find({ type: 'microsoft.web/SITES' }).map((r) => r.name)).toEqual(['app-api']);
    expect(snap.find({ type: 'sites/x' })).toEqual([]);
    expect(snap.find({ name: 'STSHARED', subscriptionIds: [SUB_NET] }).map((r) => r.resourceGroup)).toEqual([
      'rg-net',
    ]);
    expect(snap.find({ resourceGroup: 'RG-APP', location: 'WestEurope' })).toHaveLength(3);
    expect(snap.find({ table: 'resourceGroups', type: 'ignored' }).map((r) => r.name)).toEqual(['rg-app']);
  });

  it('serves a fresh snapshot, refreshes it in the background near the TTL, and stops serving it once stale', async () => {
    const { azure, clock, queries, flush } = setup();
    await azure.inventory.refresh();
    const first = azure.inventory.current();
    expect(first).toBeDefined();

    clock.now += INVENTORY_TTL_MS * 0.5;
    expect(azure.inventory.current()).toBe(first);
    expect(queries()).toEqual(['index']);

    // Near the TTL: still served, and a refresh starts in the background.
    clock.now += INVENTORY_TTL_MS * 0.35;
    expect(azure.inventory.current()).toBe(first);
    expect(queries()).toEqual(['index', 'index']);
    await flush();
    const second = azure.inventory.current();
    expect(second).not.toBe(first);
    expect(second?.builtAt).toBe(clock.now);

    // Stale (not used for a whole TTL): not served, callers go live while it rebuilds.
    clock.now += INVENTORY_TTL_MS;
    expect(azure.inventory.current()).toBeUndefined();
    expect(queries()).toEqual(['index', 'index', 'index']);
    await flush();
    expect(azure.inventory.current()).toBeDefined();
  });

  it('backs off after a failed build and never logs the Azure error', async () => {
    const logs: string[] = [];
    const clock = { now: 1_000_000 };
    const store = createContextStore({
      contexts: FAKE_CONTEXTS,
      isLoggedIn: () => true,
      initialActive: 'prod',
    });
    const clients = createFakeClientFactory();
    let calls = 0;
    clients.stub(RESOURCE_GRAPH_CLIENT_KEY, {
      resources: () => {
        calls++;
        return Promise.reject(
          Object.assign(new Error(`boom ${SUB_APP} ${v.OWNER_EMAIL}`), { statusCode: 429 }),
        );
      },
    });
    const credential = createFakeTokenCredential();
    const azure = createAzureAccess({
      contexts: FAKE_CONTEXTS,
      store,
      credentials: { isLoggedIn: () => true, getCredential: () => credential },
      clients,
      inventory: { now: () => clock.now },
      logger: createLogger('debug', { write: (l) => logs.push(l) }),
    });

    await azure.inventory.refresh();
    expect(azure.inventory.current()).toBeUndefined();
    expect(calls).toBe(1);
    clock.now += 31_000;
    azure.inventory.current();
    expect(calls).toBe(2);
    expect(logs.join('\n')).toContain('inventory index build failed');
    expect(logs.join('\n')).not.toContain('boom');
    expectNoLeak(logs);
  });

  it('is disabled with maxResources 0: always live, never a query', async () => {
    const { azure, queries } = setup({ maxResources: 0 });
    expect(azure.inventory.enabled).toBe(false);
    expect(azure.inventory.current()).toBeUndefined();
    await azure.inventory.refresh();
    await expect(azure.inventory.load('prod')).resolves.toBeUndefined();
    expect(queries()).toEqual([]);
  });
});

describe('inventory index: memory cap', () => {
  it('keeps nothing over the cap, logs a warning and lets callers fall back to live queries', async () => {
    const logs: string[] = [];
    const clock = { now: 1_000_000 };
    const store = createContextStore({
      contexts: FAKE_CONTEXTS,
      isLoggedIn: () => true,
      initialActive: 'prod',
    });
    const clients = createFakeClientFactory();
    const tops: (number | undefined)[] = [];
    clients.stub(RESOURCE_GRAPH_CLIENT_KEY, {
      resources: (req: { query: string; options?: { top?: number } }) => {
        tops.push(req.options?.top);
        return Promise.resolve({ data: req.query === INVENTORY_QUERY ? PROD_ROWS.slice(0, 4) : [LIVE_ROW] });
      },
    });
    const credential = createFakeTokenCredential();
    const azure = createAzureAccess({
      contexts: FAKE_CONTEXTS,
      store,
      credentials: { isLoggedIn: () => true, getCredential: () => credential },
      clients,
      inventory: { now: () => clock.now, maxResources: 3 },
      logger: createLogger('debug', { write: (l) => logs.push(l) }),
    });

    await azure.inventory.refresh();
    // It asked for cap + 1 rows, no more: the cap bounds the download too.
    expect(tops).toEqual([4]);
    expect(azure.inventory.status('prod')).toEqual({ builtAt: clock.now, overCap: true, resourceCount: 4 });
    expect(azure.inventory.current()).toBeUndefined();
    expect(logs.join('\n')).toContain('inventory index over its cap');
    expectNoLeak(logs);

    // The resolver goes live.
    await expect(azure.resolver.resolve({ name: 'app-new' })).resolves.toBe(
      armId(SUB_APP, 'rg-live', 'Microsoft.Web/sites', 'app-new'),
    );
    // And the over-cap state is not rebuilt at every call.
    clock.now += INVENTORY_TTL_MS;
    azure.inventory.current();
    expect(tops.filter((t) => t === 4)).toHaveLength(1);
  });

  it('accepts exactly the cap (raw rows count, so the download is bounded too)', async () => {
    const { azure } = setup({ maxResources: PROD_ROWS.length });
    await azure.inventory.refresh();
    expect(azure.inventory.status('prod')?.overCap).toBe(false);
    expect(azure.inventory.current()).toBeDefined();
  });
});

describe('inventory index: lifecycle', () => {
  it('wired like main.ts: built right after login, dropped on logout', async () => {
    const stub = createStubLogin();
    const logger = createLogger('error', { write: () => undefined });
    const manager = createCredentialManager({ contexts: FAKE_CONTEXTS, logger, factory: stub.factory });
    const store = createContextStore({
      contexts: FAKE_CONTEXTS,
      isLoggedIn: (a) => manager.isLoggedIn(a),
      initialActive: 'prod',
    });
    const clients = createFakeClientFactory();
    let builds = 0;
    clients.stub(RESOURCE_GRAPH_CLIENT_KEY, {
      resources: (req: { query: string }) => {
        if (req.query === INVENTORY_QUERY) builds++;
        return Promise.resolve({ data: PROD_ROWS });
      },
    });
    const azure = createAzureAccess({
      contexts: FAKE_CONTEXTS,
      store,
      credentials: manager,
      clients,
      logger,
    });
    manager.onSessionChange((alias, change) => {
      if (change === 'logout') azure.inventory.drop(alias);
      else void azure.inventory.refresh(alias);
    });

    manager.startLogin('prod');
    stub.approve();
    await flushLogin();
    await flushLogin();
    expect(builds).toBe(1);
    expect(azure.inventory.current()?.resources).toHaveLength(5);

    manager.logout('prod');
    expect(azure.inventory.status('prod')).toBeUndefined();
    expect(azure.inventory.current()).toBeUndefined();
  });

  it('is empty after logout, and an in-flight build is discarded', async () => {
    const { azure, flush } = setup();
    await azure.inventory.refresh();
    expect(azure.inventory.status('prod')).toBeDefined();

    azure.logout('prod');
    expect(azure.inventory.status('prod')).toBeUndefined();
    expect(azure.inventory.current()).toBeUndefined();

    azure.login('prod');
    const building = azure.inventory.refresh();
    azure.logout('prod');
    await building;
    await flush();
    expect(azure.inventory.status('prod')).toBeUndefined();
  });

  it('drops a context that is no longer logged in, even without a logout hook (session expired)', async () => {
    const loggedIn = new Set(['prod', 'lab']);
    const credential = createFakeTokenCredential();
    const credentials: CredentialProvider = {
      isLoggedIn: (a) => loggedIn.has(a),
      getCredential: (a) => {
        if (!loggedIn.has(a)) throw new AppError('NotLoggedIn', 'not logged in');
        return credential;
      },
    };
    const store = createContextStore({
      contexts: FAKE_CONTEXTS,
      isLoggedIn: (a) => loggedIn.has(a),
      initialActive: 'prod',
    });
    const clients = createFakeClientFactory();
    clients.stub(RESOURCE_GRAPH_CLIENT_KEY, { resources: () => Promise.resolve({ data: PROD_ROWS }) });
    const azure = createAzureAccess({ contexts: FAKE_CONTEXTS, store, credentials, clients });

    await azure.inventory.refresh();
    expect(azure.inventory.status('prod')).toBeDefined();
    loggedIn.delete('prod');
    expect(azure.inventory.current()).toBeUndefined();
    expect(azure.inventory.status('prod')).toBeUndefined();
  });

  it('drops the snapshot when the context logs in again with a new credential', async () => {
    let credential = createFakeTokenCredential();
    const credentials: CredentialProvider = { isLoggedIn: () => true, getCredential: () => credential };
    const store = createContextStore({
      contexts: FAKE_CONTEXTS,
      isLoggedIn: () => true,
      initialActive: 'prod',
    });
    const clients = createFakeClientFactory();
    clients.stub(RESOURCE_GRAPH_CLIENT_KEY, { resources: () => Promise.resolve({ data: PROD_ROWS }) });
    const azure = createAzureAccess({ contexts: FAKE_CONTEXTS, store, credentials, clients });

    await azure.inventory.refresh();
    expect(azure.inventory.current()).toBeDefined();
    credential = createFakeTokenCredential();
    expect(azure.inventory.current()).toBeUndefined();
    expect(azure.inventory.status('prod')).toBeUndefined();

    // A build that started with the old credential is not kept either.
    const building = azure.inventory.refresh();
    credential = createFakeTokenCredential();
    await building;
    expect(azure.inventory.status('prod')).toBeUndefined();
  });

  it('keeps one snapshot per context, and never serves one context the other’s', async () => {
    const { azure, clock, flush } = setup();
    await azure.inventory.refresh();
    expect(azure.inventory.current()?.contextAlias).toBe('prod');

    azure.contexts.use('lab');
    expect(azure.inventory.current()).toBeUndefined();
    await flush();
    const lab = azure.inventory.current();
    expect(lab?.contextAlias).toBe('lab');
    expect(lab?.resources.map((r) => r.name)).toEqual(['vm-lab-01']);
    expect(azure.inventory.status('prod')).toBeDefined();

    // A context no longer in use is forgotten once its snapshot goes stale.
    clock.now += INVENTORY_TTL_MS;
    azure.inventory.current();
    expect(azure.inventory.status('prod')).toBeUndefined();
  });

  it('load() builds a context on demand, active or not', async () => {
    const { azure } = setup();
    const lab = await azure.inventory.load('lab');
    expect(lab?.contextAlias).toBe('lab');
    azure.logout('lab');
    await expect(azure.inventory.load('lab')).resolves.toBeUndefined();
  });
});

describe('inventory index: the resolver is served from the snapshot', () => {
  function resolverOver(azure: FakeAzureAccess): ReturnType<typeof createResourceResolver> {
    return createResourceResolver({
      resourceGraph: azure.resourceGraph,
      session: () => azure.session(),
      contexts: azure.contexts,
      inventory: azure.inventory,
    });
  }

  it('resolves from a fresh snapshot without a live query', async () => {
    const { azure, queries } = setup();
    await azure.inventory.refresh();
    const resolver = resolverOver(azure);
    await expect(resolver.resolve({ name: 'VM-WEB-01' })).resolves.toBe(
      armId(SUB_APP, 'rg-app', 'Microsoft.Compute/virtualMachines', 'vm-web-01'),
    );
    await expect(resolver.resolve({ name: 'stshared', subscription: 'prod-network' })).resolves.toBe(
      armId(SUB_NET, 'rg-net', 'Microsoft.Storage/storageAccounts', 'stshared'),
    );
    await expect(resolver.resolve({ name: 'rg-app', type: 'resourceGroups' })).resolves.toBe(
      `/subscriptions/${SUB_APP}/resourceGroups/rg-app`,
    );
    expect(queries()).toEqual(['index']);
  });

  it('reports ambiguity from the snapshot by name and subscription alias only', async () => {
    const { azure, queries } = setup();
    await azure.inventory.refresh();
    const err = await resolverOver(azure)
      .resolve({ name: 'stshared' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('AmbiguousResource');
    expect((err as AppError).message).toContain(
      'rg-app/microsoft.storage/storageaccounts/stshared (subscription prod-app)',
    );
    expectNoLeak((err as AppError).message);
    expect(queries()).toEqual(['index']);
  });

  it('falls back to a live query on a snapshot miss, a stale snapshot, or none at all', async () => {
    const { azure, clock, queries } = setup();
    const resolver = resolverOver(azure);
    const live = armId(SUB_APP, 'rg-live', 'Microsoft.Web/sites', 'app-new');

    // No snapshot yet: the build starts, the answer is live.
    await expect(resolver.resolve({ name: 'app-new' })).resolves.toBe(live);
    expect(queries()).toEqual(['index', 'live']);

    // Fresh, but the resource is newer than the snapshot.
    await expect(resolver.resolve({ name: 'app-newer' })).resolves.toBe(live);
    expect(queries()).toEqual(['index', 'live', 'live']);

    // Stale: live again.
    clock.now += INVENTORY_TTL_MS;
    await expect(resolver.resolve({ name: 'vm-web-01' })).resolves.toBe(live);
    expect(queries().slice(-2)).toEqual(['index', 'live']);
  });

  it('still rejects an unknown subscription alias when served from the snapshot', async () => {
    const { azure } = setup();
    await azure.inventory.refresh();
    await expect(
      resolverOver(azure).resolve({ name: 'vm-web-01', subscription: 'lab' }),
    ).rejects.toMatchObject({
      code: 'UnknownSubscription',
    });
  });
});

describe('inventory index: memory only', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    syncBuiltinESMExports();
  });

  it('writes nothing to disk while building, refreshing, serving and dropping', async () => {
    const WRITE_APIS = [
      'writeFile',
      'writeFileSync',
      'appendFile',
      'appendFileSync',
      'createWriteStream',
      'open',
      'openSync',
      'mkdir',
      'mkdirSync',
      'mkdtemp',
      'mkdtempSync',
      'copyFile',
      'copyFileSync',
      'rename',
      'renameSync',
    ] as const;
    const spies = [
      ...WRITE_APIS.map((name) => vi.spyOn(fs, name)),
      ...(['writeFile', 'appendFile', 'open', 'mkdir', 'mkdtemp', 'copyFile', 'rename'] as const).map(
        (name) => vi.spyOn(fsp, name),
      ),
    ];
    // Propagates the spies to the named ESM exports (`import { writeFile } from 'node:fs'`).
    syncBuiltinESMExports();

    const { azure, clock, flush } = setup();
    azure.inventory.current();
    await flush();
    clock.now += INVENTORY_TTL_MS * 0.9;
    azure.inventory.current();
    await flush();
    await azure.inventory.load('lab');
    await createResourceResolver({
      resourceGraph: azure.resourceGraph,
      session: () => azure.session(),
      contexts: azure.contexts,
      inventory: azure.inventory,
    }).resolve({ name: 'vm-web-01' });
    azure.logout('prod');

    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it('has no file system, database or network import of its own', () => {
    const source = fs.readFileSync(new URL('../inventory-index.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/from 'node:(fs|fs\/promises|sqlite|net|http|child_process)'/);
  });
});
