import { MicrosoftResourceHealth, type AvailabilityStatus, type Event } from '@azure/arm-resourcehealth';
import type { Pseudonymizer } from '../../core/anonymizer/index.js';
import { kqlString, type AzureAccess, type AzureSession } from '../../core/azure/index.js';
import { AppError } from '../../core/errors/index.js';
import {
  AdvisorRow,
  MAX_HISTORY,
  parseArmId,
  toAdvisorDto,
  toResourceHealthDto,
  toServiceHealthEventDto,
  type AdvisorRecommendationDto,
  type ResourceHealthDto,
  type ServiceHealthEventDto,
} from './health.mapper.js';
import {
  DEFAULT_ADVISOR_LIMIT,
  EVENT_TYPES,
  MAX_ADVISOR_LIMIT,
  type ADVISOR_CATEGORIES,
  type ADVISOR_IMPACTS,
  type EVENT_STATUSES,
  type TIME_RANGES,
} from './health.schemas.js';

export interface HealthDeps {
  /** Clock for the service-health time window. Defaults to `Date.now`. */
  readonly now?: () => number;
}

/** The read-only subset of `MicrosoftResourceHealth` we call (AGENTS.md R2). Lets tests stub it. */
export interface ResourceHealthClient {
  readonly availabilityStatuses: {
    getByResource(resourceUri: string, options?: { expand?: string }): Promise<AvailabilityStatus>;
    list(resourceUri: string): AsyncIterable<AvailabilityStatus>;
  };
  readonly events: {
    listBySubscriptionId(options?: { queryStartTime?: string }): AsyncIterable<Event>;
  };
}

/** `ClientFactory` key: one Resource Health client per subscription. */
export const resourceHealthClientKey = (subscriptionId: string): string => `resourcehealth:${subscriptionId}`;

/** Events read per subscription before we stop paging. */
export const MAX_EVENTS_PER_SUBSCRIPTION = 200;
/** Events returned to the AI. */
export const MAX_EVENTS = 50;

const DAY_MS = 86_400_000;
const RANGE_DAYS: Readonly<Record<(typeof TIME_RANGES)[number], number>> = { '1d': 1, '7d': 7, '30d': 30 };

function resourceHealthClient(
  azure: AzureAccess,
  session: AzureSession,
  subscriptionId: string,
): ResourceHealthClient {
  return azure.clients.getClient(
    session,
    resourceHealthClientKey(subscriptionId),
    (credential) => new MicrosoftResourceHealth(credential, subscriptionId),
  );
}

/** Real subscription ID (lowercased) → alias, for the active context. Server-side only. */
function subscriptionAliases(azure: AzureAccess, session: AzureSession): ReadonlyMap<string, string> {
  const aliases = azure.contexts.list().find((c) => c.alias === session.contextAlias)?.subscriptions ?? [];
  return new Map(aliases.map((alias) => [session.subscriptionId(alias).toLowerCase(), alias]));
}

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { statusCode?: unknown }).statusCode === 404;
}

// ---------------------------------------------------------------------------------------------

export interface ResourceHealthInput {
  readonly resourceGroup: string;
  readonly name: string;
  readonly type?: string | undefined;
  readonly subscription?: string | undefined;
}

export async function getResourceHealth(
  azure: AzureAccess,
  input: ResourceHealthInput,
): Promise<ResourceHealthDto> {
  const armId = await azure.resolver.resolve({
    name: input.name,
    resourceGroup: input.resourceGroup,
    ...(input.type === undefined ? {} : { type: input.type }),
    ...(input.subscription === undefined ? {} : { subscription: input.subscription }),
  });
  const parsed = parseArmId(armId);
  if (parsed === undefined) {
    throw new AppError('UnexpectedResponse', `Resource "${input.name}" has an unexpected ID shape.`);
  }
  const session = azure.session();
  const client = resourceHealthClient(azure, session, parsed.subscriptionId);
  // The SDK URL template is `/{+resourceUri}/providers/...`: pass the ID without its leading slash.
  const resourceUri = armId.replace(/^\/+/, '');

  let current: AvailabilityStatus;
  try {
    current = await client.availabilityStatuses.getByResource(resourceUri, { expand: 'recommendedactions' });
  } catch (err) {
    if (isNotFound(err)) {
      throw new AppError(
        'ResourceHealthUnavailable',
        `Resource Health has no status for "${input.name}". Its resource type may not support Resource Health.`,
      );
    }
    throw err;
  }

  const history: AvailabilityStatus[] = [];
  let historyTruncated = false;
  for await (const status of client.availabilityStatuses.list(resourceUri)) {
    if (history.length >= MAX_HISTORY) {
      historyTruncated = true;
      break;
    }
    history.push(status);
  }

  return toResourceHealthDto(parsed.target, current, history, historyTruncated);
}

// ---------------------------------------------------------------------------------------------

export interface ServiceHealthInput {
  readonly timeRange?: (typeof TIME_RANGES)[number] | undefined;
  readonly eventType?: (typeof EVENT_TYPES)[number] | undefined;
  readonly status?: (typeof EVENT_STATUSES)[number] | undefined;
}

export interface ServiceHealthResult {
  readonly timeRange: string;
  readonly events: readonly ServiceHealthEventDto[];
  readonly truncated: boolean;
}

/** `queryStartTime` as the API documents it: `M/D/YYYY` (UTC). */
function queryStartTime(start: Date): string {
  return `${start.getUTCMonth() + 1}/${start.getUTCDate()}/${start.getUTCFullYear()}`;
}

const time = (d: Date | undefined): number => (d instanceof Date ? d.getTime() : Number.NaN);

interface Collected {
  event: Event;
  trackingId: string;
  subscriptions: string[];
}

export async function listServiceHealthEvents(
  azure: AzureAccess,
  pseudonymizer: Pseudonymizer,
  input: ServiceHealthInput,
  deps: HealthDeps = {},
): Promise<ServiceHealthResult> {
  const range = input.timeRange ?? '7d';
  const session = azure.session();
  const aliases = subscriptionAliases(azure, session);
  const start = new Date((deps.now ?? Date.now)() - RANGE_DAYS[range] * DAY_MS);
  const types: readonly string[] = input.eventType === undefined ? EVENT_TYPES : [input.eventType];

  let truncated = false;
  const perSubscription = await Promise.all(
    session.subscriptionIds().map(async (subscriptionId) => {
      const client = resourceHealthClient(azure, session, subscriptionId);
      const events: Event[] = [];
      for await (const event of client.events.listBySubscriptionId({
        queryStartTime: queryStartTime(start),
      })) {
        if (events.length >= MAX_EVENTS_PER_SUBSCRIPTION) {
          truncated = true;
          break;
        }
        events.push(event);
      }
      return { alias: aliases.get(subscriptionId.toLowerCase()) ?? 'unknown', events };
    }),
  );

  // The same event is reported once per impacted subscription: merge by tracking ID.
  const byTrackingId = new Map<string, Collected>();
  let anonymous = 0;
  for (const { alias, events } of perSubscription) {
    for (const event of events) {
      if (event.eventType === undefined || !types.includes(event.eventType)) continue;
      if (input.status !== undefined && event.status !== input.status) continue;
      const updated = time(event.lastUpdateTime);
      if (!Number.isNaN(updated) && updated < start.getTime()) continue;

      const trackingId = event.name ?? '';
      const key = trackingId === '' ? `\u0000${String(anonymous++)}` : trackingId.toLowerCase();
      const seen = byTrackingId.get(key);
      if (seen === undefined) {
        byTrackingId.set(key, { event, trackingId, subscriptions: [alias] });
        continue;
      }
      if (!seen.subscriptions.includes(alias)) seen.subscriptions.push(alias);
      if (time(event.lastUpdateTime) > time(seen.event.lastUpdateTime)) seen.event = event;
    }
  }

  const sorted = [...byTrackingId.values()].sort(
    (a, b) => (time(b.event.lastUpdateTime) || 0) - (time(a.event.lastUpdateTime) || 0),
  );
  if (sorted.length > MAX_EVENTS) truncated = true;

  return {
    timeRange: range,
    events: sorted.slice(0, MAX_EVENTS).map((c) => {
      // Tracking IDs are not GUIDs, so the scrubber would not catch them: pseudonymise here.
      const eventRef = c.trackingId === '' ? 'unknown' : pseudonymizer.pseudonym('id', c.trackingId);
      return toServiceHealthEventDto(c.event, c.trackingId, eventRef, c.subscriptions);
    }),
    truncated,
  };
}

// ---------------------------------------------------------------------------------------------

export interface AdvisorInput {
  readonly category?: (typeof ADVISOR_CATEGORIES)[number] | undefined;
  readonly impact?: (typeof ADVISOR_IMPACTS)[number] | undefined;
  readonly resourceGroup?: string | undefined;
  readonly limit?: number | undefined;
}

export interface AdvisorResult {
  readonly recommendations: readonly AdvisorRecommendationDto[];
  readonly truncated: boolean;
}

export function buildAdvisorQuery(input: AdvisorInput): string {
  const filters = [`type =~ 'microsoft.advisor/recommendations'`];
  if (input.category !== undefined) filters.push(`properties.category =~ ${kqlString(input.category)}`);
  if (input.impact !== undefined) filters.push(`properties.impact =~ ${kqlString(input.impact)}`);
  if (input.resourceGroup !== undefined) filters.push(`resourceGroup =~ ${kqlString(input.resourceGroup)}`);
  return [
    'advisorresources',
    `where ${filters.join(' and ')}`,
    'extend impactRank = case(properties.impact =~ "High", 0, properties.impact =~ "Medium", 1, 2)',
    'order by impactRank asc, tostring(properties.lastUpdated) desc',
    [
      'project subscriptionId',
      'category = tostring(properties.category)',
      'impact = tostring(properties.impact)',
      'problem = tostring(properties.shortDescription.problem)',
      'solution = tostring(properties.shortDescription.solution)',
      'resourceId = tostring(properties.resourceMetadata.resourceId)',
      'impactedField = tostring(properties.impactedField)',
      'impactedValue = tostring(properties.impactedValue)',
      'lastUpdated = tostring(properties.lastUpdated)',
    ].join(', '),
  ].join('\n| ');
}

export async function listAdvisorRecommendations(
  azure: AzureAccess,
  input: AdvisorInput,
): Promise<AdvisorResult> {
  const session = azure.session();
  const aliases = subscriptionAliases(azure, session);
  const limit = Math.min(Math.max(1, Math.floor(input.limit ?? DEFAULT_ADVISOR_LIMIT)), MAX_ADVISOR_LIMIT);
  const { rows, truncated } = await azure.resourceGraph.queryResult<unknown>(buildAdvisorQuery(input), {
    maxRows: limit,
  });
  const recommendations = rows.flatMap((raw) => {
    const parsed = AdvisorRow.safeParse(raw);
    if (!parsed.success) return [];
    return [toAdvisorDto(parsed.data, (id) => aliases.get(id.toLowerCase()) ?? null)];
  });
  return { recommendations, truncated };
}
