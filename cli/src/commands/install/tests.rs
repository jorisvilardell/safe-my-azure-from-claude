#![allow(clippy::expect_used, clippy::struct_excessive_bools)]

use super::contexts::{self, ContextsFile, Prompt};
use super::runner::{Output, Runner};
use super::services::Services;
use super::update::{self, SelfUpdate};
use super::*;
use std::cell::RefCell;
use std::io::Cursor;
use std::rc::Rc;

const TENANT: &str = "00000000-0000-0000-0000-0000000000aa";
const SUB: &str = "00000000-0000-0000-0000-000000000001";

type Log = Rc<RefCell<Vec<String>>>;

/// Docker + Claude Code simulator that records every argv.
struct FakeRunner {
    log: Log,
    docker: bool,
    daemon_up: bool,
    claude: bool,
    /// `(running, image)` of our container.
    container: RefCell<Option<(bool, String)>>,
    /// Exe our MCP entry launches.
    registered: RefCell<Option<String>>,
    reexec_ok: bool,
}

impl FakeRunner {
    fn new(log: &Log) -> Self {
        Self {
            log: Rc::clone(log),
            docker: true,
            daemon_up: true,
            claude: true,
            container: RefCell::new(None),
            registered: RefCell::new(None),
            reexec_ok: true,
        }
    }

    fn ok(stdout: &str) -> Output {
        Output {
            success: true,
            stdout: stdout.to_owned(),
            stderr: String::new(),
        }
    }

    fn fail(stderr: &str) -> Output {
        Output {
            success: false,
            stdout: String::new(),
            stderr: stderr.to_owned(),
        }
    }

    fn exec(&self, program: &str, args: &[String]) -> Output {
        self.log
            .borrow_mut()
            .push(format!("{program} {}", args.join(" ")));
        let a: Vec<&str> = args.iter().map(String::as_str).collect();
        match (program, a.as_slice()) {
            ("docker", ["info", ..]) if self.daemon_up => Self::ok("27.0.0\n"),
            // Real Docker Desktop: exit 0, empty version, error on stderr.
            ("docker", ["info", ..]) => Output {
                success: true,
                stdout: "\n".to_owned(),
                stderr: "error during connect: open //./pipe/dockerDesktopLinuxEngine".to_owned(),
            },
            ("docker", ["ps", ..]) => match &*self.container.borrow() {
                None => Self::ok(""),
                Some((true, image)) => Self::ok(&format!("running\t{image}\n")),
                Some((false, image)) => Self::ok(&format!("exited\t{image}\n")),
            },
            ("docker", ["pull", _]) => Self::ok(""),
            ("docker", ["rm", "-f", _]) => {
                if self.container.borrow_mut().take().is_some() {
                    Self::ok("")
                } else {
                    Self::fail("Error: No such container: azure-safe-mcp")
                }
            }
            ("docker", ["run", ..]) => {
                let image = a.last().copied().unwrap_or_default().to_owned();
                *self.container.borrow_mut() = Some((true, image));
                Self::ok("abc123\n")
            }
            ("docker", ["start", _]) => {
                if let Some(c) = self.container.borrow_mut().as_mut() {
                    c.0 = true;
                }
                Self::ok("")
            }
            ("docker", ["stop", _]) => {
                if let Some(c) = self.container.borrow_mut().as_mut() {
                    c.0 = false;
                }
                Self::ok("")
            }
            ("claude", ["mcp", "get", _]) => match &*self.registered.borrow() {
                Some(exe) => Self::ok(&format!("safe-azure:\n  Command: {exe}\n  Args: mcp\n")),
                None => Self::fail("No MCP server found"),
            },
            ("claude", ["mcp", "remove", ..]) => {
                if self.registered.borrow_mut().take().is_some() {
                    Self::ok("")
                } else {
                    Self::fail("not found")
                }
            }
            ("claude", ["mcp", "add", .., exe, "mcp"]) => {
                *self.registered.borrow_mut() = Some((*exe).to_owned());
                Self::ok("")
            }
            (_, ["update", "--continue"]) if self.reexec_ok => Self::ok(""),
            _ => Self::fail("unexpected command"),
        }
    }
}

impl Runner for FakeRunner {
    fn find(&self, program: &str) -> Option<PathBuf> {
        let present = match program {
            "docker" => self.docker,
            "claude" => self.claude,
            _ => true,
        };
        present.then(|| PathBuf::from(program))
    }
    fn output(&self, program: &str, args: &[String]) -> Result<Output> {
        Ok(self.exec(program, args))
    }
    fn status(&self, program: &str, args: &[String]) -> Result<bool> {
        Ok(self.exec(program, args).success)
    }
}

struct FakeServices {
    log: Log,
    healthy: bool,
    server_version: String,
    skill: RefCell<bool>,
    hook: RefCell<bool>,
    keys_cached: RefCell<bool>,
    latest: String,
    self_update: SelfUpdate,
}

impl FakeServices {
    fn new(log: &Log) -> Self {
        Self {
            log: Rc::clone(log),
            healthy: true,
            server_version: update::CURRENT.to_owned(),
            skill: RefCell::new(false),
            hook: RefCell::new(false),
            keys_cached: RefCell::new(false),
            latest: update::CURRENT.to_owned(),
            self_update: SelfUpdate::UpToDate,
        }
    }
    fn event(&self, e: &str) {
        self.log.borrow_mut().push(e.to_owned());
    }
}

impl Services for FakeServices {
    fn health(&self) -> Result<Option<String>> {
        Ok(self.healthy.then(|| self.server_version.clone()))
    }
    fn fetch_keys(&self) -> Result<()> {
        self.event("keys.fetch");
        *self.keys_cached.borrow_mut() = true;
        Ok(())
    }
    fn keys_readable(&self) -> Result<()> {
        if *self.keys_cached.borrow() {
            Ok(())
        } else {
            bail!("no keys")
        }
    }
    fn clear_keys(&self) -> Result<()> {
        self.event("keys.clear");
        *self.keys_cached.borrow_mut() = false;
        Ok(())
    }
    fn skill_install(&self, _: &Path) -> Result<bool> {
        self.event("skill.install");
        Ok(!self.skill.replace(true))
    }
    fn skill_uninstall(&self, _: &Path) -> Result<bool> {
        self.event("skill.uninstall");
        Ok(self.skill.replace(false))
    }
    fn skill_current(&self, _: &Path) -> bool {
        *self.skill.borrow()
    }
    fn hook_install(&self, _: &Path, _: &Path) -> Result<bool> {
        self.event("hook.install");
        Ok(!self.hook.replace(true))
    }
    fn hook_uninstall(&self, _: &Path) -> Result<bool> {
        self.event("hook.uninstall");
        Ok(self.hook.replace(false))
    }
    fn hook_installed(&self, _: &Path) -> bool {
        *self.hook.borrow()
    }
    fn latest_release(&self) -> Result<String> {
        Ok(self.latest.clone())
    }
    fn self_update(&self) -> Result<SelfUpdate> {
        self.event("self-update");
        Ok(self.self_update.clone())
    }
    fn sleep(&self, _: Duration) {}
}

struct Env {
    dir: tempfile::TempDir,
    log: Log,
    run: FakeRunner,
    svc: FakeServices,
}

impl Env {
    fn new() -> Self {
        let log: Log = Rc::default();
        Self {
            dir: tempfile::tempdir().expect("tempdir"),
            run: FakeRunner::new(&log),
            svc: FakeServices::new(&log),
            log,
        }
    }
    fn paths(&self) -> Paths {
        let config_dir = self.dir.path().join("config");
        Paths {
            contexts: config_dir.join("contexts.yaml"),
            config_dir,
            claude_dir: self.dir.path().join(".claude"),
            exe: self.dir.path().join("bin").join("safe-azure"),
        }
    }
    fn ctx(&self) -> Ctx<'_> {
        Ctx {
            run: &self.run,
            svc: &self.svc,
            paths: self.paths(),
        }
    }
    fn source_contexts(&self) -> PathBuf {
        let file = ContextsFile {
            contexts: [(
                "prod".to_owned(),
                contexts::AzureContext {
                    tenant_id: TENANT.to_owned(),
                    subscriptions: [("prod-app".to_owned(), SUB.to_owned())].into(),
                },
            )]
            .into(),
            default_context: Some("prod".to_owned()),
            safe_tag_keys: vec!["env".to_owned()],
        };
        let path = self.dir.path().join("my-contexts.yaml");
        std::fs::write(&path, contexts::render(&file)).expect("write");
        path
    }
    fn take_log(&self) -> Vec<String> {
        std::mem::take(&mut *self.log.borrow_mut())
    }
    fn count(log: &[String], prefix: &str) -> usize {
        log.iter().filter(|l| l.starts_with(prefix)).count()
    }
}

fn install_args(contexts: Option<PathBuf>) -> InstallArgs {
    InstallArgs {
        contexts,
        no_hook: false,
        no_skill: false,
        yes: true,
    }
}

// ---- docker argv ---------------------------------------------------------------------------

#[test]
fn run_args_have_compose_hardening_and_loopback_port() {
    let args = docker::run_args(
        Path::new("/home/u/.config/safe-azure/contexts.yaml"),
        "img:1.0.0",
    );
    let joined = args.join(" ");
    assert_eq!(
        joined,
        "run --name azure-safe-mcp -d --restart unless-stopped -p 127.0.0.1:8765:8765 \
         --read-only --tmpfs /tmp --tmpfs /run/safe-azure:mode=0700,uid=1000 \
         --cap-drop ALL --security-opt no-new-privileges:true \
         -v /home/u/.config/safe-azure/contexts.yaml:/app/config/contexts.yaml:ro img:1.0.0"
    );
    // Never published on every interface.
    let port = args.iter().skip_while(|a| *a != "-p").nth(1).expect("port");
    assert!(port.starts_with("127.0.0.1:"));
    assert_eq!(args.iter().filter(|a| *a == "-p").count(), 1);
}

#[test]
fn claude_add_argv_launches_this_binary() {
    let args = claude::add_args(Path::new("/opt/bin/safe-azure"));
    assert_eq!(
        args.join(" "),
        "mcp add --scope user safe-azure -- /opt/bin/safe-azure mcp"
    );
}

// ---- install -------------------------------------------------------------------------------

#[test]
fn install_runs_everything_in_order() {
    let env = Env::new();
    let src = env.source_contexts();
    install_with(&env.ctx(), &install_args(Some(src.clone())), None).expect("install");

    let log = env.take_log();
    let image = paths::image_ref();
    let pos = |needle: &str| {
        log.iter()
            .position(|l| l.starts_with(needle))
            .unwrap_or_else(|| panic!("missing {needle} in {log:#?}"))
    };
    assert!(pos("docker info") < pos(&format!("docker pull {image}")));
    assert!(pos("docker pull") < pos("docker run"));
    assert!(pos("docker run") < pos("keys.fetch"));
    assert!(pos("keys.fetch") < pos("claude mcp add"));
    assert!(pos("claude mcp add") < pos("skill.install"));
    assert!(pos("skill.install") < pos("hook.install"));
    assert!(
        log.iter()
            .any(|l| l.ends_with(&format!(":/app/config/contexts.yaml:ro {image}")))
    );

    let ctx = env.ctx();
    assert_eq!(
        std::fs::read_to_string(&ctx.paths.contexts).expect("copied"),
        std::fs::read_to_string(&src).expect("src")
    );
    assert_eq!(
        Options::load(&ctx.paths.config_dir),
        Options {
            hook: true,
            skill: true
        }
    );
}

#[test]
fn install_is_idempotent_and_keeps_a_healthy_container() {
    let env = Env::new();
    let src = env.source_contexts();
    install_with(&env.ctx(), &install_args(Some(src.clone())), None).expect("first");
    env.take_log();

    // Second run with the same file: no recreate (logins kept), no re-registration.
    install_with(&env.ctx(), &install_args(Some(src)), None).expect("second");
    let log = env.take_log();
    assert_eq!(Env::count(&log, "docker run"), 0, "{log:#?}");
    assert_eq!(Env::count(&log, "docker rm"), 0);
    assert_eq!(Env::count(&log, "claude mcp add"), 0);
    // Without --contexts, the existing valid file is kept as is.
    install_with(&env.ctx(), &install_args(None), None).expect("third");
    assert_eq!(Env::count(&env.take_log(), "docker run"), 0);
}

#[test]
fn install_repairs_a_stopped_container_and_a_changed_contexts_file() {
    let env = Env::new();
    let src = env.source_contexts();
    install_with(&env.ctx(), &install_args(Some(src.clone())), None).expect("first");
    if let Some(c) = env.run.container.borrow_mut().as_mut() {
        c.0 = false;
    }
    env.take_log();
    install_with(&env.ctx(), &install_args(Some(src.clone())), None).expect("repair");
    let log = env.take_log();
    assert_eq!(Env::count(&log, "docker rm -f azure-safe-mcp"), 1);
    assert_eq!(Env::count(&log, "docker run"), 1);

    // New contexts content: the single-file bind mount needs a new container.
    let mut text = std::fs::read_to_string(&src).expect("read");
    text.push_str("# changed\n");
    std::fs::write(&src, text).expect("write");
    install_with(&env.ctx(), &install_args(Some(src)), None).expect("changed");
    assert_eq!(Env::count(&env.take_log(), "docker run"), 1);
}

#[test]
fn install_stops_when_docker_is_down() {
    let mut env = Env::new();
    env.run.daemon_up = false;
    let src = env.source_contexts();
    let err = install_with(&env.ctx(), &install_args(Some(src)), None).expect_err("must fail");
    assert!(err.to_string().contains("not running") || err.to_string().contains("not reachable"));
    assert_eq!(Env::count(&env.take_log(), "docker pull"), 0);
}

#[test]
fn install_without_claude_prints_instructions_and_skips_registration() {
    let mut env = Env::new();
    env.run.claude = false;
    let src = env.source_contexts();
    // doctor warns (not fails) when claude is missing.
    install_with(&env.ctx(), &install_args(Some(src)), None).expect("install");
    assert_eq!(Env::count(&env.take_log(), "claude"), 0);
    assert!(
        claude::manual_instructions(Path::new("/x/safe-azure"))
            .contains("claude mcp add --scope user safe-azure -- /x/safe-azure mcp")
    );
}

#[test]
fn install_honours_no_hook_and_no_skill() {
    let env = Env::new();
    let src = env.source_contexts();
    let args = InstallArgs {
        no_hook: true,
        no_skill: true,
        ..install_args(Some(src))
    };
    install_with(&env.ctx(), &args, None).expect("install");
    let log = env.take_log();
    assert_eq!(Env::count(&log, "hook.install"), 0);
    assert_eq!(Env::count(&log, "skill.install"), 0);
}

#[test]
fn install_refuses_an_invalid_contexts_file_without_printing_ids() {
    let env = Env::new();
    let bad = env.dir.path().join("bad.yaml");
    std::fs::write(
        &bad,
        "contexts:\n  prod:\n    tenantId: 00000000-0000-0000-0000-00000000zzzz\n",
    )
    .expect("write");
    let err = install_with(&env.ctx(), &install_args(Some(bad)), None).expect_err("invalid");
    let msg = format!("{err:#}");
    assert!(
        msg.contains("contexts.prod.tenantId is not a GUID"),
        "{msg}"
    );
    assert!(!msg.contains("zzzz"), "{msg}");
}

#[test]
fn install_without_terminal_or_file_explains_what_to_do() {
    let env = Env::new();
    let err = install_with(&env.ctx(), &install_args(None), None).expect_err("no tty");
    assert!(err.to_string().contains("--contexts"));
}

#[test]
fn install_runs_the_wizard_when_interactive() {
    let env = Env::new();
    let answers = format!("prod\n{TENANT}\nprod-app\n{SUB}\n\nn\nenv, app\n");
    let mut input = Cursor::new(answers.into_bytes());
    let mut out = Vec::new();
    let mut prompt = Prompt {
        input: &mut input,
        out: &mut out,
    };
    install_with(&env.ctx(), &install_args(None), Some(&mut prompt)).expect("install");
    let written = contexts::load(&env.ctx().paths.contexts).expect("valid");
    assert_eq!(written.default_context.as_deref(), Some("prod"));
    assert_eq!(written.safe_tag_keys, vec!["env", "app"]);
    // IDs are typed, never echoed back.
    let shown = String::from_utf8(out).expect("utf8");
    assert!(!shown.contains(TENANT) && !shown.contains(SUB), "{shown}");
}

// ---- uninstall / up / down -----------------------------------------------------------------

#[test]
fn uninstall_reverses_install_but_keeps_contexts() {
    let env = Env::new();
    let src = env.source_contexts();
    install_with(&env.ctx(), &install_args(Some(src)), None).expect("install");
    env.take_log();

    uninstall_with(&env.ctx(), &UninstallArgs { purge: false }).expect("uninstall");
    let log = env.take_log();
    for expected in [
        "docker rm -f azure-safe-mcp",
        "claude mcp remove --scope user safe-azure",
        "hook.uninstall",
        "skill.uninstall",
        "keys.clear",
    ] {
        assert_eq!(Env::count(&log, expected), 1, "{expected}: {log:#?}");
    }
    let ctx = env.ctx();
    assert!(ctx.paths.contexts.is_file());
    assert!(!ctx.paths.config_dir.join(OPTIONS_FILE).exists());
    assert!(env.run.container.borrow().is_none());
    assert!(env.run.registered.borrow().is_none());

    // Uninstalling twice is fine.
    uninstall_with(&env.ctx(), &UninstallArgs { purge: false }).expect("again");
}

#[test]
fn uninstall_purge_deletes_the_config_dir() {
    let env = Env::new();
    install_with(&env.ctx(), &install_args(Some(env.source_contexts())), None).expect("install");
    uninstall_with(&env.ctx(), &UninstallArgs { purge: true }).expect("purge");
    assert!(!env.ctx().paths.config_dir.exists());
}

#[test]
fn up_and_down_start_stop_and_recreate() {
    let env = Env::new();
    install_with(&env.ctx(), &install_args(Some(env.source_contexts())), None).expect("install");
    env.take_log();

    down_with(&env.ctx()).expect("down");
    let log = env.take_log();
    assert_eq!(Env::count(&log, "docker stop azure-safe-mcp"), 1);
    assert_eq!(Env::count(&log, "keys.clear"), 1);

    up_with(&env.ctx()).expect("up");
    let log = env.take_log();
    assert_eq!(Env::count(&log, "docker start azure-safe-mcp"), 1);
    assert_eq!(Env::count(&log, "keys.fetch"), 1);

    // Missing container: recreated with the hardened flags.
    env.run.container.replace(None);
    up_with(&env.ctx()).expect("recreate");
    let log = env.take_log();
    assert_eq!(Env::count(&log, "docker run --name azure-safe-mcp"), 1);
}

// ---- update --------------------------------------------------------------------------------

#[test]
fn update_with_new_binary_reexecs_and_does_nothing_else() {
    let mut env = Env::new();
    env.svc.self_update = SelfUpdate::Updated("9.9.9".to_owned());
    update_with(
        &env.ctx(),
        &UpdateArgs {
            check: false,
            continue_: false,
        },
    )
    .expect("update");
    let log = env.take_log();
    let exe = env.ctx().paths.exe.display().to_string();
    assert_eq!(
        log,
        vec!["self-update".to_owned(), format!("{exe} update --continue")]
    );
}

#[test]
fn update_continue_refreshes_image_container_and_client_setup_in_order() {
    let env = Env::new();
    install_with(&env.ctx(), &install_args(Some(env.source_contexts())), None).expect("install");
    // The new binary expects another tag than the running container: recreate.
    env.run
        .container
        .replace(Some((true, format!("{}:0.0.1", paths::IMAGE))));
    env.take_log();

    update_with(
        &env.ctx(),
        &UpdateArgs {
            check: false,
            continue_: true,
        },
    )
    .expect("update");
    let log = env.take_log();
    let image = paths::image_ref();
    let order: Vec<&str> = log
        .iter()
        .map(String::as_str)
        .filter(|l| {
            l.starts_with("docker pull")
                || l.starts_with("docker rm")
                || l.starts_with("docker run")
                || l.starts_with("keys.fetch")
                || l.starts_with("claude mcp add")
                || l.starts_with("skill.install")
                || l.starts_with("hook.install")
                || l.starts_with("self-update")
        })
        .map(|l| l.split(" --").next().unwrap_or(l))
        .collect();
    assert_eq!(
        order,
        vec![
            format!("docker pull {image}").as_str(),
            "docker rm -f azure-safe-mcp",
            "docker run",
            "keys.fetch",
            "skill.install",
            "hook.install",
        ],
        "{log:#?}"
    );
    // Doctor ran last (it lists the container).
    assert!(
        log.last().is_some_and(|l| l.starts_with("claude mcp get")),
        "{log:#?}"
    );
}

#[test]
fn update_reapplies_the_install_options() {
    let env = Env::new();
    let args = InstallArgs {
        no_hook: true,
        ..install_args(Some(env.source_contexts()))
    };
    install_with(&env.ctx(), &args, None).expect("install");
    env.take_log();
    update_with(
        &env.ctx(),
        &UpdateArgs {
            check: false,
            continue_: false,
        },
    )
    .expect("update");
    let log = env.take_log();
    assert_eq!(log.first().map(String::as_str), Some("self-update"));
    assert_eq!(Env::count(&log, "hook.install"), 0);
    assert_eq!(Env::count(&log, "skill.install"), 1);
}

#[test]
fn update_check_only_reports() {
    let mut env = Env::new();
    env.svc.latest = "99.0.0".to_owned();
    update_with(
        &env.ctx(),
        &UpdateArgs {
            check: true,
            continue_: false,
        },
    )
    .expect("check");
    assert_eq!(env.take_log(), Vec::<String>::new());
}

// ---- doctor --------------------------------------------------------------------------------

#[test]
fn doctor_passes_after_install_and_fails_when_broken() {
    let mut env = Env::new();
    install_with(&env.ctx(), &install_args(Some(env.source_contexts())), None).expect("install");
    assert_eq!(doctor::failures(&doctor::run(&env.ctx())), 0);

    env.svc.server_version = "0.0.1".to_owned();
    env.svc.hook.replace(false);
    let checks = doctor::run(&env.ctx());
    let failed: Vec<&str> = checks
        .iter()
        .filter(|c| c.level == doctor::Level::Fail)
        .map(|c| c.name)
        .collect();
    assert_eq!(failed, vec!["Versions", "Hook"]);
    assert!(doctor_with(&env.ctx()).is_err());
}

#[test]
fn doctor_reports_a_newer_release_as_a_warning() {
    let mut env = Env::new();
    install_with(&env.ctx(), &install_args(Some(env.source_contexts())), None).expect("install");
    env.svc.latest = "99.0.0".to_owned();
    let checks = doctor::run(&env.ctx());
    let release = checks
        .iter()
        .find(|c| c.name == "Release")
        .expect("release");
    assert_eq!(release.level, doctor::Level::Warn);
    assert_eq!(doctor::failures(&checks), 0);
}

#[test]
fn doctor_without_docker_fails_cleanly() {
    let mut env = Env::new();
    env.run.docker = false;
    let checks = doctor::run(&env.ctx());
    assert_eq!(checks.first().map(|c| c.level), Some(doctor::Level::Fail));
    assert!(checks.iter().all(|c| c.name != "Container"));
}

// ---- contexts.yaml -------------------------------------------------------------------------

#[test]
fn guid_and_alias_rules_match_the_server() {
    assert!(contexts::is_guid(TENANT));
    assert!(contexts::is_guid("00000000-0000-0000-0000-0000000000AA"));
    assert!(!contexts::is_guid("00000000-0000-0000-0000-0000000000a"));
    assert!(!contexts::is_guid("00000000000000000000000000000000"));
    assert!(!contexts::is_guid("{00000000-0000-0000-0000-0000000000aa}"));
    assert!(contexts::is_alias("prod"));
    assert!(contexts::is_alias("0lab-2"));
    assert!(contexts::is_alias(&"a".repeat(40)));
    assert!(!contexts::is_alias(&"a".repeat(41)));
    assert!(!contexts::is_alias("-prod"));
    assert!(!contexts::is_alias("Prod"));
    assert!(!contexts::is_alias("prod_app"));
    assert!(!contexts::is_alias(""));
}

#[test]
fn parse_accepts_the_example_file() {
    let text = include_str!("../../../../config/contexts.example.yaml");
    let file = contexts::parse(text).expect("example is valid");
    assert_eq!(file.contexts.len(), 2);
    assert_eq!(file.default_context.as_deref(), Some("prod"));
    assert_eq!(file.safe_tag_keys, vec!["env", "app"]);
    assert_eq!(
        contexts::parse(&contexts::render(&file)).expect("round trip"),
        file
    );
}

#[test]
fn parse_rejects_what_the_server_rejects() {
    assert_eq!(contexts::parse("").expect("empty"), ContextsFile::default());
    let cases = [
        (
            "contexts:\n  Prod:\n    tenantId: 00000000-0000-0000-0000-0000000000aa\n",
            "alias",
        ),
        ("contexts:\n  prod: {}\n", "tenantId is required"),
        (
            "contexts:\n  prod:\n    tenantId: 00000000-0000-0000-0000-0000000000aa\n    subscriptions:\n      app: nope\n",
            "subscriptions.app is not a GUID",
        ),
        (
            "contexts:\n  prod:\n    tenantId: 00000000-0000-0000-0000-0000000000aa\ndefaultContext: lab\n",
            "defaultContext",
        ),
        ("safeTagKeys: env\n", "safeTagKeys"),
        ("contexts: [\n", "not valid YAML"),
    ];
    for (text, expected) in cases {
        let err = contexts::parse(text).expect_err(text).to_string();
        assert!(err.contains(expected), "{text:?} → {err}");
        assert!(!err.contains("nope"));
    }
}

#[test]
fn wizard_reprompts_on_invalid_answers() {
    let answers = format!(
        "Bad_Alias\nprod\nnot-a-guid\n{TENANT}\nprod-app\n{SUB}\n\ny\nprod\nlab\n{TENANT}\n\nmaybe\nn\nstaging\nlab\n\n"
    );
    let mut input = Cursor::new(answers.into_bytes());
    let mut out = Vec::new();
    let file = contexts::wizard(&mut Prompt {
        input: &mut input,
        out: &mut out,
    })
    .expect("wizard");
    let shown = String::from_utf8(out).expect("utf8");
    assert!(shown.contains("alias must be lowercase"));
    assert!(shown.contains("not a GUID"));
    assert!(shown.contains("\"prod\" is already used"));
    assert!(shown.contains("not one of the aliases"));
    assert_eq!(
        file.contexts.keys().collect::<Vec<_>>(),
        vec!["lab", "prod"]
    );
    assert_eq!(file.default_context.as_deref(), Some("lab"));
    assert_eq!(file.safe_tag_keys, Vec::<String>::new());
    assert!(
        !format!("{file:?}").contains(TENANT),
        "Debug must redact IDs"
    );
}

#[test]
fn wizard_fails_on_closed_input() {
    let mut input = Cursor::new(b"prod\n".to_vec());
    let mut out = Vec::new();
    assert!(
        contexts::wizard(&mut Prompt {
            input: &mut input,
            out: &mut out
        })
        .is_err()
    );
}

// ---- update notice -------------------------------------------------------------------------

#[test]
fn versions_compare_numerically() {
    assert!(update::is_newer("0.10.0", "0.9.9"));
    assert!(update::is_newer("v1.0.0", "0.99.0"));
    assert!(!update::is_newer("1.0.0", "1.0.0"));
    assert!(!update::is_newer("1.0.0-rc.1", "1.0.0"));
    assert!(!update::is_newer("garbage", "1.0.0"));
    assert_eq!(update::parse_version("1.2.3+build"), Some((1, 2, 3)));
    assert_eq!(update::parse_version("1.2"), None);
}

#[test]
fn notice_checks_at_most_once_a_day() {
    let dir = tempfile::tempdir().expect("tempdir");
    let cache = dir.path().join("cfg").join(update::NOTICE_CACHE_FILE);
    let calls = RefCell::new(0);
    let fetch = || {
        *calls.borrow_mut() += 1;
        Ok("2.0.0".to_owned())
    };
    let day = 24 * 60 * 60;

    let first = update::notice(&cache, 1_000, false, "1.0.0", &fetch);
    assert!(first.is_some_and(|t| t.contains("2.0.0") && t.contains("safe-azure update")));
    assert_eq!(
        update::notice(&cache, 1_000 + day - 1, false, "1.0.0", &fetch),
        None
    );
    assert_eq!(*calls.borrow(), 1, "cached for a day");
    assert!(update::notice(&cache, 1_000 + day, false, "1.0.0", &fetch).is_some());
    assert_eq!(*calls.borrow(), 2);

    // Up to date: no notice, still cached.
    assert_eq!(
        update::notice(&cache, 10 * day, false, "2.0.0", &fetch),
        None
    );
    // A failed check is cached too (no retry on every command when offline).
    let offline = || -> Result<String> { bail!("offline") };
    assert_eq!(
        update::notice(&cache, 20 * day, false, "1.0.0", &offline),
        None
    );
    assert_eq!(
        update::notice(&cache, 20 * day + 5, false, "1.0.0", &fetch),
        None
    );
    assert_eq!(*calls.borrow(), 3);
}

#[test]
fn notice_is_skipped_when_disabled() {
    let dir = tempfile::tempdir().expect("tempdir");
    let cache = dir.path().join(update::NOTICE_CACHE_FILE);
    let fetch = || -> Result<String> { panic!("must not hit the network") };
    assert_eq!(update::notice(&cache, 1, true, "1.0.0", &fetch), None);
    assert!(!cache.exists());
}
