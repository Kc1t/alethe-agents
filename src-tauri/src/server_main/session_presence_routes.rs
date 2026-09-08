//! Session-presence check for the Web/Core transport.
//!
//! Mirrors the Tauri command one for one — the logic lives in `crate::session_presence` and both
//! runtimes call the same function, so the two can never disagree about whether a session exists.

use axum::extract::Query;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use std::collections::HashMap;

use super::query_param as q;

pub fn router() -> Router {
    Router::new().route("/api/sessions/presence", get(presence))
}

async fn presence(Query(p): Query<HashMap<String, String>>) -> Response {
    let agent = match q(&p, "agent") {
        Ok(value) => value,
        Err(error) => return error.into_response(),
    };
    let session_id = match q(&p, "sessionId") {
        Ok(value) => value,
        Err(error) => return error.into_response(),
    };
    // `cwd` is optional: only the Claude branch uses it, and an agent that ignores it should not be
    // forced to invent one.
    let cwd = p.get("cwd").cloned().unwrap_or_default();
    Json(crate::session_presence::session_presence(&agent, &cwd, &session_id)).into_response()
}
