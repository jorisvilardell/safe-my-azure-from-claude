import { describe, expect, it } from 'vitest';
import { expectNoLeak } from '../../../../test/helpers/index.js';
import { Pseudonymizer, REDACTED, scrub, scrubString } from '../index.js';

const s = (input: string): string => scrubString(input, new Pseudonymizer());
const SECRET = 'c2VjcmV0LXZhbHVl';

describe('SAS', () => {
  it('redacts SharedAccessSignature= in a connection string, keeping the endpoint', () => {
    expect(
      s(
        `Endpoint=sb://ns-01.servicebus.windows.net/;SharedAccessSignature=SharedAccessSignature sr=ns-01&sig=${SECRET}&se=1700000000&skn=send;EntityPath=q1`,
      ),
    ).toBe(`Endpoint=sb://ns-01.servicebus.windows.net/;SharedAccessSignature=${REDACTED};EntityPath=q1`);
    expect(
      s(
        `BlobEndpoint=https://st01.blob.core.windows.net/;SharedAccessSignature=sv=2024-01-01&ss=b&sig=${SECRET}`,
      ),
    ).toBe(`BlobEndpoint=https://st01.blob.core.windows.net/;SharedAccessSignature=${REDACTED}`);
  });

  it('redacts a SAS Authorization header', () => {
    expect(s(`Authorization: SharedAccessSignature sr=ns-01&sig=${SECRET}&se=1&skn=k`)).not.toContain(SECRET);
    expect(s(`token SharedAccessSignature sr=ns-01&sig=${SECRET}&se=1&skn=k end`)).toBe(
      `token SharedAccessSignature ${REDACTED} end`,
    );
  });
});

describe('x-ms-* headers', () => {
  it.each([
    'x-ms-token-aad-access-token',
    'x-ms-token-aad-refresh-token',
    'x-ms-client-principal',
    'x-ms-client-principal-name',
    'X-MS-Authorization-Auxiliary',
    'x-ms-encryption-key',
  ])('redacts %s in text and JSON', (header) => {
    expect(s(`${header}: ${SECRET}`)).toBe(`${header}: ${REDACTED}`);
    expect(s(`{"${header}": "${SECRET}"}`)).toBe(`{"${header}": "${REDACTED}"}`);
    expect(scrub({ [header]: SECRET }, new Pseudonymizer())).toEqual({ [header]: REDACTED });
  });

  it('keeps non-secret x-ms headers', () => {
    expect(s('x-ms-keyvault-region: westeurope')).toBe('x-ms-keyvault-region: westeurope');
    expect(s('x-ms-ratelimit-remaining: 11999')).toBe('x-ms-ratelimit-remaining: 11999');
  });

  it('keeps the historical Bearer output', () => {
    expect(s('Authorization: Bearer abc.def-ghi')).toBe(`Authorization: Bearer ${REDACTED}`);
    expect(s('Cookie: session=abc')).toBe(`Cookie: ${REDACTED}`);
  });
});

describe('PEM private keys', () => {
  it.each([
    'PRIVATE KEY',
    'RSA PRIVATE KEY',
    'EC PRIVATE KEY',
    'ENCRYPTED PRIVATE KEY',
    'OPENSSH PRIVATE KEY',
    'PGP PRIVATE KEY BLOCK',
  ])('redacts %s', (label) => {
    const pem = `-----BEGIN ${label}-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END ${label}-----`;
    expect(s(`key:\n${pem}\nafter`)).toBe(`key:\n${REDACTED}\nafter`);
    // Escaped newlines, as found inside JSON strings.
    expect(s(pem.replaceAll('\n', '\\n'))).toBe(REDACTED);
  });

  it('redacts a truncated private key to the end', () => {
    expect(s('cfg -----BEGIN RSA PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC')).toBe(
      `cfg ${REDACTED}`,
    );
  });
});

describe('JSON secret fields', () => {
  it('redacts password/secret fields inside serialised JSON', () => {
    const text = JSON.stringify({
      user: 'svc',
      password: SECRET,
      clientSecret: SECRET,
      adminPassword: 'p@ss "quoted"',
      pin: 1234,
      apiKey: SECRET,
      accessToken: SECRET,
      primaryKey: SECRET,
      secretName: 'kv-secret-01',
      tokenType: 'Bearer',
      passwordEnabled: false,
    });
    const out = s(text);
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain('quoted');
    expect(out).toContain('"secretName":"kv-secret-01"');
    expect(out).toContain('"tokenType":"Bearer"');
    expect(out).toContain('"passwordEnabled":false');
    expect(JSON.parse(out)).toMatchObject({ password: REDACTED, adminPassword: REDACTED });
  });

  it('redacts secret fields in objects but keeps the activity-log authorization object', () => {
    const out = scrub(
      {
        password: SECRET,
        Secret: 42,
        secrets: [SECRET, SECRET],
        authorization: { action: 'Microsoft.Compute/virtualMachines/restart/action', scope: 'rg-web' },
        secretName: 'kv-secret-01',
        passwordAuthenticationDisabled: true,
      },
      new Pseudonymizer(),
    );
    expect(out).toEqual({
      password: REDACTED,
      Secret: REDACTED,
      secrets: [REDACTED, REDACTED],
      authorization: { action: 'Microsoft.Compute/virtualMachines/restart/action', scope: 'rg-web' },
      secretName: 'kv-secret-01',
      passwordAuthenticationDisabled: true,
    });
  });

  it('redacts more key=value secrets', () => {
    expect(s(`Server=sql01;User ID=app;Password=${SECRET};`)).toBe(
      `Server=sql01;User ID=app;Password=${REDACTED};`,
    );
    expect(s(`?client_assertion=${SECRET}&id_token=${SECRET}`)).not.toContain(SECRET);
    expectNoLeak(s(`?client_assertion=${SECRET}`));
  });
});
