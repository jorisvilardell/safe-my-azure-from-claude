import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import type { AdminLogins, ContextStore, PendingLogin } from '../core/azure/index.js';
import { AppError } from '../core/errors/index.js';
import type { Logger } from '../core/logging/index.js';

/**
 * `/admin/*` (ADR 0001 §2): the human CLI's API. Not AI-facing, so no anonymizer, but:
 * - every route needs `Authorization: Bearer <admin key>` (see `requireBearer`);
 * - every response is `Cache-Control: no-store`;
 * - the user code is returned by `POST /admin/login` only, and never logged. In broker mode
 *   (AUTH_MODE=broker) there is no code: `POST /admin/login` answers 202 and WAM shows its window.
 */

export interface AdminApiDeps {
  readonly logins: AdminLogins;
  readonly contexts: ContextStore;
  readonly logger: Logger;
  /** How long `POST /admin/login` waits for Entra ID to send the user code. */
  readonly codeTimeoutMs?: number;
}

const DEFAULT_CODE_TIMEOUT_MS = 30_000;

const ALIAS = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/);
const ContextBody = z.object({ context: ALIAS });

export interface AdminError {
  readonly error: { readonly code: string; readonly message: string };
}

const sendError = (res: Response, status: number, code: string, message: string): void => {
  res.status(status).json({ error: { code, message } } satisfies AdminError);
};

/**
 * Bearer auth for a route group. `check` does the constant-time comparison (core/auth).
 * `body` is what a refused request gets, so /mcp can answer in JSON-RPC.
 */
export function requireBearer(
  check: (authorization: string | undefined) => boolean,
  body: unknown,
): RequestHandler {
  return (req, res, next) => {
    if (check(req.headers.authorization)) {
      next();
      return;
    }
    res.status(401).set('WWW-Authenticate', 'Bearer').json(body);
  };
}

export const ADMIN_UNAUTHORIZED: AdminError = {
  error: { code: 'Unauthorized', message: 'Missing or invalid admin key.' },
};

function parseContext(req: Request, res: Response): string | undefined {
  const parsed = ContextBody.safeParse(req.body);
  if (!parsed.success) {
    // The input is not echoed back.
    sendError(res, 400, 'InvalidRequest', 'Expected a JSON body {"context": "<alias>"}.');
    return undefined;
  }
  return parsed.data.context;
}

const codeResponse = (alias: string, p: PendingLogin) =>
  p.state === 'waiting' &&
  p.userCode !== undefined &&
  p.verificationUri !== undefined &&
  p.expiresOn !== undefined
    ? {
        context: alias,
        userCode: p.userCode,
        verificationUri: p.verificationUri,
        expiresAt: new Date(p.expiresOn).toISOString(),
      }
    : undefined;

export function createAdminRouter(deps: AdminApiDeps): Router {
  const router = Router();
  const codeTimeoutMs = deps.codeTimeoutMs ?? DEFAULT_CODE_TIMEOUT_MS;

  /** Turns AppErrors (UnknownContext, ...) into JSON; anything else is a bare 500. */
  const handle =
    (fn: (req: Request, res: Response) => Promise<void> | void): RequestHandler =>
    async (req, res) => {
      try {
        await fn(req, res);
      } catch (err) {
        if (err instanceof AppError) {
          sendError(res, err.code === 'UnknownContext' ? 404 : 409, err.code, err.message);
          return;
        }
        // Never the error itself: it could carry the device-code response.
        deps.logger.error('admin request failed', { path: req.path });
        if (!res.headersSent) sendError(res, 500, 'Internal', 'Internal error.');
      }
    };

  router.get(
    '/contexts',
    handle((_req, res) => {
      res.json(
        deps.contexts.list().map((c) => {
          const status = deps.logins.status(c.alias);
          return {
            alias: c.alias,
            subscriptions: c.subscriptions,
            active: c.active,
            loggedIn: status.loggedIn,
            ...(status.expiresInMinutes === undefined ? {} : { expiresInMinutes: status.expiresInMinutes }),
            loginPending: status.loginPending,
          };
        }),
      );
    }),
  );

  router.post(
    '/login',
    handle(async (req, res) => {
      const alias = parseContext(req, res);
      if (alias === undefined) return;
      if (deps.logins.startLogin(alias) === 'already-logged-in') {
        sendError(res, 409, 'AlreadyLoggedIn', `Context "${alias}" is already logged in.`);
        return;
      }
      if (deps.logins.authMode === 'broker') {
        // No code: the WAM window is open on this desktop. The caller polls GET /admin/login/:context.
        const expiresOn = deps.logins.pendingLogin(alias)?.expiresOn;
        res.status(202).json({
          context: alias,
          authMode: 'broker',
          ...(expiresOn === undefined ? {} : { expiresAt: new Date(expiresOn).toISOString() }),
        });
        return;
      }
      const pending = await deps.logins.waitForDeviceCode(alias, codeTimeoutMs);
      const body = pending === undefined ? undefined : codeResponse(alias, pending);
      if (body !== undefined) {
        // Deliberately not logged: the user code is a login secret (AGENTS.md G1).
        res.json(body);
        return;
      }
      if (deps.logins.status(alias).loggedIn) {
        sendError(res, 409, 'AlreadyLoggedIn', `Context "${alias}" is already logged in.`);
      } else if (pending?.state === 'starting') {
        sendError(res, 504, 'LoginTimeout', 'Microsoft did not send a sign-in code in time. Try again.');
      } else {
        sendError(res, 502, 'LoginFailed', 'The sign-in could not be started. Try again.');
      }
    }),
  );

  router.get(
    '/login/:context',
    handle((req, res) => {
      const parsed = ALIAS.safeParse(req.params.context);
      if (!parsed.success) {
        sendError(res, 400, 'InvalidRequest', 'Invalid context alias.');
        return;
      }
      const state = deps.logins.loginState(parsed.data);
      if (state === 'none') {
        sendError(res, 404, 'NoLogin', `No sign-in was started for context "${parsed.data}".`);
        return;
      }
      res.json({ context: parsed.data, state });
    }),
  );

  router.post(
    '/logout',
    handle((req, res) => {
      const alias = parseContext(req, res);
      if (alias === undefined) return;
      deps.logins.logout(alias);
      res.json({ context: alias, loggedIn: false });
    }),
  );

  router.post(
    '/use',
    handle((req, res) => {
      const alias = parseContext(req, res);
      if (alias === undefined) return;
      deps.contexts.use(alias);
      res.json({ active: alias, loggedIn: deps.logins.status(alias).loggedIn });
    }),
  );

  router.use((_req, res) => {
    sendError(res, 404, 'NotFound', 'Unknown admin endpoint.');
  });

  return router;
}
