//! LAN-only remote control for existing Alethe terminal sessions.
//!
//! The listener is off until the user turns it on. Pairing happens inside a
//! short-lived window: the QR carries a pairing token that is exchanged once
//! for a device-bound session token, and every later HTTP request and
//! WebSocket frame is authorized against that session. The remote surface is
//! read-mostly: it exposes workspace metadata and terminal output, and accepts
//! one complete prompt at a time. It never creates, deletes, or edits
//! workspace entities.
//!
//! Layout: [`state`] owns pairing/session state, [`http`] and [`websocket`]
//! run the two LAN listeners, [`commands`] is the Tauri command surface, and
//! [`appearance`], [`workspace`], [`pty_bridge`], [`util`] hold the pieces
//! those layers share.

mod appearance;
mod commands;
mod http;
mod pty_bridge;
mod state;
mod util;
mod websocket;
mod workspace;

use std::sync::{Arc, OnceLock};
use std::thread;
use std::time::Duration;

use tauri::AppHandle;

use crate::pty::PtySessions;

pub use commands::*;
#[allow(unused_imports)]
pub use state::{RemoteDeviceInfo, RemoteHub, RemoteInfo, TailscaleStatus};

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
/// Well above realistic human typing/tapping pace — this bounds a
/// compromised session token, not normal use.
const MESSAGE_RATE_LIMIT: u32 = 20;
const MESSAGE_RATE_WINDOW: Duration = Duration::from_secs(60);
/// Auto-disables the listeners after this long with zero paired devices, so
/// remote control can never be left silently exposed indefinitely.
const IDLE_DISABLE_SECS: u64 = 4 * 60 * 60;

static HUB: OnceLock<Arc<RemoteHub>> = OnceLock::new();

pub fn hub() -> Arc<RemoteHub> {
    HUB.get_or_init(|| Arc::new(RemoteHub::new())).clone()
}

pub fn start(app: AppHandle, sessions: PtySessions) {
    let hub = hub();
    if hub.begin_run() {
        return;
    }
    hub.refresh_host();
    hub.touch_activity();
    let generation = hub.next_generation();
    let http_hub = Arc::clone(&hub);
    let http_sessions = Arc::clone(&sessions);
    let http_app = app.clone();
    thread::spawn(move || http::run_http(http_app, http_hub, http_sessions, generation));

    let ws_hub = Arc::clone(&hub);
    let ws_sessions = Arc::clone(&sessions);
    let ws_app = app;
    thread::spawn(move || websocket::run_websocket(ws_app, ws_hub, ws_sessions, generation));
}

pub fn stop() {
    let hub = hub();
    hub.end_run();
    hub.next_generation();
    hub.reset_ports();
    hub.revoke_all();
    hub.close_pairing_window();
    eprintln!("[remote] LAN remote control disabled");
}

pub(crate) struct ConnectionGuard(Arc<RemoteHub>);

impl ConnectionGuard {
    pub(crate) fn acquire(hub: &Arc<RemoteHub>) -> Option<Self> {
        hub.try_acquire_connection(MAX_CONNECTIONS)
            .then(|| Self(Arc::clone(hub)))
    }
}

impl Drop for ConnectionGuard {
    fn drop(&mut self) {
        self.0.release_connection();
    }
}
