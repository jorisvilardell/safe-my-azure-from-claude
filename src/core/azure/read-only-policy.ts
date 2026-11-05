import type { PipelinePolicy } from '@azure/core-rest-pipeline';
import { AppError } from '../errors/index.js';

/**
 * Runtime half of AGENTS.md R2 (read-only). Every Azure SDK client built by the client factory
 * carries this guard twice:
 *
 * - `safeAzureReadOnly`, first in the pipeline (Serialize phase): a write is refused before the
 *   pipeline does anything else, not even fetch a token.
 * - `safeAzureReadOnlyWire`, last in the pipeline (after Sign): it sees every request actually
 *   handed to the HTTP client, including retries and the hops of the SDK's redirect policy.
 *
 * Allowed: `GET` and `HEAD` to the Azure hosts we use, and the read-only `POST`s listed in
 * `READ_ONLY_POSTS`. Everything else throws `AppError('WriteBlocked')` and is never sent.
 * Token requests go through MSAL's own HTTP stack (`@azure/identity`), not these pipelines.
 */
export const READ_ONLY_POLICY_NAME = 'safeAzureReadOnly';
export const READ_ONLY_WIRE_POLICY_NAME = 'safeAzureReadOnlyWire';

const ARM_HOST = 'management.azure.com';
const LOGS_HOST = 'api.loganalytics.io';
/** The only hosts our SDK clients talk to. A request anywhere else is refused, whatever its method. */
const AZURE_HOSTS: ReadonlySet<string> = new Set([ARM_HOST, LOGS_HOST]);

const READ_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD']);
/** Methods named in the error. Anything else is reported as `OTHER` (the message stays ours). */
const KNOWN_METHODS: ReadonlySet<string> = new Set([
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
  'TRACE',
  'CONNECT',
]);

export interface ReadOnlyPost {
  /** Short label, used in errors and docs. Never an ID. */
  readonly kind: string;
  readonly host: string;
  /** Matched against the parsed pathname, case-insensitively (ARM paths are case-insensitive). */
  readonly path: RegExp;
}

/**
 * The read-only POSTs the code really sends. Keep it minimal. Adding one needs a comment saying
 * which feature calls it and why the API cannot change anything, plus a test in
 * `src/core/azure/__tests__/read-only-policy.test.ts` (AGENTS.md R2).
 */
export const READ_ONLY_POSTS: readonly ReadOnlyPost[] = [
  {
    // Resource Graph query (`core/azure/resource-graph.ts`): inventory, alerts, advisor, workspaces,
    // the resolver and the inventory index. The query API only reads the Resource Graph cache.
    kind: 'resource-graph-query',
    host: ARM_HOST,
    path: /^\/providers\/microsoft\.resourcegraph\/resources$/i,
  },
  {
    // Log Analytics KQL query on a workspace (`logs`: run_kql, list_tables). KQL is checked by
    // `core/safety/kql-guard.ts` first; the query API cannot run management commands.
    kind: 'log-analytics-query',
    host: LOGS_HOST,
    path: /^\/v1\/workspaces\/[^/]+\/query$/i,
  },
  {
    // Resource-centric KQL query on an Application Insights component (`logs`: run_kql on an App
    // Insights resource). The SDK keeps the leading slash of the resource ID: `/v1//subscriptions/…`.
    kind: 'app-insights-query',
    host: LOGS_HOST,
    path: /^\/v1\/\/?subscriptions\/[^/]+\/resourcegroups\/[^/]+\/providers\/microsoft\.insights\/components\/[^/]+\/query$/i,
  },
];

export interface ReadOnlyVerdict {
  readonly allowed: boolean;
  /** `management.azure.com`, `api.loganalytics.io` or `unknown-host`. */
  readonly host: string;
  /** The allowlisted POST kind, `read`, `write`, or why the URL was refused. Never an ID. */
  readonly kind: string;
}

/**
 * Path traversal and encoded separators, checked on the raw URL: `new URL()` would already have
 * resolved `/x/../y`, and a front door may decode `%2e` / `%2f` / `%5c` itself.
 */
const TRAVERSAL = /(?:^|\/)\.{1,2}(?:\/|$)|%2e|%2f|%5c|\\/i;

function rawPath(url: string): string {
  const afterAuthority = url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, '');
  return afterAuthority.split(/[?#]/, 1)[0] ?? '';
}

/** Pure check behind the policy, also used by the e2e-mock suite on Dev Proxy's request log. */
export function classifyAzureRequest(method: string, url: string): ReadOnlyVerdict {
  const verb = method.toUpperCase();
  const refuse = (host: string, kind: string): ReadOnlyVerdict => ({ allowed: false, host, kind });
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return refuse('unknown-host', 'malformed-url');
  }
  const host = parsed.hostname.toLowerCase();
  if (!AZURE_HOSTS.has(host)) return refuse('unknown-host', 'unexpected-host');
  if (parsed.username !== '' || parsed.password !== '') return refuse(host, 'userinfo');
  if (parsed.protocol !== 'https:' || parsed.port !== '') return refuse(host, 'not-https');
  if (TRAVERSAL.test(rawPath(url))) return refuse(host, 'path-traversal');

  if (READ_METHODS.has(verb)) return { allowed: true, host, kind: 'read' };
  if (verb === 'POST') {
    const post = READ_ONLY_POSTS.find((p) => p.host === host && p.path.test(parsed.pathname));
    if (post !== undefined) return { allowed: true, host, kind: post.kind };
  }
  return refuse(host, 'write');
}

/** Throws `WriteBlocked` unless the request is read-only. The message never holds an ID or a URL. */
export function assertReadOnlyAzureRequest(method: string, url: string): void {
  const verdict = classifyAzureRequest(method, url);
  if (verdict.allowed) return;
  const verb = method.toUpperCase();
  const shown = KNOWN_METHODS.has(verb) ? verb : 'OTHER';
  throw new AppError(
    'WriteBlocked',
    `Blocked a non read-only Azure call (${shown} ${verdict.host}/${verdict.kind}).`,
  );
}

function guardPolicy(name: string): PipelinePolicy {
  return {
    name,
    sendRequest(request, next) {
      try {
        assertReadOnlyAzureRequest(request.method, request.url);
      } catch (err) {
        return Promise.reject(err instanceof Error ? err : new Error(String(err)));
      }
      return next(request);
    },
  };
}

/** The two guard instances for one client pipeline (a pipeline refuses duplicate policy names). */
export function createReadOnlyPolicies(): { readonly first: PipelinePolicy; readonly last: PipelinePolicy } {
  return { first: guardPolicy(READ_ONLY_POLICY_NAME), last: guardPolicy(READ_ONLY_WIRE_POLICY_NAME) };
}
