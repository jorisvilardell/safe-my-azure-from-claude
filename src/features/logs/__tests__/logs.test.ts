import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  CALLER_EMAIL,
  CLIENT_SECRET,
  CORRELATION_ID,
  FAKE_ID_TOKEN,
  LOG_ANALYTICS_TABLE,
  PUBLIC_IP_CLIENT,
  PUBLIC_IP_PEER,
  SAS_URL,
  STORAGE_CONNECTION_STRING,
  SUBSCRIPTION_ID,
  WORKSPACE_ID,
} from '../../../../test/fixtures/azure/index.js';
import {
  createFakeAzureAccess,
  createTestToolContext,
  expectNoLeak,
  parseToolText,
  toolText,
  type FakeAzureAccess,
} from '../../../../test/helpers/index.js';
import { executeTool, type ToolDefinition } from '../../../core/mcp/index.js';
import { createLogsFeature } from '../index.js';
import { MAX_CELL_CHARS, MAX_COLUMNS, MAX_RESULT_CHARS, MAX_ROWS } from '../logs.mapper.js';
import { RunKqlInput } from '../logs.schemas.js';
import { LOGS_CLIENT_KEY, SERVER_TIMEOUT_SECONDS } from '../logs.service.js';

const SUB_NETWORK = '00000000-0000-0000-0000-000000000002';
const APPI_CUSTOMER_ID = '00000000-0000-0000-0000-0000000000f2';
const LAW_ARM_ID = `/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/rg-obs/providers/Microsoft.OperationalInsights/workspaces/law-prod`;
const APPI_ARM_ID = `/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/rg-app/providers/Microsoft.Insights/components/appi-api`;

const WORKSPACE_ROWS = [
  {
    id: LAW_ARM_ID,
    name: 'law-prod',
    type: 'microsoft.operationalinsights/workspaces',
    resourceGroup: 'rg-obs',
    subscriptionId: SUBSCRIPTION_ID,
    location: 'westeurope',
    customerId: WORKSPACE_ID,
    retentionInDays: 30,
  },
  {
    id: APPI_ARM_ID,
    name: 'appi-api',
    type: 'microsoft.insights/components',
    resourceGroup: 'rg-app',
    subscriptionId: SUBSCRIPTION_ID,
    location: 'westeurope',
    customerId: APPI_CUSTOMER_ID,
    retentionInDays: 90,
  },
];

interface SdkTable {
  name: string;
  columnDescriptors: { name: string; type: string }[];
  rows: unknown[][];
}

interface QueryCall {
  readonly method: 'queryWorkspace' | 'queryResource';
  readonly target: string;
  readonly query: string;
  readonly timespan: unknown;
  readonly options: { serverTimeoutInSeconds?: number; abortSignal?: unknown } | undefined;
}

type Responder = (call: QueryCall) => Promise<unknown>;

function success(table: SdkTable): Promise<unknown> {
  return Promise.resolve({ status: 'Success', tables: [table] });
}

/** The raw REST fixture, converted like the SDK does (datetime → Date). */
function fixtureTable(): SdkTable {
  const raw = (
    LOG_ANALYTICS_TABLE as { tables: { columns: { name: string; type: string }[]; rows: unknown[][] }[] }
  ).tables[0];
  if (raw === undefined) throw new Error('fixture without table');
  return {
    name: 'PrimaryResult',
    columnDescriptors: raw.columns,
    rows: raw.rows.map((r) =>
      r.map((c, i) => (raw.columns[i]?.type === 'datetime' ? new Date(String(c)) : c)),
    ),
  };
}

interface Rig {
  readonly azure: FakeAzureAccess;
  readonly calls: QueryCall[];
  call(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
}

function setup(
  respond: Responder = () => success(fixtureTable()),
  rows: readonly unknown[] = WORKSPACE_ROWS,
): Rig {
  const azure = createFakeAzureAccess({
    // Mimic the `name =~` filter of the resolver query.
    resourceGraphRows: ({ query }) => {
      const m = /name =~ '([^']+)'/.exec(query);
      return m === null ? rows : rows.filter((r) => (r as { name: string }).name === m[1]);
    },
  });
  const calls: QueryCall[] = [];
  const record =
    (method: QueryCall['method']) =>
    (target: string, query: string, timespan: unknown, options?: QueryCall['options']): Promise<unknown> => {
      const c = { method, target, query, timespan, options };
      calls.push(c);
      return respond(c);
    };
  azure.stubClient(LOGS_CLIENT_KEY, {
    queryWorkspace: record('queryWorkspace'),
    queryResource: record('queryResource'),
  });
  const ctx = createTestToolContext({ azure });
  const feature = createLogsFeature();
  return {
    azure,
    calls,
    async call(name, args) {
      const tool: ToolDefinition | undefined = feature.tools.find((t) => t.name === name);
      if (tool === undefined) throw new Error(`missing tool ${name}`);
      const result = await executeTool(tool, args, ctx);
      const text = toolText(result);
      expectNoLeak(text);
      // The customerId and ARM IDs never reach the AI, not even pseudonymised in part.
      expect(text).not.toContain(WORKSPACE_ID);
      expect(text).not.toContain(APPI_CUSTOMER_ID);
      expect(text.toLowerCase()).not.toContain('/subscriptions/');
      return result;
    },
  };
}

interface KqlOut {
  workspace: string;
  kind: string;
  timespan: unknown;
  columns: { name: string; type: string }[];
  rows: unknown[][];
  rowCount: number;
  truncated: boolean;
  truncation?: string[];
  partialFailure?: { code: string; message: string };
}

const kql = (r: CallToolResult): KqlOut => parseToolText(r) as KqlOut;
const errorOf = (r: CallToolResult): { code: string; message: string } => {
  expect(r.isError).toBe(true);
  return parseToolText(r) as { code: string; message: string };
};

describe('logs feature', () => {
  it('exposes the three log tools', () => {
    expect(createLogsFeature().tools.map((t) => t.name)).toEqual([
      'list_workspaces',
      'list_tables',
      'run_kql',
    ]);
  });

  // #53 item 5: the shared core schemas, like every other feature.
  it.each([
    ['subscription', `/subscriptions/${SUBSCRIPTION_ID}`],
    ['resourceGroup', 'rg app'],
    ['workspace', `/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/rg/providers/x/y/law-prod`],
    ['workspace', "law' or 1==1"],
  ])('rejects unsafe %s', (key, value) => {
    const schema = z.object(RunKqlInput);
    expect(schema.safeParse({ workspace: 'law-prod', query: 'T | take 1' }).success).toBe(true);
    expect(schema.safeParse({ workspace: 'law-prod', query: 'T | take 1', [key]: value }).success).toBe(
      false,
    );
  });

  describe('list_workspaces', () => {
    it('lists names, kinds and retention, never the customerId or ARM ID', async () => {
      const rig = setup();
      const out = parseToolText(await rig.call('list_workspaces', {}));
      expect(out).toEqual({
        workspaces: [
          {
            name: 'law-prod',
            kind: 'log-analytics',
            resourceGroup: 'rg-obs',
            subscription: 'prod-app',
            location: 'westeurope',
            retentionInDays: 30,
          },
          {
            name: 'appi-api',
            kind: 'app-insights',
            resourceGroup: 'rg-app',
            subscription: 'prod-app',
            location: 'westeurope',
            retentionInDays: 90,
          },
        ],
        truncated: false,
      });
    });

    it('scopes to a subscription alias', async () => {
      const rig = setup();
      await rig.call('list_workspaces', { subscription: 'prod-network' });
      expect(rig.azure.resourceGraphQueries.at(-1)?.subscriptions).toEqual([SUB_NETWORK]);
    });
  });

  describe('workspace resolution', () => {
    it('queries a Log Analytics workspace by its customerId, server-side', async () => {
      const rig = setup();
      await rig.call('run_kql', { workspace: 'law-prod', query: 'AppTraces' });
      expect(rig.calls[0]?.method).toBe('queryWorkspace');
      expect(rig.calls[0]?.target).toBe(WORKSPACE_ID);
    });

    it('queries App Insights through its resource ID', async () => {
      const rig = setup();
      const out = kql(await rig.call('run_kql', { workspace: 'appi-api', query: 'requests' }));
      expect(rig.calls[0]?.method).toBe('queryResource');
      expect(rig.calls[0]?.target).toBe(APPI_ARM_ID);
      expect(out.kind).toBe('app-insights');
    });

    it('fails clearly on an unknown name', async () => {
      const rig = setup();
      const err = errorOf(await rig.call('run_kql', { workspace: 'nope', query: 'T' }));
      expect(err.code).toBe('ResourceNotFound');
      expect(rig.calls).toHaveLength(0);
    });

    it('fails clearly on an ambiguous name, by names and aliases only', async () => {
      const twin = {
        ...WORKSPACE_ROWS[0],
        id: LAW_ARM_ID.replace('rg-obs', 'rg-dr'),
        resourceGroup: 'rg-dr',
      };
      const rig = setup(undefined, [...WORKSPACE_ROWS, { ...twin, subscriptionId: SUB_NETWORK }]);
      const err = errorOf(await rig.call('run_kql', { workspace: 'law-prod', query: 'T' }));
      expect(err.code).toBe('AmbiguousResource');
      expect(err.message).toContain('rg-dr/log-analytics/law-prod (subscription prod-network)');
      expect(rig.calls).toHaveLength(0);
    });
  });

  describe('run_kql: anonymisation', () => {
    it('scrubs GUIDs, emails, public IPs, SAS URLs, connection strings, secrets and JWTs in cells', async () => {
      const table = fixtureTable();
      table.columnDescriptors.push(
        { name: 'Properties', type: 'dynamic' },
        { name: 'client_secret', type: 'string' },
      );
      table.rows = table.rows.map((r) => [
        ...r,
        {
          user: CALLER_EMAIL,
          ip: PUBLIC_IP_PEER,
          headers: { Authorization: `Bearer ${FAKE_ID_TOKEN}` },
          clientSecret: CLIENT_SECRET,
          url: SAS_URL,
          correlation: CORRELATION_ID,
        },
        'not-a-pattern-but-a-secret-column',
      ]);
      table.rows.push([
        new Date('2026-11-03T08:05:00Z'),
        null,
        null,
        null,
        null,
        null,
        `jwt ${FAKE_ID_TOKEN}`,
        null,
        null,
      ]);
      const rig = setup(() => success(table));
      const result = await rig.call('run_kql', { workspace: 'law-prod', query: 'AppTraces' });
      const out = kql(result);
      const text = toolText(result);
      for (const v of [
        CALLER_EMAIL,
        PUBLIC_IP_CLIENT,
        PUBLIC_IP_PEER,
        SAS_URL,
        STORAGE_CONNECTION_STRING,
        CLIENT_SECRET,
      ]) {
        expect(text).not.toContain(v);
      }
      expect(text).not.toContain('not-a-pattern-but-a-secret-column');
      expect(out.rowCount).toBe(4);
      // Dates come back as ISO strings, dynamic cells as (scrubbed) objects.
      expect(out.rows[0]?.[0]).toBe('2026-11-03T08:04:11.000Z');
      expect(typeof out.rows[0]?.[7]).toBe('object');
      expect(out.rows[3]?.[0]).toBe('2026-11-03T08:05:00.000Z');
    });
  });

  describe('run_kql: guard', () => {
    it.each([
      ['.show tables', 'Management commands', 'show tables'],
      ['externaldata (a: string) [@"https://evil.example/x.csv"]', 'Cross-scope', 'evil.example'],
      ["cluster('other').database('db').SecretTable", 'Cross-scope', 'SecretTable'],
    ])('rejects %s without echoing the query or calling Azure', async (query, reason, fragment) => {
      const rig = setup();
      const result = await rig.call('run_kql', { workspace: 'law-prod', query });
      const err = errorOf(result);
      expect(err.code).toBe('KqlRejected');
      expect(err.message).toContain(reason);
      expect(toolText(result)).not.toContain(fragment);
      expect(rig.calls).toHaveLength(0);
    });

    it('sends the guarded query and the guard timespan to the SDK', async () => {
      const rig = setup();
      const out = kql(
        await rig.call('run_kql', { workspace: 'law-prod', query: 'AppTraces', timespan: 'pt6h' }),
      );
      expect(rig.calls[0]?.query).toBe(`AppTraces\n| take ${MAX_ROWS + 1}`);
      expect(rig.calls[0]?.timespan).toEqual({ duration: 'PT6H' });
      expect(out.timespan).toEqual({ duration: 'PT6H' });
    });

    it('defaults to P1D and converts intervals to dates', async () => {
      const rig = setup();
      await rig.call('run_kql', { workspace: 'law-prod', query: 'T' });
      expect(rig.calls[0]?.timespan).toEqual({ duration: 'P1D' });
      await rig.call('run_kql', {
        workspace: 'law-prod',
        query: 'T',
        timespan: '2026-11-03T00:00:00Z/2026-11-03T06:00:00Z',
      });
      expect(rig.calls[1]?.timespan).toEqual({
        startTime: new Date('2026-11-03T00:00:00Z'),
        endTime: new Date('2026-11-03T06:00:00Z'),
      });
    });

    it('rejects a timespan longer than 7 days', async () => {
      const rig = setup();
      const err = errorOf(await rig.call('run_kql', { workspace: 'law-prod', query: 'T', timespan: 'P30D' }));
      expect(err.code).toBe('KqlRejected');
      expect(rig.calls).toHaveLength(0);
    });

    it('sets a server timeout and an abort signal', async () => {
      const rig = setup();
      await rig.call('run_kql', { workspace: 'law-prod', query: 'T' });
      expect(rig.calls[0]?.options?.serverTimeoutInSeconds).toBe(SERVER_TIMEOUT_SECONDS);
      expect(rig.calls[0]?.options?.abortSignal).toBeInstanceOf(AbortSignal);
    });
  });

  describe('run_kql: caps', () => {
    const table = (rows: number, cols = 1, cell: (r: number, c: number) => unknown = (r) => r): SdkTable => ({
      name: 'PrimaryResult',
      columnDescriptors: Array.from({ length: cols }, (_, c) => ({ name: `c${c}`, type: 'long' })),
      rows: Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => cell(r, c))),
    });

    it('returns at most 500 rows and says more exist', async () => {
      const rig = setup(() => success(table(MAX_ROWS + 1)));
      const out = kql(await rig.call('run_kql', { workspace: 'law-prod', query: 'T' }));
      expect(out.rowCount).toBe(MAX_ROWS);
      expect(out.rows).toHaveLength(MAX_ROWS);
      expect(out.truncated).toBe(true);
      expect(out.truncation?.join(' ')).toContain(`More than ${MAX_ROWS} rows`);
    });

    it('masks a public IP under an AI-chosen *version key (bag_pack), and encoded IDs', async () => {
      const ip = '203.0.113.77';
      const sub = '00000000-0000-0000-0000-00000000c0de';
      const rig = setup(() =>
        success(
          table(1, 2, (_r, c) =>
            c === 0 ? { x_version: ip, agentVersion: ip } : `u=%2Fsubscriptions%2F${sub}%2Fx`,
          ),
        ),
      );
      const result = await rig.call('run_kql', { workspace: 'law-prod', query: 'T' });
      const text = JSON.stringify(kql(result));
      expect(text).not.toContain(ip);
      expect(text).not.toContain(sub);
    });

    it('is not truncated at exactly 500 rows', async () => {
      const rig = setup(() => success(table(MAX_ROWS)));
      const out = kql(await rig.call('run_kql', { workspace: 'law-prod', query: 'T' }));
      expect(out).toMatchObject({ rowCount: MAX_ROWS, truncated: false });
      expect(out.truncation).toBeUndefined();
    });

    it('cuts long cells after scrubbing them', async () => {
      const long = `${'x'.repeat(MAX_CELL_CHARS - 20)} ${CALLER_EMAIL} ${'y'.repeat(2000)}`;
      const rig = setup(() => success(table(2, 2, (_r, c) => (c === 0 ? long : { blob: 'z'.repeat(3000) }))));
      const out = kql(await rig.call('run_kql', { workspace: 'law-prod', query: 'T' }));
      const [first, second] = out.rows[0] ?? [];
      expect(typeof first).toBe('string');
      expect(String(first).length).toBeLessThanOrEqual(MAX_CELL_CHARS + 20);
      expect(String(first)).toMatch(/…\[truncated\]$/);
      expect(typeof second).toBe('string');
      expect(String(second).length).toBeLessThanOrEqual(MAX_CELL_CHARS + 20);
      expect(out.truncated).toBe(true);
      expect(out.truncation?.join(' ')).toContain('4 cell(s)');
    });

    it('caps the total response size', async () => {
      const rig = setup(() => success(table(MAX_ROWS, 1, () => 'w'.repeat(900))));
      const result = await rig.call('run_kql', { workspace: 'law-prod', query: 'T' });
      const out = kql(result);
      expect(out.rowCount).toBeLessThan(MAX_ROWS);
      expect(JSON.stringify(out.rows).length).toBeLessThanOrEqual(MAX_RESULT_CHARS);
      expect(out.truncation?.join(' ')).toContain('response size limit');
    });

    it('caps the number of columns', async () => {
      const rig = setup(() => success(table(1, MAX_COLUMNS + 50)));
      const out = kql(
        await rig.call('run_kql', { workspace: 'law-prod', query: 'T | evaluate bag_unpack(p)' }),
      );
      expect(out.columns).toHaveLength(MAX_COLUMNS);
      expect(out.rows[0]).toHaveLength(MAX_COLUMNS);
      expect(out.truncation?.join(' ')).toContain(`first ${MAX_COLUMNS} of ${MAX_COLUMNS + 50} columns`);
    });
  });

  describe('run_kql: failures', () => {
    it('returns partial results with a safe partialFailure', async () => {
      const rig = setup(() =>
        Promise.resolve({
          status: 'PartialFailure',
          partialTables: [fixtureTable()],
          partialError: {
            code: 'PartialError',
            message: `Query on workspace ${WORKSPACE_ID} by ${CALLER_EMAIL} failed: AppTraces | zz-hidden-term`,
          },
        }),
      );
      const result = await rig.call('run_kql', {
        workspace: 'law-prod',
        query: 'AppTraces | where x == "zz-hidden-term"',
      });
      const out = kql(result);
      expect(out.rowCount).toBe(3);
      expect(out.truncated).toBe(true);
      expect(out.partialFailure?.code).toBe('PartialError');
      expect(toolText(result)).not.toContain('zz-hidden-term');
    });

    it('maps an SDK abort to a QueryTimeout', async () => {
      const rig = setup(() => Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      const err = errorOf(await rig.call('run_kql', { workspace: 'law-prod', query: 'T' }));
      expect(err.code).toBe('QueryTimeout');
    });

    it('maps an HTTP 504 to a QueryTimeout', async () => {
      const rig = setup(() =>
        Promise.reject(Object.assign(new Error(`gateway ${WORKSPACE_ID}`), { statusCode: 504 })),
      );
      expect(errorOf(await rig.call('run_kql', { workspace: 'law-prod', query: 'T' })).code).toBe(
        'QueryTimeout',
      );
    });

    it('turns a 400 into a safe KqlQueryFailed, never echoing the SDK message', async () => {
      const sdkMessage = `Failed to resolve table 'Nope' in https://api.loganalytics.io/v1/workspaces/${WORKSPACE_ID}/query`;
      const rig = setup(() =>
        Promise.reject(Object.assign(new Error(sdkMessage), { statusCode: 400, code: 'BadArgumentError' })),
      );
      const result = await rig.call('run_kql', { workspace: 'law-prod', query: 'Nope' });
      const err = errorOf(result);
      expect(err.code).toBe('KqlQueryFailed');
      expect(err.message).toContain('BadArgumentError');
      expect(toolText(result)).not.toContain('loganalytics.io');
      expect(toolText(result)).not.toContain('Nope');
    });

    it('withholds other SDK errors', async () => {
      const rig = setup(() =>
        Promise.reject(Object.assign(new Error(`denied for ${CALLER_EMAIL}`), { statusCode: 403 })),
      );
      const err = errorOf(await rig.call('run_kql', { workspace: 'law-prod', query: 'T' }));
      expect(err.message).toContain('HTTP 403');
    });

    it('fails with NotLoggedIn before any Azure call', async () => {
      const rig = setup();
      rig.azure.logout('prod');
      expect(errorOf(await rig.call('run_kql', { workspace: 'law-prod', query: 'T' })).code).toBe(
        'NotLoggedIn',
      );
      expect(rig.calls).toHaveLength(0);
    });
  });

  describe('list_tables', () => {
    it('counts rows per table over 24 h through the guard', async () => {
      const rig = setup(() =>
        success({
          name: 'PrimaryResult',
          columnDescriptors: [
            { name: 'TableName', type: 'string' },
            { name: 'RowCount', type: 'long' },
          ],
          rows: [
            ['AppTraces', 1200],
            ['Heartbeat', 300],
          ],
        }),
      );
      const out = parseToolText(await rig.call('list_tables', { workspace: 'law-prod' }));
      expect(out).toMatchObject({
        workspace: 'law-prod',
        kind: 'log-analytics',
        tables: [
          { name: 'AppTraces', rowCount24h: 1200 },
          { name: 'Heartbeat', rowCount24h: 300 },
        ],
        truncated: false,
      });
      expect(rig.calls[0]?.query).toMatch(/^union withsource=TableName \*[\s\S]*\| take 201$/);
      expect(rig.calls[0]?.timespan).toEqual({ duration: 'P1D' });
    });
  });
});
