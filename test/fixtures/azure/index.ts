import { ACTIVITY_LOG_EVENT } from './activity-log.js';
import { FIRED_ALERT } from './alert.js';
import { LOG_ANALYTICS_TABLE } from './log-analytics.js';
import { METRICS_RESPONSE } from './metrics.js';
import { RESOURCE_GRAPH_RESPONSE } from './resource-graph.js';

export { ACTIVITY_LOG_EVENT, FIRED_ALERT, LOG_ANALYTICS_TABLE, METRICS_RESPONSE, RESOURCE_GRAPH_RESPONSE };
export { createRestError } from './rest-error.js';
export * from './injection.js';
export * from './values.js';

/** Every raw-payload fixture, by name. Add new fixtures here to get them pipeline-tested. */
export const AZURE_PAYLOAD_FIXTURES: Readonly<Record<string, unknown>> = {
  'fired alert': FIRED_ALERT,
  'activity log event': ACTIVITY_LOG_EVENT,
  'metrics response': METRICS_RESPONSE,
  'log analytics table': LOG_ANALYTICS_TABLE,
  'resource graph row': RESOURCE_GRAPH_RESPONSE,
};
