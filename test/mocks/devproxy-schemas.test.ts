import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Dependabot (docker-compose ecosystem) bumps the Dev Proxy image in docker-compose.mock.yml but
 * not the `$schema` URLs of the mock files. This test fails such a PR until every schema points at
 * the same version as the image, so a new Dev Proxy release is always checked against its schemas.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MOCKS = path.join(ROOT, 'mocks/devproxy');
const SCHEMA = /^https:\/\/raw\.githubusercontent\.com\/dotnet\/dev-proxy\/main\/schemas\/v([^/]+)\//;

function jsonFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return jsonFiles(full);
    return entry.name.endsWith('.json') ? [full] : [];
  });
}

function imageVersion(): string {
  const compose = readFileSync(path.join(ROOT, 'docker-compose.mock.yml'), 'utf8');
  const match = /image:\s*ghcr\.io\/dotnet\/dev-proxy:(\S+)/.exec(compose);
  if (match?.[1] === undefined) throw new Error('docker-compose.mock.yml: no ghcr.io/dotnet/dev-proxy image');
  return match[1];
}

describe('Dev Proxy mock files', () => {
  const version = imageVersion();
  const files = jsonFiles(MOCKS);

  it('has mock files to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files.map((f) => [path.relative(ROOT, f).replaceAll('\\', '/'), f]))(
    '%s uses the schemas of the image version',
    (_name, file) => {
      const json = JSON.parse(readFileSync(file, 'utf8')) as { $schema?: unknown };
      expect(typeof json.$schema, 'missing $schema').toBe('string');
      const schemaVersion = SCHEMA.exec(json.$schema as string)?.[1];
      expect(
        schemaVersion,
        `$schema must be .../schemas/v${version}/... to match ghcr.io/dotnet/dev-proxy:${version}`,
      ).toBe(version);
    },
  );
});
