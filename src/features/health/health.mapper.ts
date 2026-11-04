import type { AvailabilityStatus, Event } from '@azure/arm-resourcehealth';
import { z } from 'zod';
import { untrustedText } from '../../core/safety/index.js';

/** Cap for every free-text field copied from Azure (titles, summaries, Advisor text). */
export const TEXT_CAP = 512;
export const MAX_RECOMMENDED_ACTIONS = 10;
export const MAX_HISTORY = 20;

const ENTITIES: Readonly<Record<string, string>> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  '#39': "'",
};

/**
 * Free text written by Azure (or by whoever can write to the tenant). Service Health summaries are
 * HTML: tags (and the URLs in their attributes) are dropped. The rest is `untrustedText()`:
 * invisible characters removed so nothing hides in the text (#39), capped at `cap` characters.
 * The scrubber still runs on it afterwards.
 */
export function azureText(value: unknown, cap = TEXT_CAP): string | null {
  if (typeof value !== 'string') return null;
  const html = value
    .replace(/<\s*br\s*\/?>|<\/\s*(?:p|div|li|h\d)\s*>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&(nbsp|amp|lt|gt|quot|apos|#39);/g, (_m, name: string) => ENTITIES[name] ?? '')
    // Other format characters (soft hyphen, Arabic letter mark, …) never carry meaning here.
    .replace(/\p{Cf}/gu, '');
  return untrustedText(html, { max: cap }) ?? null;
}

/** An enum-like value from Azure (`Available`, `ServiceIssue`): short, single word-ish. */
function label(value: unknown): string | null {
  return untrustedText(value, { max: 64 }) ?? null;
}

function isoTime(value: unknown): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === 'string' && value !== '') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

export interface ArmTarget {
  readonly subscriptionId: string;
  /** `rg/Namespace/type/name` (names only), `rg` for a resource group, `null` for a subscription. */
  readonly target: string | null;
}

/** Splits an ARM ID into its subscription GUID (server-side only) and a names-only target. */
export function parseArmId(id: string): ArmTarget | undefined {
  const segments = id.split('/').filter(Boolean);
  const lower = segments.map((s) => s.toLowerCase());
  if (lower[0] !== 'subscriptions' || segments[1] === undefined) return undefined;
  const subscriptionId = segments[1];
  const rgIdx = lower.indexOf('resourcegroups');
  const rg = rgIdx === -1 ? undefined : segments[rgIdx + 1];
  if (rg === undefined) return { subscriptionId, target: null };
  const provIdx = lower.indexOf('providers');
  const tail = provIdx === -1 ? [] : segments.slice(provIdx + 1);
  return { subscriptionId, target: [rg, ...tail].join('/') };
}

// ---------------------------------------------------------------------------------------------
// Resource Health

export interface HealthHistoryEntryDto {
  readonly state: string | null;
  readonly time: string | null;
  readonly summary: string | null;
}

export interface ResourceHealthDto {
  readonly resource: string | null;
  readonly availabilityState: string | null;
  /** Free text from Azure, capped. */
  readonly summary: string | null;
  readonly reasonType: string | null;
  readonly reasonChronicity: string | null;
  readonly occurredTime: string | null;
  readonly reportedTime: string | null;
  /** Free text from Azure, capped. Action URLs are never returned. */
  readonly recommendedActions: readonly string[];
  readonly history: readonly HealthHistoryEntryDto[];
  readonly historyTruncated: boolean;
}

export function toResourceHealthDto(
  resourceTarget: string | null,
  current: AvailabilityStatus,
  history: readonly AvailabilityStatus[],
  historyTruncated: boolean,
): ResourceHealthDto {
  const p = current.properties ?? {};
  const actions = (p.recommendedActions ?? [])
    .map((a) => azureText(a.action))
    .filter((a): a is string => a !== null);
  return {
    resource: resourceTarget,
    availabilityState: label(p.availabilityState),
    summary: azureText(p.summary),
    reasonType: label(p.reasonType),
    reasonChronicity: label(p.reasonChronicity),
    // The SDK spells it `occuredTime`.
    occurredTime: isoTime(p.occuredTime),
    reportedTime: isoTime(p.reportedTime),
    recommendedActions: actions.slice(0, MAX_RECOMMENDED_ACTIONS),
    history: history.slice(0, MAX_HISTORY).map((h) => ({
      state: label(h.properties?.availabilityState),
      time: isoTime(h.properties?.occuredTime),
      summary: azureText(h.properties?.summary),
    })),
    historyTruncated,
  };
}

// ---------------------------------------------------------------------------------------------
// Service Health

export interface ImpactDto {
  readonly service: string | null;
  readonly regions: readonly string[];
}

export interface ServiceHealthEventDto {
  /** Pseudonym of the Azure tracking ID. */
  readonly eventRef: string;
  /** Free text from Azure, capped. */
  readonly title: string | null;
  readonly eventType: string | null;
  readonly status: string | null;
  readonly level: string | null;
  readonly impact: readonly ImpactDto[];
  /** Subscription aliases that reported the event. */
  readonly subscriptions: readonly string[];
  readonly impactStartTime: string | null;
  readonly lastUpdateTime: string | null;
  /** Free text from Azure (HTML stripped), capped. */
  readonly summary: string | null;
}

const MAX_IMPACTS = 20;
const MAX_REGIONS = 30;

/** Replaces every occurrence of the tracking ID in Azure's text with its pseudonym. */
function hideTrackingId(text: string | null, trackingId: string, eventRef: string): string | null {
  if (text === null || trackingId === '') return text;
  return text.split(trackingId).join(eventRef);
}

export function toServiceHealthEventDto(
  event: Event,
  trackingId: string,
  eventRef: string,
  subscriptions: readonly string[],
): ServiceHealthEventDto {
  const impact = (event.impact ?? []).slice(0, MAX_IMPACTS).map((i) => ({
    service: azureText(i.impactedService, 128),
    regions: [
      ...new Set(
        (i.impactedRegions ?? [])
          .map((r) => azureText(r.impactedRegion, 64))
          .filter((r): r is string => r !== null),
      ),
    ].slice(0, MAX_REGIONS),
  }));
  return {
    eventRef,
    title: hideTrackingId(azureText(event.title), trackingId, eventRef),
    eventType: label(event.eventType),
    status: label(event.status),
    level: label(event.level),
    impact,
    subscriptions,
    impactStartTime: isoTime(event.impactStartTime),
    lastUpdateTime: isoTime(event.lastUpdateTime),
    summary: hideTrackingId(azureText(event.summary), trackingId, eventRef),
  };
}

// ---------------------------------------------------------------------------------------------
// Advisor (Resource Graph `advisorresources`)

export const AdvisorRow = z.object({
  category: z.string().nullish(),
  impact: z.string().nullish(),
  problem: z.string().nullish(),
  solution: z.string().nullish(),
  resourceId: z.string().nullish(),
  impactedField: z.string().nullish(),
  impactedValue: z.string().nullish(),
  lastUpdated: z.unknown(),
  subscriptionId: z.string().nullish(),
});
export type AdvisorRow = z.infer<typeof AdvisorRow>;

export interface AdvisorRecommendationDto {
  readonly category: string | null;
  readonly impact: string | null;
  /** Free text from Azure, capped. */
  readonly problem: string | null;
  /** Free text from Azure, capped. */
  readonly solution: string | null;
  /** Subscription alias. */
  readonly subscription: string | null;
  /** `rg/Namespace/type/name`, the resource group name, or `(subscription)`. */
  readonly target: string;
  readonly lastUpdated: string | null;
}

export function toAdvisorDto(
  row: AdvisorRow,
  subscriptionAlias: (subscriptionId: string) => string | null,
): AdvisorRecommendationDto {
  const parsed = typeof row.resourceId === 'string' ? parseArmId(row.resourceId) : undefined;
  const fallback = [row.impactedField, row.impactedValue]
    .map((v) => azureText(v, 128))
    .filter((v): v is string => v !== null)
    .join('/');
  const subId = parsed?.subscriptionId ?? row.subscriptionId ?? undefined;
  return {
    category: label(row.category),
    impact: label(row.impact),
    problem: azureText(row.problem),
    solution: azureText(row.solution),
    subscription: subId === undefined ? null : subscriptionAlias(subId),
    target:
      parsed === undefined ? (fallback === '' ? 'unknown' : fallback) : (parsed.target ?? '(subscription)'),
    lastUpdated: isoTime(row.lastUpdated),
  };
}
