import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { z } from 'zod';

const GUID = z.uuid();
const ALIAS = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'alias must be lowercase kebab-case (max 40 chars)');

const ContextSchema = z.object({
  tenantId: GUID,
  subscriptions: z.record(ALIAS, GUID).default({}),
});

export const ContextsFileSchema = z.object({
  contexts: z.record(ALIAS, ContextSchema).default({}),
  /** Tag keys whose VALUES may be shown to the AI. Everything else is masked. */
  safeTagKeys: z.array(z.string()).default([]),
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
