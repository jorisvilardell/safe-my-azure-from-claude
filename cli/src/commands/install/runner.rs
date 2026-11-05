//! External commands (`docker`, `claude`, re-exec of this binary) behind one trait, so tests can
//! assert the exact argv without running anything.

use anyhow::{Context as _, Result};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// Captured result of a command.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Output {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
}

pub trait Runner {
    /// Absolute path of `program` (PATH lookup, or the path itself when absolute).
    fn find(&self, program: &str) -> Option<PathBuf>;
    /// Runs with stdin closed and captures stdout/stderr.
    fn output(&self, program: &str, args: &[String]) -> Result<Output>;
    /// Runs attached to this terminal (progress bars, installer output). True on exit code 0.
    fn status(&self, program: &str, args: &[String]) -> Result<bool>;
}

/// `["a", "b"]` → `vec!["a".to_owned(), "b".to_owned()]`.
pub fn argv(parts: &[&str]) -> Vec<String> {
    parts.iter().map(|p| (*p).to_owned()).collect()
}

/// The real thing: `std::process::Command`, resolved through PATH (`which` handles `.exe`/`.cmd`).
pub struct System;

impl System {
    fn command(&self, program: &str) -> Result<Command> {
        let path = self
            .find(program)
            .with_context(|| format!("`{program}` was not found on PATH"))?;
        Ok(Command::new(path))
    }
}

impl Runner for System {
    fn find(&self, program: &str) -> Option<PathBuf> {
        let path = Path::new(program);
        if path.is_absolute() {
            return path.is_file().then(|| path.to_path_buf());
        }
        which::which(program).ok()
    }

    fn output(&self, program: &str, args: &[String]) -> Result<Output> {
        let out = self
            .command(program)?
            .args(args)
            .stdin(Stdio::null())
            .output()
            .with_context(|| format!("could not run `{program}`"))?;
        Ok(Output {
            success: out.status.success(),
            stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
        })
    }

    fn status(&self, program: &str, args: &[String]) -> Result<bool> {
        let status = self
            .command(program)?
            .args(args)
            .status()
            .with_context(|| format!("could not run `{program}`"))?;
        Ok(status.success())
    }
}
