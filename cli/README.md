# safe-azure (CLI)

A native CLI that installs, updates and drives the safe-my-azure-from-claude MCP server, and guards Claude Code with a hook.
The design and contracts are in [docs/adr/0001-cli-auth-install.md](../docs/adr/0001-cli-auth-install.md).

```bash
cargo build
cargo test
cargo clippy --all-targets -- -D warnings
cargo fmt --check
```

## Module ownership

| Module                                                            | Area                                                |
| ----------------------------------------------------------------- | --------------------------------------------------- |
| `commands/login.rs`, `commands/bridge.rs`, `keys.rs`, `server.rs` | CLI core: admin API client, keys, login, MCP bridge |
| `commands/install.rs`                                             | install / uninstall / update / doctor / up / down   |
| `commands/hook.rs`, `skill/`                                      | Claude Code hook and skill                          |
| `paths.rs`                                                        | shared paths (keep small)                           |

Rules: no `unsafe` (DPAPI calls are wrapped in one module with a justified `#[allow(unsafe_code)]`), no `unwrap`, and every command has tests. Commit rules are the same as the rest of the repo (AGENTS.md §6).

## Environment

- `SAFE_AZURE_NO_UPDATE_CHECK=1` turns off the once-a-day "update available" notice (it is never shown for `mcp` and `hook`).
- `SAFE_AZURE_GITHUB_TOKEN` is passed to the self-updater when GitHub rate-limits anonymous requests.
