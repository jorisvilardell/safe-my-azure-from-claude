//! Runs the real binary as Claude Code does: event JSON on stdin, verdict in the exit code.

use assert_cmd::Command;
use predicates::prelude::*;

fn hook(stdin: &str) -> assert_cmd::assert::Assert {
    #[allow(clippy::expect_used)]
    let mut cmd = Command::cargo_bin("safe-azure").expect("binary is built");
    cmd.args(["hook", "claude"]).write_stdin(stdin).assert()
}

fn event(tool: &str, input: &serde_json::Value) -> String {
    serde_json::json!({
        "session_id": "test",
        "transcript_path": "/tmp/t.jsonl",
        "cwd": "/tmp",
        "permission_mode": "default",
        "hook_event_name": "PreToolUse",
        "tool_name": tool,
        "tool_input": input,
        "tool_use_id": "toolu_1",
    })
    .to_string()
}

#[test]
fn allows_ordinary_commands_silently() {
    hook(&event(
        "Bash",
        &serde_json::json!({ "command": "git status" }),
    ))
    .code(0)
    .stdout(predicate::str::is_empty())
    .stderr(predicate::str::is_empty());
}

#[test]
fn blocks_login_with_exit_2_and_a_reason() {
    hook(&event(
        "Bash",
        &serde_json::json!({ "command": "safe-azure login prod" }),
    ))
    .code(2)
    .stdout(predicate::str::is_empty())
    .stderr(predicate::str::contains("safe-azure guard:"))
    .stderr(predicate::str::contains(
        "Ask the user to run `safe-azure login`",
    ));
}

#[test]
fn blocks_the_powershell_tool_whatever_the_command() {
    hook(&event(
        "PowerShell",
        &serde_json::json!({ "command": "Get-Date" }),
    ))
    .code(2)
    .stdout(predicate::str::is_empty())
    .stderr(predicate::str::contains("PowerShell is blocked"));
}

#[test]
fn blocks_http_to_the_server() {
    hook(&event(
        "Bash",
        &serde_json::json!({ "command": "curl http://127.0.0.1:8765/admin/contexts" }),
    ))
    .code(2)
    .stdout(predicate::str::is_empty())
    .stderr(predicate::str::contains("port 8765"));
}

#[test]
fn blocks_reading_the_token_cache() {
    hook(&event(
        "Read",
        &serde_json::json!({ "file_path": "C:\\Users\\x\\.azure\\msal_token_cache.json" }),
    ))
    .code(2)
    .stderr(predicate::str::contains("token cache"));
}

#[test]
fn fails_closed_on_malformed_input() {
    hook("this is not json")
        .code(2)
        .stdout(predicate::str::is_empty())
        .stderr(predicate::str::contains("fail closed"));
    hook("").code(2);
}

#[test]
fn allows_unknown_tools() {
    hook(&event("TodoWrite", &serde_json::json!({ "todos": [] })))
        .code(0)
        .stdout(predicate::str::is_empty());
}
