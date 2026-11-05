import { isIPv6 } from 'node:net';
import { IPV4_CANDIDATE, IPV4_CANDIDATE_STRICT, IPV6_CANDIDATE } from './patterns.js';
import type { Pseudonymizer } from './pseudonymizer.js';

/**
 * Resolves a public IP to the NAME of one of our Public IP resources, if it is one.
 * Lookups use the canonical form (`203.0.113.5`, `2001:db8::1`, lowercase, compressed).
 * The Resource Graph-backed implementation lives with the features that load it.
 */
export interface PublicIpIndex {
  lookup(ip: string): string | undefined;
}

/** Resource names allowed into a placeholder. Anything else falls back to `public-ip-external-NNN`. */
const SAFE_RESOURCE_NAME = /^[\w.-]{1,80}$/;

/**
 * Azure's platform virtual IP (DNS, DHCP, health probes). It is the same in every tenant and
 * shows up in many diagnostics, so it identifies nothing.
 */
const AZURE_PLATFORM_IPS = new Set(['168.63.129.16']);

function parseIPv4(s: string): readonly [number, number, number, number] | undefined {
  const parts = s.split('.');
  if (parts.length !== 4) return undefined;
  const octets = parts.map((x) => (/^\d{1,3}$/.test(x) ? Number(x) : Number.NaN));
  if (octets.some((o) => !(o >= 0 && o <= 255))) return undefined;
  const [a = 0, b = 0, c = 0, d = 0] = octets;
  return [a, b, c, d];
}

/**
 * Kept as-is (not identifying): RFC 1918, CGNAT 100.64/10, loopback, link-local (incl. IMDS
 * 169.254.169.254), "this network" 0/8, multicast 224/4, reserved 240/4 (incl. broadcast and most
 * netmasks such as 255.255.255.0) and the Azure platform IP. Documentation ranges (192.0.2/24,
 * 198.51.100/24, 203.0.113/24) are deliberately treated as PUBLIC: tests use them as stand-ins.
 */
function isKeptIPv4([a, b]: readonly [number, number, number, number], canonical: string): boolean {
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    a >= 224 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127) ||
    AZURE_PLATFORM_IPS.has(canonical)
  );
}

/** RFC 5952 canonical form via WHATWG URL (lowercase, compressed). Zone ids are dropped. */
function canonicalIPv6(s: string): string | undefined {
  const bare = s.split('%')[0] ?? '';
  if (!isIPv6(bare)) return undefined;
  try {
    return new URL(`http://[${bare}]/`).hostname.slice(1, -1);
  } catch {
    return undefined;
  }
}

function hextets(canonical: string): number[] {
  const [head = '', tail] = canonical.split('::');
  const h = head === '' ? [] : head.split(':');
  const t = tail === undefined || tail === '' ? [] : tail.split(':');
  const fill = tail === undefined ? 0 : 8 - h.length - t.length;
  return [...h, ...Array<string>(fill).fill('0'), ...t].map((x) => Number.parseInt(x, 16));
}

/**
 * Kept: unspecified `::`, loopback `::1`, link-local fe80::/10, ULA fc00::/7, multicast ff00::/8,
 * and IPv4-mapped `::ffff:a.b.c.d` when the embedded IPv4 is itself kept.
 * 2001:db8::/32 (documentation) is treated as public, like the IPv4 documentation ranges.
 */
function isKeptIPv6(canonical: string): boolean {
  const g = hextets(canonical);
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = g;
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0) {
    if (g5 === 0 && g6 === 0 && (g7 === 0 || g7 === 1)) return true;
    if (g5 === 0xffff) {
      const v4 = [g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff] as const;
      return isKeptIPv4(v4, v4.join('.'));
    }
  }
  return (g0 & 0xffc0) === 0xfe80 || (g0 & 0xfe00) === 0xfc00 || (g0 & 0xff00) === 0xff00;
}

/** True when `ip` is a valid IPv4/IPv6 address that must NOT be shown to the AI. */
export function isPublicIp(ip: string): boolean {
  const v4 = parseIPv4(ip);
  if (v4 !== undefined) return !isKeptIPv4(v4, v4.join('.'));
  const v6 = canonicalIPv6(ip);
  return v6 !== undefined && !isKeptIPv6(v6);
}

/** `public-ip-<name>` placeholder: the resource name of one of our Public IP resources. */
export const PUBLIC_IP_NAME_PLACEHOLDER = /^public-ip-([\w.-]{1,80})$/;

/**
 * The name comes from the ACTIVE context's inventory snapshot, so it is shown only while that
 * snapshot is fresh: just after login (before the first build lands), over the inventory cap or
 * in another context, the same IP shows as `public-ip-external-NNN` (#53, docs/SECURITY.md).
 * Both placeholders resolve to the same IP: `public-ip-<name>` is bound in the pseudonymizer
 * so `pseudonymizer.resolve()` maps it back (metrics filters).
 */
function placeholder(canonical: string, p: Pseudonymizer, index: PublicIpIndex | undefined): string {
  const name = index?.lookup(canonical);
  if (name !== undefined && SAFE_RESOURCE_NAME.test(name)) {
    const named = `public-ip-${name}`;
    if (p.bind(canonical, named)) return named;
  }
  return p.pseudonym('public-ip-external', canonical);
}

/** Replaces public IPv6 addresses (run BEFORE IPv4 so `::ffff:203.0.113.5` is handled whole). */
export function maskPublicIPv6(input: string, p: Pseudonymizer, index?: PublicIpIndex): string {
  return input.replace(IPV6_CANDIDATE, (m) => {
    const canonical = canonicalIPv6(m);
    if (canonical === undefined || isKeptIPv6(canonical)) return m;
    return placeholder(canonical, p, index);
  });
}

/** `strict`: no `version 1.2.3.4` exception (text whose wording the AI controls). */
export function maskPublicIPv4(
  input: string,
  p: Pseudonymizer,
  index?: PublicIpIndex,
  strict = false,
): string {
  return input.replace(strict ? IPV4_CANDIDATE_STRICT : IPV4_CANDIDATE, (m) => {
    const v4 = parseIPv4(m);
    if (v4 === undefined) return m;
    // Normalised so `203.0.113.005` and `203.0.113.5` share one placeholder.
    const canonical = v4.join('.');
    if (isKeptIPv4(v4, canonical)) return m;
    return placeholder(canonical, p, index);
  });
}
