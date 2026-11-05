import type { LoginController } from '../core/azure/index.js';
import type { Feature } from '../core/mcp/index.js';
import { createAlertsFeature } from '../features/alerts/index.js';
import { createContextsFeature } from '../features/contexts/index.js';
import { createHealthFeature } from '../features/health/index.js';
import { createInventoryFeature } from '../features/inventory/index.js';
import { createLogsFeature } from '../features/logs/index.js';
import { createMetricsFeature } from '../features/metrics/index.js';
import { createSystemFeature } from '../features/system/index.js';

export interface FeatureDeps {
  readonly version: string;
  /** Status and logout only: the AI-facing tools can never start a sign-in or see a code. */
  readonly logins: LoginController;
}

/** The list of enabled features. Register new feature slices here (AGENTS.md §2). */
export function buildFeatures(deps: FeatureDeps): Feature[] {
  const features: Feature[] = [];
  features.push(
    createSystemFeature({ version: deps.version, listFeatures: () => features }),
    createContextsFeature({ logins: deps.logins }),
    createInventoryFeature(),
    createAlertsFeature(),
    createMetricsFeature(),
    createLogsFeature(),
    createHealthFeature(),
  );
  return features;
}
