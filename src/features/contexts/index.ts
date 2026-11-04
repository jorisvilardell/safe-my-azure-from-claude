import { defineFeature, type Feature } from '../../core/mcp/index.js';
import type { ContextsDeps } from './contexts.service.js';
import { createContextsTools } from './contexts.tools.js';

export function createContextsFeature(deps: ContextsDeps): Feature {
  return defineFeature({
    name: 'contexts',
    description: 'Azure context (tenant alias) switching and device-code login.',
    tools: createContextsTools(deps),
  });
}
