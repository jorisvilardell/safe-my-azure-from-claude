import {
  createHttpHeaders,
  type HttpClient,
  type Pipeline,
  type PipelineRequest,
  type PipelineResponse,
} from '@azure/core-rest-pipeline';
import { describe, expect, it } from 'vitest';
import { createFakeTokenCredential, expectNoLeak } from '../../../../test/helpers/index.js';
import {
  READ_ONLY_POLICY_NAME,
  READ_ONLY_WIRE_POLICY_NAME,
  assertReadOnlyAzureRequest,
  azureClients,
  classifyAzureRequest,
  createClientFactory,
} from '../index.js';

const SUB = '00000000-0000-0000-0000-000000000001';
const WS = '00000000-0000-0000-0000-000000000002';
const ARM = 'https://management.azure.com';
const LOGS = 'https://api.loganalytics.io';
const VM = `/subscriptions/${SUB}/resourceGroups/rg-app/providers/Microsoft.Compute/virtualMachines/vm-web-01`;
const APPI = `/subscriptions/${SUB}/resourceGroups/rg-app/providers/microsoft.insights/components/appi-api`;
const RG_QUERY = `${ARM}/providers/Microsoft.ResourceGraph/resources?api-version=2024-04-01`;

const allowed = (method: string, url: string): boolean => classifyAzureRequest(method, url).allowed;

function blockedError(method: string, url: string): Error {
  try {
    assertReadOnlyAzureRequest(method, url);
  } catch (err) {
    if (err instanceof Error) return err;
  }
  throw new Error(`${method} ${url} was not blocked`);
}

describe('read-only policy: classification', () => {
  it('allows GET and HEAD to the Azure hosts', () => {
    expect(allowed('GET', `${ARM}/${VM}/providers/Microsoft.Insights/metrics?api-version=2024-02-01`)).toBe(
      true,
    );
    expect(
      allowed('GET', `${ARM}/subscriptions/${SUB}/providers/Microsoft.Insights/eventtypes/management/values`),
    ).toBe(true);
    expect(allowed('HEAD', `${ARM}${VM}`)).toBe(true);
  });

  it('normalises the method case', () => {
    expect(allowed('get', `${ARM}${VM}`)).toBe(true);
    expect(allowed('post', RG_QUERY)).toBe(true);
    expect(allowed('put', `${ARM}${VM}?api-version=2024-07-01`)).toBe(false);
    expect(allowed('Delete', `${ARM}${VM}`)).toBe(false);
  });

  it('allows each allowlisted read-only POST', () => {
    expect(classifyAzureRequest('POST', RG_QUERY)).toMatchObject({
      allowed: true,
      kind: 'resource-graph-query',
    });
    expect(classifyAzureRequest('POST', `${ARM}/PROVIDERS/microsoft.resourcegraph/RESOURCES`)).toMatchObject({
      allowed: true,
    });
    expect(classifyAzureRequest('POST', `${LOGS}/v1/workspaces/${WS}/query`)).toMatchObject({
      allowed: true,
      kind: 'log-analytics-query',
    });
    // What LogsQueryClient.queryResource really sends (double slash), and the single-slash form.
    expect(classifyAzureRequest('POST', `${LOGS}/v1/${APPI}/query`)).toMatchObject({
      allowed: true,
      kind: 'app-insights-query',
    });
    expect(allowed('POST', `${LOGS}/v1${APPI}/query`)).toBe(true);
  });

  it('blocks PUT, PATCH and DELETE', () => {
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      expect(classifyAzureRequest(method, `${ARM}${VM}?api-version=2024-07-01`)).toMatchObject({
        allowed: false,
        kind: 'write',
      });
    }
    expect(allowed('OPTIONS', `${ARM}${VM}`)).toBe(false);
    expect(allowed('MERGE', `${ARM}${VM}`)).toBe(false);
  });

  it('blocks action POSTs and the read-like POSTs the code does not use', () => {
    expect(allowed('POST', `${ARM}${VM}/start?api-version=2024-07-01`)).toBe(false);
    expect(
      allowed(
        'POST',
        `${ARM}/subscriptions/x/resourceGroups/y/providers/Microsoft.Compute/virtualMachines/vm/start`,
      ),
    ).toBe(false);
    expect(
      allowed('POST', `${ARM}/subscriptions/${SUB}/providers/Microsoft.Storage/storageAccounts/st/listKeys`),
    ).toBe(false);
    expect(allowed('POST', `${ARM}/providers/Microsoft.ResourceGraph/resourceChanges`)).toBe(false);
    expect(allowed('POST', `${ARM}/providers/Microsoft.ResourceGraph/resources/extra`)).toBe(false);
    expect(allowed('POST', `${LOGS}/v1/$batch`)).toBe(false);
    expect(allowed('POST', `${LOGS}/v1/workspaces/${WS}/purge`)).toBe(false);
    expect(allowed('POST', `${LOGS}/v1${VM}/query`)).toBe(false);
    expect(allowed('POST', `${ARM}/v1/workspaces/${WS}/query`)).toBe(false);
  });

  it('blocks an allowlisted path on another host', () => {
    expect(allowed('POST', 'https://evil.example/providers/Microsoft.ResourceGraph/resources')).toBe(false);
    expect(
      allowed(
        'POST',
        'https://management.azure.com.evil.example/providers/Microsoft.ResourceGraph/resources',
      ),
    ).toBe(false);
    expect(allowed('POST', `https://evil.example/v1/workspaces/${WS}/query`)).toBe(false);
    expect(allowed('GET', 'https://evil.example/')).toBe(false);
  });

  it('blocks userinfo, plain HTTP, explicit ports and malformed URLs', () => {
    expect(
      classifyAzureRequest(
        'POST',
        `https://user:pw@management.azure.com/providers/Microsoft.ResourceGraph/resources`,
      ),
    ).toMatchObject({
      allowed: false,
      kind: 'userinfo',
    });
    expect(allowed('GET', 'https://evil.example@management.azure.com/')).toBe(false);
    expect(allowed('GET', `http://management.azure.com${VM}`)).toBe(false);
    expect(allowed('GET', `https://management.azure.com:8443${VM}`)).toBe(false);
    expect(allowed('GET', 'not a url')).toBe(false);
  });

  it('blocks path traversal, plain or encoded', () => {
    expect(allowed('POST', `${ARM}${VM}/../../../../../providers/Microsoft.ResourceGraph/resources`)).toBe(
      false,
    );
    expect(allowed('POST', `${ARM}${VM}/%2e%2e/start`)).toBe(false);
    expect(allowed('POST', `${LOGS}/v1/workspaces/${WS}/%2E%2E/query`)).toBe(false);
    expect(allowed('POST', `${LOGS}/v1/workspaces/${WS}%2fpurge/query`)).toBe(false);
    expect(allowed('GET', `${ARM}/subscriptions/${SUB}/./resourceGroups`)).toBe(false);
    expect(allowed('GET', `${ARM}/subscriptions\\..\\x`)).toBe(false);
  });

  it('says what was blocked without any ID, URL or resource name', () => {
    const err = blockedError('put', `${ARM}${VM}?api-version=2024-07-01`);
    expect(err).toMatchObject({ code: 'WriteBlocked' });
    expect(err.message).toBe('Blocked a non read-only Azure call (PUT management.azure.com/write).');
    expectNoLeak(err.message);
    for (const [method, url] of [
      ['POST', `${ARM}${VM}/start`],
      ['POST', `https://user:pw@management.azure.com${VM}`],
      ['DELETE', `${LOGS}/v1/workspaces/${WS}`],
      ['X-CUSTOM', `https://evil.example/${SUB}`],
    ] as const) {
      const message = blockedError(method, url).message;
      expectNoLeak(message);
      expect(message).not.toMatch(/vm-web-01|rg-app|evil|user:|pw@|https?:|subscriptions/);
    }
  });
});

const ok = (
  request: PipelineRequest,
  status = 200,
  headers: Record<string, string> = {},
): PipelineResponse => ({
  request,
  status,
  headers: createHttpHeaders({ 'content-type': 'application/json', ...headers }),
  bodyAsText: '{"value":[],"tables":[],"data":[],"totalRecords":0,"count":0,"resultTruncated":"false"}',
});

function recordingHttpClient(respond: (request: PipelineRequest) => PipelineResponse = (r) => ok(r)): {
  httpClient: HttpClient;
  sent: string[];
} {
  const sent: string[] = [];
  return {
    sent,
    httpClient: {
      sendRequest: (request) => {
        sent.push(`${request.method} ${request.url}`);
        return Promise.resolve(respond(request));
      },
    },
  };
}

const session = { contextAlias: 'prod', credential: createFakeTokenCredential() };

describe('read-only policy: on every SDK client of the factory', () => {
  const specs = {
    resourceGraph: azureClients.resourceGraph(),
    monitor: azureClients.monitor(),
    monitorForSubscription: azureClients.monitor(SUB),
    resourceHealth: azureClients.resourceHealth(SUB),
    logsQuery: azureClients.logsQuery(),
  };

  it.each(Object.entries(specs))('%s carries the guard first and last in its pipeline', (key, spec) => {
    const client = createClientFactory().getClient<{ pipeline: Pipeline }>(session, key, spec);
    const names = client.pipeline.getOrderedPolicies().map((p) => p.name);
    expect(names[0]).toBe(READ_ONLY_POLICY_NAME);
    expect(names.at(-1)).toBe(READ_ONLY_WIRE_POLICY_NAME);
    expect(names).toContain('bearerTokenAuthenticationPolicy');
  });

  it('lets the reads through, to the HTTP client', async () => {
    const { httpClient, sent } = recordingHttpClient();
    const clients = createClientFactory({ httpClient });
    const monitor = clients.getClient(session, 'monitor', azureClients.monitor());
    for await (const d of monitor.metricDefinitions.list(VM)) expect(d).toBeDefined();
    const graph = clients.getClient(session, 'rg', azureClients.resourceGraph());
    await graph.resources({ query: 'resources | take 1', subscriptions: [SUB] });
    const logs = clients.getClient(session, 'logs', azureClients.logsQuery());
    await logs.queryWorkspace(WS, 'Heartbeat | take 1', { duration: 'PT1H' });
    await logs.queryResource(APPI, 'requests | take 1', { duration: 'PT1H' });
    expect(sent.map((s) => s.split(' ')[0])).toEqual(['GET', 'POST', 'POST', 'POST']);
  });

  it('blocks real SDK write operations before anything is sent', async () => {
    const { httpClient, sent } = recordingHttpClient();
    const clients = createClientFactory({ httpClient });
    const monitor = clients.getClient(session, 'monitor', azureClients.monitor(SUB));
    await expect(monitor.actionGroups.delete('rg-app', 'ag-oncall')).rejects.toMatchObject({
      code: 'WriteBlocked',
    });
    const logs = clients.getClient(session, 'logs', azureClients.logsQuery());
    await expect(
      logs.queryBatch([{ workspaceId: WS, query: 'Heartbeat', timespan: { duration: 'PT1H' } }]),
    ).rejects.toMatchObject({ code: 'WriteBlocked' });
    const graph = clients.getClient(session, 'rg', azureClients.resourceGraph());
    await expect(
      graph.resourceChanges({ resourceIds: [VM], interval: { start: new Date(0), end: new Date() } }),
    ).rejects.toMatchObject({
      code: 'WriteBlocked',
    });
    expect(sent).toEqual([]);
  });

  it('checks every hop on the wire: a 307 from an allowed POST to an action is refused', async () => {
    // A 307 keeps the method and body: the SDK's redirect policy would re-POST to the new path.
    const { httpClient, sent } = recordingHttpClient((request) =>
      request.url.includes('ResourceGraph') ? ok(request, 307, { location: `${VM}/start` }) : ok(request),
    );
    const graph = createClientFactory({ httpClient }).getClient(session, 'rg', azureClients.resourceGraph());
    await expect(graph.resources({ query: 'resources', subscriptions: [SUB] })).rejects.toMatchObject({
      code: 'WriteBlocked',
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/^POST https:\/\/management\.azure\.com\/providers\/Microsoft\.ResourceGraph\//);
  });
});
