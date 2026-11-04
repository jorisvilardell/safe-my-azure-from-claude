import { describe, expect, it } from 'vitest';
import { Pseudonymizer, scrub } from '../../src/core/anonymizer/index.js';
import { sanitizeError } from '../../src/core/errors/index.js';
import { defineTool, executeTool } from '../../src/core/mcp/index.js';
import {
  createTestToolContext,
  expectNoLeak,
  PUBLIC_IP_CANARIES,
  toLeakText,
  toolText,
} from '../helpers/index.js';
import { AZURE_PAYLOAD_FIXTURES, createRestError } from './azure/index.js';

const PUBLIC_IPS = PUBLIC_IP_CANARIES.map(([, value]) => value);

describe('fixture pipeline: raw Azure payload → scrub()', () => {
  for (const [name, fixture] of Object.entries(AZURE_PAYLOAD_FIXTURES)) {
    it(`the raw ${name} is a meaningful canary (it leaks before scrubbing)`, () => {
      expect(() => {
        expectNoLeak(fixture);
      }).toThrow(/leak detected/);
    });

    it(`scrub() removes identifiers and secrets from the ${name}, keeping resource names`, () => {
      const out = toLeakText(scrub(fixture, new Pseudonymizer()));
      expectNoLeak(out);
      expect(out.toLowerCase()).toContain('vm-web-01');
      for (const ip of PUBLIC_IPS) expect(out).not.toContain(ip);
    });
  }
});

describe('fixture pipeline: Azure SDK RestError → sanitizeError()', () => {
  it('the raw RestError leaks its URL, subscription, token and correlation IDs', () => {
    const err = createRestError();
    expect(() => {
      expectNoLeak({ message: err.message, ...Object.fromEntries(Object.entries(err)) });
    }).toThrow(/leak detected/);
  });

  it('sanitizeError() + scrub() keep only the status and code', () => {
    const safe = sanitizeError(createRestError());
    expectNoLeak(scrub(safe, new Pseudonymizer()));
    expect(safe.code).toBe('ResourceNotFound');
    expect(safe.message).toContain('404');
  });

  it('a tool that throws it returns a leak-free error result', async () => {
    const tool = defineTool({
      name: 'throws_rest_error',
      title: 'Throws',
      description: 'test',
      inputSchema: {},
      handler: () => Promise.reject(createRestError()),
    });
    const result = await executeTool(tool, {}, createTestToolContext());
    expect(result.isError).toBe(true);
    expectNoLeak(toolText(result));
  });

  it('scrub() alone also redacts the auth header and IDs if the error object is returned', () => {
    expectNoLeak(scrub(Object.fromEntries(Object.entries(createRestError())), new Pseudonymizer()));
  });
});
