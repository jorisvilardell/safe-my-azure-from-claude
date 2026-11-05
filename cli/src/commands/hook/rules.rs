//! Decision logic of the Claude Code guard (ADR 0001 §5). Pure, no I/O, so it is table-tested.
//!
//! The matching is deliberately coarse: it works on a lowercased, quote-stripped copy of the
//! command and looks for dangerous words anywhere in each segment, not only in command position.
//! A false positive costs the agent one retry; a false negative can leak a credential.

use serde_json::Value;

/// What the hook answers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    Allow,
    Deny(String),
}

/// Host facts the rules need. Paths are normalised with [`norm`].
#[derive(Debug, Clone, Default)]
pub struct Env {
    pub home: Option<String>,
    pub config_dir: Option<String>,
}

impl Env {
    pub fn from_system() -> Self {
        Self {
            home: dirs::home_dir().map(|p| norm(&p.to_string_lossy())),
            config_dir: crate::paths::config_dir().map(|p| norm(&p.to_string_lossy())),
        }
    }
}

const PREFIX: &str = "safe-azure guard:";
const USE_MCP: &str = "Use the safe-azure MCP tools instead (server_info, login_status, \
    list_fired_alerts, get_alert, get_activity_log, get_metrics, run_kql, get_resource_health).";

const MALFORMED: &str = "the hook input is not valid PreToolUse JSON, so the call is blocked \
    (fail closed). Retry the tool call; if this keeps happening, ask the user to run \
    `safe-azure doctor` in their own terminal.";

fn deny(reason: impl AsRef<str>) -> Decision {
    Decision::Deny(format!("{PREFIX} {}", reason.as_ref()))
}

fn deny_shape(tool: &str, field: &str) -> Decision {
    deny(format!(
        "the {tool} call has no string `{field}` field, so it cannot be checked and is blocked \
         (fail closed). Retry with a well-formed call."
    ))
}

/// Entry point: the raw stdin of the hook.
pub fn evaluate(raw: &str, env: &Env) -> Decision {
    let Ok(event) = serde_json::from_str::<Value>(raw) else {
        return deny(MALFORMED);
    };
    let Some(tool) = event.get("tool_name").and_then(Value::as_str) else {
        return deny(MALFORMED);
    };
    let input = event.get("tool_input");
    let field = |name: &str| input.and_then(|i| i.get(name));
    let text = |name: &str| field(name).and_then(Value::as_str);
    let cwd = event.get("cwd").and_then(Value::as_str);

    match tool {
        "Bash" | "PowerShell" => match text("command") {
            Some(cmd) => check_command(cmd, env),
            None => deny_shape(tool, "command"),
        },
        "Read" => match text("file_path") {
            Some(p) => check_path(p, false, env),
            None => deny_shape(tool, "file_path"),
        },
        "Write" | "Edit" | "MultiEdit" => match text("file_path") {
            Some(p) => check_path(p, true, env),
            None => deny_shape(tool, "file_path"),
        },
        "NotebookEdit" => match text("notebook_path") {
            Some(p) => check_path(p, true, env),
            None => deny_shape(tool, "notebook_path"),
        },
        "LS" => match text("path") {
            Some(p) => check_path(p, false, env),
            None => deny_shape(tool, "path"),
        },
        "Glob" | "Grep" => {
            let Some(pattern) = text("pattern") else {
                return deny_shape(tool, "pattern");
            };
            // Optional fields must be strings when present.
            for name in ["path", "glob"] {
                if field(name).is_some_and(|v| !v.is_string() && !v.is_null()) {
                    return deny_shape(tool, name);
                }
            }
            if tool == "Glob" {
                if let Decision::Deny(r) = check_path(pattern, false, env) {
                    return Decision::Deny(r);
                }
            }
            for value in [text("path"), text("glob")].into_iter().flatten() {
                if let Decision::Deny(r) = check_path(value, false, env) {
                    return Decision::Deny(r);
                }
            }
            if tool == "Grep" {
                return check_grep_scope(text("path"), cwd, env);
            }
            Decision::Allow
        }
        "WebFetch" => match text("url") {
            Some(url) => check_url(url),
            None => deny_shape(tool, "url"),
        },
        // Unknown tools pass, unless they carry a shell command.
        _ => match text("command") {
            Some(cmd) => check_command(cmd, env),
            None => Decision::Allow,
        },
    }
}

// ---------------------------------------------------------------------------------------------
// Paths

/// Lowercase, forward slashes, no doubled slashes.
pub fn norm(path: &str) -> String {
    let lowered = path.to_lowercase().replace('\\', "/");
    let mut out = String::with_capacity(lowered.len());
    for c in lowered.chars() {
        if c == '/' && out.ends_with('/') {
            continue;
        }
        out.push(c);
    }
    out
}

fn is_word(c: char) -> bool {
    c.is_alphanumeric() || c == '_' || c == '-'
}

/// Occurrences of `needle` in `hay` with a non-word char (or the edge) after it, and before it
/// when `strict_before` is set.
fn find_bounded(hay: &str, needle: &str, strict_before: bool) -> bool {
    hay.match_indices(needle).any(|(i, _)| {
        let before_ok = !strict_before || hay[..i].chars().next_back().is_none_or(|c| !is_word(c));
        let after = hay[i + needle.len()..].chars().next();
        let after_ok = after.is_none_or(|c| !(is_word(c) || c == '.'));
        before_ok && after_ok
    })
}

const AZURE_CACHE: &str = "it is the Azure CLI / Azure PowerShell token cache, which holds \
    refresh tokens and raw tenant IDs. Never read it. ";
const CLI_CONFIG: &str = "it is the safe-azure config directory (server keys, real tenant and \
    subscription IDs). Never read it: ask the user to run safe-azure commands in their own \
    terminal. ";
const CONTEXTS: &str = "contexts.yaml holds the real tenant and subscription IDs. Use the \
    `list_contexts` MCP tool, which shows aliases only, or read `contexts.example.yaml`. ";
const SETTINGS: &str = "Claude Code settings files hold the safe-azure guard hook \
    (self-protection). Ask the user to edit Claude Code settings themselves.";

/// Why `text` (already normalised: lowercase, `/`) refers to a protected location, if it does.
fn sensitive_location(text: &str, env: &Env) -> Option<String> {
    let with = |what: &str| Some(format!("blocked access to {what}{USE_MCP}"));
    // `.azure` as a path segment (`~/.azure`, `%USERPROFILE%\.azure`, azd's project `.azure`).
    if text.match_indices(".azure").any(|(i, _)| {
        let before = text[..i].chars().next_back();
        let after = text[i + ".azure".len()..].chars().next();
        before.is_none_or(|c| !(is_word(c) || c == '.'))
            && after.is_none_or(|c| !(is_word(c) || c == '.'))
    }) {
        return with(&format!("`.azure`: {AZURE_CACHE}"));
    }
    for name in [
        ".identityservice",
        "msal_token_cache",
        "msal.cache",
        "tokencache.dat",
    ] {
        if text.contains(name) {
            return with(&format!("`{name}`: {AZURE_CACHE}"));
        }
    }
    if text.contains("keys.bin") {
        return with(&format!("`keys.bin`: {CLI_CONFIG}"));
    }
    if is_config_dir_ref(text, env) {
        return with(&format!("the safe-azure config directory: {CLI_CONFIG}"));
    }
    if find_bounded(text, "contexts.yaml", true) {
        return with(&format!("contexts.yaml: {CONTEXTS}"));
    }
    None
}

fn is_config_dir_ref(text: &str, env: &Env) -> bool {
    const PARENTS: [&str; 9] = [
        "roaming/",
        "appdata/",
        "appdata%/",
        "appdata)/",
        "appdata}/",
        ".config/",
        "application support/",
        "config_home/",
        "config_home}/",
    ];
    if let Some(dir) = env.config_dir.as_deref() {
        if !dir.is_empty() && text.contains(dir) {
            return true;
        }
    }
    if text.match_indices("safe-azure").any(|(i, _)| {
        let head = &text[..i];
        PARENTS.iter().any(|p| head.ends_with(p))
    }) {
        return true;
    }
    // `Join-Path $env:APPDATA safe-azure` and friends: both words in one shell segment.
    text.split(['\n', ';', '|', '&']).any(|seg| {
        seg.contains("safe-azure")
            && ["appdata", "config_home", ".config", "application support"]
                .iter()
                .any(|p| seg.contains(p))
    })
}

fn is_claude_settings(text: &str) -> bool {
    text.contains(".claude/settings")
        || text.contains("managed-settings")
        || text.contains("disableallhooks")
}

fn check_path(path: &str, write: bool, env: &Env) -> Decision {
    let p = norm(path);
    if let Some(reason) = sensitive_location(&p, env) {
        return deny(reason);
    }
    if write && (is_claude_settings(&p) || p.contains(".claude/skills/safe-azure")) {
        return deny(format!("blocked writing `{path}`: {SETTINGS}"));
    }
    Decision::Allow
}

/// Absolute, normalised form of a path, resolved against `cwd` and `~`.
fn absolute(path: &str, cwd: Option<&str>, env: &Env) -> Option<String> {
    let p = norm(path);
    let p = if let Some(rest) = p.strip_prefix('~') {
        format!("{}{rest}", env.home.as_deref()?)
    } else if p.starts_with('/') || p.get(1..3) == Some(":/") {
        p
    } else {
        format!("{}/{p}", norm(cwd?))
    };
    // Git Bash style `/c/users/...` when the host uses drive letters.
    let drive_host = env
        .home
        .as_deref()
        .is_some_and(|h| h.get(1..3) == Some(":/"));
    let bytes = p.as_bytes();
    let p = if drive_host
        && bytes.len() >= 3
        && bytes[0] == b'/'
        && bytes[1].is_ascii_alphabetic()
        && bytes[2] == b'/'
    {
        format!("{}:{}", char::from(bytes[1]), &p[2..])
    } else {
        p
    };
    // Resolve `.` and `..` lexically.
    let mut parts: Vec<&str> = Vec::new();
    for part in p.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    let joined = parts.join("/");
    Some(if p.starts_with('/') {
        format!("/{joined}")
    } else {
        joined
    })
}

/// Grep over a parent of `~/.azure` (the home dir, `C:/Users`, `/`) would read the token cache.
fn check_grep_scope(path: Option<&str>, cwd: Option<&str>, env: &Env) -> Decision {
    let Some(target) = path.or(cwd).and_then(|p| absolute(p, cwd, env)) else {
        return Decision::Allow;
    };
    let target = target.trim_end_matches('/');
    let protected = [
        env.home
            .as_deref()
            .map(|h| format!("{}/.azure", h.trim_end_matches('/'))),
        env.config_dir.clone(),
    ];
    for dir in protected.into_iter().flatten() {
        if dir == target
            || dir.starts_with(&format!("{target}/"))
            || (target.is_empty() && !dir.is_empty())
        {
            return deny(format!(
                "a Grep over `{}` would also search `{dir}`, which holds credentials or real IDs. \
                 Grep a narrower directory (the project folder). {USE_MCP}",
                path.unwrap_or("the working directory")
            ));
        }
    }
    Decision::Allow
}

// ---------------------------------------------------------------------------------------------
// URLs and the server port

const PORT: &str = "8765";
const LOOPBACK: [&str; 12] = [
    "localhost",
    "127.",
    "::1",
    "0.0.0.0",
    "[::]",
    "0x7f",
    "2130706433",
    "0177.",
    "host.docker.internal",
    "ip6-localhost",
    "/dev/tcp/",
    "/dev/udp/",
];
const SERVER: &str = "the safe-azure server on 127.0.0.1:8765 must only be reached through \
    its MCP client: shell or web access would bypass the key and the anonymiser.";

/// `8765` as a whole number (leading zeros allowed).
fn mentions_port(text: &str) -> bool {
    text.match_indices(PORT).any(|(i, _)| {
        let after_ok = text[i + PORT.len()..]
            .chars()
            .next()
            .is_none_or(|c| !c.is_ascii_digit());
        let head = text[..i].trim_end_matches('0');
        let before_ok = head.chars().next_back().is_none_or(|c| !c.is_ascii_digit());
        after_ok && before_ok
    })
}

fn mentions_loopback(text: &str) -> bool {
    LOOPBACK.iter().any(|l| text.contains(l))
}

fn check_url(url: &str) -> Decision {
    let u = url.trim().to_lowercase();
    let rest = u.split_once("://").map_or(u.as_str(), |(_, r)| r);
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    let host_port = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    if mentions_port(host_port) && (mentions_loopback(host_port) || is_loopback_host(host_port)) {
        return deny(format!("blocked {url}: {SERVER} {USE_MCP}"));
    }
    Decision::Allow
}

fn is_loopback_host(host_port: &str) -> bool {
    let host = host_port.rsplit_once(':').map_or(host_port, |(h, _)| h);
    host.is_empty() || host.starts_with("127") || host.ends_with(".localhost")
}

// ---------------------------------------------------------------------------------------------
// Shell commands

/// Two views of the command: escapes as path separators, and escapes removed.
fn variants(cmd: &str) -> [String; 2] {
    let lower = cmd
        .to_lowercase()
        .replace("\\\r\n", " ")
        .replace("\\\n", " ")
        .replace("`\r\n", " ")
        .replace("`\n", " ")
        .replace("^\r\n", " ")
        .replace("^\n", " ");
    let stripped: String = lower
        .chars()
        .filter(|c| !matches!(c, '"' | '\'' | '^'))
        .collect();
    let slashes = stripped.replace('\\', "/");
    let unescaped: String = stripped
        .chars()
        .filter(|c| !matches!(c, '\\' | '`'))
        .collect();
    [slashes, unescaped]
}

fn segments(text: &str) -> impl Iterator<Item = Vec<String>> + '_ {
    text.split(['\n', '\r', ';', '&', '|', '(', ')', '{', '}', '`'])
        .map(|seg| {
            seg.split(|c: char| c.is_whitespace() || matches!(c, ',' | '<' | '>'))
                .filter(|t| !t.is_empty())
                .map(program_name)
                .collect::<Vec<_>>()
        })
        .filter(|tokens| !tokens.is_empty())
}

/// `C:/Windows/System32/curl.exe` → `curl`; `@echo` → `echo`.
fn program_name(token: &str) -> String {
    let t = token.trim_start_matches('@');
    let base = if t.contains("://") {
        t
    } else {
        t.rsplit('/').next().unwrap_or(t)
    };
    for ext in [".exe", ".cmd", ".bat", ".com", ".ps1"] {
        if let Some(stem) = base.strip_suffix(ext) {
            if !stem.is_empty() {
                return stem.to_string();
            }
        }
    }
    base.to_string()
}

fn is_flag(t: &str) -> bool {
    t.starts_with('-') || (t.starts_with('/') && t.len() <= 3)
}

fn next_word(tokens: &[String]) -> Option<&str> {
    tokens.iter().map(String::as_str).find(|t| !is_flag(t))
}

const HTTP_CLIENTS: [&str; 30] = [
    "curl",
    "wget",
    "invoke-webrequest",
    "iwr",
    "invoke-restmethod",
    "irm",
    "nc",
    "ncat",
    "netcat",
    "socat",
    "telnet",
    "http",
    "https",
    "xh",
    "aria2c",
    "lynx",
    "w3m",
    "node",
    "nodejs",
    "deno",
    "bun",
    "python",
    "python3",
    "py",
    "ruby",
    "perl",
    "php",
    "start-bitstransfer",
    "test-netconnection",
    "openssl",
];
const HTTP_HINTS: [&str; 9] = [
    "fetch",
    "urllib",
    "http.client",
    "requests",
    "webclient",
    "httpclient",
    "tcpclient",
    "socket",
    "xmlhttp",
];

const SAFE_AZURE_HUMAN: [&str; 6] = ["login", "keys", "install", "uninstall", "update", "down"];
const DOCKER_TOOLS: [&str; 5] = [
    "docker",
    "docker-compose",
    "podman",
    "podman-compose",
    "nerdctl",
];
const DOCKER_SUBS: [&str; 10] = [
    "exec", "cp", "inspect", "logs", "attach", "export", "commit", "diff", "top", "debug",
];
const SHELLS: [&str; 14] = [
    "sh",
    "bash",
    "zsh",
    "dash",
    "iex",
    "invoke-expression",
    "eval",
    "source",
    "pwsh",
    "powershell",
    "cmd",
    "python",
    "python3",
    "node",
];

fn check_command(cmd: &str, env: &Env) -> Decision {
    for text in variants(cmd) {
        if let Some(reason) = sensitive_location(&text, env) {
            return deny(reason);
        }
        if is_claude_settings(&text) || text.contains(".claude/skills/safe-azure") {
            return deny(format!(
                "blocked a shell command that touches Claude Code settings: {SETTINGS}"
            ));
        }
        let segs: Vec<Vec<String>> = segments(&text).collect();
        for tokens in &segs {
            if let Some(reason) = check_tokens(tokens) {
                return deny(reason);
            }
        }
        if mentions_port(&text) {
            let client = segs.iter().flatten().any(|t| {
                HTTP_CLIENTS.contains(&t.as_str()) || HTTP_HINTS.iter().any(|h| t.contains(h))
            });
            if client || mentions_loopback(&text) {
                return deny(format!(
                    "blocked a command aimed at port 8765: {SERVER} {USE_MCP}"
                ));
            }
        }
        let decodes = [
            "frombase64string",
            "base64 -d",
            "base64 --decode",
            "certutil -decode",
            "-decode ",
        ]
        .iter()
        .any(|d| text.contains(d));
        if decodes && segs.iter().flatten().any(|t| SHELLS.contains(&t.as_str())) {
            return deny(
                "blocked a command that decodes and runs hidden text, which the guard cannot \
                 inspect. Run the command in plain text.",
            );
        }
    }
    Decision::Allow
}

fn check_tokens(tokens: &[String]) -> Option<String> {
    for (i, t) in tokens.iter().enumerate() {
        let rest = &tokens[i + 1..];
        match t.as_str() {
            "safe-azure" => {
                if let Some(sub) = next_word(rest).filter(|s| SAFE_AZURE_HUMAN.contains(s)) {
                    return Some(format!(
                        "`safe-azure {sub}` is for the human only (it handles device codes, keys or \
                         the container). Ask the user to run `safe-azure {sub}` in their own terminal. \
                         {USE_MCP}"
                    ));
                }
            }
            "az" => {
                return Some(format!(
                    "the Azure CLI (`az`) is blocked: it can mint tokens (`az account \
                     get-access-token`, `az rest`) and prints raw tenant, subscription and resource \
                     IDs. {USE_MCP} If a login is needed, ask the user to run `safe-azure login \
                     <context>` in their own terminal."
                ));
            }
            "azd" if next_word(rest) == Some("auth") => {
                return Some(format!(
                    "`azd auth` handles Azure tokens and is blocked. {USE_MCP}"
                ));
            }
            "powershell" | "pwsh" if rest.iter().any(|f| is_encoded_flag(f)) => {
                return Some(
                    "`-EncodedCommand` hides the command from the guard. Run the command in \
                     plain text."
                        .to_string(),
                );
            }
            name if DOCKER_TOOLS.contains(&name) => {
                if let Some(sub) = rest.iter().find(|s| DOCKER_SUBS.contains(&s.as_str())) {
                    return Some(format!(
                        "`{name} {sub}` is blocked: it can read the server keys, the environment or \
                         the logs of the azure-safe-mcp container. Ask the user to run `safe-azure \
                         doctor` in their own terminal for container diagnostics. {USE_MCP}"
                    ));
                }
                let first = next_word(rest);
                if rest.iter().any(|s| s.contains("azure-safe-mcp"))
                    && !matches!(first, Some("ps" | "stats" | "images" | "version"))
                {
                    return Some(format!(
                        "commands that target the azure-safe-mcp container are blocked. Ask the user \
                         to run `safe-azure up`, `safe-azure down` or `safe-azure doctor` in their \
                         own terminal. {USE_MCP}"
                    ));
                }
            }
            name if is_az_cmdlet(name) => {
                return Some(format!(
                    "Azure PowerShell (`{name}`) is blocked: it can mint tokens and prints raw IDs. \
                     {USE_MCP}"
                ));
            }
            _ => {}
        }
    }
    None
}

/// `-e`, `-ec`, `-enc`, … `-EncodedCommand` (PowerShell accepts any unambiguous prefix).
fn is_encoded_flag(flag: &str) -> bool {
    let body = flag.strip_prefix('-').or_else(|| flag.strip_prefix('/'));
    body.is_some_and(|b| !b.is_empty() && ("encodedcommand".starts_with(b) || b == "ec"))
}

/// `Get-AzAccessToken`, `Connect-AzAccount`, `Get-AzContext`… (verb-noun with an `Az` noun).
fn is_az_cmdlet(token: &str) -> bool {
    const VERBS: [&str; 20] = [
        "get",
        "set",
        "new",
        "remove",
        "connect",
        "disconnect",
        "invoke",
        "select",
        "clear",
        "save",
        "import",
        "export",
        "enable",
        "disable",
        "update",
        "start",
        "stop",
        "add",
        "test",
        "resolve",
    ];
    token.split_once("-az").is_some_and(|(verb, noun)| {
        VERBS.contains(&verb)
            && noun.chars().next().is_some_and(|c| c.is_ascii_alphabetic())
            && noun.chars().all(|c| c.is_ascii_alphanumeric())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn env() -> Env {
        Env {
            home: Some("c:/users/alice".into()),
            config_dir: Some("c:/users/alice/appdata/roaming/safe-azure".into()),
        }
    }

    fn event(tool: &str, input: &Value) -> String {
        json!({
            "session_id": "s",
            "hook_event_name": "PreToolUse",
            "cwd": "c:/users/alice/dev/app",
            "tool_name": tool,
            "tool_input": input,
        })
        .to_string()
    }

    fn shell(tool: &str, cmd: &str) -> String {
        event(tool, &json!({ "command": cmd }))
    }

    const ALLOW: bool = true;
    const DENY: bool = false;

    #[test]
    #[allow(clippy::too_many_lines)]
    fn table() {
        let cases: Vec<(&str, String, bool)> = vec![
            // --- plain dev work is allowed
            ("ls", shell("Bash", "ls -la"), ALLOW),
            ("git status", shell("Bash", "git status && git diff"), ALLOW),
            ("npm test", shell("Bash", "npm run check"), ALLOW),
            (
                "cargo",
                shell("Bash", "cd cli && cargo test --locked"),
                ALLOW,
            ),
            ("grep port", shell("Bash", "grep -rn 8765 src"), ALLOW),
            (
                "curl other",
                shell("Bash", "curl https://example.com/api"),
                ALLOW,
            ),
            (
                "curl other loopback port",
                shell("Bash", "curl http://localhost:3000/"),
                ALLOW,
            ),
            (
                "azure word",
                shell("Bash", "cat azure-pipelines.yml"),
                ALLOW,
            ),
            (
                "azure folder name",
                shell("Bash", "ls src/azure/ docs/.azurerc"),
                ALLOW,
            ),
            (
                "safe-azure status",
                shell("Bash", "safe-azure status"),
                ALLOW,
            ),
            (
                "safe-azure doctor",
                shell("PowerShell", "safe-azure.exe doctor"),
                ALLOW,
            ),
            (
                "safe-azure hook",
                shell("Bash", "echo {} | safe-azure hook claude"),
                ALLOW,
            ),
            (
                "docker ps",
                shell("Bash", "docker ps --filter name=azure-safe-mcp"),
                ALLOW,
            ),
            (
                "docker build",
                shell("Bash", "docker build -t app ."),
                ALLOW,
            ),
            (
                "ps get-childitem",
                shell("PowerShell", "Get-ChildItem -Recurse src"),
                ALLOW,
            ),
            (
                "ps azure word",
                shell("PowerShell", "Get-Content docs/azure.md"),
                ALLOW,
            ),
            (
                "pwsh file",
                shell("PowerShell", "pwsh -File build.ps1 -ExecutionPolicy Bypass"),
                ALLOW,
            ),
            (
                "read src",
                event(
                    "Read",
                    &json!({"file_path": "C:\\Users\\alice\\dev\\app\\src\\main.ts"}),
                ),
                ALLOW,
            ),
            (
                "read claude settings",
                event(
                    "Read",
                    &json!({"file_path": "C:/Users/alice/.claude/settings.json"}),
                ),
                ALLOW,
            ),
            (
                "write src",
                event(
                    "Write",
                    &json!({"file_path": "/home/bob/app/a.ts", "content": "x"}),
                ),
                ALLOW,
            ),
            (
                "glob ts",
                event("Glob", &json!({"pattern": "**/*.ts"})),
                ALLOW,
            ),
            (
                "grep project",
                event("Grep", &json!({"pattern": "token", "path": "src"})),
                ALLOW,
            ),
            (
                "grep pattern mentions azure",
                event("Grep", &json!({"pattern": "\\.azure"})),
                ALLOW,
            ),
            (
                "webfetch docs",
                event(
                    "WebFetch",
                    &json!({"url": "https://code.claude.com/docs", "prompt": "x"}),
                ),
                ALLOW,
            ),
            (
                "unknown tool",
                event("TodoWrite", &json!({"todos": []})),
                ALLOW,
            ),
            (
                "mcp tool",
                event("mcp__safe-azure__run_kql", &json!({"query": "AppRequests"})),
                ALLOW,
            ),
            // --- safe-azure human-only commands
            ("sa login", shell("Bash", "safe-azure login prod"), DENY),
            ("sa keys", shell("Bash", "safe-azure keys"), DENY),
            (
                "sa install",
                shell(
                    "PowerShell",
                    "& 'C:\\Program Files\\safe-azure\\safe-azure.exe' install -y",
                ),
                DENY,
            ),
            (
                "sa uninstall",
                shell("Bash", "safe-azure uninstall --purge"),
                DENY,
            ),
            (
                "sa update",
                shell("Bash", "~/.cargo/bin/safe-azure update"),
                DENY,
            ),
            ("sa down", shell("Bash", "true; safe-azure down"), DENY),
            // --- az and Azure PowerShell
            (
                "az token",
                shell("Bash", "az account get-access-token"),
                DENY,
            ),
            ("az show", shell("Bash", "az account show -o json"), DENY),
            (
                "az login",
                shell("Bash", "AZURE_CONFIG_DIR=/tmp/x az login --use-device-code"),
                DENY,
            ),
            ("az ad", shell("Bash", "az ad signed-in-user show"), DENY),
            (
                "az rest",
                shell(
                    "Bash",
                    "az rest --url https://management.azure.com/subscriptions",
                ),
                DENY,
            ),
            ("az.cmd", shell("PowerShell", "az.cmd account list"), DENY),
            (
                "az in subshell",
                shell("Bash", "echo $(az account show)"),
                DENY,
            ),
            (
                "az in backticks",
                shell("Bash", "echo `az account show`"),
                DENY,
            ),
            ("az quoted", shell("Bash", "\"az\" 'login'"), DENY),
            ("az escaped", shell("Bash", "a\\z login"), DENY),
            (
                "az bash -c",
                shell("Bash", "bash -c 'az account get-access-token'"),
                DENY,
            ),
            (
                "az cmd /c",
                shell("PowerShell", "cmd /c \"az account show\""),
                DENY,
            ),
            ("az caret", shell("PowerShell", "cmd /c a^z login"), DENY),
            (
                "az full path",
                shell(
                    "PowerShell",
                    "& \"C:\\Program Files\\Microsoft SDKs\\Azure\\CLI2\\wbin\\az.cmd\" login",
                ),
                DENY,
            ),
            (
                "az continuation",
                shell("Bash", "az \\\n account show"),
                DENY,
            ),
            (
                "Get-AzAccessToken",
                shell("PowerShell", "Get-AzAccessToken -AsSecureString"),
                DENY,
            ),
            (
                "Connect-AzAccount",
                shell("PowerShell", "Connect-AzAccount -UseDeviceAuthentication"),
                DENY,
            ),
            ("azd auth", shell("Bash", "azd auth token"), DENY),
            // --- docker
            (
                "docker exec",
                shell(
                    "Bash",
                    "docker exec azure-safe-mcp cat /run/safe-azure/keys.json",
                ),
                DENY,
            ),
            (
                "docker exec other",
                shell("Bash", "docker exec -it web sh"),
                DENY,
            ),
            (
                "docker cp",
                shell("Bash", "docker cp azure-safe-mcp:/run/safe-azure ."),
                DENY,
            ),
            (
                "docker inspect",
                shell("PowerShell", "docker inspect $(docker ps -q)"),
                DENY,
            ),
            (
                "docker logs",
                shell("Bash", "docker logs -f azure-safe-mcp 2>&1 | head"),
                DENY,
            ),
            (
                "docker attach",
                shell("Bash", "docker attach azure-safe-mcp"),
                DENY,
            ),
            (
                "docker compose exec",
                shell("Bash", "docker compose exec mcp sh"),
                DENY,
            ),
            (
                "docker compose logs",
                shell("Bash", "docker-compose logs mcp"),
                DENY,
            ),
            (
                "docker --context exec",
                shell("Bash", "docker --context default exec x id"),
                DENY,
            ),
            (
                "docker run pid",
                shell(
                    "Bash",
                    "docker run --rm --pid=container:azure-safe-mcp alpine cat /proc/1/root/run/x",
                ),
                DENY,
            ),
            (
                "podman exec",
                shell("Bash", "podman exec azure-safe-mcp env"),
                DENY,
            ),
            // --- the server port
            (
                "curl login",
                shell("Bash", "curl http://127.0.0.1:8765/admin/contexts"),
                DENY,
            ),
            (
                "curl localhost",
                shell("Bash", "curl -s localhost:8765/mcp"),
                DENY,
            ),
            (
                "curl ipv6",
                shell("Bash", "curl 'http://[::1]:8765/healthz'"),
                DENY,
            ),
            (
                "wget",
                shell("Bash", "wget -qO- http://0.0.0.0:8765/mcp"),
                DENY,
            ),
            (
                "curl decimal ip",
                shell("Bash", "curl http://2130706433:8765/"),
                DENY,
            ),
            (
                "iwr",
                shell("PowerShell", "iwr http://localhost:8765/mcp -Method Post"),
                DENY,
            ),
            (
                "Invoke-RestMethod",
                shell(
                    "PowerShell",
                    "Invoke-RestMethod -Uri \"http://127.0.0.1:8765/admin/login\"",
                ),
                DENY,
            ),
            (
                "irm var port",
                shell("PowerShell", "$p = 8765; irm \"http://localhost:$p/mcp\""),
                DENY,
            ),
            (
                "node fetch",
                shell(
                    "Bash",
                    "node -e \"fetch('http://127.0.0.1:8765/mcp').then(r=>r.text())\"",
                ),
                DENY,
            ),
            (
                "python urllib",
                shell(
                    "Bash",
                    "python -c 'import urllib.request as u; print(u.urlopen(\"http://localhost:8765\").read())'",
                ),
                DENY,
            ),
            ("nc", shell("Bash", "nc 127.0.0.1 8765"), DENY),
            (
                "dev tcp",
                shell("Bash", "exec 3<>/dev/tcp/127.0.0.1/8765"),
                DENY,
            ),
            (
                "webclient",
                shell(
                    "PowerShell",
                    "(New-Object Net.WebClient).DownloadString('http://localhost:8765')",
                ),
                DENY,
            ),
            (
                "port leading zero",
                shell("Bash", "curl http://127.0.0.1:08765/"),
                DENY,
            ),
            // --- sensitive files from the shell
            (
                "cat azure cache",
                shell("Bash", "cat ~/.azure/msal_token_cache.json"),
                DENY,
            ),
            (
                "ps azure cache",
                shell(
                    "PowerShell",
                    "Get-Content $env:USERPROFILE\\.azure\\azureProfile.json",
                ),
                DENY,
            ),
            (
                "type azure cache",
                shell(
                    "PowerShell",
                    "cmd /c type %USERPROFILE%\\.azure\\accessTokens.json",
                ),
                DENY,
            ),
            ("azure dir ls", shell("Bash", "cd ~ && ls .azure"), DENY),
            (
                "identity service",
                shell("PowerShell", "dir $env:LOCALAPPDATA\\.IdentityService"),
                DENY,
            ),
            ("keys.bin", shell("Bash", "xxd keys.bin"), DENY),
            (
                "appdata config",
                shell("PowerShell", "gci $env:APPDATA\\safe-azure"),
                DENY,
            ),
            (
                "xdg config",
                shell("Bash", "cat ~/.config/safe-azure/contexts.yaml"),
                DENY,
            ),
            (
                "join-path config",
                shell("PowerShell", "Join-Path $env:APPDATA 'safe-azure' | gci"),
                DENY,
            ),
            (
                "contexts yaml",
                shell("Bash", "cat config/contexts.yaml"),
                DENY,
            ),
            // --- self-protection
            (
                "edit settings shell",
                shell("Bash", "jq 'del(.hooks)' ~/.claude/settings.json > x"),
                DENY,
            ),
            (
                "ps settings",
                shell(
                    "PowerShell",
                    "Set-Content $HOME\\.claude\\settings.json '{}'",
                ),
                DENY,
            ),
            (
                "disable hooks",
                shell(
                    "Bash",
                    "echo '{\"disableAllHooks\": true}' > .claude/x.json",
                ),
                DENY,
            ),
            (
                "encoded command",
                shell("PowerShell", "powershell -NoProfile -enc SQBFAFgA"),
                DENY,
            ),
            ("encoded pwsh -e", shell("Bash", "pwsh -e SQBFAFgA"), DENY),
            (
                "base64 pipe sh",
                shell("Bash", "echo YXogbG9naW4= | base64 -d | sh"),
                DENY,
            ),
            (
                "frombase64 iex",
                shell(
                    "PowerShell",
                    "iex ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('YXo=')))",
                ),
                DENY,
            ),
            // --- file tools
            (
                "read azure",
                event(
                    "Read",
                    &json!({"file_path": "C:\\Users\\alice\\.azure\\msal_token_cache.json"}),
                ),
                DENY,
            ),
            (
                "read azure posix",
                event(
                    "Read",
                    &json!({"file_path": "/home/bob/.azure/azureProfile.json"}),
                ),
                DENY,
            ),
            (
                "read azure gitbash",
                event("Read", &json!({"file_path": "/c/Users/alice/.azure/x"})),
                DENY,
            ),
            (
                "read keys",
                event(
                    "Read",
                    &json!({"file_path": "C:\\Users\\alice\\AppData\\Roaming\\safe-azure\\keys.bin"}),
                ),
                DENY,
            ),
            (
                "read contexts",
                event(
                    "Read",
                    &json!({"file_path": "/home/bob/.config/safe-azure/contexts.yaml"}),
                ),
                DENY,
            ),
            (
                "read macos config",
                event(
                    "Read",
                    &json!({"file_path": "/Users/bob/Library/Application Support/safe-azure/x"}),
                ),
                DENY,
            ),
            (
                "write settings",
                event(
                    "Write",
                    &json!({"file_path": "C:\\Users\\alice\\.claude\\settings.json", "content": "{}"}),
                ),
                DENY,
            ),
            (
                "edit settings",
                event(
                    "Edit",
                    &json!({"file_path": "/home/bob/.claude/settings.json", "old_string": "a", "new_string": "b"}),
                ),
                DENY,
            ),
            (
                "multiedit local settings",
                event(
                    "MultiEdit",
                    &json!({"file_path": "/repo/.claude/settings.local.json", "edits": []}),
                ),
                DENY,
            ),
            (
                "write skill",
                event(
                    "Write",
                    &json!({"file_path": "/home/bob/.claude/skills/safe-azure/SKILL.md", "content": ""}),
                ),
                DENY,
            ),
            (
                "notebook azure",
                event(
                    "NotebookEdit",
                    &json!({"notebook_path": "/home/bob/.azure/x.ipynb", "new_source": ""}),
                ),
                DENY,
            ),
            (
                "glob azure",
                event("Glob", &json!({"pattern": "**/.azure/**"})),
                DENY,
            ),
            (
                "glob path azure",
                event(
                    "Glob",
                    &json!({"pattern": "*", "path": "C:\\Users\\alice\\.azure"}),
                ),
                DENY,
            ),
            (
                "grep azure",
                event("Grep", &json!({"pattern": "refresh", "path": "~/.azure"})),
                DENY,
            ),
            (
                "grep home",
                event(
                    "Grep",
                    &json!({"pattern": "refresh_token", "path": "C:\\Users\\alice"}),
                ),
                DENY,
            ),
            (
                "grep users",
                event("Grep", &json!({"pattern": "x", "path": "C:/Users"})),
                DENY,
            ),
            (
                "grep tilde",
                event("Grep", &json!({"pattern": "x", "path": "~"})),
                DENY,
            ),
            (
                "grep dotdot",
                event("Grep", &json!({"pattern": "x", "path": "../.."})),
                DENY,
            ),
            (
                "grep glob azure",
                event("Grep", &json!({"pattern": "x", "glob": ".azure/*"})),
                DENY,
            ),
            // --- WebFetch
            (
                "webfetch server",
                event(
                    "WebFetch",
                    &json!({"url": "http://127.0.0.1:8765/admin/contexts", "prompt": "x"}),
                ),
                DENY,
            ),
            (
                "webfetch localhost",
                event(
                    "WebFetch",
                    &json!({"url": "http://localhost:8765/", "prompt": "x"}),
                ),
                DENY,
            ),
            (
                "webfetch ipv6",
                event(
                    "WebFetch",
                    &json!({"url": "http://[::1]:8765/mcp", "prompt": "x"}),
                ),
                DENY,
            ),
            (
                "webfetch userinfo",
                event(
                    "WebFetch",
                    &json!({"url": "http://a@127.0.0.2:8765/", "prompt": "x"}),
                ),
                DENY,
            ),
            (
                "webfetch other port",
                event(
                    "WebFetch",
                    &json!({"url": "http://localhost:3000/", "prompt": "x"}),
                ),
                ALLOW,
            ),
            // --- fail closed
            ("malformed json", "{not json".to_string(), DENY),
            ("no tool name", json!({"tool_input": {}}).to_string(), DENY),
            ("bash no command", event("Bash", &json!({})), DENY),
            (
                "bash command not string",
                event("Bash", &json!({"command": ["az", "login"]})),
                DENY,
            ),
            ("read no path", event("Read", &json!({"limit": 3})), DENY),
            (
                "grep path not string",
                event("Grep", &json!({"pattern": "x", "path": 3})),
                DENY,
            ),
            (
                "webfetch no url",
                event("WebFetch", &json!({"prompt": "x"})),
                DENY,
            ),
            (
                "input not object",
                json!({"tool_name": "Write", "tool_input": "x"}).to_string(),
                DENY,
            ),
            (
                "unknown tool with command",
                event("Monitor", &json!({"command": "az login"})),
                DENY,
            ),
        ];
        assert!(cases.len() >= 60, "only {} cases", cases.len());
        let env = env();
        let mut failures = Vec::new();
        for (name, raw, allowed) in &cases {
            let got = evaluate(raw, &env);
            if (got == Decision::Allow) != *allowed {
                failures.push(format!("{name}: expected allow={allowed}, got {got:?}"));
            }
            if let Decision::Deny(reason) = got {
                assert!(reason.starts_with(PREFIX), "{name}: {reason}");
            }
        }
        assert!(failures.is_empty(), "{}", failures.join("\n"));
    }

    #[test]
    fn deny_reason_says_what_to_do() {
        let Decision::Deny(reason) = evaluate(&shell("Bash", "safe-azure login prod"), &env())
        else {
            panic!("expected deny");
        };
        assert!(
            reason.contains("Ask the user to run `safe-azure login`"),
            "{reason}"
        );
        let Decision::Deny(reason) = evaluate(&shell("Bash", "az account show"), &env()) else {
            panic!("expected deny");
        };
        assert!(reason.contains("safe-azure MCP tools"), "{reason}");
    }

    #[test]
    fn grep_without_path_uses_cwd() {
        let raw =
            json!({"tool_name": "Grep", "cwd": "C:\\Users\\alice", "tool_input": {"pattern": "x"}})
                .to_string();
        assert!(matches!(evaluate(&raw, &env()), Decision::Deny(_)));
        let raw = json!({"tool_name": "Grep", "cwd": "C:\\Users\\alice\\dev", "tool_input": {"pattern": "x"}}).to_string();
        assert_eq!(evaluate(&raw, &env()), Decision::Allow);
    }
}
