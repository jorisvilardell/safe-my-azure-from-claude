//! MCP and admin keys: fetched from the container, cached encrypted (DPAPI on Windows).
//! Owned by the "CLI core" issue (#60). Signatures are a contract used by other modules.
//!
//! Keys never appear in output or errors: `Debug` is redacted and every parse error is replaced
//! by a fixed message (serde errors can quote the offending value).
#![allow(dead_code)]

#[cfg(windows)]
mod dpapi;

use crate::paths;
use anyhow::{Context, Result, anyhow, bail};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{self, Write};
use std::path::Path;
use std::process::{Command, Stdio};

/// The two server keys (ADR 0001 §1). Never print or log them.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
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
    // No shell: fixed program and arguments.
    let output = Command::new("docker")
        .args([
            "exec",
            paths::CONTAINER,
            "cat",
            paths::KEYS_PATH_IN_CONTAINER,
        ])
        .stdin(Stdio::null())
        .output()
        .map_err(|err| {
            anyhow!("could not run `docker` ({err}); is Docker installed and on PATH?")
        })?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let reason: String = stderr
            .lines()
            .next()
            .unwrap_or("")
            .trim()
            .chars()
            .take(200)
            .collect();
        bail!(
            "could not read the server keys from container `{}` ({reason}); is it running? Try `safe-azure up`",
            paths::CONTAINER
        );
    }
    let keys = parse(&output.stdout)?;
    if let Err(err) = store(&keys) {
        eprintln!("warning: could not cache the server keys: {err:#}");
    }
    Ok(keys)
}

/// Cached keys, if any (decrypted).
pub fn load_cached() -> Result<Option<Keys>> {
    match paths::keys_cache() {
        Some(path) => load_from(&path),
        None => Ok(None),
    }
}

/// Cached keys, or freshly fetched ones when the cache is missing.
pub fn get() -> Result<Keys> {
    // An unreadable cache (other user, corrupted file) is simply replaced.
    if let Ok(Some(keys)) = load_cached() {
        return Ok(keys);
    }
    fetch_from_container()
}

/// Drops the cache and fetches the keys again (after a 401: the container restarted).
pub fn refresh() -> Result<Keys> {
    clear_cache()?;
    fetch_from_container()
}

/// Deletes the cache (uninstall, or after a 401 before re-fetching).
pub fn clear_cache() -> Result<()> {
    let Some(path) = paths::keys_cache() else {
        return Ok(());
    };
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err).with_context(|| format!("could not delete {}", path.display())),
    }
}

/// Parses `keys.json` (`{"mcp": "…", "admin": "…"}`).
fn parse(bytes: &[u8]) -> Result<Keys> {
    let keys: Keys =
        serde_json::from_slice(bytes).map_err(|_| anyhow!("the server keys are malformed"))?;
    // They end up in an HTTP header: printable ASCII only.
    let valid = |k: &str| !k.is_empty() && k.bytes().all(|b| b.is_ascii_graphic());
    if !valid(&keys.mcp) || !valid(&keys.admin) {
        bail!("the server keys are malformed");
    }
    Ok(keys)
}

fn store(keys: &Keys) -> Result<()> {
    let path = paths::keys_cache().context("no config directory for the key cache")?;
    store_to(&path, keys)
}

fn store_to(path: &Path, keys: &Keys) -> Result<()> {
    let json = serde_json::to_vec(keys).map_err(|_| anyhow!("could not encode the key cache"))?;
    write_private(path, &seal(&json)?)
}

fn load_from(path: &Path) -> Result<Option<Keys>> {
    let sealed = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(err).with_context(|| format!("could not read {}", path.display())),
    };
    let plain = unseal(&sealed)?;
    parse(&plain)
        .map(Some)
        .map_err(|_| anyhow!("the key cache is corrupted"))
}

#[cfg(windows)]
fn seal(plain: &[u8]) -> Result<Vec<u8>> {
    dpapi::protect(plain)
}

#[cfg(windows)]
fn unseal(sealed: &[u8]) -> Result<Vec<u8>> {
    dpapi::unprotect(sealed)
}

// Elsewhere the protection is the 0600 file mode (ADR 0001 §1).
#[cfg(not(windows))]
#[allow(clippy::unnecessary_wraps)]
fn seal(plain: &[u8]) -> Result<Vec<u8>> {
    Ok(plain.to_vec())
}

#[cfg(not(windows))]
#[allow(clippy::unnecessary_wraps)]
fn unseal(sealed: &[u8]) -> Result<Vec<u8>> {
    Ok(sealed.to_vec())
}

/// Writes `bytes` atomically to `path`, readable by the current user only (0600 on Unix).
fn write_private(path: &Path, bytes: &[u8]) -> Result<()> {
    let dir = path.parent().context("key cache path has no parent")?;
    create_private_dir(dir).with_context(|| format!("could not create {}", dir.display()))?;
    let tmp = path.with_extension("tmp");
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let write = || -> io::Result<()> {
        let mut file = options.open(&tmp)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(fs::Permissions::from_mode(0o600))?;
        }
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&tmp, path)
    };
    write().with_context(|| format!("could not write {}", path.display()))
}

fn create_private_dir(dir: &Path) -> io::Result<()> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Keys {
        Keys {
            mcp: "mcp-key-0123456789abcdef".into(),
            admin: "admin-key-0123456789abcdef".into(),
        }
    }

    #[test]
    fn debug_is_redacted() {
        let shown = format!("{:?}", sample());
        assert_eq!(shown, "Keys { .. }");
    }

    #[test]
    fn parses_keys_json() -> Result<()> {
        let keys = parse(br#"{"mcp":"m1","admin":"a1","extra":1}"#)?;
        assert_eq!(keys.mcp, "m1");
        assert_eq!(keys.admin, "a1");
        Ok(())
    }

    #[test]
    fn parse_errors_never_quote_the_input() {
        for bad in [
            &br#"{"mcp":"secret-value-1","admin":42}"#[..],
            br#"{"mcp":"secret-value-1","admin":""}"#,
            br#"{"mcp":"secret value 1","admin":"x"}"#,
            b"secret-value-1",
        ] {
            let err = parse(bad)
                .err()
                .map(|e| format!("{e:#}"))
                .unwrap_or_default();
            assert!(err.contains("malformed"), "{err}");
            assert!(!err.contains("secret"), "{err}");
        }
    }

    #[test]
    fn cache_round_trip() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let path = dir.path().join("nested").join("keys.bin");
        assert!(load_from(&path)?.is_none());

        store_to(&path, &sample())?;
        assert_eq!(load_from(&path)?, Some(sample()));

        // Overwrite works (atomic rename over an existing file).
        let other = Keys {
            mcp: "m2".into(),
            admin: "a2".into(),
        };
        store_to(&path, &other)?;
        assert_eq!(load_from(&path)?, Some(other));
        Ok(())
    }

    #[cfg(windows)]
    #[test]
    fn cache_is_encrypted_with_dpapi() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let path = dir.path().join("keys.bin");
        store_to(&path, &sample())?;
        let raw = fs::read(&path)?;
        let needle = sample().mcp.into_bytes();
        assert!(!raw.windows(needle.len()).any(|w| w == needle.as_slice()));
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn cache_file_is_mode_0600() -> Result<()> {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir()?;
        let path = dir.path().join("keys.bin");
        store_to(&path, &sample())?;
        let mode = fs::metadata(&path)?.permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        Ok(())
    }

    #[test]
    fn corrupted_cache_is_an_error_without_content() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let path = dir.path().join("keys.bin");
        fs::write(&path, b"secret-garbage")?;
        let err = load_from(&path)
            .err()
            .map(|e| format!("{e:#}"))
            .unwrap_or_default();
        assert_ne!(err, "");
        assert!(!err.contains("secret"), "{err}");
        Ok(())
    }
}
