import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  createFakeAzureAccess,
  createTestToolContext,
  expectNoLeak,
  toolText,
  type FakeAzureAccess,
  type FakeResource,
} from '../../../../test/helpers/index.js';
import { defineTool, executeTool } from '../../mcp/index.js';
import {
  RESOLVER_TTL_MS,
  createResourceResolver,
  type ResourceGraph,
  type ResourceQueryOptions,
  type ResourceRef,
} from '../index.js';

const VM_APP: FakeResource = {
  subscription: 'prod-app',
  resourceGroup: 'rg-app',
  name: 'vm-web-01',
  type: 'Microsoft.Compute/virtualMachines',
};
const VM_NET: FakeResource = { ...VM_APP, subscription: 'prod-network', resourceGroup: 'rg-net' };

interface Setup {
  readonly azure: FakeAzureAccess;
  readonly query: ReturnType<typeof vi.fn<(kql: string, opts?: ResourceQueryOptions) => Promise<unknown[]>>>;
  readonly resolve: (ref: ResourceRef) => Promise<string>;
  readonly clock: { now: number };
}

function setup(resources: readonly FakeResource[]): Setup {
  const azure = createFakeAzureAccess();
  const row = (r: FakeResource): Record<string, string> => ({
    id: azure.armId(r),
    name: r.name,
    type: r.type,
    resourceGroup: r.resourceGroup,
    subscriptionId: azure.session().subscriptionId(r.subscription),
  });
  const query = vi.fn<(kql: string, opts?: ResourceQueryOptions) => Promise<unknown[]>>(() =>
    Promise.resolve(resources.map(row)),
  );
  const resourceGraph: Pick<ResourceGraph, 'query'> = { query: query as ResourceGraph['query'] };
  const clock = { now: 1_000_000 };
  const resolver = createResourceResolver({
    resourceGraph,
    session: () => azure.session(),
    contexts: azure.contexts,
    now: () => clock.now,
  });
  return { azure, query, resolve: (ref) => resolver.resolve(ref), clock };
}

const lastKql = (s: Setup): string => s.query.mock.lastCall?.[0] ?? '';
const lastOpts = (s: Setup): ResourceQueryOptions | undefined => s.query.mock.lastCall?.[1];

/** Runs `resolve` through the real tool pipeline (scrub + sanitizeError), as the AI would see it. */
async function viaTool(s: Setup, ref: ResourceRef): Promise<string> {
  const tool = defineTool({
    name: 'resolve_test',
    title: 'Resolve',
    description: 'test',
    inputSchema: { name: z.string() },
    handler: (_args, ctx) => ctx.azure.resolver.resolve(ref),
  });
  const ctx = createTestToolContext({ azure: { ...s.azure, resolver: { resolve: s.resolve } } });
  const result = await executeTool(tool, { name: ref.name }, ctx);
  expect(result.isError).toBe(true);
  return toolText(result);
}

describe('createResourceResolver', () => {
  it('returns the ARM ID of a unique match', async () => {
    const s = setup([VM_APP]);
    await expect(s.resolve({ name: 'VM-WEB-01' })).resolves.toBe(s.azure.armId(VM_APP));
    expect(lastKql(s)).toContain("name =~ 'VM-WEB-01'");
    expect(lastKql(s)).toMatch(/^resources\n/);
    expect(lastOpts(s)?.subscriptions).toBeUndefined();
  });

  it('throws ResourceNotFound with no leak', async () => {
    const s = setup([]);
    await expect(s.resolve({ name: 'nope' })).rejects.toMatchObject({ code: 'ResourceNotFound' });
    const text = await viaTool(s, { name: 'nope' });
    expect(text).toContain('ResourceNotFound');
    expectNoLeak(text);
  });

  it('throws AmbiguousResource listing names and subscription aliases only', async () => {
    const s = setup([VM_APP, VM_NET]);
    const err: unknown = await s.resolve({ name: 'vm-web-01' }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'AmbiguousResource' });
    const message = (err as Error).message;
    expect(message).toContain('rg-app/Microsoft.Compute/virtualMachines/vm-web-01 (subscription prod-app)');
    expect(message).toContain(
      'rg-net/Microsoft.Compute/virtualMachines/vm-web-01 (subscription prod-network)',
    );
    expectNoLeak(message);

    const text = await viaTool(s, { name: 'vm-web-01' });
    expect(text).toContain('AmbiguousResource');
    expectNoLeak(text);
  });

  it('caps ambiguity candidates at 10', async () => {
    const many = Array.from({ length: 11 }, (_, i): FakeResource => ({
      ...VM_APP,
      resourceGroup: `rg-${i}`,
    }));
    const s = setup(many);
    const err: unknown = await s.resolve({ name: 'vm-web-01' }).catch((e: unknown) => e);
    const message = (err as Error).message;
    expect(message).toContain('more than 10');
    expect(message).not.toContain('rg-10/');
    expect(message).not.toContain('(subscription');
    expect(lastOpts(s)?.maxRows).toBe(11);
    expectNoLeak(message);
  });

  it('filters by resource group and full type', async () => {
    const s = setup([VM_APP]);
    await s.resolve({
      name: 'vm-web-01',
      resourceGroup: 'rg-app',
      type: 'Microsoft.Compute/virtualMachines',
    });
    expect(lastKql(s)).toContain("resourceGroup =~ 'rg-app'");
    expect(lastKql(s)).toContain("type =~ 'Microsoft.Compute/virtualMachines'");
  });

  it('accepts a short type name', async () => {
    const s = setup([VM_APP]);
    await s.resolve({ name: 'vm-web-01', type: 'virtualMachines' });
    expect(lastKql(s)).toContain("type endswith '/virtualMachines'");
  });

  it('resolves resource groups through resourcecontainers', async () => {
    const s = setup([VM_APP]);
    await s.resolve({ name: 'rg-app', type: 'resourceGroups' });
    expect(lastKql(s)).toMatch(/^resourcecontainers\n/);
    expect(lastKql(s)).toContain("type =~ 'microsoft.resources/subscriptions/resourcegroups'");
  });

  it('scopes to the subscription alias', async () => {
    const s = setup([VM_NET]);
    await s.resolve({ name: 'vm-web-01', subscription: 'prod-network' });
    expect(lastOpts(s)?.subscriptions).toEqual(['00000000-0000-0000-0000-000000000002']);
  });

  it('rejects an unknown subscription alias without querying', async () => {
    const s = setup([VM_APP]);
    await expect(s.resolve({ name: 'vm-web-01', subscription: 'lab' })).rejects.toMatchObject({
      code: 'UnknownSubscription',
    });
    expect(s.query).not.toHaveBeenCalled();
  });

  it('escapes injection attempts in every filter', async () => {
    const s = setup([]);
    const evil = "x' or 1==1 //";
    await s.resolve({ name: evil, resourceGroup: evil, type: evil }).catch(() => undefined);
    const kql = lastKql(s);
    expect(kql).toContain("name =~ 'x\\' or 1==1 //'");
    expect(kql).toContain("resourceGroup =~ 'x\\' or 1==1 //'");
    expect(kql).toContain("type =~ 'x\\' or 1==1 //'");
    await s.resolve({ name: 'vm', type: "vm' or 1==1" }).catch(() => undefined);
    expect(lastKql(s)).toContain("type endswith '/vm\\' or 1==1'");
    // Every quote in the query is either a delimiter or escaped.
    expect(kql.replace(/\\'/g, '').match(/'/g)?.length ?? 0).toBe(2 * 3);
  });

  it('caches resolutions for 5 minutes, per context', async () => {
    const s = setup([VM_APP]);
    await s.resolve({ name: 'vm-web-01' });
    await s.resolve({ name: 'VM-web-01' });
    expect(s.query).toHaveBeenCalledTimes(1);

    s.clock.now += RESOLVER_TTL_MS - 1;
    await s.resolve({ name: 'vm-web-01' });
    expect(s.query).toHaveBeenCalledTimes(1);

    s.clock.now += 1;
    await s.resolve({ name: 'vm-web-01' });
    expect(s.query).toHaveBeenCalledTimes(2);

    s.azure.contexts.use('lab');
    await s.resolve({ name: 'vm-web-01' }).catch(() => undefined);
    expect(s.query).toHaveBeenCalledTimes(3);
  });

  it('does not cache failures', async () => {
    const s = setup([]);
    await s.resolve({ name: 'vm-web-01' }).catch(() => undefined);
    await s.resolve({ name: 'vm-web-01' }).catch(() => undefined);
    expect(s.query).toHaveBeenCalledTimes(2);
  });
});
