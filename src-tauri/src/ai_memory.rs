//! ai-memory: long-term memory for the agents Alethe launches.
//!
//! Two halves. The older one answers queries: `ai_memory_detect` finds the binary and health-checks
//! its loopback endpoint, and the three config writers register its MCP server per agent — Claude
//! through an ephemeral `--mcp-config` so nothing is left pointing at a dead endpoint, Codex and
//! OpenCode through config files in the repository. `useXtermSession` calls them at launch.
//!
//! The newer one manages the service itself — which release to fetch for this machine, and the
//! `serve` child — shaped after `router9.rs`, which does the same job for 9router.

pub const AI_MEMORY_VERSION: &str = "2.4.0";
const RELEASES: &str = "https://github.com/akitaonrails/ai-memory/releases/download";

/// Sized for what ai-memory actually is: a ~46 MB binary plus hook scripts, with room to grow.
/// Generous next to a plugin's limits, and still nowhere near unbounded.
pub const MAX_DOWNLOAD_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_UNPACKED_BYTES: u64 = 192 * 1024 * 1024;
pub const MAX_ENTRIES: usize = 4_000;

#[derive(Debug, Clone, PartialEq)]
pub struct ReleaseAsset {
    pub file: String,
    pub url: String,
    pub sha256_url: String,
}

/// The asset for this machine, or `None` when upstream publishes no build for it.
///
/// Windows on ARM is the real case: every other platform Alethe supports has one.
pub fn release_asset(os: &str, arch: &str) -> Option<ReleaseAsset> {
    let file = match (os, arch) {
        ("windows", "x86_64") => "ai-memory-windows-x86_64.zip",
        ("linux", "x86_64") => "ai-memory-linux-x86_64.tar.gz",
        ("linux", "aarch64") => "ai-memory-linux-aarch64.tar.gz",
        ("macos", "x86_64") => "ai-memory-macos-x86_64.tar.gz",
        ("macos", "aarch64") => "ai-memory-macos-aarch64.tar.gz",
        _ => return None,
    };
    let url = format!("{RELEASES}/v{AI_MEMORY_VERSION}/{file}");
    Some(ReleaseAsset {
        file: file.to_string(),
        sha256_url: format!("{url}.sha256"),
        url,
    })
}

use std::net::{TcpStream, ToSocketAddrs};
use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tauri::AppHandle;

use crate::git_control::{hide_console, repository_root};
use crate::paths::profile_data_dir;

const DEFAULT_COMMAND: &str = "ai-memory";

/// Used for the "is it running" health-check.
const DEFAULT_ENDPOINT: &str = "127.0.0.1:49374";

const MCP_KEY: &str = "ai-memory";

pub fn binary_name() -> &'static str {
    if cfg!(windows) {
        "ai-memory.exe"
    } else {
        "ai-memory"
    }
}

pub fn install_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(profile_data_dir(app)?.join("tools").join("ai-memory"))
}

/// The copy Alethe installed, if it is there.
pub fn managed_binary(app: &AppHandle) -> Option<String> {
    let path = install_dir(app).ok()?.join(binary_name());
    path.is_file().then(|| path.to_string_lossy().to_string())
}

/// Which binary to run: what the caller asked for, else the managed copy by full path, else the
/// bare name for `PATH` to resolve.
///
/// The managed copy lives in the profile folder, so it has to travel as a path — the bare name
/// would not resolve for the agents the config writers hand it to.
pub fn pick_command(managed: Option<String>, explicit: Option<String>) -> String {
    explicit
        .or(managed)
        .unwrap_or_else(|| DEFAULT_COMMAND.to_string())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiMemoryStatus {
    installed: bool,
    /// The server answers on the loopback endpoint.
    running: bool,
    command: String,
    endpoint: String,
    version: Option<String>,
    /// This is the copy Alethe installed, not one found on `PATH`.
    managed: bool,
    /// Upstream publishes a build for this machine. False on Windows ARM64.
    supported: bool,
    /// The server behind `endpoint`, if one is running, is the child Alethe itself started.
    ///
    /// This has to come from the tracked child handle, not from anything a screen remembers: the
    /// handle outlives any particular window being open, while a frontend flag does not survive the
    /// panel unmounting. Without it, reopening Preferences after starting ai-memory and closing the
    /// dialog would forget that Alethe owns the process and hide the Stop button for a server it is
    /// still running.
    ours: bool,
}

fn short_hash(input: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    input.hash(&mut hasher);
    format!("{:x}", hasher.finish())
}

/// The loopback URL an agent's MCP client should reach ai-memory's server on.
fn mcp_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}/mcp")
}

/// Claude's MCP registration for ai-memory: the loopback HTTP endpoint `serve` binds, not a `mcp`
/// subcommand — there isn't one. Upstream's CLI (`crates/ai-memory-cli/src/cli.rs`) offers `serve`,
/// `install-mcp` and `mcp-bridge`; the only other `Mcp` token is a value of `uninstall --only`. This
/// mirrors what `install-mcp` itself recommends, and only answers once `ai-memory serve` is actually
/// running — before that, an agent reaching for it sees a connection refused, the same as any other
/// MCP server pointed at a port nothing is listening on yet.
fn mcp_server_spec(port: u16) -> Value {
    serde_json::json!({
        "type": "http",
        "url": mcp_url(port),
    })
}

/// OpenCode's shape for the same HTTP registration: a "remote" server entry, not a spawned command.
fn opencode_mcp_entry(port: u16) -> Value {
    serde_json::json!({
        "type": "remote",
        "url": mcp_url(port),
        "enabled": true,
    })
}

/// Codex's `[mcp_servers.<name>]` block for the same HTTP registration: a bare `url`, no `command`
/// or `args` to spawn.
fn codex_mcp_block(port: u16) -> String {
    format!("[mcp_servers.{MCP_KEY}]\nurl = \"{}\"\n", mcp_url(port))
}

/// Detects whether ai-memory is installed and reachable, and what kind of copy it is.
///
/// `installed` comes from running `--version`; `running` from the loopback health check below, so a
/// copy that is installed but not started yet is reported as exactly that, not as a detection
/// failure.
#[tauri::command]
pub fn ai_memory_detect(
    app: AppHandle,
    state: tauri::State<'_, AiMemoryProcess>,
    command: Option<String>,
) -> Result<AiMemoryStatus, String> {
    let managed = managed_binary(&app);
    let cmd = pick_command(managed.clone(), command);

    let mut probe = Command::new(&cmd);
    probe.arg("--version");
    hide_console(&mut probe);
    let (installed, version) = match probe.output() {
        Ok(output) if output.status.success() => {
            let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
            (true, (!version.is_empty()).then_some(version))
        }
        _ => (false, None),
    };

    let running = endpoint_alive(DEFAULT_ENDPOINT);
    // Same aliveness check `ai_memory_start` uses to decide a tracked child is still running. A
    // poisoned lock means we cannot claim the server is ours, so `false`.
    let ours = state
        .0
        .lock()
        .map(|mut guard| matches!(guard.as_mut().map(|child| child.try_wait()), Some(Ok(None))))
        .unwrap_or(false);

    Ok(AiMemoryStatus {
        installed,
        running,
        managed: managed.as_deref() == Some(cmd.as_str()),
        supported: release_asset(std::env::consts::OS, std::env::consts::ARCH).is_some(),
        command: cmd,
        endpoint: DEFAULT_ENDPOINT.to_string(),
        version,
        ours,
    })
}

fn endpoint_alive(endpoint: &str) -> bool {
    let Ok(mut addrs) = endpoint.to_socket_addrs() else {
        return false;
    };
    addrs.any(|addr| TcpStream::connect_timeout(&addr, Duration::from_millis(250)).is_ok())
}

#[tauri::command]
pub fn ai_memory_mcp_config_path(repo: String) -> Result<String, String> {
    let root = repository_root(&repo)?;
    let config = serde_json::json!({
        "mcpServers": { (MCP_KEY): mcp_server_spec(DEFAULT_PORT) }
    });
    let file_name = format!(
        "alethe-ai-memory-mcp-{}.json",
        short_hash(&root.to_string_lossy())
    );
    let path = std::env::temp_dir().join(file_name);
    let body = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    std::fs::write(&path, body).map_err(|e| format!("write_failed:{e}"))?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn ai_memory_opencode_config_write(repo: String) -> Result<(), String> {
    let _guard = crate::provider_common::opencode_json_lock()
        .lock()
        .map_err(|_| "opencode.json lock poisoned".to_string())?;
    let root = repository_root(&repo)?;
    let path = root.join("opencode.json");

    let mut config: serde_json::Map<String, Value> = if path.is_file() {
        let raw = std::fs::read_to_string(&path).map_err(|e| format!("read_failed:{e}"))?;
        match serde_json::from_str::<Value>(&raw) {
            Ok(Value::Object(map)) => map,

            _ => return Ok(()),
        }
    } else {
        let mut map = serde_json::Map::new();
        map.insert(
            "$schema".to_string(),
            Value::String("https://opencode.ai/config.json".to_string()),
        );
        map
    };

    let mcp = config
        .entry("mcp".to_string())
        .or_insert_with(|| Value::Object(serde_json::Map::new()));
    if let Value::Object(mcp_map) = mcp {
        mcp_map.insert(MCP_KEY.to_string(), opencode_mcp_entry(DEFAULT_PORT));
    }

    let body = serde_json::to_string_pretty(&Value::Object(config)).map_err(|e| e.to_string())?;
    std::fs::write(&path, body).map_err(|e| format!("write_failed:{e}"))
}

#[tauri::command]
pub fn ai_memory_codex_config_write(repo: String) -> Result<(), String> {
    let root = repository_root(&repo)?;
    let codex_dir = root.join(".codex");
    std::fs::create_dir_all(&codex_dir).map_err(|e| format!("mkdir_failed:{e}"))?;
    let path = codex_dir.join("config.toml");

    let existing = if path.is_file() {
        std::fs::read_to_string(&path).map_err(|e| format!("read_failed:{e}"))?
    } else {
        String::new()
    };

    let header = format!("[mcp_servers.{MCP_KEY}]");
    // The pre-fix writer quoted the key (`[mcp_servers."ai-memory"]`), which is unnecessary — a bare
    // `ai-memory` is a valid TOML key — but still has to be recognised and stripped here too, so an
    // upgrade replaces the old `command`/`args` section instead of leaving it behind next to the new
    // `url` one.
    let legacy_header = format!("[mcp_servers.\"{MCP_KEY}\"]");
    let mut kept_lines: Vec<&str> = Vec::new();
    let mut skipping = false;
    for line in existing.lines() {
        let trimmed = line.trim();
        if trimmed == header || trimmed == legacy_header {
            skipping = true;
            continue;
        }
        if skipping && trimmed.starts_with('[') {
            skipping = false;
        }
        if !skipping {
            kept_lines.push(line);
        }
    }
    let mut body = kept_lines.join("\n");
    if !body.is_empty() && !body.ends_with('\n') {
        body.push('\n');
    }

    body.push('\n');
    body.push_str(&codex_mcp_block(DEFAULT_PORT));

    std::fs::write(&path, body).map_err(|e| format!("write_failed:{e}"))
}

use std::io::Read;
use std::path::Path;

use crate::plugin_package::safe_entry_path;

/// Unpacks a `.tar.gz` release, refusing any entry whose path leaves `destination`.
///
/// The same rule `extract_zip` applies, through the same `safe_entry_path`: an archive from the
/// internet does not choose where its files land.
pub fn extract_tar_gz(bytes: &[u8], destination: &Path) -> Result<(), String> {
    extract_tar_gz_bounded(bytes, destination, MAX_ENTRIES, MAX_UNPACKED_BYTES)
}

/// Bounded variant of extract_tar_gz, with configurable limits for different callers.
/// Counts actual bytes written (not header claims) and refuses when entry count or
/// unpacked bytes exceed the limits.
pub fn extract_tar_gz_bounded(
    bytes: &[u8],
    destination: &Path,
    max_entries: usize,
    max_bytes: u64,
) -> Result<(), String> {
    let decoder = flate2::read::GzDecoder::new(bytes);
    let mut archive = tar::Archive::new(decoder);
    std::fs::create_dir_all(destination).map_err(|e| format!("mkdir_failed:{e}"))?;
    let mut entry_count: usize = 0;
    let mut written: u64 = 0;
    for entry in archive.entries().map_err(|e| format!("tar_read_failed:{e}"))? {
        entry_count += 1;
        if entry_count > max_entries {
            return Err("tar_too_many_entries".to_string());
        }
        let mut entry = entry.map_err(|e| format!("tar_read_failed:{e}"))?;
        let name = entry.path().map_err(|e| format!("tar_read_failed:{e}"))?;
        let target = destination.join(safe_entry_path(&name.to_string_lossy())?);
        if entry.header().entry_type().is_dir() {
            std::fs::create_dir_all(&target).map_err(|e| format!("mkdir_failed:{e}"))?;
            continue;
        }
        if !entry.header().entry_type().is_file() {
            return Err("tar_entry_not_a_file".to_string());
        }
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("mkdir_failed:{e}"))?;
        }
        let mut body = Vec::new();
        entry
            .read_to_end(&mut body)
            .map_err(|e| format!("tar_read_failed:{e}"))?;
        written = written.saturating_add(body.len() as u64);
        if written > max_bytes {
            return Err("tar_too_large".to_string());
        }
        std::fs::write(&target, &body).map_err(|e| format!("write_failed:{e}"))?;
    }
    Ok(())
}

use std::collections::HashMap;
use std::process::{Child, Stdio};
use std::sync::{mpsc, Mutex, OnceLock};

use crate::plugin_package::{download_bounded, extract_zip_bounded, is_sha256, verify_sha256};

pub const DEFAULT_PORT: u16 = 49374;

/// The published `.sha256` is `<hash>  <filename>`; only the hash is ours to use.
pub fn parse_sha256_file(body: &str) -> Option<String> {
    let first = body.split_whitespace().next()?.to_ascii_lowercase();
    is_sha256(&first).then_some(first)
}

#[derive(Debug, Default, Clone, Copy, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Counts {
    pub sessions: u64,
    pub observations: u64,
    pub pages: u64,
}

/// Reads the counts out of `ai-memory status`.
///
/// Anything unrecognised stays zero: an empty store prints no count lines, and that is a healthy
/// service with nothing in it, not a failure to report.
pub fn parse_counts(stdout: &str) -> Counts {
    let mut counts = Counts::default();
    for line in stdout.lines() {
        let Some((label, rest)) = line.trim().split_once(':') else { continue };
        let Some(value) = rest.trim().split_whitespace().next().and_then(|v| v.parse().ok()) else {
            continue;
        };
        match label.trim() {
            "sessions" => counts.sessions = value,
            "observations" => counts.observations = value,
            "pages" => counts.pages = value,
            _ => {}
        }
    }
    counts
}

/// The `ai-memory serve` child Alethe started, if any.
///
/// This is process-global — one child for the whole app — while the data directory it was launched
/// with (`managed_data_dir`) is per-profile. Switching profiles does not restart Alethe
/// (`ProfilesModal.tsx`'s `switchProfile` only re-hydrates the store from the new profile's
/// `projects.json`), so a server started under profile A keeps running, and keeps holding its port,
/// after a switch to profile B. Not fixed here — flagged so the next change to profile switching
/// accounts for it.
#[derive(Default)]
pub struct AiMemoryProcess(pub Mutex<Option<Child>>);

/// The data directory for a copy Alethe installed. A copy the person installed themselves keeps its
/// data where they put it, so this is never passed for one of those.
fn managed_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(profile_data_dir(app)?.join("ai-memory-data"))
}

/// The command to run and, only for a copy Alethe installed, the data directory to give it.
pub(crate) fn command_for(app: &AppHandle, explicit: Option<String>) -> (String, Option<String>) {
    let managed = managed_binary(app);
    let cmd = pick_command(managed.clone(), explicit);
    let data_dir = if managed.as_deref() == Some(cmd.as_str()) {
        managed_data_dir(app).ok().map(|d| d.to_string_lossy().to_string())
    } else {
        None
    };
    (cmd, data_dir)
}

pub(crate) fn base_command(cmd: &str, data_dir: Option<&str>) -> Command {
    let mut command = Command::new(cmd);
    if let Some(dir) = data_dir {
        command.arg("--data-dir").arg(dir);
    }
    hide_console(&mut command);
    command
}

/// One 3-second budget for waiting on `install-hooks` to answer.
const HOOK_CONFIG_TIMEOUT: Duration = Duration::from_secs(3);

/// `hook_config`'s answer per (command, data directory, port) — everything it actually depends on.
/// None of the three changes between terminal launches on their own, so it is safe to compute once
/// and reuse rather than shelling out to the CLI again on every capture-enabled launch.
///
/// Keying by port alone used to conflate two profiles that both use the default port: the resolved
/// command and `managed_data_dir` are per-profile, but switching profiles does not restart Alethe, so
/// a cache keyed only by port would keep handing a newly-opened terminal in profile B the hooks
/// generated for profile A — silently recording captures into the wrong store.
type HookConfigKey = (String, Option<String>, u16);

fn hook_config_cache() -> &'static Mutex<HashMap<HookConfigKey, Value>> {
    static CACHE: OnceLock<Mutex<HashMap<HookConfigKey, Value>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Drops every cached `hook_config` answer.
///
/// An install changes which binary `pick_command` resolves to, and its data directory with it, so a
/// cached entry generated from the old copy would keep sending capture to a store the panel is no
/// longer reading. Clears the whole map rather than one entry: the binary changed, so every entry is
/// stale regardless of which key it was stored under.
pub(crate) fn invalidate_hook_config_cache() {
    if let Ok(mut cache) = hook_config_cache().lock() {
        cache.clear();
    }
}

/// The `hooks` object `install-hooks` prints for claude-code.
///
/// Never `--apply`: Alethe writes these into its own per-terminal file, not into the person's
/// settings. `Command::output()` cannot time out, and a wedged or very slow binary must not hang a
/// terminal launch, so the wait happens on its own thread with a fixed budget; the child is killed
/// either way once that budget is up.
pub fn hook_config(app: &AppHandle, port: u16) -> Result<Value, String> {
    let (cmd, data_dir) = command_for(app, None);
    let key: HookConfigKey = (cmd.clone(), data_dir.clone(), port);
    if let Some(cached) = hook_config_cache().lock().ok().and_then(|cache| cache.get(&key).cloned())
    {
        return Ok(cached);
    }

    let mut child = base_command(&cmd, data_dir.as_deref())
        .arg("install-hooks")
        .arg("--agent")
        .arg("claude-code")
        .arg("--server-url")
        .arg(format!("http://127.0.0.1:{port}"))
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("ai_memory_install_hooks:{e}"))?;
    let mut child_stdout = child
        .stdout
        .take()
        .ok_or_else(|| "ai_memory_hooks_no_stdout".to_string())?;

    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = child_stdout.read_to_end(&mut bytes);
        let _ = tx.send(bytes);
    });
    let received = rx.recv_timeout(HOOK_CONFIG_TIMEOUT);
    // Reap the child whether it answered in time or not — a timed-out read must not leave it
    // running forever.
    let _ = child.kill();
    let _ = child.wait();
    let bytes = received.map_err(|_| "ai_memory_install_hooks_timeout".to_string())?;

    let stdout = String::from_utf8_lossy(&bytes);
    // The command prints comment lines before the JSON body.
    let start = stdout.find('{').ok_or_else(|| "ai_memory_hooks_no_json".to_string())?;
    let parsed: Value = serde_json::from_str(stdout[start..].trim())
        .map_err(|e| format!("ai_memory_hooks_bad_json:{e}"))?;
    let hooks = parsed
        .get("hooks")
        .cloned()
        .ok_or_else(|| "ai_memory_hooks_missing_key".to_string())?;

    if let Ok(mut cache) = hook_config_cache().lock() {
        cache.insert(key, hooks.clone());
    }
    Ok(hooks)
}

/// The hooks to merge, or `None` when consent is off or the binary is not there.
///
/// A failure here is not worth failing a terminal launch over: no hooks means no capture, and the
/// panel is where a person finds out why.
pub(crate) fn claude_hooks(app: &AppHandle, enabled: bool, port: u16) -> Option<Value> {
    if !enabled {
        return None;
    }
    hook_config(app, port).ok()
}

/// Runs after extraction, so a failure partway through — a cap tripped, a corrupt archive — leaves
/// nothing behind either. Without this, only the "binary missing" path cleaned up, and a plain
/// extraction error would leave whatever was written so far sitting in `dir`; harmless in practice,
/// since the next install removes `dir` first, but no failure path should rely on the next one.
fn cleanup_on_extract_failure(dir: &Path, result: Result<(), String>) -> Result<(), String> {
    if result.is_err() {
        let _ = std::fs::remove_dir_all(dir);
    }
    result
}

/// Downloads the asset for this platform, checks it against the hash the release publishes, and
/// unpacks it into the profile folder. Returns the path to the binary.
#[tauri::command]
pub async fn ai_memory_install(app: AppHandle) -> Result<String, String> {
    let asset = release_asset(std::env::consts::OS, std::env::consts::ARCH)
        .ok_or_else(|| "ai_memory_unsupported_platform".to_string())?;

    // The hash file is a line of text; the asset is tens of megabytes. Both go through the bounded
    // helpers with ai-memory's own caps — the plugin ones would refuse this download.
    let expected = parse_sha256_file(&String::from_utf8_lossy(
        &download_bounded(&asset.sha256_url, 4 * 1024).await?,
    ))
    .ok_or_else(|| "ai_memory_bad_hash_file".to_string())?;
    let bytes = download_bounded(&asset.url, MAX_DOWNLOAD_BYTES).await?;
    verify_sha256(&bytes, &expected)?;

    let dir = install_dir(&app)?;
    let _ = std::fs::remove_dir_all(&dir);
    let extraction = if asset.file.ends_with(".zip") {
        extract_zip_bounded(&bytes, &dir, MAX_ENTRIES, MAX_UNPACKED_BYTES)
    } else {
        extract_tar_gz(&bytes, &dir)
    };
    cleanup_on_extract_failure(&dir, extraction)?;

    let binary = dir.join(binary_name());
    if !binary.is_file() {
        let _ = std::fs::remove_dir_all(&dir);
        return Err("ai_memory_binary_missing".to_string());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&binary)
            .map_err(|e| format!("stat_failed:{e}"))?
            .permissions();
        perms.set_mode(perms.mode() | 0o755);
        std::fs::set_permissions(&binary, perms).map_err(|e| format!("chmod_failed:{e}"))?;
    }
    // The cached hook config names the binary it was generated from. An install changes which copy
    // `pick_command` resolves to, and its data directory with it, so the old entries would send
    // capture to a store the panel is no longer reading.
    invalidate_hook_config_cache();
    Ok(binary.to_string_lossy().to_string())
}

/// Reports the store's counts, or `None` when ai-memory could not answer.
///
/// `status` fetches `/admin/status` over HTTP: with the server unreachable it writes to stderr and
/// exits non-zero with empty stdout, which `parse_counts` cannot tell apart from a real, empty store.
/// The exit status is the only signal that distinguishes them, so it has to be checked here rather
/// than left for the parser — an unreachable server must read as "could not ask", not as zero.
#[tauri::command]
pub fn ai_memory_counts(app: AppHandle, command: Option<String>) -> Result<Option<Counts>, String> {
    let (cmd, data_dir) = command_for(&app, command);
    let output = base_command(&cmd, data_dir.as_deref())
        .arg("status")
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .map_err(|e| format!("ai_memory_status:{e}"))?;
    if !output.status.success() {
        return Ok(None);
    }
    Ok(Some(parse_counts(&String::from_utf8_lossy(&output.stdout))))
}

#[tauri::command]
pub fn ai_memory_start(
    app: AppHandle,
    state: tauri::State<'_, AiMemoryProcess>,
    port: Option<u16>,
) -> Result<(), String> {
    let port = port.unwrap_or(DEFAULT_PORT);
    let (cmd, data_dir) = command_for(&app, None);

    let mut guard = state.0.lock().map_err(|_| "ai_memory_lock".to_string())?;
    if let Some(child) = guard.as_mut() {
        if matches!(child.try_wait(), Ok(None)) {
            return Ok(());
        }
    }
    // Something else holds the endpoint — most likely the person's own instance. Starting anyway
    // would fail the bind and leave a dead child behind.
    if endpoint_alive(&format!("127.0.0.1:{port}")) {
        return Err("ai_memory_port_in_use".to_string());
    }

    let child = base_command(&cmd, data_dir.as_deref())
        .arg("serve")
        .arg("--transport")
        .arg("http")
        .arg("--bind")
        .arg(format!("127.0.0.1:{port}"))
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("ai_memory_spawn:{e}"))?;
    *guard = Some(child);
    Ok(())
}

/// Kills the child Alethe started, if there is one. Shared by the command and by app exit, so
/// quitting never leaves a server holding the port.
pub fn stop_managed(state: &AiMemoryProcess) {
    if let Ok(mut guard) = state.0.lock() {
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

#[tauri::command]
pub fn ai_memory_stop(state: tauri::State<'_, AiMemoryProcess>) -> Result<(), String> {
    stop_managed(state.inner());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // `hook_config` itself needs a real `AppHandle` (no mock-app pattern exists in this codebase),
    // so the process-spawning and timeout parts of it are verified by reading, not by a test here.
    // The cache it consults, however, is reachable on its own. All its properties are asserted in one
    // test, not several: `hook_config_cache()` is a single process-wide static, and cargo runs tests
    // in parallel by default, so a separate `invalidate_hook_config_cache` test clearing the whole map
    // could race a concurrent test's insert-then-read on a different key. One test means no
    // interleaving is possible.
    #[test]
    fn the_hook_config_cache_is_keyed_by_command_and_data_dir_and_persists_until_an_install_invalidates_it(
    ) {
        let profile_a: HookConfigKey =
            ("/profile-a/ai-memory".into(), Some("/profile-a/ai-memory-data".into()), 65001);
        // Same port as `profile_a`, different command and data directory: a cache keyed by port
        // alone would collide with the entry below and hand profile B's terminals profile A's hooks.
        let profile_b_same_port: HookConfigKey =
            ("/profile-b/ai-memory".into(), Some("/profile-b/ai-memory-data".into()), 65001);

        assert!(hook_config_cache().lock().unwrap().get(&profile_a).is_none());

        hook_config_cache()
            .lock()
            .unwrap()
            .insert(profile_a.clone(), serde_json::json!({ "Stop": [] }));
        hook_config_cache()
            .lock()
            .unwrap()
            .insert(profile_b_same_port.clone(), serde_json::json!({ "Stop": ["b"] }));

        // A fresh call to the accessor still sees both inserts: it is the same static map, and the
        // two profiles do not collide despite sharing a port.
        assert_eq!(
            hook_config_cache().lock().unwrap().get(&profile_a).cloned(),
            Some(serde_json::json!({ "Stop": [] })),
        );
        assert_eq!(
            hook_config_cache().lock().unwrap().get(&profile_b_same_port).cloned(),
            Some(serde_json::json!({ "Stop": ["b"] })),
        );

        // A real install calls this once the new binary is confirmed in place. Neither entry must
        // survive it: each was generated from whichever binary `pick_command` resolved to before the
        // install, which may no longer be the one it resolves to now.
        invalidate_hook_config_cache();
        assert!(
            hook_config_cache().lock().unwrap().get(&profile_a).is_none(),
            "the entry must not survive an install",
        );
        assert!(
            hook_config_cache().lock().unwrap().get(&profile_b_same_port).is_none(),
            "the entry must not survive an install",
        );
        assert!(
            hook_config_cache().lock().unwrap().is_empty(),
            "the whole map is cleared, not just these two entries",
        );
    }

    #[test]
    fn claude_gets_the_http_endpoint_not_a_nonexistent_mcp_subcommand() {
        let spec = mcp_server_spec(49374);
        assert_eq!(spec["type"], "http");
        assert_eq!(spec["url"], "http://127.0.0.1:49374/mcp");
        assert!(
            spec.get("args").is_none(),
            "ai-memory has no `mcp` subcommand to pass args to: {spec}"
        );
        assert!(spec.get("command").is_none(), "{spec}");
    }

    #[test]
    fn opencode_gets_a_remote_url_entry_not_a_command_array() {
        let entry = opencode_mcp_entry(49374);
        assert_eq!(entry["type"], "remote");
        assert_eq!(entry["url"], "http://127.0.0.1:49374/mcp");
        assert_eq!(entry["enabled"], true);
        assert!(entry.get("command").is_none(), "{entry}");
    }

    #[test]
    fn codex_gets_a_bare_url_under_its_own_unquoted_table_header() {
        let block = codex_mcp_block(49374);
        assert!(block.contains("[mcp_servers.ai-memory]"), "{block}");
        assert!(block.contains("url = \"http://127.0.0.1:49374/mcp\""), "{block}");
        assert!(!block.contains("command"), "{block}");
        assert!(!block.contains("args"), "{block}");
    }

    #[test]
    fn every_platform_alethe_supports_gets_the_matching_asset() {
        for (os, arch, expected) in [
            ("windows", "x86_64", "ai-memory-windows-x86_64.zip"),
            ("linux", "x86_64", "ai-memory-linux-x86_64.tar.gz"),
            ("linux", "aarch64", "ai-memory-linux-aarch64.tar.gz"),
            ("macos", "x86_64", "ai-memory-macos-x86_64.tar.gz"),
            ("macos", "aarch64", "ai-memory-macos-aarch64.tar.gz"),
        ] {
            let asset = release_asset(os, arch).unwrap_or_else(|| panic!("{os}/{arch}"));
            assert_eq!(asset.file, expected);
            assert!(asset.url.ends_with(expected), "{}", asset.url);
            assert_eq!(asset.sha256_url, format!("{}.sha256", asset.url));
            assert!(asset.url.starts_with("https://"), "{}", asset.url);
        }
    }

    #[test]
    fn a_machine_upstream_does_not_build_for_gets_no_asset() {
        // Windows on ARM: the release has no such build. Returning None is what lets the UI say so
        // instead of offering a button that downloads a 404.
        assert!(release_asset("windows", "aarch64").is_none());
        assert!(release_asset("freebsd", "x86_64").is_none());
    }

    #[test]
    fn an_explicit_command_always_wins() {
        // The caller named a binary; nothing may second-guess that.
        assert_eq!(
            pick_command(Some("/profile/ai-memory".into()), Some("/usr/bin/ai-memory".into())),
            "/usr/bin/ai-memory"
        );
        assert_eq!(pick_command(None, Some("/usr/bin/ai-memory".into())), "/usr/bin/ai-memory");
    }

    #[test]
    fn the_copy_alethe_installed_travels_as_a_full_path() {
        // It lives in the profile folder, which is not on PATH: handing the agent the bare name
        // would give it a command it cannot resolve, and memory would silently never work.
        assert_eq!(pick_command(Some("/profile/ai-memory".into()), None), "/profile/ai-memory");
    }

    #[test]
    fn with_nothing_installed_the_bare_name_is_tried() {
        // PATH may still hold one the person installed themselves.
        assert_eq!(pick_command(None, None), DEFAULT_COMMAND);
    }

    #[test]
    fn a_tarball_unpacks_and_refuses_an_entry_that_escapes() {
        use std::io::Write;

        fn tar_gz(entries: &[(&str, &[u8])]) -> Vec<u8> {
            let mut tar = tar::Builder::new(Vec::new());
            for (name, body) in entries {
                let mut header = tar::Header::new_gnu();
                header.set_size(body.len() as u64);
                header.set_mode(0o644);
                header.set_cksum();
                tar.append_data(&mut header, name, *body).unwrap();
            }
            let raw = tar.into_inner().unwrap();
            let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
            gz.write_all(&raw).unwrap();
            gz.finish().unwrap()
        }

        fn create_evil_tar_gz() -> Vec<u8> {
            let mut tar_bytes = Vec::new();
            let mut header = [0u8; 512];

            // Filename: ../escaped (null-terminated)
            let name = b"../escaped\0";
            header[..name.len()].copy_from_slice(name);

            // File mode: 0000644 (octal for regular file, rw-r--r--)
            "0000644\0".as_bytes().iter().enumerate().for_each(|(i, &b)| header[100 + i] = b);

            // Owner's UID: 0
            "0000000\0".as_bytes().iter().enumerate().for_each(|(i, &b)| header[108 + i] = b);

            // Group GID: 0
            "0000000\0".as_bytes().iter().enumerate().for_each(|(i, &b)| header[116 + i] = b);

            // File size: 4 (in octal: 000000000004)
            "000000000004".as_bytes().iter().enumerate().for_each(|(i, &b)| header[124 + i] = b);

            // Modification time (use a fixed value: 1234567890 in octal)
            "12345677720".as_bytes().iter().enumerate().for_each(|(i, &b)| header[136 + i] = b);

            // Checksum field (start at offset 148, 8 bytes, filled with spaces during calc)
            // Type flag (offset 156): '0' for regular file
            header[156] = b'0';

            // Calculate checksum (sum of all bytes, treating checksum field as spaces)
            let mut checksum = 0u32;
            for (i, &byte) in header.iter().enumerate() {
                if i >= 148 && i < 156 {
                    checksum += b' ' as u32;
                } else {
                    checksum += byte as u32;
                }
            }

            // Write checksum field in octal with trailing space and null
            let checksum_str = format!("{:06o} ", checksum);
            checksum_str.as_bytes().iter().take(8).enumerate().for_each(|(i, &b)| header[148 + i] = b);

            tar_bytes.extend_from_slice(&header);
            tar_bytes.extend_from_slice(b"nope");

            // Pad to 512-byte boundary
            while tar_bytes.len() % 512 != 0 {
                tar_bytes.push(0);
            }

            // Two zero blocks to mark end of archive
            tar_bytes.extend_from_slice(&[0; 1024]);

            // Gzip compress
            let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
            gz.write_all(&tar_bytes).unwrap();
            gz.finish().unwrap()
        }

        let dir = std::env::temp_dir().join(format!("alethe-aimem-tar-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);

        extract_tar_gz(&tar_gz(&[("ai-memory", b"binary")]), &dir).expect("a plain tarball unpacks");
        assert!(dir.join("ai-memory").is_file());

        let evil = create_evil_tar_gz();
        let err = extract_tar_gz(&evil, &dir).unwrap_err();
        assert!(err.contains("escaping_entry"), "path check fired: {err}");
        assert!(!dir.parent().unwrap().join("escaped").exists());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_tarball_with_too_many_entries_is_refused() {
        use std::io::Write;

        fn tar_gz(count: usize) -> Vec<u8> {
            let mut tar = tar::Builder::new(Vec::new());
            for i in 0..count {
                let name = format!("file{i}");
                let mut header = tar::Header::new_gnu();
                header.set_size(1);
                header.set_mode(0o644);
                header.set_cksum();
                tar.append_data(&mut header, &name, &b"x"[..]).unwrap();
            }
            let raw = tar.into_inner().unwrap();
            let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
            gz.write_all(&raw).unwrap();
            gz.finish().unwrap()
        }

        let dir = std::env::temp_dir().join(format!("alethe-aimem-tar-many-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);

        // Create an archive with 5 entries, but test with a limit of 3
        let tarball = tar_gz(5);
        let err = extract_tar_gz_bounded(&tarball, &dir, 3, MAX_UNPACKED_BYTES).unwrap_err();
        assert_eq!(err, "tar_too_many_entries", "entry cap is enforced: {err}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_tarball_exceeding_unpacked_bytes_is_refused() {
        use std::io::Write;

        fn tar_gz(entries: &[(&str, &[u8])]) -> Vec<u8> {
            let mut tar = tar::Builder::new(Vec::new());
            for (name, body) in entries {
                let mut header = tar::Header::new_gnu();
                header.set_size(body.len() as u64);
                header.set_mode(0o644);
                header.set_cksum();
                tar.append_data(&mut header, name, *body).unwrap();
            }
            let raw = tar.into_inner().unwrap();
            let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
            gz.write_all(&raw).unwrap();
            gz.finish().unwrap()
        }

        let dir = std::env::temp_dir().join(format!("alethe-aimem-tar-size-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);

        // Create an archive with 100 bytes of data, but test with a limit of 50 bytes
        let tarball = tar_gz(&[("file1", &[0u8; 100])]);
        let err = extract_tar_gz_bounded(&tarball, &dir, MAX_ENTRIES, 50).unwrap_err();
        assert_eq!(err, "tar_too_large", "unpacked bytes cap is enforced: {err}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_plugin_extraction_path_is_unchanged() {
        // Verify that extract_zip still rejects archives exceeding the plugin cap,
        // and that the plugin download limit is untouched.
        use crate::plugin_package::{extract_zip, MAX_DOWNLOAD_BYTES as PLUGIN_MAX_DL, MAX_UNPACKED_BYTES as PLUGIN_MAX_UP, MAX_ENTRIES as PLUGIN_MAX_ENTRIES};

        let dir = std::env::temp_dir().join(format!("alethe-plugin-cap-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);

        // Create a zip that's over the plugin unpacked limit
        let mut buffer = Vec::new();
        {
            let mut writer = zip::ZipWriter::new(std::io::Cursor::new(&mut buffer));
            let options: zip::write::FileOptions = Default::default();
            use std::io::Write;
            writer.start_file("file.bin", options).unwrap();
            // Write more than PLUGIN_MAX_UP bytes
            writer.write_all(&vec![0u8; (PLUGIN_MAX_UP + 1) as usize]).unwrap();
            writer.finish().unwrap();
        }

        let result = extract_zip(&buffer, &dir);
        assert!(result.is_err(), "plugin cap still enforced");

        // Verify the plugin constants are what we expect
        assert_eq!(PLUGIN_MAX_DL, 8 * 1024 * 1024, "plugin download limit unchanged");
        assert_eq!(PLUGIN_MAX_UP, 32 * 1024 * 1024, "plugin unpacked limit unchanged");
        assert_eq!(PLUGIN_MAX_ENTRIES, 2_000, "plugin entry limit unchanged");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_hash_file_is_read_from_its_first_field() {
        // The published file is "<hash>  <filename>".
        let body = "4b3b8757c16a6ae97a3a43f46baef012a400121017272fb4e799503d8c130a50  ai-memory-windows-x86_64.zip\n";
        assert_eq!(
            parse_sha256_file(body).as_deref(),
            Some("4b3b8757c16a6ae97a3a43f46baef012a400121017272fb4e799503d8c130a50")
        );
        assert!(parse_sha256_file("").is_none());
        assert!(parse_sha256_file("not-a-hash  file.zip").is_none());
    }

    #[test]
    fn the_counts_come_from_the_binarys_own_status() {
        // Real `ai-memory status` output, trimmed. Alethe reports what the service says about
        // itself rather than keeping a tally of its own that can drift.
        let out = "ai-memory 2.4.0 (server)\n  \
                   pages:        3 (all versions: 4)\n  \
                   sessions:     2\n  \
                   observations: 17\n";
        let counts = parse_counts(out);
        assert_eq!((counts.pages, counts.sessions, counts.observations), (3, 2, 17));
    }

    #[test]
    fn a_store_with_nothing_in_it_reads_as_zero_not_as_an_error() {
        // A freshly reset store prints no count lines. Zero is the truth there; failing would make
        // the panel show an error for a healthy, empty service.
        let counts = parse_counts("ai-memory 2.4.0 (server)\n");
        assert_eq!((counts.pages, counts.sessions, counts.observations), (0, 0, 0));
    }

    #[test]
    fn a_failed_extraction_leaves_nothing_behind() {
        use std::io::Write;

        fn tar_gz(count: usize) -> Vec<u8> {
            let mut tar = tar::Builder::new(Vec::new());
            for i in 0..count {
                let name = format!("file{i}");
                let mut header = tar::Header::new_gnu();
                header.set_size(1);
                header.set_mode(0o644);
                header.set_cksum();
                tar.append_data(&mut header, &name, &b"x"[..]).unwrap();
            }
            let raw = tar.into_inner().unwrap();
            let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
            gz.write_all(&raw).unwrap();
            gz.finish().unwrap()
        }

        let dir = std::env::temp_dir().join(format!("alethe-aimem-install-cleanup-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);

        // 5 entries against a cap of 3: the entry-count check trips partway through, after the
        // destination directory (and possibly some of its entries) already exist on disk.
        let tarball = tar_gz(5);
        let extraction = extract_tar_gz_bounded(&tarball, &dir, 3, MAX_UNPACKED_BYTES);
        assert!(extraction.is_err(), "the cap should have tripped");
        assert!(dir.exists(), "the failed extraction itself still leaves the partial dir behind");

        let outcome = cleanup_on_extract_failure(&dir, extraction);
        assert!(outcome.is_err(), "the error is still propagated, not swallowed");
        assert!(!dir.exists(), "install's cleanup removes what the failed extraction left behind");
    }
}
