//! MCP and admin keys: fetched from the container, cached encrypted (DPAPI on Windows).
//! Owned by the "CLI core" issue (#60). Signatures are a contract used by other modules.
#![allow(dead_code)]

use anyhow::{Result, bail};

/// The two server keys (ADR 0001 §1). Never print or log them.
#[derive(Clone, PartialEq, Eq)]
pub struct Keys {
    pub mcp: String,
    pub admin: String,
}

impl std::fmt::Debug for Keys {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Keys { .. }")
    }
}

/// Reads the keys from the running container (`docker exec … cat`), then caches them.
pub fn fetch_from_container() -> Result<Keys> {
    bail!("not implemented yet")
}

/// Cached keys, if any (decrypted).
pub fn load_cached() -> Result<Option<Keys>> {
    bail!("not implemented yet")
}

/// Cached keys, or freshly fetched ones when the cache is missing.
pub fn get() -> Result<Keys> {
    bail!("not implemented yet")
}

/// Deletes the cache (uninstall, or after a 401 before re-fetching).
pub fn clear_cache() -> Result<()> {
    bail!("not implemented yet")
}
