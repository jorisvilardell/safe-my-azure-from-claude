import { describe, expect, it } from 'vitest';
import { expectNoLeak } from '../../../../test/helpers/index.js';
import { isPublicIp, Pseudonymizer, scrub, scrubString, type PublicIpIndex } from '../index.js';

// Documentation ranges only (AGENTS.md R7): 203.0.113.0/24, 198.51.100.0/24, 192.0.2.0/24, 2001:db8::/32.
const SUB = '00000000-0000-0000-0000-000000000001';

const index: PublicIpIndex = {
  lookup: (ip) => ({ '203.0.113.10': 'pip-web-01', '2001:db8::10': 'pip-web-v6' })[ip],
};

const s = (input: string, idx?: PublicIpIndex): string =>
  scrubString(input, new Pseudonymizer(), idx === undefined ? {} : { publicIpIndex: idx });

describe('isPublicIp', () => {
  it.each([
    '10.0.0.4',
    '10.255.255.255',
    '172.16.0.1',
    '172.31.255.254',
    '192.168.1.1',
    '100.64.0.1',
    '100.127.255.255',
    '127.0.0.1',
    '169.254.169.254',
    '0.0.0.0',
    '255.255.255.0',
    '224.0.0.251',
    '168.63.129.16',
    '::',
    '::1',
    'fe80::1',
    'fd00:1234::5',
    'fc00::1',
    'ff02::1',
    '::ffff:10.0.0.1',
  ])('keeps private/reserved %s', (ip) => {
    expect(isPublicIp(ip)).toBe(false);
  });

  it.each([
    '203.0.113.5',
    '198.51.100.7',
    '192.0.2.1',
    '172.15.0.1',
    '172.32.0.1',
    '100.63.255.255',
    '100.128.0.1',
    '2001:db8::1',
    '::ffff:203.0.113.5',
  ])('flags public %s', (ip) => {
    expect(isPublicIp(ip)).toBe(true);
  });

  it('rejects non-addresses', () => {
    expect(isPublicIp('256.1.1.1')).toBe(false);
    expect(isPublicIp('not-an-ip')).toBe(false);
  });
});

describe('public IP masking', () => {
  it('names our own Public IP resources', () => {
    expect(s('frontend 203.0.113.10:443', index)).toBe('frontend public-ip-pip-web-01:443');
    expect(s('v6 [2001:db8::10]:443', index)).toBe('v6 [public-ip-pip-web-v6]:443');
    expect(s('v6 2001:0DB8:0:0::10', index)).toBe('v6 public-ip-pip-web-v6');
  });

  it('pseudonymises external IPs stably per value', () => {
    const p = new Pseudonymizer();
    const out = scrubString('from 198.51.100.7 to 192.0.2.1, again 198.51.100.7 and 198.51.100.007', p);
    expect(out).toBe(
      'from public-ip-external-001 to public-ip-external-002, again public-ip-external-001 and public-ip-external-001',
    );
  });

  it('keeps private IPs and masks public ones in the same text', () => {
    expect(s('src=10.1.2.3 dst=203.0.113.99 nat=100.64.1.1 lb=168.63.129.16')).toBe(
      'src=10.1.2.3 dst=public-ip-external-001 nat=100.64.1.1 lb=168.63.129.16',
    );
  });

  it('masks IPv6 and IPv4-mapped IPv6 whole', () => {
    expect(s('client 2001:db8:85a3::8a2e:370:7334 via ::ffff:203.0.113.5 and fe80::1%eth0')).toBe(
      'client public-ip-external-001 via public-ip-external-002 and fe80::1%eth0',
    );
  });

  it('masks CIDRs, URLs and trailing punctuation', () => {
    expect(s('allow 203.0.113.0/24 on http://198.51.100.7/health. Done')).toBe(
      'allow public-ip-external-001/24 on http://public-ip-external-002/health. Done',
    );
  });

  it('ignores a malicious or odd index name', () => {
    const bad: PublicIpIndex = { lookup: () => 'x y/../jane@contoso.example' };
    expect(s('203.0.113.10', bad)).toBe('public-ip-external-001');
  });

  describe('false positives', () => {
    it.each([
      ['v1.2.3.4', 'v1.2.3.4'],
      ['1.2.3.4.5', '1.2.3.4.5'],
      ['build 10.0.20348.2340', 'build 10.0.20348.2340'],
      ['version 2.9.1.0', 'version 2.9.1.0'],
      ['"agentVersion": "1.10.2.0"', '"agentVersion": "1.10.2.0"'],
      ['999.1.1.1', '999.1.1.1'],
      ['at 2026-01-01T10:30:00.000Z', 'at 2026-01-01T10:30:00.000Z'],
      ['12:30:45', '12:30:45'],
      ['mac 00:0d:3a:12:34:56', 'mac 00:0d:3a:12:34:56'],
      ['std::map and Microsoft::Foo', 'std::map and Microsoft::Foo'],
    ])('leaves %s alone', (input, expected) => {
      expect(s(input)).toBe(expected);
    });

    it('does not see IPs inside GUIDs or ARM IDs (replaced earlier)', () => {
      const armId = `/subscriptions/${SUB}/resourceGroups/rg-1/providers/Microsoft.Network/publicIPAddresses/pip-01`;
      expect(s(`${armId} ${SUB}`)).toBe('rg-1/publicIPAddresses/pip-01 id-001');
    });

    it('does not scan *Version fields for IPv4', () => {
      const out = scrub(
        { osVersion: '6.1.7.1', typeHandlerVersion: '2.1.0.3', ip: '203.0.113.5' },
        new Pseudonymizer(),
      );
      expect(out).toEqual({
        osVersion: '6.1.7.1',
        typeHandlerVersion: '2.1.0.3',
        ip: 'public-ip-external-001',
      });
      expectNoLeak(out);
    });
  });

  it('masks IPs used as object keys', () => {
    const out = scrub({ '203.0.113.5': { hits: 3 } }, new Pseudonymizer());
    expect(out).toEqual({ 'public-ip-external-001': { hits: 3 } });
  });
});
