//! `safe-azure hook claude`: Claude Code `PreToolUse` guard (ADR 0001 §5, docs/SECURITY.md).
//!
//! Reads the hook JSON on stdin and blocks tool calls that could reach credentials or bypass
//! the MCP: exit code 2 with the reason on stderr, nothing on stdout. Anything else exits 0.
//! `install` / `uninstall` / `is_installed` are a contract used by the install command.
#![allow(dead_code)]

mod rules;
mod settings;

use anyhow::Result;
use clap::Subcommand;
use std::io::Read;
use std::path::Path;
use std::process::ExitCode;

#[derive(Debug, Subcommand)]
pub enum HookCommand {
    /// Claude Code `PreToolUse` hook: reads the event JSON on stdin.
    Claude,
}

/// Exit code Claude Code reads as "block the tool call, stderr is the reason".
const BLOCK: u8 = 2;
/// Hook events are small; anything bigger is refused rather than buffered.
const MAX_INPUT: u64 = 16 * 1024 * 1024;

pub fn run(cmd: &HookCommand) -> ExitCode {
    match cmd {
        HookCommand::Claude => {
            let mut raw = String::new();
            let read = std::io::stdin().take(MAX_INPUT).read_to_string(&mut raw);
            // An unreadable or oversized event cannot be checked: fail closed.
            let decision = if read.is_err() || raw.len() as u64 >= MAX_INPUT {
                rules::evaluate("", &rules::Env::default())
            } else {
                rules::evaluate(&raw, &rules::Env::from_system())
            };
            match decision {
                rules::Decision::Allow => ExitCode::SUCCESS,
                rules::Decision::Deny(reason) => {
                    eprintln!("{reason}");
                    ExitCode::from(BLOCK)
                }
            }
        }
    }
}

/// Merges the hook into `<claude_dir>/settings.json` (backup first, idempotent).
/// `exe` is the absolute path of this binary. Returns true when the file changed.
pub fn install(claude_dir: &Path, exe: &Path) -> Result<bool> {
    settings::install(claude_dir, exe)
}

/// Removes only our hook entry. Returns true when the file changed.
pub fn uninstall(claude_dir: &Path) -> Result<bool> {
    settings::uninstall(claude_dir)
}

/// True when our hook entry is present and points at an existing binary.
pub fn is_installed(claude_dir: &Path) -> bool {
    settings::is_installed(claude_dir)
}
