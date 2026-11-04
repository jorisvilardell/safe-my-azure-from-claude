import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createAnonymizer } from '../../src/core/anonymizer/index.js';
import { contextIdAliases } from '../../src/core/config/index.js';
import { createLogger } from '../../src/core/logging/index.js';
import { createFakeAzureAccess, FAKE_CONTEXTS } from './azure.js';
import { assertNoLeakWith } from './leak.js';
import type { ToolContext } from '../../src/core/mcp/index.js';

/**
 * A `ToolContext` wired like main.ts: a fake Azure (`createFakeAzureAccess`) and an anonymizer
 * that shows the fake contexts' tenants and subscriptions by alias. Override any part.
 */
export function createTestToolContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    anonymizer: createAnonymizer({ aliases: contextIdAliases(FAKE_CONTEXTS) }),
    logger: createLogger('error', { write: () => undefined }),
    azure: createFakeAzureAccess(),
    ...overrides,
  };
}

export function toolText(result: CallToolResult): string {
  return result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
}

export function parseToolText(result: CallToolResult): unknown {
  return JSON.parse(toolText(result));
}

/** Patterns that must NEVER appear in anything sent to the AI (AGENTS.md G1/G2). */
export const LEAK_PATTERNS: readonly (readonly [string, RegExp])[] = [
  ['GUID', /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i],
  ['ARM id', /\/subscriptions\//i],
  ['JWT', /\beyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]{5,}/],
  ['email', /\b[\w.%+-]+@[\w-]+(?:\.[\w-]+)+\b/],
  ['bearer', /Bearer\s+(?!\[REDACTED\])\S+/i],
  // Public IPv4: excludes 10/8, 127/8, 0/8, 172.16/12, 192.168/16, 169.254/16, 100.64/10, 224/4, 240/4,
  // the Azure platform IP 168.63.129.16, dotted versions (`v1.2.3.4`, `agentVersion: "1.10.2.0"`).
  [
    'public IPv4',
    /(?<![\w.])(?<!version["']?\s*[:=]?\s*["']?)(?!(?:10|127|0|22[4-9]|2[3-5]\d)\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|168\.63\.129\.16(?!\d))(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?!\w|\.\d)/i,
  ],
];

/** Fails if `output` matches a LEAK_PATTERN or contains any CANARY verbatim (see `leak.ts`). */
export function expectNoLeak(output: unknown): void {
  assertNoLeakWith(output, LEAK_PATTERNS);
}

export * from './azure.js';
export * from './leak.js';
export * from './login.js';
