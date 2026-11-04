import { defineFeature, type Feature } from '../../core/mcp/index.js';
import { createInventoryTools } from './inventory.tools.js';

export function createInventoryFeature(): Feature {
  return defineFeature({
    name: 'inventory',
    description: 'Subscriptions, resource groups and resource search (Azure Resource Graph, read-only).',
    tools: createInventoryTools(),
  });
}
