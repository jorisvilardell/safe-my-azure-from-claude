//! `safe-azure mcp`: stdio ⇄ Streamable HTTP bridge. Owned by the "CLI core" issue.
//!
//! MCP clients launch this; it adds the MCP bearer key itself, so the key never sits in a
//! client config file.
//!
//! - stdin: newline-delimited JSON-RPC from the client. Each message is posted to `/mcp` on its
//!   own thread, so a long tool call does not hold back pings or cancellations.
//! - stdout: **only** JSON-RPC, one message per line, from `application/json` or
//!   `text/event-stream` responses. Diagnostics go to stderr.
//! - Every request (a message with a `method` and an `id`) gets an answer: the server's, or a
//!   JSON-RPC error when the server is down, rejects the key, or ends without answering.

use crate::keys::{self, Keys};
use crate::paths;
use crate::server::{self, NOT_RUNNING};
use anyhow::Result;
use serde_json::{Value, json};
use std::collections::HashSet;
use std::io::{self, BufRead, Write};
use std::sync::{Arc, Mutex, PoisonError};
use std::thread;
use ureq::http::{Response, StatusCode};
use ureq::{Agent, Body};

pub fn run() -> Result<()> {
    let bridge = Arc::new(Bridge::new(
        format!("{}/mcp", paths::base_url()),
        Box::new(keys::get),
        Box::new(keys::refresh),
        Box::new(io::stdout()),
    ));
    bridge.serve(io::stdin().lock())
}

type KeySource = Box<dyn Fn() -> Result<Keys> + Send + Sync>;

/// Why a request got no answer from the server; the text goes to the MCP client (and the AI).
#[derive(Debug, Clone, PartialEq, Eq)]
enum Failure {
    Down,
    Keys,
    Unauthorized,
    Http(u16, Option<String>),
    NoAnswer,
}

impl Failure {
    fn message(&self) -> String {
        match self {
            Self::Down => format!("{NOT_RUNNING}."),
            Self::Keys => {
                "could not read the safe-azure server keys; is the server running? Run `safe-azure up`."
                    .into()
            }
            Self::Unauthorized => {
                "the safe-azure server rejected the MCP key; run `safe-azure doctor`.".into()
            }
            Self::Http(status, Some(detail)) => {
                format!("the safe-azure server returned HTTP {status}: {detail}")
            }
            Self::Http(status, None) => format!("the safe-azure server returned HTTP {status}."),
            Self::NoAnswer => "the safe-azure server ended the response without an answer.".into(),
        }
    }
}

struct Bridge {
    url: String,
    agent: Agent,
    load: KeySource,
    refresh: KeySource,
    /// MCP key, loaded on the first message.
    key: Mutex<Option<String>>,
    session: Mutex<Option<String>>,
    protocol: Mutex<Option<String>>,
    out: Mutex<Box<dyn Write + Send>>,
}

impl Bridge {
    fn new(url: String, load: KeySource, refresh: KeySource, out: Box<dyn Write + Send>) -> Self {
        Self {
            url,
            // No global timeout: tool calls and SSE streams can legitimately take a while.
            agent: server::agent(None),
            load,
            refresh,
            key: Mutex::new(None),
            session: Mutex::new(None),
            protocol: Mutex::new(None),
            out: Mutex::new(out),
        }
    }

    fn serve(self: &Arc<Self>, input: impl BufRead) -> Result<()> {
        let mut workers = Vec::new();
        let mut result = Ok(());
        for line in input.lines() {
            let line = match line {
                Ok(line) => line,
                Err(err) => {
                    result = Err(anyhow::Error::new(err).context("could not read stdin"));
                    break;
                }
            };
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let Ok(message) = serde_json::from_str::<Value>(line) else {
                eprintln!("safe-azure mcp: ignoring a line that is not JSON");
                self.emit(&json!({
                    "jsonrpc": "2.0",
                    "id": null,
                    "error": { "code": -32700, "message": "Parse error" }
                }));
                continue;
            };
            let bridge = Arc::clone(self);
            workers.push(thread::spawn(move || bridge.forward(&message)));
            workers.retain(|w| !w.is_finished());
        }
        for worker in workers {
            let _ = worker.join();
        }
        self.close_session();
        result
    }

    /// POSTs one message and writes whatever comes back; answers unanswered requests.
    fn forward(&self, message: &Value) {
        let mut pending = request_ids(message);
        let failure = match self.exchange(message, &mut pending) {
            Ok(()) if pending.is_empty() => return,
            Ok(()) => Failure::NoAnswer,
            Err(failure) => failure,
        };
        eprintln!("safe-azure mcp: {}", failure.message());
        for id in pending {
            let id: Value = serde_json::from_str(&id).unwrap_or(Value::Null);
            self.emit(&json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": { "code": -32000, "message": failure.message() }
            }));
        }
    }

    fn exchange(&self, message: &Value, pending: &mut HashSet<String>) -> Result<(), Failure> {
        let body = message.to_string();
        let key = self.key()?;
        let mut resp = self.post(&body, &key)?;
        if resp.status() == StatusCode::UNAUTHORIZED {
            // The container restarted: new keys. Re-read them and retry once.
            let key = self.refresh_key(&key)?;
            resp = self.post(&body, &key)?;
            if resp.status() == StatusCode::UNAUTHORIZED {
                return Err(Failure::Unauthorized);
            }
        }
        if let Some(id) = header(&resp, "mcp-session-id") {
            *lock(&self.session) = Some(id);
        }
        let status = resp.status();
        if status == StatusCode::ACCEPTED {
            return Ok(());
        }
        if !status.is_success() {
            if status == StatusCode::NOT_FOUND {
                // Session expired (spec): forget it so the client can initialize again.
                *lock(&self.session) = None;
            }
            return Err(Failure::Http(status.as_u16(), error_detail(resp)));
        }
        let is_sse = resp.body().mime_type() == Some("text/event-stream");
        let mut body = resp.into_body();
        if is_sse {
            let reader = io::BufReader::new(body.as_reader());
            read_sse(reader, |data| self.emit_text(data, pending)).map_err(|err| {
                eprintln!("safe-azure mcp: event stream broken: {err}");
                Failure::NoAnswer
            })
        } else {
            match body.read_to_string() {
                Ok(text) => {
                    self.emit_text(&text, pending);
                    Ok(())
                }
                Err(err) => {
                    eprintln!("safe-azure mcp: could not read the response: {err}");
                    Err(Failure::NoAnswer)
                }
            }
        }
    }

    fn post(&self, body: &str, key: &str) -> Result<Response<Body>, Failure> {
        let mut req = self
            .agent
            .post(&self.url)
            .header("Authorization", format!("Bearer {key}"))
            .header("Content-Type", "application/json")
            .header("Accept", "application/json, text/event-stream");
        if let Some(session) = lock(&self.session).clone() {
            req = req.header("Mcp-Session-Id", session);
        }
        if let Some(version) = lock(&self.protocol).clone() {
            req = req.header("MCP-Protocol-Version", version);
        }
        req.send(body).map_err(|err| {
            if server::is_unreachable(&err) {
                Failure::Down
            } else {
                eprintln!("safe-azure mcp: request failed: {err}");
                Failure::NoAnswer
            }
        })
    }

    fn key(&self) -> Result<String, Failure> {
        let mut key = lock(&self.key);
        if let Some(key) = key.as_ref() {
            return Ok(key.clone());
        }
        let fresh = (self.load)().map_err(|err| key_failure(&err))?.mcp;
        *key = Some(fresh.clone());
        Ok(fresh)
    }

    /// Re-fetches the key unless another thread already replaced `stale`.
    fn refresh_key(&self, stale: &str) -> Result<String, Failure> {
        let mut key = lock(&self.key);
        if let Some(current) = key.as_ref().filter(|k| k.as_str() != stale) {
            return Ok(current.clone());
        }
        let fresh = (self.refresh)().map_err(|err| key_failure(&err))?.mcp;
        *key = Some(fresh.clone());
        Ok(fresh)
    }

    /// Writes the JSON-RPC message(s) in `text` (an object or a batch array).
    fn emit_text(&self, text: &str, pending: &mut HashSet<String>) {
        let text = text.trim();
        if text.is_empty() {
            return;
        }
        let Ok(value) = serde_json::from_str::<Value>(text) else {
            eprintln!("safe-azure mcp: dropping a server message that is not JSON");
            return;
        };
        let messages = match value {
            Value::Array(items) => items,
            other => vec![other],
        };
        for message in messages {
            if message.get("result").is_some() || message.get("error").is_some() {
                if let Some(id) = message.get("id").filter(|id| !id.is_null()) {
                    pending.remove(&id.to_string());
                }
                if let Some(version) = message
                    .pointer("/result/protocolVersion")
                    .and_then(Value::as_str)
                    .filter(|_| message.pointer("/result/serverInfo").is_some())
                {
                    *lock(&self.protocol) = Some(version.to_owned());
                }
            }
            self.emit(&message);
        }
    }

    /// One compact JSON line on stdout (serde never emits raw newlines inside JSON).
    fn emit(&self, message: &Value) {
        let mut out = lock(&self.out);
        if writeln!(out, "{message}")
            .and_then(|()| out.flush())
            .is_err()
        {
            eprintln!("safe-azure mcp: could not write to stdout");
        }
    }

    /// Ends the session, if the server opened one.
    fn close_session(&self) {
        let Some(session) = lock(&self.session).take() else {
            return;
        };
        let Ok(key) = self.key() else {
            return;
        };
        let _ = self
            .agent
            .delete(&self.url)
            .header("Authorization", format!("Bearer {key}"))
            .header("Mcp-Session-Id", session)
            .call();
    }
}

fn key_failure(err: &anyhow::Error) -> Failure {
    eprintln!("safe-azure mcp: {err:#}");
    Failure::Keys
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

fn header(resp: &Response<Body>, name: &str) -> Option<String> {
    resp.headers()
        .get(name)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned)
}

/// Ids (as JSON text) of the requests in `message`: objects with a `method` and a non-null `id`.
fn request_ids(message: &Value) -> HashSet<String> {
    let one = |m: &Value| {
        m.get("method")?;
        m.get("id").filter(|id| !id.is_null()).map(Value::to_string)
    };
    match message {
        Value::Array(items) => items.iter().filter_map(one).collect(),
        other => one(other).into_iter().collect(),
    }
}

/// `error.message` from a JSON-RPC error body, if the server sent one.
fn error_detail(resp: Response<Body>) -> Option<String> {
    let text = resp
        .into_body()
        .with_config()
        .limit(64 * 1024)
        .read_to_string()
        .ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    let message = value.pointer("/error/message")?.as_str()?;
    Some(message.chars().take(300).collect())
}

/// Calls `on_data` with the data of every `message` event (the default type) of an SSE stream.
fn read_sse(reader: impl BufRead, mut on_data: impl FnMut(&str)) -> io::Result<()> {
    let mut data = String::new();
    let mut has_data = false;
    let mut event = String::new();
    let mut dispatch = |data: &mut String, has_data: &mut bool, event: &mut String| {
        if *has_data && (event.is_empty() || event == "message") {
            on_data(data);
        }
        data.clear();
        event.clear();
        *has_data = false;
    };
    for line in reader.lines() {
        let line = line?;
        if line.is_empty() {
            dispatch(&mut data, &mut has_data, &mut event);
            continue;
        }
        if line.starts_with(':') {
            continue;
        }
        let (field, value) = match line.split_once(':') {
            Some((field, value)) => (field, value.strip_prefix(' ').unwrap_or(value)),
            None => (line.as_str(), ""),
        };
        match field {
            "data" => {
                if has_data {
                    data.push('\n');
                }
                data.push_str(value);
                has_data = true;
            }
            "event" => value.clone_into(&mut event),
            _ => {}
        }
    }
    dispatch(&mut data, &mut has_data, &mut event);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::fake::{FakeServer, Reply, dead_url};
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[derive(Clone, Default)]
    struct Captured(Arc<Mutex<Vec<u8>>>);

    impl Write for Captured {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            lock(&self.0).extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    impl Captured {
        fn messages(&self) -> Vec<Value> {
            let text = String::from_utf8_lossy(&lock(&self.0)).into_owned();
            text.lines()
                .map(|l| serde_json::from_str(l).unwrap_or(Value::Null))
                .collect()
        }
    }

    fn keys(mcp: &str) -> Keys {
        Keys {
            mcp: mcp.into(),
            admin: "admin".into(),
        }
    }

    /// Runs the bridge over `input` against `base`; returns stdout messages and refresh count.
    fn run_bridge(
        base: &str,
        initial: &'static str,
        fresh: &'static str,
        input: &str,
    ) -> (Vec<Value>, usize) {
        let out = Captured::default();
        let refreshes = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&refreshes);
        let bridge = Arc::new(Bridge::new(
            format!("{base}/mcp"),
            Box::new(move || Ok(keys(initial))),
            Box::new(move || {
                counter.fetch_add(1, Ordering::SeqCst);
                Ok(keys(fresh))
            }),
            Box::new(out.clone()),
        ));
        assert!(bridge.serve(input.as_bytes()).is_ok());
        (out.messages(), refreshes.load(Ordering::SeqCst))
    }

    /// A fake `/mcp`: `ping` → JSON, `tools/list` → SSE, notifications → 202.
    fn mcp_server() -> FakeServer {
        FakeServer::start(|req| {
            if req.header("authorization") != Some("Bearer good") {
                return Reply::json(
                    401,
                    r#"{"jsonrpc":"2.0","error":{"code":-32001,"message":"Unauthorized"},"id":null}"#,
                );
            }
            assert_eq!(req.method, "POST");
            assert_eq!(req.path, "/mcp");
            assert_eq!(req.header("content-type"), Some("application/json"));
            assert_eq!(
                req.header("accept"),
                Some("application/json, text/event-stream")
            );
            let msg: Value = serde_json::from_str(&req.body).unwrap_or(Value::Null);
            let id = msg["id"].clone();
            match msg["method"].as_str() {
                Some("ping") => Reply::json(200, &json!({"jsonrpc":"2.0","id":id,"result":{}}).to_string()),
                Some("tools/list") => Reply::sse(&format!(
                    ": keep-alive\n\nevent: message\ndata: {}\n\nevent: other\ndata: ignored\n\ndata: {}\n\n",
                    json!({"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info","data":"multi\nline"}}),
                    json!({"jsonrpc":"2.0","id":id,"result":{"tools":[]}}),
                )),
                Some("initialize") => Reply::sse(&format!(
                    "data: {}\n\n",
                    json!({"jsonrpc":"2.0","id":id,"result":{"protocolVersion":"2025-06-18","serverInfo":{"name":"x"}}})
                ))
                .with_header("Mcp-Session-Id", "session-1"),
                Some("silent") => Reply::sse(": nothing\n\n"),
                Some(m) if m.starts_with("notifications/") => Reply::empty(202),
                _ => Reply::json(400, r#"{"jsonrpc":"2.0","error":{"code":-32600,"message":"Bad request"},"id":null}"#),
            }
        })
    }

    fn by_id(messages: &[Value], id: i64) -> Option<&Value> {
        messages.iter().find(|m| m["id"] == id)
    }

    #[test]
    fn json_sse_and_notifications() {
        let server = mcp_server();
        let input = [
            json!({"jsonrpc":"2.0","id":1,"method":"ping"}),
            json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
            json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}),
        ]
        .map(|m| m.to_string())
        .join("\n\n");
        let (messages, refreshes) = run_bridge(&server.url(), "good", "good", &input);

        assert_eq!(refreshes, 0);
        assert_eq!(messages.len(), 3, "{messages:?}");
        assert_eq!(by_id(&messages, 1).map(|m| &m["result"]), Some(&json!({})));
        assert_eq!(
            by_id(&messages, 2).map(|m| &m["result"]["tools"]),
            Some(&json!([]))
        );
        let note = messages
            .iter()
            .find(|m| m["method"] == "notifications/message");
        assert_eq!(
            note.map(|m| &m["params"]["data"]),
            Some(&json!("multi\nline"))
        );
        assert!(!messages.contains(&Value::Null));
        assert_eq!(server.requests().len(), 3);
    }

    #[test]
    fn session_and_protocol_headers_are_reused() {
        let server = mcp_server();
        let input = json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}).to_string();
        let out = Captured::default();
        let bridge = Arc::new(Bridge::new(
            format!("{}/mcp", server.url()),
            Box::new(|| Ok(keys("good"))),
            Box::new(|| Ok(keys("good"))),
            Box::new(out.clone()),
        ));
        bridge.forward(&serde_json::from_str(&input).unwrap_or(Value::Null));
        bridge.forward(&json!({"jsonrpc":"2.0","id":2,"method":"ping"}));
        assert!(bridge.serve(&b""[..]).is_ok()); // EOF: closes the session

        let reqs = server.requests();
        assert_eq!(reqs.len(), 3);
        assert!(reqs[0].header("mcp-session-id").is_none());
        assert_eq!(reqs[1].header("mcp-session-id"), Some("session-1"));
        assert_eq!(reqs[1].header("mcp-protocol-version"), Some("2025-06-18"));
        assert_eq!(reqs[2].method, "DELETE");
        assert_eq!(out.messages().len(), 2);
    }

    #[test]
    fn unauthorized_refetches_the_key_and_retries_once() {
        let server = mcp_server();
        let input = json!({"jsonrpc":"2.0","id":7,"method":"ping"}).to_string();
        let (messages, refreshes) = run_bridge(&server.url(), "stale", "good", &input);
        assert_eq!(refreshes, 1);
        assert_eq!(messages, vec![json!({"jsonrpc":"2.0","id":7,"result":{}})]);
        assert_eq!(server.requests().len(), 2);
    }

    #[test]
    fn unauthorized_twice_answers_with_an_error() {
        let server = mcp_server();
        let input = json!({"jsonrpc":"2.0","id":"a","method":"ping"}).to_string();
        let (messages, refreshes) = run_bridge(&server.url(), "stale", "bad", &input);
        assert_eq!(refreshes, 1);
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0]["id"], "a");
        let text = messages[0]["error"]["message"].as_str().unwrap_or_default();
        assert!(text.contains("rejected the MCP key"), "{text}");
        assert!(!text.contains("bad") && !text.contains("stale"), "{text}");
    }

    #[test]
    fn server_down_answers_requests_only() {
        let input = [
            json!({"jsonrpc":"2.0","id":1,"method":"tools/list"}),
            json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
        ]
        .map(|m| m.to_string())
        .join("\n");
        let (messages, _) = run_bridge(&dead_url(), "good", "good", &input);
        assert_eq!(messages.len(), 1, "{messages:?}");
        assert_eq!(messages[0]["id"], 1);
        assert_eq!(messages[0]["error"]["code"], -32000);
        let text = messages[0]["error"]["message"].as_str().unwrap_or_default();
        assert!(text.contains("run `safe-azure up`"), "{text}");
    }

    #[test]
    fn key_failure_answers_with_up_hint() {
        let out = Captured::default();
        let bridge = Arc::new(Bridge::new(
            format!("{}/mcp", dead_url()),
            Box::new(|| Err(anyhow::anyhow!("no container"))),
            Box::new(|| Err(anyhow::anyhow!("no container"))),
            Box::new(out.clone()),
        ));
        assert!(
            bridge
                .serve(&br#"{"jsonrpc":"2.0","id":3,"method":"ping"}"#[..])
                .is_ok()
        );
        let messages = out.messages();
        assert_eq!(messages.len(), 1);
        let text = messages[0]["error"]["message"].as_str().unwrap_or_default();
        assert!(text.contains("safe-azure up"), "{text}");
    }

    #[test]
    fn http_errors_and_missing_answers_become_json_rpc_errors() {
        let server = mcp_server();
        let input = [
            json!({"jsonrpc":"2.0","id":1,"method":"unknown"}),
            json!({"jsonrpc":"2.0","id":2,"method":"silent"}),
        ]
        .map(|m| m.to_string())
        .join("\n");
        let (messages, _) = run_bridge(&server.url(), "good", "good", &input);
        assert_eq!(messages.len(), 2, "{messages:?}");
        let first = by_id(&messages, 1)
            .and_then(|m| m["error"]["message"].as_str())
            .unwrap_or_default();
        assert_eq!(
            first,
            "the safe-azure server returned HTTP 400: Bad request"
        );
        let second = by_id(&messages, 2)
            .and_then(|m| m["error"]["message"].as_str())
            .unwrap_or_default();
        assert!(second.contains("without an answer"), "{second}");
    }

    #[test]
    fn invalid_json_line_gets_a_parse_error() {
        let (messages, _) = run_bridge(&dead_url(), "good", "good", "not json\n");
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0]["error"]["code"], -32700);
    }

    #[test]
    fn sse_parser() -> io::Result<()> {
        let mut seen = Vec::new();
        read_sse(
            "data: a\r\ndata:b\n\nid: 1\nevent: ping\ndata: skip\n\n:comment\ndata: tail"
                .as_bytes(),
            |d| seen.push(d.to_owned()),
        )?;
        assert_eq!(seen, vec!["a\nb".to_owned(), "tail".to_owned()]);
        Ok(())
    }

    #[test]
    fn request_ids_skip_notifications_and_responses() {
        let batch = json!([
            {"jsonrpc":"2.0","id":1,"method":"a"},
            {"jsonrpc":"2.0","method":"b"},
            {"jsonrpc":"2.0","id":2,"result":{}},
            {"jsonrpc":"2.0","id":"x","method":"c"}
        ]);
        let ids = request_ids(&batch);
        assert_eq!(ids, HashSet::from(["1".to_owned(), "\"x\"".to_owned()]));
    }
}
