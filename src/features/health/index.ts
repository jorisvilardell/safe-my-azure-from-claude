import { defineFeature, type Feature } from '../../core/mcp/index.js';
import type { HealthDeps } from './health.service.js';
import { createHealthTools } from './health.tools.js';

export function createHealthFeature(deps: HealthDeps = {}): Feature {
  return defineFeature({
    name: 'health',
    description: 'Azure Resource Health, Service Health events and Advisor recommendations.',
    tools: createHealthTools(deps),
  });
}
