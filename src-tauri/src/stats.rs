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

pub fn collect_memory_stats() -> MemoryStats {
    use sysinfo::Pid;
    let sys_lock = shared_system();
    let mut sys = sys_lock
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    sys.refresh_processes(sysinfo::ProcessesToUpdate::All);
    sys.refresh_memory();

    let system_total_mb = sys.total_memory() as f64 / 1024.0 / 1024.0;
    let system_available_mb = system_available_bytes(&sys) as f64 / 1024.0 / 1024.0;

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

/// Memory the system can still hand out, in bytes.
///
/// On macOS sysinfo computes free + inactive + purgeable minus the pages the compressor occupies,
/// which saturates to 0 on a Mac that compresses a lot (an 8 GB machine under ordinary load) while
/// the kernel still reports plenty free. The kernel's memorystatus level, the "System-wide memory
/// free percentage" `memory_pressure` prints, is the figure macOS itself acts on.
pub fn system_available_bytes(sys: &System) -> u64 {
    #[cfg(target_os = "macos")]
    if let Some(level) = memorystatus_level() {
        return available_from_level(sys.total_memory(), level);
    }
    sys.available_memory()
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn available_from_level(total_bytes: u64, level_percent: u32) -> u64 {
    total_bytes / 100 * u64::from(level_percent.min(100))
}

#[cfg(target_os = "macos")]
fn memorystatus_level() -> Option<u32> {
    let mut level: libc::c_int = 0;
    let mut size = std::mem::size_of::<libc::c_int>();
    // SAFETY: the name is NUL-terminated and `level`/`size` describe a valid c_int buffer.
    let status = unsafe {
        libc::sysctlbyname(
            c"kern.memorystatus_level".as_ptr(),
            (&mut level as *mut libc::c_int).cast(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    (status == 0 && (0..=100).contains(&level)).then_some(level as u32)
}

/// Reuses a sample for 2 s. The cache lock serializes concurrent calls.
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn available_memory_follows_the_kernel_level() {
        let total = 8 * 1024 * 1024 * 1024u64;
        assert_eq!(available_from_level(total, 42), total / 100 * 42);
        assert_eq!(available_from_level(total, 0), 0);
        assert_eq!(available_from_level(total, 250), total / 100 * 100);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn the_kernel_level_is_readable_on_macos() {
        assert!(memorystatus_level().is_some());
    }
}
