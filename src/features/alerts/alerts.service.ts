import type { Pseudonymizer } from '../../core/anonymizer/index.js';
import { azureClients, kqlString, type AzureAccess } from '../../core/azure/index.js';
import { AppError } from '../../core/errors/index.js';
import {
  eventStatus,
  eventTime,
  RULE_TYPES,
  toActivityEvent,
  toAlertDetails,
  toAlertRule,
  toAlertSummary,
  type ActivityEvent,
  type AlertDetails,
  type AlertRule,
  type AlertSummary,
} from './alerts.mapper.js';
import type {
  ACTIVITY_STATUSES,
  ALERT_STATES,
  MONITOR_CONDITIONS,
  SEVERITIES,
  TIME_RANGES,
} from './alerts.schemas.js';

export const MAX_FIRED_ALERTS = 200;
export const MAX_ALERT_RULES = 500;
export const MAX_ACTIVITY_EVENTS = 200;
/** Events read per subscription before giving up (a status filter can discard most of them). */
export const MAX_ACTIVITY_SCAN = 2000;
export const MAX_ACTIVITY_TIMESPAN_MS = 7 * 86_400_000;

/** Only fields we map: claims, httpRequest, authorization and properties are never fetched. */
const ACTIVITY_SELECT =
  'eventTimestamp,operationName,status,subStatus,caller,resourceId,resourceGroupName,level,correlationId';

/** Fixed KQL durations: the AI picks a key, never a string that reaches the query. */
const TIME_RANGE_KQL: Readonly<Record<(typeof TIME_RANGES)[number], string>> = {
  '1h': '1h',
  '1d': '1d',
  '7d': '7d',
  '30d': '30d',
};

/**
 * `/subscriptions/<guid>[/resourceGroups/<rg>[/providers/<ns>/<type>/<name>…]]/providers/
 * Microsoft.AlertsManagement/alerts/<guid>`. Anything else resolved from an alertRef is refused.
 */
const ALERT_ID =
  /^\/subscriptions\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\/[^/\s'"\\]+)*\/providers\/microsoft\.alertsmanagement\/alerts\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SUBSCRIPTION_OF = /^\/subscriptions\/([0-9a-f-]{36})\//i;

/** Subset of `MonitorClient` used here (read-only). Lets tests stub it. */
export interface ActivityLogClient {
  readonly activityLogs: {
    list(filter: string, options?: { select?: string }): AsyncIterable<unknown>;
  };
}

export function monitorClientKey(subscriptionId: string): string {
  return `monitor:${subscriptionId.toLowerCase()}`;
}

interface AlertRow {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly essentials?: unknown;
}

const alertRefOf = (p: Pseudonymizer, id: unknown): string =>
  // The ref is a pseudonym of the full alert ID; `get_alert` resolves it back server-side.
  p.pseudonym('id', typeof id === 'string' ? id : '');

// ---------------------------------------------------------------------------------------------

export interface ListFiredAlertsArgs {
  readonly timeRange: (typeof TIME_RANGES)[number];
  readonly severity?: (typeof SEVERITIES)[number] | undefined;
  readonly state?: (typeof ALERT_STATES)[number] | undefined;
  readonly monitorCondition?: (typeof MONITOR_CONDITIONS)[number] | undefined;
  readonly resourceGroup?: string | undefined;
}

export function firedAlertsQuery(args: ListFiredAlertsArgs): string {
  const filters = [
    `where type =~ 'microsoft.alertsmanagement/alerts'`,
    'extend essentials = properties.essentials',
    `where todatetime(essentials.startDateTime) >= ago(${TIME_RANGE_KQL[args.timeRange]})`,
  ];
  if (args.severity !== undefined)
    filters.push(`where tostring(essentials.severity) =~ ${kqlString(args.severity)}`);
  if (args.state !== undefined)
    filters.push(`where tostring(essentials.alertState) =~ ${kqlString(args.state)}`);
  if (args.monitorCondition !== undefined) {
    filters.push(`where tostring(essentials.monitorCondition) =~ ${kqlString(args.monitorCondition)}`);
  }
  if (args.resourceGroup !== undefined) {
    filters.push(`where tostring(essentials.targetResourceGroup) =~ ${kqlString(args.resourceGroup)}`);
  }
  return [
    'alertsmanagementresources',
    ...filters,
    'project id, name, essentials',
    'order by todatetime(essentials.startDateTime) desc',
  ].join('\n| ');
}

export async function listFiredAlerts(
  azure: AzureAccess,
  p: Pseudonymizer,
  args: ListFiredAlertsArgs,
): Promise<{ alerts: AlertSummary[]; truncated: boolean }> {
  const { rows, truncated } = await azure.resourceGraph.queryResult<AlertRow>(firedAlertsQuery(args), {
    maxRows: MAX_FIRED_ALERTS,
  });
  const alerts = rows
    .filter((r) => typeof r.id === 'string' && ALERT_ID.test(r.id))
    .map((r) => toAlertSummary(r.name, r.essentials, alertRefOf(p, r.id), p));
  return { alerts, truncated };
}

// ---------------------------------------------------------------------------------------------

export async function getAlert(
  azure: AzureAccess,
  p: Pseudonymizer,
  alertRef: string,
): Promise<AlertDetails> {
  const ref = alertRef.trim();
  const id = p.resolve(ref);
  // A forged ref (garbage, or the pseudonym of a subscription, tenant or other ID) stops here.
  if (id === undefined || !ALERT_ID.test(id)) {
    throw new AppError('InvalidAlertRef', 'Unknown alertRef. Use an alertRef returned by list_fired_alerts.');
  }
  const rows = await azure.resourceGraph.query<unknown>(
    [
      'alertsmanagementresources',
      `where type =~ 'microsoft.alertsmanagement/alerts' and id =~ ${kqlString(id)}`,
      'project id, name, properties',
      'take 1',
    ].join('\n| '),
    { maxRows: 1 },
  );
  const [row] = rows;
  if (row === undefined) {
    throw new AppError(
      'AlertNotFound',
      'This alert is not visible in the active context (switched context, or older than 30 days).',
    );
  }
  return toAlertDetails(row, ref, p);
}

// ---------------------------------------------------------------------------------------------

export async function listAlertRules(
  azure: AzureAccess,
  p: Pseudonymizer,
  args: { readonly resourceGroup?: string | undefined },
): Promise<{ rules: AlertRule[]; truncated: boolean }> {
  const types = Object.keys(RULE_TYPES).map(kqlString).join(', ');
  const query = [
    'resources',
    `where type in~ (${types})`,
    ...(args.resourceGroup === undefined ? [] : [`where resourceGroup =~ ${kqlString(args.resourceGroup)}`]),
    'project id, name, type, resourceGroup, properties',
    'order by resourceGroup asc, name asc',
  ].join('\n| ');
  const { rows, truncated } = await azure.resourceGraph.queryResult<unknown>(query, {
    maxRows: MAX_ALERT_RULES,
  });
  return { rules: rows.map((r) => toAlertRule(r, p)).filter((r) => r !== undefined), truncated };
}

// ---------------------------------------------------------------------------------------------

/** Parses an ISO 8601 duration made of days, hours, minutes and seconds. */
export function parseTimespan(input: string): number | undefined {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(input.trim().toUpperCase());
  if (m === null || /^P$|T$/.test(input.trim().toUpperCase())) return undefined;
  const [, d, h, min, s] = m;
  const n = (v: string | undefined): number => (v === undefined ? 0 : Number(v));
  return ((n(d) * 24 + n(h)) * 60 + n(min)) * 60_000 + n(s) * 1000;
}

/** OData string literal: single quotes doubled, control characters refused. */
export function odataString(value: string): string {
  // eslint-disable-next-line no-control-regex -- control characters are exactly what we reject.
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new AppError('InvalidInput', 'Names must not contain control characters.');
  }
  return `'${value.replace(/'/g, "''")}'`;
}

export interface GetActivityLogArgs {
  readonly timespan: string;
  readonly resourceGroup?: string | undefined;
  readonly resource?: string | undefined;
  readonly status?: (typeof ACTIVITY_STATUSES)[number] | undefined;
}

export interface ActivityLogResult {
  readonly timespan: string;
  readonly count: number;
  readonly truncated: boolean;
  readonly events: ActivityEvent[];
}

export async function getActivityLog(
  azure: AzureAccess,
  p: Pseudonymizer,
  args: GetActivityLogArgs,
  now: () => Date = () => new Date(),
): Promise<ActivityLogResult> {
  const ms = parseTimespan(args.timespan);
  if (ms === undefined) {
    throw new AppError('InvalidInput', 'timespan must be an ISO 8601 duration such as PT1H, P1D or P7D.');
  }
  if (ms <= 0) throw new AppError('InvalidInput', 'timespan must be greater than zero.');
  if (ms > MAX_ACTIVITY_TIMESPAN_MS) throw new AppError('InvalidInput', 'timespan must not exceed P7D.');

  const session = azure.session();
  let subscriptions = session.subscriptionIds();
  const end = now();
  const start = new Date(end.getTime() - ms);
  const filters = [`eventTimestamp ge '${start.toISOString()}'`, `eventTimestamp le '${end.toISOString()}'`];

  if (args.resource !== undefined) {
    const resourceId = await azure.resolver.resolve({
      name: args.resource,
      ...(args.resourceGroup === undefined ? {} : { resourceGroup: args.resourceGroup }),
    });
    const sub = SUBSCRIPTION_OF.exec(resourceId)?.[1]?.toLowerCase();
    subscriptions = subscriptions.filter((s) => s.toLowerCase() === sub);
    // The activity log accepts one scope filter: the resource URI covers its resource group.
    filters.push(`resourceUri eq ${odataString(resourceId)}`);
  } else if (args.resourceGroup !== undefined) {
    filters.push(`resourceGroupName eq ${odataString(args.resourceGroup)}`);
  }
  const filter = filters.join(' and ');
  const wanted = args.status?.toLowerCase();

  const events: unknown[] = [];
  let truncated = false;
  for (const subscriptionId of subscriptions) {
    const client = azure.clients.getClient<ActivityLogClient>(
      session,
      monitorClientKey(subscriptionId),
      azureClients.monitor(subscriptionId),
    );
    let scanned = 0;
    let kept = 0;
    for await (const event of client.activityLogs.list(filter, { select: ACTIVITY_SELECT })) {
      if (++scanned > MAX_ACTIVITY_SCAN || kept >= MAX_ACTIVITY_EVENTS) {
        truncated = true;
        break;
      }
      if (wanted !== undefined && eventStatus(event)?.toLowerCase() !== wanted) continue;
      events.push(event);
      kept++;
    }
  }

  const sorted = events
    .map((e) => ({ e, t: eventTime(e) ?? '' }))
    .sort((a, b) => (a.t < b.t ? 1 : a.t > b.t ? -1 : 0))
    .map(({ e }) => e);
  if (sorted.length > MAX_ACTIVITY_EVENTS) truncated = true;
  const mapped = sorted.slice(0, MAX_ACTIVITY_EVENTS).map((e) => toActivityEvent(e, p));
  return { timespan: args.timespan, count: mapped.length, truncated, events: mapped };
}
