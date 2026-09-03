//! Reads scrollback from and writes prompts into live PTY sessions on behalf
//! of the remote HTTP/WebSocket handlers.

use std::io::Write;
use std::sync::Arc;

use crate::pty::PtySessions;

pub(crate) fn read_scrollback(sessions: &PtySessions, id: &str, max_bytes: usize) -> String {
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

pub(crate) fn read_pty_size(sessions: &PtySessions, id: &str) -> Option<(u16, u16)> {
    let master = {
        let sessions = sessions.lock().ok()?;
        Arc::clone(&sessions.get(id)?.master)
    };
    let master = master.lock().ok()?;
    let size = master.get_size().ok()?;
    Some((size.cols, size.rows))
}

pub(crate) fn write_remote(sessions: &PtySessions, id: &str, data: &str) -> Result<(), String> {
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
