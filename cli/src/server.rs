//! HTTP client for the server's health and admin endpoints. Owned by the "CLI core" issue (#60).
//! Signatures are a contract used by other modules.
#![allow(dead_code, clippy::unused_self)]

#[cfg(test)]
pub(crate) mod fake;

use crate::keys::{self, Keys};
use crate::paths;
use anyhow::{Result, anyhow, bail};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Deserializer};
use std::sync::{Mutex, PoisonError};
use std::time::Duration;
use ureq::http::{Response, StatusCode};
use ureq::{Agent, Body};

/// `GET /healthz`.
#[derive(Debug, Clone, Deserialize)]
pub struct Health {
    pub status: String,
    pub version: String,
}

/// One row of `GET /admin/contexts`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextStatus {
    pub alias: String,
    #[serde(default)]
    pub subscriptions: Vec<String>,
    #[serde(default)]
    pub active: bool,
    #[serde(default)]
    pub logged_in: bool,
    pub expires_in_minutes: Option<u32>,
    #[serde(default)]
    pub login_pending: bool,
}

/// `POST /admin/login`: a device-code flow just started. The only place the code is returned.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginStart {
    pub context: String,
    pub user_code: String,
    pub verification_uri: String,
    /// As sent by the server (ISO 8601 expected; a number is kept as its decimal text).
    #[serde(deserialize_with = "string_or_number")]
    pub expires_at: String,
}

impl std::fmt::Debug for LoginStart {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LoginStart")
            .field("context", &self.context)
            .field("user_code", &"..")
            .field("verification_uri", &self.verification_uri)
            .field("expires_at", &self.expires_at)
            .finish()
    }
}

/// `GET /admin/login/:context`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum State {
    Pending,
    Succeeded,
    Failed,
    Expired,
}

/// Message used whenever the server cannot be reached.
pub const NOT_RUNNING: &str =
    "the safe-azure server is not reachable on 127.0.0.1:8765; run `safe-azure up`";

/// Unauthenticated liveness check; `Ok(None)` when the server is not reachable.
pub fn health() -> Result<Option<Health>> {
    health_at(&paths::base_url())
}

pub(crate) fn health_at(base: &str) -> Result<Option<Health>> {
    let agent = agent(Some(Duration::from_secs(2)));
    match agent.get(format!("{base}/healthz")).call() {
        Ok(mut resp) => {
            if !resp.status().is_success() {
                bail!(
                    "the server health check returned HTTP {}",
                    resp.status().as_u16()
                );
            }
            let health = resp
                .body_mut()
                .read_json::<Health>()
                .map_err(|_| anyhow!("the server health check returned an unexpected body"))?;
            Ok(Some(health))
        }
        Err(err) if is_unreachable(&err) => Ok(None),
        Err(err) => Err(anyhow!("the server health check failed: {err}")),
    }
}

/// HTTP agent for the local server: no proxy (the keys must never leave loopback), no redirects,
/// HTTP errors as plain responses.
pub(crate) fn agent(global_timeout: Option<Duration>) -> Agent {
    Agent::config_builder()
        .http_status_as_error(false)
        .proxy(None)
        .max_redirects(0)
        .timeout_connect(Some(Duration::from_secs(3)))
        .timeout_global(global_timeout)
        .build()
        .new_agent()
}

/// Connection refused, timeout, …: the server is down rather than misbehaving.
pub(crate) fn is_unreachable(err: &ureq::Error) -> bool {
    matches!(
        err,
        ureq::Error::Io(_)
            | ureq::Error::ConnectionFailed
            | ureq::Error::HostNotFound
            | ureq::Error::Timeout(_)
    )
}

type KeySource = Box<dyn Fn() -> Result<Keys> + Send + Sync>;

/// Admin API client (ADR 0001 §2). Retries once after re-fetching keys on 401.
pub struct Admin {
    base: String,
    agent: Agent,
    keys: Mutex<Keys>,
    /// Clears the cache and fetches the keys again.
    refresh: KeySource,
}

impl Admin {
    pub fn connect() -> Result<Self> {
        Ok(Self::with(
            paths::base_url(),
            keys::get()?,
            Box::new(keys::refresh),
        ))
    }

    pub(crate) fn with(base: String, keys: Keys, refresh: KeySource) -> Self {
        Self {
            base,
            agent: agent(Some(Duration::from_secs(15))),
            keys: Mutex::new(keys),
            refresh,
        }
    }

    pub fn contexts(&self) -> Result<Vec<ContextStatus>> {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum List {
            Bare(Vec<ContextStatus>),
            Wrapped { contexts: Vec<ContextStatus> },
        }
        let list: List = self.call("/admin/contexts", None)?;
        Ok(match list {
            List::Bare(rows) | List::Wrapped { contexts: rows } => rows,
        })
    }

    /// Starts a device-code login. Never log the returned `user_code`.
    pub fn start_login(&self, context: &str) -> Result<LoginStart> {
        self.call("/admin/login", Some(context))
    }

    pub fn login_state(&self, context: &str) -> Result<State> {
        #[derive(Deserialize)]
        struct Body {
            state: State,
        }
        let path = format!("/admin/login/{}", encode_segment(context));
        let body: Body = self.call(&path, None)?;
        Ok(body.state)
    }

    pub fn logout(&self, context: &str) -> Result<()> {
        self.send("/admin/logout", Some(context)).map(drop)
    }

    pub fn use_context(&self, context: &str) -> Result<()> {
        self.send("/admin/use", Some(context)).map(drop)
    }

    fn call<T: DeserializeOwned>(&self, path: &str, context: Option<&str>) -> Result<T> {
        let mut resp = self.send(path, context)?;
        // No serde message: it could quote a value from the body.
        resp.body_mut()
            .read_json::<T>()
            .map_err(|_| anyhow!("unexpected response from the server ({path})"))
    }

    /// `GET path` when `context` is `None`, else `POST path {"context": …}`. 401 → re-fetch once.
    fn send(&self, path: &str, context: Option<&str>) -> Result<Response<Body>> {
        let mut refreshed = false;
        loop {
            let key = self
                .keys
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .admin
                .clone();
            let resp = self.request(path, context, &key)?;
            if resp.status() == StatusCode::UNAUTHORIZED {
                if refreshed {
                    bail!(
                        "the server rejected the admin key even after re-reading it; run `safe-azure doctor`"
                    );
                }
                refreshed = true;
                let fresh = (self.refresh)()?;
                *self.keys.lock().unwrap_or_else(PoisonError::into_inner) = fresh;
                continue;
            }
            if !resp.status().is_success() {
                return Err(http_error(resp));
            }
            return Ok(resp);
        }
    }

    fn request(&self, path: &str, context: Option<&str>, key: &str) -> Result<Response<Body>> {
        let url = format!("{}{path}", self.base);
        let auth = format!("Bearer {key}");
        let result = match context {
            None => self
                .agent
                .get(&url)
                .header("Authorization", &auth)
                .header("Accept", "application/json")
                .call(),
            Some(context) => self
                .agent
                .post(&url)
                .header("Authorization", &auth)
                .header("Accept", "application/json")
                .send_json(serde_json::json!({ "context": context })),
        };
        result.map_err(|err| {
            if is_unreachable(&err) {
                anyhow!(NOT_RUNNING)
            } else {
                anyhow!("request to the server failed: {err}")
            }
        })
    }
}

/// `HTTP 404: unknown context` from an error response (`{error}` or `{message}` if present).
fn http_error(mut resp: Response<Body>) -> anyhow::Error {
    let status = resp.status().as_u16();
    let detail = resp
        .body_mut()
        .with_config()
        .limit(64 * 1024)
        .read_to_string()
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|v| {
            let field = |name: &str| v.get(name).cloned();
            let msg = field("error").or_else(|| field("message"))?;
            match msg {
                serde_json::Value::String(s) => Some(s),
                other => other.get("message")?.as_str().map(str::to_owned),
            }
        });
    match detail {
        Some(detail) => {
            let detail: String = detail.chars().take(300).collect();
            anyhow!("the server returned HTTP {status}: {detail}")
        }
        None => anyhow!("the server returned HTTP {status}"),
    }
}

/// Percent-encodes one URL path segment (RFC 3986 unreserved characters kept).
fn encode_segment(s: &str) -> String {
    use std::fmt::Write as _;
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~') {
            out.push(char::from(b));
        } else {
            let _ = write!(out, "%{b:02X}");
        }
    }
    out
}

fn string_or_number<'de, D: Deserializer<'de>>(de: D) -> Result<String, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Raw {
        Text(String),
        Number(serde_json::Number),
    }
    Ok(match Raw::deserialize(de)? {
        Raw::Text(s) => s,
        Raw::Number(n) => n.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::fake::{FakeServer, Reply};
    use super::*;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn keys(admin: &str) -> Keys {
        Keys {
            mcp: "mcp".into(),
            admin: admin.into(),
        }
    }

    fn admin_for(
        server: &FakeServer,
        initial: &str,
        fresh: &'static str,
    ) -> (Admin, Arc<AtomicUsize>) {
        let refreshes = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&refreshes);
        let admin = Admin::with(
            server.url(),
            keys(initial),
            Box::new(move || {
                counter.fetch_add(1, Ordering::SeqCst);
                Ok(keys(fresh))
            }),
        );
        (admin, refreshes)
    }

    /// Answers like the real admin API, but only for `Bearer good`.
    fn admin_api() -> FakeServer {
        FakeServer::start(|req| {
            if req.header("authorization") != Some("Bearer good") {
                return Reply::json(401, r#"{"error":"unauthorized"}"#);
            }
            match (req.method.as_str(), req.path.as_str()) {
                ("GET", "/admin/contexts") => Reply::json(
                    200,
                    r#"[{"alias":"prod","subscriptions":["main"],"active":true,"loggedIn":true,"expiresInMinutes":42,"loginPending":false},
                        {"alias":"dev","subscriptions":[],"active":false,"loggedIn":false,"loginPending":true}]"#,
                ),
                ("POST", "/admin/login") => Reply::json(
                    200,
                    r#"{"context":"prod","userCode":"ABCD-1234","verificationUri":"https://microsoft.com/devicelogin","expiresAt":"2026-11-05T12:00:00Z"}"#,
                ),
                ("GET", "/admin/login/my%20ctx") => Reply::json(200, r#"{"state":"succeeded"}"#),
                ("GET", "/admin/login/prod") => Reply::json(200, r#"{"state":"pending"}"#),
                ("POST", "/admin/logout" | "/admin/use") => Reply::json(200, r#"{"ok":true}"#),
                _ => Reply::json(404, r#"{"error":"unknown context"}"#),
            }
        })
    }

    #[test]
    fn admin_endpoints() -> Result<()> {
        let server = admin_api();
        let (admin, refreshes) = admin_for(&server, "good", "good");

        let rows = admin.contexts()?;
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].alias, "prod");
        assert_eq!(rows[0].expires_in_minutes, Some(42));
        assert!(rows[1].login_pending);

        let start = admin.start_login("prod")?;
        assert_eq!(start.user_code, "ABCD-1234");
        assert!(!format!("{start:?}").contains("ABCD"));

        assert_eq!(admin.login_state("prod")?, State::Pending);
        assert_eq!(admin.login_state("my ctx")?, State::Succeeded);
        admin.logout("prod")?;
        admin.use_context("prod")?;

        let reqs = server.requests();
        let login = reqs
            .iter()
            .find(|r| r.path == "/admin/login")
            .ok_or_else(|| anyhow!("no login"))?;
        assert_eq!(login.method, "POST");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&login.body)?["context"],
            "prod"
        );
        assert_eq!(refreshes.load(Ordering::SeqCst), 0);
        Ok(())
    }

    #[test]
    fn wrapped_context_list_is_accepted() -> Result<()> {
        let server = FakeServer::start(|_| {
            Reply::json(
                200,
                r#"{"contexts":[{"alias":"a","subscriptions":[],"active":false,"loggedIn":false,"loginPending":false}]}"#,
            )
        });
        let (admin, _) = admin_for(&server, "k", "k");
        assert_eq!(admin.contexts()?.len(), 1);
        Ok(())
    }

    #[test]
    fn unauthorized_refetches_keys_and_retries_once() -> Result<()> {
        let server = admin_api();
        let (admin, refreshes) = admin_for(&server, "stale", "good");
        assert_eq!(admin.contexts()?.len(), 2);
        assert_eq!(refreshes.load(Ordering::SeqCst), 1);
        // The fresh key is kept for the next call.
        admin.use_context("prod")?;
        assert_eq!(refreshes.load(Ordering::SeqCst), 1);
        assert_eq!(server.requests().len(), 3);
        Ok(())
    }

    #[test]
    fn unauthorized_twice_gives_up() {
        let server = admin_api();
        let (admin, refreshes) = admin_for(&server, "stale", "still-bad");
        let err = admin
            .contexts()
            .err()
            .map(|e| e.to_string())
            .unwrap_or_default();
        assert!(err.contains("rejected the admin key"), "{err}");
        assert!(!err.contains("still-bad"), "{err}");
        assert_eq!(refreshes.load(Ordering::SeqCst), 1);
        assert_eq!(server.requests().len(), 2);
    }

    #[test]
    fn http_errors_carry_the_server_message() {
        let server = admin_api();
        let (admin, _) = admin_for(&server, "good", "good");
        let err = admin
            .login_state("nope")
            .err()
            .map(|e| e.to_string())
            .unwrap_or_default();
        assert_eq!(err, "the server returned HTTP 404: unknown context");
    }

    #[test]
    fn server_down() {
        let url = super::fake::dead_url();
        assert!(matches!(health_at(&url), Ok(None)));
        let admin = Admin::with(url, keys("k"), Box::new(|| Ok(keys("k"))));
        let err = admin
            .contexts()
            .err()
            .map(|e| e.to_string())
            .unwrap_or_default();
        assert!(err.contains("safe-azure up"), "{err}");
    }

    #[test]
    fn health_ok() -> Result<()> {
        let server = FakeServer::start(|req| {
            assert!(req.header("authorization").is_none());
            Reply::json(200, r#"{"status":"ok","version":"0.1.0"}"#)
        });
        let health = health_at(&server.url())?.ok_or_else(|| anyhow!("down"))?;
        assert_eq!(health.status, "ok");
        assert_eq!(health.version, "0.1.0");
        Ok(())
    }

    #[test]
    fn encodes_path_segments() {
        assert_eq!(encode_segment("prod-1_a.b~"), "prod-1_a.b~");
        assert_eq!(encode_segment("a b/c"), "a%20b%2Fc");
    }

    #[test]
    fn expires_at_accepts_numbers() -> Result<()> {
        let start: LoginStart = serde_json::from_str(
            r#"{"context":"c","userCode":"u","verificationUri":"https://x","expiresAt":1700000000}"#,
        )?;
        assert_eq!(start.expires_at, "1700000000");
        Ok(())
    }
}
