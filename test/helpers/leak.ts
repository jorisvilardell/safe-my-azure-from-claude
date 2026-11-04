import { assert } from 'vitest';
import * as v from '../fixtures/azure/values.js';
import { FAKE_ACCESS_TOKEN, FAKE_CONTEXTS } from './azure.js';

export type LeakPattern = readonly [label: string, pattern: RegExp];
export type Canary = readonly [label: string, value: string];

/** Public IPs planted in fixtures (doc ranges). The scrubber must replace them with `public-ip-*`. */
export const PUBLIC_IP_CANARIES: readonly Canary[] = [
  ['public IP', v.PUBLIC_IP_CLIENT],
  ['public IP', v.PUBLIC_IP_PEER],
];

/**
 * Exact sensitive values planted in fixtures and fake contexts. Unlike the regex patterns,
 * these also catch a value that was only partly transformed (e.g. a secret with its key removed).
 */
export const CANARIES: readonly Canary[] = [
  ['access token', FAKE_ACCESS_TOKEN],
  ['id token', v.FAKE_ID_TOKEN],
  ['SAS signature', v.SAS_SIGNATURE],
  ['storage account key', v.STORAGE_ACCOUNT_KEY],
  ['client secret', v.CLIENT_SECRET],
  ['email', v.CALLER_EMAIL],
  ['email', v.OWNER_EMAIL],
  ['GUID', v.SUBSCRIPTION_ID],
  ['GUID', v.TENANT_ID],
  ['GUID', v.CALLER_OBJECT_ID],
  ['GUID', v.APP_ID],
  ['GUID', v.CORRELATION_ID],
  ['GUID', v.REQUEST_ID],
  ['GUID', v.CLIENT_REQUEST_ID],
  ['GUID', v.ALERT_ID],
  ['GUID', v.EVENT_DATA_ID],
  ['GUID', v.VM_ID],
  ['GUID', v.WORKSPACE_ID],
  ...Object.values(FAKE_CONTEXTS).flatMap((c): Canary[] => [
    ['tenant id', c.tenantId],
    ...Object.values(c.subscriptions).map((id): Canary => ['subscription id', id]),
  ]),
  ...PUBLIC_IP_CANARIES,
];

export interface Leak {
  readonly label: string;
  readonly index: number;
  readonly length: number;
}

const SNIPPET_RADIUS = 30;

export function toLeakText(output: unknown): string {
  if (typeof output === 'string') return output;
  return output === undefined ? '' : JSON.stringify(output);
}

export function findLeaks(
  text: string,
  patterns: readonly LeakPattern[],
  canaries: readonly Canary[] = CANARIES,
): Leak[] {
  const leaks: Leak[] = [];
  for (const [label, pattern] of patterns) {
    const m = new RegExp(pattern.source, pattern.flags.replace('g', '')).exec(text);
    if (m) leaks.push({ label: `pattern "${label}"`, index: m.index, length: m[0].length });
  }
  const lower = text.toLowerCase();
  for (const [label, value] of canaries) {
    const index = lower.indexOf(value.toLowerCase());
    if (index !== -1) leaks.push({ label: `canary "${label}"`, index, length: value.length });
  }
  return leaks;
}

/** A short excerpt around the leak, never the whole payload. */
function snippet(text: string, leak: Leak): string {
  const start = Math.max(0, leak.index - SNIPPET_RADIUS);
  const end = Math.min(text.length, leak.index + leak.length + SNIPPET_RADIUS);
  const body = text.slice(start, end).replace(/\s+/g, ' ');
  return `${start > 0 ? '…' : ''}${body}${end < text.length ? '…' : ''}`;
}

/**
 * Fails when `output` matches a leak pattern or contains a canary verbatim (case-insensitive).
 * The message lists every leak with a snippet, so failures are readable in CI.
 */
export function assertNoLeakWith(
  output: unknown,
  patterns: readonly LeakPattern[],
  canaries: readonly Canary[] = CANARIES,
): void {
  const text = toLeakText(output);
  const leaks = findLeaks(text, patterns, canaries);
  if (leaks.length === 0) return;
  const lines = leaks.map((l) => `  - ${l.label} at offset ${l.index}: ${snippet(text, l)}`);
  assert.fail(`leak detected (${leaks.length}):\n${lines.join('\n')}`);
}
