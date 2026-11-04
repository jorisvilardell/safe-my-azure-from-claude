import { defineTool, type ToolDefinition } from '../../core/mcp/index.js';
import { buildServerInfo, type ServerInfoDeps } from './system.service.js';

export function createSystemTools(deps: ServerInfoDeps): readonly ToolDefinition[] {
  return [
    defineTool({
      name: 'server_info',
      title: 'Server info',
      description:
        'Describes this MCP server: version, guarantees (read-only, anonymised output) and available features. ' +
        'Call it first to discover capabilities.',
      inputSchema: {},
      handler: () => Promise.resolve(buildServerInfo(deps)),
    }),
  ] as const;
}
