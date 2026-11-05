import { once } from 'node:events';
import { request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildFeatures } from '../../src/app/features.js';
import { startHttpServer } from '../../src/app/server.js';
import { generateKeys } from '../../src/core/auth/index.js';
import { INVENTORY_QUERY } from '../../src/core/azure/index.js';
import * as v from '../fixtures/azure/values.js';
import { createAnonymizer } from '../../src/core/anonymizer/index.js';
import { contextIdAliases } from '../../src/core/config/index.js';
import { createAuditLog, createLogger } from '../../src/core/logging/index.js';
import { UNTRUSTED_NOTICE } from '../../src/core/mcp/index.js';
import { INVISIBLE_IN_OUTPUT } from '../fixtures/azure/index.js';
import { INJECTED_RESOURCE, plantInjections, SAFE_TAG_KEY } from './injected-azure.js';
import {
  createFakeAzureAccess,
  createLoginRig,
  createTestToolContext,
  expectNoLeak,
  FAKE_CONTEXTS,
  FAKE_RESOURCES,
  FAKE_USER_CODE,
  toLeakText,
} from '../helpers/index.js';
import { sampleArgs } from '../helpers/schema-sample.js';

/**
 * End-to-end leak harness: every tool registered by `buildFeatures` is called over real MCP
 * Streamable HTTP, with arguments generated from its advertised JSON schema, in several fake
 * Azure states. New tools are picked up automatically; do not list them here.
 */

const VERSION = '0.0.0-test';

const SUB = FAKE_CONTEXTS.prod?.subscriptions['prod-app'] ?? '';
/** What the inventory index reads: IDs, tenant, tags with emails, public IPs, a GUID in a name. */
const LEAKY_INVENTORY_ROWS: readonly unknown[] = [
  {
    id: `/subscriptions/${SUB}/resourceGroups/rg-app`,
    name: 'rg-app',
    type: 'microsoft.resources/subscriptions/resourcegroups',
    resourceGroup: 'rg-app',
    subscriptionId: SUB,
    location: 'westeurope',
    tags: { owner: v.OWNER_EMAIL },
  },
  {
    id: v.VM_ARM_ID,
    name: 'vm-web-01',
    type: 'microsoft.compute/virtualmachines',
    resourceGroup: 'rg-app',
    subscriptionId: SUB,
    tenantId: v.TENANT_ID,
    location: 'westeurope',
    tags: { owner: v.OWNER_EMAIL, 'created-by': v.CALLER_EMAIL },
  },
  {
    id: `/subscriptions/${SUB}/resourceGroups/rg-app/providers/Microsoft.Network/publicIPAddresses/pip-web`,
    name: 'pip-web',
    type: 'microsoft.network/publicipaddresses',
    resourceGroup: 'rg-app',
    subscriptionId: SUB,
    location: 'westeurope',
    ipAddress: v.PUBLIC_IP_CLIENT,
  },
  {
    id: `/subscriptions/${SUB}/resourceGroups/rg-app/providers/Microsoft.Network/networkSecurityGroups/nsg-${v.VM_ID}`,
    name: `nsg-allow-${v.PUBLIC_IP_PEER}-${v.VM_ID}`,
    type: 'microsoft.network/networksecuritygroups',
    resourceGroup: 'rg-app',
    subscriptionId: SUB,
    location: 'westeurope',
  },
];
// Stubbed device-code login: the contexts tools run for real, without touching Azure.
const loginRig = createLoginRig();
const features = buildFeatures({ version: VERSION, logins: loginRig.manager });
const keys = generateKeys();
const admin = { logins: loginRig.manager, contexts: loginRig.azure.contexts };
/** What `safe-azure mcp` adds to every request. */
const authorized = (url: URL): StreamableHTTPClientTransport =>
  new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { authorization: `Bearer ${keys.mcp}` } },
  });
const TOOL_NAMES = features.flatMap((f) => f.tools.map((t) => t.name));

// The inventory index is on, so the tools also run their "served from memory" path.
// Schema-generated arguments use "vm-web-01" for every string, resource group included.
const leakyRows = ({ query }: { query: string }): readonly unknown[] =>
  query === INVENTORY_QUERY ? LEAKY_INVENTORY_ROWS : [];
const azure = createFakeAzureAccess({
  inventory: {},
  resources: [...FAKE_RESOURCES, INJECTED_RESOURCE],
  resourceGraphRows: leakyRows,
});
const logLines: string[] = [];
const auditLines: string[] = [];
const anonymizerConfig = { aliases: contextIdAliases(FAKE_CONTEXTS), safeTagKeys: [SAFE_TAG_KEY] };
const ctx = createTestToolContext({
  azure,
  anonymizer: createAnonymizer(anonymizerConfig),
  logger: createLogger('debug', { write: (line) => logLines.push(line) }),
  audit: createAuditLog({
    mode: 'stderr',
    anonymizer: createAnonymizer(anonymizerConfig),
    write: (line) => auditLines.push(line),
  }),
});

/** Tool output in the "injected" state, by tool name (both argument variants). */
const injectedOutputs = new Map<string, string[]>();
let currentState = '';

let server: Server;
let baseUrl: URL;
let client: Client;
let listedTools: Tool[];

beforeAll(async () => {
  server = startHttpServer({
    host: '127.0.0.1',
    port: 0,
    version: VERSION,
    features,
    ctx,
    logger: ctx.logger,
    keys,
    admin,
  });
  if (!server.listening) await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  baseUrl = new URL(`http://127.0.0.1:${port}/mcp`);

  client = new Client({ name: 'leak-harness', version: VERSION });
  await client.connect(authorized(baseUrl));
  const listed = await client.listTools();
  expectNoLeak(listed);
  listedTools = listed.tools;
});

afterAll(async () => {
  await client.close();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
  // Server logs go to stderr in production, which an agent may read: they must be clean too.
  expectNoLeak(logLines);
  expectNoLeak(auditLines);
  for (const line of [...logLines, ...auditLines]) {
    expect(line).not.toContain(keys.mcp);
    expect(line).not.toContain(keys.admin);
  }
});

async function callAndCheck(tool: Tool, full: boolean): Promise<void> {
  const args = sampleArgs(tool.inputSchema, full) as Record<string, unknown>;
  let output: unknown;
  try {
    output = await client.callTool({ name: tool.name, arguments: args });
  } catch (err) {
    // Protocol-level errors reach the AI too.
    output = err instanceof Error ? err.message : err;
  }
  const text = toLeakText(output);
  expect(text, `generated arguments for ${tool.name} were rejected`).not.toMatch(/Input validation error/);
  expectNoLeak(output);
  if (currentState === 'injected') {
    injectedOutputs.set(tool.name, [...(injectedOutputs.get(tool.name) ?? []), text]);
  }
}

const STATES: readonly (readonly [string, () => void])[] = [
  [
    'logged in',
    () => {
      // Undo a previous "injected" state: logout drops the cached inventory snapshot.
      for (const alias of Object.keys(FAKE_CONTEXTS)) azure.logout(alias);
      azure.setResourceGraphRows(leakyRows);
      for (const alias of Object.keys(FAKE_CONTEXTS)) azure.login(alias);
    },
  ],
  [
    'logged out',
    () => {
      for (const alias of Object.keys(FAKE_CONTEXTS)) azure.logout(alias);
    },
  ],
  [
    // Every free-text field from Azure carries a prompt-injection payload (#39).
    'injected',
    () => {
      for (const alias of Object.keys(FAKE_CONTEXTS)) azure.login(alias);
      plantInjections(azure);
    },
  ],
];

describe('MCP over HTTP: every tool, every state, no leak', () => {
  it('tools/list advertises exactly the tools of all features', () => {
    expect(TOOL_NAMES.length).toBeGreaterThan(0);
    expect(listedTools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
  });

  describe.each(STATES)('%s', (state, enter) => {
    it.each(TOOL_NAMES)('%s', async (name) => {
      enter();
      currentState = state;
      const tool = listedTools.find((t) => t.name === name);
      expect(tool, `${name} missing from tools/list`).toBeDefined();
      if (tool === undefined) return;
      await callAndCheck(tool, false);
      await callAndCheck(tool, true);
    });
  });
});

describe('MCP inventory resource', () => {
  it('is off by default: no resources capability, resources/list is refused', async () => {
    expect(client.getServerCapabilities()?.resources).toBeUndefined();
    const err: unknown = await client.listResources().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expectNoLeak(err instanceof Error ? err.message : err);
  });

  describe('when INVENTORY_RESOURCE=on', () => {
    let resourceServer: Server;
    let resourceClient: Client;

    beforeAll(async () => {
      resourceServer = startHttpServer({
        host: '127.0.0.1',
        port: 0,
        version: VERSION,
        features,
        ctx,
        logger: ctx.logger,
        inventoryResource: true,
        keys,
        admin,
      });
      if (!resourceServer.listening) await once(resourceServer, 'listening');
      const { port } = resourceServer.address() as AddressInfo;
      resourceClient = new Client({ name: 'leak-harness-resources', version: VERSION });
      await resourceClient.connect(authorized(new URL(`http://127.0.0.1:${port}/mcp`)));
    });

    afterAll(async () => {
      await resourceClient.close();
      resourceServer.closeAllConnections();
      await new Promise<void>((resolve) =>
        resourceServer.close(() => {
          resolve();
        }),
      );
    });

    const URIS = [
      ...Object.keys(FAKE_CONTEXTS).map((alias) => `azure://inventory/${alias}`),
      'azure://inventory/nope',
      `azure://inventory/${SUB}`,
    ];

    describe.each(STATES)('%s', (state, enter) => {
      it('resources/list and resources/read never leak', async () => {
        enter();
        const listed = await resourceClient.listResources();
        expectNoLeak(listed);
        expect(listed.resources.map((r) => r.uri)).toEqual(
          Object.keys(FAKE_CONTEXTS).map((alias) => `azure://inventory/${alias}`),
        );
        expectNoLeak(await resourceClient.listResourceTemplates());

        for (const uri of URIS) {
          let output: unknown;
          try {
            output = await resourceClient.readResource({ uri });
          } catch (err) {
            output = err instanceof Error ? err.message : err;
          }
          expectNoLeak(output);
        }

        // Not vacuous: logged in, the active context's names really are listed.
        const prod = toLeakText(await resourceClient.readResource({ uri: 'azure://inventory/prod' }));
        if (state === 'logged in') {
          expect(prod).toContain('rg-app/microsoft.compute/virtualmachines/vm-web-01');
          expect(prod).toContain('nsg-allow-public-ip-');
          expect(prod).not.toContain('rg-app/microsoft.resources');
        } else if (state === 'logged out') {
          expect(prod).toContain('NotLoggedIn');
        } else {
          expect(prod).not.toContain('NotLoggedIn');
        }
      });
    });
  });
});

/** Tools that copy Azure free text: in the "injected" state, each must flag the payloads. */
const FLAGGING_TOOLS = [
  'search_resources',
  'get_resource',
  'list_fired_alerts',
  'get_activity_log',
  'run_kql',
  'list_metric_definitions',
  'get_metrics',
  'get_resource_health',
  'list_service_health_events',
  'list_advisor_recommendations',
];

describe('prompt injection in tool results (#39)', () => {
  it('every advertised tool description starts with the untrusted-data notice', () => {
    for (const tool of listedTools) expect(tool.description?.startsWith(UNTRUSTED_NOTICE)).toBe(true);
  });

  it('no output of any tool contains an invisible or control character', () => {
    expect(injectedOutputs.size).toBe(TOOL_NAMES.length);
    for (const [name, outputs] of injectedOutputs) {
      for (const text of outputs) expect(text, name).not.toMatch(INVISIBLE_IN_OUTPUT);
    }
  });

  it.each(FLAGGING_TOOLS)('%s flags the planted payloads in a top-level warnings field', (name) => {
    const outputs = injectedOutputs.get(name) ?? [];
    expect(
      outputs.some((t) => t.includes('Possible prompt injection in ')),
      `${name}: ${outputs.join('\n').slice(0, 600)}`,
    ).toBe(true);
  });

  it('audits every call, with the injection-warning count', () => {
    const lines = auditLines.map((l) => JSON.parse(l) as { tool: string; injectionWarnings: number });
    expect(new Set(lines.map((l) => l.tool))).toEqual(new Set(TOOL_NAMES));
    expect(lines.some((l) => l.injectionWarnings > 0)).toBe(true);
  });
});

describe('sign-in over MCP and the admin API', () => {
  it('the login tool never returns the code, which only POST /admin/login does', async () => {
    const adminRes = await fetch(new URL('/admin/login', baseUrl), {
      method: 'POST',
      headers: { authorization: `Bearer ${keys.admin}`, 'content-type': 'application/json' },
      body: JSON.stringify({ context: 'lab' }),
    });
    expect(adminRes.status).toBe(200);
    expect(await adminRes.json()).toMatchObject({ context: 'lab', userCode: FAKE_USER_CODE });

    const result = await client.callTool({ name: 'login', arguments: { alias: 'lab' } });
    const text = toLeakText(result);
    expectNoLeak(result);
    expect(text).not.toContain(FAKE_USER_CODE);
    expect(text).toContain('safe-azure login lab');
    loginRig.manager.logout('lab');
  });
});

describe('HTTP transport hardening', () => {
  it('rejects a foreign Host header with 403 (DNS rebinding)', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const { status, text } = await new Promise<{ status: number | undefined; text: string }>(
      (resolve, reject) => {
        const req = request(
          baseUrl,
          {
            method: 'POST',
            headers: {
              host: 'evil.example:8765',
              'content-type': 'application/json',
              accept: 'application/json, text/event-stream',
            },
          },
          (res) => {
            let data = '';
            res.setEncoding('utf8');
            res.on('data', (chunk: string) => (data += chunk));
            res.on('end', () => {
              resolve({ status: res.statusCode, text: data });
            });
          },
        );
        req.on('error', reject);
        req.end(body);
      },
    );
    expect(status).toBe(403);
    expectNoLeak(text);
  });

  it('answers GET /mcp with 405', async () => {
    const res = await fetch(baseUrl, {
      headers: { accept: 'text/event-stream', authorization: `Bearer ${keys.mcp}` },
    });
    expect(res.status).toBe(405);
    expectNoLeak(await res.text());
  });

  it('refuses an MCP client without the key with 401', async () => {
    const anonymous = new Client({ name: 'no-key', version: VERSION });
    const err: unknown = await anonymous
      .connect(new StreamableHTTPClientTransport(baseUrl))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expectNoLeak(err instanceof Error ? err.message : err);

    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
    expect(await res.json()).toMatchObject({ jsonrpc: '2.0', error: { code: -32001 }, id: null });
  });

  it('refuses the admin key on /mcp and the MCP key on /admin', async () => {
    const asAdmin = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${keys.admin}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(asAdmin.status).toBe(401);
    const adminUrl = new URL('/admin/contexts', baseUrl);
    const asMcp = await fetch(adminUrl, { headers: { authorization: `Bearer ${keys.mcp}` } });
    expect(asMcp.status).toBe(401);
  });
});
