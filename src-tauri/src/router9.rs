//! 9router — locally managed OpenAI/Anthropic-compatible proxy.
//!
//! Installed into a private prefix under the active profile so it never touches the global npm
//! tree, pinned to a known version, and started only on explicit user action. Nothing here runs
//! on its own: the app never installs, updates, or launches 9router without a click.

use std::fs::{self, OpenOptions};
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::AppHandle;

use crate::cli_resolver::{cli_version_at, find_windows_cli_launcher};
use crate::git_control::hide_console;
use crate::paths::profile_data_dir;

pub const PINNED_VERSION: &str = "0.5.59";
pub const DEFAULT_PORT: u16 = 20128;

const PACKAGE: &str = "9router";
const PORT_PROBE_TIMEOUT_MS: u64 = 400;

#[derive(Default)]
pub struct Router9Process(Mutex<Option<Child>>);

/// One place 9router can come from. `path` is set only for an install found on PATH.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Router9Install {
    installed: bool,
    version: Option<String>,
    path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Router9Status {
    /// The copy Alethe installed into its own profile folder.
    managed: Router9Install,
    /// A 9router the user installed themselves, resolved off PATH.
    external: Router9Install,
    /// The child this app started is still alive.
    running: bool,
    /// Something answers on the port. With `running` false this means another process owns it.
    port_in_use: bool,
    port: u16,
    install_dir: String,
    data_dir: String,
    log_path: String,
    dashboard_url: String,
    pinned_version: String,
}

/// Which install a start request should launch.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Router9Source {
    Managed,
    External,
}

impl Default for Router9Source {
    fn default() -> Self {
        Self::Managed
    }
}

fn external_install() -> Router9Install {
    let Some(path) = find_windows_cli_launcher(PACKAGE) else {
        return Router9Install::default();
    };
    Router9Install {
        installed: true,
        version: cli_version_at(&path),
        path: Some(path.to_string_lossy().into_owned()),
    }
}

fn install_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(profile_data_dir(app)?.join("tools").join(PACKAGE))
}

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(profile_data_dir(app)?.join("tools").join("9router-data"))
}

fn log_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(profile_data_dir(app)?.join("9router.log"))
}

fn entry_script(dir: &Path) -> PathBuf {
    dir.join("node_modules").join(PACKAGE).join("cli.js")
}

fn installed_version(dir: &Path) -> Option<String> {
    let manifest = dir.join("node_modules").join(PACKAGE).join("package.json");
    let raw = fs::read_to_string(manifest).ok()?;
    let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
    value
        .get("version")
        .and_then(|v| v.as_str())
        .map(|v| v.to_string())
}

fn port_in_use(port: u16) -> bool {
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    TcpStream::connect_timeout(&addr, Duration::from_millis(PORT_PROBE_TIMEOUT_MS)).is_ok()
}

fn quote(path: &Path) -> String {
    format!("\"{}\"", path.to_string_lossy())
}

fn child_alive(slot: &mut Option<Child>) -> bool {
    let Some(child) = slot.as_mut() else {
        return false;
    };
    match child.try_wait() {
        Ok(None) => true,
        _ => {
            *slot = None;
            false
        }
    }
}

#[cfg(windows)]
fn kill_tree(pid: u32) {
    let mut command = Command::new("taskkill");
    command.args(["/T", "/F", "/PID", &pid.to_string()]);
    hide_console(&mut command);
    let _ = command.status();
}

#[cfg(not(windows))]
fn kill_tree(_pid: u32) {}

/// Best-effort teardown used both by the command and by app exit.
pub fn stop_managed(state: &Router9Process) {
    let Ok(mut slot) = state.0.lock() else {
        return;
    };
    if let Some(mut child) = slot.take() {
        kill_tree(child.id());
        let _ = child.kill();
        let _ = child.wait();
    }
}

#[tauri::command]
pub fn router9_status(
    app: AppHandle,
    state: tauri::State<'_, Router9Process>,
    port: Option<u16>,
) -> Result<Router9Status, String> {
    let port = port.unwrap_or(DEFAULT_PORT);
    let dir = install_dir(&app)?;
    let version = installed_version(&dir);
    let running = state
        .0
        .lock()
        .map(|mut slot| child_alive(&mut slot))
        .unwrap_or(false);

    Ok(Router9Status {
        managed: Router9Install {
            installed: version.is_some(),
            version,
            path: None,
        },
        external: external_install(),
        running,
        port_in_use: port_in_use(port),
        port,
        install_dir: dir.to_string_lossy().into_owned(),
        data_dir: data_dir(&app)?.to_string_lossy().into_owned(),
        log_path: log_path(&app)?.to_string_lossy().into_owned(),
        dashboard_url: format!("http://127.0.0.1:{port}/dashboard"),
        pinned_version: PINNED_VERSION.to_string(),
    })
}

/// The exact shell line the install PTY runs. Built here so the pinned version and the private
/// prefix have a single source of truth; the frontend never composes it.
#[tauri::command]
pub fn router9_install_command(app: AppHandle) -> Result<String, String> {
    let dir = install_dir(&app)?;
    fs::create_dir_all(&dir).map_err(|e| format!("create_dir_failed:{e}"))?;
    Ok(format!(
        "npm install --prefix {} {}@{}",
        quote(&dir),
        PACKAGE,
        PINNED_VERSION
    ))
}

#[tauri::command]
pub fn router9_uninstall_command(app: AppHandle) -> Result<String, String> {
    let dir = install_dir(&app)?;
    Ok(format!(
        "npm uninstall --prefix {} {}",
        quote(&dir),
        PACKAGE
    ))
}

#[tauri::command]
pub fn router9_start(
    app: AppHandle,
    state: tauri::State<'_, Router9Process>,
    port: Option<u16>,
    source: Option<Router9Source>,
) -> Result<(), String> {
    let port = port.unwrap_or(DEFAULT_PORT);
    let source = source.unwrap_or_default();
    let mut slot = state.0.lock().map_err(|_| "lock_poisoned".to_string())?;
    if child_alive(&mut slot) {
        return Ok(());
    }
    if port_in_use(port) {
        return Err("port_in_use".to_string());
    }

    let dir = install_dir(&app)?;
    let log = log_path(&app)?;
    if let Some(parent) = log.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create_dir_failed:{e}"))?;
    }
    let out = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log)
        .map_err(|e| format!("log_open_failed:{e}"))?;
    let err = out.try_clone().map_err(|e| format!("log_open_failed:{e}"))?;

    let mut command = match source {
        Router9Source::Managed => {
            let script = entry_script(&dir);
            if !script.is_file() {
                return Err("not_installed".to_string());
            }
            let node = which::which("node").map_err(|_| "node_not_found".to_string())?;
            let data = data_dir(&app)?;
            fs::create_dir_all(&data).map_err(|e| format!("create_dir_failed:{e}"))?;
            let mut command = Command::new(node);
            // The managed copy keeps its data beside the profile so it never shares state with an
            // install the user maintains themselves.
            command.arg(&script).current_dir(&dir).env("DATA_DIR", &data);
            command
        }
        Router9Source::External => {
            let bin = find_windows_cli_launcher(PACKAGE).ok_or("not_installed")?;
            // No DATA_DIR override: the user's own install keeps using its own configuration.
            Command::new(bin)
        }
    };

    command
        .env("PORT", port.to_string())
        .env("NEXT_PUBLIC_BASE_URL", format!("http://127.0.0.1:{port}"))
        // 9router serves a Next.js app, which binds 0.0.0.0 unless HOSTNAME says otherwise. Alethe
        // only ever routes over loopback, so the listener must not be reachable from the LAN.
        .env("HOSTNAME", "127.0.0.1")
        .stdin(Stdio::null())
        .stdout(Stdio::from(out))
        .stderr(Stdio::from(err));
    hide_console(&mut command);

    let child = command.spawn().map_err(|e| format!("spawn_failed:{e}"))?;
    *slot = Some(child);
    Ok(())
}

#[tauri::command]
pub fn router9_stop(state: tauri::State<'_, Router9Process>) -> Result<(), String> {
    stop_managed(state.inner());
    Ok(())
}
