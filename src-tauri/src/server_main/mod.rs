pub mod agent_routes;
pub mod ai_memory_routes;
pub mod backup_routes;
pub mod event_routes;
pub mod fs_cli_routes;
pub mod git_routes;
pub mod github_sync_routes;
pub mod misc_routes;
pub mod profile_routes;
pub mod pty_routes;
pub mod session_routes;
pub mod skills_routes;
pub mod plugins_routes;
pub mod self_test_routes;
pub mod sync_activation_routes;
pub mod sync_access_routes;
pub mod sync_invitation_bridge_routes;
pub mod sync_rendezvous_routes;
pub mod sync_chat_routes;
pub mod sync_engine_routes;
pub mod sync_security_routes;
pub mod sync_staging_routes;
pub mod sync_subscription_routes;
pub mod sync_tasks_routes;
pub mod window_routes;

use crate::pty_sink::PtyOutputSink;
use axum::extract::Request;
use axum::http::{header, HeaderValue, Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Extension, Json, Router};
use serde::Serialize;
use serde_json::json;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tokio::sync::broadcast;
use tauri::Manager;
use tower_http::cors::CorsLayer;

/// Preferred port. Only a starting point: a second Alethe (a dev build
/// alongside the installed one, say) takes the next free port in
/// `SERVER_PORT_RANGE` instead of failing to start. `ALETHE_SERVER_PORT` pins
/// it explicitly and disables the scan.
pub const SERVER_HOST: &str = "127.0.0.1";
pub const SERVER_DEFAULT_PORT: u16 = 1423;
pub const SERVER_PORT_RANGE: u16 = 20;
pub const SERVER_BIND_ADDRESS: &str = "127.0.0.1:1423";

/// Port this process actually bound. 0 until the listener is up.
static LISTEN_PORT: std::sync::atomic::AtomicU16 = std::sync::atomic::AtomicU16::new(0);

pub fn listen_port() -> u16 {
    LISTEN_PORT.load(std::sync::atomic::Ordering::SeqCst)
}

/// `127.0.0.1:<port>` the core is serving on, for the frontend to target.
pub fn listen_address() -> String {
    format!("{SERVER_HOST}:{}", listen_port())
}

/// Exposes the bound port to the frontend, which cannot otherwise know it —
/// the core no longer always sits on a fixed one (see `bind_server_listener`).
#[tauri::command]
pub fn get_core_port() -> u16 {
    listen_port()
}

/// Binds the preferred port, falling back to the next free one in the range.
/// Returns the listener plus the port it landed on.
pub async fn bind_server_listener() -> Result<(tokio::net::TcpListener, u16), String> {
    let pinned = std::env::var("ALETHE_SERVER_PORT")
        .ok()
        .and_then(|value| value.trim().parse::<u16>().ok());
    let first = pinned.unwrap_or(SERVER_DEFAULT_PORT);
    let last = if pinned.is_some() {
        first
    } else {
        first.saturating_add(SERVER_PORT_RANGE)
    };

    let mut last_error = String::new();
    for port in first..=last {
        match tokio::net::TcpListener::bind(format!("{SERVER_HOST}:{port}")).await {
            Ok(listener) => {
                LISTEN_PORT.store(port, std::sync::atomic::Ordering::SeqCst);
                return Ok((listener, port));
            }
            Err(error) => last_error = error.to_string(),
        }
    }
    Err(format!(
        "no free port for the core between {first} and {last}: {last_error}"
    ))
}

const ALLOWED_WEB_ORIGINS: [&str; 3] = [
    "http://tauri.localhost",
    "https://tauri.localhost",
    "tauri://localhost",
];

/// Loopback host names accepted with any port. Only these literals: an
/// attacker-controlled name that resolves to 127.0.0.1 still gets rejected,
/// which is what keeps DNS rebinding out.
const LOOPBACK_HOSTS: [&str; 2] = ["127.0.0.1", "localhost"];

const LOCAL_SESSION_TTL_MS: u64 = 15 * 60 * 1000;
const LOCAL_SESSION_REFRESH_WINDOW_MS: u64 = 60 * 1000;
const LOCAL_SESSION_GRACE_MS: u64 = 30 * 1000;
const CORE_EVENT_CHANNEL_CAPACITY: usize = 256;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalSessionCredentials {
    token: String,
    expires_at_ms: u64,
    refresh_after_ms: u64,
    generation: u64,
    instance_id: String,
}

#[derive(Clone, Debug)]
struct PreviousLocalSession {
    token: String,
    valid_until_ms: u64,
}

#[derive(Debug)]
struct LocalSessionState {
    token: String,
    expires_at_ms: u64,
    refresh_after_ms: u64,
    generation: u64,
    previous: Option<PreviousLocalSession>,
}

impl LocalSessionState {
    fn new(now_ms: u64) -> Self {
        Self {
            token: nanoid::nanoid!(32),
            expires_at_ms: now_ms.saturating_add(LOCAL_SESSION_TTL_MS),
            refresh_after_ms: now_ms
                .saturating_add(LOCAL_SESSION_TTL_MS - LOCAL_SESSION_REFRESH_WINDOW_MS),
            generation: 1,
            previous: None,
        }
    }

    fn rotate_if_due(&mut self, now_ms: u64) {
        if now_ms < self.refresh_after_ms {
            return;
        }

        let previous = PreviousLocalSession {
            token: std::mem::replace(&mut self.token, nanoid::nanoid!(32)),
            valid_until_ms: self
                .expires_at_ms
                .min(now_ms.saturating_add(LOCAL_SESSION_GRACE_MS)),
        };
        self.expires_at_ms = now_ms.saturating_add(LOCAL_SESSION_TTL_MS);
        self.refresh_after_ms =
            now_ms.saturating_add(LOCAL_SESSION_TTL_MS - LOCAL_SESSION_REFRESH_WINDOW_MS);
        self.generation = self.generation.saturating_add(1);
        self.previous = Some(previous);
    }

    fn is_valid(&self, token: &str, now_ms: u64) -> bool {
        (now_ms < self.expires_at_ms && tokens_equal(token, &self.token))
            || self.previous.as_ref().is_some_and(|previous| {
                now_ms < previous.valid_until_ms && tokens_equal(token, &previous.token)
            })
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreSyncEvent {
    pub sequence: u64,
    pub reason: String,
    pub active_profile_id: String,
    pub profiles: Vec<crate::profiles::ProfileMeta>,
    pub active_projects_revision: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub changed_profile_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub changed_projects_revision: Option<String>,
}

#[derive(Clone)]
pub(crate) struct AuthenticatedLocalSession {
    token: String,
}

impl AuthenticatedLocalSession {
    pub(crate) fn token(&self) -> &str {
        &self.token
    }
}

#[derive(Clone)]
pub struct ServerRuntime {
    instance_id: String,
    mode: &'static str,
    pid: u32,
    app_identifier: String,
    data_root: PathBuf,
    data_root_id: String,
    pty_sink: Arc<dyn PtyOutputSink>,
    auth_session: Arc<Mutex<LocalSessionState>>,
    sync_events: broadcast::Sender<CoreSyncEvent>,
    // Guards sequence allocation *and* the disk snapshot read that goes with
    // it, so two concurrent publishers can never interleave: the broadcast
    // wire order always matches the sequence order, and a request that
    // started later can never have its snapshot overwritten on the wire by
    // one that started earlier but is slower to read from disk.
    sync_publish: Arc<Mutex<u64>>,
    rendezvous_runtime: Arc<crate::sync_rendezvous::RendezvousRuntime>,
}

impl ServerRuntime {
    pub fn standalone() -> Result<Self, String> {
        let app_identifier = crate::profiles::resolve_standalone_identifier()?;
        let data_root = crate::profiles::resolve_standalone_data_root()?;
        Ok(Self::new(
            "standalone",
            app_identifier,
            data_root,
            Arc::new(crate::pty_sink::WebSocketSink),
            Arc::new(crate::sync_rendezvous::RendezvousRuntime::default()),
        ))
    }

    pub fn embedded(app_identifier: String, data_root: PathBuf, app: tauri::AppHandle) -> Self {
        let rendezvous_runtime = app
            .state::<Arc<crate::sync_rendezvous::RendezvousRuntime>>()
            .inner()
            .clone();
        Self::new(
            "embedded",
            app_identifier,
            data_root,
            Arc::new(crate::pty_sink::CombinedSink(
                crate::pty_sink::TauriSink(app),
                crate::pty_sink::WebSocketSink,
            )),
            rendezvous_runtime,
        )
    }

    fn new(
        mode: &'static str,
        app_identifier: String,
        data_root: PathBuf,
        pty_sink: Arc<dyn PtyOutputSink>,
        rendezvous_runtime: Arc<crate::sync_rendezvous::RendezvousRuntime>,
    ) -> Self {
        let data_root_id = crate::profiles::data_root_fingerprint(&data_root);
        let (sync_events, _) = broadcast::channel(CORE_EVENT_CHANNEL_CAPACITY);
        Self {
            instance_id: format!("alethe-{}-{}", std::process::id(), nanoid::nanoid!(8)),
            mode,
            pid: std::process::id(),
            app_identifier,
            data_root,
            data_root_id,
            pty_sink,
            auth_session: Arc::new(Mutex::new(LocalSessionState::new(
                crate::provider_common::now_ms(),
            ))),
            sync_events,
            sync_publish: Arc::new(Mutex::new(0)),
            rendezvous_runtime,
        }
    }

    pub fn instance_id(&self) -> &str {
        &self.instance_id
    }

    pub fn app_identifier(&self) -> &str {
        &self.app_identifier
    }

    pub fn data_root(&self) -> &Path {
        &self.data_root
    }

    pub fn pty_sink(&self) -> Arc<dyn PtyOutputSink> {
        Arc::clone(&self.pty_sink)
    }

    pub fn rendezvous_runtime(&self) -> Arc<crate::sync_rendezvous::RendezvousRuntime> {
        Arc::clone(&self.rendezvous_runtime)
    }

    fn session_credentials(&self) -> LocalSessionCredentials {
        let mut session = self
            .auth_session
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        session.rotate_if_due(crate::provider_common::now_ms());
        LocalSessionCredentials {
            token: session.token.clone(),
            expires_at_ms: session.expires_at_ms,
            refresh_after_ms: session.refresh_after_ms,
            generation: session.generation,
            instance_id: self.instance_id.clone(),
        }
    }

    pub(crate) fn session_is_valid(&self, token: &str) -> bool {
        self.auth_session
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .is_valid(token, crate::provider_common::now_ms())
    }

    pub fn subscribe_sync_events(&self) -> broadcast::Receiver<CoreSyncEvent> {
        self.sync_events.subscribe()
    }

    pub fn current_sync_event(&self, reason: impl Into<String>) -> Result<CoreSyncEvent, String> {
        let sequence = *self
            .sync_publish
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        self.build_sync_event(reason.into(), None, None, sequence)
    }

    pub fn publish_sync_event(
        &self,
        reason: impl Into<String>,
        changed_profile_id: Option<String>,
        changed_projects_revision: Option<String>,
    ) -> Result<CoreSyncEvent, String> {
        let mut sequence_guard = self
            .sync_publish
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *sequence_guard += 1;
        let sequence = *sequence_guard;
        // The disk read and the broadcast happen while still holding the
        // lock, so a slower concurrent publisher can never land its older
        // snapshot on the wire after this one.
        let event = self.build_sync_event(
            reason.into(),
            changed_profile_id,
            changed_projects_revision,
            sequence,
        )?;
        let _ = self.sync_events.send(event.clone());
        Ok(event)
    }

    fn build_sync_event(
        &self,
        reason: String,
        changed_profile_id: Option<String>,
        changed_projects_revision: Option<String>,
        sequence: u64,
    ) -> Result<CoreSyncEvent, String> {
        let bootstrap = crate::projects::load_projects_bootstrap_at(&self.data_root)?;
        Ok(CoreSyncEvent {
            sequence,
            reason,
            active_profile_id: bootstrap.active_profile_id,
            profiles: bootstrap.profiles,
            active_projects_revision: bootstrap.revision,
            changed_profile_id,
            changed_projects_revision,
        })
    }
}

pub struct AppError(pub axum::http::StatusCode, pub String);

pub(super) fn query_param(params: &HashMap<String, String>, key: &str) -> Result<String, AppError> {
    params
        .get(key)
        .cloned()
        .ok_or_else(|| AppError::bad_request(format!("missing_query_param:{key}")))
}

pub(super) fn respond<T: Serialize>(result: Result<T, String>) -> Response {
    match result {
        Ok(value) => Json(value).into_response(),
        Err(error) => AppError::from(error).into_response(),
    }
}

impl AppError {
    pub fn bad_request(message: impl Into<String>) -> Self {
        AppError(axum::http::StatusCode::BAD_REQUEST, message.into())
    }
}

impl From<String> for AppError {
    fn from(message: String) -> Self {
        AppError(axum::http::StatusCode::BAD_REQUEST, message)
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        (self.0, self.1).into_response()
    }
}

fn runtime_payload(runtime: &ServerRuntime) -> serde_json::Value {
    json!({
        "service": "alethe-core",
        "apiVersion": 1,
        "instanceId": runtime.instance_id,
        "mode": runtime.mode,
        "pid": runtime.pid,
        "appIdentifier": runtime.app_identifier,
        "dataRootId": runtime.data_root_id,
        "listenAddress": listen_address(),
        "eventStream": "/api/events/ws",
        "sessionTtlMs": LOCAL_SESSION_TTL_MS,
    })
}

async fn health(Extension(runtime): Extension<Arc<ServerRuntime>>) -> impl IntoResponse {
    (
        [(header::CACHE_CONTROL, "no-store")],
        Json(json!({
            "status": "ok",
            "service": "alethe-core",
            "runtime": runtime_payload(&runtime),
        })),
    )
}

async fn runtime_info(Extension(runtime): Extension<Arc<ServerRuntime>>) -> impl IntoResponse {
    (
        [(header::CACHE_CONTROL, "no-store")],
        Json(runtime_payload(&runtime)),
    )
}

async fn create_session(Extension(runtime): Extension<Arc<ServerRuntime>>) -> impl IntoResponse {
    (
        [(header::CACHE_CONTROL, "no-store")],
        Json(runtime.session_credentials()),
    )
}

async fn not_implemented(uri: axum::http::Uri) -> impl IntoResponse {
    (
        axum::http::StatusCode::NOT_IMPLEMENTED,
        Json(json!({ "error": "not_implemented", "path": uri.path() })),
    )
}

fn is_loopback_authority(authority: &str) -> bool {
    let name = match authority.rsplit_once(':') {
        Some((name, port)) => {
            if port.is_empty() || !port.bytes().all(|b| b.is_ascii_digit()) {
                return false;
            }
            name
        }
        None => authority,
    };
    LOOPBACK_HOSTS
        .iter()
        .any(|allowed| name.eq_ignore_ascii_case(allowed))
}

fn origin_is_allowed(origin: &HeaderValue) -> bool {
    if ALLOWED_WEB_ORIGINS
        .iter()
        .any(|allowed| origin.as_bytes() == allowed.as_bytes())
    {
        return true;
    }
    let Ok(origin) = origin.to_str() else {
        return false;
    };
    let Some(authority) = origin.strip_prefix("http://") else {
        return false;
    };
    is_loopback_authority(authority)
}

fn host_is_allowed(host: &HeaderValue) -> bool {
    host.to_str().ok().is_some_and(is_loopback_authority)
}

async fn validate_request_origin(request: Request, next: Next) -> Response {
    let mut hosts = request.headers().get_all(header::HOST).iter();
    let host_allowed = hosts.next().is_some_and(host_is_allowed);
    if !host_allowed || hosts.next().is_some() {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "host_not_allowed" })),
        )
            .into_response();
    }

    let mut origins = request.headers().get_all(header::ORIGIN).iter();
    if let Some(origin) = origins.next() {
        if origins.next().is_some() || !origin_is_allowed(origin) {
            return (
                StatusCode::FORBIDDEN,
                Json(json!({ "error": "origin_not_allowed" })),
            )
                .into_response();
        }
    }

    next.run(request).await
}

fn tokens_equal(provided: &str, expected: &str) -> bool {
    let mut difference = provided.len() ^ expected.len();
    for index in 0..provided.len().max(expected.len()) {
        difference |= usize::from(
            provided.as_bytes().get(index).copied().unwrap_or_default()
                ^ expected.as_bytes().get(index).copied().unwrap_or_default(),
        );
    }
    difference == 0
}

fn request_token(request: &Request) -> Option<&str> {
    request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .or_else(|| {
            request
                .headers()
                .get(header::SEC_WEBSOCKET_PROTOCOL)
                .and_then(|value| value.to_str().ok())
                .and_then(|value| {
                    value
                        .split(',')
                        .map(str::trim)
                        .find_map(|protocol| protocol.strip_prefix("alethe-auth."))
                })
        })
}

async fn authenticate_request(mut request: Request, next: Next) -> Response {
    let path = request.uri().path();
    if request.method() == Method::OPTIONS
        || matches!(path, "/api/health" | "/api/runtime" | "/api/session")
    {
        return next.run(request).await;
    }

    let Some(runtime) = request.extensions().get::<Arc<ServerRuntime>>() else {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    };
    let Some(token) = request_token(&request).map(str::to_owned) else {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "authentication_required" })),
        )
            .into_response();
    };
    if !runtime.session_is_valid(&token) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "authentication_required" })),
        )
            .into_response();
    }
    request
        .extensions_mut()
        .insert(AuthenticatedLocalSession { token });
    next.run(request).await
}

fn cors_layer() -> CorsLayer {
    let allowed_origins = ALLOWED_WEB_ORIGINS.map(HeaderValue::from_static);

    CorsLayer::new()
        .allow_origin(allowed_origins)
        .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
        .allow_headers([header::ACCEPT, header::AUTHORIZATION, header::CONTENT_TYPE])
}

use tower_http::catch_panic::CatchPanicLayer;

pub fn build_router(runtime: ServerRuntime) -> Router {
    Router::new()
        .route("/api/health", get(health))
        .route("/api/runtime", get(runtime_info))
        .route("/api/session", get(create_session))
        .merge(profile_routes::router())
        .merge(event_routes::router())
        .merge(git_routes::router())
        .merge(session_routes::router())
        .merge(skills_routes::router())
        .merge(plugins_routes::router())
        .merge(self_test_routes::router())
        .merge(agent_routes::router())
        .merge(ai_memory_routes::router())
        .merge(misc_routes::router())
        .merge(fs_cli_routes::router())
        .merge(backup_routes::router())
        .merge(github_sync_routes::router())
        .merge(window_routes::router())
        .merge(pty_routes::router())
        .merge(sync_security_routes::router())
        .merge(sync_subscription_routes::router())
        .merge(sync_staging_routes::router())
        .merge(sync_engine_routes::router())
        .merge(sync_tasks_routes::router())
        .merge(sync_chat_routes::router())
        .merge(sync_activation_routes::router())
        .merge(sync_access_routes::router())
        .merge(sync_rendezvous_routes::router())
        .merge(sync_invitation_bridge_routes::router())
        .fallback(not_implemented)
        .layer(middleware::from_fn(authenticate_request))
        .layer(middleware::from_fn(validate_request_origin))
        .layer(cors_layer())
        .layer(CatchPanicLayer::custom(handle_panic))
        .layer(Extension(Arc::new(runtime)))
}

fn handle_panic(err: Box<dyn std::any::Any + Send + 'static>) -> Response {
    let details = if let Some(s) = err.downcast_ref::<String>() {
        s.clone()
    } else if let Some(s) = err.downcast_ref::<&str>() {
        s.to_string()
    } else {
        "Unknown panic".to_string()
    };
    eprintln!("[Alethe Web Server] Recovered from panic: {details}");
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({
            "error": "internal_server_error",
            "message": "The server encountered an unhandled internal error and recovered gracefully.",
            "details": details
        })),
    )
        .into_response()
}

async fn standalone_shutdown_signal() {
    #[cfg(unix)]
    {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                .expect("Failed to install the SIGTERM handler");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = terminate.recv() => {}
        }
    }

    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

pub fn run_standalone() -> Result<(), String> {
    crate::pty::install_kill_on_close_guard();
    let rt = tokio::runtime::Runtime::new()
        .map_err(|error| format!("Failed to create Tokio runtime: {error}"))?;
    rt.block_on(async {
        let (listener, port) = bind_server_listener().await.map_err(|error| {
            format!("Failed to bind the standalone API; it did not start: {error}")
        })?;

        let runtime = ServerRuntime::standalone()
            .map_err(|error| format!("Failed to resolve the data root: {error}"))?;
        // The Web runtime writes into the same decision stream as the desktop one. Until the log
        // directory stopped requiring an `AppHandle`, this binary could not write a diagnostic line
        // at all, so a Web-mode failure left literally nothing behind.
        match crate::logging::set_logs_dir_at(runtime.data_root()) {
            Ok(dir) => {
                if let Err(error) = crate::obs_sink::install(&dir) {
                    eprintln!("[obs] decision records are NOT being written: {error}");
                }
            }
            Err(error) => eprintln!("[obs] no log directory, diagnostics disabled: {error}"),
        }
        println!(
            "[Alethe Web Server] Listening on http://{SERVER_HOST}:{port} (instance {}).",
            runtime.instance_id()
        );
        let app = build_router(runtime);
        let result = axum::serve(listener, app)
            .with_graceful_shutdown(standalone_shutdown_signal())
            .await
            .map_err(|error| format!("Server stopped with an error: {error}"));
        crate::pty::kill_all_sessions(crate::pty::global_pty_sessions());
        result
    })
}

#[cfg(test)]
mod security_tests {
    use super::*;

    #[test]
    fn origin_allowlist_covers_vite_and_tauri_without_accepting_other_sites() {
        assert!(origin_is_allowed(&HeaderValue::from_static(
            "http://localhost:1422"
        )));
        assert!(origin_is_allowed(&HeaderValue::from_static(
            "tauri://localhost"
        )));
        assert!(!origin_is_allowed(&HeaderValue::from_static(
            "https://attacker.example"
        )));
    }

    #[test]
    fn host_allowlist_blocks_dns_rebinding_hosts() {
        assert!(host_is_allowed(&HeaderValue::from_static("127.0.0.1:1423")));
        assert!(host_is_allowed(&HeaderValue::from_static("localhost:1423")));
        assert!(!host_is_allowed(&HeaderValue::from_static(
            "attacker.example:1423"
        )));
    }

    #[test]
    fn session_tokens_use_constant_time_comparison_semantics() {
        assert!(tokens_equal("same-token", "same-token"));
        assert!(!tokens_equal("same-token", "other-token"));
        assert!(!tokens_equal("short", "shorter"));
    }

    #[test]
    fn local_session_rotates_with_a_bounded_previous_token_grace_period() {
        let mut session = LocalSessionState::new(1_000);
        let previous_token = session.token.clone();
        let rotate_at = session.refresh_after_ms;

        session.rotate_if_due(rotate_at);

        assert_ne!(session.token, previous_token);
        assert_eq!(session.generation, 2);
        assert!(session.is_valid(&previous_token, rotate_at));
        assert!(!session.is_valid(&previous_token, rotate_at + LOCAL_SESSION_GRACE_MS));
        assert!(session.is_valid(&session.token, rotate_at));
    }

    #[test]
    fn concurrent_publishes_never_broadcast_out_of_sequence_order() {
        let root = std::env::temp_dir().join(format!(
            "alethe-sync-event-test-{}-{}",
            std::process::id(),
            nanoid::nanoid!(8)
        ));
        std::fs::create_dir_all(&root).expect("create isolated sync-event test root");
        crate::profiles::ensure_profiles_index_at(&root).expect("seed profiles index");

        let runtime = Arc::new(ServerRuntime::new(
            "test",
            "com.kc1t.alethe.test".to_string(),
            root.clone(),
            Arc::new(crate::pty_sink::WebSocketSink),
            Arc::new(crate::sync_rendezvous::RendezvousRuntime::default()),
        ));
        let mut receiver = runtime.subscribe_sync_events();

        std::thread::scope(|scope| {
            for index in 0..8 {
                let runtime = Arc::clone(&runtime);
                scope.spawn(move || {
                    runtime
                        .publish_sync_event(format!("concurrent-{index}"), None, None)
                        .expect("publish under concurrency");
                });
            }
        });

        let mut sequences = Vec::new();
        while let Ok(event) = receiver.try_recv() {
            sequences.push(event.sequence);
        }
        assert_eq!(sequences.len(), 8);
        let mut sorted = sequences.clone();
        sorted.sort_unstable();
        assert_eq!(
            sequences, sorted,
            "broadcast order must match sequence order under concurrency"
        );

        let _ = std::fs::remove_dir_all(&root);
    }
}
