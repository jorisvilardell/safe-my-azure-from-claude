import { z } from 'zod';
import { ResourceGroupName, ResourceName, ResourceType, SubscriptionAlias } from '../../core/mcp/index.js';

export const DEFAULT_SEARCH_LIMIT = 50;
export const MAX_SEARCH_LIMIT = 200;

const SUBSCRIPTION = SubscriptionAlias.describe(
  'Subscription ALIAS, as listed by list_subscriptions. Omit to use every subscription of the context.',
);

const RESOURCE_TYPE = ResourceType.describe(
  'Resource type, full (Microsoft.Compute/virtualMachines) or just its last segment (virtualMachines). Case-insensitive.',
);

const LOCATION = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[A-Za-z0-9]+$/, 'location must be an Azure region name such as westeurope')
  .describe('Azure region, e.g. westeurope.');

export const ListSubscriptionsInput = {};

export const ListResourceGroupsInput = { subscription: SUBSCRIPTION.optional() };

export const SearchResourcesInput = {
  name: ResourceName.optional().describe('Part of the resource name (contains, case-insensitive).'),
  type: RESOURCE_TYPE.optional(),
  resourceGroup: ResourceGroupName.optional(),
  location: LOCATION.optional(),
  subscription: SUBSCRIPTION.optional(),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_SEARCH_LIMIT)
    .default(DEFAULT_SEARCH_LIMIT)
    .describe(
      `Maximum number of resources returned (default ${DEFAULT_SEARCH_LIMIT}, max ${MAX_SEARCH_LIMIT}).`,
    ),
};

export const GetResourceInput = {
  resourceGroup: ResourceGroupName,
  name: ResourceName.describe('Exact resource name (case-insensitive).'),
  type: RESOURCE_TYPE.optional(),
  subscription: SUBSCRIPTION.optional(),
};
