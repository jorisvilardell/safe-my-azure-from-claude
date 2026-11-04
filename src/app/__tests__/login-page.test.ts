import { request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FAKE_ACCESS_TOKEN,
  FAKE_USER_CODE,
  FAKE_VERIFICATION_URI,
  createLoginRig,
  flushLogin,
  type StubLoginOptions,
} from '../../../test/helpers/index.js';
import { escapeHtml, renderLoginPage } from '../login-page.js';
import { createHttpApp } from '../server.js';

let server: Server | undefined;

afterEach(async () => {
  await new Promise<void>((resolve) => {
    if (server === undefined) resolve();
    else
      server.close(() => {
        resolve();
      });
  });
  server = undefined;
});

async function start(opts: StubLoginOptions = {}) {
  const rig = createLoginRig(opts);
  const app = createHttpApp({
    host: '127.0.0.1',
    version: '0.0.0-test',
    features: [],
    ctx: rig.ctx,
    logger: rig.ctx.logger,
    loginPageState: () => rig.manager.loginPageState(),
  });
  const listening = app.listen(0, '127.0.0.1');
  server = listening;
  await new Promise<void>((resolve) => listening.once('listening', resolve));
  const { port } = listening.address() as AddressInfo;
  return { ...rig, base: `http://127.0.0.1:${port}`, port };
}

/** Raw request so the Host header can be forged (fetch forbids setting it). */
function get(port: number, path: string, host: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers: { Host: host } }, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => (body += chunk.toString()));
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, body });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

describe('GET /login', () => {
  it('shows pending codes with hardened headers', async () => {
    const { base, manager } = await start();
    manager.startLogin('prod');

    const res = await fetch(`${base}/login`);
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/html/);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain('unsafe-inline');
    expect(res.headers.get('x-frame-options')).toBe('DENY');

    expect(html).toContain('<meta http-equiv="refresh" content="5">');
    expect(html).toContain(`<code>${FAKE_USER_CODE}</code>`);
    expect(html).toContain(`href="${FAKE_VERIFICATION_URI}"`);
    expect(html).toContain('prod');
    expect(html).not.toMatch(/<script|src=|@import|url\(/i);
  });

  it('lists signed-in contexts and never shows the token', async () => {
    const { base, manager, stub } = await start();
    manager.startLogin('lab');
    stub.approve();
    await flushLogin();

    const html = await (await fetch(`${base}/login`)).text();
    expect(html).toContain('No sign-in in progress');
    expect(html).toContain('<td>lab</td><td>30 min</td>');
    expect(html).not.toContain(FAKE_ACCESS_TOKEN);
    expect(html).not.toContain(FAKE_USER_CODE);
  });

  it('escapes values and does not link non-https URIs', async () => {
    const { base, manager } = await start({
      userCode: '<script>alert(1)</script>',
      verificationUri: 'javascript:alert("x")',
    });
    manager.startLogin('prod');

    const html = await (await fetch(`${base}/login`)).text();
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain('javascript:alert(&quot;x&quot;)');
  });

  it('applies the same Host validation as /mcp', async () => {
    const { port } = await start();
    expect((await get(port, '/login', `127.0.0.1:${port}`)).status).toBe(200);
    expect((await get(port, '/login', `localhost:${port}`)).status).toBe(200);

    const forged = await get(port, '/login', 'evil.example');
    expect(forged.status).toBe(403);
    expect((await get(port, '/mcp', 'evil.example')).status).toBe(403);
  });
});

describe('renderLoginPage', () => {
  it('escapes every HTML metacharacter', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  });

  it('shows failed and expired logins without a code', () => {
    const html = renderLoginPage({
      pending: [
        { alias: 'prod', state: 'failed' },
        { alias: 'lab', state: 'expired' },
      ],
      loggedIn: [],
    });
    expect(html).toContain('Sign-in failed.');
    expect(html).toContain('Code expired.');
    expect(html).not.toContain('<code>');
  });
});
