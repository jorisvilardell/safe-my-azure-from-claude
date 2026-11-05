# safe-my-azure-from-claude

**Read-only, anonymising Azure MCP server.** Let Claude (or any MCP-capable AI agent) help you
investigate Azure alerts and incidents **without sending credentials or identifiers to the AI**.

- 🔒 **No credentials to the AI.** You sign in with Microsoft device-code login from your own terminal (`safe-azure login`). The token lives only in the container's memory.
- 🕶️ **No identifiers to the AI.** Subscription/tenant GUIDs, ARM IDs, emails, secrets, tag values, and public IPs are anonymised. Only resource **names** are shown.
- 👀 **Read-only.** There are no write tools and no generic "run any command" tool. Use Azure `Reader` roles.
- 🏢 **Multi-tenant.** Switch between tenants and subscriptions by **alias** from the chat.

> Status: **usable.** Inventory, alerts and activity log, metrics, KQL logs, and health (Resource
> Health, Service Health, Advisor) are done. Planned: prompt-injection hardening
> ([#39](https://github.com/jorisvilardell/safe-my-azure-from-claude/issues/39)), an audit log
> ([#13](https://github.com/jorisvilardell/safe-my-azure-from-claude/issues/13)), an in-memory inventory
> index ([#33](https://github.com/jorisvilardell/safe-my-azure-from-claude/issues/33)) and Dev Proxy mocks
> ([#37](https://github.com/jorisvilardell/safe-my-azure-from-claude/issues/37)).

## Features

| Feature   | What it answers                                  | Tools                                                                               |
| --------- | ------------------------------------------------ | ----------------------------------------------------------------------------------- |
| system    | What can this server do?                         | `server_info`                                                                       |
| contexts  | Which tenant am I in? Sign me in.                | `list_contexts`, `use_context`, `login`, `login_status`, `logout`                   |
| inventory | What exists, and where?                          | `list_subscriptions`, `list_resource_groups`, `search_resources`, `get_resource`    |
| alerts    | What fired, and what changed around it?          | `list_fired_alerts`, `get_alert`, `list_alert_rules`, `get_activity_log`            |
| metrics   | What do the numbers say?                         | `list_metric_definitions`, `get_metrics`                                            |
| logs      | What do the logs say? (guarded, read-only KQL)   | `list_workspaces`, `list_tables`, `run_kql`                                         |
| health    | Is it the platform? What does Advisor recommend? | `get_resource_health`, `list_service_health_events`, `list_advisor_recommendations` |

Every tool, with its inputs, is in the [tool reference](./docs/USAGE.md#7-tool-reference).

## Install

Requires Docker Desktop (or Docker Engine) and Claude Code. One command installs the `safe-azure` CLI:

```powershell
# Windows (x64, arm64)
powershell -ExecutionPolicy ByPass -c "irm https://github.com/jorisvilardell/safe-my-azure-from-claude/releases/latest/download/safe-azure-installer.ps1 | iex"
```

```bash
# Linux and macOS (x64, arm64)
curl --proto '=https' --tlsv1.2 -LsSf https://github.com/jorisvilardell/safe-my-azure-from-claude/releases/latest/download/safe-azure-installer.sh | sh

# Or, with Node.js
npx safe-azure --help
```

Then let it set everything up: it pulls the server image of the same version, starts it hardened
on `127.0.0.1`, and registers it with Claude Code.

```bash
safe-azure install
```

To update the CLI, the server image and the Claude Code integration together:

```bash
safe-azure update           # update --check only reports
```

Releases are built from one tag (see [docs/RELEASING.md](./docs/RELEASING.md)): the CLI version is
always the server image tag, `ghcr.io/jorisvilardell/safe-my-azure-from-claude:<version>`.

## Quick start (from source)

Requires Docker Desktop (or Docker Engine with Compose v2) and Claude Code.

```bash
cp config/contexts.example.yaml config/contexts.yaml   # your tenants and subscriptions, by alias (gitignored)
docker compose up -d --build                            # listens on 127.0.0.1:8765 only
claude mcp add --scope user safe-azure -- safe-azure mcp  # stdio bridge that adds the MCP key
```

Then, in your own terminal, run `safe-azure login prod`, enter the code it prints at Microsoft, and
ask Claude: _"what fired in the last hour?"_ The `safe-azure` CLI is tracked in
[#60](https://github.com/jorisvilardell/safe-my-azure-from-claude/issues/60)–[#63](https://github.com/jorisvilardell/safe-my-azure-from-claude/issues/63).

## Documentation

- **[docs/USAGE.md](./docs/USAGE.md)**: install, `contexts.yaml`, login, switching contexts, tool reference, walkthroughs, troubleshooting.
- **[docs/SECURITY.md](./docs/SECURITY.md)**: threat model, what the AI can and cannot see, RBAC, deny rules, residual risks.
- **[docs/CLIENTS.md](./docs/CLIENTS.md)**: Claude Desktop, VS Code, Cursor and other MCP clients.
- **[docs/RELEASING.md](./docs/RELEASING.md)**: version bump, tag, and what the release workflows publish.
- **[AGENTS.md](./AGENTS.md)**: architecture, security rules and conventions for contributors, human or AI.

## Try it without an Azure tenant

[Dev Proxy](https://learn.microsoft.com/microsoft-cloud/dev/dev-proxy/overview) can play Azure for you.
It answers `login.microsoftonline.com`, `management.azure.com` and `api.loganalytics.io` with the
hand-written payloads in [`mocks/devproxy/`](./mocks/devproxy). Every ID in them is fake. The device-code
login completes on its own, so you don't need a browser either.

**Docker only** (Windows, macOS, Linux):

```bash
docker compose -f docker-compose.yml -f docker-compose.mock.yml up -d --build --wait
claude mcp add --scope user safe-azure -- safe-azure mcp
safe-azure login prod   # completes on its own against the mocked Entra ID
```

Then in Claude: _"show me the fired alerts and what happened on vm-web-01"_.
To stop it, run `docker compose -f docker-compose.yml -f docker-compose.mock.yml down -v`.

To try failure handling (random 5xx, 429 with `Retry-After`, and up to 1.5 s of latency on ARM and Log Analytics),
start the stack with the chaos preset:

```powershell
$env:DEVPROXY_CONFIG = "devproxyrc.chaos.json"   # bash: export DEVPROXY_CONFIG=devproxyrc.chaos.json
docker compose -f docker-compose.yml -f docker-compose.mock.yml up -d --build --wait
```

**Without Docker** (Windows, PowerShell). Install Dev Proxy, then open a new terminal:

```powershell
winget install DevProxy.DevProxy --silent
devproxy --config-file mocks/devproxy/devproxyrc.json   # the first time, accept to trust its certificate
```

In a second terminal, run the server through it:

```powershell
$env:HTTPS_PROXY = "http://127.0.0.1:8000"
$env:NODE_OPTIONS = "--use-system-ca"           # Node trusts the Dev Proxy root in the Windows store
$env:CONTEXTS_FILE = "mocks/contexts.mock.yaml"
npm ci; npm run dev
```

The proxy and the extra CA only exist in the mock setup. `docker-compose.yml` alone never uses a proxy
or trusts an extra CA. The mocks are hand-written. **Never commit recorded traffic** (for example from Dev
Proxy's `MockGeneratorPlugin`): it contains real tenant, subscription and resource IDs (AGENTS.md R7).
CI runs the same stack in the `e2e-mock` job (`npm run test:e2e-mock`).

## How it protects you

```
 Claude Code ─ safe-azure mcp ─ /mcp + Bearer key ─▶ ┌──────── container ─────────────┐
                                                     │ tool → allowlist DTO → scrub() │──▶ Azure (read-only)
 You (terminal) ─ safe-azure login ─ /admin + key ──▶ │ token cache: in-memory only    │
                                                     └────────────────────────────────┘
```

- Every tool result goes through `scrub()` (`src/core/anonymizer`). Every error goes through `sanitizeError()`.
- `.claude/settings.json` blocks Claude Code from getting around the server (`az account get-access-token`, `docker exec`, `~/.azure`).
- Assign `Reader`, `Monitoring Reader`, and `Log Analytics Reader` to the account you sign in with.
- Some things still reach the AI on purpose (resource names, log content after scrubbing). Read the
  [residual risks](./docs/SECURITY.md#8-residual-risks) before you point it at a tenant.

## Development

Requires Node ≥ 24.

```bash
npm ci
npm run dev        # watch mode
npm run check      # lint + format + typecheck + test + build (same as CI)
npm run test:e2e-mock   # against the running mock stack (see "Try it without an Azure tenant")
```

The code follows **Feature-Driven Development** (vertical slices under `src/features/`).
Read **[AGENTS.md](./AGENTS.md)** for the architecture, security rules, and conventions. It's required
reading for humans and AI agents alike.
