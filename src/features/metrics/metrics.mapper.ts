import type { Aggregation } from './metrics.schemas.js';

/** Length cap of free text copied from Azure (descriptions, display names). */
export const FREE_TEXT_MAX = 300;

interface LocalizableLike {
  readonly value?: string;
  readonly localizedValue?: string;
}

/** The fields we read from an `@azure/arm-monitor` `MetricDefinition`. */
export interface RawMetricDefinition {
  readonly name?: LocalizableLike;
  readonly displayDescription?: string;
  readonly namespace?: string;
  readonly unit?: string;
  readonly primaryAggregationType?: string;
  readonly supportedAggregationTypes?: readonly string[];
  readonly isDimensionRequired?: boolean;
  readonly dimensions?: readonly LocalizableLike[];
  readonly metricAvailabilities?: readonly { readonly timeGrain?: string }[];
}

interface RawMetricValue {
  readonly timeStamp: Date | string;
  readonly average?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly total?: number;
  readonly count?: number;
}

/** The fields we read from an `@azure/arm-monitor` metrics `Response`. */
export interface RawMetricsResponse {
  readonly interval?: string;
  readonly value: readonly {
    readonly name: LocalizableLike;
    readonly unit: string;
    readonly errorCode?: string;
    readonly timeseries?: readonly {
      readonly metadatavalues?: readonly { readonly name?: LocalizableLike; readonly value?: string }[];
      readonly data?: readonly RawMetricValue[];
    }[];
  }[];
}

export interface MetricDefinitionDto {
  readonly name: string;
  /** Free text from Azure, capped. */
  readonly displayName?: string;
  /** Free text from Azure, capped. */
  readonly description?: string;
  readonly namespace?: string;
  readonly unit?: string;
  readonly primaryAggregation?: string;
  readonly supportedAggregations: readonly string[];
  readonly dimensions: readonly string[];
  readonly dimensionRequired?: boolean;
  readonly timeGrains: readonly string[];
}

export type Point = readonly [time: string, value: number];

export interface SeriesDto {
  /** Dimension name → value. Values come from Azure (IPs, hostnames) and are scrubbed on output. */
  readonly dimensions: Readonly<Record<string, string>>;
  readonly points: readonly Point[];
}

export interface MetricDto {
  readonly name: string;
  readonly unit: string;
  readonly aggregation?: Aggregation;
  readonly series: readonly SeriesDto[];
  /** Azure's per-metric error code when this metric failed (the message is never copied). */
  readonly errorCode?: string;
}

export function capText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  return trimmed.length > FREE_TEXT_MAX ? `${trimmed.slice(0, FREE_TEXT_MAX - 1)}…` : trimmed;
}

const optional = <K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> =>
  value === undefined ? {} : ({ [key]: value } as Record<K, V>);

export function toMetricDefinitionDto(raw: RawMetricDefinition): MetricDefinitionDto | undefined {
  const name = raw.name?.value;
  if (name === undefined || name === '') return undefined;
  const displayName = capText(raw.name?.localizedValue);
  return {
    name,
    ...optional('displayName', displayName === name ? undefined : displayName),
    ...optional('description', capText(raw.displayDescription)),
    ...optional('namespace', raw.namespace),
    ...optional('unit', raw.unit),
    ...optional('primaryAggregation', raw.primaryAggregationType),
    supportedAggregations: [...(raw.supportedAggregationTypes ?? [])],
    dimensions: (raw.dimensions ?? []).flatMap((d) => (d.value === undefined ? [] : [d.value])),
    ...optional('dimensionRequired', raw.isDimensionRequired),
    timeGrains: (raw.metricAvailabilities ?? []).flatMap((a) =>
      a.timeGrain === undefined ? [] : [a.timeGrain],
    ),
  };
}

const VALUE_FIELDS: readonly (readonly [Aggregation, keyof RawMetricValue])[] = [
  ['Average', 'average'],
  ['Total', 'total'],
  ['Maximum', 'maximum'],
  ['Minimum', 'minimum'],
  ['Count', 'count'],
];

function valueOf(p: RawMetricValue, field: keyof RawMetricValue): number | undefined {
  const v = p[field];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** The aggregation actually present in the data: the requested one, else the first one Azure returned. */
function pickAggregation(
  series: readonly { readonly data?: readonly RawMetricValue[] }[],
  requested: Aggregation | undefined,
): (typeof VALUE_FIELDS)[number] | undefined {
  if (requested !== undefined) return VALUE_FIELDS.find(([a]) => a === requested);
  const points = series.flatMap((s) => s.data ?? []);
  return VALUE_FIELDS.find(([, f]) => points.some((p) => valueOf(p, f) !== undefined));
}

function isoTime(t: Date | string): string {
  const d = t instanceof Date ? t : new Date(t);
  return Number.isNaN(d.getTime()) ? String(t) : d.toISOString();
}

const SAFE_CODE = /^[A-Za-z]{1,64}$/;

/** Azure's per-metric code, only when the metric failed and only if it is a plain word. */
function errorCode(code: string | undefined): string | undefined {
  if (code === undefined || code === 'Success') return undefined;
  return SAFE_CODE.test(code) ? code : 'Error';
}

/**
 * Raw response → allowlisted DTOs. Points without a value (no data in that grain) are DROPPED,
 * always: a gap in `points` means "no data". At most `maxSeries` series are kept per metric.
 */
export function toMetricDtos(
  raw: RawMetricsResponse,
  requested: Aggregation | undefined,
  maxSeries: number,
): { metrics: MetricDto[]; seriesTruncated: boolean } {
  let seriesTruncated = false;
  const metrics = raw.value.map((m): MetricDto => {
    const all = m.timeseries ?? [];
    if (all.length > maxSeries) seriesTruncated = true;
    const kept = all.slice(0, maxSeries);
    const agg = pickAggregation(kept, requested);
    const series = kept.map((s): SeriesDto => ({
      dimensions: Object.fromEntries(
        (s.metadatavalues ?? []).flatMap((md) =>
          md.name?.value === undefined ? [] : [[md.name.value, md.value ?? ''] as const],
        ),
      ),
      points:
        agg === undefined
          ? []
          : (s.data ?? []).flatMap((p): Point[] => {
              const v = valueOf(p, agg[1]);
              return v === undefined ? [] : [[isoTime(p.timeStamp), v]];
            }),
    }));
    return {
      name: m.name.value ?? '',
      unit: m.unit,
      ...optional('aggregation', agg?.[0]),
      series,
      ...optional('errorCode', errorCode(m.errorCode)),
    };
  });
  return { metrics, seriesTruncated };
}

export function countPoints(metrics: readonly MetricDto[]): number {
  return metrics.reduce((n, m) => n + m.series.reduce((k, s) => k + s.points.length, 0), 0);
}
