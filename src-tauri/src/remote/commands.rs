//! Tauri command surface for LAN remote control preferences and pairing.

use std::sync::Arc;

use tauri::AppHandle;

use crate::pty::PtySessions;

use super::{
    hub, start, stop, RemoteInfo, TailscaleStatus, MAX_REMOTE_DEVICES, MAX_SESSION_EXPIRY_SECS,
    MIN_SESSION_EXPIRY_SECS,
};

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
    remote.set_max_devices(max_devices.clamp(1, MAX_REMOTE_DEVICES));
    remote.info()
}

#[tauri::command]
pub fn remote_control_set_session_expiry(session_expiry_secs: u64) -> RemoteInfo {
    let remote = hub();
    remote.set_session_expiry(
        session_expiry_secs.clamp(MIN_SESSION_EXPIRY_SECS, MAX_SESSION_EXPIRY_SECS),
    );
    remote.info()
}

#[tauri::command]
pub fn remote_control_set_read_only(read_only: bool) -> RemoteInfo {
    let remote = hub();
    remote.set_read_only(read_only);
    remote.info()
}

#[tauri::command]
pub fn remote_control_set_shell_input(allowed: bool) -> RemoteInfo {
    let remote = hub();
    remote.set_allow_shell_input(allowed);
    remote.info()
}

/// Never has a side effect — safe to poll from the UI to decide whether the
/// "Tailscale" reach mode should even be selectable.
#[tauri::command]
pub fn remote_control_tailscale_status() -> TailscaleStatus {
    let ip = super::util::tailscale_ip();
    TailscaleStatus {
        available: ip.is_some(),
        ip,
    }
}

#[tauri::command]
pub fn remote_control_set_reach_mode(
    app: AppHandle,
    sessions: tauri::State<'_, PtySessions>,
    use_tailscale: bool,
) -> RemoteInfo {
    let remote = hub();
    let changed = remote.use_tailscale() != use_tailscale;
    remote.set_use_tailscale(use_tailscale);
    if changed && remote.enabled() {
        // The listeners are bound to a specific host resolved at start() time;
        // flipping the flag alone would leave them on the old address, so a
        // live mode switch has to rebind through a full stop/start. Only do
        // this when the mode actually changed — this command is re-sent on
        // every preference sync, and restarting unconditionally would drop
        // paired devices and close the pairing window on unrelated changes
        // (read-only, shell input, max devices, ...).
        stop();
        start(app, Arc::clone(sessions.inner()));
    }
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
