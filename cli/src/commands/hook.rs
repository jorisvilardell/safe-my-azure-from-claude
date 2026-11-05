//! `safe-azure hook claude`: Claude Code `PreToolUse` guard. Owned by the "hook + skill" issue.
//!
//! Reads the hook JSON on stdin and blocks tool calls that could reach credentials or
//! bypass the MCP (see docs/SECURITY.md and ADR 0001 §5).
//! `install` / `uninstall` / `is_installed` are a contract used by the install command.
#![allow(dead_code)]

use anyhow::{Result, bail};
use clap::Subcommand;
use std::path::Path;
use std::process::ExitCode;

#[derive(Debug, Subcommand)]
pub enum HookCommand {
    /// Claude Code `PreToolUse` hook: reads the event JSON on stdin.
    Claude,
}

pub fn run(_cmd: &HookCommand) -> ExitCode {
    // Fail closed is decided by the hook issue; the stub allows everything.
    ExitCode::SUCCESS
}

/// Merges the hook into `<claude_dir>/settings.json` (backup first, idempotent).
/// `exe` is the absolute path of this binary. Returns true when the file changed.
pub fn install(_claude_dir: &Path, _exe: &Path) -> Result<bool> {
    bail!("not implemented yet")
}

/// Removes only our hook entry. Returns true when the file changed.
pub fn uninstall(_claude_dir: &Path) -> Result<bool> {
    bail!("not implemented yet")
}

/// True when our hook entry is present and points at an existing binary.
pub fn is_installed(_claude_dir: &Path) -> bool {
    false
}
