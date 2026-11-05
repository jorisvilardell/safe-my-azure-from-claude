# ADR 0002: Persisted, encrypted token cache

- Status: proposed (2026-11-05)
- Issues: #14
- Constraints: AGENTS.md G1 (no credential ever reaches the AI), R8 (no credential on disk)

## Context

- Each context has one `DeviceCodeCredential` with its MSAL cache **in process memory**
  (`src/core/azure/credential-manager.ts`, no `tokenCachePersistenceOptions`). Any container
  restart signs out every context.
- Restarts happen for reasons that `restart: unless-stopped` does not cover: `safe-azure update`
  (it recreates the container, by design), a host reboot, a Docker Desktop update, an OOM kill.
- The compose file already has `restart: unless-stopped`, and the image already has a
  `HEALTHCHECK` on `/healthz`. `safe-azure install` runs the container the same way (ADR 0001 §7).
- There is no `/login` page anymore (ADR 0001 §2). The only human channel into the server is
  the TTY-only CLI calling `/admin/*` with the admin key.
- Who can read a named volume: anyone who can talk to the Docker daemon
  (`docker run -v <volume>:/x alpine cat …`), the Docker Desktop VM disk, and host backups of it.
  The Claude Code hook blocks `docker exec|cp`, not every `docker run`. **A volume must be treated
  as readable by a same-user agent.**

## Options

### 1. Encrypted cache on a named volume, key derived from a passphrase

The human types a passphrase in their own terminal. The server derives a key from it (scrypt or
Argon2id), keeps the key in memory only, and encrypts the per-context MSAL cache on a named
volume. After a restart, one `unlock` restores every context.

- \+ Survives every kind of restart, including `update`.
- \+ The volume alone is useless without the passphrase; the cost of guessing is set by the KDF.
- \- One more secret for the human, typed once per restart.
- \- A weak passphrase can be brute-forced offline from the volume.
- \- Requires amending R8 (from "nothing on disk" to "nothing in plaintext on disk").

### 2. Memory only, fewer restarts

Keep R8 as is, rely on `restart: unless-stopped` plus the healthcheck.

- \+ Nothing on disk, nothing to steal, no new secret, no code.
- \- Already in place, so it changes nothing: updates, reboots and Docker Desktop restarts still
  sign everyone out. It does not solve #14.

### 3. `@azure/identity-cache-persistence` (MSAL Node extensions)

`useIdentityPlugin(cachePersistencePlugin)` plus `tokenCachePersistenceOptions`.

- On Linux it encrypts through **libsecret** (D-Bus Secret Service, e.g. GNOME Keyring). The
  Alpine runtime image has no D-Bus session, no keyring daemon and no one to unlock it; adding them
  means native modules, a writable home and a daemon in a `read_only`, `cap_drop: ALL` container.
- Without libsecret the only fallback is `unsafeAllowUnencryptedStorage: true`: **plaintext
  refresh tokens on the volume**, a direct R8 violation.
- Even with a keyring inside the container, its own master key would live on the same volume or be
  unlocked by a secret we would still have to bring in: this is option 1 with more moving parts.
- **Rejected.** It is built for desktop processes running inside a user session, not for a
  headless container.

### 4. Random key held by the host CLI (no passphrase)

`safe-azure` generates a random 256-bit cache key, stores it like the server keys (DPAPI on
Windows, Keychain/libsecret or a 0600 file elsewhere), and pushes it with `POST /admin/unlock`
after a restart (e.g. from `safe-azure login`, `doctor` or `up`).

- \+ No passphrase, no brute-force surface (full-entropy key).
- \- The key and the volume are then both reachable by the same host user. A same-user agent that
  can call DPAPI (any language with FFI, not only PowerShell) and `docker run -v` gets the refresh
  tokens. That is exactly the party we protect against (SECURITY.md §1).
- Possible later as an explicit, documented "convenience" mode; not as the default.

### 5. Cache held by the CLI on the host

Rejected outright: tokens would leave the container and live in the user space the agent shares.

## Decision (recommended)

**Option 1, opt-in, with the passphrase entered through the CLI.** Option 2 stays as the
baseline (already in place). Options 3 and 5 are rejected; option 4 is left as an open question.

### Enabling

- Off by default: `TOKEN_CACHE=memory` (current behaviour). `TOKEN_CACHE=encrypted` plus a named
  volume `safe-azure-cache:/var/lib/safe-azure` (uid 1000, 0700). The root filesystem stays
  `read_only`; only that volume is writable. `safe-azure install --persist-logins` sets both.

### Passphrase path (G1)

- `safe-azure unlock` (and `safe-azure login` when the server is locked) reads the passphrase
  **from the TTY with echo off**, refuses without a TTY, and sends it once in the body of
  `POST /admin/unlock` with the admin key. The first unlock sets it (typed twice, minimum 12
  characters).
- No MCP tool, argument, resource or error ever carries it. The MCP side only learns a boolean:
  `login_status` may report `locked: true` and the hint _"Ask the user to run
  `safe-azure unlock`"_.
- `/admin/unlock` bodies are never logged, never echoed in errors, `Cache-Control: no-store`.
  A test asserts the passphrase never appears in logs, audit lines or responses.
- The hook adds `unlock` to the human-only `safe-azure` sub-commands.
- Wrong passphrases are rate limited (exponential back-off, per process).

### Key handling

- KDF: **scrypt from `node:crypto`** (no native dependency; Argon2id would need a native or
  WASM module). Parameters `N=2^17, r=8, p=1` (128 MiB, set `maxmem`), 16-byte random salt, all
  stored in the header so they can be raised later.
- The derived 32-byte key lives in one `Buffer` in process memory, never in env, never on disk,
  never logged. The passphrase string is dropped right after derivation (JS strings cannot be
  zeroed; accepted). `--disable-sigusr1` already closes the inspector route. A restart forgets the
  key: the server starts **locked**.

### File format

- One file per context: `/var/lib/safe-azure/cache/<sha256(alias)>.bin`, plus `meta.bin`
  (salt, KDF parameters, and an encrypted known value to check the passphrase even when no context
  is cached).
- Content: the MSAL serialized cache **without access and ID tokens** (refresh token, account and
  app metadata only; access tokens are re-acquired on unlock).
- Layout: `magic "SAZC" | version u8 | nonce (12 bytes) | AES-256-GCM ciphertext | tag (16 bytes)`.
  AAD = `magic | version | alias | KDF parameters`, so a file cannot be swapped between contexts or
  downgraded. A fresh random nonce per write (far below the 2^32 limit for one key).
- Writes are atomic (temp file, `fsync`, `rename`), mode 0600, after each MSAL cache change.
- Integration: `@azure/msal-node` `PublicClientApplication` with a public `ICachePlugin`, wrapped
  as the `LoginCredential` the manager already expects. The persistence hook inside
  `@azure/identity` is `@internal` and is not used.

### Multi-context

- **One passphrase, one key, every context**: one `unlock` after a restart. Per-context files
  so that logging out of one context does not touch the others.
- On unlock, each cached context tries a silent token request. Success: logged in. Failure
  (refresh token revoked or expired): the file is deleted and the context shows as logged out.

### Rotation and wipe

- `logout <alias>`: drops the in-memory credential **and deletes its file**.
- `safe-azure unlock --change-passphrase`: new salt, new key, every file re-encrypted atomically.
- `safe-azure forget`: deletes every cache file and `meta.bin` (a forgotten passphrase is the
  same as a wipe). `safe-azure uninstall` removes the volume.
- No automatic re-lock timer in the first version.

## Consequences

### Threat model

| Attacker has                                | Gets                                                                                                                                                                               |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The volume (Docker socket, VM disk, backup) | Ciphertext, salt, KDF parameters, number of cached contexts, file times. Alias names are hashed. Tokens only by brute-forcing the passphrase at ~128 MiB and tens of ms per guess. |
| The admin key                               | Can unlock with guesses (rate limited), log out, wipe: denial of service, as today. Cannot read the cache.                                                                         |
| The MCP key / the AI                        | Nothing new: a `locked` flag. No tool takes or returns the passphrase or key.                                                                                                      |
| Container memory                            | The key and live tokens, as today. Out of scope (SECURITY.md §1).                                                                                                                  |
| A stolen refresh token                      | Valid until revoked or about 90 days of inactivity. Mitigation: revoke sessions in Entra ID and run `safe-azure forget`.                                                           |

- Security now depends on passphrase strength. Docs must say so and recommend a generated one.
- **R8 is amended**: _"No credential in plaintext on disk. The only persisted credential is the
  opt-in encrypted token cache of ADR 0002."_ G1 is unchanged. SECURITY.md §5 and §8 are updated.
- `@azure/msal-node` becomes a direct dependency; the CAE behaviour (`clientCapabilities: ['cp1']`)
  must be kept and tested.
- `safe-azure update` no longer has to warn that logins are lost when persistence is on; it asks
  for `unlock` instead.
- With `TOKEN_CACHE=memory` nothing changes.

## Open questions

1. Opt-in (recommended) or on by default?
2. One passphrase for all contexts (recommended) or one per context?
3. Should option 4 (host-held key, no passphrase) ever be offered as an explicit convenience mode?
4. Should the server re-lock (drop the key) after a period of inactivity?
