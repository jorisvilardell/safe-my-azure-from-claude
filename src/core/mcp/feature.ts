import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { z } from 'zod';
import { executeTool, READ_ONLY_ANNOTATIONS, type ToolContext, type ToolDefinition } from './define-tool.js';

/** A vertical slice: one business capability exposing one or more MCP tools. */
export interface Feature {
  readonly name: string;
  readonly description: string;
  readonly tools: readonly ToolDefinition[];
}

export function defineFeature(feature: Feature): Feature {
  return feature;
}

export function registerFeatures(server: McpServer, features: readonly Feature[], ctx: ToolContext): void {
  const seen = new Set<string>();
  for (const feature of features) {
    for (const tool of feature.tools) {
      if (seen.has(tool.name)) throw new Error(`Duplicate tool name: ${tool.name}`);
      seen.add(tool.name);
      server.registerTool(
        tool.name,
        {
          title: tool.title,
          description: tool.description,
          inputSchema: tool.inputSchema,
          annotations: READ_ONLY_ANNOTATIONS,
        },
        (args: z.infer<z.ZodObject<z.ZodRawShape>>) => executeTool(tool, args, ctx),
      );
    }
  }
}
