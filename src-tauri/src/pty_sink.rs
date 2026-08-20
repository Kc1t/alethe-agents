use crate::pty::{PtyExitPayload, PtyResizedPayload, PtySuspendedPayload};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use tauri::Emitter;
use tokio::sync::broadcast;

#[derive(Clone, Serialize)]
#[serde(tag = "type")]
pub enum PtyWsMessage {
    #[serde(rename = "data")]
    Data { chunk: String, cursor: u64 },
    #[serde(rename = "activity")]
    Activity { chunk: String, cursor: u64 },
    #[serde(rename = "exit")]
    Exit { code: Option<i32>, reason: String },
    #[serde(rename = "gap")]
    Gap { dropped: u64 },
    #[serde(rename = "missing")]
    Missing,
    // "resized" (not "resize") — deliberately distinct from the client→server
    // `IncomingWsMessage::Resize` command on the same socket, so the two
    // directions are never confused reading the wire format.
    #[serde(rename = "resized")]
    Resized { cols: u16, rows: u16 },
}

pub fn pty_broadcast_channels() -> &'static Mutex<HashMap<String, broadcast::Sender<PtyWsMessage>>>
{
    static CHANNELS: OnceLock<Mutex<HashMap<String, broadcast::Sender<PtyWsMessage>>>> =
        OnceLock::new();
    CHANNELS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn get_or_create_pty_ws_channel(id: &str) -> broadcast::Sender<PtyWsMessage> {
    let mut channels = pty_broadcast_channels().lock().unwrap();
    channels
        .entry(id.to_string())
        .or_insert_with(|| {
            let (tx, _) = broadcast::channel(1024);
            tx
        })
        .clone()
}

/// Trait genérico de saída de eventos PTY desvinculado do runtime do Tauri.
pub trait PtyOutputSink: Send + Sync {
    /// Canal `pty://data/{id}` — painel visível, sempre.
    fn emit_data(&self, id: &str, text: &str, cursor: u64);
    /// Canal `pty://activity/{id}` — painel invisível, throttlado em pty.rs.
    fn emit_activity(&self, id: &str, text: &str, cursor: u64);
    /// Canal `pty://exit/{id}`.
    fn emit_exit(&self, id: &str, payload: &PtyExitPayload);
    /// Canal ÚNICO `resource://pty-suspended` (ID no payload).
    fn emit_suspended(&self, payload: &PtySuspendedPayload);
    /// Canal `pty://resized/{id}` — avisa clientes que NÃO iniciaram o
    /// resize pra que redimensionem seu próprio xterm.js local.
    fn emit_resized(&self, id: &str, cols: u16, rows: u16);
}

/// Implementação Desktop — wrapper fino sobre o `app.emit()` do Tauri.
pub struct TauriSink(pub tauri::AppHandle);

impl PtyOutputSink for TauriSink {
    fn emit_data(&self, id: &str, text: &str, _cursor: u64) {
        let channel = format!("pty://data/{id}");
        let _ = self.0.emit(&channel, text);
    }

    fn emit_activity(&self, id: &str, text: &str, _cursor: u64) {
        let channel = format!("pty://activity/{id}");
        let _ = self.0.emit(&channel, text);
    }

    fn emit_exit(&self, id: &str, payload: &PtyExitPayload) {
        let channel = format!("pty://exit/{id}");
        let _ = self.0.emit(&channel, payload);
    }

    fn emit_suspended(&self, payload: &PtySuspendedPayload) {
        let _ = self.0.emit("resource://pty-suspended", payload);
    }

    fn emit_resized(&self, id: &str, cols: u16, rows: u16) {
        let channel = format!("pty://resized/{id}");
        let _ = self.0.emit(&channel, PtyResizedPayload { cols, rows });
    }
}

/// Implementação WebSockets — transmite chunks para conexões WS ativas.
pub struct WebSocketSink;

impl PtyOutputSink for WebSocketSink {
    fn emit_data(&self, id: &str, text: &str, cursor: u64) {
        let sender = get_or_create_pty_ws_channel(id);
        let _ = sender.send(PtyWsMessage::Data {
            chunk: text.to_string(),
            cursor,
        });
    }

    fn emit_activity(&self, id: &str, text: &str, cursor: u64) {
        let sender = get_or_create_pty_ws_channel(id);
        let _ = sender.send(PtyWsMessage::Activity {
            chunk: text.to_string(),
            cursor,
        });
    }

    fn emit_exit(&self, id: &str, payload: &PtyExitPayload) {
        let sender = get_or_create_pty_ws_channel(id);
        let _ = sender.send(PtyWsMessage::Exit {
            code: payload.code,
            reason: payload.reason.to_string(),
        });
        // Keep the channel stable across a restart that reuses the PTY id.
        // Existing WebSocket subscribers must observe the next generation.
    }

    fn emit_suspended(&self, payload: &PtySuspendedPayload) {
        let sender = get_or_create_pty_ws_channel(&payload.id);
        let _ = sender.send(PtyWsMessage::Exit {
            code: None,
            reason: payload.reason.to_string(),
        });
        // Suspension can also be followed by a spawn with the same PTY id.
    }

    fn emit_resized(&self, id: &str, cols: u16, rows: u16) {
        let sender = get_or_create_pty_ws_channel(id);
        let _ = sender.send(PtyWsMessage::Resized { cols, rows });
    }
}

/// Sink combinado que transmite simultaneamente para Tauri IPC e WebSockets.
pub struct CombinedSink(pub TauriSink, pub WebSocketSink);

impl PtyOutputSink for CombinedSink {
    fn emit_data(&self, id: &str, text: &str, cursor: u64) {
        self.0.emit_data(id, text, cursor);
        self.1.emit_data(id, text, cursor);
    }

    fn emit_activity(&self, id: &str, text: &str, cursor: u64) {
        self.0.emit_activity(id, text, cursor);
        self.1.emit_activity(id, text, cursor);
    }

    fn emit_exit(&self, id: &str, payload: &PtyExitPayload) {
        self.0.emit_exit(id, payload);
        self.1.emit_exit(id, payload);
    }

    fn emit_suspended(&self, payload: &PtySuspendedPayload) {
        self.0.emit_suspended(payload);
        self.1.emit_suspended(payload);
    }

    fn emit_resized(&self, id: &str, cols: u16, rows: u16) {
        self.0.emit_resized(id, cols, rows);
        self.1.emit_resized(id, cols, rows);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_id() -> String {
        format!("pty-sink-test-{}", nanoid::nanoid!(8))
    }

    #[test]
    fn websocket_sink_keeps_data_and_activity_as_distinct_cursor_events() {
        let id = test_id();
        let mut receiver = get_or_create_pty_ws_channel(&id).subscribe();
        let sink = WebSocketSink;

        sink.emit_data(&id, "visible", 7);
        sink.emit_activity(&id, "hidden", 13);

        match receiver.try_recv().unwrap() {
            PtyWsMessage::Data { chunk, cursor } => {
                assert_eq!(chunk, "visible");
                assert_eq!(cursor, 7);
            }
            _ => panic!("expected data event"),
        }
        match receiver.try_recv().unwrap() {
            PtyWsMessage::Activity { chunk, cursor } => {
                assert_eq!(chunk, "hidden");
                assert_eq!(cursor, 13);
            }
            _ => panic!("expected activity event"),
        }
        pty_broadcast_channels().lock().unwrap().remove(&id);
    }

    #[test]
    fn websocket_channel_survives_exit_for_same_id_restart() {
        let id = test_id();
        let mut receiver = get_or_create_pty_ws_channel(&id).subscribe();
        let sink = WebSocketSink;

        sink.emit_exit(
            &id,
            &PtyExitPayload {
                code: Some(0),
                reason: "restarted",
            },
        );
        sink.emit_data(&id, "next generation", 1);

        assert!(matches!(
            receiver.try_recv().unwrap(),
            PtyWsMessage::Exit { reason, .. } if reason == "restarted"
        ));
        assert!(matches!(
            receiver.try_recv().unwrap(),
            PtyWsMessage::Data { chunk, cursor } if chunk == "next generation" && cursor == 1
        ));
        pty_broadcast_channels().lock().unwrap().remove(&id);
    }
}
