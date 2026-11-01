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

/// sysinfo subtracts the pages the compressor occupies from free + inactive on macOS, which
/// saturates at 0 as soon as the compressor holds a few GB, and macOS compresses all the time.
/// A 0 held every new terminal at the memory gate and kept the resource manager at Critical, so
/// macOS reads the share of memory the kernel itself reports as available instead.
#[cfg(target_os = "macos")]
pub(crate) fn system_available_mb(sys: &System, total_mb: f64) -> f64 {
    match macos_memorystatus_level() {
        Some(percent) => total_mb * f64::from(percent.clamp(0, 100)) / 100.0,
        None => sys.available_memory() as f64 / 1024.0 / 1024.0,
    }
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn system_available_mb(sys: &System, _total_mb: f64) -> f64 {
    sys.available_memory() as f64 / 1024.0 / 1024.0
}

/// `kern.memorystatus_level`: the percentage of memory the kernel counts as available, the same
/// figure `memory_pressure` prints as "System-wide memory free percentage".
#[cfg(target_os = "macos")]
fn macos_memorystatus_level() -> Option<i32> {
    let mut level: libc::c_int = 0;
    let mut size = std::mem::size_of::<libc::c_int>();
    let status = unsafe {
        libc::sysctlbyname(
            c"kern.memorystatus_level".as_ptr(),
            &mut level as *mut libc::c_int as *mut libc::c_void,
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    (status == 0).then_some(level)
}

pub fn collect_memory_stats() -> MemoryStats {
    use sysinfo::Pid;
    let sys_lock = shared_system();
    let mut sys = sys_lock
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    sys.refresh_processes(sysinfo::ProcessesToUpdate::All);
    sys.refresh_memory();

    let system_total_mb = sys.total_memory() as f64 / 1024.0 / 1024.0;
    let system_available_mb = system_available_mb(&sys, system_total_mb);

    // BFS no subtree de processos a partir do PID atual.
    let root_pid = std::process::id() as usize;
    let mut visited = std::collections::HashSet::<usize>::new();
    let mut frontier = vec![root_pid];
    while let Some(pid) = frontier.pop() {
        if !visited.insert(pid) {
            continue;
        }
        for (other_pid, process) in sys.processes() {
            if process.thread_kind().is_some() {
                continue;
            }
            if let Some(parent) = process.parent() {
                if parent.as_u32() as usize == pid {
                    frontier.push(other_pid.as_u32() as usize);
                }
            }
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

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    #[test]
    fn macos_reports_the_kernel_available_share() {
        let level = macos_memorystatus_level().expect("kern.memorystatus_level is readable");
        assert!((0..=100).contains(&level), "{level}");

        let stats = collect_memory_stats();
        let expected = stats.system_total_mb * f64::from(level) / 100.0;
        assert!(stats.system_available_mb <= stats.system_total_mb);
        // The level can move between the two reads, so allow a few percent of drift.
        assert!(
            (stats.system_available_mb - expected).abs() <= stats.system_total_mb * 0.05,
            "{} vs {expected}",
            stats.system_available_mb
        );
    }
}
