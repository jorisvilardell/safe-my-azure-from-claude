import { once } from 'node:events';
import { request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildFeatures } from '../../src/app/features.js';
import { startHttpServer } from '../../src/app/server.js';
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
  toLeakText,
} from '../helpers/index.js';

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
const features = buildFeatures({
  version: VERSION,
  logins: loginRig.manager,
  loginUrl: 'http://127.0.0.1:8765/login',
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
    loginPageState: () => loginRig.manager.loginPageState(),
  });
  if (!server.listening) await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  baseUrl = new URL(`http://127.0.0.1:${port}/mcp`);

  client = new Client({ name: 'leak-harness', version: VERSION });
  await client.connect(new StreamableHTTPClientTransport(baseUrl));
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
});

// ---------------------------------------------------------------------------------------------
// Minimal valid arguments from a JSON schema.

type JsonObject = Record<string, unknown>;

const isObject = (v: unknown): v is JsonObject => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);

/** Plausible names and aliases from the fake contexts, tried in order against `pattern`/length limits. */
const STRING_CANDIDATES = [
  'vm-web-01',
  'prod',
  'prod-app',
  'rg-app',
  'Microsoft.Compute/virtualMachines',
  'PT1H',
  'P1D',
  'Heartbeat | take 1',
];

function sampleString(schema: JsonObject): string {
  switch (schema.format) {
    case 'date-time':
      return '2026-11-03T08:00:00Z';
    case 'date':
      return '2026-11-03';
    case 'duration':
      return 'PT1H';
    case 'uuid':
      return '00000000-0000-0000-0000-000000000099';
    case 'uri':
    case 'url':
      return 'https://example.com/';
    case 'email':
      return 'user@example.com';
  }
  const min = num(schema.minLength) ?? 0;
  const max = num(schema.maxLength) ?? Infinity;
  const pattern = typeof schema.pattern === 'string' ? new RegExp(schema.pattern, 'u') : undefined;
  const fits = (s: string): boolean => s.length >= min && s.length <= max && (pattern?.test(s) ?? true);
  return STRING_CANDIDATES.find(fits) ?? 'a'.repeat(Math.max(min, 1));
}

function sampleNumber(schema: JsonObject, integer: boolean): number {
  const lo = num(schema.minimum) ?? (num(schema.exclusiveMinimum) ?? 0) + 1;
  const hi = num(schema.maximum) ?? (num(schema.exclusiveMaximum) ?? Infinity) - 1;
  const value = Math.min(Math.max(lo, 1), hi);
  return integer ? Math.ceil(value) : value;
}

/** `full` also fills optional properties, to reach code paths behind them. */
function sample(schema: unknown, full: boolean): unknown {
  if (!isObject(schema)) return 'vm-web-01';
  if ('const' in schema) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  if ('default' in schema) return schema.default;

  const variants = schema.anyOf ?? schema.oneOf ?? schema.allOf;
  if (Array.isArray(variants)) {
    const first: unknown = variants.find((s) => !isObject(s) || s.type !== 'null') ?? variants[0];
    return sample(first, full);
  }

  const type: unknown = Array.isArray(schema.type)
    ? (schema.type as unknown[]).find((t) => t !== 'null')
    : schema.type;
  switch (type) {
    case 'object': {
      const props = isObject(schema.properties) ? schema.properties : {};
      const required = Array.isArray(schema.required) ? schema.required : [];
      return Object.fromEntries(
        Object.entries(props)
          .filter(([key]) => full || required.includes(key))
          .map(([key, prop]) => [key, sample(prop, full)]),
      );
    }
    case 'array': {
      const count = Math.min(Math.max(num(schema.minItems) ?? 0, 1), num(schema.maxItems) ?? 1);
      return Array.from({ length: count }, () => sample(schema.items, full));
    }
    case 'integer':
      return sampleNumber(schema, true);
    case 'number':
      return sampleNumber(schema, false);
    case 'boolean':
      return false;
    case 'null':
      return null;
    default:
      return sampleString(schema);
  }
}

// ---------------------------------------------------------------------------------------------

async function callAndCheck(tool: Tool, full: boolean): Promise<void> {
  const args = sample(tool.inputSchema, full) as Record<string, unknown>;
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
        loginPageState: () => loginRig.manager.loginPageState(),
      });
      if (!resourceServer.listening) await once(resourceServer, 'listening');
      const { port } = resourceServer.address() as AddressInfo;
      resourceClient = new Client({ name: 'leak-harness-resources', version: VERSION });
      await resourceClient.connect(
        new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)),
      );
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
    const res = await fetch(baseUrl, { headers: { accept: 'text/event-stream' } });
    expect(res.status).toBe(405);
    expectNoLeak(await res.text());
  });
});
