//! Skill discovery, detail, removal and copying for the Web/Core transport.
//!
//! These mirror the Tauri commands one for one. They existed only as commands until now, while the
//! frontend wrappers called `invoke` unconditionally — which meant every skill screen was silently
//! inert in Web mode, showing an empty list rather than an error.
//!
//! Nothing here needs a data root: skills live in the agents' own home directories, not in Alethe's
//! profile.

use axum::extract::Query;
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use std::collections::HashMap;

use super::{query_param as q, respond};
use crate::skills;

pub fn router() -> Router {
    Router::new()
        .route("/api/skills/scan", get(skills_scan))
        .route("/api/skills/detail", get(skills_detail))
        .route("/api/skills/uninstall", post(skills_uninstall))
        .route("/api/skills/sync", post(skills_sync))
}

async fn skills_scan() -> impl IntoResponse {
    respond(skills::skills_scan().await)
}

async fn skills_detail(Query(p): Query<HashMap<String, String>>) -> impl IntoResponse {
    let agent = match q(&p, "agent") {
        Ok(value) => value,
        Err(error) => return error.into_response(),
    };
    let name = match q(&p, "name") {
        Ok(value) => value,
        Err(error) => return error.into_response(),
    };
    respond(skills::skills_detail(agent, name).await)
}

#[derive(Deserialize)]
struct UninstallBody {
    agent: String,
    name: String,
}
async fn skills_uninstall(Json(body): Json<UninstallBody>) -> impl IntoResponse {
    respond(skills::skills_uninstall(body.agent, body.name).await)
}

#[derive(Deserialize)]
struct SyncBody {
    from: String,
    to: Vec<String>,
    name: String,
    overwrite: Option<bool>,
}
async fn skills_sync(Json(body): Json<SyncBody>) -> impl IntoResponse {
    respond(skills::skills_sync(body.from, body.to, body.name, body.overwrite).await)
}
