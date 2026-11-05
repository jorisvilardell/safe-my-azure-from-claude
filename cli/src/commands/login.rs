//! login / logout / status / use, over the server's admin API. Owned by the "CLI core" issue.

use anyhow::{Result, bail};
use clap::Args;

#[derive(Debug, Args)]
pub struct LoginArgs {
    /// Context alias from contexts.yaml (defaults to the active context).
    pub context: Option<String>,
    /// Do not open the browser automatically.
    #[arg(long)]
    pub no_browser: bool,
}

#[derive(Debug, Args)]
pub struct ContextArg {
    /// Context alias from contexts.yaml.
    pub context: String,
}

pub fn login(_args: &LoginArgs) -> Result<()> {
    bail!("not implemented yet")
}

pub fn logout(_args: &ContextArg) -> Result<()> {
    bail!("not implemented yet")
}

pub fn status() -> Result<()> {
    bail!("not implemented yet")
}

pub fn use_context(_args: &ContextArg) -> Result<()> {
    bail!("not implemented yet")
}
