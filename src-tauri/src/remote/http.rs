//! The LAN HTTP listener: pairing, the `/api/*` surface, and the static
//! remote-client asset bundle.

use serde::Deserialize;
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use tauri::{AppHandle, Emitter};

use crate::pty::PtySessions;

use super::appearance::{projects_document, remote_appearance, selected_brand_icon};
use super::pty_bridge::{read_pty_size, read_scrollback, write_remote};
use super::util::{bind_listener, query_value, sanitize_remote_message};
use super::workspace::{pty_agent, pty_is_shared, shared_tab, workspace_snapshot};
use super::{
    ConnectionGuard, RemoteHub, HTTP_END, HTTP_START, IDLE_DISABLE_SECS, MAX_BODY, MAX_MESSAGE,
    MAX_REQUEST, MAX_SCROLLBACK, MAX_STATIC_ASSET, SOCKET_TIMEOUT,
};

const MAX_TRANSCRIPT_EVENTS: usize = 160;
const CACHE_NO_STORE: &str = "no-store";
const CACHE_IMMUTABLE: &str = "public, max-age=31536000, immutable";

pub(crate) fn run_http(app: AppHandle, hub: Arc<RemoteHub>, sessions: PtySessions, generation: u64) {
    let host = hub.host();
    let Some(listener) = bind_listener(&host, HTTP_START, HTTP_END) else {
        eprintln!("[remote] unable to bind LAN HTTP listener");
        let _ = app.emit("remote://start-failed", ());
        super::stop();
        return;
    };
    let port = listener.local_addr().map(|addr| addr.port()).unwrap_or(0);
    hub.set_http_port(port);
    eprintln!("[remote] LAN client available at http://{host}:{port}");
    let _ = listener.set_nonblocking(true);
    while hub.is_active(generation) {
        let stream = match listener.accept() {
            Ok((stream, _)) => stream,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                if hub.is_idle(IDLE_DISABLE_SECS) {
                    eprintln!(
                        "[remote] auto-disabling after {}s with no paired device",
                        IDLE_DISABLE_SECS
                    );
                    let _ = app.emit("remote://auto-disabled", ());
                    super::stop();
                    break;
                }
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
    hub.clear_http_port_if_current(generation);
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
            include_str!("../../remote/index.html"),
        ),
        "/app.js" => respond(
            stream,
            200,
            "text/javascript; charset=utf-8",
            include_str!("../../remote/app.js"),
        ),
        "/app.css" => respond(
            stream,
            200,
            "text/css; charset=utf-8",
            include_str!("../../remote/app.css"),
        ),
        "/theme.css" => respond(
            stream,
            200,
            "text/css; charset=utf-8",
            include_str!("../../../src/styles/theme.css"),
        ),
        "/vendor/xterm.js" => respond_immutable_asset(
            stream,
            200,
            "text/javascript; charset=utf-8",
            include_str!("../../../node_modules/@xterm/xterm/lib/xterm.js"),
        ),
        "/vendor/xterm.css" => respond_immutable_asset(
            stream,
            200,
            "text/css; charset=utf-8",
            include_str!("../../../node_modules/@xterm/xterm/css/xterm.css"),
        ),
        "/vendor/addon-unicode11.js" => respond_immutable_asset(
            stream,
            200,
            "text/javascript; charset=utf-8",
            include_str!("../../../node_modules/@xterm/addon-unicode11/lib/addon-unicode11.js"),
        ),
        "/brand-icon.png" => respond_asset_bytes(
            stream,
            200,
            "image/png",
            selected_brand_icon(&projects_document(app)),
        ),
        "/assets/fonts/CaskaydiaCoveNerdFontMono-Regular.ttf" => respond_immutable_asset_bytes(
            stream,
            200,
            "font/ttf",
            include_bytes!("../../../src/assets/fonts/CaskaydiaCoveNerdFontMono-Regular.ttf"),
        ),
        "/assets/fonts/CaskaydiaCoveNerdFontMono-Bold.ttf" => respond_immutable_asset_bytes(
            stream,
            200,
            "font/ttf",
            include_bytes!("../../../src/assets/fonts/CaskaydiaCoveNerdFontMono-Bold.ttf"),
        ),
        "/assets/fonts/CaskaydiaCoveNerdFontMono-Italic.ttf" => respond_immutable_asset_bytes(
            stream,
            200,
            "font/ttf",
            include_bytes!("../../../src/assets/fonts/CaskaydiaCoveNerdFontMono-Italic.ttf"),
        ),
        "/assets/fonts/CaskaydiaCoveNerdFontMono-BoldItalic.ttf" => respond_immutable_asset_bytes(
            stream,
            200,
            "font/ttf",
            include_bytes!("../../../src/assets/fonts/CaskaydiaCoveNerdFontMono-BoldItalic.ttf"),
        ),
        "/manifest.webmanifest" => respond(
            stream,
            200,
            "application/manifest+json",
            include_str!("../../remote/manifest.webmanifest"),
        ),
        "/assets/agents/claude.png" => respond_immutable_asset_bytes(
            stream,
            200,
            "image/png",
            include_bytes!("../../../src/assets/claude-code.png"),
        ),
        "/assets/agents/codex.png" => respond_immutable_asset_bytes(
            stream,
            200,
            "image/png",
            include_bytes!("../../../src/assets/codex.png"),
        ),
        "/assets/agents/opencode.png" => respond_immutable_asset_bytes(
            stream,
            200,
            "image/png",
            include_bytes!("../../../src/assets/open-white.png"),
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
        let (cols, rows) = read_pty_size(sessions, &id).unwrap_or((80, 24));
        return respond_large(
            stream,
            200,
            "application/json",
            &json!({ "text": text, "cols": cols, "rows": rows }).to_string(),
        );
    }
    if path == "/api/transcript" {
        let id = query_value(target, "id").ok_or_else(|| "Missing PTY id".to_string())?;
        if !pty_is_shared(app, &id) {
            return respond(
                stream,
                403,
                "application/json",
                r#"{"error":"This terminal is not available remotely"}"#,
            );
        }
        let Some(tab) = shared_tab(app, &id) else {
            return respond(
                stream,
                404,
                "application/json",
                r#"{"error":"Terminal not found"}"#,
            );
        };
        if tab.agent != "claude" && tab.agent != "codex" {
            return respond(
                stream,
                200,
                "application/json",
                &json!({ "supported": false, "agent": tab.agent }).to_string(),
            );
        }
        let since = query_value(target, "since").and_then(|value| value.parse::<u64>().ok());
        return match crate::handoff::transcript_snapshot(
            &tab.agent,
            &tab.cwd,
            tab.session_id.as_deref(),
            since,
            MAX_TRANSCRIPT_EVENTS,
        ) {
            Ok(snapshot) => {
                let mut payload = serde_json::to_value(snapshot).map_err(|e| e.to_string())?;
                payload["supported"] = Value::Bool(true);
                payload["agent"] = Value::String(tab.agent);
                respond_large(stream, 200, "application/json", &payload.to_string())
            }
            Err(error) => respond(
                stream,
                200,
                "application/json",
                &json!({ "supported": true, "agent": tab.agent, "error": error }).to_string(),
            ),
        };
    }
    if path == "/api/message" && method == "POST" {
        if hub.is_read_only() {
            return respond(
                stream,
                403,
                "application/json",
                r#"{"error":"Remote control is in read-only mode"}"#,
            );
        }
        if !hub.allow_message(session_id) {
            return respond(
                stream,
                429,
                "application/json",
                r#"{"error":"Too many messages, slow down"}"#,
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
        if agent == "shell" && !hub.shell_input_allowed() {
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
    respond_bytes_with_limit(stream, status, content_type, body, MAX_BODY, CACHE_NO_STORE)
}

fn respond_large(
    stream: &mut TcpStream,
    status: u16,
    content_type: &str,
    body: &str,
) -> Result<(), String> {
    respond_bytes_with_limit(
        stream,
        status,
        content_type,
        body.as_bytes(),
        MAX_STATIC_ASSET,
        CACHE_NO_STORE,
    )
}

fn respond_asset_bytes(
    stream: &mut TcpStream,
    status: u16,
    content_type: &str,
    body: &[u8],
) -> Result<(), String> {
    respond_bytes_with_limit(
        stream,
        status,
        content_type,
        body,
        MAX_STATIC_ASSET,
        CACHE_NO_STORE,
    )
}

fn respond_immutable_asset(
    stream: &mut TcpStream,
    status: u16,
    content_type: &str,
    body: &str,
) -> Result<(), String> {
    respond_immutable_asset_bytes(stream, status, content_type, body.as_bytes())
}

fn respond_immutable_asset_bytes(
    stream: &mut TcpStream,
    status: u16,
    content_type: &str,
    body: &[u8],
) -> Result<(), String> {
    respond_bytes_with_limit(
        stream,
        status,
        content_type,
        body,
        MAX_STATIC_ASSET,
        CACHE_IMMUTABLE,
    )
}

fn respond_bytes_with_limit(
    stream: &mut TcpStream,
    status: u16,
    content_type: &str,
    body: &[u8],
    max_size: usize,
    cache_control: &str,
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
    let response = format!("HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: {cache_control}\r\nReferrer-Policy: no-referrer\r\nX-Content-Type-Options: nosniff\r\nContent-Security-Policy: default-src 'self'; connect-src 'self' ws:; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'\r\n\r\n", body.len());
    stream
        .write_all(response.as_bytes())
        .and_then(|_| stream.write_all(body))
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::{bearer_token, find_headers_end, header_value};

    #[test]
    fn request_headers_end_is_detected_across_chunks() {
        assert_eq!(find_headers_end(b"GET / HTTP/1.1\r\n\r\nbody"), Some(14));
        assert_eq!(find_headers_end(b"GET / HTTP/1.1\r\n"), None);
    }

    #[test]
    fn header_lookup_is_case_insensitive() {
        let head = "POST /api/pair HTTP/1.1\r\nContent-Length: 42\r\nAuthorization: Bearer abc";

        assert_eq!(header_value(head, "content-length"), Some("42".into()));
        assert_eq!(bearer_token(head), "abc");
    }
}
