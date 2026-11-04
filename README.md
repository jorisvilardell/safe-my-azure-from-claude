# safe-my-azure-from-claude

**Read-only, anonymising Azure MCP server.** Let Claude (or any MCP-capable AI agent) help you
investigate Azure alerts and incidents **without sending credentials or identifiers to the AI**.

- 🔒 **No credentials to the AI.** You sign in with Microsoft device-code login on a local page. The token lives only in the container's memory.
- 🕶️ **No identifiers to the AI.** Subscription/tenant GUIDs, ARM IDs, emails, secrets, tag values, and public IPs are anonymised. Only resource **names** are shown.
- 👀 **Read-only.** There are no write tools and no generic "run any command" tool. Use Azure `Reader` roles.
- 🏢 **Multi-tenant.** Switch between tenants and subscriptions by **alias** from the chat.

> Status: **scaffolding.** The core pipeline and the `system` feature exist. Azure features are on the roadmap (see Issues).

## Quick start

```bash
cp config/contexts.example.yaml config/contexts.yaml   # fill in your tenants (gitignored)
docker compose up -d --build
claude mcp add --transport http azure-safe http://127.0.0.1:8765/mcp
```

Then in Claude: _"call server_info"_.

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
