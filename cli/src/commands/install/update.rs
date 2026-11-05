//! Self-update (axoupdater + the cargo-dist install receipt), latest-release lookup and the
//! once-a-day "update available" notice.

use anyhow::{Context as _, Result};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::time::Duration;

/// App name cargo-dist writes the install receipt under (`<name>-receipt.json` in the config
/// dir). Seam with #63: change it here if the dist config picks another name.
pub const RECEIPT_APP_NAME: &str = "safe-azure";
/// GitHub "latest release" endpoint (prereleases excluded). Tags are `v<version>`.
pub const LATEST_RELEASE_API: &str =
    "https://api.github.com/repos/jorisvilardell/safe-my-azure-from-claude/releases/latest";
/// Disables the background notice (not `update --check` nor `doctor`).
pub const NO_UPDATE_CHECK_ENV: &str = "SAFE_AZURE_NO_UPDATE_CHECK";
/// Cache of the last notice check, in the config dir.
pub const NOTICE_CACHE_FILE: &str = "update-check.json";
const DAY_SECS: u64 = 24 * 60 * 60;

pub const CURRENT: &str = env!("CARGO_PKG_VERSION");

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SelfUpdate {
    /// A new binary was installed in place.
    Updated(String),
    UpToDate,
    /// No cargo-dist receipt (built from source, `cargo install`, npx…): the reason is printed.
    Unsupported(String),
}

/// Replaces this binary with the latest release, through the cargo-dist installer.
pub fn axo_self_update() -> Result<SelfUpdate> {
    let mut updater = axoupdater::AxoUpdater::new_for(RECEIPT_APP_NAME);
    if updater.load_receipt().is_err() {
        return Ok(SelfUpdate::Unsupported(
            "no install receipt found: this binary was not installed by the safe-azure installer. Reinstall it with the one-line installer from the README, or update it the way you installed it."
                .to_owned(),
        ));
    }
    if !updater
        .check_receipt_is_for_this_executable()
        .unwrap_or(false)
    {
        return Ok(SelfUpdate::Unsupported(
            "the install receipt belongs to another copy of safe-azure; run `safe-azure update` from that one, or reinstall."
                .to_owned(),
        ));
    }
    if let Ok(token) = std::env::var("SAFE_AZURE_GITHUB_TOKEN") {
        updater.set_github_token(&token);
    }
    match updater.run_sync().context("self-update failed")? {
        Some(result) => Ok(SelfUpdate::Updated(result.new_version.to_string())),
        None => Ok(SelfUpdate::UpToDate),
    }
}

#[derive(Deserialize)]
struct GithubRelease {
    tag_name: String,
}

/// Latest released version (`v1.2.3` → `1.2.3`), with a short timeout.
pub fn fetch_latest_release(timeout: Duration) -> Result<String> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(timeout))
        .build()
        .into();
    let release: GithubRelease = agent
        .get(LATEST_RELEASE_API)
        .header(
            "User-Agent",
            concat!("safe-azure/", env!("CARGO_PKG_VERSION")),
        )
        .header("Accept", "application/vnd.github+json")
        .call()
        .context("could not reach GitHub releases")?
        .body_mut()
        .read_json()
        .context("unexpected GitHub releases answer")?;
    Ok(release.tag_name.trim_start_matches('v').to_owned())
}

/// `1.2.3` (optionally `v`-prefixed, pre-release suffix ignored).
pub fn parse_version(v: &str) -> Option<(u64, u64, u64)> {
    let core = v.trim().trim_start_matches('v').split(['-', '+']).next()?;
    let mut parts = core.split('.').map(|p| p.parse::<u64>().ok());
    let version = (parts.next()??, parts.next()??, parts.next()??);
    parts.next().is_none().then_some(version)
}

pub fn is_newer(latest: &str, current: &str) -> bool {
    matches!((parse_version(latest), parse_version(current)), (Some(l), Some(c)) if l > c)
}

pub fn notice_text(latest: &str, current: &str) -> String {
    format!(
        "safe-azure {latest} is available (you have {current}). Run `safe-azure update` to update the CLI and the server together."
    )
}

#[derive(Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct NoticeCache {
    pub checked_at: u64,
    pub latest: Option<String>,
}

/// Checks GitHub at most once a day (the cache records the attempt, even a failed one) and
/// returns the notice to print, if a newer release exists.
pub fn notice(
    cache_path: &Path,
    now: u64,
    disabled: bool,
    current: &str,
    fetch: &dyn Fn() -> Result<String>,
) -> Option<String> {
    if disabled {
        return None;
    }
    let cached: Option<NoticeCache> = std::fs::read_to_string(cache_path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok());
    if cached.is_some_and(|c| now.saturating_sub(c.checked_at) < DAY_SECS && c.checked_at <= now) {
        return None;
    }
    let latest = fetch().ok();
    let cache = NoticeCache {
        checked_at: now,
        latest: latest.clone(),
    };
    if let Some(dir) = cache_path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(json) = serde_json::to_string(&cache) {
        let _ = std::fs::write(cache_path, json);
    }
    latest
        .filter(|l| is_newer(l, current))
        .map(|l| notice_text(&l, current))
}
