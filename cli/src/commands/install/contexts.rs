//! `contexts.yaml`: model, validation (same rules as `src/core/config/contexts.ts`), YAML output
//! and the interactive wizard.
//!
//! Tenant and subscription IDs are never printed or logged: error messages name the field, not
//! the value, and `Debug` redacts them.

use anyhow::{Context as _, Result, bail};
use serde_yaml_bw::Value;
use std::collections::BTreeMap;
use std::fmt::{self, Write as _};
use std::io::{BufRead, Write};
use std::path::Path;

#[derive(Clone, Default, PartialEq, Eq)]
pub struct AzureContext {
    pub tenant_id: String,
    /// Subscription alias → subscription ID.
    pub subscriptions: BTreeMap<String, String>,
}

impl fmt::Debug for AzureContext {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("AzureContext")
            .field("tenant_id", &"<redacted>")
            .field(
                "subscriptions",
                &self.subscriptions.keys().collect::<Vec<_>>(),
            )
            .finish()
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ContextsFile {
    pub contexts: BTreeMap<String, AzureContext>,
    pub default_context: Option<String>,
    pub safe_tag_keys: Vec<String>,
}

/// `z.guid()`: 8-4-4-4-12 hex digits, any case, no RFC version check.
pub fn is_guid(s: &str) -> bool {
    let groups: Vec<&str> = s.split('-').collect();
    groups.len() == 5
        && groups
            .iter()
            .zip([8, 4, 4, 4, 12])
            .all(|(g, len)| g.len() == len && g.bytes().all(|b| b.is_ascii_hexdigit()))
}

/// `^[a-z0-9][a-z0-9-]{0,39}$`.
pub fn is_alias(s: &str) -> bool {
    let mut bytes = s.bytes();
    let Some(first) = bytes.next() else {
        return false;
    };
    s.len() <= 40
        && (first.is_ascii_lowercase() || first.is_ascii_digit())
        && bytes.all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

const ALIAS_RULE: &str = "lowercase kebab-case, starting with a letter or digit, max 40 chars";

/// Scalar keys only (`123:` is an alias too, like in the server's YAML parser).
fn key_str(key: &Value, path: &str) -> Result<String> {
    match key {
        Value::String(s, _) => Ok(s.clone()),
        Value::Number(n, _) => Ok(n.to_string()),
        _ => bail!("{path}: keys must be plain aliases"),
    }
}

fn str_field(value: &Value, path: &str) -> Result<String> {
    match value {
        Value::String(s, _) => Ok(s.clone()),
        _ => bail!("{path} must be a string"),
    }
}

fn mapping<'a>(value: &'a Value, path: &str) -> Result<Option<&'a serde_yaml_bw::Mapping>> {
    match value {
        Value::Null(_) => Ok(None),
        Value::Mapping(m) => Ok(Some(m)),
        _ => bail!("{path} must be a mapping"),
    }
}

fn alias_key(key: &Value, path: &str) -> Result<String> {
    let alias = key_str(key, path)?;
    if !is_alias(&alias) {
        bail!("{path}: alias \"{alias}\" is invalid ({ALIAS_RULE})");
    }
    Ok(alias)
}

fn guid_field(value: &Value, path: &str) -> Result<String> {
    let id = str_field(value, path)?;
    if !is_guid(&id) {
        // Never echo the value: it may be a real ID with a typo.
        bail!("{path} is not a GUID (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)");
    }
    Ok(id)
}

fn parse_context(value: &Value, path: &str) -> Result<AzureContext> {
    let Some(map) = mapping(value, path)? else {
        bail!("{path}.tenantId is required");
    };
    let tenant = map
        .get("tenantId")
        .with_context(|| format!("{path}.tenantId is required"))?;
    let mut ctx = AzureContext {
        tenant_id: guid_field(tenant, &format!("{path}.tenantId"))?,
        subscriptions: BTreeMap::new(),
    };
    if let Some(subs) = map.get("subscriptions") {
        let subs_path = format!("{path}.subscriptions");
        for (k, v) in mapping(subs, &subs_path)?.into_iter().flatten() {
            let alias = alias_key(k, &subs_path)?;
            let id = guid_field(v, &format!("{subs_path}.{alias}"))?;
            ctx.subscriptions.insert(alias, id);
        }
    }
    Ok(ctx)
}

/// Parses and validates. Errors never contain an ID.
pub fn parse(text: &str) -> Result<ContextsFile> {
    let root: Value = serde_yaml_bw::from_str(text).map_err(|e| match e.location() {
        Some(loc) => anyhow::anyhow!(
            "contexts.yaml is not valid YAML (line {}, column {})",
            loc.line(),
            loc.column()
        ),
        None => anyhow::anyhow!("contexts.yaml is not valid YAML"),
    })?;
    let mut file = ContextsFile::default();
    let Some(root) = mapping(&root, "contexts.yaml")? else {
        return Ok(file); // empty file: the server starts with no context
    };
    if let Some(contexts) = root.get("contexts") {
        for (k, v) in mapping(contexts, "contexts")?.into_iter().flatten() {
            let alias = alias_key(k, "contexts")?;
            let ctx = parse_context(v, &format!("contexts.{alias}"))?;
            file.contexts.insert(alias, ctx);
        }
    }
    if let Some(default) = root.get("defaultContext").filter(|v| !v.is_null()) {
        let alias = str_field(default, "defaultContext")?;
        if !file.contexts.contains_key(&alias) {
            bail!("defaultContext must reference a declared context alias");
        }
        file.default_context = Some(alias);
    }
    if let Some(keys) = root.get("safeTagKeys").filter(|v| !v.is_null()) {
        let Value::Sequence(seq) = keys else {
            bail!("safeTagKeys must be a list of strings");
        };
        for key in seq {
            file.safe_tag_keys.push(str_field(key, "safeTagKeys[]")?);
        }
    }
    Ok(file)
}

pub fn load(path: &Path) -> Result<ContextsFile> {
    let text =
        std::fs::read_to_string(path).with_context(|| format!("cannot read {}", path.display()))?;
    parse(&text)
}

/// JSON strings are valid YAML double-quoted scalars, so every value is quoted safely.
fn q(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| format!("\"{s}\""))
}

pub fn render(file: &ContextsFile) -> String {
    let mut out = String::from(
        "# Written by `safe-azure install`. The AI only ever sees the ALIASES, never the IDs.\n",
    );
    if file.contexts.is_empty() {
        out.push_str("contexts: {}\n");
    } else {
        out.push_str("contexts:\n");
    }
    // Writing to a String cannot fail.
    for (alias, ctx) in &file.contexts {
        let _ = writeln!(out, "  {}:\n    tenantId: {}", q(alias), q(&ctx.tenant_id));
        if ctx.subscriptions.is_empty() {
            out.push_str("    subscriptions: {}\n");
        } else {
            out.push_str("    subscriptions:\n");
            for (sub, id) in &ctx.subscriptions {
                let _ = writeln!(out, "      {}: {}", q(sub), q(id));
            }
        }
    }
    if let Some(default) = &file.default_context {
        let _ = writeln!(out, "defaultContext: {}", q(default));
    }
    out.push_str("# Tag keys whose values may be shown to the AI. Others are masked.\n");
    if file.safe_tag_keys.is_empty() {
        out.push_str("safeTagKeys: []\n");
    } else {
        out.push_str("safeTagKeys:\n");
        for key in &file.safe_tag_keys {
            let _ = writeln!(out, "  - {}", q(key));
        }
    }
    out
}

/// Aliases and counts only: safe to print (the AI sees aliases anyway).
pub fn summary(file: &ContextsFile) -> String {
    if file.contexts.is_empty() {
        return "no context".to_owned();
    }
    file.contexts
        .iter()
        .map(|(alias, ctx)| {
            let subs: Vec<&str> = ctx.subscriptions.keys().map(String::as_str).collect();
            let default = if file.default_context.as_deref() == Some(alias) {
                ", default"
            } else {
                ""
            };
            format!(
                "{alias} ({} subscription(s): {}{default})",
                subs.len(),
                subs.join(", ")
            )
        })
        .collect::<Vec<_>>()
        .join("; ")
}

/// Terminal prompts, generic so tests can script them.
pub struct Prompt<'a> {
    pub input: &'a mut dyn BufRead,
    pub out: &'a mut dyn Write,
}

impl Prompt<'_> {
    pub fn ask(&mut self, question: &str) -> Result<String> {
        write!(self.out, "{question}")?;
        self.out.flush()?;
        let mut line = String::new();
        if self.input.read_line(&mut line)? == 0 {
            bail!("input closed before the wizard finished");
        }
        Ok(line.trim().to_owned())
    }

    /// Asks until `valid` returns `None` (no error message).
    fn ask_valid(
        &mut self,
        question: &str,
        valid: impl Fn(&str) -> Option<String>,
    ) -> Result<String> {
        loop {
            let answer = self.ask(question)?;
            match valid(&answer) {
                None => return Ok(answer),
                Some(msg) => writeln!(self.out, "  ✖ {msg}")?,
            }
        }
    }

    pub fn yes_no(&mut self, question: &str, default: bool) -> Result<bool> {
        loop {
            let answer = self.ask(question)?.to_ascii_lowercase();
            match answer.as_str() {
                "" => return Ok(default),
                "y" | "yes" => return Ok(true),
                "n" | "no" => return Ok(false),
                _ => writeln!(self.out, "  ✖ answer y or n")?,
            }
        }
    }
}

fn check_alias(answer: &str, taken: &[&String]) -> Option<String> {
    if !is_alias(answer) {
        Some(format!("alias must be {ALIAS_RULE}"))
    } else if taken.iter().any(|t| t.as_str() == answer) {
        Some(format!("\"{answer}\" is already used"))
    } else {
        None
    }
}

fn check_guid(answer: &str) -> Option<String> {
    (!is_guid(answer)).then(|| "not a GUID (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)".to_owned())
}

/// Interactive wizard. IDs are read but never printed back.
pub fn wizard(p: &mut Prompt<'_>) -> Result<ContextsFile> {
    writeln!(
        p.out,
        "Describe your Azure tenants. You pick an alias for each tenant and subscription: the AI only ever sees those aliases, the IDs stay in contexts.yaml on this machine.\n"
    )?;
    let mut file = ContextsFile::default();
    loop {
        let taken: Vec<&String> = file.contexts.keys().collect();
        let alias = p.ask_valid("Context alias (e.g. prod): ", |a| check_alias(a, &taken))?;
        let tenant_id = p.ask_valid(&format!("  Tenant ID of {alias}: "), check_guid)?;
        let mut ctx = AzureContext {
            tenant_id,
            subscriptions: BTreeMap::new(),
        };
        loop {
            let taken: Vec<&String> = ctx.subscriptions.keys().collect();
            let sub = p.ask_valid("  Subscription alias (empty when done): ", |a| {
                if a.is_empty() {
                    None
                } else {
                    check_alias(a, &taken)
                }
            })?;
            if sub.is_empty() {
                break;
            }
            let id = p.ask_valid(&format!("  Subscription ID of {sub}: "), check_guid)?;
            ctx.subscriptions.insert(sub, id);
        }
        if ctx.subscriptions.is_empty() {
            writeln!(
                p.out,
                "  ! {alias} has no subscription: the AI will not see any resource in it."
            )?;
        }
        file.contexts.insert(alias, ctx);
        if !p.yes_no("Add another context? [y/N] ", false)? {
            break;
        }
    }
    let aliases: Vec<String> = file.contexts.keys().cloned().collect();
    file.default_context = if aliases.len() == 1 {
        aliases.first().cloned()
    } else {
        let first = aliases.first().cloned().unwrap_or_default();
        let answer = p.ask_valid(
            &format!("Default context ({}) [{first}]: ", aliases.join(", ")),
            |a| {
                (!a.is_empty() && !aliases.iter().any(|x| x == a))
                    .then(|| "not one of the aliases above".to_owned())
            },
        )?;
        Some(if answer.is_empty() { first } else { answer })
    };
    let tags = p.ask(
        "Tag keys whose VALUES the AI may see, comma-separated (e.g. env,app; empty for none): ",
    )?;
    file.safe_tag_keys = tags
        .split(',')
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(str::to_owned)
        .collect();
    Ok(file)
}
