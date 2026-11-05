//! login / logout / status / use, over the server's admin API. Owned by the "CLI core" issue.

use crate::server::{Admin, ContextStatus, State};
use anyhow::{Result, bail};
use clap::Args;
use std::io::{self, IsTerminal, Write};
use std::thread;
use std::time::{Duration, Instant};

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

const POLL_EVERY: Duration = Duration::from_secs(2);
/// Device codes last 15 minutes; stop waiting a bit after that even if the server never says so.
const GIVE_UP_AFTER: Duration = Duration::from_secs(20 * 60);

pub fn login(args: &LoginArgs) -> Result<()> {
    // First, before touching Docker or the server: agent shells are not terminals (ADR 0001 §3).
    ensure_interactive(io::stdin().is_terminal(), io::stdout().is_terminal())?;

    let admin = Admin::connect()?;
    let context = match &args.context {
        Some(context) => context.clone(),
        None => active_context(&admin.contexts()?)?,
    };
    let start = admin.start_login(&context)?;

    println!("To sign in to `{}`, open:\n", start.context);
    println!("    {}\n", start.verification_uri);
    println!("and enter the code:\n");
    println!("    {}\n", start.user_code);
    println!("The code expires at {}.", start.expires_at);
    if !args.no_browser {
        // Only open real web pages, never another scheme the server might send.
        if start.verification_uri.starts_with("https://")
            && open::that_detached(&start.verification_uri).is_ok()
        {
            println!("Your browser has been opened.");
        } else {
            println!("Could not open a browser: open the address above yourself.");
        }
    }
    println!("Press Ctrl-C to cancel.\n");

    let mut spinner = Spinner::default();
    let state = wait_for_login(
        || admin.login_state(&context),
        POLL_EVERY,
        GIVE_UP_AFTER,
        || spinner.tick(),
    );
    spinner.clear();
    match state? {
        State::Succeeded => {
            println!("Signed in to `{context}`.");
            Ok(())
        }
        State::Failed => {
            bail!("sign-in to `{context}` failed; run `safe-azure login {context}` to try again")
        }
        State::Expired => bail!("the code expired; run `safe-azure login {context}` to try again"),
        State::Pending => bail!("sign-in to `{context}` timed out"),
    }
}

pub fn logout(args: &ContextArg) -> Result<()> {
    Admin::connect()?.logout(&args.context)?;
    println!("Logged out of `{}`.", args.context);
    Ok(())
}

pub fn status() -> Result<()> {
    let rows = Admin::connect()?.contexts()?;
    print!("{}", render_status(&rows));
    Ok(())
}

pub fn use_context(args: &ContextArg) -> Result<()> {
    Admin::connect()?.use_context(&args.context)?;
    println!("Active context: `{}`.", args.context);
    Ok(())
}

fn ensure_interactive(stdin_tty: bool, stdout_tty: bool) -> Result<()> {
    if stdin_tty && stdout_tty {
        return Ok(());
    }
    bail!(
        "`safe-azure login` must be run by a human, in their own interactive terminal \
         (stdin and stdout must both be a terminal). If an AI agent asked you to sign in, \
         open a terminal yourself and run `safe-azure login <context>` there."
    )
}

fn active_context(rows: &[ContextStatus]) -> Result<String> {
    match rows.iter().find(|r| r.active) {
        Some(row) => Ok(row.alias.clone()),
        None => {
            bail!("no active context; run `safe-azure login <context>` (see `safe-azure status`)")
        }
    }
}

/// Polls `state` every `every` until it leaves `Pending`, or `give_up` elapses (then `Pending`).
/// Three failed polls in a row abort. `tick` runs about four times a second meanwhile.
fn wait_for_login(
    mut state: impl FnMut() -> Result<State>,
    every: Duration,
    give_up: Duration,
    mut tick: impl FnMut(),
) -> Result<State> {
    let deadline = Instant::now() + give_up;
    let mut errors = 0;
    loop {
        match state() {
            Ok(State::Pending) => errors = 0,
            Ok(done) => return Ok(done),
            Err(err) => {
                errors += 1;
                if errors >= 3 {
                    return Err(err);
                }
            }
        }
        if Instant::now() >= deadline {
            return Ok(State::Pending);
        }
        let until = Instant::now() + every;
        loop {
            tick();
            let left = until.saturating_duration_since(Instant::now());
            if left.is_zero() {
                break;
            }
            thread::sleep(left.min(Duration::from_millis(250)));
        }
    }
}

#[derive(Default)]
struct Spinner {
    frame: usize,
}

impl Spinner {
    fn tick(&mut self) {
        const FRAMES: [char; 4] = ['|', '/', '-', '\\'];
        let frame = FRAMES[self.frame % FRAMES.len()];
        self.frame += 1;
        let mut out = io::stdout().lock();
        let _ = write!(
            out,
            "\rWaiting for you to finish signing in in the browser {frame} "
        );
        let _ = out.flush();
    }

    fn clear(&self) {
        if self.frame > 0 {
            let mut out = io::stdout().lock();
            let _ = write!(out, "\r{:60}\r", "");
            let _ = out.flush();
        }
    }
}

fn render_status(rows: &[ContextStatus]) -> String {
    use std::fmt::Write as _;
    if rows.is_empty() {
        return "No contexts configured: add one to contexts.yaml, then run `safe-azure up`.\n"
            .to_owned();
    }
    let header = ["", "CONTEXT", "LOGIN", "EXPIRES IN", "SUBSCRIPTIONS"];
    let table: Vec<[String; 5]> = rows
        .iter()
        .map(|r| {
            let login = if r.logged_in {
                "signed in"
            } else if r.login_pending {
                "pending"
            } else {
                "signed out"
            };
            let expires = match (r.logged_in, r.expires_in_minutes) {
                (true, Some(m)) => format!("{m} min"),
                _ => "-".to_owned(),
            };
            [
                if r.active { "*" } else { "" }.to_owned(),
                r.alias.clone(),
                login.to_owned(),
                expires,
                r.subscriptions.join(", "),
            ]
        })
        .collect();
    let mut widths = header.map(str::len);
    for row in &table {
        for (w, cell) in widths.iter_mut().zip(row) {
            *w = (*w).max(cell.chars().count());
        }
    }
    let line = |cells: [&str; 5]| {
        let mut s = String::new();
        for (i, (cell, w)) in cells.iter().zip(widths).enumerate() {
            if i + 1 == cells.len() {
                s.push_str(cell);
            } else {
                let _ = write!(s, "{cell:w$}  ");
            }
        }
        s.trim_end().to_owned() + "\n"
    };
    let mut out = line(header);
    for row in &table {
        out.push_str(&line([&row[0], &row[1], &row[2], &row[3], &row[4]]));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use anyhow::anyhow;

    fn row(alias: &str, active: bool, logged_in: bool, pending: bool) -> ContextStatus {
        ContextStatus {
            alias: alias.into(),
            subscriptions: vec!["main".into(), "shared".into()],
            active,
            logged_in,
            expires_in_minutes: Some(42),
            login_pending: pending,
        }
    }

    #[test]
    fn refuses_without_a_terminal() {
        for (i, o) in [(false, false), (true, false), (false, true)] {
            let err = ensure_interactive(i, o)
                .err()
                .map(|e| e.to_string())
                .unwrap_or_default();
            assert!(err.contains("own interactive terminal"), "{err}");
        }
        assert!(ensure_interactive(true, true).is_ok());
    }

    #[test]
    fn picks_the_active_context() -> Result<()> {
        let rows = [
            row("dev", false, false, false),
            row("prod", true, true, false),
        ];
        assert_eq!(active_context(&rows)?, "prod");
        assert!(active_context(&rows[..1]).is_err());
        Ok(())
    }

    #[test]
    fn status_table() {
        let rows = [
            row("prod", true, true, false),
            row("development", false, false, true),
        ];
        let table = render_status(&rows);
        let lines: Vec<&str> = table.lines().collect();
        assert_eq!(lines.len(), 3);
        assert!(lines[0].starts_with("   CONTEXT"));
        assert!(lines[1].starts_with("*  prod"));
        assert!(lines[1].contains("signed in"));
        assert!(lines[1].contains("42 min"));
        assert!(lines[1].ends_with("main, shared"));
        assert!(lines[2].contains("pending"));
        assert!(!lines[2].contains("42 min"));
        assert!(render_status(&[]).contains("No contexts"));
    }

    #[test]
    fn polls_until_done() -> Result<()> {
        let mut answers = vec![
            Ok(State::Succeeded),
            Err(anyhow!("blip")),
            Ok(State::Pending),
        ];
        let mut ticks = 0;
        let state = wait_for_login(
            || answers.pop().unwrap_or(Ok(State::Failed)),
            Duration::ZERO,
            Duration::from_secs(60),
            || ticks += 1,
        )?;
        assert_eq!(state, State::Succeeded);
        assert_eq!(answers.len(), 0, "every answer is consumed");
        assert!(ticks >= 2);
        Ok(())
    }

    #[test]
    fn three_errors_in_a_row_abort() {
        let mut calls = 0;
        let result = wait_for_login(
            || {
                calls += 1;
                Err(anyhow!("down"))
            },
            Duration::ZERO,
            Duration::from_secs(60),
            || {},
        );
        assert!(result.is_err());
        assert_eq!(calls, 3);
    }

    #[test]
    fn gives_up_while_pending() -> Result<()> {
        let state = wait_for_login(|| Ok(State::Pending), Duration::ZERO, Duration::ZERO, || {})?;
        assert_eq!(state, State::Pending);
        Ok(())
    }
}
