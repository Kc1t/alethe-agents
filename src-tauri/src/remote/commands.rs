//! Tauri command surface for LAN remote control preferences and pairing.

use std::sync::Arc;

use tauri::AppHandle;

use crate::pty::PtySessions;

use super::{
    hub, restart, start, stop, RemoteInfo, TailscaleStatus, MAX_REMOTE_DEVICES,
    MAX_SESSION_EXPIRY_SECS, MIN_SESSION_EXPIRY_SECS,
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

/// Sets the PIN that guards remembered devices, or clears it (which also
/// forgets every remembered device).
#[tauri::command]
pub fn remote_control_set_pin(pin: Option<String>) -> Result<RemoteInfo, String> {
    let remote = hub();
    remote.set_pin(pin.as_deref())?;
    Ok(remote.info())
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
) -> Result<RemoteInfo, String> {
    let remote = hub();
    let changed = remote.use_tailscale() != use_tailscale;
    remote.set_use_tailscale(use_tailscale);
    if changed {
        // The listeners are bound to a specific host resolved at start time;
        // flipping the flag alone would leave them on the old address, so a
        // live mode switch has to rebind through a full stop/start. Only do
        // this when the mode actually changed — this command is re-sent on
        // every preference sync, and restarting unconditionally would drop
        // paired devices and close the pairing window on unrelated changes
        // (read-only, shell input, max devices, ...). `restart` is a no-op
        // while remote control is off, and leaves it off if rebinding fails.
        restart(app, Arc::clone(sessions.inner()))?;
    }
    Ok(remote.info())
}

#[tauri::command]
pub fn remote_control_revoke_device(device_id: usize) -> RemoteInfo {
    let remote = hub();
    remote.revoke_device(device_id);
    remote.info()
}

/// `request_id` orders enable/disable requests: the newest id recorded is
/// authoritative, so an older request finishing late can never undo it. An
/// `Err` means the listeners could not be opened and remote control is off.
#[tauri::command]
pub fn remote_control_set_enabled(
    app: AppHandle,
    sessions: tauri::State<'_, PtySessions>,
    enabled: bool,
    request_id: u64,
) -> Result<RemoteInfo, String> {
    let remote = hub();
    remote.record_control_request(request_id);
    if enabled {
        start(app, Arc::clone(sessions.inner()), request_id)?;
    } else {
        stop(request_id);
    }
    Ok(remote.info())
}
