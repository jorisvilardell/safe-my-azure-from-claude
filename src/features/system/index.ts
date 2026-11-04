import { defineFeature, type Feature } from '../../core/mcp/index.js';
import type { ServerInfoDeps } from './system.service.js';
import { createSystemTools } from './system.tools.js';

/** Reference feature — copy this layout when creating a new one (AGENTS.md §2). */
export function createSystemFeature(deps: ServerInfoDeps): Feature {
  return defineFeature({
    name: 'system',
    description: 'Server metadata and capability discovery.',
    tools: createSystemTools(deps),
  });
}
