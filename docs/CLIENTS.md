# Other MCP clients

The server speaks **MCP over Streamable HTTP** at `http://127.0.0.1:8765/mcp`, in stateless mode,
with no authentication (it relies on the loopback binding). Any client that supports a remote HTTP
MCP server can use it. Start the server first ([USAGE.md](./USAGE.md#3-start-the-server)).

Whatever the client, the security model is the same: the server scrubs what it returns, but the
**client's other tools** (shell, file access, web fetch, other MCP servers) can still reach your
Azure CLI session, `~/.azure`, `config/contexts.yaml` or the `/login` page. Give each client the
equivalent of the Claude Code deny rules
([SECURITY.md §7](./SECURITY.md#7-claude-code-deny-rules)), or keep those tools on manual approval.

Formats below were checked against each client's documentation in November 2026. Clients change
quickly: if a snippet stops working, check the linked page.

## Claude Code

```bash
claude mcp add --transport http azure-safe http://127.0.0.1:8765/mcp
```

Or, in a project's `.mcp.json` ([docs](https://code.claude.com/docs/en/mcp)):

```json
{
  "mcpServers": {
    "azure-safe": {
      "type": "http",
      "url": "http://127.0.0.1:8765/mcp"
    }
  }
}
```

`type` is required: an entry with a `url` and no `type` is read as a stdio server.

## Claude Desktop (through a stdio bridge)

Claude Desktop's **custom connectors** (Settings → Connectors) are meant for servers reachable on
the internet, not for a server on your loopback interface. Use a local bridge instead:
[`mcp-remote`](https://github.com/geelen/mcp-remote) runs as a stdio server for Claude Desktop and
forwards to the HTTP endpoint. It needs Node.js on the host.

Edit `claude_desktop_config.json` (Settings → Developer → Edit Config; on Windows it is in
`%APPDATA%\Claude\`):

```json
{
  "mcpServers": {
    "azure-safe": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote@<version>",
        "http://127.0.0.1:8765/mcp",
        "--transport",
        "http-only",
        "--allow-http"
      ]
    }
  }
}
```

- `--transport http-only` skips the SSE fallback (the server has no SSE endpoint).
- `--allow-http` lets `mcp-remote` use plain HTTP. That is fine here only because the traffic never
  leaves `127.0.0.1`.
- Pin `<version>` to a release you have checked. The bridge sees every tool result: it is part of
  your trusted computing base, so don't let `npx` pull whatever is latest.
- Restart Claude Desktop after editing the file.

Claude Desktop has no equivalent of Claude Code's `permissions.deny`. Keep its other local tools
(filesystem, shell extensions) on approval while you use this server.

## VS Code (GitHub Copilot agent mode)

Workspace file `.vscode/mcp.json`, or the user-profile `mcp.json` (command **MCP: Open User
Configuration**). The top-level key is `servers`
([docs](https://code.visualstudio.com/docs/agents/reference/mcp-configuration)):

```json
{
  "servers": {
    "azure-safe": {
      "type": "http",
      "url": "http://127.0.0.1:8765/mcp"
    }
  }
}
```

Copilot's terminal tool can run `az`, `docker exec` and `curl` like Claude Code's shell can. Keep
terminal commands on manual approval.

## Cursor

Project file `.cursor/mcp.json`, or global `~/.cursor/mcp.json`
([docs](https://cursor.com/docs/context/mcp)). Cursor infers the transport from `url`:

```json
{
  "mcpServers": {
    "azure-safe": {
      "url": "http://127.0.0.1:8765/mcp"
    }
  }
}
```

Leave Cursor's auto-run for terminal commands off while this server is enabled.

## Any other client

- Transport: Streamable HTTP, `POST http://127.0.0.1:8765/mcp`. `GET` and `DELETE` on `/mcp`
  answer 405 (no SSE stream, no sessions).
- The `Host` header must be `127.0.0.1`, `localhost` or `[::1]` (with the port). Anything else gets 403.
- No authentication header is needed. Don't put the server behind a reverse proxy or publish it on
  another interface to share it: there is no authentication, and the login state is shared by
  every caller.
