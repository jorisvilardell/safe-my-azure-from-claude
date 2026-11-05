//! `safe-azure mcp`: stdio ⇄ Streamable HTTP bridge. Owned by the "CLI core" issue.
//!
//! MCP clients launch this; it adds the MCP bearer key itself, so the key never sits in a
//! client config file.

use anyhow::{Result, bail};

pub fn run() -> Result<()> {
    bail!("not implemented yet")
}
