import type { LoginController } from '../core/azure/index.js';
import type { Feature } from '../core/mcp/index.js';
import { createContextsFeature } from '../features/contexts/index.js';
import { createInventoryFeature } from '../features/inventory/index.js';
import { createSystemFeature } from '../features/system/index.js';

export interface FeatureDeps {
  readonly version: string;
  readonly logins: LoginController;
  /** Absolute URL of the /login page, built from config. */
  readonly loginUrl: string;
}

/** The list of enabled features. Register new feature slices here (AGENTS.md §2). */
export function buildFeatures(deps: FeatureDeps): Feature[] {
  const features: Feature[] = [];
  features.push(
    createSystemFeature({ version: deps.version, listFeatures: () => features }),
    createContextsFeature({ logins: deps.logins, loginUrl: deps.loginUrl }),
    createInventoryFeature(),
    // createInventoryFeature(...), ...
  );
  return features;
}
