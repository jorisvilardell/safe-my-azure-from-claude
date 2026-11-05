# safe-my-azure-from-claude

**A read-only, anonymising Azure MCP server.** Claude (or any MCP client) can help you investigate
Azure alerts and incidents, and it never gets your credentials or your identifiers.

## Why

When something breaks in Azure, an AI agent is good at the boring part: listing what fired,
reading the activity log, pulling metrics, writing KQL. To do that it usually needs `az` access or
a token, and that means:

- it holds credentials that can act as you, and
- every tenant ID, subscription ID, resource ID, email and IP it reads ends up in its context
  window, and then possibly in logs or at the model provider.

This project puts a small server between the AI and Azure. You sign in to Azure yourself, in your
own terminal. The server keeps the token, makes only read calls, and anonymises every result before
the AI sees it.

## How it works

```
                      MCP (stdio)            HTTP + MCP key
 Claude Code ──────▶ safe-azure mcp ──────▶ ┌──────── container (127.0.0.1:8765) ───────┐
                                            │ tools → allowlist → scrub() → AI           │──▶ Azure
 You, in your ─────▶ safe-azure login ────▶ │ token cache: in memory only                │   (read-only)
 own terminal        (device code)          └────────────────────────────────────────────┘
```

- The server runs in Docker, on `127.0.0.1` only. It holds the Azure token **in memory**.
- `safe-azure` is a small native CLI. It installs and updates the server, signs you in, and runs
  the stdio bridge (`safe-azure mcp`) that Claude Code launches. The bridge adds the server key
  itself, so no key ever goes in a client config file.
- `safe-azure install` also adds a guard hook to Claude Code. It blocks the obvious ways around the
  server (`az`, `docker exec`, reading `~/.azure` or the CLI's config, calling the server port
  directly).

## What the AI can and cannot see

| The AI sees                                                         | The AI never sees                                          |
| ------------------------------------------------------------------- | ---------------------------------------------------------- |
| Resource names, resource groups, locations, SKUs, states            | Tokens, device codes, server keys                          |
| Your **aliases** for tenants and subscriptions (`prod`, `prod-app`) | Tenant, subscription and object GUIDs, ARM resource IDs    |
| Alerts, activity log, metrics, health, Advisor, KQL results         | Public IPs, emails and UPNs (replaced by `user-003`, …)    |
| Pseudonyms such as `id-007`, `user-003`, `public-ip-external-002`   | Secrets in data, tag values (unless you allowlist the key) |
| Private IPs, tag keys                                               | Any write: there are no write tools and no "run any" tool  |

Some data reaches the AI on purpose (resource names, log text after scrubbing). Read the
[threat model and residual risks](./docs/SECURITY.md) before you point it at a real tenant.

## Requirements

- **Docker**: Docker Desktop on Windows (WSL 2 backend) or macOS, or Docker Engine on Linux.
- **Claude Code**, or another MCP client ([docs/CLIENTS.md](./docs/CLIENTS.md)).
- An Entra ID account with read roles on the subscriptions you want to look at: `Reader`,
  `Monitoring Reader` and `Log Analytics Reader`
  ([details](./docs/SECURITY.md#6-read-only-by-design-and-rbac)).

You do not need the Azure CLI, an app registration or a client secret.

## Install

Run every `safe-azure` command below in **your own terminal**, not in a shell that Claude Code
drives. The guard hook refuses `install`, `login`, `update` and friends when an agent runs them.

### 1. Install the CLI

Windows (x64, arm64), in PowerShell:

```powershell
powershell -ExecutionPolicy ByPass -c "irm https://github.com/jorisvilardell/safe-my-azure-from-claude/releases/latest/download/safe-azure-installer.ps1 | iex"
```

macOS and Linux (x64, arm64):

```bash
curl --proto '=https' --tlsv1.2 -LsSf https://github.com/jorisvilardell/safe-my-azure-from-claude/releases/latest/download/safe-azure-installer.sh | sh
```

With Node.js, from npm:

```bash
npm install -g safe-azure     # or try it first: npx safe-azure --help
```

The installers put `safe-azure` in `~/.cargo/bin` and add it to your `PATH`. Open a new terminal
and check with `safe-azure --version`.

### 2. Set up the server and Claude Code

```bash
safe-azure install
```

It checks Docker, asks for your Azure contexts (see below), pulls
`ghcr.io/jorisvilardell/safe-my-azure-from-claude` at the same version as the CLI, starts it
hardened on `127.0.0.1:8765`, registers it in Claude Code (user scope), installs a Claude Code
skill and the guard hook, then runs `safe-azure doctor`.

### 3. Describe your tenants

A **context** is one tenant plus the subscriptions you want in it. You give each one an
**alias**. The AI only ever sees the aliases. The wizard in `safe-azure install` asks for:

- a context alias (`prod`) and its tenant ID,
- each subscription alias (`prod-app`) and its subscription ID,
- the default context, if you have more than one,
- the tag keys whose **values** the AI may see (for example `env,app`). Every other tag value is
  masked.

It writes `contexts.yaml` to `%APPDATA%\safe-azure\` (Windows), `~/.config/safe-azure/` (Linux) or
`~/Library/Application Support/safe-azure/` (macOS). Aliases are lowercase kebab-case, at most 40
characters. To use a file you already have instead of the wizard:

```bash
safe-azure install --contexts ./contexts.yaml
```

The format is in [`config/contexts.example.yaml`](./config/contexts.example.yaml) and
[docs/USAGE.md](./docs/USAGE.md#2-describe-your-tenants-contextsyaml).

### 4. Sign in to Azure

```bash
safe-azure login prod
```

It prints a code, opens `https://microsoft.com/devicelogin` in your browser, and waits. Sign in
with an account of that tenant. The token goes to the server, never to the CLI, the browser or the
AI. Sign in to each context you want to use. A server restart (or `safe-azure update`) signs you
out of all of them.

### 5. Ask Claude

Start Claude Code anywhere and try:

- _"Call server_info."_
- _"Which Azure contexts do I have, and am I logged in?"_
- _"What fired in prod in the last hour?"_
- _"What changed on vm-web-01 in the last 6 hours, and what does its CPU look like?"_

More examples and every tool: [docs/USAGE.md](./docs/USAGE.md).

## Day to day

| Command                        | What it does                                                         |
| ------------------------------ | -------------------------------------------------------------------- |
| `safe-azure status`            | Contexts, which one is active, who is signed in and for how long.    |
| `safe-azure login [alias]`     | Sign in to a context (default: the active one).                      |
| `safe-azure use <alias>`       | Switch the active context.                                           |
| `safe-azure logout <alias>`    | Drop a context's token.                                              |
| `safe-azure doctor`            | Check Docker, the container, versions, keys, MCP registration, hook. |
| `safe-azure up` / `down`       | Start or stop the server container. `down` signs everyone out.       |
| `safe-azure update`            | Update the CLI, the server image and the Claude Code setup.          |
| `safe-azure update --check`    | Only report whether a new release exists.                            |
| `safe-azure uninstall`         | Remove the container, MCP registration, skill and hook.              |
| `safe-azure uninstall --purge` | The same, and also delete `contexts.yaml` and the CLI's config.      |

`update` works for the PowerShell and shell installers. With npm, run
`npm install -g safe-azure@latest`, then `safe-azure update` to update the server and Claude Code
setup. `uninstall` keeps the image and the binary: remove them with `docker image rm` and by
deleting `safe-azure` (or `npm uninstall -g safe-azure`).

## Other MCP clients

Claude Desktop, VS Code (Copilot agent mode), Cursor and raw HTTP clients:
[docs/CLIENTS.md](./docs/CLIENTS.md). The guard hook only protects Claude Code, so other clients
need their own controls.

Can't run Docker? An optional native Windows mode signs in with WAM instead of a device code. Its
isolation is weaker: read [docs/WINDOWS.md](./docs/WINDOWS.md) first.

## Try it without Azure

[Dev Proxy](https://learn.microsoft.com/microsoft-cloud/dev/dev-proxy/overview) can play Azure,
with the hand-written fake payloads in [`mocks/devproxy/`](./mocks/devproxy). The device-code
login completes on its own. From a clone of this repository, with the `safe-azure` CLI installed:

```bash
docker compose -f docker-compose.yml -f docker-compose.mock.yml up -d --build --wait
claude mcp add --scope user safe-azure -- safe-azure mcp
safe-azure login prod
```

Then ask Claude: _"show me the fired alerts and what happened on vm-web-01"_. Stop it with
`docker compose -f docker-compose.yml -f docker-compose.mock.yml down -v`. Don't run
`safe-azure install` here: it would replace the mock container with the released image. The chaos
preset and running without Docker are in [docs/USAGE.md](./docs/USAGE.md#10-try-it-without-azure).

## Development

Requires Node.js 24 or later, and Rust for the CLI.

```bash
npm ci
npm run dev             # server in watch mode
npm run check           # lint + format + typecheck + test + build (what CI runs)
cd cli && cargo test    # CLI
```

Read [AGENTS.md](./AGENTS.md) before changing anything: architecture, security rules and
conventions, for humans and AI agents alike. See also [CONTRIBUTING.md](./CONTRIBUTING.md).

## Documentation

- [docs/USAGE.md](./docs/USAGE.md): getting started in detail, `contexts.yaml`, sign-in, contexts, tool reference, walkthroughs, troubleshooting.
- [docs/SECURITY.md](./docs/SECURITY.md): threat model, what the AI can and cannot see, RBAC, the Claude Code guard, residual risks, reporting a vulnerability.
- [docs/CLIENTS.md](./docs/CLIENTS.md): Claude Desktop, VS Code, Cursor and other MCP clients.
- [docs/WINDOWS.md](./docs/WINDOWS.md): optional native Windows mode with WAM sign-in (`AUTH_MODE=broker`), weaker isolation than Docker.
- [docs/RELEASING.md](./docs/RELEASING.md): version bump, tag, and what the release publishes.
- [docs/adr/](./docs/adr/): architecture decisions ([0001](./docs/adr/0001-cli-auth-install.md) CLI, keys and install; [0002](./docs/adr/0002-persisted-token-cache.md) persisted token cache, proposed).
- [cli/README.md](./cli/README.md): building and testing the `safe-azure` CLI.
- [AGENTS.md](./AGENTS.md): architecture, security rules and conventions for contributors.

## License

[MIT](./LICENSE)
