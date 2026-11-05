//! Merge of our `PreToolUse` entry into `<claude_dir>/settings.json` (ADR 0001 §5).
//!
//! Every other key and hook is kept (key order too). The file is backed up before each change
//! and replaced atomically. A file that is not valid JSON is refused and left untouched.

use anyhow::{Context, Result, bail};
use serde_json::{Map, Value, json};
use std::fs;
use std::path::{Path, PathBuf};

pub const SETTINGS: &str = "settings.json";
pub const BACKUP: &str = "settings.json.safe-azure.bak";
const TEMP: &str = "settings.json.safe-azure.tmp";
const EVENT: &str = "PreToolUse";
/// Seconds. The hook answers in milliseconds; Claude Code's default is 600.
const TIMEOUT_SECS: u64 = 10;

/// The shell-form command Claude Code runs: `<exe> hook claude`.
///
/// Forward slashes on Windows work in both Git Bash and PowerShell. The path is quoted only
/// when it needs it, because a quoted program is a syntax error in PowerShell (the shell Claude
/// Code falls back to when Git Bash is missing).
pub fn hook_command(exe: &Path) -> String {
    let raw = exe.to_string_lossy();
    let mut path = raw.strip_prefix(r"\\?\").unwrap_or(&raw).to_string();
    if cfg!(windows) {
        path = path.replace('\\', "/");
    }
    let needs_quotes = path
        .chars()
        .any(|c| c.is_whitespace() || "\"'$`&|;()<>!*?[]{}#~".contains(c));
    if needs_quotes {
        let escaped: String = path
            .chars()
            .flat_map(|c| {
                let esc = matches!(c, '"' | '\\' | '$' | '`').then_some('\\');
                esc.into_iter().chain(std::iter::once(c))
            })
            .collect();
        format!("\"{escaped}\" hook claude")
    } else {
        format!("{path} hook claude")
    }
}

/// The program path of a hook command if it is ours (`…/safe-azure[.exe] hook claude`).
pub fn our_exe(command: &str) -> Option<String> {
    let c = command.trim().trim_start_matches('&').trim_start();
    let (exe, rest) = if let Some(r) = c.strip_prefix('"') {
        let mut out = String::new();
        let mut chars = r.char_indices();
        let mut end = None;
        while let Some((i, ch)) = chars.next() {
            match ch {
                '\\' => {
                    if let Some((_, next)) = chars.next() {
                        out.push(next);
                    }
                }
                '"' => {
                    end = Some(i + 1);
                    break;
                }
                other => out.push(other),
            }
        }
        (out, &r[end?..])
    } else if let Some(r) = c.strip_prefix('\'') {
        let end = r.find('\'')?;
        (r[..end].to_string(), &r[end + 1..])
    } else {
        let end = c.find(char::is_whitespace)?;
        (c[..end].to_string(), &c[end..])
    };
    if rest.split_whitespace().ne(["hook", "claude"]) {
        return None;
    }
    let base = exe.rsplit(['/', '\\']).next()?.to_ascii_lowercase();
    (base == "safe-azure" || base == "safe-azure.exe").then_some(exe)
}

fn is_ours(hook: &Value) -> bool {
    hook.get("command")
        .and_then(Value::as_str)
        .and_then(our_exe)
        .is_some()
}

fn read_settings(path: &Path) -> Result<Option<String>> {
    match fs::read_to_string(path) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e).with_context(|| format!("cannot read {}", path.display())),
    }
}

fn parse(path: &Path, text: Option<&str>) -> Result<Map<String, Value>> {
    let Some(text) = text.filter(|t| !t.trim().is_empty()) else {
        return Ok(Map::new());
    };
    match serde_json::from_str::<Value>(text) {
        Ok(Value::Object(map)) => Ok(map),
        Ok(_) => bail!("{} is not a JSON object; left untouched", path.display()),
        Err(e) => bail!(
            "{} is not valid JSON ({e}); left untouched. Fix it, then run the command again",
            path.display()
        ),
    }
}

/// `hooks.PreToolUse`, created when missing. Refuses unexpected shapes.
fn pre_tool_use<'a>(root: &'a mut Map<String, Value>, path: &Path) -> Result<&'a mut Vec<Value>> {
    let hooks = root.entry("hooks").or_insert_with(|| json!({}));
    let Value::Object(hooks) = hooks else {
        bail!(
            "`hooks` in {} is not an object; left untouched",
            path.display()
        );
    };
    let groups = hooks.entry(EVENT).or_insert_with(|| json!([]));
    let Value::Array(groups) = groups else {
        bail!(
            "`hooks.{EVENT}` in {} is not an array; left untouched",
            path.display()
        );
    };
    Ok(groups)
}

fn group_hooks(group: &mut Value) -> Option<&mut Vec<Value>> {
    group.get_mut("hooks").and_then(Value::as_array_mut)
}

/// Removes our hooks everywhere and drops groups left empty by that.
fn remove_ours(groups: &mut Vec<Value>) {
    groups.retain_mut(|group| {
        let Some(hooks) = group_hooks(group) else {
            return true;
        };
        let before = hooks.len();
        hooks.retain(|h| !is_ours(h));
        !(hooks.is_empty() && before > 0)
    });
}

/// Drops `hooks.PreToolUse` and `hooks` when they are empty.
fn prune(root: &mut Map<String, Value>) {
    if let Some(Value::Object(hooks)) = root.get_mut("hooks") {
        if hooks
            .get(EVENT)
            .and_then(Value::as_array)
            .is_some_and(Vec::is_empty)
        {
            hooks.remove(EVENT);
        }
        if hooks.is_empty() {
            root.remove("hooks");
        }
    }
}

fn upsert(root: &mut Map<String, Value>, path: &Path, command: &str) -> Result<()> {
    let groups = pre_tool_use(root, path)?;
    let desired = json!({ "type": "command", "command": command, "timeout": TIMEOUT_SECS });
    // Update the first entry of ours in place (exe moved or updated), drop any duplicate.
    let mut found = None;
    for (g, group) in groups.iter_mut().enumerate() {
        if let Some(hooks) = group_hooks(group) {
            if let Some(h) = hooks.iter().position(is_ours) {
                found = Some((g, h));
                break;
            }
        }
    }
    let Some((g, h)) = found else {
        groups.push(json!({ "matcher": "*", "hooks": [desired] }));
        return Ok(());
    };
    let group = &mut groups[g];
    // A group that only holds our hook must match every tool.
    if group_hooks(group).is_some_and(|hooks| hooks.len() == 1) {
        if let Value::Object(fields) = group {
            fields.insert("matcher".into(), json!("*"));
        }
    }
    if let Some(Value::Object(target)) = group_hooks(group).and_then(|hooks| hooks.get_mut(h)) {
        if let Value::Object(fields) = desired {
            target.extend(fields);
        }
    }
    // Keep the first entry of ours, drop any duplicate.
    let mut seen = false;
    groups.retain_mut(|group| {
        let Some(hooks) = group_hooks(group) else {
            return true;
        };
        let before = hooks.len();
        hooks.retain(|hook| {
            if !is_ours(hook) {
                return true;
            }
            let keep = !seen;
            seen = true;
            keep
        });
        !(hooks.is_empty() && before > 0)
    });
    Ok(())
}

fn write_atomic(claude_dir: &Path, root: &Map<String, Value>, had_file: bool) -> Result<()> {
    fs::create_dir_all(claude_dir)
        .with_context(|| format!("cannot create {}", claude_dir.display()))?;
    let path = claude_dir.join(SETTINGS);
    if had_file {
        fs::copy(&path, claude_dir.join(BACKUP))
            .with_context(|| format!("cannot back up {}", path.display()))?;
    }
    let mut text = serde_json::to_string_pretty(root)?;
    text.push('\n');
    let temp: PathBuf = claude_dir.join(TEMP);
    fs::write(&temp, text).with_context(|| format!("cannot write {}", temp.display()))?;
    if let Err(e) = fs::rename(&temp, &path) {
        let _ = fs::remove_file(&temp);
        return Err(e).with_context(|| format!("cannot replace {}", path.display()));
    }
    Ok(())
}

pub fn install(claude_dir: &Path, exe: &Path) -> Result<bool> {
    let path = claude_dir.join(SETTINGS);
    let original = read_settings(&path)?;
    let mut root = parse(&path, original.as_deref())?;
    let before = root.clone();
    upsert(&mut root, &path, &hook_command(exe))?;
    if root == before {
        return Ok(false);
    }
    write_atomic(claude_dir, &root, original.is_some())?;
    Ok(true)
}

pub fn uninstall(claude_dir: &Path) -> Result<bool> {
    let path = claude_dir.join(SETTINGS);
    let Some(original) = read_settings(&path)? else {
        return Ok(false);
    };
    let mut root = parse(&path, Some(&original))?;
    let before = root.clone();
    if let Some(Value::Object(hooks)) = root.get_mut("hooks") {
        if let Some(Value::Array(groups)) = hooks.get_mut(EVENT) {
            remove_ours(groups);
        }
    }
    prune(&mut root);
    if root == before {
        return Ok(false);
    }
    write_atomic(claude_dir, &root, true)?;
    Ok(true)
}

/// The exe paths of our entries, in order.
fn installed_exes(claude_dir: &Path) -> Vec<String> {
    let path = claude_dir.join(SETTINGS);
    let Ok(Some(text)) = read_settings(&path) else {
        return Vec::new();
    };
    let Ok(root) = parse(&path, Some(&text)) else {
        return Vec::new();
    };
    root.get("hooks")
        .and_then(|h| h.get(EVENT))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|g| g.get("hooks").and_then(Value::as_array))
        .flatten()
        .filter_map(|h| h.get("command").and_then(Value::as_str).and_then(our_exe))
        .collect()
}

pub fn is_installed(claude_dir: &Path) -> bool {
    installed_exes(claude_dir)
        .iter()
        .any(|exe| Path::new(exe).is_file())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn exe(dir: &TempDir, name: &str) -> PathBuf {
        let bin = dir.path().join(name);
        fs::create_dir_all(&bin).ok();
        let exe = bin.join(if cfg!(windows) {
            "safe-azure.exe"
        } else {
            "safe-azure"
        });
        fs::write(&exe, b"").ok();
        exe
    }

    fn read(dir: &Path) -> Value {
        let text = fs::read_to_string(dir.join(SETTINGS)).unwrap_or_default();
        serde_json::from_str(&text).unwrap_or(Value::Null)
    }

    fn ours(root: &Value) -> Vec<String> {
        root["hooks"][EVENT]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|g| g["hooks"].as_array())
            .flatten()
            .filter_map(|h| h["command"].as_str())
            .filter(|c| our_exe(c).is_some())
            .map(str::to_string)
            .collect()
    }

    #[test]
    fn creates_missing_file_and_is_idempotent() -> Result<()> {
        let tmp = TempDir::new()?;
        let claude = tmp.path().join(".claude");
        let exe = exe(&tmp, "bin");
        assert!(install(&claude, &exe)?);
        let root = read(&claude);
        assert_eq!(root["hooks"][EVENT][0]["matcher"], "*");
        assert_eq!(root["hooks"][EVENT][0]["hooks"][0]["type"], "command");
        assert_eq!(
            root["hooks"][EVENT][0]["hooks"][0]["command"],
            hook_command(&exe)
        );
        assert!(!claude.join(BACKUP).exists(), "nothing to back up");
        assert!(!install(&claude, &exe)?, "second install is a no-op");
        assert_eq!(ours(&read(&claude)).len(), 1);
        assert!(is_installed(&claude));
        Ok(())
    }

    #[test]
    fn keeps_other_keys_and_hooks_and_backs_up() -> Result<()> {
        let tmp = TempDir::new()?;
        let claude = tmp.path().to_path_buf();
        let original = r#"{
  "theme": "dark",
  "permissions": { "deny": ["Bash(rm:*)"] },
  "hooks": {
    "PreToolUse": [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "lint.sh" }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "notify" }] }]
  },
  "zzz": 1
}"#;
        fs::write(claude.join(SETTINGS), original)?;
        assert!(install(&claude, &exe(&tmp, "bin"))?);
        let root = read(&claude);
        assert_eq!(root["theme"], "dark");
        assert_eq!(root["permissions"]["deny"][0], "Bash(rm:*)");
        assert_eq!(root["hooks"]["Stop"][0]["hooks"][0]["command"], "notify");
        assert_eq!(root["hooks"][EVENT][0]["hooks"][0]["command"], "lint.sh");
        assert_eq!(ours(&root).len(), 1);
        // Key order is preserved.
        let text = fs::read_to_string(claude.join(SETTINGS))?;
        assert!(text.find("\"theme\"") < text.find("\"zzz\""));
        assert_eq!(fs::read_to_string(claude.join(BACKUP))?, original);
        assert!(!claude.join(TEMP).exists());
        Ok(())
    }

    #[test]
    fn refuses_malformed_file_and_leaves_it_untouched() -> Result<()> {
        let tmp = TempDir::new()?;
        let claude = tmp.path().to_path_buf();
        for bad in [
            "{ \"hooks\": [",
            "[1, 2]",
            "{\"hooks\": []}",
            "{\"hooks\": {\"PreToolUse\": {}}}",
        ] {
            fs::write(claude.join(SETTINGS), bad)?;
            assert!(install(&claude, &exe(&tmp, "bin")).is_err(), "{bad}");
            assert_eq!(fs::read_to_string(claude.join(SETTINGS))?, bad);
            assert!(!claude.join(BACKUP).exists());
            assert!(!is_installed(&claude));
        }
        fs::write(claude.join(SETTINGS), "{ nope")?;
        assert!(uninstall(&claude).is_err());
        assert_eq!(fs::read_to_string(claude.join(SETTINGS))?, "{ nope");
        Ok(())
    }

    #[test]
    fn updates_in_place_when_exe_moves() -> Result<()> {
        let tmp = TempDir::new()?;
        let claude = tmp.path().join("c");
        let old = exe(&tmp, "old");
        let new = exe(&tmp, "new dir");
        install(&claude, &old)?;
        // Another hook after ours, to check that the position is kept.
        let mut root = read(&claude);
        if let Some(groups) = root["hooks"][EVENT].as_array_mut() {
            groups.push(
                json!({ "matcher": "Bash", "hooks": [{ "type": "command", "command": "x" }] }),
            );
        }
        fs::write(claude.join(SETTINGS), serde_json::to_string(&root)?)?;
        assert!(install(&claude, &new)?);
        let root = read(&claude);
        assert_eq!(ours(&root), vec![hook_command(&new)]);
        assert_eq!(
            root["hooks"][EVENT][0]["hooks"][0]["command"],
            hook_command(&new)
        );
        assert_eq!(root["hooks"][EVENT][1]["hooks"][0]["command"], "x");
        assert!(hook_command(&new).starts_with('"'), "spaces are quoted");
        assert!(is_installed(&claude));
        fs::remove_file(&new)?;
        assert!(!is_installed(&claude), "binary is gone");
        Ok(())
    }

    #[test]
    fn removes_duplicates() -> Result<()> {
        let tmp = TempDir::new()?;
        let claude = tmp.path().to_path_buf();
        let dup = json!({ "hooks": { "PreToolUse": [
            { "matcher": "*", "hooks": [{ "type": "command", "command": "/a/safe-azure hook claude" }] },
            { "matcher": "*", "hooks": [{ "type": "command", "command": "\"C:/b c/safe-azure.exe\" hook claude" }] }
        ] } });
        fs::write(claude.join(SETTINGS), dup.to_string())?;
        let exe = exe(&tmp, "bin");
        assert!(install(&claude, &exe)?);
        assert_eq!(ours(&read(&claude)), vec![hook_command(&exe)]);
        Ok(())
    }

    #[test]
    fn uninstall_removes_only_ours() -> Result<()> {
        let tmp = TempDir::new()?;
        let claude = tmp.path().to_path_buf();
        assert!(!uninstall(&claude)?, "no file");
        fs::write(
            claude.join(SETTINGS),
            r#"{"model":"x","hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"lint.sh"}]}]}}"#,
        )?;
        install(&claude, &exe(&tmp, "bin"))?;
        assert!(uninstall(&claude)?);
        let root = read(&claude);
        assert_eq!(root["model"], "x");
        assert_eq!(root["hooks"][EVENT].as_array().map(Vec::len), Some(1));
        assert_eq!(root["hooks"][EVENT][0]["hooks"][0]["command"], "lint.sh");
        assert!(!uninstall(&claude)?, "idempotent");
        assert!(!is_installed(&claude));

        // A file with only our hook goes back to an empty object.
        let other = tmp.path().join("other");
        install(&other, &exe(&tmp, "bin"))?;
        assert!(uninstall(&other)?);
        assert_eq!(read(&other), json!({}));
        Ok(())
    }

    #[test]
    fn recognises_our_command_forms() {
        assert!(our_exe("/usr/local/bin/safe-azure hook claude").is_some());
        assert!(our_exe("\"C:/Program Files/safe-azure/safe-azure.exe\" hook claude").is_some());
        assert!(our_exe("& 'C:\\x y\\SAFE-AZURE.EXE'  hook  claude").is_some());
        assert!(our_exe("safe-azure hook claude --x").is_none());
        assert!(our_exe("/bin/other hook claude").is_none());
        assert!(our_exe("lint.sh").is_none());
        assert_eq!(
            hook_command(Path::new("/opt/bin/safe-azure")),
            "/opt/bin/safe-azure hook claude"
        );
        assert_eq!(
            hook_command(Path::new("/opt/my bin/safe-azure")),
            "\"/opt/my bin/safe-azure\" hook claude"
        );
        let quoted = hook_command(Path::new("/opt/my bin/safe-azure"));
        assert_eq!(our_exe(&quoted).as_deref(), Some("/opt/my bin/safe-azure"));
    }
}
