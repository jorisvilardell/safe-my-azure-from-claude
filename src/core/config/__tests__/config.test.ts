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

describe('inventory settings', () => {
  it('caps the index at 50,000 resources and keeps the MCP resource off by default', () => {
    const env = loadEnv({});
    expect(env.INVENTORY_MAX_RESOURCES).toBe(50_000);
    expect(env.INVENTORY_RESOURCE).toBe('off');
  });

  it('accepts an explicit opt-in and a custom cap (0 disables the index)', () => {
    const env = loadEnv({ INVENTORY_RESOURCE: 'on', INVENTORY_MAX_RESOURCES: '0' });
    expect(env.INVENTORY_RESOURCE).toBe('on');
    expect(env.INVENTORY_MAX_RESOURCES).toBe(0);
    expect(() => loadEnv({ INVENTORY_RESOURCE: 'yes' })).toThrow();
    expect(() => loadEnv({ INVENTORY_MAX_RESOURCES: '-1' })).toThrow();
  });
});

describe('AUDIT_LOG', () => {
  it('defaults to stderr, with no file', () => {
    const env = loadEnv({});
    expect(env.AUDIT_LOG).toBe('stderr');
    expect(env.AUDIT_LOG_FILE).toBeUndefined();
  });

  it('accepts off, and file with an explicit path', () => {
    expect(loadEnv({ AUDIT_LOG: 'off' }).AUDIT_LOG).toBe('off');
    expect(loadEnv({ AUDIT_LOG: 'file', AUDIT_LOG_FILE: '/app/audit/audit.jsonl' })).toMatchObject({
      AUDIT_LOG: 'file',
      AUDIT_LOG_FILE: '/app/audit/audit.jsonl',
    });
  });

  it('rejects file without a path, a path without file mode, and unknown modes', () => {
    expect(() => loadEnv({ AUDIT_LOG: 'file' })).toThrow(/AUDIT_LOG_FILE/);
    expect(() => loadEnv({ AUDIT_LOG: 'file', AUDIT_LOG_FILE: '' })).toThrow(/AUDIT_LOG_FILE/);
    expect(() => loadEnv({ AUDIT_LOG_FILE: '/tmp/a.jsonl' })).toThrow(/AUDIT_LOG_FILE/);
    expect(() => loadEnv({ AUDIT_LOG: 'syslog' })).toThrow();
  });

  it('treats an empty AUDIT_LOG_FILE (docker-compose default) as unset', () => {
    expect(loadEnv({ AUDIT_LOG: 'stderr', AUDIT_LOG_FILE: '' }).AUDIT_LOG_FILE).toBeUndefined();
  });
});
