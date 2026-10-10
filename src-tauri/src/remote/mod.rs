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

use std::net::TcpListener;
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
/// Photos from the phone are downscaled to JPEG before upload; this is only a ceiling.
const MAX_ATTACHMENT: usize = 4 * 1024 * 1024;
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

/// Turns remote control on for the enable request `request_id`. Returns
/// `Ok` without doing anything when a newer request has superseded this one
/// or the listeners are already up; the caller reads the resulting state
/// from [`RemoteHub::info`].
pub fn start(app: AppHandle, sessions: PtySessions, request_id: u64) -> Result<(), String> {
    let hub = hub();
    let _lifecycle = hub.lock_lifecycle().map_err(|_| lifecycle_unavailable())?;
    if !hub.control_request_is_current(request_id) || hub.enabled() {
        return Ok(());
    }
    start_locked(&hub, app, sessions, || {
        hub.control_request_is_current(request_id)
    })
}

/// Rebinds live listeners on the currently selected reach address. Does
/// nothing while remote control is off. On failure the hub stays off.
pub(crate) fn restart(app: AppHandle, sessions: PtySessions) -> Result<(), String> {
    let hub = hub();
    let _lifecycle = hub.lock_lifecycle().map_err(|_| lifecycle_unavailable())?;
    if !hub.enabled() {
        return Ok(());
    }
    hub.shutdown();
    start_locked(&hub, app, sessions, || true)
}

/// Turns remote control off for the disable request `request_id`, unless a
/// newer request has superseded it.
pub(crate) fn stop(request_id: u64) {
    let hub = hub();
    // A poisoned lifecycle lock must never keep the listeners up.
    let _lifecycle = hub.lock_lifecycle().ok();
    if !hub.control_request_is_current(request_id) {
        return;
    }
    hub.shutdown();
    eprintln!("[remote] LAN remote control disabled");
}

/// Shuts down from inside a listener thread (idle timeout, listener death).
/// Returns whether `generation` was still live and has now been shut down.
pub(crate) fn stop_generation(hub: &RemoteHub, generation: u64) -> bool {
    let _lifecycle = hub.lock_lifecycle().ok();
    let stopped = hub.fail_generation(generation);
    if stopped {
        eprintln!("[remote] LAN remote control disabled");
    }
    stopped
}

fn lifecycle_unavailable() -> String {
    "Remote control cannot start because its lifecycle lock is unavailable. Restart Alethe and try again."
        .to_string()
}

/// Binds both listeners and only then marks the hub enabled and hands each
/// listener to its thread. The caller must hold the lifecycle lock.
fn start_locked<F>(
    hub: &Arc<RemoteHub>,
    app: AppHandle,
    sessions: PtySessions,
    still_wanted: F,
) -> Result<(), String>
where
    F: Fn() -> bool,
{
    hub.refresh_host();
    let host = hub.host();
    if host.is_empty() {
        // `refresh_host` resolves to an empty host when Tailscale reach is
        // selected but no tailnet address is available.
        return Err(
            "Remote control could not find a Tailscale address to listen on. Make sure Tailscale is running, or switch the reach mode, then try again."
                .to_string(),
        );
    }
    let listeners = bind_remote_listeners(&host, util::bind_listener)?;
    if !still_wanted() {
        return Ok(());
    }
    let http_port = listeners
        .http
        .local_addr()
        .map_err(|_| {
            "Remote control could not inspect its HTTP listener. Restart Alethe and try again."
                .to_string()
        })?
        .port();
    let ws_port = listeners
        .websocket
        .local_addr()
        .map_err(|_| {
            "Remote control could not inspect its WebSocket listener. Restart Alethe and try again."
                .to_string()
        })?
        .port();
    let generation = hub.activate(http_port, ws_port);
    let BoundListeners { http, websocket } = listeners;

    let http_hub = Arc::clone(hub);
    let http_sessions = Arc::clone(&sessions);
    let http_app = app.clone();
    thread::spawn(move || http::run_http(http, http_app, http_hub, http_sessions, generation));

    let ws_hub = Arc::clone(hub);
    thread::spawn(move || websocket::run_websocket(websocket, app, ws_hub, sessions, generation));
    eprintln!("[remote] LAN client available at http://{host}:{http_port}");
    Ok(())
}

struct BoundListeners {
    http: TcpListener,
    websocket: TcpListener,
}

/// Binds and configures the HTTP and WebSocket listeners as a pair. If any
/// step fails, whatever was already bound is dropped (releasing its port)
/// and nothing is left listening.
fn bind_remote_listeners<F>(host: &str, mut bind: F) -> Result<BoundListeners, String>
where
    F: FnMut(&str, u16, u16) -> Option<TcpListener>,
{
    let http = bind(host, HTTP_START, HTTP_END).ok_or_else(|| {
        format!(
            "Remote control could not open an HTTP listener on local address {host} (ports {HTTP_START}-{HTTP_END}). Close another app using that range or change networks, then try again."
        )
    })?;
    let websocket = bind(host, HTTP_START + 1, HTTP_END + 1).ok_or_else(|| {
        format!(
            "Remote control could not open a WebSocket listener on local address {host} (ports {}-{}). Close another app using that range or change networks, then try again.",
            HTTP_START + 1,
            HTTP_END + 1
        )
    })?;
    http.set_nonblocking(true).map_err(|_| {
        "Remote control could not configure its HTTP listener. Restart Alethe and try again."
            .to_string()
    })?;
    websocket.set_nonblocking(true).map_err(|_| {
        "Remote control could not configure its WebSocket listener. Restart Alethe and try again."
            .to_string()
    })?;
    Ok(BoundListeners { http, websocket })
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

#[cfg(test)]
mod tests {
    use super::bind_remote_listeners;
    use std::cell::Cell;
    use std::net::TcpListener;

    #[test]
    fn listener_startup_rolls_back_when_the_second_bind_fails() {
        let calls = Cell::new(0);
        let first_address = Cell::new(None);

        let result = bind_remote_listeners("127.0.0.1", |_, _, _| {
            calls.set(calls.get() + 1);
            if calls.get() == 1 {
                let listener = TcpListener::bind(("127.0.0.1", 0)).expect("first listener");
                first_address.set(Some(listener.local_addr().expect("listener address")));
                Some(listener)
            } else {
                None
            }
        });

        let error = result.err().expect("WebSocket bind should fail");
        assert!(error.contains("WebSocket listener"));
        assert!(error.contains("try again"));
        TcpListener::bind(
            first_address
                .get()
                .expect("first address should be captured"),
        )
        .expect("the successful first listener must be dropped on rollback");
    }

    #[test]
    fn listener_startup_binds_and_configures_both_listeners() {
        let listeners = bind_remote_listeners("127.0.0.1", |_, _, _| {
            TcpListener::bind(("127.0.0.1", 0)).ok()
        })
        .expect("both listeners should bind");

        let http = listeners.http.local_addr().expect("HTTP address");
        let websocket = listeners.websocket.local_addr().expect("WebSocket address");
        assert_ne!(http.port(), 0);
        assert_ne!(websocket.port(), 0);
        assert_ne!(http.port(), websocket.port());
        // Both come back non-blocking, so an idle accept returns immediately.
        assert_eq!(
            listeners.http.accept().err().map(|error| error.kind()),
            Some(std::io::ErrorKind::WouldBlock)
        );
        assert_eq!(
            listeners.websocket.accept().err().map(|error| error.kind()),
            Some(std::io::ErrorKind::WouldBlock)
        );
    }
}
