import type { AvailabilityStatus, Event } from '@azure/arm-resourcehealth';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  CALLER_EMAIL,
  CORRELATION_ID,
  OWNER_EMAIL,
  PUBLIC_IP_CLIENT,
  SUBSCRIPTION_ID,
  TENANT_ID,
  VM_ARM_ID,
  createRestError,
} from '../../../../test/fixtures/azure/index.js';
import {
  createFakeAzureAccess,
  createTestToolContext,
  expectNoLeak,
  parseToolText,
  toolText,
  type FakeAzureAccess,
} from '../../../../test/helpers/index.js';
import { executeTool, type ToolContext, type ToolDefinition } from '../../../core/mcp/index.js';
import { createHealthFeature } from '../index.js';
import {
  GetResourceHealthInput,
  ListAdvisorRecommendationsInput,
  ListServiceHealthEventsInput,
} from '../health.schemas.js';
import { resourceHealthClientKey, type ResourceHealthClient } from '../health.service.js';

const NOW = Date.parse('2026-11-04T12:00:00Z');
const SUB_APP = SUBSCRIPTION_ID;
const SUB_NET = '00000000-0000-0000-0000-000000000002';
/** Service Health tracking IDs are short codes, not GUIDs: the scrubber alone would not catch them. */
const TRACKING_ID = 'ZZ00-FAK';
const TRACKING_ID_2 = 'ZZ11-FAK';
const LONG = 'x'.repeat(3000);
const HIDDEN = 'hid​den‮text\u{E0041}';

function iter<T>(items: readonly T[]): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const item of items) {
        await Promise.resolve();
        yield item;
      }
    },
  };
}

type Call = (name: string, args?: Record<string, unknown>) => Promise<{ text: string; json: unknown }>;

function setup(azure: FakeAzureAccess = createFakeAzureAccess()): { call: Call; ctx: ToolContext } {
  const feature = createHealthFeature({ now: () => NOW });
  const ctx = createTestToolContext({ azure });
  const call: Call = async (name, args = {}) => {
    const tool: ToolDefinition | undefined = feature.tools.find((t) => t.name === name);
    if (tool === undefined) throw new Error(`missing tool ${name}`);
    const result = await executeTool(tool, args, ctx);
    const text = toolText(result);
    expectNoLeak(text);
    // Every fake tracking ID in this file is `ZZnn-XXX`.
    expect(text).not.toMatch(/ZZ\d\d-[A-Z]{3}/);
    return { text, json: parseToolText(result) };
  };
  return { call, ctx };
}

function healthClient(overrides: Partial<ResourceHealthClient> = {}): ResourceHealthClient {
  return {
    availabilityStatuses: {
      getByResource: () => Promise.reject(new Error('not stubbed')),
      list: () => iter([]),
    },
    events: { listBySubscriptionId: () => iter([]) },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------------------------

const CURRENT: AvailabilityStatus = {
  id: `${VM_ARM_ID}/providers/Microsoft.ResourceHealth/availabilityStatuses/current`,
  name: 'current',
  type: 'Microsoft.ResourceHealth/AvailabilityStatuses',
  location: 'westeurope',
  properties: {
    availabilityState: 'Unavailable',
    title: 'Unavailable',
    summary:
      `<p>We're sorry, your virtual machine ${VM_ARM_ID} is unavailable.</p> ` +
      `Contact ${OWNER_EMAIL} from ${PUBLIC_IP_CLIENT}, tenant ${TENANT_ID}. ${HIDDEN} ${LONG}`,
    reasonType: 'Unplanned',
    reasonChronicity: 'Persistent',
    healthEventId: CORRELATION_ID,
    occuredTime: new Date('2026-11-04T10:00:00Z'),
    reportedTime: new Date('2026-11-04T10:05:00Z'),
    recommendedActions: [
      {
        action: 'Check <action>Azure Service Health</action> for platform issues',
        actionUrl: `https://portal.azure.com/#resource${VM_ARM_ID}/serviceHealth`,
        actionUrlText: 'Azure Service Health',
      },
      { action: `Redeploy, or email ${CALLER_EMAIL}`, actionUrl: `https://example.com/?sub=${SUB_APP}` },
    ],
    serviceImpactingEvents: [{ correlationId: CORRELATION_ID }],
  },
};

const HISTORY: AvailabilityStatus[] = Array.from({ length: 25 }, (_, i) => ({
  id: `${VM_ARM_ID}/providers/Microsoft.ResourceHealth/availabilityStatuses/${String(i)}`,
  properties: {
    availabilityState: i % 2 === 0 ? 'Unavailable' : 'Available',
    occuredTime: new Date(Date.parse('2026-11-04T10:00:00Z') - i * 3_600_000),
    summary: `transition ${String(i)} on ${VM_ARM_ID}`,
  },
}));

describe('get_resource_health', () => {
  function stubbed(): { call: Call; calls: { uri: string; expand: string | undefined }[] } {
    const azure = createFakeAzureAccess();
    const calls: { uri: string; expand: string | undefined }[] = [];
    azure.stubClient(
      resourceHealthClientKey(SUB_APP),
      healthClient({
        availabilityStatuses: {
          getByResource: (uri, options) => {
            calls.push({ uri, expand: options?.expand });
            return Promise.resolve(CURRENT);
          },
          list: () => iter(HISTORY),
        },
      }),
    );
    return { ...setup(azure), calls };
  }

  it('returns the current state, capped text, actions and history, without leaking', async () => {
    const { call, calls } = stubbed();
    const { json, text } = await call('get_resource_health', {
      resourceGroup: 'rg-app',
      name: 'vm-web-01',
      subscription: 'prod-app',
    });
    expect(calls).toEqual([{ uri: VM_ARM_ID.slice(1), expand: 'recommendedactions' }]);

    const dto = z
      .object({
        resource: z.string(),
        availabilityState: z.string(),
        summary: z.string(),
        reasonType: z.string(),
        reasonChronicity: z.string(),
        occurredTime: z.string(),
        reportedTime: z.string(),
        recommendedActions: z.array(z.string()),
        history: z.array(z.object({ state: z.string(), time: z.string(), summary: z.string() })),
        historyTruncated: z.boolean(),
      })
      .strict()
      .parse(json);

    expect(dto.resource).toBe('rg-app/Microsoft.Compute/virtualMachines/vm-web-01');
    expect(dto.availabilityState).toBe('Unavailable');
    expect(dto.reasonType).toBe('Unplanned');
    expect(dto.reasonChronicity).toBe('Persistent');
    expect(dto.occurredTime).toBe('2026-11-04T10:00:00.000Z');
    expect(dto.summary.startsWith("We're sorry, your virtual machine rg-app/")).toBe(true);
    expect(dto.summary).not.toMatch(/<\/?p>/);
    expect(dto.summary).toContain('hiddentext');
    expect(Array.from(dto.summary).length).toBeLessThanOrEqual(512);
    expect(dto.summary.endsWith('…')).toBe(true);
    expect(dto.recommendedActions[0]).toBe('Check Azure Service Health for platform issues');
    expect(dto.recommendedActions[1]).toMatch(/^Redeploy, or email user-\d{3}$/);
    expect(dto.history).toHaveLength(20);
    expect(dto.historyTruncated).toBe(true);
    expect(dto.history[0]).toEqual({
      state: 'Unavailable',
      time: '2026-11-04T10:00:00.000Z',
      summary: 'transition 0 on rg-app/virtualMachines/vm-web-01',
    });
    // Action URLs are never returned, whatever they contain.
    expect(text).not.toContain('portal.azure.com');
    expect(text).not.toContain('example.com');
  });

  it('accepts a short type and reports an unknown resource', async () => {
    const { call } = stubbed();
    const ok = await call('get_resource_health', {
      resourceGroup: 'rg-app',
      name: 'vm-web-01',
      type: 'Microsoft.Compute/virtualMachines',
    });
    expect(ok.json).toMatchObject({ availabilityState: 'Unavailable' });

    const missing = await call('get_resource_health', { resourceGroup: 'rg-app', name: 'vm-nope' });
    expect(missing.json).toMatchObject({ code: 'ResourceNotFound' });
  });

  it('turns a 404 into an AI-friendly error, without leaking the SDK message', async () => {
    const azure = createFakeAzureAccess();
    azure.stubClient(
      /^resourcehealth:/,
      healthClient({
        availabilityStatuses: {
          getByResource: () => Promise.reject(createRestError()),
          list: () => iter([]),
        },
      }),
    );
    const { call } = setup(azure);
    const { json } = await call('get_resource_health', { resourceGroup: 'rg-app', name: 'app-api' });
    expect(json).toMatchObject({ code: 'ResourceHealthUnavailable' });
  });

  it('validates its input', () => {
    const schema = z.object(GetResourceHealthInput);
    expect(schema.safeParse({ resourceGroup: 'rg-app', name: 'vm-web-01' }).success).toBe(true);
    expect(schema.safeParse({ name: 'vm-web-01' }).success).toBe(false);
    expect(schema.safeParse({ resourceGroup: 'rg-app', name: VM_ARM_ID }).success).toBe(false);
    expect(schema.safeParse({ resourceGroup: 'rg/../x', name: 'vm' }).success).toBe(false);
    expect(schema.safeParse({ resourceGroup: 'rg-app', name: 'vm', subscription: 'Prod App' }).success).toBe(
      false,
    );
    expect(schema.safeParse({ resourceGroup: 'rg-app', name: 'vm', type: "x' or 1" }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------

function serviceEvent(overrides: Partial<Event>): Event {
  const trackingId = overrides.name ?? TRACKING_ID;
  return {
    id: `/subscriptions/${SUB_APP}/providers/Microsoft.ResourceHealth/events/${trackingId}`,
    name: trackingId,
    type: '/providers/Microsoft.ResourceHealth/events',
    eventType: 'ServiceIssue',
    status: 'Active',
    level: 'Warning',
    title: `Virtual Machines - West Europe - Mitigated (Tracking ID ${trackingId})`,
    summary:
      `<p><strong>Impact Statement:</strong> Starting at 08:00 UTC, customers may see failures. ` +
      `<a href="https://app.azure.com/h/${trackingId}/${SUB_APP}">Details</a> ` +
      `Contact ${OWNER_EMAIL} &amp; see ${VM_ARM_ID}.</p>${LONG}`,
    impactStartTime: new Date('2026-11-04T08:00:00Z'),
    lastUpdateTime: new Date('2026-11-04T09:00:00Z'),
    impact: [
      {
        impactedService: 'Virtual Machines',
        impactedServiceGuid: CORRELATION_ID,
        impactedRegions: [
          { impactedRegion: 'West Europe', impactedSubscriptions: [SUB_APP], impactedTenants: [TENANT_ID] },
          { impactedRegion: 'West Europe' },
          { impactedRegion: 'North Europe' },
        ],
      },
    ],
    links: [{ type: 'Button', parameters: { trackingId, subscriptionId: SUB_APP } }],
    ...overrides,
  };
}

describe('list_service_health_events', () => {
  function stubbed(events: Record<string, readonly Event[]>): {
    call: Call;
    queries: { sub: string; queryStartTime: string | undefined }[];
  } {
    const azure = createFakeAzureAccess();
    const queries: { sub: string; queryStartTime: string | undefined }[] = [];
    for (const sub of [SUB_APP, SUB_NET]) {
      azure.stubClient(
        resourceHealthClientKey(sub),
        healthClient({
          events: {
            listBySubscriptionId: (options) => {
              queries.push({ sub, queryStartTime: options?.queryStartTime });
              return iter(events[sub] ?? []);
            },
          },
        }),
      );
    }
    return { ...setup(azure), queries };
  }

  const ResultSchema = z
    .object({
      timeRange: z.string(),
      truncated: z.boolean(),
      events: z.array(
        z
          .object({
            eventRef: z.string(),
            title: z.string(),
            eventType: z.string(),
            status: z.string(),
            level: z.string(),
            impact: z.array(z.object({ service: z.string(), regions: z.array(z.string()) })),
            subscriptions: z.array(z.string()),
            impactStartTime: z.string(),
            lastUpdateTime: z.string(),
            summary: z.string(),
          })
          .strict(),
      ),
    })
    .strict();

  it('merges events across subscriptions and pseudonymises the tracking ID', async () => {
    const { call, queries } = stubbed({
      [SUB_APP]: [serviceEvent({})],
      [SUB_NET]: [
        serviceEvent({ lastUpdateTime: new Date('2026-11-04T09:30:00Z'), status: 'Resolved' }),
        serviceEvent({
          name: TRACKING_ID_2,
          eventType: 'PlannedMaintenance',
          title: 'Planned maintenance',
          lastUpdateTime: new Date('2026-11-03T09:00:00Z'),
        }),
      ],
    });
    const { json } = await call('list_service_health_events', {});
    expect(queries.map((q) => q.queryStartTime)).toEqual(['10/28/2026', '10/28/2026']);

    const result = ResultSchema.parse(json);
    expect(result.timeRange).toBe('7d');
    expect(result.truncated).toBe(false);
    expect(result.events).toHaveLength(2);
    const [first, second] = result.events;
    expect(first?.eventRef).toMatch(/^id-\d{3}$/);
    expect(first?.title).toBe(
      `Virtual Machines - West Europe - Mitigated (Tracking ID ${first?.eventRef ?? ''})`,
    );
    expect(first?.subscriptions).toEqual(['prod-app', 'prod-network']);
    // The latest update wins.
    expect(first?.status).toBe('Resolved');
    expect(first?.impact).toEqual([
      { service: 'Virtual Machines', regions: ['West Europe', 'North Europe'] },
    ]);
    expect(first?.summary.startsWith('Impact Statement: Starting at 08:00 UTC')).toBe(true);
    expect(first?.summary).toContain('& see rg-app/');
    expect(first?.summary).not.toContain('href');
    expect(Array.from(first?.summary ?? '').length).toBeLessThanOrEqual(512);
    expect(second?.eventType).toBe('PlannedMaintenance');
    expect(second?.eventRef).not.toBe(first?.eventRef);
  });

  it('filters by time range, type and status', async () => {
    const events = [
      serviceEvent({}),
      serviceEvent({ name: TRACKING_ID_2, eventType: 'HealthAdvisory', status: 'Resolved' }),
      serviceEvent({ name: 'ZZ22-FAK', lastUpdateTime: new Date('2026-11-01T00:00:00Z') }),
      serviceEvent({ name: 'ZZ33-FAK', eventType: 'Billing' }),
    ];
    const { call, queries } = stubbed({ [SUB_APP]: events });

    const day = ResultSchema.parse((await call('list_service_health_events', { timeRange: '1d' })).json);
    expect(queries.at(-1)?.queryStartTime).toBe('11/3/2026');
    expect(day.events.map((e) => e.eventType)).toEqual(['ServiceIssue', 'HealthAdvisory']);

    const month = ResultSchema.parse((await call('list_service_health_events', { timeRange: '30d' })).json);
    expect(month.events).toHaveLength(3);

    const advisories = ResultSchema.parse(
      (await call('list_service_health_events', { eventType: 'HealthAdvisory' })).json,
    );
    expect(advisories.events.map((e) => e.eventType)).toEqual(['HealthAdvisory']);

    const active = ResultSchema.parse((await call('list_service_health_events', { status: 'Active' })).json);
    expect(active.events.every((e) => e.status === 'Active')).toBe(true);
    expect(active.events).toHaveLength(2);
  });

  it('caps the number of events', async () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      serviceEvent({ name: `ZZ${String(i).padStart(2, '0')}-MNY` }),
    );
    const { call } = stubbed({ [SUB_APP]: many });
    const result = ResultSchema.parse((await call('list_service_health_events', {})).json);
    expect(result.events).toHaveLength(50);
    expect(result.truncated).toBe(true);
  });

  it('validates its input', () => {
    const schema = z.object(ListServiceHealthEventsInput);
    expect(schema.safeParse({}).success).toBe(true);
    expect(schema.safeParse({ timeRange: '90d' }).success).toBe(false);
    expect(schema.safeParse({ eventType: 'Billing' }).success).toBe(false);
    expect(schema.safeParse({ status: 'Open' }).success).toBe(false);
  });

  it('reports a logged-out context without leaking', async () => {
    const azure = createFakeAzureAccess({ loggedIn: [] });
    const { call } = setup(azure);
    const { json } = await call('list_service_health_events', {});
    expect(json).toMatchObject({ code: 'NotLoggedIn' });
  });
});

// ---------------------------------------------------------------------------------------------

function advisorRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    subscriptionId: SUB_APP,
    category: 'HighAvailability',
    impact: 'High',
    problem: `Enable backups for ${VM_ARM_ID} (owner ${OWNER_EMAIL}, ip ${PUBLIC_IP_CLIENT})`,
    solution: `${HIDDEN} ${'word '.repeat(600)}`,
    resourceId: VM_ARM_ID,
    impactedField: 'Microsoft.Compute/virtualMachines',
    impactedValue: 'vm-web-01',
    lastUpdated: '2026-11-02T06:00:00Z',
    ...overrides,
  };
}

describe('list_advisor_recommendations', () => {
  const ResultSchema = z
    .object({
      truncated: z.boolean(),
      recommendations: z.array(
        z
          .object({
            category: z.string(),
            impact: z.string(),
            problem: z.string(),
            solution: z.string(),
            subscription: z.string().nullable(),
            target: z.string(),
            lastUpdated: z.string().nullable(),
          })
          .strict(),
      ),
    })
    .strict();

  it('maps recommendations to names only, with capped text', async () => {
    const azure = createFakeAzureAccess({
      resourceGraphRows: [
        advisorRow(),
        advisorRow({
          subscriptionId: SUB_NET,
          category: 'Security',
          impact: 'Medium',
          resourceId: `/subscriptions/${SUB_NET}`,
          impactedField: 'Microsoft.Subscriptions/subscriptions',
          impactedValue: SUB_NET,
          lastUpdated: null,
        }),
        advisorRow({ resourceId: `/subscriptions/${SUB_APP}/resourceGroups/rg-app` }),
        { not: 'a recommendation', category: 42 },
      ],
    });
    const { call } = setup(azure);
    const result = ResultSchema.parse((await call('list_advisor_recommendations', {})).json);
    expect(result.truncated).toBe(false);
    expect(result.recommendations).toHaveLength(3);
    const [vm, sub, rg] = result.recommendations;
    expect(vm).toMatchObject({
      category: 'HighAvailability',
      impact: 'High',
      subscription: 'prod-app',
      target: 'rg-app/Microsoft.Compute/virtualMachines/vm-web-01',
      lastUpdated: '2026-11-02T06:00:00.000Z',
    });
    expect(vm?.problem).toMatch(/^Enable backups for rg-app\/virtualMachines\/vm-web-01 \(owner user-\d{3}/);
    expect(vm?.solution.startsWith('hiddentext word')).toBe(true);
    expect(vm?.solution.endsWith('word…')).toBe(true);
    expect(Array.from(vm?.solution ?? '').length).toBeLessThanOrEqual(512);
    expect(sub).toMatchObject({ subscription: 'prod-network', target: '(subscription)', lastUpdated: null });
    expect(rg?.target).toBe('rg-app');
  });

  it('builds a filtered, read-only Resource Graph query and honours limit', async () => {
    const azure = createFakeAzureAccess({
      resourceGraphRows: Array.from({ length: 10 }, () => advisorRow()),
    });
    const { call } = setup(azure);
    const result = ResultSchema.parse(
      (
        await call('list_advisor_recommendations', {
          category: 'Cost',
          impact: 'Low',
          resourceGroup: 'rg-app',
          limit: 3,
        })
      ).json,
    );
    expect(result.recommendations).toHaveLength(3);
    expect(result.truncated).toBe(true);
    const query = azure.resourceGraphQueries.at(-1)?.query ?? '';
    expect(query.startsWith('advisorresources')).toBe(true);
    expect(query).toContain(`properties.category =~ 'Cost'`);
    expect(query).toContain(`properties.impact =~ 'Low'`);
    expect(query).toContain(`resourceGroup =~ 'rg-app'`);
    expect(azure.resourceGraphQueries.at(-1)?.subscriptions).toEqual([SUB_APP, SUB_NET]);
  });

  it('validates its input', () => {
    const schema = z.object(ListAdvisorRecommendationsInput);
    expect(schema.safeParse({}).success).toBe(true);
    expect(schema.safeParse({ category: 'Reliability' }).success).toBe(false);
    expect(schema.safeParse({ impact: 'Critical' }).success).toBe(false);
    expect(schema.safeParse({ limit: 101 }).success).toBe(false);
    expect(schema.safeParse({ limit: 0 }).success).toBe(false);
    expect(schema.safeParse({ resourceGroup: 'rg app' }).success).toBe(false);
  });
});
