import { once } from 'node:events';
import { request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildFeatures } from '../../src/app/features.js';
import { startHttpServer } from '../../src/app/server.js';
import { createLogger } from '../../src/core/logging/index.js';
import {
  createFakeAzureAccess,
  createLoginRig,
  createTestToolContext,
  expectNoLeak,
  FAKE_CONTEXTS,
  toLeakText,
} from '../helpers/index.js';

/**
 * End-to-end leak harness: every tool registered by `buildFeatures` is called over real MCP
 * Streamable HTTP, with arguments generated from its advertised JSON schema, in several fake
 * Azure states. New tools are picked up automatically; do not list them here.
 */

const VERSION = '0.0.0-test';
// Stubbed device-code login: the contexts tools run for real, without touching Azure.
const loginRig = createLoginRig();
const features = buildFeatures({
  version: VERSION,
  logins: loginRig.manager,
  loginUrl: 'http://127.0.0.1:8765/login',
});
const TOOL_NAMES = features.flatMap((f) => f.tools.map((t) => t.name));

const azure = createFakeAzureAccess();
const logLines: string[] = [];
const ctx = createTestToolContext({
  azure,
  logger: createLogger('debug', { write: (line) => logLines.push(line) }),
});

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
}

const STATES: readonly (readonly [string, () => void])[] = [
  [
    'logged in',
    () => {
      for (const alias of Object.keys(FAKE_CONTEXTS)) azure.login(alias);
    },
  ],
  [
    'logged out',
    () => {
      for (const alias of Object.keys(FAKE_CONTEXTS)) azure.logout(alias);
    },
  ],
];

describe('MCP over HTTP: every tool, every state, no leak', () => {
  it('tools/list advertises exactly the tools of all features', () => {
    expect(TOOL_NAMES.length).toBeGreaterThan(0);
    expect(listedTools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
  });

  describe.each(STATES)('%s', (_state, enter) => {
    it.each(TOOL_NAMES)('%s', async (name) => {
      enter();
      const tool = listedTools.find((t) => t.name === name);
      expect(tool, `${name} missing from tools/list`).toBeDefined();
      if (tool === undefined) return;
      await callAndCheck(tool, false);
      await callAndCheck(tool, true);
    });
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
