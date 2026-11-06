# Usage guide

How to install the server, connect Claude Code to it, sign in, and use it to investigate Azure.
The [README](../README.md) has the short version. For what the AI can and cannot see, read
[SECURITY.md](./SECURITY.md). For MCP clients other than Claude Code, read
[CLIENTS.md](./CLIENTS.md). To run the server natively on Windows with WAM sign-in instead of
Docker and device code (optional, weaker isolation), read [WINDOWS.md](./WINDOWS.md).

- [1. Getting started](#1-getting-started)
- [2. Describe your tenants (`contexts.yaml`)](#2-describe-your-tenants-contextsyaml)
- [3. Sign in](#3-sign-in)
- [4. Switch contexts](#4-switch-contexts)
- [5. Update, stop and uninstall](#5-update-stop-and-uninstall)
- [6. The server](#6-the-server)
- [7. Tool reference](#7-tool-reference)
- [8. Walkthroughs](#8-walkthroughs)
- [9. Troubleshooting](#9-troubleshooting)
- [10. Try it without Azure](#10-try-it-without-azure)

## 1. Getting started

Run every `safe-azure` command in this guide in **your own terminal**, not in a shell that an AI
agent drives. Once installed, the Claude Code guard refuses `safe-azure install`, `login`,
`update`, `uninstall` and `down` when an agent runs them.

### Requirements

- **Docker**: Docker Desktop on Windows (WSL 2 backend) or macOS, or Docker Engine on Linux. It
  must be running.
- **Claude Code**, or another MCP client ([CLIENTS.md](./CLIENTS.md)). Without `claude` on your
  `PATH`, `safe-azure install` prints the command to register the server yourself.
- An Entra ID account with read roles on the subscriptions you want to look at: `Reader`,
  `Monitoring Reader` and `Log Analytics Reader` ([SECURITY.md §6](./SECURITY.md#6-read-only-by-design-and-rbac)).
- The tenant ID and the subscription IDs you want to use. You type them once; the AI never sees
  them.

You do **not** need the Azure CLI, an app registration or a client secret. Node.js is only needed
if you install the CLI from npm.

### Step 1: install the `safe-azure` CLI

Pick one.

**Windows** (x64, arm64), in PowerShell:

```powershell
powershell -ExecutionPolicy ByPass -c "irm https://github.com/jorisvilardell/safe-my-azure-from-claude/releases/latest/download/safe-azure-installer.ps1 | iex"
```

**macOS and Linux** (x64, arm64; the Linux binary is static and runs on any distribution, WSL
included):

```bash
curl --proto '=https' --tlsv1.2 -LsSf https://github.com/jorisvilardell/safe-my-azure-from-claude/releases/latest/download/safe-azure-installer.sh | sh
```

**npm** (any platform with Node.js):

```bash
npm install -g safe-azure
```

`npx safe-azure --help` works too, to look before installing. For the real setup, prefer a
permanent install: Claude Code launches the exact binary path that `safe-azure install` registers,
and an `npx` cache can be cleared.

The PowerShell and shell installers put `safe-azure` and its updater `safe-azure-update` in
`~/.cargo/bin` (`%USERPROFILE%\.cargo\bin` on Windows) and add that folder to your `PATH`. Open a
new terminal, then check:

```bash
safe-azure --version
```

### Step 2: run `safe-azure install`

```bash
safe-azure install
```

It runs these steps and prints each one:

1. **Checking Docker**: the Docker engine must answer.
2. **Azure contexts**: writes `contexts.yaml` with an interactive wizard (§2), or keeps a valid
   one that is already there.
3. **Pulling** `ghcr.io/jorisvilardell/safe-my-azure-from-claude:<CLI version>`. The CLI version
   is always the image tag.
4. **Starting the server**: a container named `azure-safe-mcp`, published on `127.0.0.1:8765`
   only, with a read-only root filesystem, tmpfs for `/tmp` and the keys, no Linux capabilities,
   `no-new-privileges`, `--restart unless-stopped`, and `contexts.yaml` mounted read-only.
5. **Waiting for the server**, then fetching its keys and caching them for your user (encrypted
   with DPAPI on Windows, a 0600 file elsewhere).
6. **Registering the MCP server in Claude Code**: `claude mcp add --scope user safe-azure -- <path to safe-azure> mcp`.
7. **Installing the Claude Code skill** in `~/.claude/skills/safe-azure/`. It tells the agent the
   rules and an investigation playbook.
8. **Installing the Claude Code hook** in `~/.claude/settings.json` (backed up first). It applies
   to **every** Claude Code project of your user ([SECURITY.md §7](./SECURITY.md#claude-code-guard)).
9. **Checking everything** with `safe-azure doctor`.

Options:

| Option              | Effect                                                                |
| ------------------- | --------------------------------------------------------------------- |
| `--contexts <file>` | Validate and copy this `contexts.yaml` instead of running the wizard. |
| `--no-skill`        | Do not install the Claude Code skill.                                 |
| `--no-hook`         | Do not install the guard hook. Not recommended.                       |
| `-y`, `--yes`       | Answer yes to every prompt.                                           |

`safe-azure install` is idempotent: run it again at any time. `safe-azure update` re-applies the
same options.

The hook blocks a few things you may notice in Claude Code: the `PowerShell` tool as a whole,
every `az` command, `docker exec`/`logs`/`inspect` on any container, and anything that touches
`~/.azure`, `contexts.yaml` or the CLI's config folder. That is on purpose. The full list and its
limits are in [SECURITY.md §7](./SECURITY.md#claude-code-guard).

### Step 3: sign in

```bash
safe-azure login prod
```

Details in §3. Then check with `safe-azure status`.

### Step 4: ask Claude

Start Claude Code in any folder (`claude mcp list` should show `safe-azure` as connected) and ask:

- _"Call server_info."_
- _"Which Azure contexts do I have, and am I logged in?"_
- _"What fired in prod in the last hour?"_

The walkthroughs in §8 show a full investigation.

### Files the CLI writes

| Path                                                                                                                                | What                                                                                |
| ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Config folder: `%APPDATA%\safe-azure` (Windows), `~/.config/safe-azure` (Linux), `~/Library/Application Support/safe-azure` (macOS) | `contexts.yaml`, `keys.bin` (encrypted key cache), `install.json` (install options) |
| `~/.claude/settings.json`                                                                                                           | The guard hook entry. Backup: `settings.json.safe-azure.bak`.                       |
| `~/.claude/skills/safe-azure/SKILL.md`                                                                                              | The skill.                                                                          |
| Claude Code user MCP config                                                                                                         | The `safe-azure` server entry (no key in it).                                       |

## 2. Describe your tenants (`contexts.yaml`)

A **context** is one tenant, with the subscriptions you want to use in it. You give each one an
**alias**. The AI only ever sees the aliases.

The wizard in `safe-azure install` asks for each context alias and tenant ID, each subscription
alias and ID (empty alias when done), the default context when there is more than one, and the
tag keys whose values the AI may see. It validates every answer and shows a summary before it
writes the file. The result looks like this:

```yaml
contexts:
  prod: # context alias
    tenantId: 00000000-0000-0000-0000-0000000000aa
    subscriptions:
      prod-app: 00000000-0000-0000-0000-000000000001 # subscription alias: id
      prod-network: 00000000-0000-0000-0000-000000000002
  lab:
    tenantId: 00000000-0000-0000-0000-0000000000bb
    subscriptions:
      lab: 00000000-0000-0000-0000-000000000003

# Optional: the context active at startup. Must be one of the aliases above.
defaultContext: prod

# Tag keys whose values may be shown to the AI. All other tag values are masked.
safeTagKeys:
  - env
  - app
```

| Key                         | Meaning                                                                                                                                                                 |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `contexts.<alias>`          | Context alias: lowercase kebab-case, starting with a letter or digit, at most 40 characters.                                                                            |
| `tenantId`                  | The tenant to sign in to (a GUID).                                                                                                                                      |
| `subscriptions.<alias>: id` | The subscriptions tools may query. Nothing outside this list is ever queried. The AI sees the alias.                                                                    |
| `defaultContext`            | Active context at startup. If omitted and there is exactly one context, that one is active. Otherwise the AI must call `use_context` first.                             |
| `safeTagKeys`               | Tag keys whose **values** are shown (case-insensitive). Every other tag value is `[masked]`. Only add keys whose values are harmless, like `env` or `app`, not `owner`. |

The file holds IDs but no secrets. It stays on your machine and is mounted read-only in the
container. Never commit it, and never paste it into a chat.

**Use an existing file**: `safe-azure install --contexts ./contexts.yaml`. The CLI validates it
(error messages name the field, never the value), copies it into the config folder and recreates
the container if the content changed.

**Change your contexts later**: write the new version to a file outside the config folder and run
`safe-azure install --contexts <that file>`. The container is recreated so the server reads it,
which signs out every context.

## 3. Sign in

Each context is signed in separately, with Microsoft device-code login, from **your own terminal**.
The code is shown only there, never to the AI. The AI cannot start a sign-in.

```bash
safe-azure login prod          # or just `safe-azure login` for the active context
```

1. The CLI refuses to run unless stdin and stdout are a terminal (agent shells are not). It prints
   a code and the link `https://microsoft.com/devicelogin`, and opens it in your browser
   (`--no-browser` to skip that).
2. Enter the code and sign in with the account for that tenant.
3. The CLI waits until the sign-in succeeds, fails or the code expires, and says so.

Under the hood the CLI calls `POST /admin/login` and polls `GET /admin/login/prod` with the admin
key. The admin API is the only place the code is ever returned.

If the AI needs a sign-in, it can only ask you:

> **You:** Log me in to prod.
>
> **Claude:** _(calls `login`)_ Ask the user to run `safe-azure login prod` in their own terminal.
> The sign-in code is never shown here.

Check the state from your terminal with `safe-azure status`, or from the chat:

> **You:** Am I in?
>
> **Claude:** _(calls `login_status`)_ prod is logged in, token valid for 74 more minutes. lab is not
> logged in.

Notes:

- A code expires after 15 minutes. If the CLI reports it expired or failed, run
  `safe-azure login <alias>` again.
- The access token is refreshed in memory while the session lasts. When it can no longer be
  refreshed, tools answer `NotLoggedIn`: run `safe-azure login <alias>` again.
- `safe-azure logout <alias>` (or the `logout` tool) drops a context's credential. Restarting the
  container (`safe-azure down`/`up`, `update`, a reboot) drops all of them: the token lives in
  memory only. A persisted, encrypted cache is proposed in
  [ADR 0002](./adr/0002-persisted-token-cache.md).

## 4. Switch contexts

Every tool works on the **active** context. Inside a context, most tools search every declared
subscription unless you pass a `subscription` alias. Switch from your terminal with
`safe-azure use <alias>`, or from the chat:

> **You:** Which tenants do you have?
>
> **Claude:** _(calls `list_contexts`)_ Two contexts: **prod** (subscriptions prod-app,
> prod-network, active, logged in) and **lab** (subscription lab, not logged in).
>
> **You:** Switch to lab.
>
> **Claude:** _(calls `use_context` with `alias: "lab"`)_ Context 'lab' is now active but not logged
> in. Ask the user to run `safe-azure login lab` in their own terminal.

The active context is server-wide: every client connected to the server shares it.

## 5. Update, stop and uninstall

| Command                        | What it does                                                                                                                         |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `safe-azure doctor`            | Checks Docker, container health, CLI and server versions, keys, MCP registration, skill, hook, and whether a release is out.         |
| `safe-azure update --check`    | Only reports whether a newer release exists, and whether the server version differs from the CLI.                                    |
| `safe-azure update`            | Updates the CLI, then pulls the matching image, recreates the container, re-applies registration, skill and hook, and runs `doctor`. |
| `safe-azure down`              | Stops the container. Every login is lost.                                                                                            |
| `safe-azure up`                | Starts it again (or creates it if it is missing). Then sign in again.                                                                |
| `safe-azure uninstall`         | Removes the container, MCP registration, hook, skill and key cache. Keeps `contexts.yaml`.                                           |
| `safe-azure uninstall --purge` | The same, and deletes the whole config folder, `contexts.yaml` included.                                                             |

The CLI prints an "update available" notice at most once a day. Set `SAFE_AZURE_NO_UPDATE_CHECK=1`
to turn it off. If GitHub rate-limits the update check, set `SAFE_AZURE_GITHUB_TOKEN`.

`safe-azure update` replaces the binary only for the PowerShell and shell installers (they write
an install receipt). With npm, update the CLI with `npm install -g safe-azure@latest`, then run
`safe-azure update`: it says it is not self-updating and updates the rest.

`uninstall` leaves the image and the binary. To remove them too:

```bash
docker images ghcr.io/jorisvilardell/safe-my-azure-from-claude      # shows the version tag
docker image rm ghcr.io/jorisvilardell/safe-my-azure-from-claude:<version>
```

Then delete `safe-azure` and `safe-azure-update` from `~/.cargo/bin`, or run
`npm uninstall -g safe-azure`.

## 6. The server

You normally never touch the server directly: the CLI starts it and talks to it. This section is
for running it from source, and for understanding what is listening.

It listens on `127.0.0.1:8765` only:

| Path       | For                                                                                                |
| ---------- | -------------------------------------------------------------------------------------------------- |
| `/mcp`     | MCP over Streamable HTTP (POST, stateless). Needs `Authorization: Bearer <mcp key>`.               |
| `/admin/*` | The `safe-azure` CLI's API (sign-in, logout, switch context). Needs the admin key. Not for the AI. |
| `/healthz` | Liveness check (`{"status":"ok","version":"…"}`), no key, used by Docker.                          |

At every start the server generates two random 256-bit keys, `mcp` and `admin`, and writes them
only to `/run/safe-azure/keys.json` inside the container (mode 0600, on a tmpfs). They change on
every restart and are never logged. The `safe-azure` CLI reads them for you
([ADR 0001](./adr/0001-cli-auth-install.md)) and re-reads them after a restart.

### Run it from source

From a clone of this repository, with the `safe-azure` CLI installed:

```bash
cp config/contexts.example.yaml config/contexts.yaml   # edit it; gitignored
docker compose up -d --build
claude mcp add --scope user safe-azure -- safe-azure mcp
safe-azure login prod
```

This builds the image and starts the same `azure-safe-mcp` container. Don't also run
`safe-azure install`: it would replace this container with the released image. `docker compose ps`
should show it as `healthy` after about 30 seconds. After you edit `config/contexts.yaml`, run
`docker compose restart` (it signs everyone out). Without `safe-azure install` there is no guard
hook: copy the `permissions.deny` block from [`.claude/settings.json`](../.claude/settings.json)
into `~/.claude/settings.json` at least ([SECURITY.md §7](./SECURITY.md#7-claude-code-deny-rules)).

### Settings

These environment variables apply when you run the server with `docker compose` (put them in a
`.env` file next to `docker-compose.yml`, see `.env.example`). The container that
`safe-azure install` creates uses the defaults.

| Variable                  | Default       | Meaning                                                                                                     |
| ------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------- |
| `LOG_LEVEL`               | `info`        | `debug`, `info`, `warn` or `error`. Logs go to stderr and are scrubbed.                                     |
| `AUDIT_LOG`               | `stderr`      | Audit line per tool call: `stderr`, `file` or `off`.                                                        |
| `AUDIT_LOG_FILE`          | none          | Required with `AUDIT_LOG=file`, for example `/app/audit/audit.jsonl` with the `./audit` volume uncommented. |
| `INVENTORY_MAX_RESOURCES` | `50000`       | Cap of the in-memory inventory index. `0` turns it off.                                                     |
| `INVENTORY_RESOURCE`      | `off`         | `on` exposes the MCP resource `azure://inventory/<context>` (scrubbed).                                     |
| `AUTH_MODE`               | `device-code` | `broker` is the native Windows mode only ([WINDOWS.md](./WINDOWS.md)).                                      |

Each audit line is one scrubbed JSON object (`"msg":"tool call"`) with the tool name, scrubbed
arguments, duration, outcome, result size and row count, never the result itself. The file is
append-only and never rotated.

You read the logs yourself, with `docker logs azure-safe-mcp` (or `docker compose logs`). The AI
is denied `docker logs` ([SECURITY.md §7](./SECURITY.md#7-claude-code-deny-rules)).

## 7. Tool reference

22 tools, all read-only. Inputs marked `?` are optional. Resource inputs are **names** and
**aliases**, never IDs.

### system

| Tool          | Inputs | Description                                                                                 |
| ------------- | ------ | ------------------------------------------------------------------------------------------- |
| `server_info` | none   | Version, guarantees and enabled features. Call it first to discover what the server can do. |

### contexts

| Tool            | Inputs   | Description                                                                                            |
| --------------- | -------- | ------------------------------------------------------------------------------------------------------ |
| `list_contexts` | none     | Declared contexts with their subscription aliases, which one is active and which ones are logged in.   |
| `use_context`   | `alias`  | Switches the active context. Every other tool then works on it.                                        |
| `login`         | `alias?` | A hint only: tells you to run `safe-azure login <alias>` yourself. Starts nothing, never shows a code. |
| `login_status`  | `alias?` | Per context: logged in, sign-in pending or failed, and minutes left on the access token.               |
| `logout`        | `alias`  | Drops the context's in-memory credential.                                                              |

### inventory

| Tool                   | Inputs                                                                                              | Description                                                                                                                                                   |
| ---------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_subscriptions`   | none                                                                                                | Subscriptions of the active context by alias, with their state (Enabled, Disabled, Warned, PastDue…, or NotVisible).                                          |
| `list_resource_groups` | `subscription?`                                                                                     | Resource groups: name, subscription alias, location, provisioning state, tags (masked values).                                                                |
| `search_resources`     | `name?` (contains), `type?`, `resourceGroup?`, `location?`, `subscription?`, `limit?` (50, max 200) | Finds resources. Returns ref (`rg/type/name`), name, type, location, SKU, kind and tags. `truncated: true` means narrow the filters.                          |
| `get_resource`         | `resourceGroup`, `name`, `type?`, `subscription?`                                                   | One resource: the search fields plus provisioning state and a few key properties for common types (VM size and power state, App Service state, AKS version…). |

### alerts

| Tool                | Inputs                                                                                              | Description                                                                                                               |
| ------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `list_fired_alerts` | `timeRange` (`1h`, `1d`, `7d`, `30d`), `severity?`, `state?`, `monitorCondition?`, `resourceGroup?` | Fired Azure Monitor alerts, newest first: severity, state, condition, signal type, target and an `alertRef` (max 200).    |
| `get_alert`         | `alertRef`                                                                                          | One fired alert: rule, description and the condition that fired (metric, operator, threshold, value, window, dimensions). |
| `list_alert_rules`  | `resourceGroup?`                                                                                    | Metric, log search and activity log alert rules: enabled, severity, targets and a short condition summary.                |
| `get_activity_log`  | `timespan` (ISO 8601, max `P7D`), `resourceGroup?`, `resource?`, `status?`                          | What changed: control-plane operations, newest first (max 200), with callers as `user-NNN` / `app-NNN`.                   |

### metrics

| Tool                      | Inputs                                                                                                                                                           | Description                                                                                                                      |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `list_metric_definitions` | `resourceGroup`, `name`, `type?`, `subscription?`                                                                                                                | The metrics a resource emits: name, unit, aggregations, dimensions, namespace, time grains.                                      |
| `get_metrics`             | `resourceGroup`, `name`, `metrics` (1 to 10), `timespan?` (default `PT1H`, max `P30D`), `interval?`, `aggregation?`, `filter?`, `top?`, `type?`, `subscription?` | Metric values as `[isoTime, value]` series, at most 1500 points in total. `filter` like `RemoteIP eq '*'` splits by a dimension. |

### logs

| Tool              | Inputs                                                                                                                                | Description                                                                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `list_workspaces` | `subscription?`                                                                                                                       | Log Analytics workspaces and Application Insights components: name, resource group, location, retention, kind.                                   |
| `list_tables`     | `workspace`, `resourceGroup?`, `subscription?`                                                                                        | Tables that received rows in the last 24 hours, with row counts, busiest first.                                                                  |
| `run_kql`         | `workspace`, `query`, `timespan?` (ISO 8601 duration or `<start>/<end>`, default `P1D`, max `P7D`), `resourceGroup?`, `subscription?` | Guarded read-only KQL. At most 500 rows, 64 KB and 1024 characters per cell; `truncated` and `truncation` say what was cut. Rows are anonymised. |

### health

| Tool                           | Inputs                                                                   | Description                                                                                                               |
| ------------------------------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `get_resource_health`          | `resourceGroup`, `name`, `type?`, `subscription?`                        | Resource Health of one resource: availability state, reason, recommended actions and up to 20 recent transitions.         |
| `list_service_health_events`   | `timeRange?` (`1d`, `7d`, `30d`; default `7d`), `eventType?`, `status?`  | Service issues, planned maintenance and advisories for the context's subscriptions: impacted services and regions, times. |
| `list_advisor_recommendations` | `category?`, `impact?`, `resourceGroup?`, `limit?` (default 50, max 100) | Advisor recommendations, highest impact first: category, impact, problem, solution, target.                               |

## 8. Walkthroughs

The example output below is shortened. All names and numbers are made up.

### Investigate a fired alert

> **You:** I got paged for prod. What fired in the last hour?
>
> **Claude:** _(calls `list_fired_alerts` with `timeRange: "1h"`)_ One alert is still firing:
>
> - **cpu-high-vm-web** (Sev2, New, Fired) on `rg-app-prod/virtualMachines/vm-web-01`, fired at
>   09:12 UTC. Ref `id-004`.
>
> _(calls `get_alert` with `alertRef: "id-004"`)_ The rule fires when average `Percentage CPU` is
> greater than 85 over 5 minutes. The value that fired it was 97.3.
>
> **You:** What changed on that VM?
>
> **Claude:** _(calls `get_activity_log` with `timespan: "PT6H"`, `resourceGroup: "rg-app-prod"`,
> `resource: "vm-web-01"`)_ At 08:58 UTC, `user-002` ran
> `Microsoft.Compute/virtualMachines/extensions/write` (Succeeded). Nothing else in the last 6 hours.
>
> **You:** Show me the CPU curve and who is talking to it.
>
> **Claude:** _(calls `get_metrics` with `metrics: ["Percentage CPU", "Network In Total"]`,
> `timespan: "PT3H"`, `interval: "PT5M"`)_ CPU sat around 20 % until 08:59, then climbed to 95–98 %
> and stayed there. Inbound traffic did not change, so this is not a load spike.
>
> _(calls `list_workspaces`, then `run_kql` on `law-prod-weu`)_
>
> ```kql
> Perf
> | where Computer == "vm-web-01" and ObjectName == "Process" and CounterName == "% Processor Time"
> | summarize avg(CounterValue) by InstanceName
> | top 5 by avg_CounterValue
> ```
>
> The `monitoring-agent` process uses 90 % of a core since 08:59, right after the extension update
> by `user-002`. Likely cause: the new extension version. Next step for you: roll back the
> extension, or ask `user-002`'s team (you can map the pseudonym yourself in the portal: the AI
> cannot).

### Check whether Azure itself is the problem

> **You:** The API on app-api-prod is throwing 5xx since 14:00. Is it us or Azure?
>
> **Claude:** _(calls `get_resource_health` with `resourceGroup: "rg-app-prod"`,
> `name: "app-api-prod"`)_ Resource Health says **Degraded** since 13:57 UTC, reason type
> `Unplanned`, summary: _"We're sorry, your app is experiencing a platform issue…"_.
>
> _(calls `list_service_health_events` with `timeRange: "1d"`, `status: "Active"`)_ There is one
> active **ServiceIssue**, `id-009`: _"App Service - West Europe - Intermittent 5xx errors"_,
> impacting App Service in West Europe since 13:50 UTC, last updated 14:35 UTC.
>
> _(calls `run_kql` on `appi-api-prod`)_
>
> ```kql
> requests
> | where timestamp > ago(3h)
> | summarize total = count(), failed = countif(success == false) by bin(timestamp, 10m)
> ```
>
> Failures start at 13:50 and match the Service Health event. Your deployments in the activity log
> are from yesterday. This is a platform issue. Follow `id-009` in Service Health. If you have a
> second region, consider failing over.

## 9. Troubleshooting

Start with `safe-azure doctor`: every failed check comes with a fix hint.

| Symptom                                                   | What to do                                                                                                                                                                                                                                 |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `safe-azure: command not found` after installing          | Open a new terminal: the installer added `~/.cargo/bin` to your `PATH`.                                                                                                                                                                    |
| `safe-azure install` says Docker is not available         | Start Docker Desktop (or the Docker service) and run it again.                                                                                                                                                                             |
| `safe-azure login` refuses to run                         | It needs an interactive terminal. Run it yourself, not through Claude Code or a script.                                                                                                                                                    |
| An agent's command is blocked with a `safe-azure` message | That is the guard hook. The message says what to do instead (usually: use the MCP tools, or ask the user). See [SECURITY.md §7](./SECURITY.md#claude-code-guard).                                                                          |
| `claude mcp list` shows the server as failed              | `safe-azure doctor`. If the container is down, `safe-azure up`. `curl http://127.0.0.1:8765/healthz` from your own terminal should print `{"status":"ok",…}`.                                                                              |
| The container restarts in a loop, "failed to start"       | The message is deliberately vague. Usually `contexts.yaml` is invalid: GUIDs not in GUID format, an alias with capitals or underscores, or a `defaultContext` that is not declared. Fix it and run `safe-azure install --contexts <file>`. |
| `docker compose` created a `contexts.yaml` **directory**  | From source only: the file did not exist when you first ran `docker compose up`. Remove the directory, copy the example file, and start again.                                                                                             |
| `NoActiveContext`                                         | More than one context and no `defaultContext`. Run `safe-azure use <alias>`, or ask Claude to call `use_context`.                                                                                                                          |
| `NotLoggedIn`                                             | Run `safe-azure login <alias>` in your own terminal. After a container restart or an update this is expected.                                                                                                                              |
| The CLI reports the code **expired** or **failed**        | Run `safe-azure login <alias>` again. Make sure you sign in with an account of that context's tenant.                                                                                                                                      |
| HTTP 401 on `/mcp` or `/admin`                            | Missing or stale key: the keys change on every container restart. The CLI re-reads them on a 401. A raw HTTP client must send `Authorization: Bearer <mcp key>`.                                                                           |
| `Azure returned HTTP 403`                                 | The signed-in account lacks a read role on that subscription or workspace. See [SECURITY.md §6](./SECURITY.md#6-read-only-by-design-and-rbac).                                                                                             |
| `list_subscriptions` shows `NotVisible`                   | The account cannot see that subscription: wrong tenant, wrong ID in `contexts.yaml`, or no role.                                                                                                                                           |
| `ResourceNotFound` / `AmbiguousResource`                  | Check the name with `search_resources`. When a name exists more than once, add `resourceGroup`, `type` or `subscription`.                                                                                                                  |
| `KqlRejected`                                             | The guard refused the query (management command, `workspace()`, a non-allowlisted plugin, a timespan over 7 days…). The message says why.                                                                                                  |
| `KqlQueryFailed` (HTTP 400)                               | Syntax error, or a table or column that does not exist. Check with `list_tables`.                                                                                                                                                          |
| `QueryTimeout`                                            | Narrow the timespan, filter earlier, or summarize.                                                                                                                                                                                         |
| A version number shows as `public-ip-external-NNN`        | Over-masking of dotted numbers ([SECURITY.md §8](./SECURITY.md#8-residual-risks)). Ask for the field in a different form, for example with `split()` in KQL.                                                                               |
| `Invalid Host` (HTTP 403) on `/mcp` or `/admin`           | Use `127.0.0.1`, `localhost` or `[::1]` in the URL. Other host names are refused on purpose.                                                                                                                                               |
| `safe-azure update` says "not self-updating"              | The binary was not installed by the PowerShell or shell installer (npm, `cargo install`, a source build). Update it the way you installed it; `update` still updates the server and Claude Code setup.                                     |

## 10. Try it without Azure

[Dev Proxy](https://learn.microsoft.com/microsoft-cloud/dev/dev-proxy/overview) can play Azure for
you. It answers `login.microsoftonline.com`, `management.azure.com` and `api.loganalytics.io` with
the hand-written payloads in [`mocks/devproxy/`](../mocks/devproxy). Every ID in them is fake. The
device-code login completes on its own, so you don't need a browser either.

**With Docker** (Windows, macOS, Linux), from a clone of this repository with the `safe-azure`
CLI installed:

```bash
docker compose -f docker-compose.yml -f docker-compose.mock.yml up -d --build --wait
claude mcp add --scope user safe-azure -- safe-azure mcp
safe-azure login prod   # completes on its own against the mocked Entra ID
```

Then in Claude: _"show me the fired alerts and what happened on vm-web-01"_. To stop it, run
`docker compose -f docker-compose.yml -f docker-compose.mock.yml down -v`. Don't run
`safe-azure install` with the mock stack: it would replace the mock container with the released
image.

To try failure handling (random 5xx, 429 with `Retry-After`, and up to 1.5 s of latency on ARM and
Log Analytics), start the stack with the chaos preset:

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

The proxy and the extra CA only exist in the mock setup. `docker-compose.yml` alone never uses a
proxy or trusts an extra CA. The mocks are hand-written. **Never commit recorded traffic** (for
example from Dev Proxy's `MockGeneratorPlugin`): it contains real tenant, subscription and
resource IDs (AGENTS.md R7). CI runs the same stack in the `e2e` job
(`npm run test:e2e-mock`).
