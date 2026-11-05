import type { Server } from 'node:http';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { ErrorRequestHandler, Express } from 'express';
import { createBearerCheck, type ServerKeys } from '../core/auth/index.js';
import type { AdminLogins, ContextStore } from '../core/azure/index.js';
import type { Logger } from '../core/logging/index.js';
import { registerFeatures, UNTRUSTED_NOTICE, type Feature, type ToolContext } from '../core/mcp/index.js';
import { ADMIN_UNAUTHORIZED, createAdminRouter, requireBearer } from './admin-api.js';
import { registerInventoryResource } from './inventory-resource.js';

export interface HttpServerOptions {
  readonly host: string;
  readonly port: number;
  readonly version: string;
  readonly features: readonly Feature[];
  readonly ctx: ToolContext;
  readonly logger: Logger;
  /** `mcp` guards `/mcp`, `admin` guards `/admin/*` (ADR 0001 §1). Memory only, never logged. */
  readonly keys: ServerKeys;
  /** The admin API's view of the logins and contexts. Server-side only, never reachable from a tool. */
  readonly admin: {
    readonly logins: AdminLogins;
    readonly contexts: ContextStore;
    readonly codeTimeoutMs?: number;
  };
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

const MCP_UNAUTHORIZED = {
  jsonrpc: '2.0',
  error: { code: -32001, message: 'Unauthorized: missing or invalid MCP key.' },
  id: null,
} as const;

/**
 * Streamable HTTP, stateless mode (one MCP server + transport per request).
 * Host-header validation protects against DNS rebinding; the port is only
 * published on 127.0.0.1 by docker-compose. The validation middleware is
 * app-wide, so it covers /admin as well as /mcp. Both also need their own Bearer key.
 */
export function createHttpApp(opts: Omit<HttpServerOptions, 'port'>): Express {
  const app = createMcpExpressApp({ host: opts.host, allowedHosts: ['localhost', '127.0.0.1', '[::1]'] });

  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok', version: opts.version });
  });

  app.use('/mcp', requireBearer(createBearerCheck(opts.keys.mcp), MCP_UNAUTHORIZED));

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

  // Human CLI only (safe-azure). The one place a device code is ever returned (AGENTS.md G1).
  app.use(
    '/admin',
    (_req, res, next) => {
      res.set('Cache-Control', 'no-store');
      next();
    },
    requireBearer(createBearerCheck(opts.keys.admin), ADMIN_UNAUTHORIZED),
    createAdminRouter({ ...opts.admin, logger: opts.logger }),
  );

  // Malformed JSON bodies (express.json) and anything else that slipped through: a bare JSON
  // answer, never Express's default page or the error's message.
  // Express spots an error handler by its four parameters, so `_next` must stay.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const onError: ErrorRequestHandler = (err: unknown, _req, res, _next) => {
    const status =
      typeof err === 'object' && err !== null && 'status' in err && typeof err.status === 'number'
        ? err.status
        : 500;
    if (status >= 500) opts.logger.error('http request failed');
    if (!res.headersSent) {
      res.status(status >= 400 && status < 600 ? status : 500).json({
        error: { code: status < 500 ? 'BadRequest' : 'Internal', message: 'Request failed.' },
      });
    }
  };
  app.use(onError);

  return app;
}

export function startHttpServer(opts: HttpServerOptions): Server {
  return createHttpApp(opts).listen(opts.port, opts.host, () => {
    opts.logger.info('server listening', { host: opts.host, port: opts.port });
  });
}
