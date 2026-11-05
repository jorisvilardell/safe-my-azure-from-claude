# Contributing

Thanks for helping. This project protects credentials and identifiers, so a few rules are strict.

1. **Read [AGENTS.md](./AGENTS.md) first.** It is the source of truth for the architecture, the
   two guarantees (no credential and no identifier reaches the AI) and the security rules. It
   applies to humans and AI agents alike.
2. **Never put real Azure identifiers anywhere**: code, tests, fixtures, docs, issues, commit
   messages. Use fake GUIDs (`00000000-0000-0000-0000-000000000001`) and documentation IPs
   (`203.0.113.0/24`).
3. **Security issues go through private reporting**, not public issues: see
   [docs/SECURITY.md](./docs/SECURITY.md).

## Checks

Server (Node.js 24 or later):

```bash
npm ci
npm run check      # lint + format:check + typecheck + test + build, what CI runs
```

CLI (Rust), from `cli/`:

```bash
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
```

Both must pass before a PR is merged.

## Pull requests

- Branch from `main` (`feat/…`, `fix/…`, `docs/…`, `chore/…`).
- Title in Conventional Commits style, for example `feat(inventory): add search_resources`. A
  short description is enough.
- No `Co-Authored-By` trailers and no AI attribution lines. PRs are squash-merged.
- A new MCP tool goes through `defineTool()` and follows the feature checklist in
  [AGENTS.md §2](./AGENTS.md#feature-checklist-definition-of-done).
