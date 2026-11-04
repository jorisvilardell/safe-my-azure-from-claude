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
│  ├─ azure/                  # AzureAccess: contexts, sessions, Resource Graph, SDK client cache, resolver
│  ├─ config/                 # Env + contexts.yaml loading (zod-validated)
│  ├─ errors/                 # AppError + sanitizeError()
│  ├─ logging/                # Scrubbing logger (stderr only); Azure SDK logging forced off
│  ├─ mcp/                    # defineTool(), ToolContext, Feature contract, registry
│  └─ safety/                 # KQL guard (management commands, timespan and row caps)
└─ features/
   └─ <feature>/
      ├─ index.ts             # Public API: exports the Feature object ONLY
      ├─ <feature>.tools.ts   # MCP tool definitions (defineTool)
      ├─ <feature>.service.ts # Azure SDK calls, returns raw-ish domain data
      ├─ <feature>.mapper.ts  # Raw SDK response → allowlisted DTO
      ├─ <feature>.schemas.ts # zod input/output schemas
      └─ __tests__/           # Unit tests for this feature (fixtures with FAKE ids)
```

Features (registered in `src/app/features.ts`; every tool is listed in
[docs/USAGE.md](./docs/USAGE.md#7-tool-reference)):

| Feature     | Tools                                                                               |
| ----------- | ----------------------------------------------------------------------------------- |
| `system`    | `server_info` (the smallest feature: start here as a reference)                     |
| `contexts`  | `list_contexts`, `use_context`, `login`, `login_status`, `logout`                   |
| `inventory` | `list_subscriptions`, `list_resource_groups`, `search_resources`, `get_resource`    |
| `alerts`    | `list_fired_alerts`, `get_alert`, `list_alert_rules`, `get_activity_log`            |
| `metrics`   | `list_metric_definitions`, `get_metrics`                                            |
| `logs`      | `list_workspaces`, `list_tables`, `run_kql`                                         |
| `health`    | `get_resource_health`, `list_service_health_events`, `list_advisor_recommendations` |

Planned: prompt-injection hardening ([#39](https://github.com/jorisvilardell/safe-my-azure-from-claude/issues/39)),
an audit log ([#13](https://github.com/jorisvilardell/safe-my-azure-from-claude/issues/13)), an in-memory
inventory index ([#33](https://github.com/jorisvilardell/safe-my-azure-from-claude/issues/33)) and Dev Proxy
mocks ([#37](https://github.com/jorisvilardell/safe-my-azure-from-claude/issues/37)). The threat model is in
[docs/SECURITY.md](./docs/SECURITY.md).

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
5. Get Azure access **only** through the handler's `ctx` (`ToolContext`). Never build a credential, and never `new` an SDK client outside `ctx.azure.clients`:
   - `ctx.azure.session()`: the active context's `credential` and real subscription IDs (`subscriptionId(alias)`, `subscriptionIds()`). Throws `NoActiveContext` / `NotLoggedIn` (already AI-friendly `AppError`s).
   - `ctx.azure.resourceGraph.query(kql, { subscriptions?, maxRows? })` → rows; `.queryResult(...)` → `{ rows, truncated }`. Pass `truncated` on to the AI. Put AI input into KQL with `kqlString()` only.
   - `ctx.azure.clients.getClient(session, key, (credential) => new SomeClient(credential, …))`: the shared per-context client cache. The key must identify everything the client is bound to (e.g. `alerts:<subscriptionId>`).
   - `ctx.azure.resolver.resolve({ name, resourceGroup?, subscription?, type? })` → ARM ID, for name-based inputs.
   - `ctx.azure.inventory.current()` → the active context's in-memory inventory snapshot (resources and
     resource groups: name, type, resourceGroup, location, subscriptionId, ARM ID, sku, kind, tags, public
     IPs), or `undefined` when it is not fresh (building, stale, over the `INVENTORY_MAX_RESOURCES` cap, or
     disabled). Serve name/type/location lookups from `snapshot.find({...})` when it is defined, and fall
     back to the live Resource Graph query otherwise, with the **same output**. The resolver and the public
     IP index already do. The snapshot holds ARM IDs and raw tags: map it through the allowlist mapper like
     a Resource Graph row. It lives **in memory only** (never on disk, a volume or a tmpfs DB), is dropped
     on logout and gone on restart: never persist, cache or export it anywhere else.
   - `ctx.anonymizer`: `executeTool` scrubs every result with it, so don't scrub by hand. Use `ctx.anonymizer.pseudonymizer.resolve(pseudonym)` to turn a pseudonym the AI sent back (e.g. an alert ref) into the real value. For tags, return them under a `tags` key (masked automatically) or call `maskTags()` from `core/anonymizer`.
6. Write tests in `__tests__/` with realistic, FAKE payloads that contain GUIDs, ARM IDs, emails, JWTs, and public IPs. Run tools through `executeTool(tool, args, createTestToolContext({ azure }))` and assert that none of them appear in the output (`expectNoLeak()` from `test/helpers`). Stub Azure with `createFakeAzureAccess()`: `resourceGraphRows` / `setResourceGraphRows()` for Resource Graph, `stubClient(key, fake)` for any other SDK client (an unstubbed key throws, so tests never reach the network). The inventory index is off in the fake unless you pass `inventory: { now, ttlMs, maxResources }`; then it reads the rows served for `INVENTORY_QUERY`. Test both paths if your tool uses it.
7. Register the feature in `src/app/features.ts`.
8. Run `npm run check` (lint + typecheck + test + build). It must pass.

```ts
// <feature>.service.ts
export async function listVms(azure: AzureAccess, input: { subscription?: string; resourceGroup?: string }) {
  const session = azure.session();
  const subscriptions =
    input.subscription === undefined ? undefined : [session.subscriptionId(input.subscription)];
  const filter =
    input.resourceGroup === undefined ? '' : `| where resourceGroup =~ ${kqlString(input.resourceGroup)}`;
  const { rows, truncated } = await azure.resourceGraph.queryResult<unknown>(
    `resources | where type =~ 'microsoft.compute/virtualmachines' ${filter} | project id, name, location, tags`,
    { maxRows: 200, ...(subscriptions === undefined ? {} : { subscriptions }) },
  );
  return { vms: rows.map(toVmDto), truncated }; // toVmDto: allowlist mapper (rule 3)
}

// <feature>.tools.ts
defineTool({
  name: 'list_vms',
  title: 'List VMs',
  description: '…',
  inputSchema: ListVmsInput,
  handler: (args, ctx) => listVms(ctx.azure, args),
});

// __tests__/<feature>.test.ts
const azure = createFakeAzureAccess({
  resourceGraphRows: [{ id: FAKE_VM_ID, name: 'vm-web-01', location: 'westeurope' }],
});
const result = await executeTool(tool, {}, createTestToolContext({ azure }));
expectNoLeak(toolText(result));
```

## 3. Security rules (non-negotiable)

- **R1.** Never add a tool that returns a token, credential, device code, or raw HTTP request/response.
- **R2.** Never add a write/action API call. Allowed: ARM `GET`, Resource Graph query, Log Analytics / App Insights query, metrics query.
- **R3.** All tool output goes through `scrub()`. Do not bypass `defineTool`.
- **R4.** All errors go through `sanitizeError()`. Never return `err.message` from the Azure SDK as-is (it contains URLs, subscription IDs, correlation IDs).
- **R5.** Logs go to **stderr**, through the scrubbing logger. Never log headers, credentials, or full SDK responses.
- **R6.** KQL: reject management commands (`.show`, `.set`, …), and cap the timespan and row count.
- **R7.** No real Azure identifiers in the repo. That covers tests, fixtures, docs, and commit messages. Use obviously fake GUIDs (`00000000-0000-0000-0000-000000000001`) and documentation IPs (`203.0.113.0/24`, `198.51.100.0/24`).
- **R8.** The token cache stays in memory. Never write credentials to disk, a volume, or an env var dump. The same goes for the inventory index (`core/azure/inventory-index.ts`): memory only, dropped on logout.
- **R8b.** MCP resources (only `azure://inventory/<context>`, opt-in with `INVENTORY_RESOURCE=on`) are registered in `app/` and their content goes through `ctx.anonymizer.scrub()` and `sanitizeError()`, exactly like a tool result.
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
- **Commit author email:** commits must be authored with the maintainer's GitHub noreply address,
  `73846641+jorisvilardell@users.noreply.github.com` (`git config user.email` in the repo). With any
  other address, GitHub's squash merge adds a `Co-authored-by:` trailer to the merged commit, which
  this repo forbids.
- **Squash merge only:** each PR lands on `main` as one commit, titled with the PR title.
- CI (`.github/workflows/ci.yml`) runs `npm run check` on Node 24 and 26, and builds the Docker image. A PR must be green before merge.
- Don't commit `config/contexts.yaml`, `.env`, or anything containing a real tenant or subscription ID. They're gitignored.
