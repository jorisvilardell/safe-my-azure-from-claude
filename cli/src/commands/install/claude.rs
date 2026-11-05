//! MCP registration in Claude Code (`claude mcp add --scope user`), ADR 0001 §4.

use super::runner::{Runner, argv};
use crate::paths::MCP_NAME;
use anyhow::{Result, bail};
use std::path::Path;

pub const CLAUDE: &str = "claude";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Registration {
    /// Already registered with this binary: nothing changed.
    Unchanged,
    /// Added or replaced.
    Registered,
    /// `claude` is not on PATH: the user must do it (see [`manual_instructions`]).
    NoClaude,
}

pub fn add_args(exe: &Path) -> Vec<String> {
    let mut args = argv(&["mcp", "add", "--scope", "user", MCP_NAME, "--"]);
    args.push(exe.display().to_string());
    args.push("mcp".to_owned());
    args
}

pub fn remove_args() -> Vec<String> {
    argv(&["mcp", "remove", "--scope", "user", MCP_NAME])
}

fn quoted(exe: &Path) -> String {
    let s = exe.display().to_string();
    if s.contains(' ') {
        format!("\"{s}\"")
    } else {
        s
    }
}

pub fn manual_instructions(exe: &Path) -> String {
    format!(
        "Claude Code (`claude`) is not on PATH. Register the server yourself:\n    \
         claude mcp add --scope user {MCP_NAME} -- {} mcp\n  \
         Other MCP clients: add a stdio server whose command is {} with the single argument `mcp`.\n  \
         No key goes in the client config: `safe-azure mcp` adds it itself.",
        quoted(exe),
        quoted(exe)
    )
}

/// `None` when `claude` is missing; otherwise whether our entry exists and launches `exe`.
pub fn is_registered(run: &dyn Runner, exe: &Path) -> Result<Option<bool>> {
    if run.find(CLAUDE).is_none() {
        return Ok(None);
    }
    let out = run.output(CLAUDE, &argv(&["mcp", "get", MCP_NAME]))?;
    Ok(Some(
        out.success && out.stdout.contains(&exe.display().to_string()),
    ))
}

/// Adds the entry, replacing any older one (idempotent).
pub fn register(run: &dyn Runner, exe: &Path) -> Result<Registration> {
    match is_registered(run, exe)? {
        None => return Ok(Registration::NoClaude),
        Some(true) => return Ok(Registration::Unchanged),
        Some(false) => {}
    }
    // An older entry (other path, other scope) would make `add` fail: drop it first.
    run.output(CLAUDE, &remove_args())?;
    let out = run.output(CLAUDE, &add_args(exe))?;
    if !out.success {
        bail!("`claude mcp add` failed: {}", out.stderr.trim());
    }
    Ok(Registration::Registered)
}

/// `None` when `claude` is missing; otherwise whether an entry was removed.
pub fn unregister(run: &dyn Runner) -> Result<Option<bool>> {
    if run.find(CLAUDE).is_none() {
        return Ok(None);
    }
    Ok(Some(run.output(CLAUDE, &remove_args())?.success))
}
