import type { AccessToken, TokenCredential } from '@azure/core-auth';
import {
  createAzureAccess,
  createContextStore,
  type AzureAccess,
  type CredentialProvider,
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

export interface FakeAzureAccessOptions {
  readonly contexts?: Readonly<Record<string, AzureContext>>;
  /** Contexts that start logged in. Defaults to all of them. */
  readonly loggedIn?: readonly string[];
  /** Initially active context. Defaults to `prod` when declared, else none. */
  readonly active?: string;
  readonly resources?: readonly FakeResource[];
}

export interface FakeAzureAccess extends AzureAccess {
  login(contextAlias: string): void;
  logout(contextAlias: string): void;
  /** ARM IDs of the fake resources, as the resolver builds them. */
  armId(resource: FakeResource): string;
}

export function createFakeTokenCredential(token = FAKE_ACCESS_TOKEN): TokenCredential {
  return {
    getToken: (): Promise<AccessToken> =>
      Promise.resolve({ token, expiresOnTimestamp: Date.now() + 3_600_000, tokenType: 'Bearer' }),
  };
}

/** In-memory `AzureAccess`. Uses the real context store + session logic, faking only credentials and Azure. */
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

  const access = createAzureAccess({ contexts, store, credentials, resolver });

  return {
    ...access,
    login: (alias) => loggedIn.add(alias),
    logout: (alias) => loggedIn.delete(alias),
    armId,
  };
}
