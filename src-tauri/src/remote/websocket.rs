//! The LAN WebSocket listener: per-device streaming of terminal output.

use serde_json::{json, Value};
use std::net::TcpStream;
use std::sync::{mpsc, Arc};
use std::thread;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter};
use tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tungstenite::{accept_hdr, Message};

use crate::pty::PtySessions;

use super::pty_bridge::{read_pty_size, read_scrollback};
use super::util::bind_listener;
use super::{
    ConnectionGuard, RemoteHub, HTTP_END, HTTP_START, MAX_MESSAGE, MAX_SCROLLBACK,
    SOCKET_TIMEOUT, WS_AUTH_TIMEOUT,
};

pub(crate) fn run_websocket(app: AppHandle, hub: Arc<RemoteHub>, sessions: PtySessions, generation: u64) {
    let host = hub.host();
    let Some(listener) = bind_listener(&host, HTTP_START + 1, HTTP_END + 1) else {
        eprintln!("[remote] unable to bind LAN WebSocket listener");
        let _ = app.emit("remote://start-failed", ());
        super::stop();
        return;
    };
    let port = listener.local_addr().map(|addr| addr.port()).unwrap_or(0);
    hub.set_ws_port(port);
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
    hub.clear_ws_port_if_current(generation);
}

fn allowed_origin(hub: &RemoteHub) -> String {
    format!("http://{}:{}", hub.host(), hub.http_port())
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
                        let (cols, rows) = read_pty_size(&sessions, pty_id).unwrap_or((80, 24));
                        let payload = json!({
                            "type": "scrollback",
                            "ptyId": pty_id,
                            "text": scrollback,
                            "cols": cols,
                            "rows": rows,
                        });
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
