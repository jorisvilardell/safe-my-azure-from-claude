import type { Feature } from '../core/mcp/index.js';
import { createSystemFeature } from '../features/system/index.js';

export interface FeatureDeps {
  readonly version: string;
}

/** The list of enabled features. Register new feature slices here (AGENTS.md §2). */
export function buildFeatures(deps: FeatureDeps): Feature[] {
  const features: Feature[] = [];
  features.push(
    createSystemFeature({ version: deps.version, listFeatures: () => features }),
    // createContextsFeature(...), createInventoryFeature(...), ...
  );
  return features;
}
