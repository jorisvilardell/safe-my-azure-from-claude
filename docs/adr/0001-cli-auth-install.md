# ADR 0001: Rust CLI, local authentication, one-command install and update

- Status: accepted (2026-11-05)
- Issues: #52 (protect `/login` and `/mcp`), plus the CLI epic

## Context

- Any local process, including an AI agent running `curl` or `Invoke-WebRequest`, can read `/login`, which shows the device code, and can call `/mcp` without any key.
- Installing means several manual steps: Docker, `contexts.yaml`, `claude mcp add`, deny rules.
- The skill and deny rules are guidance; only a hook can actually block an agent.

## Decision

A native **Rust CLI, `safe-azure`**, in `cli/`, is the only human entry point. The Docker server keeps every Azure call and every token.

### 1. Keys

- At startup the server generates two random 256-bit keys, `mcp` and `admin`.
- They are written **only** to `/run/safe-azure/keys.json`, a mode-0600 file on a container tmpfs: never logged, never in env, never on a volume.
- The CLI reads them with `docker exec <container> cat /run/safe-azure/keys.json`. The hook blocks `docker exec` for agents.
- The CLI caches the keys encrypted: DPAPI (`CryptProtectData`, current user) on Windows, a 0600 file elsewhere. The cache lives in `config_dir()/keys.bin`.
- On a 401 the CLI re-reads the keys. They change on every container restart.

### 2. Endpoints (all on the container port, published on `127.0.0.1` only)

| Path                             | Auth                              | Purpose                                                                                                                              |
| -------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /mcp`                      | `Authorization: Bearer <mcp key>` | MCP Streamable HTTP. A missing or wrong key gets 401 (constant-time compare).                                                        |
| `GET /healthz`                   | none                              | liveness only, `{status, version}`                                                                                                   |
| `GET /admin/contexts`            | `Bearer <admin key>`              | `[{alias, subscriptions, active, loggedIn, expiresInMinutes?, loginPending}]`                                                        |
| `POST /admin/login` `{context}`  | admin                             | starts device code, returns `{context, userCode, verificationUri, expiresAt}`. **This is the only place the code is ever returned.** |
| `GET /admin/login/:context`      | admin                             | `{state: pending\|succeeded\|failed\|expired}`, polled by the CLI                                                                    |
| `POST /admin/logout` `{context}` | admin                             | drops the credential                                                                                                                 |
| `POST /admin/use` `{context}`    | admin                             | switches the active context                                                                                                          |

- The **`/login` page is removed.**
- The MCP `login` tool keeps its name but only answers: _"Ask the user to run `safe-azure login <context>` in their own terminal."_
- `login_status`, `list_contexts`, `use_context` and `logout` stay as MCP tools. They never expose a code or a key.
- All admin responses are `Cache-Control: no-store`. Host-header validation stays.
- `/admin/*` never goes through the anonymizer, because it is not AI-facing. It must still never log the user code.

### 3. Login (CLI)

- `safe-azure login [context]` **refuses unless stdin and stdout are a TTY**. Agent shells are not TTYs.
- It prints the code and opens `verificationUri` in the default browser, then polls until the state is `succeeded`, `failed` or `expired`.
- This is defence in depth, together with the hook.

### 4. MCP bridge

- MCP clients are registered with `safe-azure mcp`, a stdio ⇄ Streamable HTTP bridge that adds the MCP key itself. No key is ever written to a client config file.
- Claude Code: `claude mcp add --scope user safe-azure -- safe-azure mcp`.

### 5. Claude Code hook (installed automatically)

- `safe-azure install` merges a `PreToolUse` hook into `~/.claude/settings.json` (user level, so it covers every project).
- The hook is `{"matcher": "*", "hooks": [{"type": "command", "command": "safe-azure hook claude"}]}`. The settings file is backed up first, and the merge is idempotent.
- `safe-azure hook claude` reads the event JSON on stdin and blocks with exit code 2 plus a reason on stderr:
  - shell commands (Bash or PowerShell tools) that run `safe-azure login|keys|install|uninstall|update|down`;
  - `az account get-access-token`, `az login`, `az ad`, `az account show`;
  - `docker exec|cp|inspect|logs|attach` and `docker compose exec|logs`;
  - HTTP clients (`curl`, `wget`, `Invoke-WebRequest`, `iwr`, `Invoke-RestMethod`, `irm`, `node -e`/`python -c` with `fetch`/`http`) aimed at `127.0.0.1`, `localhost` or `::1` on the server ports;
  - reading, writing, editing or grepping `~/.azure/**` or the CLI config dir;
  - editing `~/.claude/settings.json` hooks (self-protection).
- Fail **closed** on malformed input for those tools; everything else passes.

### 6. Skill (installed automatically)

`~/.claude/skills/safe-azure/SKILL.md` contains:

- the rules: MCP tools only, untrusted data, `warnings`, refs `rg/type/name`, never pull the full inventory without a reason, ask the user to run `safe-azure login`;
- the investigation playbook: alerts → activity log → metrics → logs → health.

### 7. Install and update

- **One command.** Windows: `powershell -ExecutionPolicy ByPass -c "irm https://github.com/jorisvilardell/safe-my-azure-from-claude/releases/latest/download/safe-azure-installer.ps1 | iex"`. Linux/macOS: the `.sh` equivalent. There is also `npx safe-azure`. All are generated by `cargo-dist` from one tag. The installer ends by telling the user to run `safe-azure install`.
- **`safe-azure install`**:
  1. check Docker;
  2. write `contexts.yaml` (wizard or `--contexts`);
  3. `docker pull ghcr.io/jorisvilardell/safe-my-azure-from-claude:<CLI version>`;
  4. run the container hardened (loopback port, read-only, tmpfs, `cap_drop ALL`, `no-new-privileges`, restart unless-stopped, contexts mounted read-only);
  5. fetch the keys;
  6. register the MCP, install the skill and merge the hook;
  7. finish with `doctor`.
- **Version lock.** The CLI version equals the image tag; one release builds both.
- **`safe-azure update`**:
  1. self-update the binary (axoupdater / cargo-dist);
  2. re-exec the new binary;
  3. pull the image for the new version and recreate the container. In-memory logins are lost, and the CLI says so;
  4. re-fetch the keys and re-apply the hook, skill and registration idempotently;
  5. run `doctor`.
- `update --check` only reports. The CLI warns about a newer release at most once a day.
- **`doctor`** checks Docker, container health, version skew, keys, the hook entry, skill presence and MCP registration.

## Consequences

- No Node.js is needed on the host; Docker plus one binary is enough.
- An agent running as the same user can still try other routes. The hook and the TTY check raise the bar; DPAPI stops plain file reads. Remaining routes are documented in `docs/SECURITY.md`.
- Login state still never survives a restart (unchanged, see #14).
