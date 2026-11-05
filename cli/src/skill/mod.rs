//! Global Claude Code skill (`~/.claude/skills/safe-azure/SKILL.md`). Owned by the
//! "hook + skill" issue (#62). Signatures are a contract used by the install command.
#![allow(dead_code)]

use anyhow::{Context, Result};
use std::fs;
use std::path::{Path, PathBuf};

const TEMPLATE: &str = include_str!("SKILL.md");
const VERSION_PLACEHOLDER: &str = "{{SAFE_AZURE_VERSION}}";
const MARKER: &str = "<!-- safe-azure-skill-version: ";

/// The skill text for this CLI build.
pub fn render() -> String {
    TEMPLATE.replace(VERSION_PLACEHOLDER, env!("CARGO_PKG_VERSION"))
}

fn skill_dir(claude_dir: &Path) -> PathBuf {
    claude_dir.join("skills").join("safe-azure")
}

fn skill_file(claude_dir: &Path) -> PathBuf {
    skill_dir(claude_dir).join("SKILL.md")
}

/// The version written in a skill file, if it has our marker.
fn version_of(text: &str) -> Option<&str> {
    let start = text.find(MARKER)? + MARKER.len();
    let rest = &text[start..];
    let end = rest.find("-->")?;
    Some(rest[..end].trim())
}

/// Writes or updates the skill under `claude_dir`. Returns true when something changed.
pub fn install(claude_dir: &Path) -> Result<bool> {
    let file = skill_file(claude_dir);
    let wanted = render();
    if fs::read_to_string(&file).is_ok_and(|current| current == wanted) {
        return Ok(false);
    }
    let dir = skill_dir(claude_dir);
    fs::create_dir_all(&dir).with_context(|| format!("cannot create {}", dir.display()))?;
    let temp = dir.join("SKILL.md.safe-azure.tmp");
    fs::write(&temp, wanted).with_context(|| format!("cannot write {}", temp.display()))?;
    if let Err(e) = fs::rename(&temp, &file) {
        let _ = fs::remove_file(&temp);
        return Err(e).with_context(|| format!("cannot write {}", file.display()));
    }
    Ok(true)
}

/// Removes the skill. Returns true when something was removed.
pub fn uninstall(claude_dir: &Path) -> Result<bool> {
    let file = skill_file(claude_dir);
    let removed = match fs::remove_file(&file) {
        Ok(()) => true,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
        Err(e) => return Err(e).with_context(|| format!("cannot remove {}", file.display())),
    };
    // Only drop the directory when it is empty (never delete files we did not write).
    let _ = fs::remove_dir(skill_dir(claude_dir));
    Ok(removed)
}

/// True when the installed skill matches this CLI version.
pub fn is_current(claude_dir: &Path) -> bool {
    fs::read_to_string(skill_file(claude_dir))
        .is_ok_and(|text| version_of(&text) == Some(env!("CARGO_PKG_VERSION")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn rendered_skill_has_frontmatter_and_version_marker() {
        let text = render();
        assert!(text.starts_with("---\nname: safe-azure\ndescription: "));
        assert_eq!(version_of(&text), Some(env!("CARGO_PKG_VERSION")));
        assert!(!text.contains("{{"), "placeholder left in the skill");
        assert!(text.lines().count() < 500);
    }

    #[test]
    fn skill_names_real_tools() {
        let text = render();
        for tool in [
            "server_info",
            "login_status",
            "list_fired_alerts",
            "get_alert",
            "get_activity_log",
            "get_metrics",
            "run_kql",
            "get_resource_health",
            "list_service_health_events",
            "list_advisor_recommendations",
            "search_resources",
        ] {
            assert!(text.contains(&format!("`{tool}`")), "{tool}");
        }
        assert!(text.contains("safe-azure login <context>"));
        assert!(text.contains("`warnings`"));
    }

    #[test]
    fn install_is_idempotent_and_versioned() -> Result<()> {
        let tmp = TempDir::new()?;
        let claude = tmp.path();
        assert!(!is_current(claude));
        assert!(install(claude)?);
        assert!(is_current(claude));
        assert!(!install(claude)?);

        let file = skill_file(claude);
        fs::write(
            &file,
            render().replace(env!("CARGO_PKG_VERSION"), "0.0.0-old"),
        )?;
        assert!(!is_current(claude), "older skill is not current");
        assert!(install(claude)?);
        assert_eq!(fs::read_to_string(&file)?, render());

        assert!(uninstall(claude)?);
        assert!(!file.exists());
        assert!(!skill_dir(claude).exists());
        assert!(!uninstall(claude)?);
        assert!(!is_current(claude));
        Ok(())
    }
}
