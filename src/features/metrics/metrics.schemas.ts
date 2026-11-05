import { z } from 'zod';
import { ResourceGroupName, ResourceName, ResourceType, SubscriptionAlias } from '../../core/mcp/index.js';

/** Hard cap on the points one `get_metrics` call returns, across every metric and series. */
export const MAX_POINTS = 1500;
export const MAX_METRICS = 10;
export const MAX_SERIES = 10;
export const MAX_TIMESPAN_MS = 30 * 24 * 3_600_000;
/** Raw filter length, before parsing. */
export const MAX_FILTER_LENGTH = 1000;

/** Time grains Azure Monitor accepts, smallest first. */
export const INTERVALS = ['PT1M', 'PT5M', 'PT15M', 'PT30M', 'PT1H', 'PT6H', 'PT12H', 'P1D'] as const;
export type Interval = (typeof INTERVALS)[number];

export const AGGREGATIONS = ['Average', 'Minimum', 'Maximum', 'Total', 'Count'] as const;
export type Aggregation = (typeof AGGREGATIONS)[number];

const DURATION = /^P(?:(\d{1,3})D)?(?:T(?:(\d{1,4})H)?(?:(\d{1,6})M)?)?$/;

/** `P1DT2H30M` → milliseconds. Days, hours and minutes only (no months or years: they have no fixed length). */
export function durationMs(value: string): number | undefined {
  const m = DURATION.exec(value);
  if (m === null || value === 'P' || value.endsWith('T')) return undefined;
  const [, d = '0', h = '0', min = '0'] = m;
  const ms = ((Number(d) * 24 + Number(h)) * 60 + Number(min)) * 60_000;
  return ms > 0 ? ms : undefined;
}

const RESOURCE_REF = {
  subscription: SubscriptionAlias.optional(),
  resourceGroup: ResourceGroupName,
  name: ResourceName,
  type: ResourceType.optional(),
};

/** Metric names go into a comma-separated query parameter: no comma, no control character. */
const METRIC_NAME = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9 _.\-/%():]{0,127}$/, 'invalid metric name')
  .describe('Metric name, as listed by list_metric_definitions (e.g. "Percentage CPU").');

export const ListMetricDefinitionsInput = { ...RESOURCE_REF };

export const GetMetricsInput = {
  ...RESOURCE_REF,
  metrics: z.array(METRIC_NAME).min(1).max(MAX_METRICS).describe(`1 to ${MAX_METRICS} metric names.`),
  timespan: z
    .string()
    .refine((v) => {
      const ms = durationMs(v);
      return ms !== undefined && ms >= 60_000 && ms <= MAX_TIMESPAN_MS;
    }, 'timespan must be an ISO 8601 duration between PT1M and P30D (days, hours, minutes), e.g. PT1H, P7D')
    .default('PT1H')
    .describe('How far back to look, as an ISO 8601 duration ending now (PT1M to P30D). Default PT1H.'),
  interval: z
    .enum(INTERVALS)
    .optional()
    .describe('Time grain. Omit to get the smallest grain that fits the points cap.'),
  aggregation: z
    .enum(AGGREGATIONS)
    .optional()
    .describe("Aggregation. Omit to use Azure's default for the metric."),
  filter: z
    .string()
    .max(MAX_FILTER_LENGTH)
    .optional()
    .describe(
      "Dimension filter: clauses `<Dimension> eq '<value>'` (or `ne`) joined by `and` / `or`. " +
        "`'*'` splits the result by that dimension, e.g. `RemoteIP eq '*'`. Double a quote to escape it.",
    ),
  top: z
    .number()
    .int()
    .min(1)
    .max(MAX_SERIES)
    .optional()
    .describe(
      `Maximum series per metric when the filter splits by a dimension (1 to ${MAX_SERIES}, default ${MAX_SERIES}).`,
    ),
};
