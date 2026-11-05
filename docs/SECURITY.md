# Security and threat model

This document says what **safe-my-azure-from-claude** protects, how, and where its protection ends.
It describes the code as it is on `main`. Planned work is marked as planned, with a link to its issue.

- [1. What we protect, and from whom](#1-what-we-protect-and-from-whom)
- [2. The two guarantees and how they are enforced](#2-the-two-guarantees-and-how-they-are-enforced)
- [3. Trust boundaries](#3-trust-boundaries)
- [4. What the AI can and cannot see](#4-what-the-ai-can-and-cannot-see)
- [5. Login: device code, Docker and an in-memory token](#5-login-device-code-docker-and-an-in-memory-token)
  - [Server keys](#server-keys)
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

0. **Percent-escapes are decoded** (up to three levels), so nothing hides behind `%2F`, `%40` or
   `%3D`: `%2Fsubscriptions%2F<guid>` is an ARM ID, `jane%40contoso.com` an email. The AI gets
   the decoded text. An escape that would decode to a control or invisible character is kept.
1. **Secrets are removed whole**: PEM blocks (also unterminated private keys), JWTs (signed or
   not), well-known token formats on their own (GitHub, GitLab, npm, Slack, AWS key IDs, Google,
   Stripe, OpenAI/Anthropic, Entra ID client secrets `…8Q~…`, Azure DevOps PATs, and any padded
   base64 blob of 40+ characters such as storage, Cosmos DB, Service Bus and Function keys), SAS
   tokens and `SharedAccessSignature=`, `Bearer …` and `Basic …`, the password of a
   `scheme://user:password@host` URL, credential headers (`Authorization`, `Cookie`,
   `x-ms-token-*`, `x-ms-client-principal*`…), and any value whose **name ends** like a secret, in
   every common syntax: `name=value`, `name: value`, `name = value`, `"name": "…"`,
   `'name': '…'` (`DB_PASSWORD`, `AZURE_CLIENT_SECRET`, `GITHUB_TOKEN`, `ConnectionString`,
   `x-functions-key`, `Ocp-Apim-Subscription-Key`, `api-key`, `AccountKey`, …), plus `sig=`,
   `code=` and `subscription-key=` in query strings. Names are matched with explicit boundaries,
   never `\b`, so `_` and escapes cannot hide them.
2. **ARM IDs** become `rg/type/name` (no namespace; child and extension resources append their
   `type/name` pairs), or `sub:<alias>/…` when they are subscription-scoped. Every tool that
   returns a resource reference (inventory `ref`, alert targets, Advisor targets, Resource Health,
   ambiguity errors) uses this one format (`armRef()` in `core/anonymizer`).
3. **GUIDs** become `id-NNN` (or `app-NNN` under `appId`, `clientId`, …), wherever they are:
   glued to `_`, letters or digits (`vm_<guid>`, `<guid>_backup`), and also written as 32 hex
   digits without dashes. Known tenant and subscription IDs become their alias
   (`tenant-<context>`, `<subscription alias>`); a generated pseudonym never reuses an alias.
4. **Emails and UPNs** become `user-NNN`, including Entra ID guest UPNs
   (`jane_contoso.com#EXT#@tenant.onmicrosoft.com`) and non-ASCII local parts.
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
- known Azure version fields (`agentVersion`, `osVersion`, `typeHandlerVersion`,
  `kubernetesVersion`, … an exact list, not a `*Version` suffix) are not scanned for IPv4, so
  `1.10.2.0` stays a version. KQL results are scrubbed in **strict** mode, without that exception
  and without the `version 1.2.3.4` one: the AI names the columns and the keys of dynamic values,
  so `bag_pack('xversion', ClientIP)` must not unmask an IP.

Pseudonyms are stable for the life of the process: the same email is always `user-003`, so the
AI can correlate events without knowing who it is. The reverse map lives only in server memory.
There is **one** pseudonym map per server process, shared by every context and every MCP client
(not scoped per context): a pseudonym from one context still resolves after `use_context`, and
the AI can tell that a value seen in two contexts is the same one, never what it is. The map is
never persisted: pseudonyms (alert refs included) start over on restart, and an old one no
longer resolves.

Free text is capped **before** it is scrubbed (mappers run first), so `untrustedText()` cuts at
whitespace and drops the partial word: a cut never leaves a fragment of a GUID, email or token
that the scrubber would no longer recognise.

`sanitizeError()` (`core/errors`) keeps the message only for our own `AppError`s, which are written
to be safe. For anything else, such as an Azure SDK `RestError`, it keeps the HTTP status and a
purely alphabetic error code, and drops the message, which contains request URLs, subscription IDs
and correlation IDs.

### Layer 4: the scrubbing logger

Server logs are JSON lines on **stderr only** (`core/logging`). Every line goes through the same
anonymiser, with the same aliases and `safeTagKeys`, but without the public IP index (a log line
must never trigger an Azure call), so public IPs in logs are always `public-ip-external-NNN`. The
code never logs headers, credentials, device codes, the server keys or full SDK responses. Failed logins drop the
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
│  MCP client ─▶ safe-azure mcp ────────┼─ HTTP ────────▶│  read-only rootfs, cap_drop ALL,    │
│   (AI agent, untrusted with secrets)  │  /mcp + Bearer │  no-new-privileges, user "node"     │
│        ▲  tool results: scrubbed JSON │  <mcp key>     │                                     │
│        └──────────────────────────────┼────────────────│  tool ─▶ mapper ─▶ scrub() ─▶ result│
│                                       │                │                                     │
│  safe-azure login (you, in a TTY) ────┼─ HTTP ────────▶│  /admin: device code, human only    │
│        │                              │  /admin+Bearer │  keys: /run/safe-azure (tmpfs, 0600)│
│        │                              │  <admin key>   │  token cache: process memory only   │
│        ▼                              │                │           │                         │
│  microsoft.com/devicelogin (sign in)  │                └───────────┼─────────────────────────┘
└────────┼──────────────────────────────┘                            │ HTTPS, read-only calls
         │                                                           ▼
         └──────────────────────────────▶ Entra ID ◀──────▶ Azure (ARM, Resource Graph,
                                         (tokens go to        Monitor, Log Analytics,
                                          the container)      App Insights, Advisor)
```

| Boundary                    | What crosses it                                                                                                            | Control                                                                                                                                                                                                                                                               |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AI client ⇄ MCP server      | Tool calls (names, aliases, pseudonyms, KQL) and scrubbed results                                                          | Port published on `127.0.0.1` only. Host-header allowlist (`localhost`, `127.0.0.1`, `[::1]`) against DNS rebinding. `Authorization: Bearer <mcp key>`, constant-time compare, 401 otherwise. Stateless Streamable HTTP. zod-validated inputs. Every result scrubbed. |
| CLI ⇄ `/admin/*`            | Sign-in start (device code and verification URL, to the human), status, logout, context switch                             | Same loopback port and host check. A separate `Bearer <admin key>`, constant-time compare. `Cache-Control: no-store`. zod-validated bodies. Never reachable through a tool; the user code is never logged.                                                            |
| Container ⇄ Entra ID, Azure | Device-code flow, tokens, read-only API calls                                                                              | `DeviceCodeCredential` with no persistent cache. Only GET-style APIs, Resource Graph and query APIs are called.                                                                                                                                                       |
| Host ⇄ container            | `config/contexts.yaml` mounted read-only (aliases and GUIDs, no secrets); the keys file read by the CLI with `docker exec` | Read-only root filesystem, `tmpfs` `/tmp` and `/run/safe-azure`, all capabilities dropped, `no-new-privileges`, non-root user. No volume for tokens or keys.                                                                                                          |

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

- Any token, refresh token, MSAL cache, device code, server key or `Authorization` header. Tools
  have no access to them: the contexts feature only gets a `LoginController` that exposes flags,
  minutes and logout. It cannot even start a sign-in.
- Tenant, subscription and object GUIDs, ARM IDs, Log Analytics workspace IDs.
- Public IPs, emails, UPNs and people's display names in identity objects.
- Secrets that match the patterns in §2 (layer 3).
- Tag values whose key is not allowlisted.
- Raw SDK error messages.

## 5. Login: device code, Docker and an in-memory token

1. If the AI calls `login`, it only gets a fixed hint: _"Ask the user to run
   `safe-azure login prod` in their own terminal. The sign-in code is never shown here."_ The
   tool starts **nothing**: an agent can never open a sign-in you did not ask for.
2. You run `safe-azure login prod` in your own terminal. The CLI refuses to run without a TTY
   (agent shells are not TTYs), calls `POST /admin/login` with the admin key, and prints the code
   and the Microsoft link (codes expire after 15 minutes). `POST /admin/login` is the only place
   the code is ever returned.
3. You sign in at Microsoft with the account for that context. The token goes from Entra ID to the
   container, not to the browser, not to the CLI and not to the AI. The CLI polls
   `GET /admin/login/prod` until the state is `succeeded`, `failed` or `expired`.
4. `login_status` then reports `loggedIn: true` and the minutes left on the access token.

Why this design:

- **Device code** needs no app registration, no client secret and no redirect URI. The server uses
  the default public client. The code is shown only by the CLI, in the human's terminal.
  `disableAutomaticAuthentication` is set, so a tool call can never silently start a new sign-in:
  an expired session returns `NotLoggedIn` and the human has to run `safe-azure login` again.
- **Docker** puts the token in another process, in another (Linux VM) user space, behind a
  read-only filesystem. On the host, Claude Code can run shell commands as you: if the server ran
  as your user, the AI could read its memory or its files. With Docker, the only way in is the
  MCP port, plus `docker exec`, which the deny rules block (§7).
- **In-memory token cache** (R8): there is no `tokenCachePersistenceOptions`, no volume and no
  file. A container restart means signing in again. That is the price of having nothing on disk to
  steal (a persisted, encrypted cache is discussed in
  [#14](https://github.com/jorisvilardell/safe-my-azure-from-claude/issues/14)).
- `logout` drops the credential object of a context.
- **Native Windows mode** (`AUTH_MODE=broker`, optional, [WINDOWS.md](./WINDOWS.md)) swaps the
  device code for a WAM sign-in window and Docker for a plain Node process. That process runs as
  the same user as Claude Code, so the Docker argument above no longer holds: the keys file,
  `contexts.yaml` and the process memory are reachable from the AI's shell, and the deny rules and
  the guard (§7) become **mandatory**, not defence in depth. The default stays `device-code`.

### Server keys

- At every start the server generates two random 256-bit keys (`crypto.randomBytes`, base64url):
  `mcp` for `/mcp` and `admin` for `/admin/*` ([ADR 0001](./adr/0001-cli-auth-install.md)).
- They are written **only** to `/run/safe-azure/keys.json` (`KEYS_FILE`), mode 0600 in a 0700
  directory, on a container tmpfs owned by the `node` user. They are never logged, never in env,
  never on a volume, and the keys module takes no logger. A restart makes new keys.
- Both are checked with `crypto.timingSafeEqual` over SHA-256 digests, so the comparison always
  covers two 32-byte buffers. A missing or wrong key gets 401 with `WWW-Authenticate: Bearer`
  (a JSON-RPC error body on `/mcp`). The MCP key does not open `/admin`, and the reverse.
- The CLI reads them with `docker exec <container> cat /run/safe-azure/keys.json`. The deny rules
  (§7), and the CLI's Claude Code hook, block `docker exec` for agents.
- `/healthz` stays unauthenticated and returns only `{status, version}`.

## 6. Read-only by design, and RBAC

- No tool creates, updates, deletes, starts, stops or restarts anything. The code calls ARM GETs,
  Resource Graph, the Log Analytics and App Insights query APIs, the metrics API, Resource Health,
  Service Health and Advisor reads. There is no generic "run any ARM call" tool.
- Every tool is announced with `readOnlyHint: true` and `destructiveHint: false`.
- **Read-only is enforced, not only intended** (AGENTS.md R2):
  - _At runtime._ Azure SDK clients are only built by the client factory (`core/azure/client-factory.ts`),
    which adds a read-only pipeline policy (`core/azure/read-only-policy.ts`) at both ends of each
    client's pipeline and refuses to hand out a client where it is missing. It lets through `GET` and
    `HEAD` to `management.azure.com` and `api.loganalytics.io`, plus three read-only POSTs: the Resource
    Graph query, the Log Analytics workspace query and the App Insights resource-centric query. Any
    other method, path, host, userinfo or traversal (`..`, `%2e`, `%2f`) fails with `WriteBlocked`
    before the request leaves the container. The second instance, after the signing phase, also sees
    retries and redirect hops. Token requests go through MSAL's own HTTP client and are not affected.
  - _In CI, statically._ `test/read-only/` walks `src/` with the TypeScript compiler and fails on a
    write-like or unknown method called on an Azure SDK object, on an SDK client constructed outside
    the factory, and on raw `fetch` / `http(s).request` / `undici`. It has a self-test on bad fixtures.
  - _In CI, end to end._ The e2e-mock job checks that every request Dev Proxy intercepted for
    `management.azure.com` or `api.loganalytics.io` is a `GET` or an allowlisted POST.
- KQL is checked before it is sent (`core/safety/kql-guard.ts`): management commands (`.show`,
  `.set`, …), `set` and other non-query statements, cross-scope and external functions
  (`cluster()`, `database()`, `workspace()`, `app()`, `resource()`, `adx()`, `arg()`,
  `externaldata`, `external_table()`), `evaluate` plugins outside a small allowlist (no
  `http_request`, `sql_request`, `python`, `r`, …), `fork`/`facet` are rejected. The query is
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

| Rule                                                                                        | Why                                                                                            |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `Bash(az login:*)`, `Bash(az account get-access-token:*)`                                   | Getting a token directly from the Azure CLI.                                                   |
| `Bash(az account show:*)`, `Bash(az ad:*)`                                                  | Printing tenant and subscription IDs, users and groups.                                        |
| `Bash(docker exec:*)`, `Bash(docker cp:*)`, `Bash(docker inspect:*)`, `Bash(docker logs:*)` | Reaching into the container that holds the token and the keys, or reading its config and logs. |
| `Read(~/.azure/**)`                                                                         | The Azure CLI token cache on the host.                                                         |
| `Read(./config/contexts.yaml)`, `Read(./.env)`                                              | Real tenant and subscription IDs.                                                              |
| `WebFetch(domain:127.0.0.1)`, `WebFetch(domain:localhost)`                                  | Calling `/mcp` or `/admin` outside the MCP client.                                             |

Important limits:

- These rules are **project settings**: they apply only when Claude Code runs in this repository.
  If you use the server from other projects, copy the `permissions.deny` block into your user
  settings (`~/.claude/settings.json`).
- A deny list is not a sandbox. Other commands can reach the same things (`Get-Content`, `type`,
  another CLI that holds Azure tokens; `curl` to `/mcp` now needs the key). Keep
  Claude Code in its default "ask before running" mode for shell commands while this server is in
  use, and consider adding deny rules for the HTTP clients of your shell (`curl`,
  `Invoke-WebRequest`) when they target port 8765. Other
  clients need their own equivalent rules ([CLIENTS.md](./CLIENTS.md)).
- If your host is signed in to the Azure CLI or Azure PowerShell, the AI's shell can use those
  sessions. Sign out of them, or keep them on a different account, when you work with the AI.

### Claude Code guard

Deny rules are guidance. The real enforcement is a `PreToolUse` hook that `safe-azure install`
merges into the **user** settings (`~/.claude/settings.json`), so it applies in every project
([ADR 0001 §5](./adr/0001-cli-auth-install.md)). The entry is:

```json
{
  "matcher": "*",
  "hooks": [{ "type": "command", "command": "<path to safe-azure> hook claude", "timeout": 10 }]
}
```

The install keeps every other key and hook and backs the file up to
`settings.json.safe-azure.bak`. It refuses a file that is not valid JSON. Running it again is a
no-op, or updates the path when the binary moved. `safe-azure uninstall` removes only this entry.

`safe-azure hook claude` reads the event on stdin. It blocks a call with exit code 2 and a reason
on stderr that tells the agent what to do instead. It prints nothing on stdout. It blocks:

| Tool                                                               | Blocked                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PowerShell`                                                       | **Every call.** PowerShell reaches .NET, the registry, DPAPI and every Azure module directly: no word list can guard it, so the tool is refused as a whole, and so is starting `powershell`/`pwsh` from any other shell                                                                                                                                                                                         |
| `Bash`, any tool with a `command`                                  | `safe-azure login\|keys\|install\|uninstall\|update\|down`; **every** `az` command (it can mint tokens and prints raw IDs); `azd auth`; Azure PowerShell cmdlets (`Get-AzAccessToken`, `Connect-AzAccount`, …); `docker`/`podman` `exec\|cp\|inspect\|logs\|attach\|export\|commit\|diff\|top\|debug` on **any** container, and any other `docker` command naming `azure-safe-mcp` except `ps`/`stats`/`images` |
|                                                                    | Any command with port `8765` and a loopback host (`localhost`, `127.*`, `::1`, `0.0.0.0`, `2130706433`, `/dev/tcp/…`) or an HTTP client or interpreter (`curl`, `wget`, `iwr`, `irm`, `Invoke-WebRequest`, `Invoke-RestMethod`, `nc`, `node`, `python`, `fetch`, `WebClient`, …)                                                                                                                                |
|                                                                    | Any mention of `.azure`, `.IdentityService`, MSAL cache files, `keys.bin`, the safe-azure config dir (`%APPDATA%\safe-azure`, `~/.config/safe-azure`), `contexts.yaml`, `.claude/settings*`, `disableAllHooks`; base64-decode-then-run pipelines                                                                                                                                                                |
| `Read`, `Write`, `Edit`, `MultiEdit`, `NotebookEdit`, `LS`         | Paths under `.azure`, the config dir, `keys.bin`, `contexts.yaml`. Write tools also: `.claude/settings*.json` and `~/.claude/skills/safe-azure/`                                                                                                                                                                                                                                                                |
| `Glob`, `Grep`                                                     | The same paths in `path`, `pattern` (Glob) or `glob`. A `Grep` whose scope contains `~/.azure` or the config dir (the home directory, `C:/Users`, `/`)                                                                                                                                                                                                                                                          |
| `WebFetch`                                                         | Loopback URLs on port 8765                                                                                                                                                                                                                                                                                                                                                                                      |
| Any of the above, against the guard itself                         | Deleting, moving or overwriting the `safe-azure` binary (or its updater), `cargo install --path/--git/safe-azure`, `cargo uninstall safe-azure`: without its binary the hook cannot start, and Claude Code then lets every call through                                                                                                                                                                         |
| Paths written to dodge the checks                                  | A wildcard that can match a protected name (`~/.az*/msal_t*`, `safe-a*`, `config/*.yaml`, `~/.config/*`), a Windows 8.3 short name that can stand for one (`AZURE~1`, `CONTEX~1.YAM`, `SAFE-A~1`), drive-relative paths (`\Users\me\…`, resolved against the home drive)                                                                                                                                        |
| `docker`/`podman`/`nerdctl` options                                | Sharing another container's namespaces (`--pid/--network/--ipc=container:…`, `--volumes-from`), the host's (`--pid=host`, …), `--privileged`, `--cap-add SYS_PTRACE/SYS_ADMIN/ALL`, mounting the Docker socket or the host root (`-v /:/…`), `kill -s/--signal`, `checkpoint`; Unicode dashes count as `-`                                                                                                      |
| Malformed event, or a known tool without its expected string field | Everything (fail closed). Unknown tools without a `command` pass.                                                                                                                                                                                                                                                                                                                                               |

`docker exec` and friends are blocked for every container, not only `azure-safe-mcp`: the target
can be a container ID, a name prefix, a compose service name or `$(docker ps -q)`, so matching on
the name would be easy to evade. Matching is coarse on purpose: it lowercases the command, drops
quotes, `^` and escapes, splits on `;`, `&&`, `||`, `|`, newlines, `$(…)` and backticks, and looks
for the words anywhere in a segment. So `bash -c '…'`, `cmd /c …`, full paths
(`C:\…\az.cmd`) and `"a"z`-style quoting are caught. The price is false positives: a commit
message that says `az login` or a `grep` for `127.0.0.1:8765` is blocked too, and the agent has to
rephrase.

Known limits. The hook raises the bar; it is not a sandbox:

- **Indirection it cannot see:** a command name or port built at run time (`X=az; $X login`,
  `& ('a'+'z')`, `$((8000+765))`, an alias or function defined earlier, a script file the agent
  wrote and then runs, `Invoke-Expression` on a computed string, other encodings than base64).
- **Other programs:** any binary the agent writes or downloads, other CLIs that hold Azure tokens
  (Terraform, VS Code, the Azure SDKs reading `~/.azure` from inside a script it wrote), symlinks
  to protected paths, and a Bash `grep -r` over the home directory. As defence in depth, the
  server runs with `node --disable-sigusr1`, so a process that can signal it cannot open the
  Node inspector and read the in-memory tokens.
- **Same-user access:** the agent runs as you. Anything you can read, a process it starts can read
  with enough effort. DPAPI protects `keys.bin` from plain reads, and `safe-azure login` refuses to
  run without a TTY, as defence in depth.
- **Other clients:** the hook only guards Claude Code. Other MCP clients need their own controls
  ([CLIENTS.md](./CLIENTS.md)).
- **Timeouts and old versions:** if the hook times out (10 s) or cannot start, Claude Code lets the
  call through. Run `safe-azure doctor` after moving the binary.

The companion skill (`~/.claude/skills/safe-azure/SKILL.md`, installed by `safe-azure install`)
tells the agent the same rules up front and gives it the investigation playbook, so the hook
rarely has to fire.

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
   In `run_kql`, the AI writes the query, and the query API can only read: the server trusts it
   to write sensible KQL (log searches, probes, advanced metrics) and does not police its
   functions. A query that rewrites a value (`replace_string()`, `base64_encode_tostring()`,
   `parse_ipv4()`, `substring()`) can turn an identifier into a shape the scrubber no longer
   recognises. Results are scrubbed in strict mode and the audit log records every query.
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
   in `get_metrics` filters, `id-`/`user-`/`app-`/`public-ip-external-` pseudonyms and
   `public-ip-<name>` placeholders are resolved back server-side (`public-ip-<name>` through the
   active context's inventory snapshot, else through the pseudonym map).
6. **Public IP index lag.** The `public-ip-<name>` lookup reads the active context's inventory
   snapshot ([#33](https://github.com/jorisvilardell/safe-my-azure-from-claude/issues/33)), built
   right after login and refreshed in the background before it expires. Until the first build
   lands, over `INVENTORY_MAX_RESOURCES`, in another context, or for an IP created since the last
   refresh, your own IP shows as `public-ip-external-NNN`, so the same IP can carry both
   placeholders over a session. Both resolve to the same IP in `get_metrics` filters. The fallback
   always hides the address.
7. **Local processes that can read the keys.** `/mcp` and `/admin` need their Bearer keys
   (fixed: the old "no authentication on `/mcp` and `/login`" risk), and the `/login` page is
   gone. But a process running as you that can run `docker exec` (or read the CLI's key cache) can
   get the keys: the admin key starts a sign-in and returns its code. The deny rules, the CLI hook,
   its TTY check and its encrypted key cache raise the bar; they are not a sandbox
   ([ADR 0001](./adr/0001-cli-auth-install.md)).
8. **Same-user host in a future native mode.** A native Windows mode with broker login is
   **planned** ([#15](https://github.com/jorisvilardell/safe-my-azure-from-claude/issues/15)). In
   that mode the server would run as the same user as Claude Code, so the container boundary would
   be gone and the deny rules would become the main control. Docker stays the default.
9. **Shared state.** Login state, the active context and the pseudonym map are server-wide, shared
   by every client and every context (see Layer 3). Pseudonyms reset on restart.

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
