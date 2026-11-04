import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { z } from 'zod';
import { scrub, type Pseudonymizer } from '../anonymizer/index.js';
import type { AzureAccess } from '../azure/index.js';
import { sanitizeError } from '../errors/index.js';
import type { Logger } from '../logging/index.js';

/** Shared dependencies handed to every tool handler. Extend here, not per feature. */
export interface ToolContext {
  readonly pseudonymizer: Pseudonymizer;
  readonly logger: Logger;
  readonly azure: AzureAccess;
}

export interface ToolDefinition<S extends z.ZodRawShape = z.ZodRawShape> {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: S;
  readonly handler: (args: z.infer<z.ZodObject<S>>, ctx: ToolContext) => Promise<unknown>;
}

/** Every tool is read-only by construction (AGENTS.md R2). */
export const READ_ONLY_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

/**
 * The ONLY way to declare an MCP tool in this project (AGENTS.md R3).
 * Output is always scrubbed; errors are always sanitised.
 */
export function defineTool<S extends z.ZodRawShape>(def: ToolDefinition<S>): ToolDefinition<S> {
  return def;
}

/** Runs a tool handler through the mandatory `handler → scrub → sanitizeError` pipeline. */
export async function executeTool<S extends z.ZodRawShape>(
  def: ToolDefinition<S>,
  args: z.infer<z.ZodObject<S>>,
  ctx: ToolContext,
): Promise<CallToolResult> {
  try {
    const result = await def.handler(args, ctx);
    return { content: [{ type: 'text', text: JSON.stringify(scrub(result, ctx.pseudonymizer), null, 2) }] };
  } catch (err) {
    const safe = sanitizeError(err);
    ctx.logger.warn('tool failed', { tool: def.name, code: safe.code });
    return {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify(scrub(safe, ctx.pseudonymizer)) }],
    };
  }
}
