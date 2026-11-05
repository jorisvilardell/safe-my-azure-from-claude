import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** 256-bit keys, base64url (43 characters). */
const KEY_BYTES = 32;

export const DEFAULT_KEYS_FILE = '/run/safe-azure/keys.json';

/**
 * The two server keys (ADR 0001 §1): `mcp` for `/mcp`, `admin` for `/admin/*`.
 * They live in this process's memory and in the keys file only: never in env, a log line, a tool
 * result or an error. Nothing in this module takes a logger, on purpose.
 */
export interface ServerKeys {
  readonly mcp: string;
  readonly admin: string;
}

export function generateKeys(): ServerKeys {
  return {
    mcp: randomBytes(KEY_BYTES).toString('base64url'),
    admin: randomBytes(KEY_BYTES).toString('base64url'),
  };
}

/**
 * Writes `{"mcp": "...", "admin": "..."}` to `path`, mode 0600 in a 0700 directory. In the container
 * that is a tmpfs owned by the `node` user, read by the CLI through `docker exec ... cat`.
 *
 * The old file is removed first and the new one created with `wx`, so the mode applies to a fresh
 * inode and a planted symlink is never followed.
 */
export function writeKeysFile(path: string, keys: ServerKeys): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  rmSync(path, { force: true });
  writeFileSync(path, JSON.stringify({ mcp: keys.mcp, admin: keys.admin }) + '\n', {
    mode: 0o600,
    flag: 'wx',
  });
  // The umask can only remove bits, but be explicit: the mode is the whole point.
  chmodSync(path, 0o600);
}

const digest = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();

/**
 * Returns a checker for `Authorization: Bearer <key>`. Both sides are hashed first, so
 * `timingSafeEqual` always compares two 32-byte buffers: neither the content nor the length of
 * the expected key leaks through timing.
 */
export function createBearerCheck(expected: string): (authorization: string | undefined) => boolean {
  const want = digest(expected);
  return (authorization) => {
    const match = /^Bearer[ ]+(\S+)[ ]*$/i.exec(authorization ?? '');
    const given = digest(match?.[1] ?? '');
    // Always run the comparison, even with no or a malformed header.
    const equal = timingSafeEqual(want, given);
    return match !== null && equal;
  };
}
