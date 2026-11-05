import * as crypto from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBearerCheck, DEFAULT_KEYS_FILE, generateKeys, writeKeysFile } from '../index.js';

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof crypto>();
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});

const POSIX = process.platform !== 'win32';
const dirs: string[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'safe-azure-keys-'));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('generateKeys', () => {
  it('makes two distinct 256-bit base64url keys, new on every call', () => {
    const a = generateKeys();
    const b = generateKeys();
    for (const key of [a.mcp, a.admin, b.mcp, b.admin]) {
      expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(Buffer.from(key, 'base64url')).toHaveLength(32);
    }
    expect(new Set([a.mcp, a.admin, b.mcp, b.admin]).size).toBe(4);
  });
});

describe('writeKeysFile', () => {
  it('defaults to the container tmpfs path', () => {
    expect(DEFAULT_KEYS_FILE).toBe('/run/safe-azure/keys.json');
  });

  it('writes {mcp, admin} as JSON, creating the directory', () => {
    const path = join(tempDir(), 'run', 'safe-azure', 'keys.json');
    const keys = generateKeys();
    writeKeysFile(path, keys);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ mcp: keys.mcp, admin: keys.admin });
  });

  it.runIf(POSIX)('uses mode 0600 for the file and 0700 for a directory it creates', () => {
    const path = join(tempDir(), 'sub', 'keys.json');
    writeKeysFile(path, generateKeys());
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(path, '..')).mode & 0o777).toBe(0o700);
  });

  it('replaces the keys of a previous start, with a fresh 0600 file', () => {
    const path = join(tempDir(), 'keys.json');
    writeFileSync(path, 'old', { mode: 0o644 });
    const keys = generateKeys();
    writeKeysFile(path, keys);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ mcp: keys.mcp, admin: keys.admin });
    if (POSIX) expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('never writes the keys to stdout or stderr', () => {
    const out = vi.spyOn(process.stdout, 'write');
    const err = vi.spyOn(process.stderr, 'write');
    const keys = generateKeys();
    writeKeysFile(join(tempDir(), 'keys.json'), keys);
    createBearerCheck(keys.mcp)(`Bearer ${keys.mcp}`);
    expect(out).not.toHaveBeenCalled();
    expect(err).not.toHaveBeenCalled();
  });
});

describe('createBearerCheck', () => {
  const key = generateKeys().mcp;
  const check = createBearerCheck(key);

  it('accepts exactly `Bearer <key>` (scheme case-insensitive)', () => {
    expect(check(`Bearer ${key}`)).toBe(true);
    expect(check(`bearer ${key}`)).toBe(true);
  });

  it.each([
    ['no header', undefined],
    ['empty', ''],
    ['scheme only', 'Bearer '],
    ['no scheme', key],
    ['other scheme', `Basic ${key}`],
    ['wrong key, same length', `Bearer ${generateKeys().mcp}`],
    ['prefix of the key', `Bearer ${key.slice(0, 20)}`],
    ['key plus a suffix', `Bearer ${key}x`],
    ['two tokens', `Bearer ${key} ${key}`],
    ['the other key', `Bearer ${generateKeys().admin}`],
  ])('rejects %s', (_name, header) => {
    expect(check(header)).toBe(false);
  });

  it('compares with crypto.timingSafeEqual on equal-length buffers, even for a bad header', () => {
    const spy = vi.mocked(crypto.timingSafeEqual);
    spy.mockClear();
    for (const header of [undefined, 'x', `Bearer ${key.slice(0, 5)}`, `Bearer ${key}`]) check(header);
    expect(spy).toHaveBeenCalledTimes(4);
    for (const [a, b] of spy.mock.calls) {
      expect((a as Buffer).length).toBe(32);
      expect((b as Buffer).length).toBe(32);
    }
  });
});
