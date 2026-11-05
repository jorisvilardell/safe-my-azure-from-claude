# Native Windows mode (WAM broker login)

> **Optional, and weaker than Docker.** The supported setup is the Docker container with
> device-code login ([USAGE.md](./USAGE.md)). Use native mode only when you cannot run Docker.
> Tracking issue: [#15](https://github.com/jorisvilardell/safe-my-azure-from-claude/issues/15).

In native mode the server runs as a plain Node.js process on Windows, and each context signs in
through the **Windows broker** (WAM, the Web Account Manager) via `@azure/identity-broker`: a
Windows sign-in window opens on your desktop, with the work accounts Windows already knows. There
is no device code.

It is the same codebase. One variable selects it:

| `AUTH_MODE`             | Where                    | Sign-in                                      |
| ----------------------- | ------------------------ | -------------------------------------------- |
| `device-code` (default) | Docker (or anywhere)     | Code shown by `safe-azure login`, unchanged. |
| `broker`                | Native Windows (`win32`) | WAM window on this desktop, no code at all.  |

Anything else is rejected at startup. `AUTH_MODE=broker` fails at startup, with a message that
says why, when:

- the platform is not Windows (`BrokerUnsupportedPlatform`), e.g. in the Docker image;
- the optional package `@azure/identity-broker` is not installed (`BrokerNotInstalled`). It is an
  `optionalDependency`, loaded with a dynamic `import()` only in broker mode, and left out of the
  Docker image (`npm ci --omit=optional`), so device-code mode never loads it.

## 1. Weaker isolation: read this first

In Docker the token lives in another process, in a Linux VM user space, behind a read-only
filesystem, and the only way in is the MCP port (plus `docker exec`, which the guard blocks). In
native mode **the server runs as the same Windows user as Claude Code**. Whatever Claude Code's
shell can do as you, it can do to the server:

| Risk                                                                                   | Docker | Native   |
| -------------------------------------------------------------------------------------- | ------ | -------- |
| Read the server keys (`KEYS_FILE`): plain JSON, Windows ignores the 0600 mode          | Hard   | Easy     |
| Call `/admin/*` with the admin key (start a WAM window, log out, switch context)       | Hard   | Easy     |
| Read `contexts.yaml` (real tenant and subscription IDs)                                | Hard   | Easy     |
| Attach a debugger to, or dump the memory of, the server process (in-memory MSAL cache) | Hard   | Possible |
| Use the account WAM keeps in the Windows account store (other WAM apps, `az` with WAM) | n/a    | Possible |

What still holds in native mode: every tool result is scrubbed (G1, G2), tools are read-only (R2),
the MSAL cache of the server is in memory only (no `tokenCachePersistenceOptions`), and no tool
can start a sign-in. What WAM changes: the **account** (not our token cache) is remembered by
Windows in its own account store, as for any WAM app. That is how the broker works; sign out of
the account in _Settings > Accounts > Email & accounts_ if you do not want Windows to keep it.

### The Claude Code deny rules are MANDATORY in this mode

In Docker the deny rules and the guard are defence in depth. In native mode they are **the only
thing** between the AI's shell and the server's keys, `contexts.yaml` and process. Before you start
the server natively:

1. Install the guard hook in your **user** settings: `safe-azure install` (or
   `safe-azure hook claude` set up as in [SECURITY.md §7](./SECURITY.md#claude-code-guard)). It
   blocks reads of the safe-azure config directory (`%APPDATA%\safe-azure`), `contexts.yaml`,
   `~/.azure`, and shell HTTP calls to the server port (`curl`, `iwr`, `Invoke-RestMethod` to
   `127.0.0.1:8765`).
2. Copy the whole `permissions.deny` block of [`.claude/settings.json`](../.claude/settings.json)
   into `~/.claude/settings.json`, so it applies in every project.
3. Keep **every** server file inside `%APPDATA%\safe-azure`, which both layers protect:
   `contexts.yaml` there, and `KEYS_FILE=%APPDATA%\safe-azure\server\keys.json`. Never leave the
   keys at the default path (`/run/safe-azure/keys.json`, which on Windows is `C:\run\...` and is
   **not** protected).
4. Add deny rules for anything that could reach the server process from the AI's shell, e.g.
   `PowerShell(Stop-Process:*)`, `Bash(procdump:*)`, `PowerShell(procdump:*)`,
   `Bash(node --inspect:*)`, and for the server files if you keep them elsewhere
   (`Read(<that dir>/**)`).
5. Keep Claude Code in its default "ask before running" mode for shell commands. Never run it
   with `--dangerously-skip-permissions` while a native server is running.
6. Sign out of the Azure CLI / Azure PowerShell on this account, or use another account for them
   ([SECURITY.md §7](./SECURITY.md#7-claude-code-deny-rules)).

If you cannot do all of this, use Docker.

## 2. Run it

Requirements: Windows 10/11, Node.js 24+, a clone of this repository.

```powershell
npm ci                 # on Windows this also installs the optional @azure/identity-broker
npm run build
New-Item -ItemType Directory -Force "$env:APPDATA\safe-azure\server" | Out-Null
# contexts.yaml: same format as config/contexts.example.yaml, kept in %APPDATA%\safe-azure.

$env:AUTH_MODE    = 'broker'
$env:CONTEXTS_FILE = "$env:APPDATA\safe-azure\contexts.yaml"
$env:KEYS_FILE    = "$env:APPDATA\safe-azure\server\keys.json"
# --disable-sigusr1, as in the image: no inspector on demand for a process holding tokens.
node --disable-sigusr1 dist/main.js
```

Run it in a terminal of your own, not one Claude Code drives. `HOST` stays `127.0.0.1` (the
default). The startup log line shows `"auth":"broker"`.

### Sign in

The `safe-azure` CLI talks to the Docker container today (it reads the keys with `docker exec`),
so in native mode you call the admin API yourself, **from your own terminal**:

```powershell
$keys = Get-Content "$env:APPDATA\safe-azure\server\keys.json" | ConvertFrom-Json
$h = @{ Authorization = "Bearer $($keys.admin)" }
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8765/admin/login -Headers $h `
  -ContentType 'application/json' -Body '{"context":"prod"}'
# -> 202 {"context":"prod","authMode":"broker","expiresAt":"..."}: the WAM window opens.
Invoke-RestMethod -Uri http://127.0.0.1:8765/admin/login/prod -Headers $h   # pending -> succeeded
```

In broker mode `POST /admin/login` answers **202** at once, with no code; poll
`GET /admin/login/<alias>` until `succeeded`, `failed` (window cancelled or sign-in refused) or
`expired` (no answer within 15 minutes). Logout and context switching are unchanged
(`POST /admin/logout`, `POST /admin/use`).

### Connect Claude Code

`safe-azure mcp` (the stdio bridge) also gets its key through Docker today. Until the CLI supports
native mode, register the HTTP endpoint with the MCP key:

```powershell
claude mcp add --scope user --transport http safe-azure http://127.0.0.1:8765/mcp `
  --header "Authorization: Bearer $($keys.mcp)"
```

The MCP key then sits in your Claude Code config; it gives no more than the tools already give.
Keys change on every server restart: re-register after a restart.

## 3. Packaging (follow-ups)

Not done in #15, on purpose:

- **`safe-azure` CLI support.** `install`, `up`, `doctor`, `login` and `mcp` assume the Docker
  container (keys via `docker exec`, `docker compose` lifecycle). Native mode needs: reading the
  keys from `%APPDATA%\safe-azure\server\keys.json`, handling the `202 {authMode: "broker"}` answer
  of `POST /admin/login` (no code to print, just wait), starting/stopping the Node process, and a
  `doctor` check that the deny rules and the guard are installed (mandatory here).
- **`npx` / single executable.** The npm package `safe-azure` is the Rust CLI wrapper from
  cargo-dist ([RELEASING.md](./RELEASING.md)); the server package is `private`. Shipping the server
  natively means either publishing it (with `@azure/identity-broker` as an optional dependency for
  `npx`), or a Node single executable application (SEA) bundling `dist/` plus the native WAM
  binding (`@azure/msal-node-runtime`), which SEA cannot embed as is.

## 4. Manual test checklist (broker mode)

Unit tests cover mode selection, the startup errors and the login state machine with fakes. WAM
itself can only be tested by hand, on a real Windows desktop, with a test tenant:

- [ ] `npm ci` on Windows installs `@azure/identity-broker`; `npm run build` passes.
- [ ] Without `AUTH_MODE`, the server starts with `"auth":"device-code"` and `safe-azure login`
      (Docker) still prints a code: device-code behaviour unchanged.
- [ ] `AUTH_MODE=wam` (any unknown value) refuses to start.
- [ ] `AUTH_MODE=broker` in the Docker image (`docker compose run -e AUTH_MODE=broker ...`) fails
      with `AUTH_MODE=broker needs native Windows (WAM)`.
- [ ] `AUTH_MODE=broker` after `npm ci --omit=optional` on Windows fails with
      `needs the optional package @azure/identity-broker`, without a stack trace or a path.
- [ ] `AUTH_MODE=broker` on Windows starts with `"auth":"broker"`; `keys.json` is written under
      `%APPDATA%\safe-azure\server`.
- [ ] `POST /admin/login {"context":"prod"}` answers 202 with no `userCode`; a WAM window opens
      (check it is not hidden behind other windows) and offers the Windows work accounts.
- [ ] Signing in with the account of the context's tenant: `GET /admin/login/prod` turns
      `succeeded`; `login_status` (from Claude) shows `loggedIn: true` and minutes left.
- [ ] Tools work: `list_subscriptions`, `search_resources`, `run_kql`; results show aliases and
      names only, no GUID, no email (G2).
- [ ] Cancelling the WAM window: state `failed`; a new `POST /admin/login` opens a new window.
- [ ] Leaving the window open 15+ minutes: state `expired`.
- [ ] A second `POST /admin/login` while a window is open does not open a second window.
- [ ] Two contexts in two different tenants sign in independently.
- [ ] `POST /admin/logout`: `login_status` shows `loggedIn: false`, tools answer `NotLoggedIn`,
      and no new window opens on the next tool call (no silent re-login).
- [ ] Restarting the server drops every sign-in of the server (memory only: a new
      `POST /admin/login` is needed, even if WAM then offers the remembered account); the server
      writes no MSAL cache file (nothing new under `%APPDATA%\safe-azure` other than `keys.json`).
- [ ] Logs (stderr) contain no token, no account name, no tenant ID; the audit lines are scrubbed.
- [ ] From Claude Code with the guard and deny rules installed: reading `keys.json` or
      `contexts.yaml`, and calling `http://127.0.0.1:8765/admin/contexts`, are all refused.
- [ ] Conditional Access / MFA policies of the tenant are honoured in the WAM window.
