import { describe, expect, it } from 'vitest';
import { CALLER_EMAIL, SAS_SIGNATURE } from '../fixtures/azure/index.js';
import { CANARIES, expectNoLeak, FAKE_ACCESS_TOKEN } from './index.js';

const failureOf = (output: unknown): string => {
  try {
    expectNoLeak(output);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error('expected a leak to be detected');
};

describe('expectNoLeak', () => {
  it('passes on anonymised output', () => {
    expectNoLeak({ name: 'vm-web-01', subscription: 'prod-app', caller: 'user-001', ip: '10.0.1.4' });
  });

  it('catches a canary that no regex pattern matches', () => {
    expect(failureOf({ sig: SAS_SIGNATURE })).toMatch(/canary "SAS signature"/);
  });

  it('catches canaries case-insensitively', () => {
    expect(failureOf(CALLER_EMAIL.toUpperCase())).toMatch(/email/);
  });

  it('reports a snippet, never the full payload', () => {
    const padding = 'x'.repeat(500);
    const message = failureOf(`${padding} token=${FAKE_ACCESS_TOKEN} ${padding}`);
    expect(message).toMatch(/pattern "JWT"/);
    expect(message).toMatch(/canary "access token"/);
    expect(message).not.toContain(padding);
    expect(message.length).toBeLessThan(600);
  });

  it('includes the fake access token among the canaries', () => {
    expect(CANARIES.map(([, value]) => value)).toContain(FAKE_ACCESS_TOKEN);
  });
});
