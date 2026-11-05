import { z } from 'zod';
import { ALIAS_PATTERN } from '../config/index.js';

/*
 * Shared zod schemas for the name-based inputs every feature takes (#53). Inputs are names or
 * aliases, never IDs (AGENTS.md checklist 4). KQL literals are escaped by kqlString() anyway: these
 * charsets keep inputs to what Azure names can contain, so quotes, pipes, slashes and newlines are
 * rejected up front, the same way in every feature. Features add their own `.describe()`.
 */

/** Subscription alias from contexts.yaml (lowercase kebab-case), never a subscription ID. */
export const SubscriptionAlias = z
  .string()
  .regex(ALIAS_PATTERN, 'subscription must be an alias (lowercase kebab-case, max 40 chars)')
  .describe('Subscription alias, as listed by list_contexts. Omit to search every subscription.');

/** Azure resource group names: letters, digits, `.`, `_`, `-`, `(`, `)`, at most 90 characters. */
export const ResourceGroupName = z
  .string()
  .regex(
    /^[\p{L}\p{N}._()-]{1,90}$/u,
    'resourceGroup must be a resource group NAME (letters, digits, ".", "_", "-", "(", ")", max 90 chars)',
  )
  .describe('Resource group name (not an ID).');

/** Azure resource names (the longest types allow 260 characters). Never an ARM ID: no `/`. */
export const ResourceName = z
  .string()
  .regex(
    /^[\p{L}\p{N}._()-]{1,260}$/u,
    'name must be a resource NAME (letters, digits, ".", "_", "-", "(", ")", max 260 chars)',
  )
  .describe('Resource name (not an ID), e.g. vm-web-01.');

/** Full ARM type (`Microsoft.Compute/virtualMachines`) or its last segment (`virtualMachines`). */
export const ResourceType = z
  .string()
  .max(200)
  .regex(
    /^[A-Za-z0-9.]{1,100}(\/[A-Za-z0-9.]{1,100}){0,4}$/,
    'type must look like Microsoft.Compute/virtualMachines or virtualMachines',
  )
  .describe(
    'Resource type, full (Microsoft.Compute/virtualMachines) or just its last segment (virtualMachines). ' +
      'Case-insensitive. Needed only when the name is ambiguous.',
  );
