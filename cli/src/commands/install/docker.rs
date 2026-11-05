//! The server container: same hardening as `docker-compose.yml`, through `docker run`.

use super::runner::{Runner, argv};
use crate::paths::{CONTAINER, PORT};
use anyhow::{Result, bail};
use std::path::Path;

pub const DOCKER: &str = "docker";

/// Where the server reads its contexts file (Dockerfile `CONTEXTS_FILE`).
const CONTEXTS_IN_CONTAINER: &str = "/app/config/contexts.yaml";
/// uid of the `node` user the image runs as (Dockerfile `USER node`, uid 1000 in node:alpine).
const CONTAINER_UID: u32 = 1000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum State {
    Missing,
    Running { image: String },
    Stopped { image: String },
}

/// Docker CLI present and daemon reachable, with a fix hint otherwise.
pub fn check(run: &dyn Runner) -> Result<String> {
    if run.find(DOCKER).is_none() {
        bail!("{}", not_installed_hint());
    }
    let out = run.output(DOCKER, &argv(&["info", "--format", "{{.ServerVersion}}"]))?;
    // Some Docker versions exit 0 with `--format` when the daemon is down: an empty
    // ServerVersion is the reliable signal.
    let version = out.stdout.trim();
    if !out.success || version.is_empty() {
        bail!("{}", daemon_down_hint());
    }
    Ok(version.to_owned())
}

pub fn not_installed_hint() -> &'static str {
    if cfg!(windows) {
        "Docker is not installed. Install Docker Desktop (https://docs.docker.com/desktop/setup/install/windows-install/), start it, then run this command again."
    } else {
        "Docker is not installed. Install Docker Engine or Docker Desktop (https://docs.docker.com/engine/install/), then run this command again."
    }
}

pub fn daemon_down_hint() -> &'static str {
    if cfg!(windows) {
        "Docker is installed but its engine is not running. Start Docker Desktop, wait until it shows \"Engine running\" (it needs WSL 2: check `wsl --status`), then run this command again."
    } else {
        "Docker is installed but the daemon is not reachable. Start it (`sudo systemctl start docker`, or open Docker Desktop) and make sure your user may use it (the `docker` group), then run this command again."
    }
}

/// `docker run` argv: loopback-only port, read-only root, tmpfs, no capabilities, contexts read-only.
/// The server's env defaults (`LOG_LEVEL=info`, `AUDIT_LOG=stderr`, …) already match `docker-compose.yml`.
pub fn run_args(contexts: &Path, image: &str) -> Vec<String> {
    let mut args = argv(&[
        "run",
        "--name",
        CONTAINER,
        "-d",
        "--restart",
        "unless-stopped",
        "-p",
    ]);
    args.push(format!("127.0.0.1:{PORT}:{PORT}"));
    args.extend(argv(&["--read-only", "--tmpfs", "/tmp", "--tmpfs"]));
    args.push(format!("/run/safe-azure:mode=0700,uid={CONTAINER_UID}"));
    args.extend(argv(&[
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges:true",
        "-v",
    ]));
    args.push(format!("{}:{CONTEXTS_IN_CONTAINER}:ro", contexts.display()));
    args.push(image.to_owned());
    args
}

pub fn state(run: &dyn Runner) -> Result<State> {
    let out = run.output(
        DOCKER,
        &argv(&[
            "ps",
            "-a",
            "--filter",
            &format!("name=^{CONTAINER}$"),
            "--format",
            "{{.State}}\t{{.Image}}",
        ]),
    )?;
    if !out.success {
        bail!("`docker ps` failed: {}", out.stderr.trim());
    }
    let Some(line) = out.stdout.lines().find(|l| !l.trim().is_empty()) else {
        return Ok(State::Missing);
    };
    let (state, image) = line.split_once('\t').unwrap_or((line, ""));
    let image = image.trim().to_owned();
    Ok(if state.trim() == "running" {
        State::Running { image }
    } else {
        State::Stopped { image }
    })
}

pub fn pull(run: &dyn Runner, image: &str) -> Result<()> {
    if !run.status(DOCKER, &argv(&["pull", image]))? {
        bail!(
            "`docker pull {image}` failed. Check your network, or that this version was released."
        );
    }
    Ok(())
}

/// Removes the container. True when there was one.
pub fn remove(run: &dyn Runner) -> Result<bool> {
    let out = run.output(DOCKER, &argv(&["rm", "-f", CONTAINER]))?;
    if out.success {
        return Ok(true);
    }
    if out
        .stderr
        .to_ascii_lowercase()
        .contains("no such container")
    {
        return Ok(false);
    }
    bail!("`docker rm -f {CONTAINER}` failed: {}", out.stderr.trim());
}

pub fn create(run: &dyn Runner, contexts: &Path, image: &str) -> Result<()> {
    let out = run.output(DOCKER, &run_args(contexts, image))?;
    if !out.success {
        let hint = if out.stderr.contains("address already in use")
            || out.stderr.contains("port is already allocated")
        {
            format!(" Port {PORT} is taken: stop whatever uses it (an old docker compose stack?).")
        } else {
            String::new()
        };
        bail!("`docker run` failed: {}.{hint}", out.stderr.trim());
    }
    Ok(())
}

/// `docker rm -f` then `docker run` with the hardened flags.
pub fn recreate(run: &dyn Runner, contexts: &Path, image: &str) -> Result<()> {
    remove(run)?;
    create(run, contexts, image)
}

pub fn start(run: &dyn Runner) -> Result<()> {
    let out = run.output(DOCKER, &argv(&["start", CONTAINER]))?;
    if !out.success {
        bail!("`docker start {CONTAINER}` failed: {}", out.stderr.trim());
    }
    Ok(())
}

pub fn stop(run: &dyn Runner) -> Result<()> {
    let out = run.output(DOCKER, &argv(&["stop", CONTAINER]))?;
    if !out.success {
        bail!("`docker stop {CONTAINER}` failed: {}", out.stderr.trim());
    }
    Ok(())
}
