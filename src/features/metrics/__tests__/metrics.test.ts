import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  CALLER_EMAIL,
  createRestError,
  METRICS_RESPONSE,
  PRIVATE_IP,
  PUBLIC_IP_CLIENT,
  PUBLIC_IP_PEER,
  VM_ARM_ID,
} from '../../../../test/fixtures/azure/index.js';
import {
  createFakeAzureAccess,
  createTestToolContext,
  expectNoLeak,
  FAKE_RESOURCES,
  parseToolText,
  toolText,
  type FakeAzureAccess,
} from '../../../../test/helpers/index.js';
import { executeTool, type ToolContext, type ToolDefinition } from '../../../core/mcp/index.js';
import { createMetricsFeature } from '../index.js';
import { MAX_FILTER_CLAUSES, parseFilter, renderFilter } from '../metrics.filter.js';
import { FREE_TEXT_MAX, type RawMetricDefinition, type RawMetricsResponse } from '../metrics.mapper.js';
import { GetMetricsInput, MAX_POINTS } from '../metrics.schemas.js';
import { MAX_DEFINITIONS, METRICS_CLIENT_KEY, type MonitorMetricsClient } from '../metrics.service.js';

const VM = { resourceGroup: 'rg-app', name: 'vm-web-01', subscription: 'prod-app' } as const;
const [VM_RESOURCE] = FAKE_RESOURCES;

/** Shaped like `@azure/arm-monitor` metric definitions, with identifiers planted in every field. */
const DEFINITIONS: readonly unknown[] = [
  {
    id: `${VM_ARM_ID}/providers/microsoft.insights/metricdefinitions/Percentage CPU`,
    resourceId: VM_ARM_ID,
    namespace: 'Microsoft.Compute/virtualMachines',
    name: { value: 'Percentage CPU', localizedValue: 'Percentage CPU' },
    displayDescription: `CPU used. Contact ${CALLER_EMAIL} or ${PUBLIC_IP_CLIENT}. ${'x'.repeat(500)}`,
    unit: 'Percent',
    primaryAggregationType: 'Average',
    supportedAggregationTypes: ['None', 'Average', 'Minimum', 'Maximum', 'Total', 'Count'],
    isDimensionRequired: false,
    metricAvailabilities: [
      { timeGrain: 'PT1M', retention: 'P93D' },
      { timeGrain: 'PT1H', retention: 'P93D' },
    ],
    dimensions: [],
  },
  {
    id: `${VM_ARM_ID}/providers/microsoft.insights/metricdefinitions/Inbound Flows`,
    resourceId: VM_ARM_ID,
    namespace: 'Microsoft.Compute/virtualMachines',
    name: { value: 'Inbound Flows', localizedValue: 'Inbound flows (count)' },
    displayDescription: 'Inbound flows by remote IP',
    unit: 'Count',
    primaryAggregationType: 'Total',
    supportedAggregationTypes: ['Total'],
    dimensions: [{ value: 'RemoteIP', localizedValue: 'Remote IP' }],
  },
];

interface MetricsCall {
  readonly uri: string;
  readonly options: Parameters<MonitorMetricsClient['metrics']['list']>[1];
}

interface Rig {
  readonly azure: FakeAzureAccess;
  readonly ctx: ToolContext;
  readonly calls: MetricsCall[];
  readonly definitionCalls: string[];
  call(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
}

function setup(
  opts: {
    response?: unknown;
    definitions?: readonly unknown[];
    fail?: () => Error;
  } = {},
): Rig {
  const azure = createFakeAzureAccess();
  const ctx = createTestToolContext({ azure });
  const calls: MetricsCall[] = [];
  const definitionCalls: string[] = [];
  const client: MonitorMetricsClient = {
    metrics: {
      list(uri, options) {
        calls.push({ uri, options });
        if (opts.fail !== undefined) return Promise.reject(opts.fail());
        return Promise.resolve((opts.response ?? METRICS_RESPONSE) as RawMetricsResponse);
      },
    },
    metricDefinitions: {
      async *list(uri) {
        definitionCalls.push(uri);
        if (opts.fail !== undefined) throw opts.fail();
        await Promise.resolve();
        yield* (opts.definitions ?? DEFINITIONS) as RawMetricDefinition[];
      },
    },
  };
  azure.stubClient(METRICS_CLIENT_KEY, client);
  const feature = createMetricsFeature();
  return {
    azure,
    ctx,
    calls,
    definitionCalls,
    async call(name, args) {
      const tool: ToolDefinition | undefined = feature.tools.find((t) => t.name === name);
      if (tool === undefined) throw new Error(`missing tool ${name}`);
      // Defaults applied as the MCP SDK would, from the advertised schema.
      const parsed = z.object(tool.inputSchema).parse(args);
      const result = await executeTool(tool, parsed, ctx);
      expectNoLeak(toolText(result));
      return result;
    },
  };
}

const errorOf = (result: CallToolResult): { code: string; message: string } => {
  expect(result.isError).toBe(true);
  return parseToolText(result) as { code: string; message: string };
};

interface MetricsOut {
  interval: string;
  pointCount: number;
  seriesTruncated: boolean;
  metrics: {
    name: string;
    unit: string;
    aggregation?: string;
    series: { dimensions: Record<string, string>; points: [string, number][] }[];
  }[];
}

describe('metrics feature', () => {
  it('exposes list_metric_definitions and get_metrics', () => {
    expect(createMetricsFeature().tools.map((t) => t.name)).toEqual([
      'list_metric_definitions',
      'get_metrics',
    ]);
  });

  describe('list_metric_definitions', () => {
    it('returns allowlisted definitions for the resolved resource, without ids', async () => {
      const rig = setup();
      const result = await rig.call('list_metric_definitions', VM);
      expect(result.isError).toBeUndefined();
      if (VM_RESOURCE === undefined) throw new Error('no fake resource');
      expect(rig.definitionCalls).toEqual([rig.azure.armId(VM_RESOURCE)]);

      const out = parseToolText(result) as {
        resource: string;
        truncated: boolean;
        definitions: Record<string, unknown>[];
      };
      expect(out.resource).toBe('vm-web-01');
      expect(out.truncated).toBe(false);
      const [cpu, flows] = out.definitions;
      expect(cpu).toMatchObject({
        name: 'Percentage CPU',
        namespace: 'Microsoft.Compute/virtualMachines',
        unit: 'Percent',
        primaryAggregation: 'Average',
        supportedAggregations: ['None', 'Average', 'Minimum', 'Maximum', 'Total', 'Count'],
        dimensions: [],
        timeGrains: ['PT1M', 'PT1H'],
      });
      expect(cpu).not.toHaveProperty('displayName');
      expect(cpu).not.toHaveProperty('id');
      expect(cpu).not.toHaveProperty('resourceId');
      expect(String(cpu?.description).length).toBeLessThanOrEqual(FREE_TEXT_MAX);
      expect(flows).toMatchObject({ displayName: 'Inbound flows (count)', dimensions: ['RemoteIP'] });
    });

    it(`stops at ${MAX_DEFINITIONS} definitions and says so`, async () => {
      const many = Array.from({ length: MAX_DEFINITIONS + 5 }, (_, i) => ({ name: { value: `m${i}` } }));
      const out = parseToolText(await setup({ definitions: many }).call('list_metric_definitions', VM)) as {
        definitions: unknown[];
        truncated: boolean;
      };
      expect(out.definitions).toHaveLength(MAX_DEFINITIONS);
      expect(out.truncated).toBe(true);
    });

    it('reports an unknown resource with the resolver error, without calling Azure Monitor', async () => {
      const rig = setup();
      const err = errorOf(await rig.call('list_metric_definitions', { ...VM, name: 'vm-nope' }));
      expect(err.code).toBe('ResourceNotFound');
      expect(rig.definitionCalls).toEqual([]);
    });
  });

  describe('get_metrics', () => {
    it('masks public IPs in dimension values and keeps private ones', async () => {
      const rig = setup();
      const result = await rig.call('get_metrics', {
        ...VM,
        metrics: ['Inbound Flows'],
        filter: "RemoteIP eq '*'",
      });
      const text = toolText(result);
      expect(text).not.toContain(PUBLIC_IP_CLIENT);
      expect(text).not.toContain(PUBLIC_IP_PEER);

      const out = parseToolText(result) as MetricsOut;
      const [metric] = out.metrics;
      expect(metric).toMatchObject({ name: 'Inbound Flows', unit: 'Count', aggregation: 'Total' });
      const values = metric?.series.map((s) => s.dimensions.RemoteIP);
      expect(values?.[0]).toMatch(/^public-ip-external-\d+$/);
      expect(values?.[1]).toMatch(/^public-ip-external-\d+$/);
      expect(values?.[0]).not.toBe(values?.[1]);
      expect(values?.[2]).toBe(PRIVATE_IP);
      expect(metric?.series[0]?.points).toEqual([
        ['2026-11-03T08:00:00.000Z', 120],
        ['2026-11-03T08:01:00.000Z', 98],
      ]);
      expect(out.pointCount).toBe(4);
      expect(out.interval).toBe('PT1M');
    });

    it('sends the resolved resource, an absolute timespan and the query options to Azure', async () => {
      const rig = setup();
      await rig.call('get_metrics', {
        ...VM,
        metrics: ['Percentage CPU', 'Inbound Flows'],
        timespan: 'PT6H',
        interval: 'PT5M',
        aggregation: 'Maximum',
      });
      const [sent] = rig.calls;
      if (VM_RESOURCE === undefined) throw new Error('no fake resource');
      expect(sent?.uri).toBe(rig.azure.armId(VM_RESOURCE));
      expect(sent?.options).toMatchObject({
        interval: 'PT5M',
        metricnames: 'Percentage CPU,Inbound Flows',
        aggregation: 'Maximum',
      });
      expect(sent?.options).not.toHaveProperty('filter');
      expect(sent?.options).not.toHaveProperty('top');
      const [start = '', end = ''] = (sent?.options?.timespan ?? '').split('/');
      expect(Date.parse(end) - Date.parse(start)).toBe(6 * 3_600_000);
    });

    it('drops points that have no value and reads SDK Date timestamps', async () => {
      const response = {
        interval: 'PT1M',
        value: [
          {
            name: { value: 'Percentage CPU' },
            unit: 'Percent',
            timeseries: [
              {
                data: [
                  { timeStamp: new Date('2026-11-03T08:00:00Z'), average: 12.5 },
                  { timeStamp: new Date('2026-11-03T08:01:00Z') },
                  { timeStamp: new Date('2026-11-03T08:02:00Z'), average: 0 },
                ],
              },
            ],
          },
        ],
      };
      const out = parseToolText(
        await setup({ response }).call('get_metrics', { ...VM, metrics: ['Percentage CPU'] }),
      ) as MetricsOut;
      expect(out.metrics[0]?.aggregation).toBe('Average');
      expect(out.metrics[0]?.series[0]).toEqual({
        dimensions: {},
        points: [
          ['2026-11-03T08:00:00.000Z', 12.5],
          ['2026-11-03T08:02:00.000Z', 0],
        ],
      });
    });

    it('keeps at most `top` series per metric and flags the cut', async () => {
      const series = Array.from({ length: 5 }, (_, i) => ({
        metadatavalues: [{ name: { value: 'Instance' }, value: `vm-${i}` }],
        data: [{ timeStamp: '2026-11-03T08:00:00Z', total: i }],
      }));
      const response = { value: [{ name: { value: 'Requests' }, unit: 'Count', timeseries: series }] };
      const rig = setup({ response });
      const out = parseToolText(
        await rig.call('get_metrics', { ...VM, metrics: ['Requests'], filter: "Instance eq '*'", top: 3 }),
      ) as MetricsOut;
      expect(rig.calls[0]?.options).toMatchObject({ filter: "Instance eq '*'", top: 3 });
      expect(out.metrics[0]?.series).toHaveLength(3);
      expect(out.seriesTruncated).toBe(true);
    });

    it('maps a masked dimension value back to the real one in the filter (server side only)', async () => {
      const rig = setup();
      const first = parseToolText(
        await rig.call('get_metrics', { ...VM, metrics: ['Inbound Flows'], filter: "RemoteIP eq '*'" }),
      ) as MetricsOut;
      const masked = first.metrics[0]?.series[0]?.dimensions.RemoteIP ?? '';
      await rig.call('get_metrics', { ...VM, metrics: ['Inbound Flows'], filter: `RemoteIP eq '${masked}'` });
      expect(rig.calls[1]?.options?.filter).toBe(`RemoteIP eq '${PUBLIC_IP_CLIENT}'`);
    });

    describe('points cap', () => {
      it(`refuses a result over ${MAX_POINTS} points and suggests a larger interval`, async () => {
        const data = Array.from({ length: MAX_POINTS + 1 }, (_, i) => ({
          timeStamp: new Date(Date.UTC(2026, 10, 3) + i * 60_000).toISOString(),
          average: i,
        }));
        const response = {
          value: [{ name: { value: 'Percentage CPU' }, unit: 'Percent', timeseries: [{ data }] }],
        };
        const err = errorOf(
          await setup({ response }).call('get_metrics', {
            ...VM,
            metrics: ['Percentage CPU'],
            timespan: 'P2D',
          }),
        );
        expect(err.code).toBe('TooManyPoints');
        expect(err.message).toMatch(/larger interval/);
      });

      it('refuses an explicit interval that cannot fit, before calling Azure', async () => {
        const rig = setup();
        const err = errorOf(
          await rig.call('get_metrics', {
            ...VM,
            metrics: ['Percentage CPU'],
            timespan: 'P7D',
            interval: 'PT1M',
          }),
        );
        expect(err.code).toBe('TooManyPoints');
        expect(rig.calls).toEqual([]);
      });

      it.each([
        [['Percentage CPU'], undefined, 'PT30M'],
        [['a', 'b'], undefined, 'PT1H'],
        [['a', 'b', 'c', 'd'], undefined, 'PT6H'],
        [['Inbound Flows'], "RemoteIP eq '*'", 'PT6H'],
      ] as const)(
        'picks the smallest grain that fits for %j over P30D',
        async (metrics, filter, interval) => {
          const rig = setup();
          await rig.call('get_metrics', { ...VM, metrics, timespan: 'P30D', ...(filter ? { filter } : {}) });
          expect(rig.calls[0]?.options?.interval).toBe(interval);
        },
      );
    });

    describe('filter validation', () => {
      it.each([
        ["RemoteIP eq '10.0.0.1'", "RemoteIP eq '10.0.0.1'"],
        ["ApiName EQ 'GetBlob' OR ApiName eq 'PutBlob'", "ApiName eq 'GetBlob' or ApiName eq 'PutBlob'"],
        ["Name eq 'O''Brien' and Code ne '*'", "Name eq 'O''Brien' and Code ne '*'"],
        // A doubled quote stays inside the value: it can never close the literal.
        ["Name eq 'a'' or Other eq ''b'", "Name eq 'a'' or Other eq ''b'"],
      ])('accepts %s', (input, rendered) => {
        expect(renderFilter(parseFilter(input))).toBe(rendered);
      });

      it.each([
        ["RemoteIP eq 'a') or (1 eq 1"],
        ["RemoteIP eq 'a' or 1 eq '1'"],
        ["RemoteIP eq 'a'; Other eq 'b'"],
        ["RemoteIP eq 'a' Other eq 'b'"],
        ["RemoteIP gt '1'"],
        ['RemoteIP eq 10.0.0.1'],
        ["RemoteIP eq 'unterminated"],
        ["startswith(RemoteIP, '10.')"],
        ["RemoteIP eq 'a' and"],
        ["RemoteIP eq 'a'\nand Other eq 'b'"],
        ["RemoteIP eq 'a\u0000'"],
        [`RemoteIP eq '${'x'.repeat(300)}'`],
        [Array.from({ length: MAX_FILTER_CLAUSES + 1 }, (_, i) => `D${i} eq 'v'`).join(' and ')],
        ['   '],
      ])('rejects %j', (input) => {
        expect(() => parseFilter(input)).toThrow(/Invalid metric filter/);
      });

      it('rejects an invalid filter with an AppError, without calling Azure', async () => {
        const rig = setup();
        const err = errorOf(
          await rig.call('get_metrics', {
            ...VM,
            metrics: ['Inbound Flows'],
            filter: "RemoteIP eq 'a' or $(x)",
          }),
        );
        expect(err.code).toBe('InvalidFilter');
        expect(rig.calls).toEqual([]);
      });
    });

    describe('input bounds', () => {
      const parse = (args: Record<string, unknown>): boolean =>
        z.object(GetMetricsInput).safeParse({ ...VM, metrics: ['Percentage CPU'], ...args }).success;

      it.each(['PT1M', 'PT1H', 'P1DT12H', 'P30D'])('accepts timespan %s', (timespan) => {
        expect(parse({ timespan })).toBe(true);
      });
      it.each(['P31D', 'PT0M', 'PT30S', 'P1M', 'P1Y', 'P1W', 'PT', 'P', '1h', 'P30DT1M'])(
        'rejects timespan %s',
        (timespan) => {
          expect(parse({ timespan })).toBe(false);
        },
      );
      it('defaults the timespan to PT1H', () => {
        expect(z.object(GetMetricsInput).parse({ ...VM, metrics: ['x'] }).timespan).toBe('PT1H');
      });
      it.each(['PT2M', 'PT1S', 'P2D', 'FULL'])('rejects interval %s', (interval) => {
        expect(parse({ interval })).toBe(false);
      });
      it.each([
        { metrics: [] },
        { metrics: Array.from({ length: 11 }, (_, i) => `m${i}`) },
        { metrics: ['a,b'] },
        { metrics: ["x' or 1"] },
        { top: 11 },
        { top: 0 },
        { aggregation: 'Median' },
      ])('rejects %j', (args) => {
        expect(parse(args)).toBe(false);
      });
    });

    it('turns an HTTP 400 into a hint, without Azure’s message', async () => {
      const fail = (): Error => Object.assign(createRestError(), { statusCode: 400, code: 'BadRequest' });
      const err = errorOf(await setup({ fail }).call('get_metrics', { ...VM, metrics: ['Nope'] }));
      expect(err.code).toBe('InvalidMetricsQuery');
      expect(err.message).toMatch(/list_metric_definitions/);
    });

    it('sanitises any other Azure error', async () => {
      const err = errorOf(
        await setup({ fail: createRestError }).call('get_metrics', { ...VM, metrics: ['x'] }),
      );
      expect(err.code).toBe('ResourceNotFound');
      expect(err.message).toMatch(/HTTP 404/);
    });

    it('reports an unknown resource with the resolver error, without calling Azure Monitor', async () => {
      const rig = setup();
      const err = errorOf(
        await rig.call('get_metrics', { ...VM, resourceGroup: 'rg-other', metrics: ['x'] }),
      );
      expect(err.code).toBe('ResourceNotFound');
      expect(rig.calls).toEqual([]);
    });

    it('asks for a login when the active context is logged out', async () => {
      const rig = setup();
      rig.azure.logout('prod');
      const err = errorOf(await rig.call('get_metrics', { ...VM, metrics: ['x'] }));
      expect(err.code).toBe('NotLoggedIn');
      expect(rig.calls).toEqual([]);
    });
  });
});
