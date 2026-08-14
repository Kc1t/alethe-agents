use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Extension, Path as AxumPath, Query};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::broadcast;

use crate::pty::{
    attach_pty_core, attach_pty_snapshot_core, get_pty_cwd_core, kill_pty_core,
    list_pty_processes_core, pty_exists_core, resize_pty_core, restart_pty_core,
    set_pty_priority_core, set_pty_read_state_core, set_pty_visible_core, spawn_pty_core,
    suspend_pty_core, PtySessions, SpawnPtyArgs, SpawnPtyResponse,
};
use crate::pty_sink::{get_or_create_pty_ws_channel, PtyWsMessage};

use super::{AppError, AuthenticatedLocalSession, ServerRuntime};

pub fn alethe_server_pty_sessions() -> &'static PtySessions {
    crate::pty::global_pty_sessions()
}

#[derive(Clone)]
struct ResolvedPtyOwner {
    profile_id: String,
    scrollback_path: PathBuf,
}

fn resolve_pty_owner(
    runtime: &ServerRuntime,
    id: &str,
    profile_id: &str,
) -> Result<ResolvedPtyOwner, AppError> {
    crate::pty::validate_pty_id(id)?;
    let index = crate::profiles::ensure_profiles_index_at(runtime.data_root())?;
    let profile_dir =
        crate::profiles::profile_dir_for_id_in_index(runtime.data_root(), &index, profile_id)?;
    Ok(ResolvedPtyOwner {
        profile_id: profile_id.to_string(),
        scrollback_path: profile_dir.join("scrollback").join(format!("{id}.bin")),
    })
}

fn ensure_profile_owner(
    runtime: &ServerRuntime,
    id: &str,
    profile_id: &str,
) -> Result<ResolvedPtyOwner, AppError> {
    let owner = resolve_pty_owner(runtime, id, profile_id)?;
    crate::pty::ensure_pty_owner(
        alethe_server_pty_sessions(),
        id,
        &owner.profile_id,
        &owner.scrollback_path,
    )?;
    Ok(owner)
}

async fn handle_spawn(
    Extension(runtime): Extension<Arc<ServerRuntime>>,
    Json(args): Json<SpawnPtyArgs>,
) -> Result<Json<SpawnPtyResponse>, AppError> {
    let pty_id = args.id.clone().unwrap_or_else(|| nanoid::nanoid!());
    let owner = resolve_pty_owner(&runtime, &pty_id, &args.profile_id)?;
    let mut full_args = args;
    full_args.id = Some(pty_id);
    full_args.profile_id = owner.profile_id;

    let res = spawn_pty_core(
        alethe_server_pty_sessions().clone(),
        runtime.pty_sink(),
        crate::remote::hub(),
        None,
        owner.scrollback_path,
        full_args,
    )
    .await?;

    Ok(Json(res))
}

async fn handle_exists(
    Extension(runtime): Extension<Arc<ServerRuntime>>,
    AxumPath(id): AxumPath<String>,
    Query(query): Query<PtyProfileQuery>,
) -> Json<bool> {
    if ensure_profile_owner(&runtime, &id, &query.profile_id).is_err() {
        return Json(false);
    }
    let exists = pty_exists_core(alethe_server_pty_sessions(), &id);
    Json(exists)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PtyProfileQuery {
    profile_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AttachQuery {
    max_bytes: Option<usize>,
    profile_id: String,
}

async fn handle_attach(
    Extension(runtime): Extension<Arc<ServerRuntime>>,
    AxumPath(id): AxumPath<String>,
    Query(query): Query<AttachQuery>,
) -> Result<String, AppError> {
    let owner = ensure_profile_owner(&runtime, &id, &query.profile_id)?;
    let max_bytes = query.max_bytes.unwrap_or(512 * 1024);
    let data = attach_pty_core(
        alethe_server_pty_sessions(),
        &owner.scrollback_path,
        &id,
        max_bytes,
    )
    .await?;
    Ok(data)
}

async fn handle_snapshot(
    Extension(runtime): Extension<Arc<ServerRuntime>>,
    AxumPath(id): AxumPath<String>,
    Query(query): Query<AttachQuery>,
) -> Result<Json<crate::pty::PtyScrollbackSnapshot>, AppError> {
    let owner = ensure_profile_owner(&runtime, &id, &query.profile_id)?;
    let max_bytes = query.max_bytes.unwrap_or(512 * 1024);
    Ok(Json(
        attach_pty_snapshot_core(
            alethe_server_pty_sessions(),
            &owner.scrollback_path,
            &id,
            max_bytes,
        )
        .await?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WriteBody {
    id: String,
    data: String,
    profile_id: String,
}

async fn handle_write(
    Extension(runtime): Extension<Arc<ServerRuntime>>,
    Json(body): Json<WriteBody>,
) -> Result<(), AppError> {
    let owner = ensure_profile_owner(&runtime, &body.id, &body.profile_id)?;
    crate::pty::write_pty_core(
        alethe_server_pty_sessions(),
        &body.id,
        &body.data,
        Some(&owner.profile_id),
        Some(&owner.scrollback_path),
    )
    .await?;
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResizeBody {
    id: String,
    cols: u16,
    rows: u16,
    profile_id: String,
}

async fn handle_resize(
    Extension(runtime): Extension<Arc<ServerRuntime>>,
    Json(body): Json<ResizeBody>,
) -> Result<(), AppError> {
    let owner = ensure_profile_owner(&runtime, &body.id, &body.profile_id)?;
    resize_pty_core(
        alethe_server_pty_sessions(),
        None,
        &body.id,
        body.cols,
        body.rows,
        Some(&owner.profile_id),
        Some(&owner.scrollback_path),
    )
    .await?;
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct KillBody {
    id: String,
    profile_id: String,
}

async fn handle_kill(
    Extension(runtime): Extension<Arc<ServerRuntime>>,
    Json(body): Json<KillBody>,
) -> Result<(), AppError> {
    let owner = ensure_profile_owner(&runtime, &body.id, &body.profile_id)?;
    kill_pty_core(
        alethe_server_pty_sessions(),
        &owner.scrollback_path,
        &body.id,
    )
    .await?;
    Ok(())
}

async fn handle_suspend(
    Extension(runtime): Extension<Arc<ServerRuntime>>,
    Json(body): Json<KillBody>,
) -> Result<Json<bool>, AppError> {
    let owner = ensure_profile_owner(&runtime, &body.id, &body.profile_id)?;
    let log_path = owner
        .scrollback_path
        .parent()
        .and_then(std::path::Path::parent)
        .map(|profile_dir| profile_dir.join("spawn.log"));
    let suspended = suspend_pty_core(
        alethe_server_pty_sessions(),
        runtime.pty_sink(),
        log_path,
        &body.id,
    )
    .await?;
    Ok(Json(suspended))
}

async fn handle_restart(
    Extension(runtime): Extension<Arc<ServerRuntime>>,
    Json(args): Json<SpawnPtyArgs>,
) -> Result<Json<SpawnPtyResponse>, AppError> {
    let pty_id = args
        .id
        .clone()
        .ok_or_else(|| AppError::bad_request("Terminal ID is required for restart"))?;
    let owner = resolve_pty_owner(&runtime, &pty_id, &args.profile_id)?;
    let mut args = args;
    args.profile_id = owner.profile_id;

    let res = restart_pty_core(
        alethe_server_pty_sessions().clone(),
        runtime.pty_sink(),
        crate::remote::hub(),
        None,
        owner.scrollback_path,
        args,
    )
    .await?;

    Ok(Json(res))
}

async fn handle_cwd(
    Extension(runtime): Extension<Arc<ServerRuntime>>,
    AxumPath(id): AxumPath<String>,
    Query(query): Query<PtyProfileQuery>,
) -> Result<Json<Option<String>>, AppError> {
    ensure_profile_owner(&runtime, &id, &query.profile_id)?;
    let cwd = get_pty_cwd_core(alethe_server_pty_sessions(), &id).await?;
    Ok(Json(cwd))
}

async fn handle_processes(
    Extension(runtime): Extension<Arc<ServerRuntime>>,
    Query(query): Query<PtyProfileQuery>,
) -> Result<Json<Vec<crate::pty::PtyProcessSnapshot>>, AppError> {
    let _ = resolve_pty_owner(&runtime, "ownership-check", &query.profile_id)?;
    let snapshots =
        list_pty_processes_core(alethe_server_pty_sessions(), Some(&query.profile_id)).await?;
    Ok(Json(snapshots))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StateBody {
    id: String,
    active: bool,
    profile_id: String,
}

async fn handle_read_state(
    Extension(runtime): Extension<Arc<ServerRuntime>>,
    Json(body): Json<StateBody>,
) -> Result<(), AppError> {
    ensure_profile_owner(&runtime, &body.id, &body.profile_id)?;
    set_pty_read_state_core(alethe_server_pty_sessions(), &body.id, body.active)?;
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct VisibleBody {
    id: String,
    visible: bool,
    profile_id: String,
}

async fn handle_visible(
    Extension(runtime): Extension<Arc<ServerRuntime>>,
    Json(body): Json<VisibleBody>,
) -> Result<(), AppError> {
    ensure_profile_owner(&runtime, &body.id, &body.profile_id)?;
    set_pty_visible_core(alethe_server_pty_sessions(), &body.id, body.visible)?;
    Ok(())
}

async fn handle_priority(
    Extension(runtime): Extension<Arc<ServerRuntime>>,
    Json(body): Json<StateBody>,
) -> Result<(), AppError> {
    ensure_profile_owner(&runtime, &body.id, &body.profile_id)?;
    set_pty_priority_core(alethe_server_pty_sessions(), &body.id, body.active).await?;
    Ok(())
}

async fn handle_tree(
    Extension(runtime): Extension<Arc<ServerRuntime>>,
    AxumPath(id): AxumPath<String>,
    Query(query): Query<PtyProfileQuery>,
) -> Result<Json<Option<crate::process_tree::PtyTreeInfo>>, AppError> {
    let owner = ensure_profile_owner(&runtime, &id, &query.profile_id)?;
    let root_pid = crate::pty::owned_pty_root_pid(
        alethe_server_pty_sessions(),
        &id,
        &owner.profile_id,
        &owner.scrollback_path,
    )?;
    Ok(Json(Some(crate::process_tree::get_pty_tree_for_root(
        &id, root_pid,
    ))))
}

async fn handle_tree_kill(
    Extension(runtime): Extension<Arc<ServerRuntime>>,
    AxumPath(id): AxumPath<String>,
    Query(query): Query<PtyProfileQuery>,
) -> Result<Json<Vec<u32>>, AppError> {
    let owner = ensure_profile_owner(&runtime, &id, &query.profile_id)?;
    let root_pid = crate::pty::owned_pty_root_pid(
        alethe_server_pty_sessions(),
        &id,
        &owner.profile_id,
        &owner.scrollback_path,
    )?
    .ok_or_else(|| AppError::bad_request(format!("No root PID registered for PTY: {id}")))?;
    let killed = crate::process_tree::kill_pty_tree_for_root(id, root_pid).await?;
    Ok(Json(killed))
}

async fn handle_ws(
    Extension(runtime): Extension<Arc<ServerRuntime>>,
    Extension(session): Extension<AuthenticatedLocalSession>,
    AxumPath(id): AxumPath<String>,
    Query(query): Query<PtyProfileQuery>,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    let owner = match ensure_profile_owner(&runtime, &id, &query.profile_id) {
        Ok(owner) => owner,
        Err(error) => return error.into_response(),
    };
    let session_token = session.token().to_string();
    ws.protocols([format!("alethe-auth.{session_token}")])
        .on_upgrade(move |socket| handle_socket(id, owner, runtime, session_token, socket))
        .into_response()
}

#[derive(Deserialize)]
#[serde(tag = "type")]
enum IncomingWsMessage {
    #[serde(rename = "input")]
    Input { data: String },
    #[serde(rename = "resize")]
    Resize { cols: u16, rows: u16 },
}

async fn send_ws_event(socket: &mut WebSocket, event: &PtyWsMessage) -> Result<(), ()> {
    let json = serde_json::to_string(event).map_err(|_| ())?;
    socket.send(Message::Text(json)).await.map_err(|_| ())
}

async fn handle_socket(
    id: String,
    owner: ResolvedPtyOwner,
    runtime: Arc<ServerRuntime>,
    session_token: String,
    mut socket: WebSocket,
) {
    if !pty_exists_core(alethe_server_pty_sessions(), &id) {
        let _ = send_ws_event(&mut socket, &PtyWsMessage::Missing).await;
        return;
    }
    let sender = get_or_create_pty_ws_channel(&id);
    let mut rx = sender.subscribe();
    let mut auth_check = tokio::time::interval(std::time::Duration::from_secs(15));

    loop {
        tokio::select! {
            _ = auth_check.tick() => {
                if !runtime.session_is_valid(&session_token) {
                    break;
                }
            }
            msg = rx.recv() => {
                match msg {
                    Ok(event) => {
                        // A stable channel can outlive one PTY generation. Stop
                        // before a reused id from another profile can fan out.
                        if pty_exists_core(alethe_server_pty_sessions(), &id)
                            && crate::pty::ensure_pty_owner(
                                alethe_server_pty_sessions(),
                                &id,
                                &owner.profile_id,
                                &owner.scrollback_path,
                            )
                            .is_err()
                        {
                            break;
                        }
                        if send_ws_event(&mut socket, &event).await.is_err() {
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(dropped)) => {
                        // A broadcast receiver cannot recover the missing bytes.
                        // Tell the client to rebuild its view from scrollback.
                        let gap = PtyWsMessage::Gap { dropped };
                        if send_ws_event(&mut socket, &gap).await.is_err() {
                            break;
                        }
                    },
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
            incoming = socket.recv() => {
                let Some(Ok(msg)) = incoming else { break };
                if let Message::Text(text) = msg {
                    if let Ok(cmd) = serde_json::from_str::<IncomingWsMessage>(&text) {
                        if !pty_exists_core(alethe_server_pty_sessions(), &id)
                            || crate::pty::ensure_pty_owner(
                                alethe_server_pty_sessions(),
                                &id,
                                &owner.profile_id,
                                &owner.scrollback_path,
                            )
                            .is_err()
                        {
                            let _ = send_ws_event(&mut socket, &PtyWsMessage::Missing).await;
                            break;
                        }
                        match cmd {
                            IncomingWsMessage::Input { data } => {
                                let _ = crate::pty::write_pty_core(
                                    alethe_server_pty_sessions(),
                                    &id,
                                    &data,
                                    Some(&owner.profile_id),
                                    Some(&owner.scrollback_path),
                                )
                                .await;
                            }
                            IncomingWsMessage::Resize { cols, rows } => {
                                let _ = resize_pty_core(
                                    alethe_server_pty_sessions(),
                                    None,
                                    &id,
                                    cols,
                                    rows,
                                    Some(&owner.profile_id),
                                    Some(&owner.scrollback_path),
                                )
                                .await;
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
        .route("/api/pty/snapshot/:id", get(handle_snapshot))
        .route("/api/pty/write", post(handle_write))
        .route("/api/pty/resize", post(handle_resize))
        .route("/api/pty/kill", post(handle_kill))
        .route("/api/pty/suspend", post(handle_suspend))
        .route("/api/window/suspend_pty", post(handle_suspend))
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
