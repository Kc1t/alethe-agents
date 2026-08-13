// Agentes instalados/economy/hooks + Plugins — a maioria é função pura sem
// `AppHandle`. Exceção: `plugins.rs` (lista/instala/desinstala plugin) usa
// `AppHandle` só pra resolver `profile_data_dir()/plugins` — reaproveita o
// "core testável" já existente (`list_in`/`install_in`/`uninstall_in`,
// tornadas `pub` pra isso) com o mesmo `active_profile_dir()` usado em
// `session_routes.rs`.
//
// `codex_app_server_*` fica de fora por enquanto — depende de estado
// compartilhado (`State<...>`) + emissão de evento em tempo real
// (`agent-sandbox-app-server://event/{id}`), mesma classe de problema
// arquitetural que PTY (ver `TODO_WEB_PTY.md`).

use alethe_lib::agent_events;
use alethe_lib::agent_library;
use alethe_lib::cli_resolver;
use alethe_lib::codex_app_server::{
    codex_app_server_send_core, codex_app_server_start_core, codex_app_server_stop_core,
    CodexAppServerSink, CodexAppServerState,
};
use alethe_lib::economy_agents;
use alethe_lib::plugins::{self, PluginKind, PluginManifest};
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::Path as AxumPath;
use axum::extract::Query;
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use tokio::sync::broadcast;

use crate::profile_routes::active_profile_dir;
use crate::AppError;

fn q(params: &HashMap<String, String>, key: &str) -> Result<String, AppError> {
    params
        .get(key)
        .cloned()
        .ok_or_else(|| AppError::bad_request(format!("missing_query_param:{key}")))
}

pub fn router() -> Router {
    Router::new()
        .route("/api/agents/hooks_endpoint", get(hooks_endpoint))
        .route("/api/agents/hooks_token", get(hooks_token))
        .route("/api/agents/hooks_settings_path", get(hooks_settings_path))
        .route("/api/agents/installed", get(installed))
        .route("/api/agents/economy_enabled", get(economy_enabled))
        .route("/api/agents/set_economy", post(set_economy))
        .route("/api/agents/install", post(install))
        .route("/api/agents/uninstall", post(uninstall))
        .route("/api/agents/models", get(models))
        .route("/api/plugins/list", get(plugins_list))
        .route("/api/plugins/install", post(plugin_install))
        .route("/api/plugins/uninstall", post(plugin_uninstall))
        .route("/api/codex_app_server/start", post(codex_start))
        .route("/api/codex_app_server/send", post(codex_send))
        .route("/api/codex_app_server/stop", post(codex_stop))
        .route("/api/codex_app_server/ws/:id", get(codex_ws))
        .route("/api/agents/codex_app_server/start", post(codex_start))
        .route("/api/agents/codex_app_server/send", post(codex_send))
        .route("/api/agents/codex_app_server/stop", post(codex_stop))
        .route("/api/agents/codex_app_server/ws/:id", get(codex_ws))
}

async fn hooks_endpoint() -> impl IntoResponse {
    respond(agent_events::agent_hooks_endpoint())
}
async fn hooks_token() -> impl IntoResponse {
    Json(agent_events::agent_hooks_token())
}
async fn hooks_settings_path() -> impl IntoResponse {
    respond(agent_events::agent_hooks_settings_path())
}

async fn installed(Query(p): Query<HashMap<String, String>>) -> impl IntoResponse {
    let folder = match q(&p, "folder") {
        Ok(v) => v,
        Err(e) => return e.into_response(),
    };
    Json(agent_library::list_installed_agents(folder).await).into_response()
}

async fn economy_enabled(Query(p): Query<HashMap<String, String>>) -> impl IntoResponse {
    let folder = match q(&p, "folder") {
        Ok(v) => v,
        Err(e) => return e.into_response(),
    };
    Json(economy_agents::economy_agents_enabled(folder)).into_response()
}

#[derive(Deserialize)]
struct SetEconomyBody {
    folder: String,
    enabled: bool,
}
async fn set_economy(Json(b): Json<SetEconomyBody>) -> impl IntoResponse {
    respond(economy_agents::set_economy_agents(b.folder, b.enabled))
}

#[derive(Deserialize)]
struct InstallAgentBody {
    folder: String,
    name: String,
    content: String,
    force: bool,
}
async fn install(Json(b): Json<InstallAgentBody>) -> impl IntoResponse {
    respond(agent_library::install_agent(
        b.folder, b.name, b.content, b.force,
    ))
}

#[derive(Deserialize)]
struct UninstallAgentBody {
    folder: String,
    name: String,
    force: bool,
}
async fn uninstall(Json(b): Json<UninstallAgentBody>) -> impl IntoResponse {
    respond(agent_library::uninstall_agent(b.folder, b.name, b.force))
}

async fn models(Query(p): Query<HashMap<String, String>>) -> impl IntoResponse {
    let provider = match q(&p, "provider") {
        Ok(v) => v,
        Err(e) => return e.into_response(),
    };
    respond(cli_resolver::discover_provider_models(provider).await)
}

async fn plugins_list(Query(p): Query<HashMap<String, String>>) -> impl IntoResponse {
    let kind: Option<PluginKind> = p
        .get("kind")
        .and_then(|k| serde_json::from_value(serde_json::json!(k)).ok());
    let root = active_profile_dir().join("plugins");
    respond(plugins::list_in(&root).map(|all| match kind {
        Some(kind) => all.into_iter().filter(|m| m.kind == kind).collect(),
        None => all,
    }))
}

#[derive(Deserialize)]
struct PluginInstallBody {
    manifest: PluginManifest,
}
async fn plugin_install(Json(b): Json<PluginInstallBody>) -> impl IntoResponse {
    let root = active_profile_dir().join("plugins");
    respond(plugins::install_in(&root, &b.manifest))
}

#[derive(Deserialize)]
struct PluginUninstallBody {
    id: String,
}
async fn plugin_uninstall(Json(b): Json<PluginUninstallBody>) -> impl IntoResponse {
    let root = active_profile_dir().join("plugins");
    respond(plugins::uninstall_in(&root, &b.id))
}

fn respond<T: serde::Serialize>(result: Result<T, String>) -> axum::response::Response {
    match result {
        Ok(v) => Json(v).into_response(),
        Err(e) => AppError::from(e).into_response(),
    }
}

pub fn alethe_server_codex_app_server_state() -> &'static CodexAppServerState {
    static STATE: OnceLock<CodexAppServerState> = OnceLock::new();
    STATE.get_or_init(CodexAppServerState::default)
}

pub type CodexChannels = Arc<Mutex<HashMap<String, broadcast::Sender<Value>>>>;

pub fn codex_broadcast_channels() -> &'static CodexChannels {
    static CHANNELS: OnceLock<CodexChannels> = OnceLock::new();
    CHANNELS.get_or_init(|| Arc::new(Mutex::new(HashMap::new())))
}

fn get_or_create_codex_channel(id: &str) -> broadcast::Sender<Value> {
    let mut channels = codex_broadcast_channels().lock().unwrap();
    channels
        .entry(id.to_string())
        .or_insert_with(|| {
            let (tx, _) = broadcast::channel(1024);
            tx
        })
        .clone()
}

pub struct WebSocketCodexSink;

impl CodexAppServerSink for WebSocketCodexSink {
    fn emit_event(&self, id: &str, payload: Value) {
        let sender = get_or_create_codex_channel(id);
        let _ = sender.send(payload);
    }
}

#[derive(Deserialize)]
struct CodexStartBody {
    id: String,
    cwd: String,
}

async fn codex_start(Json(b): Json<CodexStartBody>) -> Result<(), AppError> {
    codex_app_server_start_core(
        Arc::new(WebSocketCodexSink),
        alethe_server_codex_app_server_state(),
        b.id,
        b.cwd,
    )?;
    Ok(())
}

#[derive(Deserialize)]
struct CodexSendBody {
    id: String,
    request: Value,
}

async fn codex_send(Json(b): Json<CodexSendBody>) -> Result<(), AppError> {
    codex_app_server_send_core(
        alethe_server_codex_app_server_state(),
        b.id,
        b.request,
    )?;
    Ok(())
}

#[derive(Deserialize)]
struct CodexStopBody {
    id: String,
}

async fn codex_stop(Json(b): Json<CodexStopBody>) -> Result<(), AppError> {
    codex_app_server_stop_core(
        alethe_server_codex_app_server_state(),
        b.id,
    )?;
    Ok(())
}

async fn codex_ws(
    AxumPath(id): AxumPath<String>,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_codex_socket(id, socket))
}

async fn handle_codex_socket(id: String, mut socket: WebSocket) {
    let sender = get_or_create_codex_channel(&id);
    let mut rx = sender.subscribe();

    loop {
        tokio::select! {
            msg = rx.recv() => {
                match msg {
                    Ok(event) => {
                        if let Ok(json) = serde_json::to_string(&event) {
                            if socket.send(Message::Text(json)).await.is_err() {
                                break;
                            }
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
            incoming = socket.recv() => {
                let Some(Ok(msg)) = incoming else { break };
                if let Message::Text(text) = msg {
                    if let Ok(request) = serde_json::from_str::<Value>(&text) {
                        let _ = codex_app_server_send_core(
                            alethe_server_codex_app_server_state(),
                            id.clone(),
                            request,
                        );
                    }
                }
            }
        }
    }
}
