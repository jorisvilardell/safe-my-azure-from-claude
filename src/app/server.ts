import type { Server } from 'node:http';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Logger } from '../core/logging/index.js';
import { registerFeatures, type Feature, type ToolContext } from '../core/mcp/index.js';

export interface HttpServerOptions {
  readonly host: string;
  readonly port: number;
  readonly version: string;
  readonly features: readonly Feature[];
  readonly ctx: ToolContext;
  readonly logger: Logger;
}

export function createMcpServer(opts: Pick<HttpServerOptions, 'version' | 'features' | 'ctx'>): McpServer {
  const server = new McpServer({ name: 'safe-my-azure-from-claude', version: opts.version });
  registerFeatures(server, opts.features, opts.ctx);
  return server;
}

/**
 * Streamable HTTP, stateless mode (one MCP server + transport per request).
 * Host-header validation protects against DNS rebinding; the port is only
 * published on 127.0.0.1 by docker-compose.
 */
export function startHttpServer(opts: HttpServerOptions): Server {
  const app = createMcpExpressApp({ host: opts.host, allowedHosts: ['localhost', '127.0.0.1', '[::1]'] });

  app.post('/mcp', async (req, res) => {
    const server = createMcpServer(opts);
    const transport = new StreamableHTTPServerTransport({}); // no sessionIdGenerator = stateless
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch {
      opts.logger.error('mcp request failed');
      if (!res.headersSent) {
        res
          .status(500)
          .json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
      }
    }
  });

  const methodNotAllowed = (
    _req: unknown,
    res: { status: (n: number) => { json: (b: unknown) => void } },
  ) => {
    res
      .status(405)
      .json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });
  };
  app.get('/mcp', methodNotAllowed);
  app.delete('/mcp', methodNotAllowed);

  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' });
  });

  return app.listen(opts.port, opts.host, () => {
    opts.logger.info('server listening', { host: opts.host, port: opts.port });
  });
}
