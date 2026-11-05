import { request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FAKE_ACCESS_TOKEN,
  FAKE_CONTEXTS,
  FAKE_USER_CODE,
  FAKE_VERIFICATION_URI,
  createLoginRig,
  expectNoLeak,
  flushLogin,
} from '../../../test/helpers/index.js';
import { generateKeys, type ServerKeys } from '../../core/auth/index.js';
import { createCredentialManager, type AdminLogins } from '../../core/azure/index.js';
import { createLogger } from '../../core/logging/index.js';
import { buildFeatures } from '../features.js';
import { createHttpApp } from '../server.js';

let server: Server | undefined;

afterEach(async () => {
  const s = server;
  server = undefined;
  if (s === undefined) return;
  s.closeAllConnections();
  await new Promise<void>((resolve) => {
    s.close(() => {
      resolve();
    });
  });
});

async function start(opts: { logins?: AdminLogins; codeTimeoutMs?: number } = {}) {
  const rig = createLoginRig();
  const keys: ServerKeys = generateKeys();
  const logins = opts.logins ?? rig.manager;
  const app = createHttpApp({
    host: '127.0.0.1',
    version: '1.2.3-test',
    features: buildFeatures({ version: '1.2.3-test', logins: rig.manager }),
    ctx: rig.ctx,
    logger: rig.ctx.logger,
    keys,
    admin: {
      logins,
      contexts: rig.azure.contexts,
      ...(opts.codeTimeoutMs === undefined ? {} : { codeTimeoutMs: opts.codeTimeoutMs }),
    },
  });
  const listening = app.listen(0, '127.0.0.1');
  server = listening;
  await new Promise<void>((resolve) => listening.once('listening', resolve));
  const { port } = listening.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  const admin = (method: string, path: string, body?: unknown, key: string = keys.admin) =>
    fetch(`${base}/admin${path}`, {
      method,
      headers: {
        authorization: `Bearer ${key}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    });
  const mcp = (headers: Record<string, string> = {}) =>
    fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...headers,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
  return { ...rig, keys, base, port, admin, mcp };
}

/** Raw request so the Host header can be forged (fetch forbids setting it). */
function get(port: number, path: string, host: string, auth?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { Host: host };
    if (auth !== undefined) headers.authorization = auth;
    const req = request({ host: '127.0.0.1', port, path, headers }, (res) => {
      res.resume();
      res.on('end', () => {
        resolve(res.statusCode ?? 0);
      });
    });
    req.on('error', reject);
    req.end();
  });
}

describe('GET /healthz', () => {
  it('needs no key and returns {status, version} only', async () => {
    const { base } = await start();
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', version: '1.2.3-test' });
  });
});

describe('/mcp Bearer auth', () => {
  it.each([
    ['no Authorization header', {}],
    ['a wrong key', { authorization: `Bearer ${generateKeys().mcp}` }],
    ['the admin key', 'admin'],
    ['the key without the Bearer scheme', 'raw'],
  ] as const)('refuses %s with 401, WWW-Authenticate and a JSON-RPC error', async (_name, how) => {
    const { mcp, keys } = await start();
    const headers =
      how === 'admin'
        ? { authorization: `Bearer ${keys.admin}` }
        : how === 'raw'
          ? { authorization: keys.mcp }
          : how;
    const res = await mcp(headers);
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
    const body = (await res.json()) as { jsonrpc: string; error: { code: number; message: string } };
    expect(body).toMatchObject({ jsonrpc: '2.0', id: null, error: { code: -32001 } });
    expect(JSON.stringify(body)).not.toContain(keys.mcp);
  });

  it('accepts the MCP key', async () => {
    const { mcp, keys } = await start();
    const res = await mcp({ authorization: `Bearer ${keys.mcp}` });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('login_status');
  });

  it('also guards GET and DELETE', async () => {
    const { base, keys } = await start();
    expect((await fetch(`${base}/mcp`)).status).toBe(401);
    expect((await fetch(`${base}/mcp`, { method: 'DELETE' })).status).toBe(401);
    const ok = await fetch(`${base}/mcp`, { headers: { authorization: `Bearer ${keys.mcp}` } });
    expect(ok.status).toBe(405);
  });

  it('still checks the Host header first (DNS rebinding)', async () => {
    const { port, keys } = await start();
    expect(await get(port, '/mcp', 'evil.example', `Bearer ${keys.mcp}`)).toBe(403);
    expect(await get(port, '/admin/contexts', 'evil.example', `Bearer ${keys.admin}`)).toBe(403);
    expect(await get(port, '/admin/contexts', `localhost:${port}`, `Bearer ${keys.admin}`)).toBe(200);
  });
});

describe('/login page', () => {
  it('is gone', async () => {
    const { base } = await start();
    expect((await fetch(`${base}/login`)).status).toBe(404);
  });
});

describe('/admin API', () => {
  it.each([
    ['GET', '/contexts'],
    ['POST', '/login'],
    ['GET', '/login/prod'],
    ['POST', '/logout'],
    ['POST', '/use'],
  ])('%s %s needs the admin key (401, no-store), not the MCP key', async (method, path) => {
    const { base, keys, admin, manager } = await start();
    const body = method === 'POST' ? { context: 'prod' } : undefined;
    for (const res of [
      await fetch(`${base}/admin${path}`, { method }),
      await admin(method, path, body, keys.mcp),
      await admin(method, path, body, generateKeys().admin),
    ]) {
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toBe('Bearer');
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(await res.json()).toEqual({
        error: { code: 'Unauthorized', message: 'Missing or invalid admin key.' },
      });
    }
    // A refused POST /admin/login started nothing.
    expect(manager.loginState('prod')).toBe('none');
  });

  it('GET /admin/contexts lists aliases, flags and minutes', async () => {
    const { admin, manager, stub } = await start();
    manager.startLogin('prod');
    stub.approve();
    await flushLogin();
    manager.startLogin('lab');
    const res = await admin('GET', '/contexts');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json();
    expect(body).toEqual([
      {
        alias: 'prod',
        subscriptions: ['prod-app', 'prod-network'],
        active: true,
        loggedIn: true,
        expiresInMinutes: 30,
        loginPending: false,
      },
      { alias: 'lab', subscriptions: ['lab'], active: false, loggedIn: false, loginPending: true },
    ]);
    expectNoLeak(body);
  });

  it('POST /admin/login returns the code, then GET /admin/login/:context reports the state', async () => {
    const { admin, stub, logs, keys } = await start();
    const res = await admin('POST', '/login', { context: 'lab' });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as { expiresAt: string };
    expect(body).toEqual({
      context: 'lab',
      userCode: FAKE_USER_CODE,
      verificationUri: FAKE_VERIFICATION_URI,
      expiresAt: expect.any(String) as unknown,
    });
    const minutes = (Date.parse(body.expiresAt) - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(14);
    expect(minutes).toBeLessThanOrEqual(15);

    expect(await (await admin('GET', '/login/lab')).json()).toEqual({ context: 'lab', state: 'pending' });
    // A second start while pending returns the same code instead of a new flow.
    expect(await (await admin('POST', '/login', { context: 'lab' })).json()).toMatchObject({
      userCode: FAKE_USER_CODE,
    });
    expect(stub.created).toHaveLength(1);

    stub.approve();
    await flushLogin();
    expect(await (await admin('GET', '/login/lab')).json()).toEqual({ context: 'lab', state: 'succeeded' });

    const again = await admin('POST', '/login', { context: 'lab' });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: { code: 'AlreadyLoggedIn' } });

    // The code is a login secret: never logged, and neither are the keys.
    const allLogs = logs.join('\n');
    expect(allLogs).not.toContain(FAKE_USER_CODE);
    expect(allLogs).not.toContain(FAKE_ACCESS_TOKEN);
    expect(allLogs).not.toContain(keys.admin);
    expect(allLogs).not.toContain(keys.mcp);
  });

  it('GET /admin/login/:context reports failed, and 404 when nothing was started', async () => {
    const { admin, stub } = await start();
    const none = await admin('GET', '/login/prod');
    expect(none.status).toBe(404);
    expect(await none.json()).toMatchObject({ error: { code: 'NoLogin' } });

    await admin('POST', '/login', { context: 'prod' });
    stub.fail();
    await flushLogin();
    expect(await (await admin('GET', '/login/prod')).json()).toEqual({ context: 'prod', state: 'failed' });
  });

  it('POST /admin/login answers 504 when Entra ID sends no code in time', async () => {
    const logger = createLogger('error', { write: () => undefined });
    const silent = createCredentialManager({
      contexts: FAKE_CONTEXTS,
      logger,
      factory: () => ({
        authenticate: () => new Promise(() => undefined),
        getToken: () => Promise.resolve(null),
      }),
    });
    const { admin } = await start({ logins: silent, codeTimeoutMs: 20 });
    const res = await admin('POST', '/login', { context: 'prod' });
    expect(res.status).toBe(504);
    expect(await res.json()).toMatchObject({ error: { code: 'LoginTimeout' } });
  });

  it('POST /admin/logout and /admin/use act on the context', async () => {
    const { admin, manager, stub, azure } = await start();
    manager.startLogin('prod');
    stub.approve();
    await flushLogin();

    const out = await admin('POST', '/logout', { context: 'prod' });
    expect(out.status).toBe(200);
    expect(await out.json()).toEqual({ context: 'prod', loggedIn: false });
    expect(manager.isLoggedIn('prod')).toBe(false);

    const use = await admin('POST', '/use', { context: 'lab' });
    expect(use.status).toBe(200);
    expect(await use.json()).toEqual({ active: 'lab', loggedIn: false });
    expect(azure.contexts.active()).toBe('lab');
  });

  it.each([
    ['POST', '/login'],
    ['POST', '/logout'],
    ['POST', '/use'],
  ])('%s %s validates the body and the alias', async (method, path) => {
    const { admin } = await start();
    for (const body of [{}, { context: 'Not An Alias' }, { context: 42 }]) {
      const res = await admin(method, path, body);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: { code: 'InvalidRequest' } });
    }
    const malformed = await admin(method, path, '{"context":');
    expect(malformed.status).toBe(400);
    expect(await malformed.text()).not.toContain('SyntaxError');

    const unknown = await admin(method, path, { context: 'nope' });
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({
      error: { code: 'UnknownContext', message: 'Unknown context "nope". Known contexts: prod, lab.' },
    });
  });

  it('answers unknown admin paths with a JSON 404', async () => {
    const { admin } = await start();
    const res = await admin('GET', '/keys');
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: 'NotFound' } });
  });
});
