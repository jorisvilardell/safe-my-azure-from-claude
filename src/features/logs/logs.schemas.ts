import { z } from 'zod';
import { KQL_MAX_QUERY_LENGTH } from '../../core/safety/index.js';

const SUBSCRIPTION = z
  .string()
  .min(1)
  .max(64)
  .describe('Subscription alias, as listed by list_contexts. Omit to search every subscription.');

const WORKSPACE = z
  .string()
  .min(1)
  .max(260)
  .describe('Workspace or Application Insights NAME, as listed by list_workspaces.');

const RESOURCE_GROUP = z
  .string()
  .min(1)
  .max(90)
  .describe('Resource group of the workspace. Only needed when the name is ambiguous.');

const TIMESPAN = z
  .string()
  .min(1)
  .max(100)
  .describe(
    'Time window: ISO 8601 duration (PT1H, P1D, max P7D) or "<start>/<end>" in ISO 8601 UTC. Default P1D. ' +
      'It bounds the data whatever the query says.',
  );

export const ListWorkspacesInput = { subscription: SUBSCRIPTION.optional() };

export const ListTablesInput = {
  workspace: WORKSPACE,
  resourceGroup: RESOURCE_GROUP.optional(),
  subscription: SUBSCRIPTION.optional(),
};

export const RunKqlInput = {
  workspace: WORKSPACE,
  query: z
    .string()
    .min(1)
    .max(KQL_MAX_QUERY_LENGTH)
    .describe(
      'Read-only KQL. Management commands, cross-workspace and external data functions are rejected.',
    ),
  timespan: TIMESPAN.optional(),
  resourceGroup: RESOURCE_GROUP.optional(),
  subscription: SUBSCRIPTION.optional(),
};
