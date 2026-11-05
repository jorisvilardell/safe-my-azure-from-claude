//! Well-known paths: the CLI config dir (contexts.yaml, key cache) and Claude Code files.
//! Shared by every command; keep it small.

use std::path::PathBuf;

/// `%APPDATA%\safe-azure` on Windows, `~/.config/safe-azure` elsewhere.
#[allow(dead_code)]
pub fn config_dir() -> Option<PathBuf> {
    dirs::config_dir().map(|d| d.join("safe-azure"))
}

/// `~/.claude`, where Claude Code keeps user-level settings and skills.
#[allow(dead_code)]
pub fn claude_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|d| d.join(".claude"))
}
