import { defineFeature, type Feature } from '../../core/mcp/index.js';
import { createLogsTools } from './logs.tools.js';

export function createLogsFeature(): Feature {
  return defineFeature({
    name: 'logs',
    description: 'Read-only, guarded KQL on Log Analytics workspaces and Application Insights.',
    tools: createLogsTools(),
  });
}
