# Usage guide

How to install the server, connect Claude Code to it, sign in, and use it to investigate Azure.
For what the AI can and cannot see, read [SECURITY.md](./SECURITY.md). For MCP clients other than
Claude Code, read [CLIENTS.md](./CLIENTS.md).

- [1. Install](#1-install)
- [2. Configure `contexts.yaml`](#2-configure-contextsyaml)
- [3. Start the server](#3-start-the-server)
- [4. Connect Claude Code](#4-connect-claude-code)
- [5. Sign in](#5-sign-in)
- [6. Switch contexts](#6-switch-contexts)
- [7. Tool reference](#7-tool-reference)
- [8. Walkthroughs](#8-walkthroughs)
- [9. Troubleshooting](#9-troubleshooting)

## 1. Install

You need:

- **Docker Desktop** for Windows (WSL 2 backend), or Docker Engine with Compose v2 on Linux or macOS.
- **Claude Code** (or another MCP client that speaks Streamable HTTP).
- An Entra ID account with read roles on the subscriptions you want to look at: `Reader`,
  `Monitoring Reader` and `Log Analytics Reader` ([SECURITY.md §6](./SECURITY.md#6-read-only-by-design-and-rbac)).

You do **not** need the Azure CLI, an app registration or a client secret.

```bash
git clone https://github.com/jorisvilardell/safe-my-azure-from-claude.git
cd safe-my-azure-from-claude
```

## 2. Configure `contexts.yaml`

A **context** is one tenant, with the subscriptions you want to use in it. You give each one an
**alias**. The AI only ever sees the aliases.

```bash
cp config/contexts.example.yaml config/contexts.yaml   # gitignored
```

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
| `contexts.<alias>`          | Context alias: lowercase kebab-case, at most 40 characters.                                                                                                             |
| `tenantId`                  | The tenant to sign in to.                                                                                                                                               |
| `subscriptions.<alias>: id` | The subscriptions tools may query. Nothing outside this list is ever queried. The AI sees the alias.                                                                    |
| `defaultContext`            | Active context at startup. If omitted and there is exactly one context, that one is active. Otherwise the AI must call `use_context` first.                             |
| `safeTagKeys`               | Tag keys whose **values** are shown (case-insensitive). Every other tag value is `[masked]`. Only add keys whose values are harmless, like `env` or `app`, not `owner`. |

The file holds IDs but no secrets. It is mounted read-only in the container. Never commit it.

## 3. Start the server

```bash
docker compose up -d --build
```

This builds the image and starts the `azure-safe-mcp` container. It listens on
`127.0.0.1:8765` only:

| Path       | For                                                 |
| ---------- | --------------------------------------------------- |
| `/mcp`     | MCP over Streamable HTTP (POST, stateless).         |
| `/login`   | The device-code sign-in page, for you in a browser. |
| `/healthz` | Liveness check (`{"status":"ok"}`), used by Docker. |

Check it: `docker compose ps` should show the container as `healthy` after about 30 seconds.

`LOG_LEVEL` (`debug`, `info`, `warn`, `error`; default `info`) can be set in a `.env` file next to
`docker-compose.yml`. Logs are scrubbed, and you read them yourself with `docker compose logs`. The
AI is denied `docker logs` ([SECURITY.md §7](./SECURITY.md#7-claude-code-deny-rules)).

After you edit `contexts.yaml`, restart: `docker compose restart`. A restart drops every sign-in,
because tokens live in memory only.

## 4. Connect Claude Code

```bash
claude mcp add --transport http azure-safe http://127.0.0.1:8765/mcp
```

That adds the server for you, in the current project (`--scope local`, the default). Use
`--scope user` to have it in every project, or `--scope project` to write it to a shared `.mcp.json`.

If you use it outside this repository, also copy the `permissions.deny` block from
[`.claude/settings.json`](../.claude/settings.json) into `~/.claude/settings.json`. Those rules stop
Claude Code from getting around the server ([SECURITY.md §7](./SECURITY.md#7-claude-code-deny-rules)).

Check with `claude mcp list`, or ask Claude: _"call server_info"_.

## 5. Sign in

Each context is signed in separately, with Microsoft device-code login. The code is shown only on
the `/login` page, never to the AI.

> **You:** Log me in to prod.
>
> **Claude:** _(calls `login`)_ Open http://127.0.0.1:8765/login to sign in to context 'prod'.

1. Open http://127.0.0.1:8765/login. Under **Pending sign-ins** you see the context, a code such as
   `ABCD1234`, a link to `https://microsoft.com/devicelogin` and the time left. The page refreshes
   every 5 seconds.
2. Open the link, enter the code and sign in with the account for that tenant.
3. The context moves to **Signed-in contexts**, with the minutes left on the access token.

> **You:** Am I in?
>
> **Claude:** _(calls `login_status`)_ prod is logged in, token valid for 74 more minutes. lab is not
> logged in.

Notes:

- A code expires after 15 minutes. If the page says **Code expired** or **Sign-in failed**, ask for
  `login` again.
- The access token is refreshed in memory while the session lasts. When it can no longer be
  refreshed, tools answer `NotLoggedIn`: run `login` again.
- `logout` drops a context's credential. Restarting the container drops all of them.

## 6. Switch contexts

Every tool works on the **active** context. Inside a context, most tools search every declared
subscription unless you pass a `subscription` alias.

> **You:** Which tenants do you have?
>
> **Claude:** _(calls `list_contexts`)_ Two contexts: **prod** (subscriptions prod-app,
> prod-network, active, logged in) and **lab** (subscription lab, not logged in).
>
> **You:** Switch to lab.
>
> **Claude:** _(calls `use_context` with `alias: "lab"`)_ Context 'lab' is now active but not logged
> in. _(calls `login`)_ Open http://127.0.0.1:8765/login to sign in to context 'lab'.

The active context is server-wide: every client connected to the server shares it.

## 7. Tool reference

22 tools, all read-only. Inputs marked `?` are optional. Resource inputs are **names** and
**aliases**, never IDs.

### system

| Tool          | Inputs | Description                                                                                 |
| ------------- | ------ | ------------------------------------------------------------------------------------------- |
| `server_info` | none   | Version, guarantees and enabled features. Call it first to discover what the server can do. |

### contexts

| Tool            | Inputs   | Description                                                                                          |
| --------------- | -------- | ---------------------------------------------------------------------------------------------------- |
| `list_contexts` | none     | Declared contexts with their subscription aliases, which one is active and which ones are logged in. |
| `use_context`   | `alias`  | Switches the active context. Every other tool then works on it.                                      |
| `login`         | `alias?` | Starts a device-code sign-in (default: active context) and returns the `/login` URL for you to open. |
| `login_status`  | `alias?` | Per context: logged in, sign-in pending or failed, and minutes left on the access token.             |
| `logout`        | `alias`  | Drops the context's in-memory credential.                                                            |

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

| Tool              | Inputs                                                                                          | Description                                                                                                                                      |
| ----------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `list_workspaces` | `subscription?`                                                                                 | Log Analytics workspaces and Application Insights components: name, resource group, location, retention, kind.                                   |
| `list_tables`     | `workspace`, `resourceGroup?`, `subscription?`                                                  | Tables that received rows in the last 24 hours, with row counts, busiest first.                                                                  |
| `run_kql`         | `workspace`, `query`, `timespan?` (default `P1D`, max `P7D`), `resourceGroup?`, `subscription?` | Guarded read-only KQL. At most 500 rows, 64 KB and 1024 characters per cell; `truncated` and `truncation` say what was cut. Rows are anonymised. |

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

| Symptom                                               | What to do                                                                                                                                                                                                     |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claude mcp list` shows the server as failed          | `docker compose ps`: is the container up and healthy? `curl http://127.0.0.1:8765/healthz` from your own terminal should print `{"status":"ok"}`.                                                              |
| The container restarts in a loop, "failed to start"   | The message is deliberately vague. Usually `config/contexts.yaml` is invalid: GUIDs not in GUID format, an alias with capitals or underscores, or a `defaultContext` that is not declared. Fix it and restart. |
| Docker created a `contexts.yaml` **directory**        | The file did not exist when you first ran `docker compose up`. Remove the directory, copy the example file, and start again.                                                                                   |
| `NoActiveContext`                                     | More than one context and no `defaultContext`. Call `use_context`.                                                                                                                                             |
| `NotLoggedIn`                                         | Call `login` and finish the sign-in on `/login`. After a container restart this is expected.                                                                                                                   |
| `/login` shows **Code expired** or **Sign-in failed** | Ask for `login` again. Make sure you sign in with an account of that context's tenant.                                                                                                                         |
| `Azure returned HTTP 403`                             | The signed-in account lacks a read role on that subscription or workspace. See [SECURITY.md §6](./SECURITY.md#6-read-only-by-design-and-rbac).                                                                 |
| `list_subscriptions` shows `NotVisible`               | The account cannot see that subscription: wrong tenant, wrong ID in `contexts.yaml`, or no role.                                                                                                               |
| `ResourceNotFound` / `AmbiguousResource`              | Check the name with `search_resources`. When a name exists more than once, add `resourceGroup`, `type` or `subscription`.                                                                                      |
| `KqlRejected`                                         | The guard refused the query (management command, `workspace()`, a non-allowlisted plugin, a timespan over 7 days…). The message says why.                                                                      |
| `KqlQueryFailed` (HTTP 400)                           | Syntax error, or a table or column that does not exist. Check with `list_tables`.                                                                                                                              |
| `QueryTimeout`                                        | Narrow the timespan, filter earlier, or summarize.                                                                                                                                                             |
| A version number shows as `public-ip-external-NNN`    | Over-masking of dotted numbers ([SECURITY.md §8](./SECURITY.md#8-residual-risks)). Ask for the field in a different form, for example with `split()` in KQL.                                                   |
| `Invalid Host` (HTTP 403) on `/mcp` or `/login`       | Use `127.0.0.1`, `localhost` or `[::1]` in the URL. Other host names are refused on purpose.                                                                                                                   |
| The login link points to the wrong port               | The server builds it from `PORT` (or `PUBLIC_URL`), not from the request. If you change the published port in `docker-compose.yml`, add `PUBLIC_URL: http://127.0.0.1:<port>` to the service's `environment`.  |
