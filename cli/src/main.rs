//! `safe-azure`: installs and drives the safe-my-azure-from-claude MCP server.
//!
//! Module ownership (one issue per area, see `cli/README.md`):
//! - `commands::login`   – login / logout / status / use, over the admin API (TTY only)
//! - `commands::bridge`  – `safe-azure mcp`: stdio ⇄ Streamable HTTP bridge for MCP clients
//! - `commands::install` – install / uninstall / update / doctor / up / down
//! - `commands::hook`    – `safe-azure hook claude`: Claude Code `PreToolUse` guard
//! - `keys`, `server`, `paths` – shared building blocks

mod commands;
mod keys;
mod paths;
mod server;
mod skill;

use clap::{Parser, Subcommand};

#[derive(Debug, Parser)]
#[command(name = "safe-azure", version, about, propagate_version = true)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Install everything: server container, MCP registration, skill and Claude Code hook.
    Install(commands::install::InstallArgs),
    /// Remove the container, MCP registration, skill and hook (keeps contexts.yaml unless --purge).
    Uninstall(commands::install::UninstallArgs),
    /// Update the CLI, the server image (same version) and re-apply hook, skill and registration.
    Update(commands::install::UpdateArgs),
    /// Check Docker, container health, versions, keys, hook and MCP registration.
    Doctor,
    /// Start the server container.
    Up,
    /// Stop the server container (drops every in-memory login).
    Down,
    /// Sign in to a context with the Microsoft device-code flow (interactive terminal only).
    Login(commands::login::LoginArgs),
    /// Drop the in-memory credential of a context.
    Logout(commands::login::ContextArg),
    /// Show contexts and login state.
    Status,
    /// Switch the active context.
    Use(commands::login::ContextArg),
    /// Run the MCP stdio bridge (what MCP clients launch).
    Mcp,
    /// Hook entry points (called by Claude Code, not by humans).
    #[command(subcommand)]
    Hook(commands::hook::HookCommand),
}

fn main() -> std::process::ExitCode {
    let cli = Cli::parse();
    let result = match cli.command {
        Command::Install(args) => commands::install::install(&args),
        Command::Uninstall(args) => commands::install::uninstall(&args),
        Command::Update(args) => commands::install::update(&args),
        Command::Doctor => commands::install::doctor(),
        Command::Up => commands::install::up(),
        Command::Down => commands::install::down(),
        Command::Login(args) => commands::login::login(&args),
        Command::Logout(args) => commands::login::logout(&args),
        Command::Status => commands::login::status(),
        Command::Use(args) => commands::login::use_context(&args),
        Command::Mcp => commands::bridge::run(),
        // The hook decides its own exit code (Claude Code reads it), so it returns early.
        Command::Hook(cmd) => return commands::hook::run(&cmd),
    };
    match result {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("error: {err:#}");
            std::process::ExitCode::FAILURE
        }
    }
}
