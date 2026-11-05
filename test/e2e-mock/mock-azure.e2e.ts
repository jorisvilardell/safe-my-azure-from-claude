import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as v from '../fixtures/azure/values.js';
import { assertNoLeakWith, CANARIES, LEAK_PATTERNS, toLeakText, type Canary } from '../helpers/index.js';
import { sampleArgs } from '../helpers/schema-sample.js';

/**
 * Drives the REAL container (docker-compose.yml + docker-compose.mock.yml) over MCP, against Azure
 * mocked by Dev Proxy (mocks/devproxy). Run with `npm run test:e2e-mock` once the stack is up.
 *
 *   E2E_MOCK_MODE=chaos  the proxy runs devproxyrc.chaos.json: failures must be clean AppErrors.
 */

const MCP_URL = new URL(process.env.E2E_MCP_URL ?? 'http://127.0.0.1:8765/mcp');
const CHAOS = process.env.E2E_MOCK_MODE === 'chaos';
const PROXY_CONTAINER = process.env.E2E_DEVPROXY_CONTAINER ?? 'azure-safe-devproxy';
const SERVER_CONTAINER = process.env.E2E_SERVER_CONTAINER ?? 'azure-safe-mcp';
/** Set to 0 to skip the `docker logs` assertions (e.g. when the containers run elsewhere). */
const READ_DOCKER_LOGS = process.env.E2E_DOCKER_LOGS !== '0';
/** Longer than the server's own Log Analytics backstop (75 s): a hang shows up as a timeout here. */
const CALL_TIMEOUT_MS = 100_000;

/** Login secrets served by the Entra ID mock (mocks/devproxy/mocks/entra-id.json). */
const MOCK_LOGIN_CANARIES: readonly Canary[] = [
  ['user code', 'FAKEUC7Q2'],
  ['device code', 'FAKE-device-code-not-a-real-secret'],
  ['refresh token', 'FAKE-refresh-token-not-a-real-secret'],
  ['id token', 'eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0'],
  ['client info', 'eyJ1aWQiOiIwMDAwMDAwMC0wMDAwLTAwMDAtMDAwMC0wMDAwMDAwMDAwYzEi'],
];
const ALL_CANARIES = [...CANARIES, ...MOCK_LOGIN_CANARIES];

const expectNoLeak = (output: unknown): void => {
  assertNoLeakWith(output, LEAK_PATTERNS, ALL_CANARIES);
};

/** What a failing tool may say: our own wording, never Azure's (URLs, correlation IDs, subscriptions). */
function expectCleanError(name: string, result: CallToolResult): void {
  const text = toLeakText(result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n'));
  const parsed = JSON.parse(text) as { code?: unknown; message?: unknown };
  expect(typeof parsed.code, `${name}: error code`).toBe('string');
  expect(typeof parsed.message, `${name}: error message`).toBe('string');
  const message = String(parsed.message);
  expect(message, `${name}: Azure's message was forwarded`).not.toMatch(
    /https?:\/\/|correlation|management\.azure|loganalytics|InternalServerError|ServiceUnavailable/i,
  );
}

let client: Client;
let tools: Tool[];
const calls: { name: string; ms: number; isError: boolean }[] = [];

async function call(name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
  const started = Date.now();
  let result: CallToolResult;
  try {
    result = (await client.callTool({ name, arguments: args }, undefined, {
      timeout: CALL_TIMEOUT_MS,
    })) as CallToolResult;
  } catch (err) {
    // A protocol error (or a timeout) reaches the AI too: check it, then fail.
    const message = err instanceof Error ? err.message : String(err);
    expectNoLeak(message);
    throw new Error(`${name} did not return a tool result: ${message}`, { cause: err });
  }
  calls.push({ name, ms: Date.now() - started, isError: result.isError === true });
  expectNoLeak(result);
  if (result.isError === true) expectCleanError(name, result);
  return result;
}

const textOf = (r: CallToolResult): string =>
  r.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
const jsonOf = (r: CallToolResult): unknown => JSON.parse(textOf(r));

/** In the plain run every targeted call must succeed. In chaos, a clean AppError is also fine. */
async function expectOk(
  name: string,
  args: Record<string, unknown>,
  contains: readonly string[],
): Promise<void> {
  const result = await call(name, args);
  if (CHAOS && result.isError === true) return;
  expect(result.isError, `${name} failed: ${textOf(result)}`).not.toBe(true);
  for (const s of contains) expect(textOf(result), `${name} result`).toContain(s);
}

/** stdout + stderr of a container (the server logs to stderr, Dev Proxy to stdout). */
function dockerLogs(container: string): string {
  const res = spawnSync('docker', ['logs', container], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (res.status !== 0) throw new Error(`docker logs ${container} failed: ${res.stderr}`);
  return `${res.stdout}\n${res.stderr}`;
}

beforeAll(async () => {
  client = new Client({ name: 'e2e-mock', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(MCP_URL));
  const listed = await client.listTools();
  expectNoLeak(listed);
  tools = listed.tools;
});

afterAll(async () => {
  await client.close();
  const slowest = [...calls].sort((a, b) => b.ms - a.ms).slice(0, 5);
  process.stdout.write(
    `e2e-mock (${CHAOS ? 'chaos' : 'mocks'}): ${calls.length} calls, ${calls.filter((c) => c.isError).length} errors. ` +
      `Slowest: ${slowest.map((c) => `${c.name} ${c.ms} ms`).join(', ')}\n`,
  );
});

describe(`mocked Azure over MCP (${CHAOS ? 'chaos' : 'mocks'})`, () => {
  it('logs in against the mocked Entra ID device-code flow, with no human', async () => {
    const started = await call('login', { alias: 'prod' });
    expect(textOf(started)).toContain('/login');

    const deadline = Date.now() + 60_000;
    let loggedIn = false;
    while (!loggedIn && Date.now() < deadline) {
      const status = jsonOf(await call('login_status', { alias: 'prod' })) as {
        contexts: { loggedIn: boolean; loginFailed: boolean }[];
      };
      loggedIn = status.contexts.some((c) => c.loggedIn);
      expect(
        status.contexts.some((c) => c.loginFailed),
        'login failed against the Entra ID mock',
      ).toBe(false);
      if (!loggedIn) await new Promise((r) => setTimeout(r, 500));
    }
    expect(loggedIn, 'login did not complete within 60 s').toBe(true);
  });

  it('answers the targeted investigation calls', async () => {
    await expectOk('list_contexts', {}, ['prod']);
    await expectOk('list_subscriptions', {}, ['prod-app', 'Enabled']);
    await expectOk('list_resource_groups', {}, ['rg-app', 'rg-net']);
    await expectOk('search_resources', {}, ['vm-web-01', 'vnet-hub']);
    await expectOk('get_resource', { resourceGroup: 'rg-app', name: 'vm-web-01' }, ['vm-web-01']);
    await expectOk('list_alert_rules', {}, ['cpu-high']);
    await expectOk('get_activity_log', { timespan: 'P1D' }, ['Succeeded']);
    await expectOk('list_metric_definitions', { resourceGroup: 'rg-app', name: 'vm-web-01' }, [
      'Percentage CPU',
    ]);
    await expectOk(
      'get_metrics',
      { resourceGroup: 'rg-app', name: 'vm-web-01', metrics: ['Inbound Flows'], timespan: 'PT1H' },
      ['Inbound Flows'],
    );
    await expectOk('get_resource_health', { resourceGroup: 'rg-app', name: 'vm-web-01' }, ['Degraded']);
    await expectOk('list_service_health_events', {}, ['Virtual Machines']);
    await expectOk('list_advisor_recommendations', {}, ['HighAvailability']);
    await expectOk('list_workspaces', {}, ['log-prod', 'appi-api']);
    await expectOk('list_tables', { workspace: 'log-prod' }, ['Heartbeat']);
    await expectOk('run_kql', { workspace: 'log-prod', query: 'AzureActivity | take 3' }, ['TimeGenerated']);
    // Application Insights: resource-centric query (/v1/<ARM id>/query).
    await expectOk('run_kql', { workspace: 'appi-api', query: 'requests | take 3' }, ['TimeGenerated']);

    const fired = await call('list_fired_alerts', { timeRange: '1d' });
    if (CHAOS && fired.isError === true) return;
    const { alerts } = jsonOf(fired) as { alerts: { alertRef: string }[] };
    expect(alerts.length).toBeGreaterThan(0);
    const [first] = alerts;
    if (first !== undefined) await expectOk('get_alert', { alertRef: first.alertRef }, ['cpu-high']);
  });

  it('calls every tool with schema-generated arguments, without a leak', async () => {
    for (const tool of tools) {
      if (tool.name === 'logout' || tool.name === 'login') continue;
      for (const full of [false, true]) {
        const args = sampleArgs(tool.inputSchema, full) as Record<string, unknown>;
        const result = await call(tool.name, args);
        expect(textOf(result), `generated arguments for ${tool.name} were rejected`).not.toMatch(
          /Input validation error/,
        );
      }
    }
  });

  it('logs out, after which Azure tools say so cleanly', async () => {
    await expectOk('logout', { alias: 'prod' }, ['logged out']);
    const after = await call('search_resources', {});
    expect(after.isError).toBe(true);
    expect(textOf(after)).toContain('NotLoggedIn');
  });

  it.runIf(READ_DOCKER_LOGS)('kept the server logs clean', () => {
    expectNoLeak(dockerLogs(SERVER_CONTAINER));
  });

  it.runIf(READ_DOCKER_LOGS)('sent the real (fake) IDs to Azure: they were stripped, not absent', () => {
    const proxyLog = dockerLogs(PROXY_CONTAINER);
    // Request URLs Dev Proxy logged: the activity log is per subscription, the KQL query per workspace.
    expect(proxyLog.toLowerCase()).toContain(
      `/subscriptions/${v.SUBSCRIPTION_ID}/providers/microsoft.insights`,
    );
    expect(proxyLog.toLowerCase()).toContain(`/workspaces/${v.WORKSPACE_ID}/query`);
    expect(proxyLog).toMatch(
      /login\.microsoftonline\.com\/00000000-0000-0000-0000-0000000000aa\/oauth2\/v2\.0\/token/i,
    );
    if (CHAOS) {
      const early = proxyLog.match(/before waiting for the Retry-After period/g)?.length ?? 0;
      // Parallel requests can trip it without a client bug, so report rather than fail.
      process.stdout.write(`RetryAfterPlugin: ${early} request(s) sent before Retry-After elapsed.\n`);
    }
  });
});
