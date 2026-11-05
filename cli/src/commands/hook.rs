//! `safe-azure hook claude`: Claude Code `PreToolUse` guard. Owned by the "hook + skill" issue.
//!
//! Reads the hook JSON on stdin and blocks tool calls that could reach credentials or
//! bypass the MCP (see docs/SECURITY.md).

use clap::Subcommand;
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
