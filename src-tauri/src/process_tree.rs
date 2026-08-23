use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use sysinfo::{Pid, ProcessesToUpdate, System};

/// Mapeia ptyId → PID raiz do PTY (pwsh.exe / bash).
static PTY_ROOTS: OnceLock<Mutex<HashMap<String, u32>>> = OnceLock::new();

static TREE_CACHE: OnceLock<Mutex<Option<(Instant, HashMap<u32, Vec<u32>>)>>> = OnceLock::new();

fn roots() -> &'static Mutex<HashMap<String, u32>> {
    PTY_ROOTS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn tree_cache() -> &'static Mutex<Option<(Instant, HashMap<u32, Vec<u32>>)>> {
    TREE_CACHE.get_or_init(|| Mutex::new(None))
}

fn build_parent_map(sys: &mut System) -> HashMap<u32, Vec<u32>> {
    sys.refresh_processes(ProcessesToUpdate::All);
    let mut map: HashMap<u32, Vec<u32>> = HashMap::new();
    for (pid, process) in sys.processes() {
        // contagem/kill de PTY tree e deixando spawn/kill bem mais lentos.
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
    let mut sys = System::new();
    let fresh = build_parent_map(&mut sys);
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

/// The instance that wrote the file, so a reader can tell a dead session's leftovers from the live
/// terminals of an instance that is still running.
#[derive(Serialize, Deserialize)]
struct PersistedRoots {
    owner: PersistedRoot,
    roots: Vec<PersistedRoot>,
}

static ROOTS_FILE: OnceLock<PathBuf> = OnceLock::new();

/// Scopes the file to one instance's data directory. A dev build and an installed build must never
/// share it: the sweep kills whole process trees, so reading another live instance's file wipes out
/// its terminals. Until this is set there is no path, and both the write and the sweep are skipped.
pub fn set_roots_file_dir(dir: PathBuf) {
    let _ = ROOTS_FILE.set(dir.join("pty_roots.json"));
}

fn roots_file_path() -> Option<PathBuf> {
    ROOTS_FILE.get().cloned()
}

fn identify(sys: &System, pid: u32) -> Option<PersistedRoot> {
    sys.process(Pid::from_u32(pid)).map(|process| PersistedRoot {
        pid,
        name: process.name().to_string_lossy().into_owned(),
        start_time: process.start_time(),
    })
}

/// PIDs are recycled, so identity is the triple, never the number alone.
fn still_running(sys: &System, recorded: &PersistedRoot) -> bool {
    identify(sys, recorded.pid)
        .map(|live| live.name == recorded.name && live.start_time == recorded.start_time)
        .unwrap_or(false)
}

/// Job Object (`pty::install_kill_on_close_guard`) tenha falhado silenciosamente

fn persist_roots() {
    let Some(path) = roots_file_path() else {
        return;
    };
    let snapshot = {
        let Ok(guard) = roots().lock() else { return };
        let mut sys = System::new();
        sys.refresh_processes(ProcessesToUpdate::All);
        let Some(owner) = identify(&sys, std::process::id()) else {
            return;
        };
        PersistedRoots {
            owner,
            roots: guard
                .values()
                .filter_map(|&pid| identify(&sys, pid))
                .collect(),
        }
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

/// inteira de qualquer PID raiz ainda vivo cujo nome+start_time batam com o

/// falhar silenciosamente, ou qualquer processo que tenha escapado dele).

pub fn sweep_orphans_from_previous_session() -> usize {
    let Some(path) = roots_file_path() else {
        return 0;
    };
    let Ok(bytes) = std::fs::read(&path) else {
        return 0;
    };
    // A file this build cannot parse says nothing about who owns the processes in it, and the sweep
    // kills whole trees — so it is discarded rather than acted on.
    let Ok(persisted) = serde_json::from_slice::<PersistedRoots>(&bytes) else {
        let _ = std::fs::remove_file(&path);
        return 0;
    };

    let mut sys = System::new();
    sys.refresh_processes(ProcessesToUpdate::All);

    // Nothing here is an orphan while the instance that registered it is still running: these are
    // its live terminals, and the file is still in use, so it must not be removed either.
    if still_running(&sys, &persisted.owner) {
        return 0;
    }

    let _ = std::fs::remove_file(&path);
    if persisted.roots.is_empty() {
        return 0;
    }

    let parent_map = get_parent_map();
    let mut killed_roots = 0;
    for root in persisted.roots {
        if !still_running(&sys, &root) {
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
        // Inclui o root se ele ainda estiver vivo (aparece no parent_map)
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

/// Mata um PID (Windows via taskkill /F, Unix via SIGKILL). Descarta

fn kill_pid(pid: u32) {
    #[cfg(windows)]
    {
        let mut command = std::process::Command::new("taskkill");
        command.args(["/F", "/PID", &pid.to_string()]);
        command.stdout(std::process::Stdio::null());
        command.stderr(std::process::Stdio::null());
        crate::git_control::hide_console(&mut command);
        run_with_timeout(command, Duration::from_secs(3));
    }
    #[cfg(not(windows))]
    {
        let mut command = std::process::Command::new("kill");
        command.args(["-9", &pid.to_string()]);
        command.stdout(std::process::Stdio::null());
        command.stderr(std::process::Stdio::null());
        run_with_timeout(command, Duration::from_secs(3));
    }
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

    for &pid in &all {
        kill_pid(pid);
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
    // `kill_pty_tree` roda `taskkill`/`kill` por descendente, sequencial e

    tokio::task::spawn_blocking(move || kill_pty_tree(&pty_id))
        .await
        .map_err(|error| format!("kill_pty_tree_cmd: falha na task bloqueante: {error}"))?
}
