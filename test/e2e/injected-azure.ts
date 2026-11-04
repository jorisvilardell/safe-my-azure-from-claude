import {
  ACTIVITY_LOG_EVENT,
  BIDI_INJECTION,
  FIRED_ALERT,
  FULLWIDTH_INJECTION,
  HIDDEN_EMAIL,
  HIDDEN_GUID,
  PLAIN_INJECTION,
  ROLE_INJECTION,
  SUBSCRIPTION_ID,
  TAG_INJECTION,
  TOOL_CALL_INJECTION,
  VM_ARM_ID,
  WORKSPACE_ID,
  ZERO_WIDTH_INJECTION,
} from '../fixtures/azure/index.js';
import type { FakeAzureAccess, FakeResource } from '../helpers/index.js';

/**
 * A fake Azure whose every free-text field carries a prompt-injection payload (issue #39): KQL
 * cells, tags, alert descriptions, activity log text, Advisor and Resource Health text, metric
 * descriptions and dimension values. Hidden identifiers are planted next to them, so the leak
 * checks prove that stripping happens before scrubbing.
 */

type Rec = Record<string, unknown>;

/** Tag key whose values the e2e anonymizer shows (`safeTagKeys`). */
export const SAFE_TAG_KEY = 'env';

/** Resolvable with the harness's generated arguments (`name` and `resourceGroup` = 'vm-web-01'). */
export const INJECTED_RESOURCE: FakeResource = {
  subscription: 'prod-app',
  resourceGroup: 'vm-web-01',
  name: 'vm-web-01',
  type: 'Microsoft.Compute/virtualMachines',
};

const rec = (v: unknown): Rec => v as Rec;

async function* iter<T>(items: readonly T[]): AsyncGenerator<T> {
  await Promise.resolve();
  yield* items;
}

const RESOURCE_ROW: Rec = {
  id: VM_ARM_ID,
  name: 'vm-web-01',
  type: 'microsoft.compute/virtualmachines',
  location: 'westeurope',
  resourceGroup: 'rg-app',
  subscriptionId: SUBSCRIPTION_ID,
  provisioningState: 'Succeeded',
  tags: { [SAFE_TAG_KEY]: ZERO_WIDTH_INJECTION, owner: HIDDEN_EMAIL },
  properties: { provisioningState: 'Succeeded', hardwareProfile: { vmSize: PLAIN_INJECTION } },
};

const WORKSPACE_ROW: Rec = {
  id: `/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/rg-app/providers/Microsoft.OperationalInsights/workspaces/vm-web-01`,
  name: 'vm-web-01',
  type: 'microsoft.operationalinsights/workspaces',
  resourceGroup: 'rg-app',
  subscriptionId: SUBSCRIPTION_ID,
  location: 'westeurope',
  customerId: WORKSPACE_ID,
};

const essentials = rec(rec(rec(FIRED_ALERT).properties).essentials);
const ALERT_ROW: Rec = {
  ...rec(FIRED_ALERT),
  // The alert rule name is free text too, and it is shown in list_fired_alerts.
  name: PLAIN_INJECTION,
  properties: {
    ...rec(rec(FIRED_ALERT).properties),
    essentials: { ...essentials, description: `${PLAIN_INJECTION} ${HIDDEN_GUID}` },
  },
};

const ADVISOR_ROW: Rec = {
  subscriptionId: SUBSCRIPTION_ID,
  category: 'HighAvailability',
  impact: 'High',
  problem: BIDI_INJECTION,
  solution: `${TAG_INJECTION} ${FULLWIDTH_INJECTION}`,
  resourceId: VM_ARM_ID,
  impactedField: 'Microsoft.Compute/virtualMachines',
  impactedValue: 'vm-web-01',
  lastUpdated: '2026-11-02T06:00:00Z',
};

const ACTIVITY_EVENT: Rec = {
  ...rec(ACTIVITY_LOG_EVENT),
  eventTimestamp: new Date(),
  operationName: {
    value: 'Microsoft.Compute/virtualMachines/restart/action',
    localizedValue: ROLE_INJECTION,
  },
};

const LOG_TABLE = {
  name: 'PrimaryResult',
  columnDescriptors: [
    { name: 'TimeGenerated', type: 'datetime' },
    { name: 'Message', type: 'string' },
    { name: 'Properties', type: 'dynamic' },
  ],
  rows: [
    [new Date('2026-11-03T08:00:00Z'), PLAIN_INJECTION, { note: ZERO_WIDTH_INJECTION }],
    [new Date('2026-11-03T08:01:00Z'), `user ${HIDDEN_EMAIL}\n${ROLE_INJECTION}`, { tag: TAG_INJECTION }],
    [new Date('2026-11-03T08:02:00Z'), TOOL_CALL_INJECTION, null],
  ],
};

const METRICS = {
  interval: 'PT1M',
  value: [
    {
      name: { value: 'Inbound Flows', localizedValue: 'Inbound Flows' },
      unit: 'Count',
      timeseries: [
        {
          metadatavalues: [{ name: { value: 'RemoteIP' }, value: BIDI_INJECTION }],
          data: [{ timeStamp: '2026-11-03T08:00:00Z', total: 1 }],
        },
      ],
    },
  ],
};

const METRIC_DEFINITION = {
  name: { value: 'Percentage CPU', localizedValue: FULLWIDTH_INJECTION },
  displayDescription: `${PLAIN_INJECTION} ${HIDDEN_EMAIL}`,
  unit: 'Percent',
  primaryAggregationType: 'Average',
  supportedAggregationTypes: ['Average'],
  dimensions: [],
  metricAvailabilities: [{ timeGrain: 'PT1M' }],
};

const HEALTH_STATUS = {
  id: `${VM_ARM_ID}/providers/Microsoft.ResourceHealth/availabilityStatuses/current`,
  properties: {
    availabilityState: 'Unavailable',
    summary: `<p>${ZERO_WIDTH_INJECTION}</p> ${HIDDEN_EMAIL}`,
    occuredTime: new Date('2026-11-04T10:00:00Z'),
    recommendedActions: [{ action: PLAIN_INJECTION }],
  },
};

const SERVICE_EVENT = {
  id: `/subscriptions/${SUBSCRIPTION_ID}/providers/Microsoft.ResourceHealth/events/ZZ00-AAA`,
  name: 'ZZ00-AAA',
  eventType: 'ServiceIssue',
  status: 'Active',
  level: 'Warning',
  title: ROLE_INJECTION,
  summary: `<p>${PLAIN_INJECTION}</p>`,
  impactStartTime: new Date(),
  lastUpdateTime: new Date(),
  impact: [{ impactedService: 'Virtual Machines', impactedRegions: [{ impactedRegion: 'West Europe' }] }],
};

/** Plants the payloads in `azure` (Resource Graph rows and every SDK client the features use). */
export function plantInjections(azure: FakeAzureAccess): void {
  azure.setResourceGraphRows(({ query }) => {
    const q = query.toLowerCase();
    if (q.includes('advisorresources')) return [ADVISOR_ROW];
    if (q.includes('alertsmanagementresources')) return [ALERT_ROW];
    if (q.includes('operationalinsights') || q.includes('microsoft.insights/components')) {
      return [WORKSPACE_ROW];
    }
    return [RESOURCE_ROW];
  });
  const success = () => Promise.resolve({ status: 'Success', tables: [LOG_TABLE] });
  azure.stubClient('logs-query', { queryWorkspace: success, queryResource: success });
  azure.stubClient('monitor-metrics', {
    metrics: { list: () => Promise.resolve(METRICS) },
    metricDefinitions: { list: () => iter([METRIC_DEFINITION]) },
  });
  azure.stubClient(/^monitor:/, { activityLogs: { list: () => iter([ACTIVITY_EVENT]) } });
  azure.stubClient(/^resourcehealth:/, {
    availabilityStatuses: {
      getByResource: () => Promise.resolve(HEALTH_STATUS),
      list: () => iter([HEALTH_STATUS]),
    },
    events: { listBySubscriptionId: () => iter([SERVICE_EVENT]) },
  });
}
