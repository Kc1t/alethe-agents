//! Plugin discovery, detail and import for the Web/Core transport.
//!
//! These mirror the Tauri commands one for one. Nothing here needs a data root: the scan reads the
//! agent's own configuration directories, and the import target is Alethe's registered agent config
//! root, which the process resolves at startup.

use axum::extract::Query;
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use std::collections::HashMap;

use super::{query_param as q, respond};
use crate::plugins;

pub fn router() -> Router {
    Router::new()
        .route("/api/plugins/scan", get(plugins_scan))
        .route("/api/plugins/detail", get(plugins_detail))
        .route("/api/plugins/import", post(plugins_import))
}

async fn plugins_scan() -> impl IntoResponse {
    respond(plugins::plugins_scan().await)
}

async fn plugins_detail(Query(p): Query<HashMap<String, String>>) -> impl IntoResponse {
    let path = match q(&p, "path") {
        Ok(value) => value,
        Err(error) => return error.into_response(),
    };
    respond(plugins::plugins_detail(path).await)
}

#[derive(Deserialize)]
struct ImportBody {
    names: Vec<String>,
    overwrite: Option<bool>,
}
async fn plugins_import(Json(body): Json<ImportBody>) -> impl IntoResponse {
    respond(plugins::plugins_import(body.names, body.overwrite).await)
}
