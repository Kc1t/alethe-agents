use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use sysinfo::{Pid, ProcessesToUpdate, System};

/// Maps ptyId → root PID of the PTY (pwsh.exe / bash).
static PTY_ROOTS: OnceLock<Mutex<HashMap<String, u32>>> = OnceLock::new();

static TREE_CACHE: OnceLock<Mutex<Option<(Instant, HashMap<u32, Vec<u32>>)>>> = OnceLock::new();

fn roots() -> &'static Mutex<HashMap<String, u32>> {
    PTY_ROOTS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn tree_cache() -> &'static Mutex<Option<(Instant, HashMap<u32, Vec<u32>>)>> {
    TREE_CACHE.get_or_init(|| Mutex::new(None))
}

fn build_parent_map_inner(sys: &System) -> HashMap<u32, Vec<u32>> {
    let mut map: HashMap<u32, Vec<u32>> = HashMap::new();
    for (pid, process) in sys.processes() {
        // sysinfo lists kernel threads as children; skipping them keeps the
        // PTY tree counts and kills fast instead of walking tens of threads
        // per process.
        if process.thread_kind().is_some() {
            continue;
        }
        if let Some(parent) = process.parent() {
            let parent_pid = parent.as_u32();
            map.entry(parent_pid).or_default().push(pid.as_u32());
        }
    }
    map
}

fn get_parent_map() -> HashMap<u32, Vec<u32>> {
    let cache = tree_cache();
    let mut guard = cache
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some((at, map)) = guard.as_ref() {
        if at.elapsed() < Duration::from_secs(2) {
            return map.clone();
        }
    }
    let mut sys = crate::stats::shared_system_handle()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    crate::stats::refresh_system_if_stale(&mut sys);
    let fresh = build_parent_map_inner(&sys);
    *guard = Some((Instant::now(), fresh.clone()));
    fresh
}

fn collect_descendants(root: u32, parent_map: &HashMap<u32, Vec<u32>>) -> Vec<u32> {
    let mut result = Vec::new();
    let mut frontier = vec![root];
    let mut visited = std::collections::HashSet::new();
    while let Some(pid) = frontier.pop() {
        if !visited.insert(pid) {
            continue;
        }
        if pid != root {
            result.push(pid);
        }
        if let Some(children) = parent_map.get(&pid) {
            for &child in children {
                frontier.push(child);
            }
        }
    }
    result
}

#[derive(Serialize)]
pub struct PtyTreeInfo {
    pub pty_id: String,
    pub root_pid: Option<u32>,
    pub descendants: Vec<u32>,
    pub alive: bool,
}

pub fn register_pty_root(pty_id: &str, pid: u32) {
    if let Ok(mut guard) = roots().lock() {
        guard.insert(pty_id.to_string(), pid);
    }
    persist_roots();
}

pub fn unregister_pty(pty_id: &str) {
    if let Ok(mut guard) = roots().lock() {
        guard.remove(pty_id);
    }
    persist_roots();
}

#[derive(Serialize, Deserialize, Clone)]
struct PersistedRoot {
    pid: u32,
    name: String,
    start_time: u64,
}

/// Fixed path, independent of profile/`AppHandle` — `register_pty_root` and
/// the boot sweep both need it before any window state exists.
fn roots_file_path() -> Option<PathBuf> {
    dirs_next::data_local_dir().map(|d| d.join("Alethe").join("pty_roots.json"))
}

/// Persists root PIDs so a future boot can sweep trees that escaped the
/// job-object guard (`pty::install_kill_on_close_guard`).
fn persist_roots() {
    let Some(path) = roots_file_path() else {
        return;
    };
    let snapshot: Vec<PersistedRoot> = {
        let Ok(guard) = roots().lock() else { return };
        let mut sys = crate::stats::shared_system_handle()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        // persist_roots runs on every spawn/kill and must record the freshly
        // spawned process. Only force a /proc scan when a root is missing
        // from the (possibly stale) shared table; otherwise the resource
        // monitor's recent refresh already covers it.
        let missing = guard
            .values()
            .any(|&pid| sys.process(Pid::from_u32(pid)).is_none());
        if missing {
            sys.refresh_processes(ProcessesToUpdate::All);
        }
        guard
            .values()
            .filter_map(|&pid| {
                sys.process(Pid::from_u32(pid)).map(|p| PersistedRoot {
                    pid,
                    name: p.name().to_string_lossy().into_owned(),
                    start_time: p.start_time(),
                })
            })
            .collect()
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let Ok(json) = serde_json::to_vec(&snapshot) else {
        return;
    };
    let tmp = path.with_extension("json.tmp");
    if std::fs::write(&tmp, &json).is_ok() {
        let _ = std::fs::rename(&tmp, &path);
    }
}

/// Kills the whole tree of any root PID still alive whose name+start_time
/// match the persisted record (the job-object guard may have failed silently,
/// or a process escaped it).
pub fn sweep_orphans_from_previous_session() -> usize {
    let Some(path) = roots_file_path() else {
        return 0;
    };
    let Ok(bytes) = std::fs::read(&path) else {
        return 0;
    };
    let _ = std::fs::remove_file(&path);
    let Ok(persisted) = serde_json::from_slice::<Vec<PersistedRoot>>(&bytes) else {
        return 0;
    };
    if persisted.is_empty() {
        return 0;
    }

    let mut sys = System::new();
    sys.refresh_processes(ProcessesToUpdate::All);
    let parent_map = get_parent_map();
    let mut killed_roots = 0;
    for root in persisted {
        let Some(proc) = sys.process(Pid::from_u32(root.pid)) else {
            continue;
        };
        if proc.name().to_string_lossy() != root.name || proc.start_time() != root.start_time {
            continue;
        }
        let mut all = collect_descendants(root.pid, &parent_map);
        all.reverse();
        all.push(root.pid);
        for pid in all {
            kill_pid(pid);
        }
        killed_roots += 1;
    }
    killed_roots
}

pub fn get_pty_tree(pty_id: &str) -> Option<PtyTreeInfo> {
    let root_pid = {
        let guard = roots().lock().ok()?;
        guard.get(pty_id).copied()
    };
    let parent_map = get_parent_map();
    let (live_descendants, alive) = if let Some(root) = root_pid {
        let desc = collect_descendants(root, &parent_map);
        // Includes the root if it is still alive (it appears in the parent map)
        let root_alive = parent_map.contains_key(&root) || desc.iter().any(|&p| p == root);
        let alive = root_alive || !desc.is_empty();
        (desc, alive)
    } else {
        (Vec::new(), false)
    };
    Some(PtyTreeInfo {
        pty_id: pty_id.to_string(),
        root_pid,
        descendants: live_descendants,
        alive,
    })
}

#[cfg(windows)]
fn run_with_timeout(mut command: std::process::Command, timeout: Duration) {
    let Ok(mut child) = command.spawn() else {
        return;
    };
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return,
            Ok(None) => {
                if started.elapsed() >= timeout {
                    let _ = child.kill();
                    return;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(_) => return,
        }
    }
}

/// Kills a PID (Windows via `taskkill /F`, Unix via direct SIGKILL syscall).
/// Unix avoids spawning a `kill` subprocess per descendant — a syscall is
/// ~3 orders of magnitude cheaper and removes the per-PID poll loop.
#[cfg(not(windows))]
fn kill_pid(pid: u32) {
    let _ = unsafe { libc::kill(pid as i32, libc::SIGKILL) };
}

#[cfg(windows)]
fn kill_pid(pid: u32) {
    let mut command = std::process::Command::new("taskkill");
    command.args(["/F", "/PID", &pid.to_string()]);
    command.stdout(std::process::Stdio::null());
    command.stderr(std::process::Stdio::null());
    crate::git_control::hide_console(&mut command);
    run_with_timeout(command, Duration::from_secs(3));
}

pub fn kill_pty_tree(pty_id: &str) -> Result<Vec<u32>, String> {
    let root_pid = {
        let guard = roots().lock().map_err(|_| "PTY roots lock poisoned")?;
        guard.get(pty_id).copied()
    };
    let root = root_pid.ok_or_else(|| format!("No root PID registered for PTY: {pty_id}"))?;

    let parent_map = get_parent_map();
    let mut all = collect_descendants(root, &parent_map);

    all.reverse();
    all.push(root);

    #[cfg(not(windows))]
    {
        // portable-pty creates a new session for the PTY child, so the root is
        // a process-group leader. killpg sends SIGKILL to the entire group in
        // one syscall; stragglers that called setsid() themselves are handled
        // by the per-PID pass below.
        let _ = unsafe { libc::killpg(root as i32, libc::SIGKILL) };
    }

    for &pid in &all {
        if pid != root {
            kill_pid(pid);
        }
    }

    if let Ok(mut guard) = roots().lock() {
        guard.remove(pty_id);
    }

    Ok(all)
}

#[tauri::command]
pub fn get_pty_tree_info(pty_id: String) -> Option<PtyTreeInfo> {
    get_pty_tree(&pty_id)
}

#[tauri::command]
pub async fn kill_pty_tree_cmd(pty_id: String) -> Result<Vec<u32>, String> {
    // `kill_pty_tree` walks the process table and runs killpg/`kill` — keep it
    // off the async runtime so a large tree never stalls a tokio worker.
    tokio::task::spawn_blocking(move || kill_pty_tree(&pty_id))
        .await
        .map_err(|error| format!("kill_pty_tree_cmd: blocking task failed: {error}"))?
}
