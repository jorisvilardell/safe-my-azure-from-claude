//! install / uninstall / update / doctor / up / down. Owned by the "CLI install" issue (#61).
//!
//! Every external effect goes through [`runner::Runner`] (docker, claude, re-exec) or
//! [`services::Services`] (keys, server, hook, skill, network), so the flows below are tested
//! with fakes.

mod claude;
mod contexts;
mod docker;
mod doctor;
mod runner;
mod services;
#[cfg(test)]
mod tests;
mod update;

use anyhow::{Context as _, Result, bail};
use clap::Args;
use runner::{Runner, argv};
use serde::{Deserialize, Serialize};
use services::Services;
use std::io::IsTerminal;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use update::SelfUpdate;

use crate::paths;
use docker::State;

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
    /// Internal: run by the freshly installed binary to finish the update.
    #[arg(long = "continue", hide = true)]
    pub continue_: bool,
}

/// Files and binaries the flows act on (temp dirs in tests).
#[derive(Debug, Clone)]
pub struct Paths {
    pub config_dir: PathBuf,
    pub contexts: PathBuf,
    pub claude_dir: PathBuf,
    /// Absolute path of this binary (what Claude Code and the hook launch).
    pub exe: PathBuf,
}

impl Paths {
    fn real() -> Result<Self> {
        Ok(Self {
            config_dir: paths::config_dir().context("cannot find the user config directory")?,
            contexts: paths::contexts_file().context("cannot find the user config directory")?,
            claude_dir: paths::claude_dir().context("cannot find the home directory")?,
            exe: std::env::current_exe().context("cannot find the path of this binary")?,
        })
    }
}

pub struct Ctx<'a> {
    pub run: &'a dyn Runner,
    pub svc: &'a dyn Services,
    pub paths: Paths,
}

/// What `install` was asked to set up, so `update` re-applies the same (`install.json`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Options {
    pub hook: bool,
    pub skill: bool,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            hook: true,
            skill: true,
        }
    }
}

const OPTIONS_FILE: &str = "install.json";

impl Options {
    fn load(config_dir: &Path) -> Self {
        std::fs::read_to_string(config_dir.join(OPTIONS_FILE))
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default()
    }

    fn save(self, config_dir: &Path) -> Result<()> {
        std::fs::create_dir_all(config_dir)?;
        std::fs::write(
            config_dir.join(OPTIONS_FILE),
            serde_json::to_string_pretty(&self)?,
        )?;
        Ok(())
    }
}

const LOGINS_LOST: &str = "! Recreating the server container: every in-memory Azure login is lost. Run `safe-azure login` afterwards.";

fn with_real<T>(f: impl FnOnce(&Ctx<'_>) -> Result<T>) -> Result<T> {
    let ctx = Ctx {
        run: &runner::System,
        svc: &services::Real,
        paths: Paths::real()?,
    };
    f(&ctx)
}

// ---------------------------------------------------------------------------------------------
// Entry points (main.rs)
// ---------------------------------------------------------------------------------------------

pub fn install(args: &InstallArgs) -> Result<()> {
    with_real(|ctx| {
        let interactive = std::io::stdin().is_terminal() && std::io::stdout().is_terminal();
        let stdin = std::io::stdin();
        let mut input = stdin.lock();
        let mut out = std::io::stdout();
        let mut prompt = contexts::Prompt {
            input: &mut input,
            out: &mut out,
        };
        install_with(ctx, args, interactive.then_some(&mut prompt))
    })
}

pub fn uninstall(args: &UninstallArgs) -> Result<()> {
    with_real(|ctx| uninstall_with(ctx, args))
}

pub fn update(args: &UpdateArgs) -> Result<()> {
    with_real(|ctx| update_with(ctx, args))
}

pub fn doctor() -> Result<()> {
    with_real(doctor_with)
}

pub fn up() -> Result<()> {
    with_real(up_with)
}

pub fn down() -> Result<()> {
    with_real(down_with)
}

/// Once-a-day "update available" notice on stderr. main.rs never calls it for `mcp` or `hook`.
pub fn notify_update_available() {
    let disabled = std::env::var(update::NO_UPDATE_CHECK_ENV).is_ok_and(|v| v == "1");
    let Some(dir) = paths::config_dir() else {
        return;
    };
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    let fetch = || update::fetch_latest_release(Duration::from_secs(2));
    if let Some(text) = update::notice(
        &dir.join(update::NOTICE_CACHE_FILE),
        now,
        disabled,
        update::CURRENT,
        &fetch,
    ) {
        eprintln!("{text}\n");
    }
}

// ---------------------------------------------------------------------------------------------
// Flows
// ---------------------------------------------------------------------------------------------

fn step(title: &str) {
    println!("\n» {title}");
}

/// Polls `/healthz` for up to ~60 s.
fn wait_healthy(ctx: &Ctx<'_>) -> Result<String> {
    for _ in 0..120 {
        if let Ok(Some(version)) = ctx.svc.health() {
            return Ok(version);
        }
        ctx.svc.sleep(Duration::from_millis(500));
    }
    bail!(
        "the server did not become healthy on {}. Check `docker ps` and the container output in Docker Desktop.",
        paths::base_url()
    )
}

/// Writes `contexts.yaml` (copy or wizard). Returns true when its content changed.
fn ensure_contexts(
    ctx: &Ctx<'_>,
    args: &InstallArgs,
    prompt: Option<&mut contexts::Prompt<'_>>,
) -> Result<bool> {
    let target = &ctx.paths.contexts;
    let existing = std::fs::read_to_string(target).ok();
    std::fs::create_dir_all(&ctx.paths.config_dir)?;

    if let Some(source) = &args.contexts {
        let text = std::fs::read_to_string(source)
            .with_context(|| format!("cannot read {}", source.display()))?;
        let file =
            contexts::parse(&text).with_context(|| format!("{} is invalid", source.display()))?;
        if existing.as_deref() == Some(text.as_str()) {
            println!(
                "  ✔ {} unchanged ({})",
                target.display(),
                contexts::summary(&file)
            );
            return Ok(false);
        }
        std::fs::write(target, &text)?;
        println!(
            "  ✔ copied to {} ({})",
            target.display(),
            contexts::summary(&file)
        );
        return Ok(true);
    }

    if let Some(text) = &existing {
        match contexts::parse(text) {
            Ok(file) => {
                println!(
                    "  ✔ keeping {} ({}). Edit it, or pass --contexts <file>, to change it.",
                    target.display(),
                    contexts::summary(&file)
                );
                return Ok(false);
            }
            Err(e) => println!(
                "  ✖ {} is invalid: {e}. Let's write a new one.",
                target.display()
            ),
        }
    }

    let Some(prompt) = prompt else {
        bail!(
            "no contexts.yaml yet and this is not an interactive terminal: run `safe-azure install` in a terminal, or pass --contexts <file> (see config/contexts.example.yaml)"
        );
    };
    let file = contexts::wizard(prompt)?;
    writeln!(prompt.out, "\n  {}", contexts::summary(&file))?;
    if !args.yes && !prompt.yes_no(&format!("Write {}? [Y/n] ", target.display()), true)? {
        bail!("cancelled: nothing written");
    }
    if existing.is_some() {
        std::fs::copy(target, target.with_extension("yaml.bak"))?;
    }
    std::fs::write(target, contexts::render(&file))?;
    println!("  ✔ wrote {}", target.display());
    Ok(true)
}

/// Container on this CLI's image. Keeps a healthy one (and its logins) unless `force`.
fn ensure_container(ctx: &Ctx<'_>, force: bool) -> Result<()> {
    let image = paths::image_ref();
    match docker::state(ctx.run)? {
        State::Running { image: current } if current == image && !force => {
            println!("  ✔ {} already running {image}", paths::CONTAINER);
            return Ok(());
        }
        State::Running { .. } => println!("  {LOGINS_LOST}"),
        State::Stopped { .. } | State::Missing => {}
    }
    docker::recreate(ctx.run, &ctx.paths.contexts, &image)?;
    println!(
        "  ✔ started {} ({image}) on 127.0.0.1:{} only, read-only, no capabilities",
        paths::CONTAINER,
        paths::PORT
    );
    Ok(())
}

/// Health, keys, MCP registration, skill and hook: the idempotent tail of install and update.
fn apply_client_setup(ctx: &Ctx<'_>, opts: Options) -> Result<()> {
    step("Waiting for the server");
    let version = wait_healthy(ctx)?;
    println!("  ✔ healthy (server {version})");
    ctx.svc
        .fetch_keys()
        .context("could not read the server keys")?;
    println!("  ✔ keys fetched and cached for this user");

    step("Registering the MCP server in Claude Code");
    match claude::register(ctx.run, &ctx.paths.exe)? {
        claude::Registration::Unchanged => {
            println!("  ✔ already registered as `{}`", paths::MCP_NAME);
        }
        claude::Registration::Registered => println!(
            "  ✔ registered `{}` (user scope): Claude Code launches `{} mcp`",
            paths::MCP_NAME,
            ctx.paths.exe.display()
        ),
        claude::Registration::NoClaude => {
            println!("  ! {}", claude::manual_instructions(&ctx.paths.exe));
        }
    }

    let claude_dir = &ctx.paths.claude_dir;
    if opts.skill {
        step("Installing the Claude Code skill");
        let changed = ctx.svc.skill_install(claude_dir)?;
        println!(
            "  ✔ {} {}",
            claude_dir.join("skills").join("safe-azure").display(),
            if changed {
                "written"
            } else {
                "already current"
            }
        );
    }
    if opts.hook {
        step("Installing the Claude Code hook");
        let changed = ctx.svc.hook_install(claude_dir, &ctx.paths.exe)?;
        println!(
            "  ✔ {} {}: the hook protects EVERY Claude Code project of this user, not just one",
            claude_dir.join("settings.json").display(),
            if changed {
                "updated (backup saved first)"
            } else {
                "already has the hook"
            }
        );
    }
    Ok(())
}

pub fn install_with(
    ctx: &Ctx<'_>,
    args: &InstallArgs,
    prompt: Option<&mut contexts::Prompt<'_>>,
) -> Result<()> {
    step("Checking Docker");
    let engine = docker::check(ctx.run)?;
    println!("  ✔ Docker engine {engine}");

    step("Azure contexts");
    let contexts_changed = ensure_contexts(ctx, args, prompt)?;

    step(&format!("Pulling {}", paths::image_ref()));
    docker::pull(ctx.run, &paths::image_ref())?;

    step("Starting the server");
    // A rewritten contexts.yaml is only seen by a new container (single-file bind mount).
    ensure_container(ctx, contexts_changed)?;

    let opts = Options {
        hook: !args.no_hook,
        skill: !args.no_skill,
    };
    opts.save(&ctx.paths.config_dir)?;
    apply_client_setup(ctx, opts)?;
    if args.no_hook {
        println!(
            "  ! --no-hook: nothing stops an agent from reaching credentials by other routes."
        );
    }

    step("Checking everything");
    doctor_with(ctx)?;
    println!("\nDone. Now sign in to Azure in your own terminal:\n    safe-azure login");
    Ok(())
}

pub fn uninstall_with(ctx: &Ctx<'_>, args: &UninstallArgs) -> Result<()> {
    let mut problems: Vec<String> = Vec::new();
    let mut note = |what: &str, r: Result<String>| match r {
        Ok(msg) => println!("  ✔ {what}: {msg}"),
        Err(e) => {
            println!("  ✖ {what}: {e:#}");
            problems.push(what.to_owned());
        }
    };

    note(
        "container",
        if ctx.run.find(docker::DOCKER).is_some() {
            docker::remove(ctx.run).map(|removed| {
                if removed {
                    "removed (logins dropped)"
                } else {
                    "none"
                }
                .to_owned()
            })
        } else {
            Ok("Docker not found, skipped".to_owned())
        },
    );
    note(
        "MCP registration",
        claude::unregister(ctx.run).map(|r| match r {
            Some(true) => "removed".to_owned(),
            Some(false) => "none".to_owned(),
            None => "Claude Code not found: remove `safe-azure` from your MCP clients yourself"
                .to_owned(),
        }),
    );
    let claude_dir = &ctx.paths.claude_dir;
    note(
        "hook",
        ctx.svc
            .hook_uninstall(claude_dir)
            .map(|c| if c { "removed" } else { "none" }.to_owned()),
    );
    note(
        "skill",
        ctx.svc
            .skill_uninstall(claude_dir)
            .map(|c| if c { "removed" } else { "none" }.to_owned()),
    );
    note(
        "key cache",
        ctx.svc.clear_keys().map(|()| "cleared".to_owned()),
    );

    for file in [OPTIONS_FILE, update::NOTICE_CACHE_FILE] {
        let _ = std::fs::remove_file(ctx.paths.config_dir.join(file));
    }
    if args.purge {
        note(
            "config",
            match std::fs::remove_dir_all(&ctx.paths.config_dir) {
                Ok(()) => Ok(format!("deleted {}", ctx.paths.config_dir.display())),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok("none".to_owned()),
                Err(e) => Err(e.into()),
            },
        );
    } else if ctx.paths.contexts.is_file() {
        println!(
            "  ✔ kept {} (run `safe-azure uninstall --purge` to delete it)",
            ctx.paths.contexts.display()
        );
    }
    println!(
        "  The image and this binary stay: `docker image rm {}` and delete the binary to finish.",
        paths::IMAGE
    );
    if !problems.is_empty() {
        bail!("uninstall incomplete: {}", problems.join(", "));
    }
    Ok(())
}

pub fn up_with(ctx: &Ctx<'_>) -> Result<()> {
    docker::check(ctx.run)?;
    match docker::state(ctx.run)? {
        State::Running { .. } => {
            println!("✔ {} is already running", paths::CONTAINER);
            return Ok(());
        }
        State::Stopped { .. } => docker::start(ctx.run)?,
        State::Missing => {
            if !ctx.paths.contexts.is_file() {
                bail!("no contexts.yaml yet: run `safe-azure install` first");
            }
            docker::create(ctx.run, &ctx.paths.contexts, &paths::image_ref())?;
        }
    }
    wait_healthy(ctx)?;
    ctx.svc
        .fetch_keys()
        .context("could not read the server keys")?;
    println!(
        "✔ {} is up. Sign in with `safe-azure login`.",
        paths::CONTAINER
    );
    Ok(())
}

pub fn down_with(ctx: &Ctx<'_>) -> Result<()> {
    docker::check(ctx.run)?;
    match docker::state(ctx.run)? {
        State::Missing => println!("✔ {} does not exist", paths::CONTAINER),
        State::Stopped { .. } => println!("✔ {} is already stopped", paths::CONTAINER),
        State::Running { .. } => {
            println!("! Stopping the server: every in-memory Azure login is lost.");
            docker::stop(ctx.run)?;
            println!("✔ stopped. `safe-azure up` starts it again.");
        }
    }
    // Keys rotate on every start: the cache is stale now.
    let _ = ctx.svc.clear_keys();
    Ok(())
}

pub fn update_with(ctx: &Ctx<'_>, args: &UpdateArgs) -> Result<()> {
    if args.check {
        let latest = ctx.svc.latest_release()?;
        if update::is_newer(&latest, update::CURRENT) {
            println!("{}", update::notice_text(&latest, update::CURRENT));
        } else {
            println!("safe-azure {} is the latest release.", update::CURRENT);
        }
        if let Ok(Some(server)) = ctx.svc.health() {
            println!(
                "Server: {server}{}",
                if server == update::CURRENT {
                    ""
                } else {
                    " (differs from the CLI: run `safe-azure update`)"
                }
            );
        }
        return Ok(());
    }

    if !args.continue_ {
        step("Updating the safe-azure binary");
        match ctx.svc.self_update()? {
            SelfUpdate::Updated(version) => {
                println!("  ✔ installed safe-azure {version}; it finishes the update");
                // The new binary knows its own image tag (version lock): let it do the rest.
                let exe = ctx.paths.exe.display().to_string();
                if !ctx.run.status(&exe, &argv(&["update", "--continue"]))? {
                    bail!(
                        "the new binary could not finish the update: run `safe-azure update` again"
                    );
                }
                return Ok(());
            }
            SelfUpdate::UpToDate => println!("  ✔ safe-azure {} is the latest", update::CURRENT),
            SelfUpdate::Unsupported(reason) => println!("  ! not self-updating: {reason}"),
        }
    }

    step("Checking Docker");
    docker::check(ctx.run)?;
    if !ctx.paths.contexts.is_file() {
        bail!("no contexts.yaml: run `safe-azure install` first");
    }
    step(&format!("Pulling {}", paths::image_ref()));
    docker::pull(ctx.run, &paths::image_ref())?;
    step("Restarting the server on the matching image");
    ensure_container(ctx, false)?;
    apply_client_setup(ctx, Options::load(&ctx.paths.config_dir))?;
    step("Checking everything");
    doctor_with(ctx)
}

pub fn doctor_with(ctx: &Ctx<'_>) -> Result<()> {
    let checks = doctor::run(ctx);
    doctor::print(&checks);
    match doctor::failures(&checks) {
        0 => Ok(()),
        n => bail!("doctor found {n} problem(s): see the fix hints above"),
    }
}
