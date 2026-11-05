# Other MCP clients

The server speaks **MCP over Streamable HTTP** at `http://127.0.0.1:8765/mcp`, in stateless mode,
on the loopback interface only. Every request needs `Authorization: Bearer <mcp key>`; the key is
random, changes on every container restart and lives only in the container
([USAGE.md §3](./USAGE.md#3-start-the-server)). Start the server first.

**The recommended way for every client is the `safe-azure mcp` stdio bridge**, which comes with the
`safe-azure` CLI (see [#60](https://github.com/jorisvilardell/safe-my-azure-from-claude/issues/60)–[#63](https://github.com/jorisvilardell/safe-my-azure-from-claude/issues/63)).
It reads the key itself, re-reads it after a restart, and adds the header: no key is ever written
to a client config file. Register it as a **stdio** server with the command `safe-azure` and the
argument `mcp`.

Whatever the client, the security model is the same: the server scrubs what it returns, but the
**client's other tools** (shell, file access, web fetch, other MCP servers) can still reach your
Azure CLI session, `~/.azure`, `config/contexts.yaml` or the keys (`docker exec`). Give each client the
equivalent of the Claude Code deny rules
([SECURITY.md §7](./SECURITY.md#7-claude-code-deny-rules)), or keep those tools on manual approval.

Formats below were checked against each client's documentation in November 2026. Clients change
quickly: if a snippet stops working, check the linked page.

## Claude Code

```bash
claude mcp add --scope user safe-azure -- safe-azure mcp
```

Or, in a project's `.mcp.json` ([docs](https://code.claude.com/docs/en/mcp)):

```json
{
  "mcpServers": {
    "safe-azure": {
      "command": "safe-azure",
      "args": ["mcp"]
    }
  }
}
```

## Claude Desktop

Claude Desktop's **custom connectors** (Settings → Connectors) are meant for servers reachable on
the internet, not for a server on your loopback interface. Use the stdio bridge: edit
`claude_desktop_config.json` (Settings → Developer → Edit Config; on Windows it is in
`%APPDATA%\Claude\`):

```json
{
  "mcpServers": {
    "safe-azure": {
      "command": "safe-azure",
      "args": ["mcp"]
    }
  }
}
```

Restart Claude Desktop after editing the file.

Claude Desktop has no equivalent of Claude Code's `permissions.deny`. Keep its other local tools
(filesystem, shell extensions) on approval while you use this server.

## VS Code (GitHub Copilot agent mode)

Workspace file `.vscode/mcp.json`, or the user-profile `mcp.json` (command **MCP: Open User
Configuration**). The top-level key is `servers`
([docs](https://code.visualstudio.com/docs/agents/reference/mcp-configuration)):

```json
{
  "servers": {
    "safe-azure": {
      "type": "stdio",
      "command": "safe-azure",
      "args": ["mcp"]
    }
  }
}
```

Copilot's terminal tool can run `az`, `docker exec` and `curl` like Claude Code's shell can. Keep
terminal commands on manual approval.

## Cursor

Project file `.cursor/mcp.json`, or global `~/.cursor/mcp.json`
([docs](https://cursor.com/docs/context/mcp)):

```json
{
  "mcpServers": {
    "safe-azure": {
      "command": "safe-azure",
      "args": ["mcp"]
    }
  }
}
```

Leave Cursor's auto-run for terminal commands off while this server is enabled.

## Any other client (raw HTTP)

Prefer the stdio bridge above. A client that can only speak HTTP must:

- use Streamable HTTP, `POST http://127.0.0.1:8765/mcp`. `GET` and `DELETE` on `/mcp` answer 405
  (no SSE stream, no sessions);
- send `Authorization: Bearer <mcp key>` on every request. The key is the `mcp` field of
  `docker exec azure-safe-mcp cat /run/safe-azure/keys.json`. Without it, or with a wrong one, the
  server answers 401 with `WWW-Authenticate: Bearer` and a JSON-RPC error. The key changes on every
  container restart, and whatever config file holds it can be read by the client's other tools:
  that is why the bridge is preferred;
- send a `Host` header of `127.0.0.1`, `localhost` or `[::1]` (with the port). Anything else gets 403.

Never give a client the `admin` key: it starts sign-ins and returns the device code. Don't put the
server behind a reverse proxy or publish it on another interface to share it: the login state is
shared by every caller.
