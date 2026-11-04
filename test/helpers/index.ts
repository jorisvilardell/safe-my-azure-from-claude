import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { expect } from 'vitest';
import { Pseudonymizer } from '../../src/core/anonymizer/index.js';
import { createLogger } from '../../src/core/logging/index.js';
import { createFakeAzureAccess } from './azure.js';
import type { ToolContext } from '../../src/core/mcp/index.js';

export function createTestToolContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    pseudonymizer: new Pseudonymizer(),
    logger: createLogger('error', () => undefined),
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
];

export function expectNoLeak(output: unknown): void {
  const text = typeof output === 'string' ? output : JSON.stringify(output);
  for (const [label, pattern] of LEAK_PATTERNS) {
    expect(text, `leak detected: ${label}`).not.toMatch(pattern);
  }
}

export * from './azure.js';
export * from './login.js';
