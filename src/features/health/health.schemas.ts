import { z } from 'zod';

const SUBSCRIPTION = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'subscription must be an alias (lowercase kebab-case, max 40 chars)')
  .describe('Subscription alias, as listed by list_contexts. Omit to search every subscription.');

const RESOURCE_GROUP = z
  .string()
  .regex(/^[\w\-.()]{1,90}$/, 'resourceGroup must be a resource group name (max 90 chars)')
  .describe('Resource group name.');

export const TIME_RANGES = ['1d', '7d', '30d'] as const;
export const EVENT_TYPES = [
  'ServiceIssue',
  'PlannedMaintenance',
  'HealthAdvisory',
  'SecurityAdvisory',
] as const;
export const EVENT_STATUSES = ['Active', 'Resolved'] as const;
/** Advisor API names. `HighAvailability` is what the portal now calls "Reliability". */
export const ADVISOR_CATEGORIES = [
  'Cost',
  'Security',
  'HighAvailability',
  'Performance',
  'OperationalExcellence',
] as const;
export const ADVISOR_IMPACTS = ['High', 'Medium', 'Low'] as const;
export const MAX_ADVISOR_LIMIT = 100;
export const DEFAULT_ADVISOR_LIMIT = 50;

export const GetResourceHealthInput = {
  resourceGroup: RESOURCE_GROUP,
  name: z
    .string()
    .regex(/^[^\p{Cc}/]{1,260}$/u, 'name must be a resource name (max 260 chars, no "/")')
    .describe('Resource name.'),
  type: z
    .string()
    .regex(/^[A-Za-z0-9.]{1,100}(\/[A-Za-z0-9.]{1,100}){0,4}$/, 'type must be an ARM type')
    .optional()
    .describe('ARM type, e.g. Microsoft.Compute/virtualMachines, or its last segment (virtualMachines).'),
  subscription: SUBSCRIPTION.optional(),
};

export const ListServiceHealthEventsInput = {
  timeRange: z.enum(TIME_RANGES).optional().describe('Events updated within this window. Default 7d.'),
  eventType: z.enum(EVENT_TYPES).optional().describe('Only this event type. Default: all.'),
  status: z.enum(EVENT_STATUSES).optional().describe('Only Active or only Resolved events. Default: both.'),
};

export const ListAdvisorRecommendationsInput = {
  category: z
    .enum(ADVISOR_CATEGORIES)
    .optional()
    .describe('Advisor category. Reliability is HighAvailability.'),
  impact: z.enum(ADVISOR_IMPACTS).optional(),
  resourceGroup: RESOURCE_GROUP.optional().describe(
    'Only recommendations for resources in this resource group.',
  ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_ADVISOR_LIMIT)
    .optional()
    .describe(
      `Maximum recommendations to return (1-${MAX_ADVISOR_LIMIT}). Default ${DEFAULT_ADVISOR_LIMIT}.`,
    ),
};
