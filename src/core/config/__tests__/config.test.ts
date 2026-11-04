import { describe, expect, it } from 'vitest';
import { loadEnv, loginPageUrl, parseContexts } from '../index.js';

const YAML = `
contexts:
  prod:
    tenantId: 00000000-0000-0000-0000-0000000000aa
  lab:
    tenantId: 00000000-0000-0000-0000-0000000000bb
`;

describe('contexts.yaml defaultContext', () => {
  it('is optional', () => {
    expect(parseContexts(YAML).defaultContext).toBeUndefined();
  });

  it('accepts a declared alias', () => {
    expect(parseContexts(`${YAML}defaultContext: lab\n`).defaultContext).toBe('lab');
  });

  it('rejects an undeclared alias', () => {
    expect(() => parseContexts(`${YAML}defaultContext: nope\n`)).toThrow(/defaultContext/);
  });
});

describe('loginPageUrl', () => {
  it('defaults to loopback and the configured port, not request headers', () => {
    expect(loginPageUrl(loadEnv({ PORT: '9000' }))).toBe('http://127.0.0.1:9000/login');
  });

  it('honours PUBLIC_URL', () => {
    expect(loginPageUrl(loadEnv({ PUBLIC_URL: 'http://localhost:18765/' }))).toBe(
      'http://localhost:18765/login',
    );
    expect(() => loadEnv({ PUBLIC_URL: 'ftp://x' })).toThrow();
  });
});
