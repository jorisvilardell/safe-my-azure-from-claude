import { shortenArmId, type Pseudonymizer } from '../../core/anonymizer/index.js';
import { untrustedText } from '../../core/safety/index.js';

/**
 * Cap for free text copied from Azure (descriptions, operation names, dimension values). Anyone
 * with write access to the tenant chooses that text, so it is kept short and in clearly named
 * fields (see issue #39).
 */
export const MAX_TEXT = 512;
const MAX_SHORT_TEXT = 128;
const MAX_SUMMARY = 256;
const MAX_CRITERIA = 10;
const MAX_DIMENSIONS = 20;
const MAX_TARGETS = 10;

type Rec = Record<string, unknown>;

const rec = (v: unknown): Rec | undefined =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Rec) : undefined;
const arr = (v: unknown): readonly unknown[] => (Array.isArray(v) ? v : []);

function str(v: unknown): string | undefined {
  if (typeof v === 'string') return v === '' ? undefined : v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return undefined;
}

function num(v: unknown): number | string | undefined {
  if (typeof v === 'number') return v;
  return str(v);
}

/**
 * Free text through `untrustedText()`: invisible characters removed, capped at whitespace (the
 * partial word is dropped, so a GUID, ARM ID or token is never cut into an unrecognisable fragment).
 */
export function capText(v: unknown, max = MAX_TEXT): string | undefined {
  return untrustedText(str(v), { max });
}

function instant(v: unknown): string | undefined {
  const d = v instanceof Date ? v : typeof v === 'string' ? new Date(v) : undefined;
  return d === undefined || Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** `rg/type/name` for an ARM ID. Anything that is not an ARM ID is dropped, not shown. */
export function toTarget(armId: unknown, p: Pseudonymizer): string | undefined {
  if (typeof armId !== 'string' || !/^\/subscriptions\//i.test(armId)) return undefined;
  return shortenArmId(armId, p);
}

/** Drops `undefined` values so the JSON stays compact (and `exactOptionalPropertyTypes` holds). */
type Compact<T> = { [K in keyof T as undefined extends T[K] ? never : K]: T[K] } & {
  [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>;
};

function compact<T extends Rec>(o: T): Compact<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Compact<T>;
}

// ---------------------------------------------------------------------------------------------
// Fired alerts (Resource Graph `alertsmanagementresources`)

export interface AlertSummary {
  /** Opaque reference for get_alert. Never the alert ID. */
  readonly alertRef: string;
  readonly name?: string;
  readonly severity?: string;
  readonly alertState?: string;
  readonly monitorCondition?: string;
  readonly signalType?: string;
  readonly target?: string;
  readonly firedAt?: string;
  readonly resolvedAt?: string;
}

export function toAlertSummary(
  name: unknown,
  essentials: unknown,
  alertRef: string,
  p: Pseudonymizer,
): AlertSummary {
  const e = rec(essentials) ?? {};
  return compact({
    alertRef,
    name: capText(name, MAX_SHORT_TEXT),
    severity: capText(e.severity, MAX_SHORT_TEXT),
    alertState: capText(e.alertState, MAX_SHORT_TEXT),
    monitorCondition: capText(e.monitorCondition, MAX_SHORT_TEXT),
    signalType: capText(e.signalType, MAX_SHORT_TEXT),
    target: toTarget(e.targetResource, p),
    firedAt: instant(e.startDateTime),
    resolvedAt: instant(e.monitorConditionResolvedDateTime),
  });
}

export interface AlertDimension {
  readonly name?: string;
  readonly value?: string;
}

export interface AlertCriterion {
  readonly metricName?: string;
  readonly metricNamespace?: string;
  readonly operator?: string;
  readonly threshold?: number | string;
  readonly timeAggregation?: string;
  readonly metricValue?: number | string;
  readonly dimensions?: readonly AlertDimension[];
}

export interface AlertCondition {
  readonly conditionType?: string;
  readonly windowSize?: string;
  readonly criteria: readonly AlertCriterion[];
}

export interface AlertDetails extends AlertSummary {
  /** `rg/type/name` of the alert rule. */
  readonly rule?: string;
  readonly monitorService?: string;
  /** Free text written by the rule author (capped). */
  readonly description?: string;
  readonly condition?: AlertCondition;
}

function toDimensions(v: unknown): AlertDimension[] | undefined {
  const dims = arr(v)
    .slice(0, MAX_DIMENSIONS)
    .flatMap((d) => {
      const r = rec(d);
      return r === undefined
        ? []
        : [compact({ name: capText(r.name, MAX_SHORT_TEXT), value: capText(r.value, MAX_SHORT_TEXT) })];
    });
  return dims.length === 0 ? undefined : dims;
}

function toCriterion(v: unknown): AlertCriterion[] {
  const c = rec(v);
  if (c === undefined) return [];
  return [
    compact({
      metricName: capText(c.metricName, MAX_SHORT_TEXT),
      metricNamespace: capText(c.metricNamespace, MAX_SHORT_TEXT),
      operator: capText(c.operator, MAX_SHORT_TEXT),
      threshold: num(c.threshold),
      timeAggregation: capText(c.timeAggregation, MAX_SHORT_TEXT),
      metricValue: num(c.metricValue),
      dimensions: toDimensions(c.dimensions),
    }),
  ];
}

/**
 * Allowlisted view of the alert context. The raw context also holds portal links, resource IDs,
 * search queries and result links: none of them is copied.
 */
function toCondition(context: unknown): AlertCondition | undefined {
  const outer = rec(context);
  // The common alert schema nests the payload under `context.context`.
  const inner = rec(outer?.context) ?? outer;
  const condition = rec(inner?.condition);
  if (inner === undefined || condition === undefined) return undefined;
  return compact({
    conditionType: capText(inner.conditionType, MAX_SHORT_TEXT),
    windowSize: capText(condition.windowSize, MAX_SHORT_TEXT),
    criteria: arr(condition.allOf).slice(0, MAX_CRITERIA).flatMap(toCriterion),
  });
}

export function toAlertDetails(row: unknown, alertRef: string, p: Pseudonymizer): AlertDetails {
  const r = rec(row) ?? {};
  const props = rec(r.properties) ?? {};
  const e = rec(props.essentials) ?? {};
  return compact({
    ...toAlertSummary(r.name, e, alertRef, p),
    rule: toTarget(e.alertRule, p),
    monitorService: capText(e.monitorService, MAX_SHORT_TEXT),
    description: capText(e.description),
    condition: toCondition(props.context),
  });
}

// ---------------------------------------------------------------------------------------------
// Alert rules (Resource Graph `resources`)

export type AlertRuleKind = 'metric' | 'log' | 'activity';

export const RULE_TYPES: Readonly<Record<string, AlertRuleKind>> = {
  'microsoft.insights/metricalerts': 'metric',
  'microsoft.insights/scheduledqueryrules': 'log',
  'microsoft.insights/activitylogalerts': 'activity',
};

export interface AlertRule {
  readonly name?: string;
  readonly resourceGroup?: string;
  readonly kind: AlertRuleKind;
  readonly enabled?: boolean;
  readonly severity?: string;
  /** `rg/type/name` of each monitored scope. */
  readonly targets: readonly string[];
  /** Short, generated summary of the condition (free text from Azure inside, capped). */
  readonly conditionSummary?: string;
}

function enabledOf(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return v.toLowerCase() === 'true';
  return undefined;
}

function severityOf(v: unknown): string | undefined {
  const s = str(v);
  return s !== undefined && /^\d$/.test(s) ? `Sev${s}` : capText(s, MAX_SHORT_TEXT);
}

const words = (...parts: unknown[]): string =>
  parts
    .map((x) => str(x))
    .filter((x) => x !== undefined)
    .join(' ');

const withWindow = (summary: string, window: unknown): string =>
  str(window) === undefined ? summary : `${summary} over ${str(window) ?? ''}`;

function metricSummary(props: Rec): string {
  const criteria = arr(rec(props.criteria)?.allOf).slice(0, MAX_CRITERIA);
  const parts = criteria.map((c) => {
    const r = rec(c) ?? {};
    if (r.failedLocationCount !== undefined) {
      return `availability test failing in >= ${str(r.failedLocationCount) ?? '?'} locations`;
    }
    const threshold =
      str(r.criterionType) === 'DynamicThresholdCriterion'
        ? `dynamic(${str(r.alertSensitivity) ?? 'Medium'})`
        : str(r.threshold);
    return words(r.timeAggregation, r.metricName, r.operator, threshold);
  });
  return withWindow(parts.filter((x) => x !== '').join(' and ') || 'metric condition', props.windowSize);
}

function logSummary(props: Rec): string {
  const criteria = arr(rec(props.criteria)?.allOf).slice(0, MAX_CRITERIA);
  if (criteria.length > 0) {
    const parts = criteria.map((c) => {
      const r = rec(c) ?? {};
      const measure = str(r.metricMeasureColumn);
      return words(
        r.timeAggregation,
        measure === undefined ? undefined : `of ${measure}`,
        r.operator,
        r.threshold,
      );
    });
    return withWindow(`log query: ${parts.join(' and ')}`, props.windowSize);
  }
  // Legacy (2018) log alerts: `action.trigger` + `schedule`.
  const trigger = rec(rec(props.action)?.trigger) ?? {};
  const window = str(rec(props.schedule)?.timeWindowInMinutes);
  return withWindow(
    `log query: results ${words(trigger.thresholdOperator, trigger.threshold)}`.trimEnd(),
    window === undefined ? undefined : `${window} min`,
  );
}

function activitySummary(props: Rec): string {
  const leaves = arr(rec(props.condition)?.allOf).flatMap((c) => {
    const r = rec(c) ?? {};
    const anyOf = arr(r.anyOf);
    if (anyOf.length > 0) {
      const alts = anyOf.map((a) => `${str(rec(a)?.field) ?? '?'}=${str(rec(a)?.equals) ?? '?'}`);
      return [`(${alts.join(' or ')})`];
    }
    return [`${str(r.field) ?? '?'}=${str(r.equals) ?? str(r.containsAny) ?? '?'}`];
  });
  return leaves.slice(0, MAX_CRITERIA).join(' and ') || 'activity log condition';
}

export function toAlertRule(row: unknown, p: Pseudonymizer): AlertRule | undefined {
  const r = rec(row) ?? {};
  const kind = RULE_TYPES[str(r.type)?.toLowerCase() ?? ''];
  if (kind === undefined) return undefined;
  const props = rec(r.properties) ?? {};
  const legacySource = rec(props.source)?.dataSourceId;
  const scopes = arr(props.scopes).length > 0 ? arr(props.scopes) : [legacySource];
  const summary =
    kind === 'metric' ? metricSummary(props) : kind === 'log' ? logSummary(props) : activitySummary(props);
  return compact({
    name: capText(r.name, MAX_SHORT_TEXT),
    resourceGroup: capText(r.resourceGroup, MAX_SHORT_TEXT),
    kind,
    enabled: enabledOf(props.enabled),
    severity: severityOf(props.severity ?? rec(props.action)?.severity),
    targets: scopes
      .slice(0, MAX_TARGETS)
      .map((s) => toTarget(s, p))
      .filter((t) => t !== undefined),
    conditionSummary: capText(summary, MAX_SUMMARY),
  });
}

// ---------------------------------------------------------------------------------------------
// Activity log (`MonitorClient.activityLogs.list`)

export interface ActivityEvent {
  readonly time?: string;
  /** e.g. `Microsoft.Compute/virtualMachines/restart/action`. */
  readonly operationName?: string;
  /** Localised display name from Azure (capped free text). */
  readonly operationDisplayName?: string;
  readonly status?: string;
  readonly subStatus?: string;
  readonly level?: string;
  /** Pseudonymised by the anonymizer (`user-NNN` / `app-NNN`): never an email or object ID. */
  readonly caller?: string;
  readonly target?: string;
  /** Pseudonymised correlation ID: events of one operation share it. */
  readonly correlationRef?: string;
}

const localizable = (v: unknown): Rec => rec(v) ?? {};

export function eventStatus(event: unknown): string | undefined {
  return str(localizable(rec(event)?.status).value);
}

export function eventTime(event: unknown): string | undefined {
  return instant(rec(event)?.eventTimestamp);
}

export function toActivityEvent(event: unknown, p: Pseudonymizer): ActivityEvent {
  const e = rec(event) ?? {};
  const op = localizable(e.operationName);
  const opName = capText(op.value, MAX_TEXT);
  const opDisplay = capText(op.localizedValue, MAX_TEXT);
  return compact({
    time: eventTime(e),
    operationName: opName,
    operationDisplayName: opDisplay === opName ? undefined : opDisplay,
    status: capText(eventStatus(e), MAX_SHORT_TEXT),
    subStatus:
      capText(localizable(e.subStatus).localizedValue, MAX_SHORT_TEXT) ??
      capText(localizable(e.subStatus).value, MAX_SHORT_TEXT),
    level: capText(e.level, MAX_SHORT_TEXT),
    // `caller` is a USER field for the anonymizer: the email/UPN/object ID becomes user-NNN/app-NNN.
    caller: capText(e.caller, MAX_TEXT),
    target: toTarget(e.resourceId, p),
    correlationRef: capText(e.correlationId, MAX_SHORT_TEXT),
  });
}
