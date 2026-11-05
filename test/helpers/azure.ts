import type { AccessToken, TokenCredential } from '@azure/core-auth';
import {
  createAzureAccess,
  createContextStore,
  RESOURCE_GRAPH_CLIENT_KEY,
  type AzureAccess,
  type ClientFactory,
  type CredentialProvider,
  type InventoryIndexOptions,
  type ResourceGraphQueryClient,
  type ResourceRef,
  type ResourceResolver,
} from '../../src/core/azure/index.js';
import type { AzureContext } from '../../src/core/config/index.js';
import { AppError } from '../../src/core/errors/index.js';

/** JWT-shaped but obviously fake (header `{"alg":"none"}`). Tests assert it never leaks. */
export const FAKE_ACCESS_TOKEN = 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJmYWtlLXVzZXIifQ.ZmFrZS1zaWduYXR1cmU';

/** Mirrors config/contexts.example.yaml. All IDs are fake (AGENTS.md R7). */
export const FAKE_CONTEXTS: Readonly<Record<string, AzureContext>> = {
  prod: {
    tenantId: '00000000-0000-0000-0000-0000000000aa',
    subscriptions: {
      'prod-app': '00000000-0000-0000-0000-000000000001',
      'prod-network': '00000000-0000-0000-0000-000000000002',
    },
  },
  lab: {
    tenantId: '00000000-0000-0000-0000-0000000000bb',
    subscriptions: { lab: '00000000-0000-0000-0000-000000000003' },
  },
};

export interface FakeResource {
  /** Subscription ALIAS, as declared in the fake contexts. */
  readonly subscription: string;
  readonly resourceGroup: string;
  readonly name: string;
  readonly type: string;
}

export const FAKE_RESOURCES: readonly FakeResource[] = [
  {
    subscription: 'prod-app',
    resourceGroup: 'rg-app',
    name: 'vm-web-01',
    type: 'Microsoft.Compute/virtualMachines',
  },
  { subscription: 'prod-app', resourceGroup: 'rg-app', name: 'app-api', type: 'Microsoft.Web/sites' },
  {
    subscription: 'prod-network',
    resourceGroup: 'rg-net',
    name: 'vnet-hub',
    type: 'Microsoft.Network/virtualNetworks',
  },
  {
    subscription: 'lab',
    resourceGroup: 'rg-lab',
    name: 'vm-web-01',
    type: 'Microsoft.Compute/virtualMachines',
  },
];

/** One call that reached the fake Resource Graph. */
export interface FakeResourceGraphQuery {
  readonly query: string;
  /** Real (fake) subscription IDs the query was scoped to. */
  readonly subscriptions: readonly string[];
}

/** Rows the fake Resource Graph returns: a fixed list, or computed per query. */
export type FakeResourceGraphRows = readonly unknown[] | ((q: FakeResourceGraphQuery) => readonly unknown[]);

export interface FakeAzureAccessOptions {
  readonly contexts?: Readonly<Record<string, AzureContext>>;
  /** Contexts that start logged in. Defaults to all of them. */
  readonly loggedIn?: readonly string[];
  /** Initially active context. Defaults to `prod` when declared, else none. */
  readonly active?: string;
  /** Resources the fake `resolver` knows. */
  readonly resources?: readonly FakeResource[];
  /** What `resourceGraph.query()` returns. Defaults to no rows. See `setResourceGraphRows`. */
  readonly resourceGraphRows?: FakeResourceGraphRows;
  /**
   * Turns the REAL in-memory inventory index on, over the fake Resource Graph (pass a clock, a TTL or
   * a cap). Off by default, so feature tests see exactly the live queries they assert on.
   */
  readonly inventory?: InventoryIndexOptions;
}

export interface FakeAzureAccess extends AzureAccess {
  login(contextAlias: string): void;
  logout(contextAlias: string): void;
  /** ARM IDs of the fake resources, as the resolver builds them. */
  armId(resource: FakeResource): string;
  /**
   * Sets what the shared `resourceGraph` returns. It is the REAL Resource Graph client (scoping,
   * row caps, paging and `truncated` all run) over a fake transport that serves these rows,
   * `top` rows per page. Raw rows go through unchanged, so put realistic Azure fields in them.
   *
   * ```ts
   * azure.setResourceGraphRows([{ id: ARM_ID, name: 'vm-web-01', type: 'microsoft.compute/virtualmachines' }]);
   * azure.setResourceGraphRows(({ query }) => (query.includes('publicipaddresses') ? ipRows : []));
   * ```
   */
  setResourceGraphRows(rows: FakeResourceGraphRows): void;
  /** Every query that reached the fake Resource Graph, oldest first. */
  readonly resourceGraphQueries: readonly FakeResourceGraphQuery[];
  /** Stubs an Azure SDK client in `clients`. See `FakeClientFactory.stub`. */
  stubClient(key: string | RegExp, client: unknown): void;
}

/** `ClientFactory` that hands out stubs and never builds a real SDK client (no network in tests). */
export interface FakeClientFactory extends ClientFactory {
  /**
   * `getClient(session, key, spec)` returns `client` for a matching key and never builds a real client.
   * Use a RegExp for per-subscription keys (`/^alerts:/`). Later stubs win. An unstubbed key throws.
   */
  stub(key: string | RegExp, client: unknown): void;
}

export function createFakeClientFactory(): FakeClientFactory {
  const stubs: { readonly key: string | RegExp; readonly client: unknown }[] = [];
  return {
    getClient(_session, key) {
      const hit = stubs.findLast((s) => (typeof s.key === 'string' ? s.key === key : s.key.test(key)));
      if (hit === undefined) {
        throw new Error(`No fake Azure SDK client for "${key}". Stub it with azure.stubClient(key, client).`);
      }
      // Test-only: the test that stubs a key is responsible for giving it the client's shape.
      return hit.client as never;
    },
    invalidate: () => undefined,
    stub(key, client) {
      stubs.push({ key, client });
    },
  };
}

/** Real `ResourceGraphQueryClient` contract over in-memory rows, paged with `top` / `skipToken`. */
function createFakeResourceGraphClient(
  getRows: () => FakeResourceGraphRows,
  log: FakeResourceGraphQuery[],
): ResourceGraphQueryClient {
  return {
    resources(request) {
      const q: FakeResourceGraphQuery = { query: request.query, subscriptions: request.subscriptions ?? [] };
      const source = getRows();
      const all = typeof source === 'function' ? source(q) : source;
      const offset = Number(request.options?.skipToken ?? '0');
      if (offset === 0) log.push(q);
      const end = offset + (request.options?.top ?? all.length);
      return Promise.resolve({
        data: all.slice(offset, end),
        ...(end < all.length ? { skipToken: String(end) } : {}),
      });
    },
  };
}

export function createFakeTokenCredential(token = FAKE_ACCESS_TOKEN): TokenCredential {
  return {
    getToken: (): Promise<AccessToken> =>
      Promise.resolve({ token, expiresOnTimestamp: Date.now() + 3_600_000, tokenType: 'Bearer' }),
  };
}

/**
 * In-memory `AzureAccess`. Uses the real context store, session logic and Resource Graph client,
 * faking only credentials and Azure itself. In a feature test:
 *
 * - Resource Graph: `createFakeAzureAccess({ resourceGraphRows })` or `azure.setResourceGraphRows(...)`,
 *   then assert on `azure.resourceGraphQueries`.
 * - Other SDK clients: `azure.stubClient(key, fakeClient)` with the key the service passes to
 *   `ctx.azure.clients.getClient(session, key, azureClients.x())`. An unstubbed key throws.
 * - Names → IDs: `resolver` is in-memory, over `resources` (default `FAKE_RESOURCES`); `armId(r)`
 *   gives the ID it returns.
 * - Inventory index: off (`current()` is always `undefined`) unless `inventory: { now, ttlMs, … }`
 *   is passed; then the real index runs over the fake Resource Graph (`INVENTORY_QUERY`).
 */
export function createFakeAzureAccess(opts: FakeAzureAccessOptions = {}): FakeAzureAccess {
  const contexts = opts.contexts ?? FAKE_CONTEXTS;
  const resources = opts.resources ?? FAKE_RESOURCES;
  const loggedIn = new Set(opts.loggedIn ?? Object.keys(contexts));
  const credential = createFakeTokenCredential();

  const credentials: CredentialProvider = {
    isLoggedIn: (alias) => loggedIn.has(alias),
    getCredential(alias) {
      if (!loggedIn.has(alias)) throw new AppError('NotLoggedIn', `Context "${alias}" is not logged in.`);
      return credential;
    },
  };

  const initialActive = opts.active ?? (Object.hasOwn(contexts, 'prod') ? 'prod' : undefined);
  const store = createContextStore({
    contexts,
    isLoggedIn: (alias) => credentials.isLoggedIn(alias),
    ...(initialActive === undefined ? {} : { initialActive }),
  });

  const subscriptionIdOf = (contextAlias: string, subAlias: string): string | undefined => {
    const subs = contexts[contextAlias]?.subscriptions ?? {};
    return Object.hasOwn(subs, subAlias) ? subs[subAlias] : undefined;
  };

  const armId = (r: FakeResource): string => {
    const owner = Object.keys(contexts).find((c) => subscriptionIdOf(c, r.subscription) !== undefined);
    const subId = owner === undefined ? undefined : subscriptionIdOf(owner, r.subscription);
    if (subId === undefined)
      throw new Error(`fake resource uses undeclared subscription "${r.subscription}"`);
    return `/subscriptions/${subId}/resourceGroups/${r.resourceGroup}/providers/${r.type}/${r.name}`;
  };

  const eq = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

  const resolver: ResourceResolver = {
    resolve(ref: ResourceRef): Promise<string> {
      try {
        const session = access.session();
        const subAliases = Object.keys(contexts[session.contextAlias]?.subscriptions ?? {});
        if (ref.subscription !== undefined) session.subscriptionId(ref.subscription);
        const matches = resources.filter(
          (r) =>
            subAliases.includes(r.subscription) &&
            (ref.subscription === undefined || r.subscription === ref.subscription) &&
            (ref.resourceGroup === undefined || eq(r.resourceGroup, ref.resourceGroup)) &&
            (ref.type === undefined || eq(r.type, ref.type)) &&
            eq(r.name, ref.name),
        );
        const [first, ...rest] = matches;
        if (first === undefined) throw new AppError('ResourceNotFound', `Resource "${ref.name}" not found.`);
        if (rest.length > 0) {
          throw new AppError(
            'AmbiguousResource',
            `Resource "${ref.name}" matches ${matches.length} resources. Add a resourceGroup, subscription or type.`,
          );
        }
        return Promise.resolve(armId(first));
      } catch (err) {
        return Promise.reject(err instanceof Error ? err : new Error(String(err)));
      }
    },
  };

  let resourceGraphRows: FakeResourceGraphRows = opts.resourceGraphRows ?? [];
  const resourceGraphQueries: FakeResourceGraphQuery[] = [];
  const clients = createFakeClientFactory();
  clients.stub(
    RESOURCE_GRAPH_CLIENT_KEY,
    createFakeResourceGraphClient(() => resourceGraphRows, resourceGraphQueries),
  );

  const access = createAzureAccess({
    contexts,
    store,
    credentials,
    clients,
    resolver,
    inventory: opts.inventory ?? false,
  });

  return {
    ...access,
    login: (alias) => loggedIn.add(alias),
    // Like main.ts, where the credential manager's logout drops the context's inventory.
    logout: (alias) => {
      loggedIn.delete(alias);
      access.inventory.drop(alias);
    },
    armId,
    setResourceGraphRows(rows) {
      resourceGraphRows = rows;
    },
    resourceGraphQueries,
    stubClient: (key, client) => {
      clients.stub(key, client);
    },
  };
}
