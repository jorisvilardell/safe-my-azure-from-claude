import { describe, expect, it } from 'vitest';
import { expectNoLeak } from '../../../../test/helpers/index.js';
import { createAnonymizer, Pseudonymizer, REDACTED, scrub, scrubString } from '../index.js';

/**
 * Regression tests for the leaks found by the 2026-11 audit: identifiers and secrets that the
 * scrubber missed because of `\b` boundaries, percent-encoding, guest UPNs, env-var names or
 * formats it did not know. Every value here is fake (R7).
 */

const s = (input: string): string => scrubString(input, new Pseudonymizer());
const SUB = '00000000-0000-0000-0000-00000000a5b1';
const SECRET = 'S3cr3tValue-not-real';

describe('identifiers hidden by encoding or glued to other characters', () => {
  it.each([
    ['URL-encoded ARM ID', `alertId~/%2Fsubscriptions%2F${SUB}%2FresourceGroups%2Frg-prod`],
    ['lowercase escapes', `x=%2fsubscriptions%2f${SUB}%2fresourcegroups%2frg`],
    ['double-encoded ARM ID', `r=%252Fsubscriptions%252F${SUB}`],
    ['GUID after an underscore', `vm_${SUB}`],
    ['GUID before an underscore', `${SUB}_backup`],
    ['GUID inside a word', `diag${SUB}x`],
    ['GUID after an encoded =', `cb%3Ftenant%3D${SUB}`],
    ['GUID without dashes', `sub ${SUB.replaceAll('-', '')}`],
  ])('%s', (_label, input) => {
    const out = s(input);
    expect(out).not.toContain(SUB);
    expect(out).not.toContain(SUB.replaceAll('-', ''));
    expectNoLeak(out);
  });

  it.each([
    ['guest UPN', 'user jane.doe_contoso.example#EXT#@fabrikam.onmicrosoft.com signed in'],
    ['URL-encoded email', 'GET /users/jane.doe%40contoso.example'],
    ['non-ASCII local part', 'josé@contoso.example'],
    ['portal tenant link', 'https://portal.azure.com/#@contoso.onmicrosoft.com/resource'],
  ])('pseudonymises an email in a %s', (_label, input) => {
    const out = s(input);
    expect(out).toMatch(/user-\d{3}/);
    expect(out).not.toMatch(/contoso\.example|onmicrosoft\.com/);
  });

  it.each([
    ['glued to underscores', 'Allow_203.0.113.5_SSH', '203.0.113.5'],
    ['URL-encoded', 'q=%2F203.0.113.5', '203.0.113.5'],
  ])('masks a public IP %s', (_label, input, ip) => {
    expect(s(input)).not.toContain(ip);
  });

  it('keeps URLs readable once decoded', () => {
    expect(s('GET /api/items?q=red%20shoes')).toBe('GET /api/items?q=red shoes');
  });

  it('does not decode an escape into a control or invisible character', () => {
    expect(s('a%0Ab%E2%80%8Bc')).toBe('a%0Ab%E2%80%8Bc');
  });
});

describe('secrets in env vars, YAML, Python reprs and Azure headers', () => {
  it.each([
    'DB_PASSWORD',
    'AZURE_CLIENT_SECRET',
    'MYSQL_ROOT_PASSWORD',
    'GITHUB_TOKEN',
    'app.secret',
    'x-functions-key',
    'Ocp-Apim-Subscription-Key',
    'api-key',
    'ConnectionString',
  ])('%s with =, : or quotes', (name) => {
    for (const text of [
      `${name}=${SECRET}`,
      `${name}: ${SECRET}`,
      `${name} = ${SECRET}`,
      `{'${name}': '${SECRET}'}`,
      `{"${name}": "${SECRET}"}`,
    ]) {
      const out = s(text);
      expect(out, text).not.toContain(SECRET);
      expect(out, text).toContain(REDACTED);
    }
  });

  it('redacts query-string keys', () => {
    expect(s(`GET /api/x?subscription-key=${SECRET}&q=1`)).toBe(
      `GET /api/x?subscription-key=${REDACTED}&q=1`,
    );
    expect(s(`https://fn.azurewebsites.net/api/f?code=${SECRET}`)).not.toContain(SECRET);
  });

  it('redacts the password of a URL, whatever characters it uses', () => {
    for (const pass of ['pa$$w0rd!', 'S3cretPass', 'p@ss:word']) {
      const out = s(`mongodb://admin:${pass}@db.example:10255/`);
      expect(out, pass).not.toContain(pass.slice(0, 4));
    }
  });

  it.each([
    ['GitHub token', `ghp_${'A1b2C3d4E5'.repeat(4)}`],
    ['fine-grained GitHub token', `github_pat_${'11ABCDEFG0'.repeat(3)}`],
    ['AWS key id', 'AKIAABCDEFGHIJKLMNOP'],
    ['Slack token', 'xoxb-0000000000-0000000000-abcdefghijkl'],
    ['Google API key', `AIza${'Sy0123456789abcdefghij'.padEnd(35, 'x')}`],
    ['Entra ID client secret', `abc8Q~${'d'.repeat(34)}`],
    ['storage account key', `${'Zm9vYmFy'.repeat(11)}==`],
    ['Azure DevOps PAT', 'a'.repeat(26) + '2'.repeat(26)],
    ['OpenAI key', `sk-proj-${'x1'.repeat(16)}`],
    ['unsigned JWT', 'eyJhbGciOiJub25lIn0.eyJvaWQiOiJmYWtlLW9pZCJ9.'],
  ])('redacts a bare %s', (_label, token) => {
    expect(s(`value ${token} end`)).toBe(`value ${REDACTED} end`);
  });

  it('redacts Basic credentials, keeping the scheme', () => {
    expect(s('value Basic dXNlcjpwYXNzd29yZA== end')).toBe(`value Basic ${REDACTED} end`);
  });

  it('keeps ordinary text', () => {
    for (const text of [
      'status code: 404',
      'tokenType: Bearer',
      'secretName: db-password',
      'isSecret: true',
      'Basic tier',
      'x-ms-request-id: abc',
      'partition key: tenant',
    ]) {
      expect(s(text), text).toBe(text);
    }
  });
});

describe('field-name exceptions the AI could steer', () => {
  it('strict mode masks a public IP under any *version key', () => {
    const a = createAnonymizer();
    expect(JSON.stringify(a.scrub({ d: { x_version: '203.0.113.7' } }, { strict: true }))).not.toContain(
      '203.0.113.7',
    );
    expect(a.scrubString('version 203.0.113.8')).toContain('203.0.113.8');
    expect(JSON.stringify(a.scrub({ t: 'version 203.0.113.8' }, { strict: true }))).not.toContain(
      '203.0.113.8',
    );
  });

  it('only known version fields keep a dotted value, in normal mode too', () => {
    const p = new Pseudonymizer();
    expect(scrub({ agentVersion: '1.10.2.0' }, p)).toEqual({ agentVersion: '1.10.2.0' });
    expect(JSON.stringify(scrub({ clientversion: '203.0.113.9' }, p))).not.toContain('203.0.113.9');
  });
});

describe('pseudonyms never collide with aliases', () => {
  it('skips a placeholder already used as an alias', () => {
    const p = new Pseudonymizer(new Map([[SUB, 'id-001']]));
    const other = p.pseudonym('id', '00000000-0000-0000-0000-00000000bbbb');
    expect(other).toBe('id-002');
    expect(p.resolve('id-001')).toBe(SUB);
  });
});
