//! Owns a Chromium-family browser that automation tools drive over the DevTools protocol.
//!
//! Playwright MCP can either launch its own browser or attach to one that is already running via
//! `--cdp-endpoint`. Launching it here means the browser inherits the job object installed at
//! startup, so it dies with Alethe instead of outliving a crash, and its profile stays in the
//! active Alethe profile rather than the user's real one.

use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, State};

const PROFILE_SUBDIR: &str = "browser-session";
const READY_TIMEOUT: Duration = Duration::from_secs(20);
const READY_POLL: Duration = Duration::from_millis(150);

#[derive(Default)]
pub struct BrowserSessionState {
    session: Mutex<Option<BrowserSession>>,
    // Startup takes seconds, and the session slot is empty for all of them. Without a lock held
    // across the whole thing, every concurrent caller sees "no session" and launches its own
    // browser, so N agents starting together produced N browsers.
    starting: tokio::sync::Mutex<()>,
}

struct BrowserSession {
    child: Arc<Mutex<Child>>,
    info: BrowserSessionInfo,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSessionInfo {
    pub endpoint: String,
    pub port: u16,
    pub executable: String,
    pub profile_dir: String,
}

/// Candidates in preference order. The first that exists wins; an explicit path skips the search.
#[cfg(windows)]
fn browser_candidates() -> Vec<PathBuf> {
    let mut out = Vec::new();
    for root in [
        std::env::var_os("ProgramFiles"),
        std::env::var_os("ProgramFiles(x86)"),
        std::env::var_os("LOCALAPPDATA"),
    ]
    .into_iter()
    .flatten()
    {
        let root = PathBuf::from(root);
        out.push(root.join(r"Microsoft\Edge\Application\msedge.exe"));
        out.push(root.join(r"Google\Chrome\Application\chrome.exe"));
    }
    out
}

#[cfg(target_os = "macos")]
fn browser_candidates() -> Vec<PathBuf> {
    vec![
        PathBuf::from("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
        PathBuf::from("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"),
        PathBuf::from("/Applications/Chromium.app/Contents/MacOS/Chromium"),
    ]
}

#[cfg(all(unix, not(target_os = "macos")))]
fn browser_candidates() -> Vec<PathBuf> {
    [
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/usr/bin/microsoft-edge",
        "/snap/bin/chromium",
    ]
    .iter()
    .map(PathBuf::from)
    .collect()
}

fn resolve_browser(explicit: Option<String>) -> Result<PathBuf, String> {
    if let Some(path) = explicit.filter(|value| !value.trim().is_empty()) {
        let path = PathBuf::from(path);
        return if path.exists() {
            Ok(path)
        } else {
            Err("browser_not_found".to_string())
        };
    }
    browser_candidates()
        .into_iter()
        .find(|candidate| candidate.exists())
        .ok_or_else(|| "browser_not_found".to_string())
}

/// Asking the OS for port 0 and reading back what it assigned avoids guessing a free port.
fn free_port() -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|error| error.to_string())?;
    let port = listener
        .local_addr()
        .map_err(|error| error.to_string())?
        .port();
    drop(listener);
    Ok(port)
}

/// The pane is the window. Running headless is what keeps a second, loose browser window from
/// appearing next to it — screencast, input and Playwright all work the same either way.
pub fn browser_args(port: u16, profile_dir: &std::path::Path) -> Vec<String> {
    vec![
        format!("--remote-debugging-port={port}"),
        // A dedicated profile keeps this out of the user's real browser and, on Chrome, is what
        // makes the debugging port bind at all instead of handing off to a running instance.
        format!("--user-data-dir={}", profile_dir.display()),
        "--headless=new".to_string(),
        "--no-first-run".to_string(),
        "--no-default-browser-check".to_string(),
        // Occlusion tracking freezes rendering for a window Windows considers covered, which
        // would stop screencast frames if this ever runs headed.
        "--disable-features=Translate,CalculateNativeWinOcclusion".to_string(),
        "about:blank".to_string(),
    ]
}

pub fn endpoint_for(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

/// Chromium binds the debugging port only once the DevTools endpoint answers, so polling
/// `/json/version` is the readiness signal rather than merely waiting for the process to exist.
async fn wait_until_ready(port: u16) -> Result<(), String> {
    let url = format!("{}/json/version", endpoint_for(port));
    let deadline = Instant::now() + READY_TIMEOUT;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .map_err(|error| error.to_string())?;
    while Instant::now() < deadline {
        if let Ok(response) = client.get(&url).send().await {
            if response.status().is_success() {
                return Ok(());
            }
        }
        tokio::time::sleep(READY_POLL).await;
    }
    Err("browser_not_ready".to_string())
}

fn kill(session: BrowserSession) {
    if let Ok(mut child) = session.child.lock() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

fn take_session(state: &BrowserSessionState) -> Result<Option<BrowserSession>, String> {
    Ok(state
        .session
        .lock()
        .map_err(|_| "browser session lock poisoned")?
        .take())
}

/// A recorded session whose process already died is not a running session.
fn is_alive(session: &BrowserSession) -> bool {
    session
        .child
        .lock()
        .map(|mut child| matches!(child.try_wait(), Ok(None)))
        .unwrap_or(false)
}

#[tauri::command]
pub async fn browser_session_start(
    app: AppHandle,
    state: State<'_, BrowserSessionState>,
    executable: Option<String>,
) -> Result<BrowserSessionInfo, String> {
    let _starting = state.starting.lock().await;

    if let Some(existing) = take_session(&state)? {
        if is_alive(&existing) {
            let info = existing.info.clone();
            state
                .session
                .lock()
                .map_err(|_| "browser session lock poisoned")?
                .replace(existing);
            return Ok(info);
        }
        kill(existing);
    }

    let binary = resolve_browser(executable)?;
    let profile_dir = crate::paths::profile_data_dir(&app)?.join(PROFILE_SUBDIR);
    std::fs::create_dir_all(&profile_dir).map_err(|error| format!("profile_dir:{error}"))?;
    kill_stale_sessions(&profile_dir);
    let port = free_port()?;

    let mut command = Command::new(&binary);
    command
        .args(browser_args(port, &profile_dir))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    crate::git_control::hide_console(&mut command);

    let child = command
        .spawn()
        .map_err(|error| format!("browser_spawn_failed:{error}"))?;
    let child = Arc::new(Mutex::new(child));

    let info = BrowserSessionInfo {
        endpoint: endpoint_for(port),
        port,
        executable: binary.to_string_lossy().into_owned(),
        profile_dir: profile_dir.to_string_lossy().into_owned(),
    };

    let session = BrowserSession {
        child: Arc::clone(&child),
        info: info.clone(),
    };

    if let Err(error) = wait_until_ready(port).await {
        kill(session);
        return Err(error);
    }

    state
        .session
        .lock()
        .map_err(|_| "browser session lock poisoned")?
        .replace(session);
    Ok(info)
}

/// Chromium deliberately breaks away from the job object that ties every other child process to
/// Alethe, so the browser outlives a crash unless it is torn down explicitly.
pub fn kill_running_session(state: &BrowserSessionState) {
    if let Ok(mut guard) = state.session.lock() {
        if let Some(session) = guard.take() {
            kill(session);
        }
    }
}

/// A browser left behind by a previous run still holds the profile directory, which stops the next
/// one from ever binding its debugging port.
pub fn kill_stale_sessions(profile_dir: &std::path::Path) {
    let marker = profile_dir.to_string_lossy().to_lowercase();
    if marker.is_empty() {
        return;
    }
    let mut system = sysinfo::System::new();
    system.refresh_processes(sysinfo::ProcessesToUpdate::All);
    for process in system.processes().values() {
        if !is_browser_executable(process.name()) {
            continue;
        }
        let command = process.cmd().join(std::ffi::OsStr::new(" "));
        if command.to_string_lossy().to_lowercase().contains(&marker) {
            process.kill();
        }
    }
}

/// Matching on the command line alone would also match a shell, an editor or an agent that merely
/// mentions the profile path, and killing those would be catastrophic.
fn is_browser_executable(name: &std::ffi::OsStr) -> bool {
    // Matched loosely on purpose: the same browser ships as chrome.exe, google-chrome,
    // google-chrome-stable, chromium-browser and microsoft-edge depending on the platform, and a
    // prefix match would recognise only the Windows spelling. Pairing this with the profile path
    // the caller already requires is what keeps it from reaching anything else.
    let name = name.to_string_lossy().to_lowercase();
    ["chrome", "chromium", "edge", "brave"]
        .iter()
        .any(|candidate| name.contains(candidate))
}

#[tauri::command]
pub fn browser_session_stop(state: State<'_, BrowserSessionState>) -> Result<(), String> {
    if let Some(session) = take_session(&state)? {
        kill(session);
    }
    Ok(())
}

#[tauri::command]
pub fn browser_session_status(
    state: State<'_, BrowserSessionState>,
) -> Result<Option<BrowserSessionInfo>, String> {
    let mut guard = state
        .session
        .lock()
        .map_err(|_| "browser session lock poisoned")?;
    let alive = guard.as_ref().map(is_alive).unwrap_or(false);
    if !alive {
        if let Some(dead) = guard.take() {
            kill(dead);
        }
        return Ok(None);
    }
    Ok(guard.as_ref().map(|session| session.info.clone()))
}

pub fn mcp_server_spec(endpoint: &str) -> serde_json::Value {
    mcp_server_spec_for(Some(endpoint))
}

pub fn mcp_server_spec_for(endpoint: Option<&str>) -> serde_json::Value {
    let mut args = vec!["-y".to_string(), "@playwright/mcp@latest".to_string()];
    if let Some(endpoint) = endpoint {
        args.push("--cdp-endpoint".to_string());
        args.push(endpoint.to_string());
    }
    serde_json::json!({ "command": "npx", "args": args })
}

/// Mirrors `graphify_mcp_config_path`: an ephemeral config Claude is pointed at with `--mcp-config`.
#[tauri::command]
pub fn playwright_mcp_config_path(state: State<'_, BrowserSessionState>) -> Result<String, String> {
    let info = state
        .session
        .lock()
        .map_err(|_| "browser session lock poisoned")?
        .as_ref()
        .filter(|session| is_alive(session))
        .map(|session| session.info.clone());

    // Spawning an agent must never launch a browser. When one is already running the agent is
    // pointed at it so both act on the same tabs; otherwise Playwright keeps its own default,
    // which only opens a browser once the agent actually reaches for one.
    let endpoint = info.as_ref().map(|info| info.endpoint.as_str());
    let config = serde_json::json!({
        "mcpServers": { "playwright": mcp_server_spec_for(endpoint) }
    });
    let suffix = info
        .as_ref()
        .map(|info| info.port.to_string())
        .unwrap_or_else(|| "standalone".to_string());
    let path = std::env::temp_dir().join(format!("alethe-playwright-mcp-{suffix}.json"));
    let body = serde_json::to_string_pretty(&config).map_err(|error| error.to_string())?;
    std::fs::write(&path, body).map_err(|error| format!("write_failed:{error}"))?;
    Ok(path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_is_loopback_only() {
        assert_eq!(endpoint_for(9333), "http://127.0.0.1:9333");
        assert!(
            !endpoint_for(9333).contains("0.0.0.0"),
            "the debugging port must never be advertised on a routable address"
        );
    }

    #[test]
    fn free_port_returns_a_usable_port() {
        let port = free_port().expect("a free port");
        assert!(port > 0);
        TcpListener::bind(("127.0.0.1", port)).expect("the reported port must be bindable");
    }

    #[test]
    fn mcp_spec_points_playwright_at_the_running_browser() {
        let spec = mcp_server_spec("http://127.0.0.1:1234");
        let args = spec["args"].as_array().expect("args");
        let flags: Vec<&str> = args.iter().filter_map(|value| value.as_str()).collect();
        assert!(flags.contains(&"--cdp-endpoint"));
        assert!(flags.contains(&"http://127.0.0.1:1234"));
        assert_eq!(spec["command"], "npx");
    }

    #[test]
    fn spawning_an_agent_without_a_browser_does_not_demand_one() {
        // Starting an agent used to launch a browser just to fill in --cdp-endpoint, so every
        // terminal opened a window and concurrent spawns opened several.
        let spec = mcp_server_spec_for(None);
        let args: Vec<&str> = spec["args"]
            .as_array()
            .expect("args")
            .iter()
            .filter_map(|value| value.as_str())
            .collect();
        assert!(
            !args.contains(&"--cdp-endpoint"),
            "with no browser running the agent must fall back to Playwright's own default"
        );
        assert_eq!(args, vec!["-y", "@playwright/mcp@latest"]);
    }

    #[test]
    fn a_running_browser_is_shared_with_the_agent() {
        let spec = mcp_server_spec_for(Some("http://127.0.0.1:4321"));
        let args: Vec<&str> = spec["args"]
            .as_array()
            .expect("args")
            .iter()
            .filter_map(|value| value.as_str())
            .collect();
        assert!(args.contains(&"--cdp-endpoint"));
        assert!(args.contains(&"http://127.0.0.1:4321"));
    }

    #[test]
    fn only_browsers_are_ever_reaped() {
        use std::ffi::OsStr;
        // Every spelling the same browser ships under. A prefix match recognised only the first
        // three, so on Linux a leftover browser was never cleared and kept its profile locked.
        for browser in [
            "chrome.exe",
            "msedge.exe",
            "chromium",
            "google-chrome",
            "google-chrome-stable",
            "chromium-browser",
            "microsoft-edge",
            "brave-browser",
        ] {
            assert!(
                is_browser_executable(OsStr::new(browser)),
                "{browser} is a browser and has to be reapable"
            );
        }
        // A shell or an agent can carry the profile path in its command line; killing one because
        // of that would take a terminal, or the app itself, down with it.
        for innocent in [
            "pwsh.exe",
            "cmd.exe",
            "node.exe",
            "claude.exe",
            "alethe.exe",
            "code.exe",
        ] {
            assert!(
                !is_browser_executable(OsStr::new(innocent)),
                "{innocent} must never be reaped"
            );
        }
    }

    #[test]
    fn the_shared_browser_opens_no_window_of_its_own() {
        let args = browser_args(9333, std::path::Path::new("C:/profile"));
        assert!(
            args.iter().any(|arg| arg == "--headless=new"),
            "a visible window would sit next to the pane that is meant to be the only view"
        );
        assert!(args.iter().any(|arg| arg == "--remote-debugging-port=9333"));
        assert!(args
            .iter()
            .any(|arg| arg.starts_with("--user-data-dir=") && arg.contains("profile")));
    }

    #[test]
    fn an_explicit_missing_executable_is_rejected() {
        let error = resolve_browser(Some("/nonexistent/browser".into())).unwrap_err();
        assert_eq!(error, "browser_not_found");
    }

    #[test]
    fn a_blank_explicit_path_falls_back_to_discovery() {
        // Blank must not be treated as a path; it should behave like "no preference".
        let blank = resolve_browser(Some("   ".into()));
        let discovered = resolve_browser(None);
        assert_eq!(blank.is_ok(), discovered.is_ok());
    }
}
