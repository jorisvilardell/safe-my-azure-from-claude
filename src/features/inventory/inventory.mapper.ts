import { maskTags } from '../../core/anonymizer/index.js';
import { untrustedText } from '../../core/safety/index.js';

/**
 * Free text copied from Azure (names, tag values, host names) goes through `untrustedText()`:
 * invisible characters removed, capped so one field cannot flood the AI's context (#39).
 */
export const MAX_TEXT_LENGTH = 256;
export const MAX_TAGS = 50;

/** Real subscription ID (lowercased) → alias, built server-side from the active session. */
export type SubscriptionAliases = ReadonlyMap<string, string>;

export interface MapperDeps {
  readonly subscriptionAliases: SubscriptionAliases;
  readonly safeTagKeys: Iterable<string>;
}

export interface SkuDto {
  readonly name?: string;
  readonly tier?: string;
  readonly capacity?: number;
}

export interface ResourceDto {
  /** `<resourceGroup>/<type>/<name>` (names only, never an ID). */
  readonly ref: string;
  readonly name: string;
  readonly resourceGroup: string;
  /** Subscription ALIAS. */
  readonly subscription: string;
  readonly type: string;
  readonly location: string;
  readonly sku?: SkuDto;
  readonly kind?: string;
  /** Values masked unless their key is in `safeTagKeys`. Kept values are Azure free text, capped. */
  readonly tags: Record<string, string>;
}

export type PropertyValue = string | number | boolean;

export interface ResourceDetailsDto extends ResourceDto {
  readonly provisioningState?: string;
  /** A small per-type allowlist of properties. Empty for types we do not know. */
  readonly properties: Record<string, PropertyValue>;
}

export interface ResourceGroupDto {
  readonly name: string;
  readonly subscription: string;
  readonly location: string;
  readonly provisioningState?: string;
  readonly tags: Record<string, string>;
}

export interface SubscriptionDto {
  readonly alias: string;
  /** Azure subscription state (Enabled, Disabled, Warned, PastDue…), or `NotVisible`. */
  readonly state: string;
}

type Json = Record<string, unknown>;

function isRecord(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function text(v: unknown): string | undefined {
  return untrustedText(v, { max: MAX_TEXT_LENGTH });
}

function at(obj: unknown, path: readonly string[]): unknown {
  let cur = obj;
  for (const key of path) {
    if (!isRecord(cur) || !Object.hasOwn(cur, key)) return undefined;
    cur = cur[key];
  }
  return cur;
}

function scalar(v: unknown): PropertyValue | undefined {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  return text(v);
}

export function mapTags(raw: unknown, safeTagKeys: Iterable<string>): Record<string, string> {
  if (!isRecord(raw)) return {};
  const strings = Object.fromEntries(
    Object.entries(raw)
      .filter((e): e is [string, string] => typeof e[1] === 'string')
      .slice(0, MAX_TAGS),
  );
  return Object.fromEntries(
    Object.entries(maskTags(strings, safeTagKeys)).map(([k, v]) => [text(k) ?? k, text(v) ?? ''] as const),
  );
}

function mapSku(raw: unknown): SkuDto | undefined {
  if (!isRecord(raw)) return undefined;
  const name = text(raw.name);
  const tier = text(raw.tier);
  const capacity = typeof raw.capacity === 'number' ? raw.capacity : undefined;
  if (name === undefined && tier === undefined && capacity === undefined) return undefined;
  return {
    ...(name === undefined ? {} : { name }),
    ...(tier === undefined ? {} : { tier }),
    ...(capacity === undefined ? {} : { capacity }),
  };
}

/**
 * Builds `<rg>/<type>/<name>[/<childType>/<child>]` from the ARM ID's names, like the scrubber's
 * `shortenArmId`, but without any pseudonym: the ID itself never leaves this function.
 */
export function resourceRef(id: unknown, resourceGroup: string, type: string, name: string): string {
  if (typeof id === 'string') {
    const segments = id.split('/').filter(Boolean);
    const lower = segments.map((s) => s.toLowerCase());
    const rgIdx = lower.indexOf('resourcegroups');
    const provIdx = lower.lastIndexOf('providers');
    if (rgIdx !== -1 && provIdx > rgIdx) {
      return [segments[rgIdx + 1] ?? resourceGroup, ...segments.slice(provIdx + 2)].join('/');
    }
  }
  const shortType = type.split('/').slice(1).join('/') || type;
  return `${resourceGroup}/${shortType}/${name}`;
}

function subscriptionAlias(raw: unknown, aliases: SubscriptionAliases): string {
  return typeof raw === 'string' ? (aliases.get(raw.toLowerCase()) ?? 'unknown') : 'unknown';
}

export function toResourceDto(row: unknown, deps: MapperDeps): ResourceDto | undefined {
  if (!isRecord(row)) return undefined;
  const name = text(row.name);
  const type = text(row.type);
  if (name === undefined || type === undefined) return undefined;
  const resourceGroup = text(row.resourceGroup) ?? '';
  const sku = mapSku(row.sku);
  const kind = text(row.kind);
  return {
    ref: resourceRef(row.id, resourceGroup, type, name),
    name,
    resourceGroup,
    subscription: subscriptionAlias(row.subscriptionId, deps.subscriptionAliases),
    type,
    location: text(row.location) ?? '',
    ...(sku === undefined ? {} : { sku }),
    ...(kind === undefined ? {} : { kind }),
    tags: mapTags(row.tags, deps.safeTagKeys),
  };
}

/** Per-type property allowlist: output key → path under `properties`. Types are lowercased. */
const PROPERTY_ALLOWLIST: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  'microsoft.compute/virtualmachines': {
    vmSize: ['hardwareProfile', 'vmSize'],
    osType: ['storageProfile', 'osDisk', 'osType'],
    powerState: ['extended', 'instanceView', 'powerState', 'code'],
  },
  'microsoft.web/sites': {
    state: ['state'],
    defaultHostName: ['defaultHostName'],
    httpsOnly: ['httpsOnly'],
  },
  'microsoft.storage/storageaccounts': {
    accessTier: ['accessTier'],
    minimumTlsVersion: ['minimumTlsVersion'],
    supportsHttpsTrafficOnly: ['supportsHttpsTrafficOnly'],
  },
  'microsoft.sql/servers/databases': {
    status: ['status'],
    currentServiceObjectiveName: ['currentServiceObjectiveName'],
  },
  'microsoft.containerservice/managedclusters': {
    kubernetesVersion: ['kubernetesVersion'],
    powerState: ['powerState', 'code'],
  },
};

export function pickProperties(type: string, properties: unknown): Record<string, PropertyValue> {
  const allow = PROPERTY_ALLOWLIST[type.toLowerCase()];
  if (allow === undefined) return {};
  const out: Record<string, PropertyValue> = {};
  for (const [key, path] of Object.entries(allow)) {
    const value = scalar(at(properties, path));
    if (value !== undefined) out[key] = value;
  }
  return out;
}

export function toResourceDetailsDto(row: unknown, deps: MapperDeps): ResourceDetailsDto | undefined {
  const base = toResourceDto(row, deps);
  if (base === undefined || !isRecord(row)) return undefined;
  const provisioningState = text(at(row.properties, ['provisioningState']));
  return {
    ...base,
    ...(provisioningState === undefined ? {} : { provisioningState }),
    properties: pickProperties(base.type, row.properties),
  };
}

export function toResourceGroupDto(row: unknown, deps: MapperDeps): ResourceGroupDto | undefined {
  if (!isRecord(row)) return undefined;
  const name = text(row.name);
  if (name === undefined) return undefined;
  const provisioningState = text(row.provisioningState);
  return {
    name,
    subscription: subscriptionAlias(row.subscriptionId, deps.subscriptionAliases),
    location: text(row.location) ?? '',
    ...(provisioningState === undefined ? {} : { provisioningState }),
    tags: mapTags(row.tags, deps.safeTagKeys),
  };
}

/** Subscription ID (lowercased) → state, from `resourcecontainers` rows. */
export function toSubscriptionStates(rows: readonly unknown[]): ReadonlyMap<string, string> {
  const states = new Map<string, string>();
  for (const row of rows) {
    if (!isRecord(row) || typeof row.subscriptionId !== 'string') continue;
    states.set(row.subscriptionId.toLowerCase(), text(row.state) ?? 'Unknown');
  }
  return states;
}
