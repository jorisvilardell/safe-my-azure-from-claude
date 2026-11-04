import { defineFeature, type Feature } from '../../core/mcp/index.js';
import { createMetricsTools } from './metrics.tools.js';

export function createMetricsFeature(): Feature {
  return defineFeature({
    name: 'metrics',
    description: 'Azure Monitor metric definitions and metric values for a resource.',
    tools: createMetricsTools(),
  });
}
