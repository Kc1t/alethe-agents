use serde::Serialize;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use sysinfo::System;

#[derive(Serialize, Clone, Debug)]
pub struct MemoryStats {
    pub total_mb: f64,
    pub app_mb: f64,
    pub webview_mb: f64,
    pub ptys_mb: f64,
    pub process_count: usize,
    pub system_total_mb: f64,
    pub system_available_mb: f64,
}

fn shared_system() -> &'static Mutex<System> {
    static SYS: OnceLock<Mutex<System>> = OnceLock::new();
    SYS.get_or_init(|| Mutex::new(System::new()))
}

const SYSTEM_REFRESH_GRACE: Duration = Duration::from_secs(2);

fn refresh_tracker() -> &'static Mutex<Option<Instant>> {
    static LAST: OnceLock<Mutex<Option<Instant>>> = OnceLock::new();
    LAST.get_or_init(|| Mutex::new(None))
}

/// Refreshes the shared system only when the last refresh is older than
/// [`SYSTEM_REFRESH_GRACE`]. Both the stats collector and the resource
/// supervisor use this, so two monitors ticking on the same cadence reuse a
/// single `/proc` walk instead of each building its own process table.
pub(crate) fn refresh_system_if_stale(sys: &mut System) {
    let mut last = refresh_tracker()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let stale = last.map_or(true, |at| at.elapsed() >= SYSTEM_REFRESH_GRACE);
    if stale {
        sys.refresh_processes(sysinfo::ProcessesToUpdate::All);
        sys.refresh_memory();
        *last = Some(Instant::now());
    }
}

pub(crate) fn shared_system_handle() -> &'static Mutex<System> {
    shared_system()
}

pub fn collect_memory_stats() -> MemoryStats {
    use sysinfo::Pid;
    let sys_lock = shared_system();
    let mut sys = sys_lock
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    refresh_system_if_stale(&mut sys);

    let system_total_mb = sys.total_memory() as f64 / 1024.0 / 1024.0;
    let system_available_mb = sys.available_memory() as f64 / 1024.0 / 1024.0;

    // BFS over the process subtree rooted at the current PID. Build a
    // children map in a single pass (O(N)) instead of scanning all processes
    // per visited pid (O(N×P)).
    let root_pid = std::process::id() as usize;
    let mut children: std::collections::HashMap<usize, Vec<usize>> = std::collections::HashMap::new();
    for (other_pid, process) in sys.processes() {
        if process.thread_kind().is_some() {
            continue;
        }
        if let Some(parent) = process.parent() {
            children
                .entry(parent.as_u32() as usize)
                .or_default()
                .push(other_pid.as_u32() as usize);
        }
    }
    let mut visited = std::collections::HashSet::<usize>::new();
    let mut frontier = vec![root_pid];
    while let Some(pid) = frontier.pop() {
        if !visited.insert(pid) {
            continue;
        }
        if let Some(kids) = children.get(&pid) {
            frontier.extend(kids.iter().copied());
        }
    }

    let mut app_bytes: u64 = 0;
    let mut webview_bytes: u64 = 0;
    let mut pty_bytes: u64 = 0;
    for pid in &visited {
        let Some(process) = sys.process(Pid::from(*pid)) else {
            continue;
        };
        let mem = process.memory();
        let name = process.name().to_string_lossy().to_ascii_lowercase();
        if *pid == root_pid || name.contains("alethe") || name.contains("ensemble") {
            app_bytes += mem;
        } else if name.contains("msedgewebview2") {
            webview_bytes += mem;
        } else {
            pty_bytes += mem;
        }
    }

    let total = app_bytes + webview_bytes + pty_bytes;
    let to_mb = |bytes: u64| (bytes as f64) / 1024.0 / 1024.0;
    MemoryStats {
        total_mb: to_mb(total),
        app_mb: to_mb(app_bytes),
        webview_mb: to_mb(webview_bytes),
        ptys_mb: to_mb(pty_bytes),
        process_count: visited.len(),
        system_total_mb,
        system_available_mb,
    }
}

/// Windows). O lock do cache serializa chamadas concorrentes.
fn cached_memory_stats() -> MemoryStats {
    static CACHE: OnceLock<Mutex<Option<(Instant, MemoryStats)>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(None));
    let mut guard = cache
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some((at, stats)) = guard.as_ref() {
        if at.elapsed() < Duration::from_secs(2) {
            return stats.clone();
        }
    }
    let fresh = collect_memory_stats();
    *guard = Some((Instant::now(), fresh.clone()));
    fresh
}

#[tauri::command]
pub fn get_memory_stats() -> MemoryStats {
    cached_memory_stats()
}

pub fn memory_stats_cached() -> MemoryStats {
    cached_memory_stats()
}
