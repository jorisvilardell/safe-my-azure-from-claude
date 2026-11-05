import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseContexts } from '../../src/core/config/index.js';
import * as v from '../fixtures/azure/values.js';
import { FAKE_ACCESS_TOKEN } from '../helpers/index.js';

/** Static checks on the Dev Proxy mocks (they only run for real in the e2e-mock CI job). */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEVPROXY = join(ROOT, 'mocks', 'devproxy');

interface Mock {
  readonly request: {
    readonly url: string;
    readonly method?: string;
    readonly bodyFragment?: string;
    readonly nth?: number;
  };
  readonly response: { readonly statusCode?: number; readonly body?: unknown };
}

function jsonFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return jsonFiles(path);
    return name.endsWith('.json') ? [path] : [];
  });
}

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));
const files = jsonFiles(DEVPROXY);
const mockFiles = files.filter((f) => f.includes(join('devproxy', 'mocks')));
const mocksOf = (path: string): Mock[] => (readJson(path) as { mocks: Mock[] }).mocks;
const allText = files.map((f) => readFileSync(f, 'utf8')).join('\n');

/** Dev Proxy turns `*` into `.*` and matches case-insensitively. */
const urlRegex = (pattern: string): RegExp =>
  new RegExp(
    `^${pattern
      .split('*')
      .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')}$`,
    'i',
  );

describe('Dev Proxy mocks', () => {
  it('are valid JSON with only fake GUIDs (AGENTS.md R7)', () => {
    expect(files.length).toBeGreaterThan(0);
    const guids = allText.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) ?? [];
    const real = guids.filter((g) => !g.startsWith('00000000-0000-0000-0000-') && g !== v.CLIENT_REQUEST_ID);
    expect(real).toEqual([]);
  });

  it('reference files that exist', () => {
    for (const rc of ['devproxyrc.json', 'devproxyrc.chaos.json']) {
      const config = readJson(join(DEVPROXY, rc)) as Record<string, unknown>;
      const refs = Object.values(config).flatMap((section) => {
        if (typeof section !== 'object' || section === null) return [];
        const s = section as { mocksFile?: unknown; errorsFile?: unknown };
        return [s.mocksFile, s.errorsFile].filter((x): x is string => typeof x === 'string');
      });
      expect(refs.length, rc).toBeGreaterThan(0);
      for (const ref of refs) expect(() => statSync(join(DEVPROXY, ref)), `${rc} → ${ref}`).not.toThrow();
    }
  });

  it.each(mockFiles.map((f) => [relative(DEVPROXY, f), f]))(
    '%s: no mock is shadowed by an earlier one',
    (_, file) => {
      const mocks = mocksOf(file);
      mocks.forEach((later, i) => {
        for (const earlier of mocks.slice(0, i)) {
          const sameMethod = (earlier.request.method ?? 'GET') === (later.request.method ?? 'GET');
          const unconditional =
            earlier.request.bodyFragment === undefined && earlier.request.nth === undefined;
          // A sample URL for the later mock: its wildcards filled with a plausible segment.
          const sample = later.request.url.replace(/\*/g, 'x/y?z=1');
          const shadowed = sameMethod && unconditional && urlRegex(earlier.request.url).test(sample);
          expect(shadowed, `${later.request.url} is shadowed by ${earlier.request.url}`).toBe(false);
        }
      });
    },
  );

  it('carry the canaries the e2e run must see stripped', () => {
    for (const canary of [
      v.SUBSCRIPTION_ID,
      v.TENANT_ID,
      v.CALLER_OBJECT_ID,
      v.CORRELATION_ID,
      v.ALERT_ID,
      v.VM_ID,
      v.WORKSPACE_ID,
      v.CALLER_EMAIL,
      v.OWNER_EMAIL,
      v.PUBLIC_IP_CLIENT,
      v.PUBLIC_IP_PEER,
      v.SAS_SIGNATURE,
      v.STORAGE_ACCOUNT_KEY,
      v.CLIENT_SECRET,
      v.FAKE_ID_TOKEN,
      FAKE_ACCESS_TOKEN,
    ]) {
      expect(allText, canary).toContain(canary);
    }
  });

  it('match the mock contexts.yaml', () => {
    const contexts = parseContexts(readFileSync(join(ROOT, 'mocks', 'contexts.mock.yaml'), 'utf8'));
    const prod = contexts.contexts.prod;
    expect(prod?.tenantId).toBe(v.TENANT_ID);
    expect(prod?.subscriptions['prod-app']).toBe(v.SUBSCRIPTION_ID);
  });
});
