//! The doctor, for the Web/Core transport.
//!
//! Mirrors the Tauri command one for one: the checks live in `crate::self_test` and take an
//! already-resolved data root, so both runtimes call the same code rather than each growing their
//! own idea of what "healthy" means.

use axum::extract::Extension;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use std::sync::Arc;

use super::ServerRuntime;

pub fn router() -> Router {
    Router::new().route("/api/self-test", get(run))
}

async fn run(Extension(runtime): Extension<Arc<ServerRuntime>>) -> Response {
    // Always a 200 with the verdicts inside: a failing check is a successful diagnosis, and
    // returning an error status would make "the doctor could not run" and "the doctor found a
    // problem" the same observation — precisely the confusion this module exists to end.
    let results = crate::self_test::run_self_test_at(runtime.data_root()).await;
    Json(results).into_response()
}
