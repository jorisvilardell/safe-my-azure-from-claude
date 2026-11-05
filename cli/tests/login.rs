//! `safe-azure login` must refuse to run without a terminal (agent shells pipe stdio).

use assert_cmd::cargo::cargo_bin_cmd;
use predicates::str::contains;

#[test]
fn login_refuses_piped_stdio() {
    cargo_bin_cmd!("safe-azure")
        .args(["login", "prod", "--no-browser"])
        .write_stdin("")
        .assert()
        .failure()
        .stdout("")
        .stderr(contains("own interactive terminal"));
}

#[test]
fn login_without_context_refuses_too() {
    cargo_bin_cmd!("safe-azure")
        .arg("login")
        .write_stdin("")
        .assert()
        .failure()
        .stderr(contains("must be run by a human"));
}
