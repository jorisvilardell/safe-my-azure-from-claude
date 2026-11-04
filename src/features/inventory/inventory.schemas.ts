import { z } from 'zod';

export const DEFAULT_SEARCH_LIMIT = 50;
export const MAX_SEARCH_LIMIT = 200;

// Safe charsets: KQL literals are escaped by kqlString() anyway; these keep inputs to what
// Azure names can actually contain, so quotes, pipes and newlines are rejected up front.
const SUBSCRIPTION = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'subscription must be an alias (lowercase kebab-case, max 40 chars)')
  .describe(
    'Subscription ALIAS, as listed by list_subscriptions. Omit to use every subscription of the context.',
  );

const RESOURCE_NAME = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\p{L}\p{N}._()-]+$/u, 'name may only contain letters, digits, ".", "_", "-", "(" and ")"');

const RESOURCE_GROUP = z
  .string()
  .min(1)
  .max(90)
  .regex(
    /^[\p{L}\p{N}._()-]+$/u,
    'resourceGroup may only contain letters, digits, ".", "_", "-", "(" and ")"',
  )
  .describe('Resource group name.');

const RESOURCE_TYPE = z
  .string()
  .min(1)
  .max(200)
  .regex(
    /^[A-Za-z0-9.]+(\/[A-Za-z0-9.]+)*$/,
    'type must look like Microsoft.Compute/virtualMachines or virtualMachines',
  )
  .describe(
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
  name: RESOURCE_NAME.optional().describe('Part of the resource name (contains, case-insensitive).'),
  type: RESOURCE_TYPE.optional(),
  resourceGroup: RESOURCE_GROUP.optional(),
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
  resourceGroup: RESOURCE_GROUP,
  name: RESOURCE_NAME.describe('Exact resource name (case-insensitive).'),
  type: RESOURCE_TYPE.optional(),
  subscription: SUBSCRIPTION.optional(),
};
