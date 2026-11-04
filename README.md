# safe-my-azure-from-claude

**Read-only, anonymising Azure MCP server.** Let Claude (or any MCP-capable AI agent) help you
investigate Azure alerts and incidents **without sending credentials or identifiers to the AI**.

- 🔒 **No credentials to the AI.** You sign in with Microsoft device-code login on a local page. The token lives only in the container's memory.
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

## Quick start

Requires Docker Desktop (or Docker Engine with Compose v2) and Claude Code.

```bash
cp config/contexts.example.yaml config/contexts.yaml   # your tenants and subscriptions, by alias (gitignored)
docker compose up -d --build                            # listens on 127.0.0.1:8765 only
claude mcp add --transport http azure-safe http://127.0.0.1:8765/mcp
```

Then, in Claude: _"log me in to prod"_. Open the `/login` link it gives you, enter the code at
Microsoft, and ask: _"what fired in the last hour?"_

## Documentation

- **[docs/USAGE.md](./docs/USAGE.md)**: install, `contexts.yaml`, login, switching contexts, tool reference, walkthroughs, troubleshooting.
- **[docs/SECURITY.md](./docs/SECURITY.md)**: threat model, what the AI can and cannot see, RBAC, deny rules, residual risks.
- **[docs/CLIENTS.md](./docs/CLIENTS.md)**: Claude Desktop, VS Code, Cursor and other MCP clients.
- **[AGENTS.md](./AGENTS.md)**: architecture, security rules and conventions for contributors, human or AI.

## How it protects you

```
 Claude Code ──MCP/HTTP (127.0.0.1)──▶ ┌──────────── container ────────────┐
                                       │ tool → allowlist DTO → scrub()    │──▶ Azure (read-only)
 You (browser) ── /login (device code) ▶│ token cache: in-memory only       │
                                       └───────────────────────────────────┘
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
```

The code follows **Feature-Driven Development** (vertical slices under `src/features/`).
Read **[AGENTS.md](./AGENTS.md)** for the architecture, security rules, and conventions. It's required
reading for humans and AI agents alike.
