use crate::pty::{PtyExitPayload, PtySuspendedPayload};
use tauri::Emitter;

/// Trait genérico de saída de eventos PTY desvinculado do runtime do Tauri.
pub trait PtyOutputSink: Send + Sync {
    /// Canal `pty://data/{id}` — painel visível, sempre.
    fn emit_data(&self, id: &str, text: &str);
    /// Canal `pty://activity/{id}` — painel invisível, throttlado em pty.rs.
    fn emit_activity(&self, id: &str, text: &str);
    /// Canal `pty://exit/{id}`.
    fn emit_exit(&self, id: &str, payload: &PtyExitPayload);
    /// Canal ÚNICO `resource://pty-suspended` (ID no payload).
    fn emit_suspended(&self, payload: &PtySuspendedPayload);
}

/// Implementação Desktop — wrapper fino sobre o `app.emit()` do Tauri.
pub struct TauriSink(pub tauri::AppHandle);

impl PtyOutputSink for TauriSink {
    fn emit_data(&self, id: &str, text: &str) {
        let channel = format!("pty://data/{id}");
        let _ = self.0.emit(&channel, text);
    }

    fn emit_activity(&self, id: &str, text: &str) {
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
}
