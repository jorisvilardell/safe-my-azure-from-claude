# AGENTS.md — Guide for AI coding agents

> Read this file before changing anything in this repository. It applies to every AI agent
> (Claude Code, Copilot, Cursor, Codex, …). `CLAUDE.md` points here.

## 1. What this project is

**safe-my-azure-from-claude** is an MCP (Model Context Protocol) server. It lets an AI agent
**read** Azure (inventory, alerts, activity log, metrics, KQL logs, health, advisor) to help a
human investigate an incident or alert, **without any sensitive data leaving the machine**.

Two guarantees define the project. Every change must preserve both:

| #   | Guarantee                             | Meaning                                                                                                                                                                                   |
| --- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1  | **No credential ever reaches the AI** | Tokens, refresh tokens, device codes, MSAL caches, client secrets, and auth headers never show up in a tool result, an error, or a log.                                                   |
| G2  | **No identifier ever reaches the AI** | Subscription, tenant, and object GUIDs, ARM resource IDs, public IPs, emails/UPNs, secrets, and tag values are anonymised. Only **resource names** (and private IPs) are allowed through. |

Other core properties:

- **Read-only.** No tool may create, update, delete, start, stop, or restart anything. There is no generic "run any ARM/az call" tool, and there never will be.
- **Multi-tenant.** Tenants and subscriptions are declared in `config/contexts.yaml` under **aliases**. The AI only ever sees aliases.
- **Dockerised.** The server runs in a container. It exposes MCP over Streamable HTTP on `127.0.0.1:8765/mcp` and a device-code login page on `127.0.0.1:8765/login`. The token cache lives **in memory only**.

## 2. Architecture (Feature-Driven Development)

The code is organised in **vertical feature slices**. One feature = one business capability =
one folder that owns its tools, service, schemas, mappers, and tests.

```
src/
├─ main.ts                    # Composition root: load config, build deps, register features, start server
├─ app/                       # Application wiring (no business logic)
│  ├─ features.ts             # List of enabled features
│  └─ server.ts               # MCP server + HTTP transport
├─ core/                      # Cross-cutting, feature-agnostic building blocks
│  ├─ anonymizer/             # scrub() — the single choke point for G1/G2
│  ├─ config/                 # Env + contexts.yaml loading (zod-validated)
│  ├─ errors/                 # AppError + sanitizeError()
│  ├─ logging/                # Scrubbing logger (stderr only)
│  └─ mcp/                    # defineTool(), Feature contract, registry
└─ features/
   └─ <feature>/
      ├─ index.ts             # Public API: exports the Feature object ONLY
      ├─ <feature>.tools.ts   # MCP tool definitions (defineTool)
      ├─ <feature>.service.ts # Azure SDK calls, returns raw-ish domain data
      ├─ <feature>.mapper.ts  # Raw SDK response → allowlisted DTO
      ├─ <feature>.schemas.ts # zod input/output schemas
      └─ __tests__/           # Unit tests for this feature (fixtures with FAKE ids)
```

Planned features: `system` (exists, the reference example), `contexts` (login and tenant switching),
`inventory`, `alerts`, `monitor` (metrics), `logs` (KQL), `health` (resource/service health + advisor).

### Dependency rules (enforced by ESLint `no-restricted-imports`)

- `features/*` may import from `core/*`. They may **not** import from another feature or from `app/`.
  Anything two features share moves into `core/`.
- `core/*` must **not** import from `features/*` or `app/`.
- Only `main.ts` and `app/` know the full list of features.
- Outside a feature, import it only through its `index.ts`.

### Feature checklist (Definition of Done)

1. Create a folder under `src/features/<name>/` following the layout above.
2. Every tool is declared with `defineTool()` from `core/mcp`. **Never** call `server.registerTool` directly:
   `defineTool` is what forces the `shape → scrub → sanitizeError` pipeline.
3. The mapper uses an **allowlist**: copy only the fields you need, and never spread a raw SDK object (`...raw`).
4. Inputs take **names or aliases** (`resourceGroup`, `name`, `subscription` alias), never raw IDs. Resolve them to IDs inside the service.
5. Write tests in `__tests__/` with realistic, FAKE payloads that contain GUIDs, ARM IDs, emails, JWTs, and public IPs. Assert that none of them appear in the tool output (`expectNoLeak()` from `test/helpers`).
6. Register the feature in `src/app/features.ts`.
7. Run `npm run check` (lint + typecheck + test + build). It must pass.

## 3. Security rules (non-negotiable)

- **R1.** Never add a tool that returns a token, credential, device code, or raw HTTP request/response.
- **R2.** Never add a write/action API call. Allowed: ARM `GET`, Resource Graph query, Log Analytics / App Insights query, metrics query.
- **R3.** All tool output goes through `scrub()`. Do not bypass `defineTool`.
- **R4.** All errors go through `sanitizeError()`. Never return `err.message` from the Azure SDK as-is (it contains URLs, subscription IDs, correlation IDs).
- **R5.** Logs go to **stderr**, through the scrubbing logger. Never log headers, credentials, or full SDK responses.
- **R6.** KQL: reject management commands (`.show`, `.set`, …), and cap the timespan and row count.
- **R7.** No real Azure identifiers in the repo. That covers tests, fixtures, docs, and commit messages. Use obviously fake GUIDs (`00000000-0000-0000-0000-000000000001`) and documentation IPs (`203.0.113.0/24`, `198.51.100.0/24`).
- **R8.** The token cache stays in memory. Never write credentials to disk, a volume, or an env var dump.
- **R9.** Agents working on this repo must **not** run `az login`, `az account get-access-token`, `docker exec`/`docker cp` against a running server container, or read `~/.azure/**`. `.claude/settings.json` enforces this for Claude Code.

When in doubt, choose the option that reveals **less** to the AI.

## 4. Code conventions & best practices

- **TypeScript strict** (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`). ESM only (`"type": "module"`, `NodeNext`). Relative imports use the `.js` extension.
- No `any`. Use `unknown` and narrow it. No non-null `!` unless it's justified in a comment.
- Validate every external input with **zod**: tool inputs, env, and `contexts.yaml`.
- Use dependency injection through plain factory functions (`createXService(deps)`). Avoid singletons and module-level state, except in `main.ts`.
- Write small pure functions, especially mappers and the anonymiser. They are easy to test.
- Names: files are `kebab-case` / `feature.role.ts`, types `PascalCase`, functions and variables `camelCase`, constants `UPPER_SNAKE_CASE`.
- Don't comment what the code does. Comment **why** when it isn't obvious, especially security decisions.
- Prettier formats, ESLint lints. Don't fight them.
- Tests use **Vitest** and sit next to the code (`__tests__/*.test.ts`). Cross-cutting helpers live in `test/helpers/`.

## 5. Commands

| Command                                   | Purpose                                                       |
| ----------------------------------------- | ------------------------------------------------------------- |
| `npm ci`                                  | Install exact dependencies                                    |
| `npm run dev`                             | Run the server locally with tsx (watch)                       |
| `npm run lint` / `npm run lint:fix`       | ESLint                                                        |
| `npm run format` / `npm run format:check` | Prettier                                                      |
| `npm run typecheck`                       | `tsc --noEmit`                                                |
| `npm test` / `npm run test:coverage`      | Vitest                                                        |
| `npm run build`                           | Compile to `dist/`                                            |
| `npm run check`                           | lint + format:check + typecheck + test + build (what CI runs) |
| `docker compose up -d --build`            | Run the server container                                      |

## 6. Git & CI

- Branch from `main` (`feat/<feature>`, `fix/…`, `chore/…`).
- **Commit & PR format:** a short title (Conventional Commits style, e.g. `feat(inventory): add search_resources`), optionally followed by a short description. A description isn't required.
- **No co-authoring:** never add `Co-Authored-By:` trailers, "Generated with …" footers, or any AI attribution to commits or pull requests.
- **Squash merge only:** each PR lands on `main` as one commit, titled with the PR title.
- CI (`.github/workflows/ci.yml`) runs `npm run check` on Node 24 and 26, and builds the Docker image. A PR must be green before merge.
- Don't commit `config/contexts.yaml`, `.env`, or anything containing a real tenant or subscription ID. They're gitignored.
