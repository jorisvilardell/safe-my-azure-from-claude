import { azureClients, type AzureAccess, type ResourceRef } from '../../core/azure/index.js';
import { AppError } from '../../core/errors/index.js';
import { parseFilter, renderFilter } from './metrics.filter.js';
import {
  countPoints,
  toMetricDefinitionDto,
  toMetricDtos,
  type MetricDefinitionDto,
  type MetricDto,
  type RawMetricDefinition,
  type RawMetricsResponse,
} from './metrics.mapper.js';
import {
  durationMs,
  INTERVALS,
  MAX_POINTS,
  MAX_SERIES,
  MAX_TIMESPAN_MS,
  type Aggregation,
  type Interval,
} from './metrics.schemas.js';

/**
 * `ClientFactory` key of the Azure Monitor client. `metrics.list` and `metricDefinitions.list`
 * take a full resource URI, so the client is bound to nothing but the context's credential.
 */
export const METRICS_CLIENT_KEY = 'monitor-metrics';
export const MAX_DEFINITIONS = 200;

/** The subset of `MonitorClient` we use (read-only). Lets tests stub it. */
export interface MonitorMetricsClient {
  readonly metrics: {
    list(
      resourceUri: string,
      options?: {
        timespan?: string;
        interval?: string;
        metricnames?: string;
        aggregation?: string;
        top?: number;
        filter?: string;
        autoAdjustTimegrain?: boolean;
      },
    ): Promise<RawMetricsResponse>;
  };
  readonly metricDefinitions: {
    list(resourceUri: string): AsyncIterable<RawMetricDefinition>;
  };
}

const INTERVAL_MS: Readonly<Record<Interval, number>> = {
  PT1M: 60_000,
  PT5M: 5 * 60_000,
  PT15M: 15 * 60_000,
  PT30M: 30 * 60_000,
  PT1H: 3_600_000,
  PT6H: 6 * 3_600_000,
  PT12H: 12 * 3_600_000,
  P1D: 24 * 3_600_000,
};

export interface ResourceInput {
  readonly subscription?: string | undefined;
  readonly resourceGroup: string;
  readonly name: string;
  readonly type?: string | undefined;
}

export interface GetMetricsInput extends ResourceInput {
  readonly metrics: readonly string[];
  readonly timespan: string;
  readonly interval?: Interval | undefined;
  readonly aggregation?: Aggregation | undefined;
  readonly filter?: string | undefined;
  readonly top?: number | undefined;
}

export interface MetricDefinitionsResult {
  readonly resource: string;
  readonly definitions: readonly MetricDefinitionDto[];
  readonly truncated: boolean;
}

export interface MetricsResult {
  readonly resource: string;
  readonly timespan: string;
  readonly interval: string;
  readonly pointCount: number;
  readonly metrics: readonly MetricDto[];
  /** True when a metric had more series than `top` and some were dropped. */
  readonly seriesTruncated: boolean;
}

/** Placeholders the anonymiser hands the AI. Only these are mapped back to real filter values. */
const PSEUDONYM = /^(?:id|user|app|ip|public-ip-external)-\d{3,}$/;

export interface MetricsDeps {
  /** `ctx.anonymizer.pseudonymizer.resolve`: a masked dimension value the AI sends back → real value. */
  readonly resolvePseudonym: (placeholder: string) => string | undefined;
  readonly now?: () => number;
}

function toRef(input: ResourceInput): ResourceRef {
  return {
    resourceGroup: input.resourceGroup,
    name: input.name,
    ...(input.subscription === undefined ? {} : { subscription: input.subscription }),
    ...(input.type === undefined ? {} : { type: input.type }),
  };
}

async function target(
  azure: AzureAccess,
  input: ResourceInput,
): Promise<{ uri: string; client: MonitorMetricsClient }> {
  const session = azure.session();
  const uri = await azure.resolver.resolve(toRef(input));
  return {
    uri,
    client: azure.clients.getClient<MonitorMetricsClient>(
      session,
      METRICS_CLIENT_KEY,
      azureClients.monitor(),
    ),
  };
}

/** An HTTP 400 from Azure Monitor is almost always the AI's query: say so, without Azure's message (R4). */
async function withQueryHint<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    const status = (err as { statusCode?: unknown } | null)?.statusCode;
    if (status === 400) {
      throw new AppError(
        'InvalidMetricsQuery',
        'Azure Monitor rejected the query (HTTP 400). Check the metric names and dimension names with ' +
          'list_metric_definitions, and that the interval is supported by those metrics.',
      );
    }
    throw err;
  }
}

export async function listMetricDefinitions(
  azure: AzureAccess,
  input: ResourceInput,
): Promise<MetricDefinitionsResult> {
  const { uri, client } = await target(azure, input);
  const definitions: MetricDefinitionDto[] = [];
  let truncated = false;
  await withQueryHint(async () => {
    for await (const raw of client.metricDefinitions.list(uri)) {
      if (definitions.length >= MAX_DEFINITIONS) {
        truncated = true;
        break;
      }
      const dto = toMetricDefinitionDto(raw);
      if (dto !== undefined) definitions.push(dto);
    }
  });
  return { resource: input.name, definitions, truncated };
}

function tooManyPoints(points: number, scope: string): AppError {
  return new AppError(
    'TooManyPoints',
    `${scope} ${points} points, over the cap of ${MAX_POINTS}. Use a larger interval, a shorter ` +
      'timespan, fewer metrics, or a smaller top.',
  );
}

/**
 * Picks the time grain. An explicit `interval` is checked against the cap with the minimum
 * possible series count (one per metric). Without one, the smallest grain that fits the expected
 * series count is used.
 */
function chooseInterval(
  spanMs: number,
  metricCount: number,
  expectedSeries: number,
  requested: Interval | undefined,
): Interval {
  const pointsPerSeries = (i: Interval): number => Math.ceil(spanMs / INTERVAL_MS[i]);
  if (requested !== undefined) {
    const minimum = pointsPerSeries(requested) * metricCount;
    if (minimum > MAX_POINTS) throw tooManyPoints(minimum, `This query would return at least`);
    return requested;
  }
  const fits = (series: number) => (i: Interval) => pointsPerSeries(i) * metricCount * series <= MAX_POINTS;
  return INTERVALS.find(fits(expectedSeries)) ?? INTERVALS.find(fits(1)) ?? 'P1D';
}

export async function getMetrics(
  azure: AzureAccess,
  deps: MetricsDeps,
  input: GetMetricsInput,
): Promise<MetricsResult> {
  // Validate everything before touching Azure.
  const spanMs = durationMs(input.timespan);
  if (spanMs === undefined || spanMs < 60_000 || spanMs > MAX_TIMESPAN_MS) {
    throw new AppError('InvalidTimespan', 'timespan must be an ISO 8601 duration between PT1M and P30D.');
  }
  const filter =
    input.filter === undefined || input.filter.trim() === '' ? undefined : parseFilter(input.filter);
  const top = Math.min(input.top ?? MAX_SERIES, MAX_SERIES);
  const interval = chooseInterval(
    spanMs,
    input.metrics.length,
    filter === undefined ? 1 : top,
    input.interval,
  );

  const { uri, client } = await target(azure, input);
  const end = (deps.now ?? Date.now)();
  const raw = await withQueryHint(() =>
    client.metrics.list(uri, {
      timespan: `${new Date(end - spanMs).toISOString()}/${new Date(end).toISOString()}`,
      interval,
      metricnames: input.metrics.join(','),
      autoAdjustTimegrain: true,
      ...(input.aggregation === undefined ? {} : { aggregation: input.aggregation }),
      ...(filter === undefined
        ? {}
        : {
            filter: renderFilter(filter, (v) => (PSEUDONYM.test(v) ? (deps.resolvePseudonym(v) ?? v) : v)),
            top,
          }),
    }),
  );

  const { metrics, seriesTruncated } = toMetricDtos(raw, input.aggregation, top);
  const pointCount = countPoints(metrics);
  // Error rather than downsample: re-aggregating Azure's grains (averages of averages, sums of counts)
  // would silently change what the numbers mean.
  if (pointCount > MAX_POINTS) throw tooManyPoints(pointCount, 'Azure returned');

  return {
    resource: input.name,
    timespan: input.timespan,
    interval: raw.interval ?? interval,
    pointCount,
    metrics,
    seriesTruncated,
  };
}
