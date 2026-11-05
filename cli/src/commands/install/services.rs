//! Seam to the modules owned by other issues (keys, server, hook, skill) and to the network,
//! so the install flows can be tested with fakes.

use super::update::{self, SelfUpdate};
use crate::commands::hook;
use crate::{keys, server, skill};
use anyhow::Result;
use std::path::Path;
use std::time::Duration;

pub trait Services {
    /// `GET /healthz` version, `None` when the server is not reachable.
    fn health(&self) -> Result<Option<String>>;
    /// Reads fresh keys from the container and caches them.
    fn fetch_keys(&self) -> Result<()>;
    /// Cached keys, or fetched ones: proves the CLI can talk to the admin API.
    fn keys_readable(&self) -> Result<()>;
    fn clear_keys(&self) -> Result<()>;
    fn skill_install(&self, claude_dir: &Path) -> Result<bool>;
    fn skill_uninstall(&self, claude_dir: &Path) -> Result<bool>;
    fn skill_current(&self, claude_dir: &Path) -> bool;
    fn hook_install(&self, claude_dir: &Path, exe: &Path) -> Result<bool>;
    fn hook_uninstall(&self, claude_dir: &Path) -> Result<bool>;
    fn hook_installed(&self, claude_dir: &Path) -> bool;
    /// Latest released version (network).
    fn latest_release(&self) -> Result<String>;
    fn self_update(&self) -> Result<SelfUpdate>;
    fn sleep(&self, duration: Duration);
}

pub struct Real;

impl Services for Real {
    fn health(&self) -> Result<Option<String>> {
        Ok(server::health()?.map(|h| h.version))
    }
    fn fetch_keys(&self) -> Result<()> {
        keys::fetch_from_container().map(drop)
    }
    fn keys_readable(&self) -> Result<()> {
        keys::get().map(drop)
    }
    fn clear_keys(&self) -> Result<()> {
        keys::clear_cache()
    }
    fn skill_install(&self, claude_dir: &Path) -> Result<bool> {
        skill::install(claude_dir)
    }
    fn skill_uninstall(&self, claude_dir: &Path) -> Result<bool> {
        skill::uninstall(claude_dir)
    }
    fn skill_current(&self, claude_dir: &Path) -> bool {
        skill::is_current(claude_dir)
    }
    fn hook_install(&self, claude_dir: &Path, exe: &Path) -> Result<bool> {
        hook::install(claude_dir, exe)
    }
    fn hook_uninstall(&self, claude_dir: &Path) -> Result<bool> {
        hook::uninstall(claude_dir)
    }
    fn hook_installed(&self, claude_dir: &Path) -> bool {
        hook::is_installed(claude_dir)
    }
    fn latest_release(&self) -> Result<String> {
        update::fetch_latest_release(Duration::from_secs(5))
    }
    fn self_update(&self) -> Result<SelfUpdate> {
        update::axo_self_update()
    }
    fn sleep(&self, duration: Duration) {
        std::thread::sleep(duration);
    }
}
