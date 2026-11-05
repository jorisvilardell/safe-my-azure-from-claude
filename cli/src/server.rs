//! HTTP client for the server's health and admin endpoints. Owned by the "CLI core" issue (#60).
//! Signatures are a contract used by other modules.
#![allow(dead_code, clippy::unused_self)]

use anyhow::{Result, bail};
use serde::Deserialize;

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
    pub subscriptions: Vec<String>,
    pub active: bool,
    pub logged_in: bool,
    pub expires_in_minutes: Option<u32>,
    pub login_pending: bool,
}

/// Unauthenticated liveness check; `Ok(None)` when the server is not reachable.
pub fn health() -> Result<Option<Health>> {
    bail!("not implemented yet")
}

/// Admin API client (ADR 0001 §2). Retries once after re-fetching keys on 401.
pub struct Admin;

impl Admin {
    pub fn connect() -> Result<Self> {
        bail!("not implemented yet")
    }

    pub fn contexts(&self) -> Result<Vec<ContextStatus>> {
        bail!("not implemented yet")
    }
}
