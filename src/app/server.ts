import type { Server } from 'node:http';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Express } from 'express';
import type { LoginPageState } from '../core/azure/index.js';
import type { Logger } from '../core/logging/index.js';
import { registerFeatures, UNTRUSTED_NOTICE, type Feature, type ToolContext } from '../core/mcp/index.js';
import { registerInventoryResource } from './inventory-resource.js';
import { LOGIN_PAGE_HEADERS, renderLoginPage } from './login-page.js';

export interface HttpServerOptions {
  readonly host: string;
  readonly port: number;
  readonly version: string;
  readonly features: readonly Feature[];
  readonly ctx: ToolContext;
  readonly logger: Logger;
  /** Pending device-code logins for the /login page. Server-side only. */
  readonly loginPageState: () => LoginPageState;
  /** Exposes the `azure://inventory/<context>` MCP resource. Off unless `INVENTORY_RESOURCE=on`. */
  readonly inventoryResource?: boolean;
}

export function createMcpServer(
  opts: Pick<HttpServerOptions, 'version' | 'features' | 'ctx' | 'inventoryResource'>,
): McpServer {
  const server = new McpServer(
    { name: 'safe-my-azure-from-claude', version: opts.version },
    { instructions: UNTRUSTED_NOTICE },
  );
  registerFeatures(server, opts.features, opts.ctx);
  if (opts.inventoryResource === true) registerInventoryResource(server, opts.ctx);
  return server;
}

/**
 * Streamable HTTP, stateless mode (one MCP server + transport per request).
 * Host-header validation protects against DNS rebinding; the port is only
 * published on 127.0.0.1 by docker-compose. The validation middleware is
 * app-wide, so it covers /login as well as /mcp.
 */
export function createHttpApp(opts: Omit<HttpServerOptions, 'port'>): Express {
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

  // Human-only page showing device codes. Never reachable through an MCP tool (AGENTS.md G1).
  app.get('/login', (_req, res) => {
    res.set(LOGIN_PAGE_HEADERS).send(renderLoginPage(opts.loginPageState()));
  });

  return app;
}

export function startHttpServer(opts: HttpServerOptions): Server {
  return createHttpApp(opts).listen(opts.port, opts.host, () => {
    opts.logger.info('server listening', { host: opts.host, port: opts.port });
  });
}
