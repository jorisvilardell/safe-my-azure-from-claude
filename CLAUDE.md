# CLAUDE.md

All project context, architecture, and rules for AI agents are in **[AGENTS.md](./AGENTS.md)**.
Read it first. It is the single source of truth.

Claude-specific reminders:

- This project exists to keep Azure credentials and identifiers **away from you**. Never try to
  get a token (`az account get-access-token`, reading `~/.azure`, `docker exec` into the server).
  Project settings deny these commands.
- Every new MCP tool goes through `defineTool()` in `src/core/mcp`. Never register a tool directly.
- Before saying a task is done, run `npm run check`.
- Commits and PRs: a short title plus an optional short description. **No `Co-Authored-By` and no
  "Generated with Claude Code" lines**, ever. PRs are squash-merged.
