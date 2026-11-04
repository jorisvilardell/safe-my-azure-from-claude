import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { z } from 'zod';

// z.guid(), not z.uuid(): RFC version bits would reject the fake IDs used in docs and tests (R7).
const GUID = z.guid();
const ALIAS = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'alias must be lowercase kebab-case (max 40 chars)');

const ContextSchema = z.object({
  tenantId: GUID,
  subscriptions: z.record(ALIAS, GUID).default({}),
});

export const ContextsFileSchema = z
  .object({
    contexts: z.record(ALIAS, ContextSchema).default({}),
    /** Context active at startup. Must be one of the declared aliases. */
    defaultContext: ALIAS.optional(),
    /** Tag keys whose VALUES may be shown to the AI. Everything else is masked. */
    safeTagKeys: z.array(z.string()).default([]),
  })
  .refine((f) => f.defaultContext === undefined || Object.hasOwn(f.contexts, f.defaultContext), {
    message: 'defaultContext must reference a declared context alias',
    path: ['defaultContext'],
  });

export type ContextsFile = z.infer<typeof ContextsFileSchema>;
export type AzureContext = z.infer<typeof ContextSchema>;

export function parseContexts(yamlText: string): ContextsFile {
  return ContextsFileSchema.parse(parse(yamlText) ?? {});
}

/** Loads contexts.yaml. A missing file yields an empty config (server still starts). */
export async function loadContexts(path: string): Promise<ContextsFile> {
  try {
    return parseContexts(await readFile(path, 'utf8'));
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
      return ContextsFileSchema.parse({});
    }
    throw err;
  }
}

/**
 * Real tenant/subscription ID → the alias the AI sees instead (`tenant-<context>`, `<subscription alias>`).
 * Feed it to `createAnonymizer({ aliases })`.
 */
export function contextIdAliases(contexts: Readonly<Record<string, AzureContext>>): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const [ctxAlias, c] of Object.entries(contexts)) {
    aliases.set(c.tenantId, `tenant-${ctxAlias}`);
    for (const [subAlias, subId] of Object.entries(c.subscriptions)) aliases.set(subId, subAlias);
  }
  return aliases;
}
