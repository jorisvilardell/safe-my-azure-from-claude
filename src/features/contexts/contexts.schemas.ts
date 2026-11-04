import { z } from 'zod';

const ALIAS = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'alias must be lowercase kebab-case (max 40 chars)')
  .describe('Context alias, as listed by list_contexts.');

export const ListContextsInput = {};
export const UseContextInput = { alias: ALIAS };
export const LoginInput = {
  alias: ALIAS.optional().describe('Context alias. Defaults to the active context.'),
};
export const LoginStatusInput = {
  alias: ALIAS.optional().describe('Context alias. Omit to get every context.'),
};
export const LogoutInput = { alias: ALIAS };
