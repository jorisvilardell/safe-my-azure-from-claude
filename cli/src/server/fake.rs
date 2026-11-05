//! Minimal HTTP/1.1 server for tests: one thread per connection, `Connection: close`.
#![allow(clippy::expect_used)]

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex, PoisonError};
use std::thread;

#[derive(Debug, Clone)]
pub struct Request {
    pub method: String,
    pub path: String,
    /// Lower-case names.
    pub headers: HashMap<String, String>,
    pub body: String,
}

impl Request {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).map(String::as_str)
    }
}

pub struct Reply {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: String,
}

impl Reply {
    pub fn json(status: u16, body: &str) -> Self {
        Self {
            status,
            headers: vec![("Content-Type".into(), "application/json".into())],
            body: body.into(),
        }
    }

    pub fn sse(body: &str) -> Self {
        Self {
            status: 200,
            headers: vec![("Content-Type".into(), "text/event-stream".into())],
            body: body.into(),
        }
    }

    pub fn empty(status: u16) -> Self {
        Self {
            status,
            headers: Vec::new(),
            body: String::new(),
        }
    }

    #[must_use]
    pub fn with_header(mut self, name: &str, value: &str) -> Self {
        self.headers.push((name.into(), value.into()));
        self
    }
}

type Handler = dyn Fn(&Request) -> Reply + Send + Sync;

pub struct FakeServer {
    port: u16,
    requests: Arc<Mutex<Vec<Request>>>,
}

impl FakeServer {
    pub fn start(handler: impl Fn(&Request) -> Reply + Send + Sync + 'static) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let handler: Arc<Handler> = Arc::new(handler);
        let log = Arc::clone(&requests);
        thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let handler = Arc::clone(&handler);
                let log = Arc::clone(&log);
                thread::spawn(move || serve(stream, &*handler, &log));
            }
        });
        Self { port, requests }
    }

    pub fn url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    pub fn requests(&self) -> Vec<Request> {
        self.requests
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }
}

/// A loopback URL where nothing listens.
pub fn dead_url() -> String {
    let port = TcpListener::bind("127.0.0.1:0")
        .and_then(|l| l.local_addr())
        .expect("bind")
        .port();
    format!("http://127.0.0.1:{port}")
}

fn serve(stream: TcpStream, handler: &Handler, log: &Mutex<Vec<Request>>) {
    use std::fmt::Write as _;
    let Ok(read_half) = stream.try_clone() else {
        return;
    };
    let mut reader = BufReader::new(read_half);
    let mut line = String::new();
    if reader.read_line(&mut line).is_err() {
        return;
    }
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or_default().to_owned();
    let path = parts.next().unwrap_or_default().to_owned();
    let mut headers = HashMap::new();
    loop {
        let mut h = String::new();
        if reader.read_line(&mut h).unwrap_or(0) == 0 || h.trim().is_empty() {
            break;
        }
        if let Some((k, v)) = h.split_once(':') {
            headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_owned());
        }
    }
    let len: usize = headers
        .get("content-length")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    let mut body = vec![0; len];
    if reader.read_exact(&mut body).is_err() {
        return;
    }
    let req = Request {
        method,
        path,
        headers,
        body: String::from_utf8_lossy(&body).into_owned(),
    };
    log.lock()
        .unwrap_or_else(PoisonError::into_inner)
        .push(req.clone());
    let reply = handler(&req);
    let mut out = format!("HTTP/1.1 {} X\r\n", reply.status);
    for (k, v) in &reply.headers {
        let _ = write!(out, "{k}: {v}\r\n");
    }
    let _ = write!(
        out,
        "Content-Length: {}\r\nConnection: close\r\n\r\n{}",
        reply.body.len(),
        reply.body
    );
    let mut stream = stream;
    let _ = stream.write_all(out.as_bytes());
    let _ = stream.flush();
}
