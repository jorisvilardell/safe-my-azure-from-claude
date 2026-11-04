import { describe, expect, it } from 'vitest';
import { expectNoLeak } from '../../../../test/helpers/index.js';
import { Pseudonymizer, REDACTED, scrub, scrubString, shortenArmId } from '../index.js';

// FAKE identifiers only (AGENTS.md R7).
const SUB = '00000000-0000-0000-0000-000000000001';
const TENANT = '00000000-0000-0000-0000-0000000000aa';
const VM_ID = `/subscriptions/${SUB}/resourceGroups/rg-web/providers/Microsoft.Compute/virtualMachines/vm-web-01`;

describe('shortenArmId', () => {
  it('keeps resource group, type and name only', () => {
    expect(shortenArmId(VM_ID, new Pseudonymizer())).toBe('rg-web/virtualMachines/vm-web-01');
  });

  it('keeps child resources', () => {
    const id = `/subscriptions/${SUB}/resourceGroups/rg-data/providers/Microsoft.Sql/servers/sql-01/databases/db-orders`;
    expect(shortenArmId(id, new Pseudonymizer())).toBe('rg-data/servers/sql-01/databases/db-orders');
  });

  it('uses the subscription alias for subscription-scoped ids', () => {
    const p = new Pseudonymizer(new Map([[SUB, 'prod-app']]));
    expect(shortenArmId(`/subscriptions/${SUB}`, p)).toBe('sub:prod-app');
  });
});

describe('scrubString', () => {
  it('pseudonymises bare GUIDs consistently', () => {
    const p = new Pseudonymizer();
    const out = scrubString(`tenant ${TENANT} and again ${TENANT.toUpperCase()}`, p);
    expect(out).toBe('tenant id-001 and again id-001');
  });

  it('replaces emails', () => {
    expect(scrubString('caller: jane.doe@contoso.example', new Pseudonymizer())).toBe('caller: user-001');
  });

  it('redacts secrets', () => {
    const p = new Pseudonymizer();
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    expect(scrubString(`token ${jwt}`, p)).toBe(`token ${REDACTED}`);
    expect(scrubString('Authorization: Bearer abc.def-ghi', p)).toBe(`Authorization: Bearer ${REDACTED}`);
    expect(scrubString('DefaultEndpointsProtocol=https;AccountName=st01;AccountKey=c2VjcmV0;', p)).toBe(
      `DefaultEndpointsProtocol=https;AccountName=st01;AccountKey=${REDACTED};`,
    );
    expect(scrubString('https://st01.blob.core.windows.net/c?sv=2024&sig=abc%2Fdef', p)).toBe(
      `https://st01.blob.core.windows.net/c?sv=2024&sig=${REDACTED}`,
    );
  });
});

describe('scrub (deep)', () => {
  it('leaves no identifier in a realistic alert payload', () => {
    const alert = {
      id: `${VM_ID}/providers/Microsoft.AlertsManagement/alerts/11111111-2222-3333-4444-555555555555`,
      properties: {
        essentials: {
          targetResource: VM_ID,
          monitorCondition: 'Fired',
          severity: 'Sev1',
          startDateTime: new Date('2026-01-01T00:00:00Z'),
        },
        context: { caller: 'ops@contoso.example', tenantId: TENANT },
      },
      tags: { [`hidden-link:${VM_ID}`]: 'Resource' },
      count: 3,
      resolved: false,
      extra: null,
    };

    const out = scrub(alert, new Pseudonymizer());

    expectNoLeak(out);
    expect(JSON.stringify(out)).toContain('vm-web-01');
    expect(JSON.stringify(out)).toContain('2026-01-01T00:00:00.000Z');
  });
});

describe('pathological input', () => {
  it.each([
    ['dots', '1.'.repeat(100_000)],
    ['dashes', `x-ms${'-a'.repeat(100_000)}`],
    ['colons', 'abcd:'.repeat(50_000)],
    ['quotes', `"${'a'.repeat(200_000)}`],
  ])('scrubs a long %s run in linear time', (_label, input) => {
    const start = performance.now();
    scrubString(input, new Pseudonymizer());
    expect(performance.now() - start).toBeLessThan(1000);
  });
});

describe('golden: activity log event', () => {
  const APP = '00000000-0000-0000-0000-0000000000a1';
  const event = {
    caller: 'jane.doe@contoso.example',
    eventTimestamp: '2026-01-01T10:30:00.0000000Z',
    operationName: { value: 'Microsoft.Network/networkSecurityGroups/securityRules/write' },
    resourceId: `/subscriptions/${SUB}/resourceGroups/rg-net/providers/Microsoft.Network/networkSecurityGroups/nsg-web`,
    authorization: { action: 'Microsoft.Network/networkSecurityGroups/securityRules/write', scope: VM_ID },
    claims: {
      'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name': 'Jane Doe',
      appid: APP,
      ipaddr: '2001:db8::42',
    },
    httpRequest: {
      clientIpAddress: '198.51.100.23',
      clientRequestId: '00000000-0000-0000-0000-0000000000c1',
    },
    properties: {
      requestbody: JSON.stringify({
        properties: { sourceAddressPrefix: '203.0.113.0/24', destinationAddressPrefix: '10.0.1.0/24' },
        clientSecret: 'c2VjcmV0',
      }),
      statusCode: 'Created',
      agentVersion: '1.10.2.0',
    },
    tags: { env: 'prod', owner: 'jane.doe@contoso.example' },
  };

  it('keeps names and private IPs, removes everything else', () => {
    const out = scrub(event, new Pseudonymizer(), { safeTagKeys: ['env'] });
    expectNoLeak(out);
    const text = JSON.stringify(out);
    for (const leaked of ['Jane', 'jane', '2001:db8', '198.51.100', '203.0.113', 'c2VjcmV0']) {
      expect(text).not.toContain(leaked);
    }
    for (const kept of [
      'nsg-web',
      'rg-net',
      '10.0.1.0/24',
      '1.10.2.0',
      '"env":"prod"',
      'app-001',
      'Created',
    ]) {
      expect(text).toContain(kept);
    }
  });
});

describe('LEAK_PATTERNS public IPv4', () => {
  it.each(['203.0.113.5', '198.51.100.7', '192.0.2.1', 'ip=172.32.0.1'])('flags %s', (text) => {
    expect(() => {
      expectNoLeak(text);
    }).toThrow(/public IPv4/);
  });

  it.each([
    '10.0.0.4',
    '172.16.5.4',
    '192.168.0.1',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '168.63.129.16',
    'v1.2.3.4',
    '"agentVersion": "1.10.2.0"',
  ])('ignores %s', (text) => {
    expectNoLeak(text);
  });
});
