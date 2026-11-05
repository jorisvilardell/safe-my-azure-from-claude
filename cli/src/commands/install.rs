//! install / uninstall / update / doctor / up / down. Owned by the "CLI install" issue.

use anyhow::{Result, bail};
use clap::Args;
use std::path::PathBuf;

#[derive(Debug, Args)]
pub struct InstallArgs {
    /// Use this contexts.yaml instead of the interactive wizard.
    #[arg(long)]
    pub contexts: Option<PathBuf>,
    /// Do not install the Claude Code hook (not recommended).
    #[arg(long)]
    pub no_hook: bool,
    /// Do not install the Claude Code skill.
    #[arg(long)]
    pub no_skill: bool,
    /// Answer yes to every prompt.
    #[arg(long, short)]
    pub yes: bool,
}

#[derive(Debug, Args)]
pub struct UninstallArgs {
    /// Also delete contexts.yaml and every file the CLI created.
    #[arg(long)]
    pub purge: bool,
}

#[derive(Debug, Args)]
pub struct UpdateArgs {
    /// Only check whether an update is available.
    #[arg(long)]
    pub check: bool,
}

pub fn install(_args: &InstallArgs) -> Result<()> {
    bail!("not implemented yet")
}

pub fn uninstall(_args: &UninstallArgs) -> Result<()> {
    bail!("not implemented yet")
}

pub fn update(_args: &UpdateArgs) -> Result<()> {
    bail!("not implemented yet")
}

pub fn doctor() -> Result<()> {
    bail!("not implemented yet")
}

pub fn up() -> Result<()> {
    bail!("not implemented yet")
}

pub fn down() -> Result<()> {
    bail!("not implemented yet")
}
