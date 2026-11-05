//! Well-known names and paths shared by every command. Keep it small (ADR 0001).
#![allow(dead_code)]

use std::path::PathBuf;

/// Docker container name of the server.
pub const CONTAINER: &str = "azure-safe-mcp";
/// Server image; the tag is always the CLI version (version lock, ADR 0001 §7).
pub const IMAGE: &str = "ghcr.io/jorisvilardell/safe-my-azure-from-claude";
/// Port published on 127.0.0.1 only.
pub const PORT: u16 = 8765;
/// Keys file inside the container (tmpfs, mode 0600).
pub const KEYS_PATH_IN_CONTAINER: &str = "/run/safe-azure/keys.json";
/// MCP server name registered in Claude Code.
pub const MCP_NAME: &str = "safe-azure";

/// Image reference pinned to this CLI build.
pub fn image_ref() -> String {
    format!("{IMAGE}:{}", env!("CARGO_PKG_VERSION"))
}

/// `http://127.0.0.1:8765`.
pub fn base_url() -> String {
    format!("http://127.0.0.1:{PORT}")
}

/// `%APPDATA%\safe-azure` on Windows, `~/.config/safe-azure` elsewhere.
pub fn config_dir() -> Option<PathBuf> {
    dirs::config_dir().map(|d| d.join("safe-azure"))
}

/// `contexts.yaml` mounted read-only into the container.
pub fn contexts_file() -> Option<PathBuf> {
    config_dir().map(|d| d.join("contexts.yaml"))
}

/// Encrypted key cache (DPAPI on Windows).
pub fn keys_cache() -> Option<PathBuf> {
    config_dir().map(|d| d.join("keys.bin"))
}

/// `~/.claude`, where Claude Code keeps user-level settings and skills.
pub fn claude_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|d| d.join(".claude"))
}
