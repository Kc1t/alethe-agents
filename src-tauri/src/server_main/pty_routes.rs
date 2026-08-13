use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path as AxumPath, Query};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use tokio::sync::broadcast;

use alethe_lib::pty::{
    attach_pty_core, get_pty_cwd_core, kill_pty_core, list_pty_processes_core, pty_exists_core,
    resize_pty_core, restart_pty_core, set_pty_priority_core, set_pty_read_state_core,
    set_pty_visible_core, spawn_pty_core, PtyExitPayload, PtySessions, PtySuspendedPayload,
    SpawnPtyArgs, SpawnPtyResponse,
};
use alethe_lib::pty_sink::PtyOutputSink;

use super::profile_routes::active_profile_dir;
use super::AppError;

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum PtyWsMessage {
    #[serde(rename = "data")]
    Data { chunk: String },
    #[serde(rename = "exit")]
    Exit {
        code: Option<i32>,
        reason: String,
    },
}

pub type PtyChannels = Arc<Mutex<HashMap<String, broadcast::Sender<PtyWsMessage>>>>;

pub fn pty_broadcast_channels() -> &'static PtyChannels {
    static CHANNELS: OnceLock<PtyChannels> = OnceLock::new();
    CHANNELS.get_or_init(|| Arc::new(Mutex::new(HashMap::new())))
}

pub fn alethe_server_pty_sessions() -> &'static PtySessions {
    static SESSIONS: OnceLock<PtySessions> = OnceLock::new();
    SESSIONS.get_or_init(|| Arc::new(Mutex::new(HashMap::new())))
}

fn get_or_create_channel(id: &str) -> broadcast::Sender<PtyWsMessage> {
    let mut channels = pty_broadcast_channels().lock().unwrap();
    channels
        .entry(id.to_string())
        .or_insert_with(|| {
            let (tx, _) = broadcast::channel(1024);
            tx
        })
        .clone()
}

pub struct WebSocketSink;

impl PtyOutputSink for WebSocketSink {
    fn emit_data(&self, id: &str, text: &str) {
        let sender = get_or_create_channel(id);
        let _ = sender.send(PtyWsMessage::Data {
            chunk: text.to_string(),
        });
    }

    fn emit_activity(&self, id: &str, text: &str) {
        let sender = get_or_create_channel(id);
        let _ = sender.send(PtyWsMessage::Data {
            chunk: text.to_string(),
        });
    }

    fn emit_exit(&self, id: &str, payload: &PtyExitPayload) {
        let sender = get_or_create_channel(id);
        let _ = sender.send(PtyWsMessage::Exit {
            code: payload.code,
            reason: payload.reason.to_string(),
        });
        let mut channels = pty_broadcast_channels().lock().unwrap();
        channels.remove(id);
    }

    fn emit_suspended(&self, payload: &PtySuspendedPayload) {
        let sender = get_or_create_channel(&payload.id);
        let _ = sender.send(PtyWsMessage::Exit {
            code: None,
            reason: payload.reason.to_string(),
        });
        let mut channels = pty_broadcast_channels().lock().unwrap();
        channels.remove(&payload.id);
    }
}

fn resolve_scrollback_path(id: &str) -> PathBuf {
    let dir = active_profile_dir().join("scrollback");
    dir.join(format!("{id}.bin"))
}

async fn handle_spawn(Json(args): Json<SpawnPtyArgs>) -> Result<Json<SpawnPtyResponse>, AppError> {
    let pty_id = args.id.clone().unwrap_or_else(|| nanoid::nanoid!());
    let sb_path = resolve_scrollback_path(&pty_id);
    let mut full_args = args;
    full_args.id = Some(pty_id);

    let res = spawn_pty_core(
        alethe_server_pty_sessions().clone(),
        Arc::new(WebSocketSink),
        alethe_lib::remote::hub(),
        None,
        sb_path,
        full_args,
    )
    .await?;

    Ok(Json(res))
}

async fn handle_exists(AxumPath(id): AxumPath<String>) -> Json<bool> {
    let exists = pty_exists_core(alethe_server_pty_sessions(), &id);
    Json(exists)
}

#[derive(Deserialize)]
struct AttachQuery {
    #[serde(rename = "maxBytes")]
    max_bytes: Option<usize>,
}

async fn handle_attach(
    AxumPath(id): AxumPath<String>,
    Query(query): Query<AttachQuery>,
) -> Result<String, AppError> {
    let sb_path = resolve_scrollback_path(&id);
    let max_bytes = query.max_bytes.unwrap_or(512 * 1024);
    let data = attach_pty_core(alethe_server_pty_sessions(), &sb_path, &id, max_bytes).await?;
    Ok(data)
}

#[derive(Deserialize)]
struct WriteBody {
    id: String,
    data: String,
}

async fn handle_write(Json(body): Json<WriteBody>) -> Result<(), AppError> {
    alethe_lib::pty::write_pty_core(alethe_server_pty_sessions(), &body.id, &body.data).await?;
    Ok(())
}

#[derive(Deserialize)]
struct ResizeBody {
    id: String,
    cols: u16,
    rows: u16,
}

async fn handle_resize(Json(body): Json<ResizeBody>) -> Result<(), AppError> {
    resize_pty_core(
        alethe_server_pty_sessions(),
        None,
        &body.id,
        body.cols,
        body.rows,
    )
    .await?;
    Ok(())
}

#[derive(Deserialize)]
struct KillBody {
    id: String,
}

async fn handle_kill(Json(body): Json<KillBody>) -> Result<(), AppError> {
    let sb_path = resolve_scrollback_path(&body.id);
    kill_pty_core(alethe_server_pty_sessions(), &sb_path, &body.id).await?;
    Ok(())
}

async fn handle_restart(Json(args): Json<SpawnPtyArgs>) -> Result<Json<SpawnPtyResponse>, AppError> {
    let pty_id = args.id.clone().ok_or_else(|| AppError::bad_request("ID do terminal obrigatorio no restart"))?;
    let sb_path = resolve_scrollback_path(&pty_id);

    let res = restart_pty_core(
        alethe_server_pty_sessions().clone(),
        Arc::new(WebSocketSink),
        alethe_lib::remote::hub(),
        None,
        sb_path,
        args,
    )
    .await?;

    Ok(Json(res))
}

async fn handle_cwd(AxumPath(id): AxumPath<String>) -> Result<Json<Option<String>>, AppError> {
    let cwd = get_pty_cwd_core(alethe_server_pty_sessions(), &id).await?;
    Ok(Json(cwd))
}

async fn handle_processes() -> Result<Json<Vec<alethe_lib::pty::PtyProcessSnapshot>>, AppError> {
    let snapshots = list_pty_processes_core(alethe_server_pty_sessions()).await?;
    Ok(Json(snapshots))
}

#[derive(Deserialize)]
struct StateBody {
    id: String,
    active: bool,
}

async fn handle_read_state(Json(body): Json<StateBody>) -> Result<(), AppError> {
    set_pty_read_state_core(alethe_server_pty_sessions(), &body.id, body.active)?;
    Ok(())
}

#[derive(Deserialize)]
struct VisibleBody {
    id: String,
    visible: bool,
}

async fn handle_visible(Json(body): Json<VisibleBody>) -> Result<(), AppError> {
    set_pty_visible_core(alethe_server_pty_sessions(), &body.id, body.visible)?;
    Ok(())
}

async fn handle_priority(Json(body): Json<StateBody>) -> Result<(), AppError> {
    set_pty_priority_core(alethe_server_pty_sessions(), &body.id, body.active).await?;
    Ok(())
}

async fn handle_tree(AxumPath(id): AxumPath<String>) -> Result<Json<Option<alethe_lib::process_tree::PtyTreeInfo>>, AppError> {
    let info = alethe_lib::process_tree::get_pty_tree_info(id);
    Ok(Json(info))
}

async fn handle_tree_kill(AxumPath(id): AxumPath<String>) -> Result<Json<Vec<u32>>, AppError> {
    let killed = alethe_lib::process_tree::kill_pty_tree_cmd(id).await?;
    Ok(Json(killed))
}

async fn handle_ws(
    AxumPath(id): AxumPath<String>,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(id, socket))
}

#[derive(Deserialize)]
#[serde(tag = "type")]
enum IncomingWsMessage {
    #[serde(rename = "input")]
    Input { data: String },
    #[serde(rename = "resize")]
    Resize { cols: u16, rows: u16 },
}

async fn handle_socket(id: String, mut socket: WebSocket) {
    let sender = get_or_create_channel(&id);
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
                    if let Ok(cmd) = serde_json::from_str::<IncomingWsMessage>(&text) {
                        match cmd {
                            IncomingWsMessage::Input { data } => {
                                let _ = alethe_lib::pty::write_pty_core(alethe_server_pty_sessions(), &id, &data).await;
                            }
                            IncomingWsMessage::Resize { cols, rows } => {
                                let _ = resize_pty_core(alethe_server_pty_sessions(), None, &id, cols, rows).await;
                            }
                        }
                    }
                }
            }
        }
    }
}

pub fn router() -> Router {
    Router::new()
        .route("/api/pty/spawn", post(handle_spawn))
        .route("/api/pty/exists/:id", get(handle_exists))
        .route("/api/pty/attach/:id", get(handle_attach))
        .route("/api/pty/write", post(handle_write))
        .route("/api/pty/resize", post(handle_resize))
        .route("/api/pty/kill", post(handle_kill))
        .route("/api/pty/restart", post(handle_restart))
        .route("/api/pty/cwd/:id", get(handle_cwd))
        .route("/api/pty/processes", get(handle_processes))
        .route("/api/pty/read_state", post(handle_read_state))
        .route("/api/pty/visible", post(handle_visible))
        .route("/api/pty/priority", post(handle_priority))
        .route("/api/pty/tree/:id", get(handle_tree))
        .route("/api/pty/tree/:id/kill", post(handle_tree_kill))
        .route("/api/pty/ws/:id", get(handle_ws))
}
