//! Global Claude Code skill (`~/.claude/skills/safe-azure/SKILL.md`). Owned by the
//! "hook + skill" issue (#62). Signatures are a contract used by the install command.
#![allow(dead_code)]

use anyhow::{Result, bail};
use std::path::Path;

/// Writes or updates the skill under `claude_dir`. Returns true when something changed.
pub fn install(_claude_dir: &Path) -> Result<bool> {
    bail!("not implemented yet")
}

/// Removes the skill. Returns true when something was removed.
pub fn uninstall(_claude_dir: &Path) -> Result<bool> {
    bail!("not implemented yet")
}

/// True when the installed skill matches this CLI version.
pub fn is_current(_claude_dir: &Path) -> bool {
    false
}
