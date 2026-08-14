//! LAN-only remote control for existing Alethe terminal sessions.
//!
//! The remote surface is intentionally read-mostly: it exposes workspace
//! metadata and terminal output, and accepts one complete prompt at a time.
//! It never creates, deletes, or edits workspace entities.

use qrcode::{render::svg, QrCode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::{IpAddr, TcpListener, TcpStream, UdpSocket};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU16, AtomicU64, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::AppHandle;
use tungstenite::{accept, Message};

use crate::paths::projects_file_path;
use crate::pty::PtySessions;

const HTTP_START: u16 = 9340;
const HTTP_END: u16 = 9360;
const MAX_BODY: usize = 64 * 1024;
const MAX_MESSAGE: usize = 16 * 1024;
const MAX_REMOTE_DEVICES: usize = 4;
const DEFAULT_SESSION_EXPIRY_SECS: u64 = 60 * 60;
const MIN_SESSION_EXPIRY_SECS: u64 = 5 * 60;
const MAX_SESSION_EXPIRY_SECS: u64 = 24 * 60 * 60;

static HUB: OnceLock<Arc<RemoteHub>> = OnceLock::new();

#[derive(Clone, Serialize)]
pub struct RemoteDeviceInfo {
    pub id: usize,
    pub name: String,
    pub address: String,
    pub connected_at: u64,
    pub expires_at: u64,
}

#[derive(Clone, Serialize)]
pub struct RemoteInfo {
    pub enabled: bool,
    pub connected_devices: usize,
    pub max_devices: usize,
    pub session_expiry_secs: u64,
    pub devices: Vec<RemoteDeviceInfo>,
    pub pairing_url: Option<String>,
    pub qr_svg: Option<String>,
    pub http_url: Option<String>,
    pub ws_url: Option<String>,
}

pub struct RemoteHub {
    token: Mutex<String>,
    host: String,
    running: AtomicBool,
    generation: AtomicU64,
    http_port: AtomicU16,
    ws_port: AtomicU16,
    next_client_id: AtomicUsize,
    max_devices: AtomicUsize,
    session_expiry_secs: AtomicU64,
    clients: Mutex<Vec<RemoteClient>>,
}

struct RemoteClient {
    id: usize,
    sender: mpsc::Sender<String>,
    name: String,
    address: String,
    connected_at: SystemTime,
    expires_at: Instant,
}

impl RemoteHub {
    fn new() -> Self {
        Self {
            token: Mutex::new(nanoid::nanoid!(32)),
            host: local_ip(),
            running: AtomicBool::new(false),
            generation: AtomicU64::new(0),
            http_port: AtomicU16::new(0),
            ws_port: AtomicU16::new(0),
            next_client_id: AtomicUsize::new(1),
            max_devices: AtomicUsize::new(1),
            session_expiry_secs: AtomicU64::new(DEFAULT_SESSION_EXPIRY_SECS),
            clients: Mutex::new(Vec::new()),
        }
    }

    fn enabled(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    fn is_active(&self, generation: u64) -> bool {
        self.running.load(Ordering::SeqCst) && self.generation.load(Ordering::SeqCst) == generation
    }

    fn pairing_url(&self) -> Option<String> {
        let port = self.http_port.load(Ordering::SeqCst);
        let token = self.token.lock().ok()?.clone();
        (port != 0).then(|| format!("http://{}:{}/?token={}", self.host, port, token))
    }

    fn info(&self) -> RemoteInfo {
        let http_port = self.http_port.load(Ordering::SeqCst);
        let ws_port = self.ws_port.load(Ordering::SeqCst);
        let pairing_url = self.pairing_url();
        let qr_svg = pairing_url.as_ref().and_then(|url| {
            QrCode::new(url.as_bytes())
                .ok()
                .map(|code| code.render::<svg::Color>().min_dimensions(220, 220).build())
        });
        let devices: Vec<RemoteDeviceInfo> = self
            .clients
            .lock()
            .map(|clients| {
                clients
                    .iter()
                    .map(|client| RemoteDeviceInfo {
                        id: client.id,
                        name: client.name.clone(),
                        address: client.address.clone(),
                        connected_at: client
                            .connected_at
                            .duration_since(UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_secs(),
                        expires_at: client
                            .connected_at
                            .duration_since(UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_secs()
                            + self.session_expiry_secs.load(Ordering::Relaxed),
                    })
                    .collect()
            })
            .unwrap_or_default();
        RemoteInfo {
            enabled: self.enabled(),
            connected_devices: devices.len(),
            max_devices: self.max_devices.load(Ordering::Relaxed),
            session_expiry_secs: self.session_expiry_secs.load(Ordering::Relaxed),
            devices,
            pairing_url,
            qr_svg,
            http_url: (http_port != 0).then(|| format!("http://{}:{}", self.host, http_port)),
            ws_url: (ws_port != 0).then(|| format!("ws://{}:{}", self.host, ws_port)),
        }
    }

    pub(crate) fn publish(&self, payload: Value) {
        let message = payload.to_string();
        let mut clients = match self.clients.lock() {
            Ok(clients) => clients,
            Err(_) => return,
        };
        clients.retain(|client| client.sender.send(message.clone()).is_ok());
    }

    fn try_register_client(
        &self,
        sender: mpsc::Sender<String>,
        name: String,
        address: String,
    ) -> Option<usize> {
        let mut clients = self.clients.lock().ok()?;
        if clients.len() >= self.max_devices.load(Ordering::Relaxed) {
            return None;
        }
        let id = self.next_client_id.fetch_add(1, Ordering::Relaxed);
        let now = SystemTime::now();
        let expires_at =
            Instant::now() + Duration::from_secs(self.session_expiry_secs.load(Ordering::Relaxed));
        clients.push(RemoteClient {
            id,
            sender,
            name,
            address,
            connected_at: now,
            expires_at,
        });
        Some(id)
    }

    fn unregister_client(&self, id: usize) {
        if let Ok(mut clients) = self.clients.lock() {
            clients.retain(|client| client.id != id);
        }
    }

    fn disconnect_all(&self) {
        if let Ok(mut clients) = self.clients.lock() {
            clients.clear();
        }
    }

    fn revoke_client(&self, id: usize) {
        if let Ok(mut clients) = self.clients.lock() {
            clients.retain(|client| client.id != id);
        }
    }

    fn client_expired(&self, id: usize) -> bool {
        self.clients
            .lock()
            .ok()
            .and_then(|clients| {
                clients
                    .iter()
                    .find(|client| client.id == id)
                    .map(|client| client.expires_at <= Instant::now())
            })
            .unwrap_or(true)
    }
}

pub fn hub() -> Arc<RemoteHub> {
    HUB.get_or_init(|| Arc::new(RemoteHub::new())).clone()
}

pub fn start_core(projects_path: PathBuf, sessions: PtySessions) {
    let hub = hub();
    if hub.running.swap(true, Ordering::SeqCst) {
        return;
    }
    let generation = hub.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let http_hub = Arc::clone(&hub);
    let http_sessions = Arc::clone(&sessions);
    let http_projects_path = projects_path;
    thread::spawn(move || run_http(http_projects_path, http_hub, http_sessions, generation));

    let ws_hub = Arc::clone(&hub);
    let ws_sessions = Arc::clone(&sessions);
    thread::spawn(move || run_websocket(ws_hub, ws_sessions, generation));
}

pub fn start(app: AppHandle, sessions: PtySessions) {
    if let Ok(projects_path) = projects_file_path(&app) {
        start_core(projects_path, sessions);
    }
}

pub fn stop() {
    let hub = hub();
    hub.running.store(false, Ordering::SeqCst);
    hub.generation.fetch_add(1, Ordering::SeqCst);
    hub.http_port.store(0, Ordering::SeqCst);
    hub.ws_port.store(0, Ordering::SeqCst);
    hub.disconnect_all();
    eprintln!("[remote] LAN remote control disabled");
}

#[tauri::command]
pub fn remote_control_info() -> RemoteInfo {
    hub().info()
}

#[tauri::command]
pub fn remote_control_revoke() -> RemoteInfo {
    let remote = hub();
    if let Ok(mut token) = remote.token.lock() {
        *token = nanoid::nanoid!(32);
    }
    remote.disconnect_all();
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
pub fn remote_control_revoke_device(device_id: usize) -> RemoteInfo {
    let remote = hub();
    remote.revoke_client(device_id);
    remote.info()
}

pub fn remote_control_set_enabled_core(
    projects_path: &Path,
    sessions: &PtySessions,
    enabled: bool,
) -> RemoteInfo {
    if enabled {
        start_core(projects_path.to_path_buf(), sessions.clone());
    } else {
        stop();
    }
    hub().info()
}

#[tauri::command]
pub fn remote_control_set_enabled(
    app: AppHandle,
    sessions: tauri::State<'_, PtySessions>,
    enabled: bool,
) -> Result<RemoteInfo, String> {
    let projects_path = projects_file_path(&app)?;
    Ok(remote_control_set_enabled_core(
        &projects_path,
        sessions.inner(),
        enabled,
    ))
}

fn run_http(projects_path: PathBuf, hub: Arc<RemoteHub>, sessions: PtySessions, generation: u64) {
    let Some(listener) = bind_listener(&hub.host, HTTP_START, HTTP_END) else {
        eprintln!("[remote] unable to bind LAN HTTP listener");
        hub.running.store(false, Ordering::SeqCst);
        return;
    };
    let port = listener.local_addr().map(|addr| addr.port()).unwrap_or(0);
    hub.http_port.store(port, Ordering::SeqCst);
    eprintln!(
        "[remote] LAN client available at http://{}:{}",
        hub.host, port
    );
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
        let mut stream = stream;
        let hub = Arc::clone(&hub);
        let sessions = Arc::clone(&sessions);
        let projects_path = projects_path.clone();
        thread::spawn(move || {
            if let Err(error) = handle_http(&mut stream, &projects_path, &hub, &sessions) {
                eprintln!("[remote] HTTP request failed: {error}");
            }
        });
    }
    if hub.generation.load(Ordering::SeqCst) == generation {
        hub.http_port.store(0, Ordering::SeqCst);
    }
}

fn run_websocket(hub: Arc<RemoteHub>, sessions: PtySessions, generation: u64) {
    let Some(listener) = bind_listener(&hub.host, HTTP_START + 1, HTTP_END + 1) else {
        eprintln!("[remote] unable to bind LAN WebSocket listener");
        hub.running.store(false, Ordering::SeqCst);
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
        let hub = Arc::clone(&hub);
        let sessions = Arc::clone(&sessions);
        let address = stream
            .peer_addr()
            .map(|address| address.to_string())
            .unwrap_or_else(|_| "Unknown device".into());
        thread::spawn(move || handle_websocket(stream, hub, sessions, generation, address));
    }
    if hub.generation.load(Ordering::SeqCst) == generation {
        hub.ws_port.store(0, Ordering::SeqCst);
    }
}

fn handle_websocket(
    stream: TcpStream,
    hub: Arc<RemoteHub>,
    sessions: PtySessions,
    generation: u64,
    address: String,
) {
    let mut socket = match accept(stream) {
        Ok(socket) => socket,
        Err(_) => return,
    };
    let _ = socket.get_mut().set_nonblocking(true);
    let (tx, rx) = mpsc::channel::<String>();
    let mut client_id = None;
    loop {
        if !hub.is_active(generation) {
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
        if let Some(id) = client_id {
            if hub.client_expired(id) {
                let _ = socket.send(Message::Text(
                    json!({ "type": "error", "message": "Remote session expired" })
                        .to_string()
                        .into(),
                ));
                break;
            }
        }
        match socket.read() {
            Ok(Message::Text(text)) => {
                let Ok(command) = serde_json::from_str::<Value>(&text) else {
                    continue;
                };
                let valid_token = hub
                    .token
                    .lock()
                    .ok()
                    .and_then(|token| {
                        command
                            .get("token")
                            .and_then(Value::as_str)
                            .map(|provided| tokens_equal(provided, &token))
                    })
                    .unwrap_or(false);
                if !valid_token {
                    let _ = socket.send(Message::Text(
                        json!({ "type": "error", "message": "Invalid pairing token" })
                            .to_string()
                            .into(),
                    ));
                    continue;
                }
                if client_id.is_none() {
                    let name = command
                        .get("deviceName")
                        .and_then(Value::as_str)
                        .unwrap_or("Remote device")
                        .chars()
                        .take(48)
                        .collect();
                    let Some(id) = hub.try_register_client(tx.clone(), name, address.clone())
                    else {
                        let _ = socket.send(Message::Text(
                            json!({ "type": "error", "message": "Maximum remote devices reached" })
                                .to_string()
                                .into(),
                        ));
                        break;
                    };
                    client_id = Some(id);
                    let _ = socket.send(Message::Text(
                        json!({ "type": "authenticated" }).to_string().into(),
                    ));
                }
                if command.get("type").and_then(Value::as_str) == Some("subscribe") {
                    if let Some(id) = command.get("ptyId").and_then(Value::as_str) {
                        let scrollback = read_scrollback(&sessions, id, 512 * 1024);
                        let payload =
                            json!({ "type": "scrollback", "ptyId": id, "text": scrollback });
                        let _ = socket.send(Message::Text(payload.to_string().into()));
                    }
                }
            }
            Err(tungstenite::Error::Io(error))
                if error.kind() == std::io::ErrorKind::WouldBlock => {}
            Err(tungstenite::Error::ConnectionClosed) => return,
            Err(_) => return,
            _ => {}
        }
        thread::sleep(Duration::from_millis(16));
    }
    if let Some(client_id) = client_id {
        hub.unregister_client(client_id);
    }
}

fn handle_http(
    stream: &mut TcpStream,
    projects_path: &Path,
    hub: &RemoteHub,
    sessions: &PtySessions,
) -> Result<(), String> {
    let mut buffer = vec![0_u8; 16 * 1024];
    let count = stream.read(&mut buffer).map_err(|e| e.to_string())?;
    let request = String::from_utf8_lossy(&buffer[..count]);
    let mut lines = request.split("\r\n");
    let first = lines.next().unwrap_or("");
    let mut parts = first.split_whitespace();
    let method = parts.next().unwrap_or("");
    let path = parts.next().unwrap_or("/");
    let headers_end = request.find("\r\n\r\n").unwrap_or(request.len());
    let body = &request[headers_end.saturating_add(4)..];
    let token = query_value(path, "token");
    let valid_token = hub
        .token
        .lock()
        .ok()
        .and_then(|expected| {
            token
                .as_deref()
                .map(|provided| tokens_equal(provided, &expected))
        })
        .unwrap_or(false);
    if path.starts_with("/api/") && !valid_token {
        return respond(
            stream,
            401,
            "application/json",
            r#"{"error":"Invalid pairing token"}"#,
        );
    }
    if path.starts_with("/api/info") {
        return respond(
            stream,
            200,
            "application/json",
            &serde_json::to_string(&hub.info()).map_err(|e| e.to_string())?,
        );
    }
    if path.starts_with("/api/state") {
        let state = workspace_snapshot(projects_path)?;
        return respond(stream, 200, "application/json", &state.to_string());
    }
    if path.starts_with("/api/scrollback") {
        let id = query_value(path, "id").ok_or_else(|| "Missing PTY id".to_string())?;
        let text = read_scrollback(sessions, &id, 512 * 1024);
        return respond(
            stream,
            200,
            "application/json",
            &json!({ "text": text }).to_string(),
        );
    }
    if path.starts_with("/api/message") && method == "POST" {
        let payload: RemoteMessage = serde_json::from_str(body).map_err(|e| e.to_string())?;
        let text = sanitize_remote_message(&payload.text);
        if text.trim().is_empty() || text.len() > MAX_MESSAGE {
            return respond(
                stream,
                400,
                "application/json",
                r#"{"error":"Message is empty or too large"}"#,
            );
        }
        write_remote(sessions, &payload.pty_id, &format!("{}\r", text.trim()))?;
        return respond(stream, 204, "text/plain", "");
    }
    match path.split('?').next().unwrap_or("/") {
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
        "/manifest.webmanifest" => respond(
            stream,
            200,
            "application/manifest+json",
            include_str!("../remote/manifest.webmanifest"),
        ),
        _ => respond(stream, 404, "text/plain", "Not found"),
    }
}

#[derive(Deserialize)]
struct RemoteMessage {
    #[serde(rename = "ptyId")]
    pty_id: String,
    text: String,
}

fn workspace_snapshot(projects_path: &Path) -> Result<Value, String> {
    let content = std::fs::read_to_string(projects_path).unwrap_or_else(|_| "{}".to_string());
    let parsed: Value = serde_json::from_str(&content).map_err(|e| e.to_string())?;
    let groups = parsed.get("groups").cloned().unwrap_or_else(|| json!([]));
    let projects = parsed.get("projects").cloned().unwrap_or_else(|| json!([]));
    let mut remote_projects = Vec::new();
    if let Some(items) = projects.as_array() {
        for project in items {
            let terminals = project
                .get("terminals")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let chats = terminals.into_iter().flat_map(|terminal| {
                let terminal_id = terminal.get("id").cloned().unwrap_or(Value::Null);
                let terminal_name = terminal.get("name").cloned().unwrap_or(Value::String("Terminal".into()));
                terminal.get("tabs").and_then(Value::as_array).cloned().unwrap_or_default().into_iter().filter_map(move |tab| {
                    let pty_id = tab.get("ptyId").and_then(Value::as_str)?.to_string();
                    Some(json!({ "id": tab.get("id"), "ptyId": pty_id, "name": terminal_name, "agent": tab.get("type"), "terminalId": terminal_id }))
                })
            }).collect::<Vec<_>>();
            remote_projects.push(json!({ "id": project.get("id"), "name": project.get("name"), "groupId": project.get("groupId"), "chats": chats }));
        }
    }
    Ok(json!({ "groups": groups, "projects": remote_projects }))
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
    if body.len() > MAX_BODY {
        return Err("Response too large".into());
    }
    let reason = match status {
        200 => "OK",
        204 => "No Content",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        _ => "Error",
    };
    let response = format!("HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nX-Content-Type-Options: nosniff\r\nContent-Security-Policy: default-src 'self'; connect-src 'self' ws:; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'\r\n\r\n{body}", body.as_bytes().len());
    stream
        .write_all(response.as_bytes())
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

fn query_value(path: &str, key: &str) -> Option<String> {
    path.split('?').nth(1)?.split('&').find_map(|part| {
        let (candidate, value) = part.split_once('=')?;
        (candidate == key).then(|| value.to_string())
    })
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
