import { z } from 'zod';

/** Azure resource group names: letters, digits, `_`, `-`, `.`, `(`, `)`, at most 90 characters. */
const RESOURCE_GROUP = z
  .string()
  .regex(/^[\w.()-]{1,90}$/u, 'resourceGroup must be a resource group NAME')
  .describe('Resource group name (not an ID).');

const RESOURCE_NAME = z
  .string()
  .regex(/^[\w.()-]{1,260}$/u, 'resource must be a resource NAME')
  .describe('Resource name (not an ID), e.g. vm-web-01.');

export const TIME_RANGES = ['1h', '1d', '7d', '30d'] as const;
export const SEVERITIES = ['Sev0', 'Sev1', 'Sev2', 'Sev3', 'Sev4'] as const;
export const ALERT_STATES = ['New', 'Acknowledged', 'Closed'] as const;
export const MONITOR_CONDITIONS = ['Fired', 'Resolved'] as const;
export const ACTIVITY_STATUSES = ['Started', 'Accepted', 'Succeeded', 'Failed', 'Canceled'] as const;

/** ISO 8601 duration with days, hours, minutes or seconds only (bounded server-side to 7 days). */
export const ACTIVITY_TIMESPAN = /^P(?:\d{1,3}D)?(?:T(?:\d{1,4}H)?(?:\d{1,5}M)?(?:\d{1,6}S)?)?$/u;

export const ListFiredAlertsInput = {
  timeRange: z.enum(TIME_RANGES).describe('How far back to look for fired alerts.'),
  severity: z.enum(SEVERITIES).optional().describe('Only alerts of this severity (Sev0 is the highest).'),
  state: z.enum(ALERT_STATES).optional().describe('Only alerts in this user-facing state.'),
  monitorCondition: z
    .enum(MONITOR_CONDITIONS)
    .optional()
    .describe('Fired: the condition still holds. Resolved: it cleared.'),
  resourceGroup: RESOURCE_GROUP.optional().describe('Only alerts on resources of this resource group.'),
};

export const GetAlertInput = {
  alertRef: z
    .string()
    .min(1)
    .max(64)
    .describe('The alertRef returned by list_fired_alerts (an opaque reference such as id-007).'),
};

export const ListAlertRulesInput = {
  resourceGroup: RESOURCE_GROUP.optional().describe('Only rules defined in this resource group.'),
};

export const GetActivityLogInput = {
  timespan: z
    .string()
    .regex(ACTIVITY_TIMESPAN, 'timespan must be an ISO 8601 duration such as PT1H, P1D or P7D')
    .describe('How far back to look, as an ISO 8601 duration ending now (e.g. PT1H, P1D). At most P7D.'),
  resourceGroup: RESOURCE_GROUP.optional().describe('Only events of this resource group.'),
  resource: RESOURCE_NAME.optional().describe(
    'Only events of this resource (by name; add resourceGroup if the name is ambiguous).',
  ),
  status: z.enum(ACTIVITY_STATUSES).optional().describe('Only events with this status.'),
};
