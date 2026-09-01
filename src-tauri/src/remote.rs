//! LAN-only remote control for existing Alethe terminal sessions.
//!
//! The listener is off until the user turns it on. Pairing happens inside a
//! short-lived window: the QR carries a pairing token that is exchanged once
//! for a device-bound session token, and every later HTTP request and
//! WebSocket frame is authorized against that session. The remote surface is
//! read-mostly: it exposes workspace metadata and terminal output, and accepts
//! one complete prompt at a time. It never creates, deletes, or edits
//! workspace entities.

use qrcode::{render::svg, QrCode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{IpAddr, TcpListener, TcpStream, UdpSocket};
use std::sync::atomic::{AtomicBool, AtomicU16, AtomicU64, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};
use tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tungstenite::{accept_hdr, Message};

use crate::paths::projects_file_path;
use crate::pty::PtySessions;

const HTTP_START: u16 = 9340;
const HTTP_END: u16 = 9360;
const MAX_BODY: usize = 64 * 1024;
const MAX_STATIC_ASSET: usize = 4 * 1024 * 1024;
const MAX_REQUEST: usize = 96 * 1024;
const MAX_MESSAGE: usize = 4 * 1024;
const MAX_SCROLLBACK: usize = 512 * 1024;
const MAX_REMOTE_DEVICES: usize = 4;
const MAX_CONNECTIONS: usize = 24;
const DEFAULT_SESSION_EXPIRY_SECS: u64 = 60 * 60;
const MIN_SESSION_EXPIRY_SECS: u64 = 5 * 60;
const MAX_SESSION_EXPIRY_SECS: u64 = 24 * 60 * 60;
const PAIRING_WINDOW_SECS: u64 = 120;
const SOCKET_TIMEOUT: Duration = Duration::from_secs(20);
const WS_AUTH_TIMEOUT: Duration = Duration::from_secs(10);
const AUTH_FAILURE_LIMIT: u32 = 10;
const AUTH_FAILURE_WINDOW: Duration = Duration::from_secs(60);
const AUTH_LOCKOUT: Duration = Duration::from_secs(300);

static HUB: OnceLock<Arc<RemoteHub>> = OnceLock::new();

#[derive(Clone, Serialize)]
pub struct RemoteDeviceInfo {
    pub id: usize,
    pub name: String,
    pub address: String,
    pub connected_at: u64,
    pub expires_at: u64,
    pub online: bool,
}

#[derive(Clone, Serialize)]
pub struct RemoteInfo {
    pub enabled: bool,
    pub connected_devices: usize,
    pub online_devices: usize,
    pub max_devices: usize,
    pub session_expiry_secs: u64,
    pub read_only: bool,
    pub allow_shell_input: bool,
    pub pairing_open: bool,
    pub pairing_expires_in: u64,
    pub devices: Vec<RemoteDeviceInfo>,
    pub pairing_url: Option<String>,
    pub qr_svg: Option<String>,
    pub http_url: Option<String>,
    pub ws_url: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteAppearance {
    ui_theme: String,
    app_icon_theme: String,
    language: String,
    motion_preference: String,
    color_scheme: String,
}

struct RemoteSession {
    id: usize,
    token: String,
    name: String,
    address: String,
    connected_at: SystemTime,
    expires_at: Instant,
    expires_at_unix: u64,
    subscription: Option<String>,
    sender: Option<mpsc::Sender<String>>,
}

struct AuthFailures {
    count: u32,
    window_start: Instant,
    locked_until: Option<Instant>,
}

pub struct RemoteHub {
    pairing_token: Mutex<String>,
    pairing_until: Mutex<Option<Instant>>,
    host: Mutex<String>,
    running: AtomicBool,
    generation: AtomicU64,
    http_port: AtomicU16,
    ws_port: AtomicU16,
    next_session_id: AtomicUsize,
    max_devices: AtomicUsize,
    session_expiry_secs: AtomicU64,
    read_only: AtomicBool,
    allow_shell_input: AtomicBool,
    connections: AtomicUsize,
    sessions: Mutex<Vec<RemoteSession>>,
    failures: Mutex<HashMap<IpAddr, AuthFailures>>,
    qr_cache: Mutex<Option<(String, String)>>,
}

impl RemoteHub {
    fn new() -> Self {
        Self {
            pairing_token: Mutex::new(nanoid::nanoid!(32)),
            pairing_until: Mutex::new(None),
            host: Mutex::new(local_ip()),
            running: AtomicBool::new(false),
            generation: AtomicU64::new(0),
            http_port: AtomicU16::new(0),
            ws_port: AtomicU16::new(0),
            next_session_id: AtomicUsize::new(1),
            max_devices: AtomicUsize::new(1),
            session_expiry_secs: AtomicU64::new(DEFAULT_SESSION_EXPIRY_SECS),
            read_only: AtomicBool::new(false),
            allow_shell_input: AtomicBool::new(false),
            connections: AtomicUsize::new(0),
            sessions: Mutex::new(Vec::new()),
            failures: Mutex::new(HashMap::new()),
            qr_cache: Mutex::new(None),
        }
    }

    fn enabled(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    fn is_active(&self, generation: u64) -> bool {
        self.running.load(Ordering::SeqCst) && self.generation.load(Ordering::SeqCst) == generation
    }

    fn host(&self) -> String {
        self.host
            .lock()
            .map(|host| host.clone())
            .unwrap_or_else(|_| "127.0.0.1".into())
    }

    fn refresh_host(&self) {
        if let Ok(mut host) = self.host.lock() {
            *host = local_ip();
        }
        if let Ok(mut cache) = self.qr_cache.lock() {
            *cache = None;
        }
    }

    fn open_pairing_window(&self) {
        if let Ok(mut token) = self.pairing_token.lock() {
            *token = nanoid::nanoid!(32);
        }
        if let Ok(mut until) = self.pairing_until.lock() {
            *until = Some(Instant::now() + Duration::from_secs(PAIRING_WINDOW_SECS));
        }
        if let Ok(mut cache) = self.qr_cache.lock() {
            *cache = None;
        }
    }

    fn close_pairing_window(&self) {
        if let Ok(mut token) = self.pairing_token.lock() {
            *token = nanoid::nanoid!(32);
        }
        if let Ok(mut until) = self.pairing_until.lock() {
            *until = None;
        }
        if let Ok(mut cache) = self.qr_cache.lock() {
            *cache = None;
        }
    }

    fn pairing_remaining(&self) -> u64 {
        if !self.enabled() {
            return 0;
        }
        self.pairing_until
            .lock()
            .ok()
            .and_then(|until| *until)
            .map(|until| until.saturating_duration_since(Instant::now()).as_secs())
            .unwrap_or(0)
    }

    fn pairing_url(&self) -> Option<String> {
        if self.pairing_remaining() == 0 {
            return None;
        }
        let port = self.http_port.load(Ordering::SeqCst);
        let token = self.pairing_token.lock().ok()?.clone();
        (port != 0).then(|| format!("http://{}:{}/?pair={}", self.host(), port, token))
    }

    fn info(&self) -> RemoteInfo {
        self.prune_expired();
        let http_port = self.http_port.load(Ordering::SeqCst);
        let ws_port = self.ws_port.load(Ordering::SeqCst);
        let host = self.host();
        let pairing_url = self.pairing_url();
        let qr_svg = pairing_url.as_ref().and_then(|url| self.qr_svg(url));
        let devices: Vec<RemoteDeviceInfo> = self
            .sessions
            .lock()
            .map(|sessions| {
                sessions
                    .iter()
                    .map(|session| RemoteDeviceInfo {
                        id: session.id,
                        name: session.name.clone(),
                        address: session.address.clone(),
                        connected_at: session
                            .connected_at
                            .duration_since(UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_secs(),
                        expires_at: session.expires_at_unix,
                        online: session.sender.is_some(),
                    })
                    .collect()
            })
            .unwrap_or_default();
        RemoteInfo {
            enabled: self.enabled(),
            connected_devices: devices.len(),
            online_devices: devices.iter().filter(|device| device.online).count(),
            max_devices: self.max_devices.load(Ordering::Relaxed),
            session_expiry_secs: self.session_expiry_secs.load(Ordering::Relaxed),
            read_only: self.read_only.load(Ordering::Relaxed),
            allow_shell_input: self.allow_shell_input.load(Ordering::Relaxed),
            pairing_open: pairing_url.is_some(),
            pairing_expires_in: self.pairing_remaining(),
            devices,
            pairing_url,
            qr_svg,
            http_url: (http_port != 0).then(|| format!("http://{host}:{http_port}")),
            ws_url: (ws_port != 0).then(|| format!("ws://{host}:{ws_port}")),
        }
    }

    fn qr_svg(&self, url: &str) -> Option<String> {
        let mut cache = self.qr_cache.lock().ok()?;
        if let Some((cached_url, svg)) = cache.as_ref() {
            if cached_url == url {
                return Some(svg.clone());
            }
        }
        let svg = QrCode::new(url.as_bytes())
            .ok()?
            .render::<svg::Color>()
            .min_dimensions(220, 220)
            .build();
        *cache = Some((url.to_string(), svg.clone()));
        Some(svg)
    }

    fn connected_device_count(&self) -> usize {
        if !self.enabled() {
            return 0;
        }
        self.prune_expired();
        self.sessions
            .lock()
            .map(|sessions| sessions.len())
            .unwrap_or(0)
    }

    fn prune_expired(&self) {
        let now = Instant::now();
        if let Ok(mut sessions) = self.sessions.lock() {
            sessions.retain(|session| session.expires_at > now);
        }
    }

    fn pair(
        &self,
        provided: &str,
        name: String,
        address: String,
    ) -> Result<(usize, String), &'static str> {
        if self.pairing_remaining() == 0 {
            return Err("Pairing window is closed");
        }
        let expected = self
            .pairing_token
            .lock()
            .map_err(|_| "Pairing unavailable")?
            .clone();
        if !tokens_equal(provided, &expected) {
            return Err("Invalid pairing token");
        }
        self.prune_expired();
        let mut sessions = self.sessions.lock().map_err(|_| "Pairing unavailable")?;
        if sessions.len() >= self.max_devices.load(Ordering::Relaxed) {
            return Err("Maximum remote devices reached");
        }
        let lifetime = self.session_expiry_secs.load(Ordering::Relaxed);
        let id = self.next_session_id.fetch_add(1, Ordering::Relaxed);
        let token = nanoid::nanoid!(40);
        let now = SystemTime::now();
        sessions.push(RemoteSession {
            id,
            token: token.clone(),
            name,
            address,
            connected_at: now,
            expires_at: Instant::now() + Duration::from_secs(lifetime),
            expires_at_unix: now.duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()
                + lifetime,
            subscription: None,
            sender: None,
        });
        drop(sessions);
        self.close_pairing_window();
        Ok((id, token))
    }

    fn session_id_for(&self, token: &str) -> Option<usize> {
        if token.is_empty() {
            return None;
        }
        self.prune_expired();
        let sessions = self.sessions.lock().ok()?;
        sessions
            .iter()
            .find(|session| tokens_equal(token, &session.token))
            .map(|session| session.id)
    }

    fn attach_sender(&self, id: usize, sender: mpsc::Sender<String>) {
        if let Ok(mut sessions) = self.sessions.lock() {
            if let Some(session) = sessions.iter_mut().find(|session| session.id == id) {
                session.sender = Some(sender);
            }
        }
    }

    fn detach_sender(&self, id: usize) {
        if let Ok(mut sessions) = self.sessions.lock() {
            if let Some(session) = sessions.iter_mut().find(|session| session.id == id) {
                session.sender = None;
                session.subscription = None;
            }
        }
    }

    fn set_subscription(&self, id: usize, pty_id: Option<String>) {
        if let Ok(mut sessions) = self.sessions.lock() {
            if let Some(session) = sessions.iter_mut().find(|session| session.id == id) {
                session.subscription = pty_id;
            }
        }
    }

    fn session_alive(&self, id: usize) -> bool {
        self.sessions
            .lock()
            .map(|sessions| {
                sessions
                    .iter()
                    .any(|session| session.id == id && session.expires_at > Instant::now())
            })
            .unwrap_or(false)
    }

    fn device_name(&self, id: usize) -> String {
        self.sessions
            .lock()
            .ok()
            .and_then(|sessions| {
                sessions
                    .iter()
                    .find(|session| session.id == id)
                    .map(|session| session.name.clone())
            })
            .unwrap_or_else(|| "Remote device".into())
    }

    fn rename_device(&self, id: usize, name: String) {
        if let Ok(mut sessions) = self.sessions.lock() {
            if let Some(session) = sessions.iter_mut().find(|session| session.id == id) {
                session.name = name;
            }
        }
    }

    pub(crate) fn publish<F>(&self, pty_id: &str, payload: F)
    where
        F: FnOnce() -> Value,
    {
        let mut sessions = match self.sessions.lock() {
            Ok(sessions) => sessions,
            Err(_) => return,
        };
        let now = Instant::now();
        let has_subscriber = sessions.iter().any(|session| {
            session.expires_at > now
                && session.sender.is_some()
                && session.subscription.as_deref() == Some(pty_id)
        });
        if !has_subscriber {
            return;
        }
        let message = payload().to_string();
        for session in sessions.iter_mut() {
            if session.expires_at <= now || session.subscription.as_deref() != Some(pty_id) {
                continue;
            }
            let delivered = session
                .sender
                .as_ref()
                .map(|sender| sender.send(message.clone()).is_ok())
                .unwrap_or(true);
            if !delivered {
                session.sender = None;
            }
        }
    }

    fn revoke_all(&self) {
        if let Ok(mut sessions) = self.sessions.lock() {
            sessions.clear();
        }
    }

    fn revoke_device(&self, id: usize) {
        if let Ok(mut sessions) = self.sessions.lock() {
            sessions.retain(|session| session.id != id);
        }
    }

    fn auth_blocked(&self, address: &str) -> bool {
        let Some(ip) = peer_ip(address) else {
            return false;
        };
        self.failures
            .lock()
            .map(|failures| {
                failures
                    .get(&ip)
                    .and_then(|entry| entry.locked_until)
                    .map(|until| until > Instant::now())
                    .unwrap_or(false)
            })
            .unwrap_or(false)
    }

    fn record_auth_failure(&self, address: &str) {
        let Some(ip) = peer_ip(address) else {
            return;
        };
        let Ok(mut failures) = self.failures.lock() else {
            return;
        };
        let now = Instant::now();
        let entry = failures.entry(ip).or_insert(AuthFailures {
            count: 0,
            window_start: now,
            locked_until: None,
        });
        if now.duration_since(entry.window_start) > AUTH_FAILURE_WINDOW {
            entry.count = 0;
            entry.window_start = now;
            entry.locked_until = None;
        }
        entry.count += 1;
        if entry.count >= AUTH_FAILURE_LIMIT {
            entry.locked_until = Some(now + AUTH_LOCKOUT);
            eprintln!("[remote] too many failed pairing attempts from {ip}, blocked for 5 minutes");
        }
    }

    fn clear_auth_failures(&self, address: &str) {
        if let Some(ip) = peer_ip(address) {
            if let Ok(mut failures) = self.failures.lock() {
                failures.remove(&ip);
            }
        }
    }
}

pub fn hub() -> Arc<RemoteHub> {
    HUB.get_or_init(|| Arc::new(RemoteHub::new())).clone()
}

pub fn start(app: AppHandle, sessions: PtySessions) {
    let hub = hub();
    if hub.running.swap(true, Ordering::SeqCst) {
        return;
    }
    hub.refresh_host();
    let generation = hub.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let http_hub = Arc::clone(&hub);
    let http_sessions = Arc::clone(&sessions);
    let http_app = app.clone();
    thread::spawn(move || run_http(http_app, http_hub, http_sessions, generation));

    let ws_hub = Arc::clone(&hub);
    let ws_sessions = Arc::clone(&sessions);
    thread::spawn(move || run_websocket(ws_hub, ws_sessions, generation));
}

pub fn stop() {
    let hub = hub();
    hub.running.store(false, Ordering::SeqCst);
    hub.generation.fetch_add(1, Ordering::SeqCst);
    hub.http_port.store(0, Ordering::SeqCst);
    hub.ws_port.store(0, Ordering::SeqCst);
    hub.revoke_all();
    hub.close_pairing_window();
    eprintln!("[remote] LAN remote control disabled");
}

#[tauri::command]
pub fn remote_control_info() -> RemoteInfo {
    hub().info()
}

#[tauri::command]
pub fn remote_control_connected_devices() -> usize {
    hub().connected_device_count()
}

#[tauri::command]
pub fn remote_control_open_pairing() -> RemoteInfo {
    let remote = hub();
    if remote.enabled() {
        remote.refresh_host();
        remote.open_pairing_window();
    }
    remote.info()
}

#[tauri::command]
pub fn remote_control_close_pairing() -> RemoteInfo {
    let remote = hub();
    remote.close_pairing_window();
    remote.info()
}

#[tauri::command]
pub fn remote_control_revoke() -> RemoteInfo {
    let remote = hub();
    remote.revoke_all();
    remote.close_pairing_window();
    remote.info()
}

#[tauri::command]
pub fn remote_control_set_max_devices(max_devices: usize) -> RemoteInfo {
    let remote = hub();
    remote
        .max_devices
        .store(max_devices.clamp(1, MAX_REMOTE_DEVICES), Ordering::Relaxed);
    remote.info()
}

#[tauri::command]
pub fn remote_control_set_session_expiry(session_expiry_secs: u64) -> RemoteInfo {
    let remote = hub();
    remote.session_expiry_secs.store(
        session_expiry_secs.clamp(MIN_SESSION_EXPIRY_SECS, MAX_SESSION_EXPIRY_SECS),
        Ordering::Relaxed,
    );
    remote.info()
}

#[tauri::command]
pub fn remote_control_set_read_only(read_only: bool) -> RemoteInfo {
    let remote = hub();
    remote.read_only.store(read_only, Ordering::Relaxed);
    remote.info()
}

#[tauri::command]
pub fn remote_control_set_shell_input(allowed: bool) -> RemoteInfo {
    let remote = hub();
    remote.allow_shell_input.store(allowed, Ordering::Relaxed);
    remote.info()
}

#[tauri::command]
pub fn remote_control_revoke_device(device_id: usize) -> RemoteInfo {
    let remote = hub();
    remote.revoke_device(device_id);
    remote.info()
}

#[tauri::command]
pub fn remote_control_set_enabled(
    app: AppHandle,
    sessions: tauri::State<'_, PtySessions>,
    enabled: bool,
) -> RemoteInfo {
    let remote = hub();
    if enabled {
        start(app, Arc::clone(sessions.inner()));
    } else {
        stop();
    }
    remote.info()
}

struct ConnectionGuard(Arc<RemoteHub>);

impl ConnectionGuard {
    fn acquire(hub: &Arc<RemoteHub>) -> Option<Self> {
        let previous = hub.connections.fetch_add(1, Ordering::SeqCst);
        if previous >= MAX_CONNECTIONS {
            hub.connections.fetch_sub(1, Ordering::SeqCst);
            return None;
        }
        Some(Self(Arc::clone(hub)))
    }
}

impl Drop for ConnectionGuard {
    fn drop(&mut self) {
        self.0.connections.fetch_sub(1, Ordering::SeqCst);
    }
}

fn run_http(app: AppHandle, hub: Arc<RemoteHub>, sessions: PtySessions, generation: u64) {
    let host = hub.host();
    let Some(listener) = bind_listener(&host, HTTP_START, HTTP_END) else {
        eprintln!("[remote] unable to bind LAN HTTP listener");
        stop();
        return;
    };
    let port = listener.local_addr().map(|addr| addr.port()).unwrap_or(0);
    hub.http_port.store(port, Ordering::SeqCst);
    eprintln!("[remote] LAN client available at http://{host}:{port}");
    let _ = listener.set_nonblocking(true);
    while hub.is_active(generation) {
        let stream = match listener.accept() {
            Ok((stream, _)) => stream,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(50));
                continue;
            }
            Err(_) => break,
        };
        let Some(guard) = ConnectionGuard::acquire(&hub) else {
            continue;
        };
        let mut stream = stream;
        let _ = stream.set_nonblocking(false);
        let _ = stream.set_read_timeout(Some(SOCKET_TIMEOUT));
        let _ = stream.set_write_timeout(Some(SOCKET_TIMEOUT));
        let hub = Arc::clone(&hub);
        let sessions = Arc::clone(&sessions);
        let app = app.clone();
        thread::spawn(move || {
            let _guard = guard;
            if let Err(error) = handle_http(&mut stream, &app, &hub, &sessions) {
                eprintln!("[remote] HTTP request failed: {error}");
                let _ = respond(
                    &mut stream,
                    400,
                    "application/json",
                    r#"{"error":"Bad request"}"#,
                );
            }
        });
    }
    if hub.generation.load(Ordering::SeqCst) == generation {
        hub.http_port.store(0, Ordering::SeqCst);
    }
}

fn run_websocket(hub: Arc<RemoteHub>, sessions: PtySessions, generation: u64) {
    let host = hub.host();
    let Some(listener) = bind_listener(&host, HTTP_START + 1, HTTP_END + 1) else {
        eprintln!("[remote] unable to bind LAN WebSocket listener");
        stop();
        return;
    };
    let port = listener.local_addr().map(|addr| addr.port()).unwrap_or(0);
    hub.ws_port.store(port, Ordering::SeqCst);
    let _ = listener.set_nonblocking(true);
    while hub.is_active(generation) {
        let stream = match listener.accept() {
            Ok((stream, _)) => stream,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(50));
                continue;
            }
            Err(_) => break,
        };
        let Some(guard) = ConnectionGuard::acquire(&hub) else {
            continue;
        };
        let hub = Arc::clone(&hub);
        let sessions = Arc::clone(&sessions);
        let address = stream
            .peer_addr()
            .map(|address| address.to_string())
            .unwrap_or_else(|_| "Unknown device".into());
        thread::spawn(move || {
            let _guard = guard;
            handle_websocket(stream, hub, sessions, generation, address);
        });
    }
    if hub.generation.load(Ordering::SeqCst) == generation {
        hub.ws_port.store(0, Ordering::SeqCst);
    }
}

fn allowed_origin(hub: &RemoteHub) -> String {
    format!(
        "http://{}:{}",
        hub.host(),
        hub.http_port.load(Ordering::SeqCst)
    )
}

fn handle_websocket(
    stream: TcpStream,
    hub: Arc<RemoteHub>,
    sessions: PtySessions,
    generation: u64,
    address: String,
) {
    if hub.auth_blocked(&address) {
        return;
    }
    let _ = stream.set_read_timeout(Some(SOCKET_TIMEOUT));
    let _ = stream.set_write_timeout(Some(SOCKET_TIMEOUT));
    let expected_origin = allowed_origin(&hub);
    let handshake = accept_hdr(
        stream,
        |request: &Request, response: Response| match request
            .headers()
            .get("Origin")
            .and_then(|value| value.to_str().ok())
        {
            None => Ok(response),
            Some(origin) if origin == expected_origin => Ok(response),
            Some(_) => Err(ErrorResponse::new(Some("Origin not allowed".into()))),
        },
    );
    let mut socket = match handshake {
        Ok(socket) => socket,
        Err(_) => return,
    };
    let _ = socket.get_mut().set_nonblocking(true);
    let (tx, rx) = mpsc::channel::<String>();
    let opened_at = Instant::now();
    let mut session_id: Option<usize> = None;
    loop {
        if !hub.is_active(generation) {
            break;
        }
        if session_id.is_none() && opened_at.elapsed() > WS_AUTH_TIMEOUT {
            break;
        }
        loop {
            match rx.try_recv() {
                Ok(payload) => {
                    if socket.send(Message::Text(payload.into())).is_err() {
                        break;
                    }
                }
                Err(mpsc::TryRecvError::Empty) => break,
                Err(mpsc::TryRecvError::Disconnected) => break,
            }
        }
        if let Some(id) = session_id {
            if !hub.session_alive(id) {
                let _ = socket.send(Message::Text(
                    json!({ "type": "error", "reason": "expired", "message": "Remote session expired" })
                        .to_string()
                        .into(),
                ));
                break;
            }
        }
        match socket.read() {
            Ok(Message::Text(text)) => {
                if text.len() > MAX_MESSAGE {
                    break;
                }
                let Ok(command) = serde_json::from_str::<Value>(&text) else {
                    continue;
                };
                let provided = command
                    .get("sessionToken")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let Some(id) = hub.session_id_for(provided) else {
                    // A session that expires mid-connection is not a failed
                    // attempt: counting it would lock out the paired device.
                    if session_id.is_none() {
                        hub.record_auth_failure(&address);
                    }
                    let _ = socket.send(Message::Text(
                        json!({ "type": "error", "reason": "unauthorized", "message": "Remote session is not valid" })
                            .to_string()
                            .into(),
                    ));
                    break;
                };
                if session_id.is_none() {
                    hub.clear_auth_failures(&address);
                    if let Some(name) = command.get("deviceName").and_then(Value::as_str) {
                        hub.rename_device(id, name.chars().take(48).collect());
                    }
                    hub.attach_sender(id, tx.clone());
                    session_id = Some(id);
                    let _ = socket.send(Message::Text(
                        json!({ "type": "authenticated" }).to_string().into(),
                    ));
                }
                if command.get("type").and_then(Value::as_str) == Some("subscribe") {
                    let pty_id = command.get("ptyId").and_then(Value::as_str);
                    hub.set_subscription(id, pty_id.map(str::to_string));
                    if let Some(pty_id) = pty_id {
                        let scrollback = read_scrollback(&sessions, pty_id, MAX_SCROLLBACK);
                        let payload =
                            json!({ "type": "scrollback", "ptyId": pty_id, "text": scrollback });
                        let _ = socket.send(Message::Text(payload.to_string().into()));
                    }
                }
            }
            Err(tungstenite::Error::Io(error))
                if error.kind() == std::io::ErrorKind::WouldBlock => {}
            Err(tungstenite::Error::ConnectionClosed) => break,
            Err(_) => break,
            _ => {}
        }
        thread::sleep(Duration::from_millis(16));
    }
    if let Some(session_id) = session_id {
        hub.detach_sender(session_id);
    }
}

fn read_request(stream: &mut TcpStream) -> Result<(String, Vec<u8>), String> {
    let mut raw: Vec<u8> = Vec::with_capacity(8 * 1024);
    let mut chunk = [0_u8; 8 * 1024];
    let headers_end = loop {
        if let Some(index) = find_headers_end(&raw) {
            break index;
        }
        if raw.len() > MAX_REQUEST {
            return Err("Request headers too large".into());
        }
        let count = stream.read(&mut chunk).map_err(|error| error.to_string())?;
        if count == 0 {
            return Err("Connection closed before the request completed".into());
        }
        raw.extend_from_slice(&chunk[..count]);
    };
    let head = String::from_utf8_lossy(&raw[..headers_end]).into_owned();
    let content_length = header_value(&head, "content-length")
        .and_then(|value| value.trim().parse::<usize>().ok())
        .unwrap_or(0);
    if content_length > MAX_BODY {
        return Err("Request body too large".into());
    }
    let mut body = raw[headers_end + 4..].to_vec();
    while body.len() < content_length {
        let count = stream.read(&mut chunk).map_err(|error| error.to_string())?;
        if count == 0 {
            return Err("Connection closed before the body completed".into());
        }
        body.extend_from_slice(&chunk[..count]);
        if body.len() > MAX_BODY {
            return Err("Request body too large".into());
        }
    }
    body.truncate(content_length);
    Ok((head, body))
}

fn find_headers_end(raw: &[u8]) -> Option<usize> {
    raw.windows(4).position(|window| window == b"\r\n\r\n")
}

fn header_value(head: &str, name: &str) -> Option<String> {
    head.split("\r\n").skip(1).find_map(|line| {
        let (key, value) = line.split_once(':')?;
        key.trim()
            .eq_ignore_ascii_case(name)
            .then(|| value.trim().to_string())
    })
}

fn bearer_token(head: &str) -> String {
    header_value(head, "authorization")
        .and_then(|value| {
            value
                .strip_prefix("Bearer ")
                .or_else(|| value.strip_prefix("bearer "))
                .map(str::to_string)
        })
        .unwrap_or_default()
}

fn handle_http(
    stream: &mut TcpStream,
    app: &AppHandle,
    hub: &Arc<RemoteHub>,
    sessions: &PtySessions,
) -> Result<(), String> {
    let address = stream
        .peer_addr()
        .map(|address| address.to_string())
        .unwrap_or_else(|_| "Unknown device".into());
    if hub.auth_blocked(&address) {
        return respond(
            stream,
            429,
            "application/json",
            r#"{"error":"Too many failed attempts"}"#,
        );
    }
    let (head, body) = read_request(stream)?;
    let first = head.split("\r\n").next().unwrap_or("");
    let mut parts = first.split_whitespace();
    let method = parts.next().unwrap_or("");
    let target = parts.next().unwrap_or("/");
    let path = target.split('?').next().unwrap_or("/");

    if path == "/api/pair" && method == "POST" {
        let payload: PairRequest = serde_json::from_slice(&body).map_err(|e| e.to_string())?;
        let name: String = payload
            .device_name
            .unwrap_or_else(|| "Remote device".into())
            .chars()
            .take(48)
            .collect();
        return match hub.pair(&payload.token, name, address.clone()) {
            Ok((id, session_token)) => {
                hub.clear_auth_failures(&address);
                eprintln!("[remote] device {id} paired from {address}");
                let info = hub.info();
                respond(
                    stream,
                    200,
                    "application/json",
                    &json!({
                        "sessionToken": session_token,
                        "deviceId": id,
                        "wsUrl": info.ws_url,
                        "readOnly": info.read_only,
                        "allowShellInput": info.allow_shell_input,
                        "sessionExpirySecs": info.session_expiry_secs,
                    })
                    .to_string(),
                )
            }
            Err(message) => {
                hub.record_auth_failure(&address);
                respond(
                    stream,
                    401,
                    "application/json",
                    &json!({ "error": message }).to_string(),
                )
            }
        };
    }

    if path == "/appearance.json" && method == "GET" {
        return respond(
            stream,
            200,
            "application/json",
            &remote_appearance(app).to_string(),
        );
    }

    if path.starts_with("/api/") {
        let Some(session_id) = hub.session_id_for(&bearer_token(&head)) else {
            hub.record_auth_failure(&address);
            return respond(
                stream,
                401,
                "application/json",
                r#"{"error":"Remote session is not valid"}"#,
            );
        };
        hub.clear_auth_failures(&address);
        return handle_api(
            stream, app, hub, sessions, session_id, method, target, &body,
        );
    }

    match path {
        "/" | "/index.html" => respond(
            stream,
            200,
            "text/html; charset=utf-8",
            include_str!("../remote/index.html"),
        ),
        "/app.js" => respond(
            stream,
            200,
            "text/javascript; charset=utf-8",
            include_str!("../remote/app.js"),
        ),
        "/app.css" => respond(
            stream,
            200,
            "text/css; charset=utf-8",
            include_str!("../remote/app.css"),
        ),
        "/theme.css" => respond(
            stream,
            200,
            "text/css; charset=utf-8",
            include_str!("../../src/styles/theme.css"),
        ),
        "/brand-icon.png" => respond_asset_bytes(
            stream,
            200,
            "image/png",
            selected_brand_icon(&projects_document(app)),
        ),
        "/assets/fonts/CaskaydiaCoveNerdFontMono-Regular.ttf" => respond_asset_bytes(
            stream,
            200,
            "font/ttf",
            include_bytes!("../../src/assets/fonts/CaskaydiaCoveNerdFontMono-Regular.ttf"),
        ),
        "/assets/fonts/CaskaydiaCoveNerdFontMono-Bold.ttf" => respond_asset_bytes(
            stream,
            200,
            "font/ttf",
            include_bytes!("../../src/assets/fonts/CaskaydiaCoveNerdFontMono-Bold.ttf"),
        ),
        "/assets/fonts/CaskaydiaCoveNerdFontMono-Italic.ttf" => respond_asset_bytes(
            stream,
            200,
            "font/ttf",
            include_bytes!("../../src/assets/fonts/CaskaydiaCoveNerdFontMono-Italic.ttf"),
        ),
        "/assets/fonts/CaskaydiaCoveNerdFontMono-BoldItalic.ttf" => respond_asset_bytes(
            stream,
            200,
            "font/ttf",
            include_bytes!("../../src/assets/fonts/CaskaydiaCoveNerdFontMono-BoldItalic.ttf"),
        ),
        "/manifest.webmanifest" => respond(
            stream,
            200,
            "application/manifest+json",
            include_str!("../remote/manifest.webmanifest"),
        ),
        _ => respond(stream, 404, "text/plain", "Not found"),
    }
}

fn handle_api(
    stream: &mut TcpStream,
    app: &AppHandle,
    hub: &Arc<RemoteHub>,
    sessions: &PtySessions,
    session_id: usize,
    method: &str,
    target: &str,
    body: &[u8],
) -> Result<(), String> {
    let path = target.split('?').next().unwrap_or("/");
    if path == "/api/info" {
        let info = hub.info();
        return respond(
            stream,
            200,
            "application/json",
            &json!({
                "wsUrl": info.ws_url,
                "readOnly": info.read_only,
                "allowShellInput": info.allow_shell_input,
                "sessionExpirySecs": info.session_expiry_secs,
            })
            .to_string(),
        );
    }
    if path == "/api/state" {
        return respond(
            stream,
            200,
            "application/json",
            &workspace_snapshot(app)?.to_string(),
        );
    }
    if path == "/api/scrollback" {
        let id = query_value(target, "id").ok_or_else(|| "Missing PTY id".to_string())?;
        if !pty_is_shared(app, &id) {
            return respond(
                stream,
                403,
                "application/json",
                r#"{"error":"This terminal is not available remotely"}"#,
            );
        }
        hub.set_subscription(session_id, Some(id.clone()));
        let text = read_scrollback(sessions, &id, MAX_SCROLLBACK);
        return respond(
            stream,
            200,
            "application/json",
            &json!({ "text": text }).to_string(),
        );
    }
    if path == "/api/message" && method == "POST" {
        if hub.read_only.load(Ordering::Relaxed) {
            return respond(
                stream,
                403,
                "application/json",
                r#"{"error":"Remote control is in read-only mode"}"#,
            );
        }
        let payload: RemoteMessage = serde_json::from_slice(body).map_err(|e| e.to_string())?;
        let text = sanitize_remote_message(&payload.text);
        let text = text.trim();
        if text.is_empty() || text.len() > MAX_MESSAGE {
            return respond(
                stream,
                400,
                "application/json",
                r#"{"error":"Message is empty or too large"}"#,
            );
        }
        let agent = pty_agent(app, &payload.pty_id);
        let Some(agent) = agent else {
            return respond(
                stream,
                403,
                "application/json",
                r#"{"error":"This terminal is not available remotely"}"#,
            );
        };
        if agent == "shell" && !hub.allow_shell_input.load(Ordering::Relaxed) {
            return respond(
                stream,
                403,
                "application/json",
                r#"{"error":"Sending commands to shell terminals is disabled"}"#,
            );
        }
        write_remote(sessions, &payload.pty_id, &format!("{text}\r"))?;
        let device_name = hub.device_name(session_id);
        eprintln!(
            "[remote] {device_name} (device {session_id}) sent {} chars to {}",
            text.len(),
            payload.pty_id
        );
        let _ = app.emit(
            "remote://message",
            json!({
                "ptyId": payload.pty_id,
                "deviceId": session_id,
                "deviceName": device_name,
                "preview": text.chars().take(120).collect::<String>(),
            }),
        );
        return respond(stream, 204, "text/plain", "");
    }
    respond(stream, 404, "application/json", r#"{"error":"Not found"}"#)
}

#[derive(Deserialize)]
struct PairRequest {
    token: String,
    #[serde(rename = "deviceName")]
    device_name: Option<String>,
}

#[derive(Deserialize)]
struct RemoteMessage {
    #[serde(rename = "ptyId")]
    pty_id: String,
    text: String,
}

fn projects_document(app: &AppHandle) -> Value {
    let Ok(path) = projects_file_path(app) else {
        return json!({});
    };
    std::fs::read_to_string(path)
        .ok()
        .and_then(|content| serde_json::from_str::<Value>(&content).ok())
        .unwrap_or_else(|| json!({}))
}

fn remote_appearance(app: &AppHandle) -> Value {
    json!(appearance_from_document(&projects_document(app)))
}

fn appearance_from_document(document: &Value) -> RemoteAppearance {
    let preferences = document.get("preferences").unwrap_or(&Value::Null);
    let ui_theme = preferences
        .get("uiTheme")
        .and_then(Value::as_str)
        .filter(|theme| is_known_theme(theme))
        .unwrap_or("elite-indigo")
        .to_string();
    let app_icon_theme = preferences
        .get("appIconTheme")
        .and_then(Value::as_str)
        .filter(|theme| is_known_app_icon(theme))
        .unwrap_or("elite-indigo")
        .to_string();
    let language = match preferences.get("language").and_then(Value::as_str) {
        Some("pt-BR") => "pt-BR",
        _ => "en",
    }
    .to_string();
    let motion_preference = match preferences.get("motionPreference").and_then(Value::as_str) {
        Some("reduced") => "reduced",
        _ => "animated",
    }
    .to_string();
    let color_scheme = if is_light_theme(&ui_theme) {
        "light"
    } else {
        "dark"
    }
    .to_string();

    RemoteAppearance {
        ui_theme,
        app_icon_theme,
        language,
        motion_preference,
        color_scheme,
    }
}

fn is_known_theme(theme: &str) -> bool {
    matches!(
        theme,
        "elite-original"
            | "elite-pure-black"
            | "elite-indigo"
            | "elite-blush"
            | "dark"
            | "light"
            | "dracula"
            | "nord"
            | "gruvbox"
            | "solarized"
            | "tokyo-night"
            | "vscode"
            | "min-dark"
            | "min-light"
            | "dark-lemon"
            | "orca"
            | "ember"
            | "golden-premium"
    )
}

fn is_light_theme(theme: &str) -> bool {
    matches!(
        theme,
        "elite-original" | "elite-blush" | "light" | "min-light"
    )
}

fn is_known_app_icon(theme: &str) -> bool {
    matches!(
        theme,
        "elite-original" | "elite-pure-black" | "elite-indigo" | "elite-blush"
    )
}

fn selected_brand_icon(document: &Value) -> &'static [u8] {
    match appearance_from_document(document).app_icon_theme.as_str() {
        "elite-original" => include_bytes!("../../src/assets/theme-icons/elite-original.png"),
        "elite-pure-black" => {
            include_bytes!("../../src/assets/theme-icons/elite-pure-black.png")
        }
        "elite-blush" => include_bytes!("../../src/assets/theme-icons/elite-blush.png"),
        _ => include_bytes!("../../src/assets/theme-icons/elite-indigo.png"),
    }
}

fn tab_is_shared(terminal: &Value) -> bool {
    terminal.get("remoteExcluded").and_then(Value::as_bool) != Some(true)
}

fn shared_tabs(app: &AppHandle) -> Vec<(String, String)> {
    let document = projects_document(app);
    let mut tabs = Vec::new();
    for project in document
        .get("projects")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
    {
        for terminal in project
            .get("terminals")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
        {
            if !tab_is_shared(&terminal) {
                continue;
            }
            for tab in terminal
                .get("tabs")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
            {
                let Some(pty_id) = tab.get("ptyId").and_then(Value::as_str) else {
                    continue;
                };
                let agent = tab
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or("shell")
                    .to_string();
                tabs.push((pty_id.to_string(), agent));
            }
        }
    }
    tabs
}

fn pty_agent(app: &AppHandle, pty_id: &str) -> Option<String> {
    shared_tabs(app)
        .into_iter()
        .find(|(id, _)| id == pty_id)
        .map(|(_, agent)| agent)
}

fn pty_is_shared(app: &AppHandle, pty_id: &str) -> bool {
    shared_tabs(app).iter().any(|(id, _)| id == pty_id)
}

fn workspace_snapshot(app: &AppHandle) -> Result<Value, String> {
    let document = projects_document(app);
    let groups: Vec<Value> = document
        .get("groups")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .iter()
        .map(|group| {
            json!({
                "id": group.get("id"),
                "name": group.get("name"),
                "color": group.get("color"),
            })
        })
        .collect();
    let mut projects = Vec::new();
    for project in document
        .get("projects")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
    {
        let mut chats = Vec::new();
        for terminal in project
            .get("terminals")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
        {
            if !tab_is_shared(&terminal) {
                continue;
            }
            let terminal_id = terminal.get("id").cloned().unwrap_or(Value::Null);
            let terminal_name = terminal
                .get("name")
                .cloned()
                .unwrap_or_else(|| Value::String("Terminal".into()));
            for tab in terminal
                .get("tabs")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
            {
                let Some(pty_id) = tab.get("ptyId").and_then(Value::as_str) else {
                    continue;
                };
                chats.push(json!({
                    "id": tab.get("id"),
                    "ptyId": pty_id,
                    "name": terminal_name,
                    "agent": tab.get("type"),
                    "terminalId": terminal_id,
                }));
            }
        }
        projects.push(json!({
            "id": project.get("id"),
            "name": project.get("name"),
            "groupId": project.get("groupId"),
            "chats": chats,
        }));
    }
    Ok(json!({ "groups": groups, "projects": projects }))
}

fn read_scrollback(sessions: &PtySessions, id: &str, max_bytes: usize) -> String {
    if let Ok(sessions) = sessions.lock() {
        if let Some(session) = sessions.get(id) {
            if let Ok(mut buffer) = session.scrollback.lock() {
                let data = buffer.data.make_contiguous();
                let start =
                    crate::pty::align_to_char_boundary(data, data.len().saturating_sub(max_bytes));
                return String::from_utf8_lossy(&data[start..]).into_owned();
            }
        }
    }
    String::new()
}

fn write_remote(sessions: &PtySessions, id: &str, data: &str) -> Result<(), String> {
    let writer = {
        let sessions = sessions
            .lock()
            .map_err(|_| "PTY sessions lock poisoned".to_string())?;
        let session = sessions
            .get(id)
            .ok_or_else(|| "PTY not found".to_string())?;
        Arc::clone(&session.writer)
    };
    let mut writer = writer
        .lock()
        .map_err(|_| "PTY writer lock poisoned".to_string())?;
    writer
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())?;
    writer.flush().map_err(|e| e.to_string())
}

fn respond(
    stream: &mut TcpStream,
    status: u16,
    content_type: &str,
    body: &str,
) -> Result<(), String> {
    respond_bytes(stream, status, content_type, body.as_bytes())
}

fn respond_bytes(
    stream: &mut TcpStream,
    status: u16,
    content_type: &str,
    body: &[u8],
) -> Result<(), String> {
    respond_bytes_with_limit(stream, status, content_type, body, MAX_BODY)
}

fn respond_asset_bytes(
    stream: &mut TcpStream,
    status: u16,
    content_type: &str,
    body: &[u8],
) -> Result<(), String> {
    respond_bytes_with_limit(stream, status, content_type, body, MAX_STATIC_ASSET)
}

fn respond_bytes_with_limit(
    stream: &mut TcpStream,
    status: u16,
    content_type: &str,
    body: &[u8],
    max_size: usize,
) -> Result<(), String> {
    if body.len() > max_size {
        return Err("Response too large".into());
    }
    let reason = match status {
        200 => "OK",
        204 => "No Content",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        429 => "Too Many Requests",
        _ => "Error",
    };
    let response = format!("HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nX-Content-Type-Options: nosniff\r\nContent-Security-Policy: default-src 'self'; connect-src 'self' ws:; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'\r\n\r\n", body.len());
    stream
        .write_all(response.as_bytes())
        .and_then(|_| stream.write_all(body))
        .map_err(|e| e.to_string())
}

fn bind_listener(host: &str, start: u16, end: u16) -> Option<TcpListener> {
    let ip = host
        .trim_start_matches('[')
        .trim_end_matches(']')
        .parse::<IpAddr>()
        .ok()?;
    (start..=end).find_map(|port| TcpListener::bind((ip, port)).ok())
}

fn peer_ip(address: &str) -> Option<IpAddr> {
    address
        .parse::<std::net::SocketAddr>()
        .ok()
        .map(|addr| addr.ip())
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

fn sanitize_remote_message(input: &str) -> String {
    input
        .chars()
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .collect()
}

fn query_value(target: &str, key: &str) -> Option<String> {
    target.split('?').nth(1)?.split('&').find_map(|part| {
        let (candidate, value) = part.split_once('=')?;
        (candidate == key).then(|| percent_decode(value))
    })
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'%' if index + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).unwrap_or("");
                match u8::from_str_radix(hex, 16) {
                    Ok(byte) => {
                        decoded.push(byte);
                        index += 3;
                    }
                    Err(_) => {
                        decoded.push(bytes[index]);
                        index += 1;
                    }
                }
            }
            b'+' => {
                decoded.push(b' ');
                index += 1;
            }
            byte => {
                decoded.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8_lossy(&decoded).into_owned()
}

fn local_ip() -> String {
    UdpSocket::bind("0.0.0.0:0")
        .and_then(|socket| {
            socket.connect("8.8.8.8:80")?;
            socket.local_addr()
        })
        .map(|addr| match addr.ip() {
            IpAddr::V4(ip) => ip.to_string(),
            IpAddr::V6(ip) => format!("[{ip}]"),
        })
        .unwrap_or_else(|_| "127.0.0.1".into())
}

#[cfg(test)]
mod tests {
    use super::{
        appearance_from_document, find_headers_end, header_value, percent_decode,
        selected_brand_icon, RemoteAppearance, RemoteHub,
    };
    use serde_json::json;
    use std::cell::Cell;

    #[test]
    fn appearance_defaults_are_safe_and_branded() {
        assert_eq!(
            appearance_from_document(&json!({})),
            RemoteAppearance {
                ui_theme: "elite-indigo".into(),
                app_icon_theme: "elite-indigo".into(),
                language: "en".into(),
                motion_preference: "animated".into(),
                color_scheme: "dark".into(),
            }
        );
    }

    #[test]
    fn appearance_accepts_persisted_light_preferences() {
        assert_eq!(
            appearance_from_document(&json!({
                "preferences": {
                    "uiTheme": "elite-blush",
                    "appIconTheme": "elite-original",
                    "language": "pt-BR",
                    "motionPreference": "reduced"
                }
            })),
            RemoteAppearance {
                ui_theme: "elite-blush".into(),
                app_icon_theme: "elite-original".into(),
                language: "pt-BR".into(),
                motion_preference: "reduced".into(),
                color_scheme: "light".into(),
            }
        );
    }

    #[test]
    fn appearance_rejects_unknown_persisted_values() {
        let appearance = appearance_from_document(&json!({
            "preferences": {
                "uiTheme": "custom-script",
                "appIconTheme": "missing-icon",
                "language": "unknown",
                "motionPreference": "spin"
            }
        }));

        assert_eq!(appearance.ui_theme, "elite-indigo");
        assert_eq!(appearance.app_icon_theme, "elite-indigo");
        assert_eq!(appearance.language, "en");
        assert_eq!(appearance.motion_preference, "animated");
    }

    #[test]
    fn selected_brand_icon_uses_embedded_png_assets() {
        let icon = selected_brand_icon(&json!({
            "preferences": { "appIconTheme": "elite-blush" }
        }));

        assert_eq!(&icon[..8], b"\x89PNG\r\n\x1a\n");
        assert_ne!(
            icon,
            selected_brand_icon(&json!({
                "preferences": { "appIconTheme": "elite-indigo" }
            }))
        );
    }

    #[test]
    fn publish_does_not_build_payload_without_subscribers() {
        let hub = RemoteHub::new();
        let payload_built = Cell::new(false);

        hub.publish("pty-1", || {
            payload_built.set(true);
            serde_json::json!({ "type": "test" })
        });

        assert!(!payload_built.get());
    }

    #[test]
    fn inactive_hub_reports_no_connected_devices() {
        let hub = RemoteHub::new();

        assert_eq!(hub.connected_device_count(), 0);
    }

    #[test]
    fn pairing_is_closed_until_a_window_is_opened() {
        let hub = RemoteHub::new();

        assert_eq!(hub.pairing_remaining(), 0);
        assert!(hub.pairing_url().is_none());
        assert!(hub
            .pair("anything", "Phone".into(), "127.0.0.1:1".into())
            .is_err());
    }

    #[test]
    fn pairing_rejects_an_unknown_token_while_open() {
        let hub = RemoteHub::new();
        hub.running.store(true, std::sync::atomic::Ordering::SeqCst);
        hub.open_pairing_window();

        assert!(hub
            .pair("wrong-token", "Phone".into(), "127.0.0.1:1".into())
            .is_err());
    }

    #[test]
    fn pairing_issues_a_session_token_and_closes_the_window() {
        let hub = RemoteHub::new();
        hub.running.store(true, std::sync::atomic::Ordering::SeqCst);
        hub.open_pairing_window();
        let token = hub.pairing_token.lock().expect("pairing token").clone();

        let (id, session_token) = hub
            .pair(&token, "Phone".into(), "127.0.0.1:1".into())
            .expect("pairing should succeed");

        assert_eq!(hub.session_id_for(&session_token), Some(id));
        assert_eq!(hub.pairing_remaining(), 0);
        assert!(hub.session_id_for("not-a-session").is_none());
    }

    #[test]
    fn pairing_honours_the_device_limit() {
        let hub = RemoteHub::new();
        hub.running.store(true, std::sync::atomic::Ordering::SeqCst);
        hub.open_pairing_window();
        let token = hub.pairing_token.lock().expect("pairing token").clone();
        hub.pair(&token, "Phone".into(), "127.0.0.1:1".into())
            .expect("first device pairs");

        hub.open_pairing_window();
        let token = hub.pairing_token.lock().expect("pairing token").clone();

        assert!(hub
            .pair(&token, "Tablet".into(), "127.0.0.1:2".into())
            .is_err());
    }

    #[test]
    fn revoking_a_device_invalidates_its_session_token() {
        let hub = RemoteHub::new();
        hub.running.store(true, std::sync::atomic::Ordering::SeqCst);
        hub.open_pairing_window();
        let token = hub.pairing_token.lock().expect("pairing token").clone();
        let (id, session_token) = hub
            .pair(&token, "Phone".into(), "127.0.0.1:1".into())
            .expect("pairing should succeed");

        hub.revoke_device(id);

        assert!(hub.session_id_for(&session_token).is_none());
    }

    #[test]
    fn repeated_failures_lock_an_address_out() {
        let hub = RemoteHub::new();
        let address = "192.168.0.44:5100";

        for _ in 0..super::AUTH_FAILURE_LIMIT {
            hub.record_auth_failure(address);
        }

        assert!(hub.auth_blocked(address));
        hub.clear_auth_failures(address);
        assert!(!hub.auth_blocked(address));
    }

    #[test]
    fn qr_svg_is_cached_by_pairing_url() {
        let hub = RemoteHub::new();
        let url = "http://127.0.0.1:9340/?pair=test";

        let first = hub.qr_svg(url).expect("QR code should render");
        let second = hub.qr_svg(url).expect("cached QR code should exist");

        assert_eq!(first, second);
        assert_eq!(
            hub.qr_cache.lock().expect("cache lock").as_ref().unwrap().0,
            url
        );
    }

    #[test]
    fn request_headers_end_is_detected_across_chunks() {
        assert_eq!(find_headers_end(b"GET / HTTP/1.1\r\n\r\nbody"), Some(14));
        assert_eq!(find_headers_end(b"GET / HTTP/1.1\r\n"), None);
    }

    #[test]
    fn header_lookup_is_case_insensitive() {
        let head = "POST /api/pair HTTP/1.1\r\nContent-Length: 42\r\nAuthorization: Bearer abc";

        assert_eq!(header_value(head, "content-length"), Some("42".into()));
        assert_eq!(super::bearer_token(head), "abc");
    }

    #[test]
    fn percent_encoded_query_values_are_decoded() {
        assert_eq!(percent_decode("a%2Fb+c"), "a/b c");
    }
}
