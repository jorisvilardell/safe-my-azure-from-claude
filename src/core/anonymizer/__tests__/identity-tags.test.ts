import { describe, expect, it } from 'vitest';
import { expectNoLeak } from '../../../../test/helpers/index.js';
import { createAnonymizer, MASKED, maskTags, Pseudonymizer, scrub } from '../index.js';

const APP = '00000000-0000-0000-0000-0000000000a1';
const OBJ = '00000000-0000-0000-0000-0000000000b1';

describe('maskTags', () => {
  it('masks values unless the key is allowlisted (case-insensitive), keeping keys', () => {
    expect(
      maskTags({ env: 'prod', Owner: 'jane@contoso.example', CostCenter: '4242' }, ['ENV', 'costcenter']),
    ).toEqual({
      env: 'prod',
      Owner: MASKED,
      CostCenter: '4242',
    });
  });

  it('masks everything by default and tolerates missing tags', () => {
    expect(maskTags({ env: 'prod' })).toEqual({ env: MASKED });
    expect(maskTags(undefined)).toEqual({});
    expect(maskTags(null, ['env'])).toEqual({});
  });

  it('cannot be abused through __proto__', () => {
    const out = maskTags(JSON.parse('{"__proto__": {"polluted": true}}') as Record<string, unknown>);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(Object.keys(out)).toEqual(['__proto__']);
  });
});

describe('scrub: tags', () => {
  it('masks tag values at any depth, and still scrubs keys and allowed values', () => {
    const out = scrub(
      {
        tags: { env: 'prod', owner: 'jane@contoso.example', ticket: 'INC-123' },
        resources: [{ name: 'vm-01', Tags: { env: 'ops@contoso.example', ip: '203.0.113.5' } }],
      },
      new Pseudonymizer(),
      { safeTagKeys: ['env'] },
    );
    expect(out).toEqual({
      tags: { env: 'prod', owner: MASKED, ticket: MASKED },
      resources: [{ name: 'vm-01', Tags: { env: 'user-001', ip: MASKED } }],
    });
    expectNoLeak(out);
  });

  it('masks every tag value without options', () => {
    expect(scrub({ tags: { env: 'prod' } }, new Pseudonymizer())).toEqual({ tags: { env: MASKED } });
  });
});

describe('scrub: identities', () => {
  it('maps app ids to app-NNN and people to user-NNN', () => {
    const out = scrub(
      {
        caller: 'jane.doe@contoso.example',
        identity: {
          type: 'SystemAssigned',
          principalId: OBJ,
          tenantId: '00000000-0000-0000-0000-0000000000aa',
        },
        properties: {
          appId: APP,
          clientId: APP,
          principalType: 'ServicePrincipal',
          displayName: 'deploy-bot',
        },
        systemData: { createdBy: 'John Smith', createdByType: 'User', lastModifiedBy: APP },
        owners: ['Jane Doe', { displayName: 'John Smith', userPrincipalName: 'john@contoso.example' }],
        alertRule: { displayName: 'High CPU', name: 'cpu-high' },
      },
      new Pseudonymizer(),
    );
    expect(out).toEqual({
      caller: 'user-001',
      identity: { type: 'SystemAssigned', principalId: 'id-001', tenantId: 'id-002' },
      properties: {
        appId: 'app-001',
        clientId: 'app-001',
        principalType: 'ServicePrincipal',
        displayName: 'user-002',
      },
      systemData: { createdBy: 'user-003', createdByType: 'User', lastModifiedBy: 'app-001' },
      owners: ['user-004', { displayName: 'user-003', userPrincipalName: 'user-005' }],
      alertRule: { displayName: 'High CPU', name: 'cpu-high' },
    });
  });

  it('treats a bare GUID caller as a service principal', () => {
    expect(scrub({ caller: APP }, new Pseudonymizer())).toEqual({ caller: 'app-001' });
  });

  it('anonymises activity-log claims (URI keys)', () => {
    const out = scrub(
      {
        claims: {
          'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name': 'Jane Doe',
          'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname': 'Jane',
          'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/upn': 'jane@contoso.example',
          'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier': 'AbCdEf0123456789',
          appid: APP,
          ipaddr: '203.0.113.7',
          'http://schemas.microsoft.com/identity/claims/objectidentifier': OBJ,
        },
      },
      new Pseudonymizer(),
    );
    const text = JSON.stringify(out);
    for (const leaked of ['Jane', 'AbCdEf', '203.0.113.7']) expect(text).not.toContain(leaked);
    expect(text).toContain('app-001');
    expectNoLeak(out);
  });
});

describe('createAnonymizer', () => {
  it('bundles aliases, safeTagKeys and the public IP index', () => {
    const a = createAnonymizer({
      aliases: new Map([['00000000-0000-0000-0000-000000000001', 'prod-app']]),
      safeTagKeys: ['env'],
      publicIpIndex: { lookup: (ip) => (ip === '203.0.113.10' ? 'pip-web-01' : undefined) },
    });
    expect(
      a.scrub({
        subscriptionId: '00000000-0000-0000-0000-000000000001',
        tags: { env: 'prod', owner: 'x' },
        ips: ['203.0.113.10', '198.51.100.1', '10.0.0.4'],
      }),
    ).toEqual({
      subscriptionId: 'prod-app',
      tags: { env: 'prod', owner: MASKED },
      ips: ['public-ip-pip-web-01', 'public-ip-external-001', '10.0.0.4'],
    });
    expect(a.scrubString('from 198.51.100.1')).toBe('from public-ip-external-001');
    expect(a.pseudonymizer.resolve('public-ip-external-001')).toBe('198.51.100.1');
  });
});
