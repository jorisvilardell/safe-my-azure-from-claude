import { defineFeature, type Feature } from '../../core/mcp/index.js';
import { createAlertsTools } from './alerts.tools.js';

export function createAlertsFeature(): Feature {
  return defineFeature({
    name: 'alerts',
    description: 'Fired alerts, alert rules and the activity log: what fired, and what changed around it.',
    tools: createAlertsTools(),
  });
}
