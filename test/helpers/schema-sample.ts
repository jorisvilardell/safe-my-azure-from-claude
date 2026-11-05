/**
 * Minimal valid tool arguments generated from an advertised JSON schema. Shared by the in-process
 * e2e harness (test/e2e) and the mocked-Azure container run (test/e2e-mock).
 */

type JsonObject = Record<string, unknown>;

const isObject = (v: unknown): v is JsonObject => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);

/** Plausible names and aliases from the fake contexts, tried in order against `pattern`/length limits. */
const STRING_CANDIDATES = [
  'vm-web-01',
  'prod',
  'prod-app',
  'rg-app',
  'Microsoft.Compute/virtualMachines',
  'PT1H',
  'P1D',
  'Heartbeat | take 1',
];

function sampleString(schema: JsonObject): string {
  switch (schema.format) {
    case 'date-time':
      return '2026-11-03T08:00:00Z';
    case 'date':
      return '2026-11-03';
    case 'duration':
      return 'PT1H';
    case 'uuid':
      return '00000000-0000-0000-0000-000000000099';
    case 'uri':
    case 'url':
      return 'https://example.com/';
    case 'email':
      return 'user@example.com';
  }
  const min = num(schema.minLength) ?? 0;
  const max = num(schema.maxLength) ?? Infinity;
  const pattern = typeof schema.pattern === 'string' ? new RegExp(schema.pattern, 'u') : undefined;
  const fits = (s: string): boolean => s.length >= min && s.length <= max && (pattern?.test(s) ?? true);
  return STRING_CANDIDATES.find(fits) ?? 'a'.repeat(Math.max(min, 1));
}

function sampleNumber(schema: JsonObject, integer: boolean): number {
  const lo = num(schema.minimum) ?? (num(schema.exclusiveMinimum) ?? 0) + 1;
  const hi = num(schema.maximum) ?? (num(schema.exclusiveMaximum) ?? Infinity) - 1;
  const value = Math.min(Math.max(lo, 1), hi);
  return integer ? Math.ceil(value) : value;
}

/** `full` also fills optional properties, to reach code paths behind them. */
export function sampleArgs(schema: unknown, full: boolean): unknown {
  if (!isObject(schema)) return 'vm-web-01';
  if ('const' in schema) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  if ('default' in schema) return schema.default;

  const variants = schema.anyOf ?? schema.oneOf ?? schema.allOf;
  if (Array.isArray(variants)) {
    const first: unknown = variants.find((s) => !isObject(s) || s.type !== 'null') ?? variants[0];
    return sampleArgs(first, full);
  }

  const type: unknown = Array.isArray(schema.type)
    ? (schema.type as unknown[]).find((t) => t !== 'null')
    : schema.type;
  switch (type) {
    case 'object': {
      const props = isObject(schema.properties) ? schema.properties : {};
      const required = Array.isArray(schema.required) ? schema.required : [];
      return Object.fromEntries(
        Object.entries(props)
          .filter(([key]) => full || required.includes(key))
          .map(([key, prop]) => [key, sampleArgs(prop, full)]),
      );
    }
    case 'array': {
      const count = Math.min(Math.max(num(schema.minItems) ?? 0, 1), num(schema.maxItems) ?? 1);
      return Array.from({ length: count }, () => sampleArgs(schema.items, full));
    }
    case 'integer':
      return sampleNumber(schema, true);
    case 'number':
      return sampleNumber(schema, false);
    case 'boolean':
      return false;
    case 'null':
      return null;
    default:
      return sampleString(schema);
  }
}
