//! `safe-azure doctor`: every check with ✔ / ! / ✖ and a fix hint. Never prints an ID or a key.

use super::docker::{self, State};
use super::update::{CURRENT, is_newer};
use super::{Ctx, Options, claude, contexts};
use crate::paths;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Level {
    Ok,
    /// Worth knowing, not broken (newer release, Claude Code not installed…).
    Warn,
    Fail,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Check {
    pub level: Level,
    pub name: &'static str,
    pub detail: String,
    pub hint: Option<String>,
}

fn check(level: Level, name: &'static str, detail: impl Into<String>, hint: Option<&str>) -> Check {
    Check {
        level,
        name,
        detail: detail.into(),
        hint: hint.map(str::to_owned),
    }
}

use Level::{Fail, Ok as Pass, Warn};

pub fn run(ctx: &Ctx<'_>) -> Vec<Check> {
    let mut checks = Vec::new();
    server_checks(ctx, &mut checks);
    client_checks(ctx, &mut checks);
    checks
}

/// Docker, container, versions and keys.
fn server_checks(ctx: &Ctx<'_>, checks: &mut Vec<Check>) {
    let docker_ok = match docker::check(ctx.run) {
        Ok(version) => {
            checks.push(check(
                Pass,
                "Docker",
                format!("running (engine {version})"),
                None,
            ));
            true
        }
        Err(e) => {
            checks.push(check(Fail, "Docker", "not available", Some(&e.to_string())));
            false
        }
    };
    let expected = paths::image_ref();
    let mut healthy = false;
    if docker_ok {
        match docker::state(ctx.run) {
            Ok(State::Running { image }) => {
                let version = ctx.svc.health().ok().flatten();
                healthy = version.is_some();
                checks.push(if healthy {
                    check(Pass, "Container", format!("{} running and healthy", paths::CONTAINER), None)
                } else {
                    check(
                        Fail,
                        "Container",
                        format!("running but /healthz does not answer on {}", paths::base_url()),
                        Some("wait a few seconds, or `safe-azure up` / `safe-azure install` to recreate it"),
                    )
                });
                if image != expected {
                    checks.push(check(
                        Fail,
                        "Image",
                        format!("container runs {image}, this CLI expects {expected}"),
                        Some("safe-azure update"),
                    ));
                }
                if let Some(server) = version {
                    checks.push(if server == CURRENT {
                        check(
                            Pass,
                            "Versions",
                            format!("CLI and server are both {CURRENT}"),
                            None,
                        )
                    } else {
                        check(
                            Fail,
                            "Versions",
                            format!("CLI {CURRENT}, server {server}"),
                            Some("safe-azure update"),
                        )
                    });
                }
            }
            Ok(State::Stopped { .. }) => checks.push(check(
                Fail,
                "Container",
                format!("{} is stopped", paths::CONTAINER),
                Some("safe-azure up"),
            )),
            Ok(State::Missing) => checks.push(check(
                Fail,
                "Container",
                format!("{} does not exist", paths::CONTAINER),
                Some("safe-azure install"),
            )),
            Err(e) => checks.push(check(
                Fail,
                "Container",
                e.to_string(),
                Some("safe-azure install"),
            )),
        }
    }

    if healthy {
        checks.push(match ctx.svc.keys_readable() {
            Ok(()) => check(Pass, "Keys", "readable", None),
            Err(_) => check(
                Fail,
                "Keys",
                "cannot read the server keys",
                Some("safe-azure up"),
            ),
        });
    }
}

/// MCP registration, skill, hook, contexts.yaml and releases.
fn client_checks(ctx: &Ctx<'_>, checks: &mut Vec<Check>) {
    let opts = Options::load(&ctx.paths.config_dir);
    checks.push(match claude::is_registered(ctx.run, &ctx.paths.exe) {
        Ok(Some(true)) => check(
            Pass,
            "MCP",
            format!("registered in Claude Code as `{}`", paths::MCP_NAME),
            None,
        ),
        Ok(Some(false)) => check(
            Fail,
            "MCP",
            "not registered in Claude Code (or for another binary)",
            Some("safe-azure install"),
        ),
        Ok(None) => check(
            Warn,
            "MCP",
            "Claude Code not on PATH: registration not checked",
            Some(&claude::manual_instructions(&ctx.paths.exe)),
        ),
        Err(e) => check(Fail, "MCP", e.to_string(), Some("safe-azure install")),
    });

    checks.push(if !opts.skill {
        check(Warn, "Skill", "skipped (installed with --no-skill)", None)
    } else if ctx.svc.skill_current(&ctx.paths.claude_dir) {
        check(Pass, "Skill", "installed and current", None)
    } else {
        check(
            Fail,
            "Skill",
            "missing or outdated",
            Some("safe-azure install"),
        )
    });

    checks.push(if !opts.hook {
        check(
            Warn,
            "Hook",
            "skipped (installed with --no-hook): agents are not blocked from credentials",
            Some("safe-azure install"),
        )
    } else if ctx.svc.hook_installed(&ctx.paths.claude_dir) {
        check(
            Pass,
            "Hook",
            "installed, guards every Claude Code project",
            None,
        )
    } else {
        check(Fail, "Hook", "not installed", Some("safe-azure install"))
    });

    checks.push(if ctx.paths.contexts.is_file() {
        match contexts::load(&ctx.paths.contexts) {
            Ok(file) => check(Pass, "contexts.yaml", contexts::summary(&file), None),
            Err(e) => check(
                Fail,
                "contexts.yaml",
                e.to_string(),
                Some("fix the file, or `safe-azure install --contexts <file>`"),
            ),
        }
    } else {
        check(Fail, "contexts.yaml", "missing", Some("safe-azure install"))
    });

    checks.push(match ctx.svc.latest_release() {
        Ok(latest) if is_newer(&latest, CURRENT) => check(
            Warn,
            "Release",
            format!("{latest} is available (you have {CURRENT})"),
            Some("safe-azure update"),
        ),
        Ok(_) => check(Pass, "Release", format!("{CURRENT} is the latest"), None),
        Err(_) => check(Warn, "Release", "could not check GitHub releases", None),
    });
}

pub fn print(checks: &[Check]) {
    for c in checks {
        let mark = match c.level {
            Pass => "✔",
            Warn => "!",
            Fail => "✖",
        };
        println!("  {mark} {:<14} {}", c.name, c.detail);
        if let Some(hint) = &c.hint {
            for (i, line) in hint.lines().enumerate() {
                let prefix = if i == 0 { "fix:" } else { "    " };
                println!("      {prefix} {line}");
            }
        }
    }
}

pub fn failures(checks: &[Check]) -> usize {
    checks.iter().filter(|c| c.level == Fail).count()
}
