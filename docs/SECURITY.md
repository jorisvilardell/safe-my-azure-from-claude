# Security and threat model

This document says what **safe-my-azure-from-claude** protects, how, and where its protection ends.
It describes the code as it is on `main`. Planned work is marked as planned, with a link to its issue.

- [1. What we protect, and from whom](#1-what-we-protect-and-from-whom)
- [2. The two guarantees and how they are enforced](#2-the-two-guarantees-and-how-they-are-enforced)
- [3. Trust boundaries](#3-trust-boundaries)
- [4. What the AI can and cannot see](#4-what-the-ai-can-and-cannot-see)
- [5. Login: device code, Docker and an in-memory token](#5-login-device-code-docker-and-an-in-memory-token)
- [6. Read-only by design, and RBAC](#6-read-only-by-design-and-rbac)
- [7. Claude Code deny rules](#7-claude-code-deny-rules)
- [8. Residual risks](#8-residual-risks)
- [9. Reporting a vulnerability](#9-reporting-a-vulnerability)

## 1. What we protect, and from whom

The server lets an AI agent **read** Azure to help a human investigate an alert or an incident.
The **AI agent and its provider are the party we protect against.** The agent is useful and is
trusted to reason about the data, but anything that enters its context window may be stored,
logged, sent to a model provider or repeated somewhere else. So the server decides what crosses
that line, and the agent never holds the keys.

| Asset                                                                         | Why it matters                                              |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Azure access and refresh tokens, MSAL cache, device codes                     | Whoever holds them can act as you in Azure.                 |
| Tenant, subscription and object GUIDs, ARM resource IDs                       | They let someone target your tenant and correlate data.     |
| Public IPs, emails and UPNs, people's names                                   | Attack surface and personal data.                           |
| Secrets found in data (connection strings, keys, JWTs, passwords, SAS tokens) | Direct access to other systems.                             |
| Tag values                                                                    | People put emails, ticket numbers and cost centres in them. |

Out of scope: an attacker who already controls your Windows session, Docker Desktop or the
container (they can read process memory), and Microsoft itself.

## 2. The two guarantees and how they are enforced

| #   | Guarantee                             | Meaning                                                                                                                                                                      |
| --- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1  | **No credential ever reaches the AI** | Tokens, refresh tokens, device codes, MSAL caches, client secrets and auth headers never show up in a tool result, an error or a log.                                        |
| G2  | **No identifier ever reaches the AI** | Subscription, tenant and object GUIDs, ARM resource IDs, public IPs, emails and UPNs, secrets and tag values are anonymised. Only **resource names** (and private IPs) pass. |

They are enforced in layers. Each layer assumes the one before it can fail.

### Layer 1: inputs are names, never IDs

Tool inputs are resource group names, resource names, subscription **aliases** and context
**aliases**, validated with zod (charset and length). The server resolves them to ARM IDs itself
(`core/azure/resolver.ts`, a 5-minute in-memory cache per context). AI input reaches KQL only
through `kqlString()` and OData only through `odataString()`. When the AI has to point back at
something it was shown (an alert, a metric dimension value), it sends a **pseudonym** such as
`id-007`. The server resolves it in memory (`Pseudonymizer.resolve`) and checks that it is the
kind of thing it expects (for example, `get_alert` only accepts the pseudonym of an alert ID).

Resource Graph queries are always scoped to the subscriptions declared for the active context.
An empty scope would mean "the whole tenant", so it returns nothing instead
(`core/azure/resource-graph.ts`).

### Layer 2: allowlist mappers

Every feature has a `<feature>.mapper.ts` that copies **only** the fields it needs from the raw SDK
response into a DTO. Nothing spreads a raw object. Examples:

- workspaces: the Log Analytics `customerId` and the ARM ID stay server-side;
- alerts: the alert context keeps the metric, operator, threshold, value, window and dimensions,
  but not the portal links, resource IDs, search queries or result links;
- inventory: a small per-type property allowlist (VM size, power state, App Service state, AKS
  version…). Unknown types get no properties at all;
- free text is capped (128 to 1024 characters depending on the field) so one field cannot flood
  the context.

ARM IDs are turned into `resourceGroup/type/name` refs (`shortenArmId`, `resourceRef`), and real
subscription IDs into their alias from `contexts.yaml`.

### Layer 3: `executeTool` scrubs every result and sanitises every error

Every tool is declared with `defineTool()` and registered by `registerFeatures()`, which always
runs it through `executeTool()` (`core/mcp/define-tool.ts`):

```
handler(args, ctx) ──▶ scrub(result) ──▶ JSON text to the AI
        │
        └─ throws ──▶ sanitizeError(err) ──▶ scrub(safeError) ──▶ isError result
```

`scrub()` (`core/anonymizer/scrub.ts`) deep-walks the result, keys included. In order:

1. **Secrets are removed whole**: PEM blocks (also unterminated private keys), JWTs, SAS tokens and
   `SharedAccessSignature=`, `Bearer …`, `key=value` secrets (`AccountKey`, `SharedAccessKey`,
   `sig`, `password`, `client_secret`, `access_token`, `code`, …), secret JSON fields inside text,
   and credential headers (`Authorization`, `Cookie`, `x-ms-token-*`, `x-ms-client-principal*`…).
2. **ARM IDs** become `rg/type/name`, or `sub:<alias>/…` when they are subscription-scoped.
3. **GUIDs** become `id-NNN` (or `app-NNN` under `appId`, `clientId`, …). Known tenant and
   subscription IDs become their alias (`tenant-<context>`, `<subscription alias>`).
4. **Emails and UPNs** become `user-NNN`.
5. **Public IPs** (v4 and v6) become `public-ip-<name>` when they belong to one of your Public IP
   resources, or `public-ip-external-NNN` otherwise. Private, CGNAT, loopback, link-local,
   multicast and reserved ranges, and the Azure platform IP `168.63.129.16`, are kept.

Field names drive extra rules (`core/anonymizer/fields.ts`):

- keys that look like secrets (`password`, `clientSecret`, `primaryKey`, `accessToken`, `sig`,
  `x-ms-token-*`, …) are `[REDACTED]`, including every leaf under them;
- objects under a `tags` key keep their keys, but values are `[masked]` unless the key is in
  `safeTagKeys`. Kept values are still scrubbed;
- `caller`, `userPrincipalName`, `createdBy`, `owner`, … become `user-NNN` (`app-NNN` for a bare
  GUID). `displayName` and `name` are treated as a person only inside an identity object
  (`identity`, `principal`, `claims`, …, or next to `principalId`/`appId`), so resource names
  survive;
- `*Version` fields are not scanned for IPv4, so `1.10.2.0` stays a version.

Pseudonyms are stable for the life of the process: the same email is always `user-003`, so the
AI can correlate events without knowing who it is. The reverse map lives only in server memory.

`sanitizeError()` (`core/errors`) keeps the message only for our own `AppError`s, which are written
to be safe. For anything else, such as an Azure SDK `RestError`, it keeps the HTTP status and a
purely alphabetic error code, and drops the message, which contains request URLs, subscription IDs
and correlation IDs.

### Layer 4: the scrubbing logger

Server logs are JSON lines on **stderr only** (`core/logging`). Every line goes through the same
anonymiser, with the same aliases and `safeTagKeys`, but without the public IP index (a log line
must never trigger an Azure call), so public IPs in logs are always `public-ip-external-NNN`. The
code never logs headers, credentials, device codes or full SDK responses. Failed logins drop the
SDK error on purpose, because it may echo the device-code response.

### Layer 5: Azure SDK logging is silenced

`silenceAzureSdkLogging()` runs first thing in `main.ts`. It lowers the `@azure/logger` and
`@typespec/ts-http-runtime` log levels **and** replaces their sinks with a no-op. Those loggers write
straight to stderr, with request URLs, tenant and subscription IDs and account names, and
`AZURE_LOG_LEVEL` or `DEBUG` would otherwise turn them on behind our logger's back. A fatal startup
error prints a fixed message only.

### Layer 6: tests and CI

- Every feature's tests run its tools through `executeTool` with fake payloads full of GUIDs, ARM
  IDs, emails, JWTs and public IPs, and assert that none of them come out (`expectNoLeak()`).
- An e2e test drives the real HTTP server over MCP.
- The CI `leak-guard` job rejects any GUID in the repository that is not obviously fake
  (`00000000-0000-0000-0000-…`). Docs and fixtures use documentation IPs
  (`203.0.113.0/24`, `198.51.100.0/24`).

## 3. Trust boundaries

```
 Host (your Windows session)                                Docker Desktop VM
┌───────────────────────────────────────┐                ┌─────────────────────────────────────┐
│                                       │  MCP over      │ container azure-safe-mcp            │
│  Claude Code / other MCP client ──────┼─ HTTP ────────▶│  read-only rootfs, cap_drop ALL,    │
│   (AI agent, untrusted with secrets)  │  127.0.0.1:8765│  no-new-privileges, user "node"     │
│        ▲  tool results: scrubbed JSON │  /mcp          │                                     │
│        └──────────────────────────────┼────────────────│  tool ─▶ mapper ─▶ scrub() ─▶ result│
│                                       │                │                                     │
│  Browser (you, the human) ────────────┼─ HTTP ────────▶│  /login: device code, human only    │
│        │                              │  /login        │                                     │
│        │                              │                │  token cache: process memory only   │
│        ▼                              │                │           │                         │
│  microsoft.com/devicelogin (sign in)  │                └───────────┼─────────────────────────┘
└────────┼──────────────────────────────┘                            │ HTTPS, read-only calls
         │                                                           ▼
         └──────────────────────────────▶ Entra ID ◀──────▶ Azure (ARM, Resource Graph,
                                         (tokens go to        Monitor, Log Analytics,
                                          the container)      App Insights, Advisor)
```

| Boundary                    | What crosses it                                                          | Control                                                                                                                                                                                                                  |
| --------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| AI client ⇄ MCP server      | Tool calls (names, aliases, pseudonyms, KQL) and scrubbed results        | Port published on `127.0.0.1` only. Host-header allowlist (`localhost`, `127.0.0.1`, `[::1]`) against DNS rebinding. Stateless Streamable HTTP. zod-validated inputs. Every result scrubbed. No authentication (see §8). |
| Browser ⇄ `/login`          | Device code and verification URL, to the human                           | Same loopback port and host check. Strict CSP (no scripts, no forms, no framing), `no-store`, `no-referrer`. Never reachable through a tool.                                                                             |
| Container ⇄ Entra ID, Azure | Device-code flow, tokens, read-only API calls                            | `DeviceCodeCredential` with no persistent cache. Only GET-style APIs, Resource Graph and query APIs are called.                                                                                                          |
| Host ⇄ container            | `config/contexts.yaml` mounted read-only (aliases and GUIDs, no secrets) | Read-only root filesystem, `tmpfs` `/tmp`, all capabilities dropped, `no-new-privileges`, non-root user. No volume for tokens.                                                                                           |

## 4. What the AI can and cannot see

### It can see

- **Resource names**: resource groups, resources, workspaces, alert rules, metrics, tables, and refs
  like `rg-app-prod/virtualMachines/vm-web-01`.
- **Aliases** from `contexts.yaml`: `prod`, `prod-app`, `tenant-prod`.
- **Private IPs** (`10.0.0.4`, `192.168.1.10`, `fd00::1`…) and the Azure platform IP.
- **Pseudonyms**: `id-NNN` (GUIDs, alert refs, correlation IDs, Service Health tracking IDs),
  `user-NNN` (people), `app-NNN` (service principals), `public-ip-<name>` and
  `public-ip-external-NNN`.
- **Tag keys**, and tag **values** only for keys listed in `safeTagKeys`.
- Locations, SKUs, kinds, provisioning and power states, a few per-type properties, App Service
  default host names (`<name>.azurewebsites.net`).
- Alert severity, state, condition, threshold and value; activity log operation names and status;
  metric values; Resource Health and Service Health text; Advisor problem and solution text.
- **KQL cell contents, after scrubbing**: log messages, URLs, user agents, exception text. Columns
  named like a secret are redacted and columns named like a user are pseudonymised.

### It cannot see

- Any token, refresh token, MSAL cache, device code or `Authorization` header. Tools have no access
  to them: the contexts feature only gets a `LoginController` that exposes flags and minutes.
- Tenant, subscription and object GUIDs, ARM IDs, Log Analytics workspace IDs.
- Public IPs, emails, UPNs and people's display names in identity objects.
- Secrets that match the patterns in §2 (layer 3).
- Tag values whose key is not allowlisted.
- Raw SDK error messages.

## 5. Login: device code, Docker and an in-memory token

1. The AI calls `login`. The server starts a Microsoft device-code flow for that context's tenant
   and answers with a fixed message: _"Open http://127.0.0.1:8765/login to sign in to context
   'prod'."_ The code is **not** in the result.
2. You open `/login` in a browser. The page shows the code, the Microsoft link and the time left
   (codes expire after 15 minutes), and refreshes itself every 5 seconds.
3. You sign in at Microsoft with the account for that context. The token goes from Entra ID to the
   container, not to the browser and not to the AI.
4. `login_status` then reports `loggedIn: true` and the minutes left on the access token.

Why this design:

- **Device code** needs no app registration, no client secret and no redirect URI. The server uses
  the default public client. The code is shown on a page that only the human opens.
  `disableAutomaticAuthentication` is set, so a tool call can never silently start a new sign-in:
  an expired session returns `NotLoggedIn` and the human has to run `login` again.
- **Docker** puts the token in another process, in another (Linux VM) user space, behind a
  read-only filesystem. On the host, Claude Code can run shell commands as you: if the server ran
  as your user, the AI could read its memory or its files. With Docker, the only way in is the
  MCP port, plus `docker exec`, which the deny rules block (§7).
- **In-memory token cache** (R8): there is no `tokenCachePersistenceOptions`, no volume and no
  file. A container restart means signing in again. That is the price of having nothing on disk to
  steal (a persisted, encrypted cache is discussed in
  [#14](https://github.com/jorisvilardell/safe-my-azure-from-claude/issues/14)).
- `logout` drops the credential object of a context.

## 6. Read-only by design, and RBAC

- No tool creates, updates, deletes, starts, stops or restarts anything. The code calls ARM GETs,
  Resource Graph, the Log Analytics and App Insights query APIs, the metrics API, Resource Health,
  Service Health and Advisor reads. There is no generic "run any ARM call" tool.
- Every tool is announced with `readOnlyHint: true` and `destructiveHint: false`.
- KQL is checked before it is sent (`core/safety/kql-guard.ts`): management commands (`.show`,
  `.set`, …), `set` and other non-query statements, cross-scope and external functions
  (`cluster()`, `database()`, `workspace()`, `app()`, `resource()`, `adx()`, `arg()`,
  `externaldata`, `external_table()`), `evaluate` plugins outside a small allowlist (no
  `http_request`, `sql_request`, `python`, `r`, …), and `fork`/`facet` are rejected. The query is
  capped at 10 000 characters, the timespan at 7 days (passed to the API, so it bounds the data
  whatever the query says) and the result at 500 rows, 1024 characters per cell and 64 KB.

Defence in depth: **give the sign-in account read roles only.** Even if a bug let a write through,
Azure would refuse it.

| Role                   | Needed for                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------- |
| `Reader`               | Inventory, Resource Graph, alert rules, activity log, Resource Health, Advisor.       |
| `Monitoring Reader`    | Fired alerts, metric definitions and values, Service Health events.                   |
| `Log Analytics Reader` | `list_tables` and `run_kql` on workspaces (and App Insights through their workspace). |

Assign them at subscription (or resource group) scope, for the subscriptions you declare in
`contexts.yaml`. Use a dedicated account, or a PIM-activated reader role, rather than an owner
account.

## 7. Claude Code deny rules

The MCP server only protects what goes **through** it. Claude Code also has a shell, file access
and web fetch on your machine, and your machine can still run `az`, `docker exec` and so on. So
`.claude/settings.json` denies the obvious ways around the server:

| Rule                                                                                        | Why                                                                                   |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `Bash(az login:*)`, `Bash(az account get-access-token:*)`                                   | Getting a token directly from the Azure CLI.                                          |
| `Bash(az account show:*)`, `Bash(az ad:*)`                                                  | Printing tenant and subscription IDs, users and groups.                               |
| `Bash(docker exec:*)`, `Bash(docker cp:*)`, `Bash(docker inspect:*)`, `Bash(docker logs:*)` | Reaching into the container that holds the token, or reading its config and logs.     |
| `Read(~/.azure/**)`                                                                         | The Azure CLI token cache on the host.                                                |
| `Read(./config/contexts.yaml)`, `Read(./.env)`                                              | Real tenant and subscription IDs.                                                     |
| `WebFetch(domain:127.0.0.1)`, `WebFetch(domain:localhost)`                                  | Reading the `/login` page (the device code) or calling `/mcp` outside the MCP client. |

Important limits:

- These rules are **project settings**: they apply only when Claude Code runs in this repository.
  If you use the server from other projects, copy the `permissions.deny` block into your user
  settings (`~/.claude/settings.json`).
- A deny list is not a sandbox. Other commands can reach the same things (`curl
http://127.0.0.1:8765/login`, `Get-Content`, `type`, another CLI that holds Azure tokens). Keep
  Claude Code in its default "ask before running" mode for shell commands while this server is in
  use, and consider adding deny rules for the HTTP clients of your shell (`curl`,
  `Invoke-WebRequest`) when they target port 8765. Other
  clients need their own equivalent rules ([CLIENTS.md](./CLIENTS.md)).
- If your host is signed in to the Azure CLI or Azure PowerShell, the AI's shell can use those
  sessions. Sign out of them, or keep them on a different account, when you work with the AI.

## 8. Residual risks

Stated plainly, so you can decide what to point this server at.

1. **Resource names and log content still reach the AI.** Names are allowed by design (they are
   what makes the AI useful), and names can be sensitive (`rg-acquisition-contoso`). KQL results
   and alert, health and Advisor text are copied from Azure after scrubbing: if your logs contain
   customer data, the AI sees it. Usernames that are not emails and are not in a user-named column
   (a bare `jdoe` in an `Account` column) pass through. Query only what you need.
2. **Stored KQL functions are opaque to the guard.** The guard inspects the query text the AI wrote.
   A workspace function saved in Log Analytics is called by name, and its body is not checked. The
   timespan and row caps still apply, and the query API is read-only, but a stored function could
   use a construct the guard would refuse inline.
3. **Free-text heuristics can miss bare secrets.** The scrubber finds secrets by format (JWT, PEM,
   SAS, `Bearer`), by `key=value` name, and by field name. A bare key or password in a log message
   (`the key is 3x4mpl3…`), a third-party token format it does not know, or an identifier that is
   not a GUID, email or IP will pass. Do not send secrets to your logs.
4. **Prompt injection through Azure data.** Anyone who can write a resource name, a tag, an alert
   description or a log line can write instructions for the AI. The tools are read-only and hold no
   token, so the damage is limited, but injected text could steer the investigation, trigger broad
   queries, or try to exfiltrate data through the client's other tools (web fetch, shell, other MCP
   servers). Mitigations ([#39](https://github.com/jorisvilardell/safe-my-azure-from-claude/issues/39)):
   every tool description (and the server instructions) starts with a notice that copied values are
   untrusted data, and every result carries `_meta: { "safe-my-azure/untrusted": true }`;
   zero-width, bidi, Unicode tag and control characters are stripped from every result before
   scrubbing; free text is length-capped; and text that looks like an instruction (`ignore previous
instructions`, `you are now`, `system:`, `<|…|>`, tool-call-shaped JSON, …) adds a top-level
   `warnings` entry naming the field. The detection is a cheap heuristic: paraphrases, other
   languages and homoglyphs (Cyrillic `о` for `o`) are not caught, and a warning never removes the
   text. Keep other exfiltration-capable tools on approval while you use this server.
5. **Over-masking.** A dotted version string outside a `*Version` field and not right after the
   word `version` (`agent 1.2.3.4 started`) looks like an IPv4 and becomes
   `public-ip-external-NNN`. Documentation ranges (`192.0.2.0/24`, `198.51.100.0/24`,
   `203.0.113.0/24`) are treated as public on purpose. Masked values cannot be used in KQL filters;
   in `get_metrics` filters, `id-`/`user-`/`app-`/`public-ip-external-` pseudonyms are resolved
   back server-side.
6. **Public IP index lag.** The `public-ip-<name>` lookup is built from Resource Graph in the
   background, refreshed every 5 minutes (30 seconds after a failure) and rebuilt on context switch.
   Until it is ready, or for an IP created since the last refresh, your own IP shows as
   `public-ip-external-NNN`, and the same IP may later show as `public-ip-<name>`. The fallback
   always hides the address.
7. **No authentication on `/mcp` and `/login`.** Any process on your machine that can reach
   `127.0.0.1:8765` can call the tools (the results are scrubbed) and read the `/login` page. The
   loopback binding and host-header check keep the network and malicious web pages out, not local
   processes.
8. **Same-user host in a future native mode.** A native Windows mode with broker login is
   **planned** ([#15](https://github.com/jorisvilardell/safe-my-azure-from-claude/issues/15)). In
   that mode the server would run as the same user as Claude Code, so the container boundary would
   be gone and the deny rules would become the main control. Docker stays the default.
9. **Shared state.** Login state, the active context and the pseudonym map are server-wide, shared
   by every client connected to the server. Pseudonyms reset on restart.

Audit trail ([#13](https://github.com/jorisvilardell/safe-my-azure-from-claude/issues/13)): every
tool call writes one scrubbed JSON line (tool, scrubbed arguments, duration, outcome or error code,
result size, row count, injection-warning count, never the result) to stderr by default.
`AUDIT_LOG=file` with an explicit `AUDIT_LOG_FILE` appends to a mounted file instead (no rotation);
`AUDIT_LOG=off` disables it. Remember that stderr may be readable by an agent: the lines are
scrubbed like every other log line.

Planned work that changes this picture: an in-memory
inventory index that would also feed the public IP lookup
([#33](https://github.com/jorisvilardell/safe-my-azure-from-claude/issues/33)), and Dev Proxy mocks
to test the real HTTP path end to end
([#37](https://github.com/jorisvilardell/safe-my-azure-from-claude/issues/37)).

## 9. Reporting a vulnerability

Please do not open a public issue for a leak. Use the repository's **Security** tab (private
vulnerability reporting) or contact the maintainer directly, and never paste real identifiers or
tokens in the report: reproduce with fake ones.
