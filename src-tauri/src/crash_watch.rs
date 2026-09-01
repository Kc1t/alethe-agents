//

// marca `clean_exit:true`. Se o processo foi morto/crashou (OOM, taskkill, freeze

// (≠ do record_frontend_error, que depende da UI viva).

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

const HEARTBEAT_SECS: u64 = 6;

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct SessionRecord {
    pub started_at_ms: u64,
    pub clean_exit: bool,
    pub app_version: String,

    pub last_heartbeat_ms: u64,
    pub total_mb: f64,
    pub ptys_mb: f64,
    pub webview_mb: f64,
    pub process_count: usize,

    #[serde(default)]
    pub job_guard_active: bool,
}

#[derive(Serialize, Clone)]
pub struct CrashReport {
    pub session: SessionRecord,
    pub orphans_reaped: usize,
}

static STATE: OnceLock<Mutex<SessionRecord>> = OnceLock::new();
static FILE: OnceLock<PathBuf> = OnceLock::new();

static LAST_CRASH: OnceLock<Option<CrashReport>> = OnceLock::new();

use crate::provider_common::now_ms;

fn unix_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn write_record(rec: &SessionRecord) {
    let Some(path) = FILE.get() else {
        return;
    };
    let Ok(json) = serde_json::to_vec_pretty(rec) else {
        return;
    };
    let tmp = path.with_extension("json.tmp");
    if fs::write(&tmp, &json).is_ok() {
        let _ = fs::rename(&tmp, path);
    }
}

fn append_unclean_log(dir: &Path, prev: &SessionRecord, orphans_reaped: usize) {
    let path = dir.join(format!("unclean-exit-{}.log", unix_secs()));
    if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(
            file,
            "previous session did NOT exit cleanly (likely crash/kill/OOM)\n\
             app_version={} started_at_ms={} last_heartbeat_ms={} job_guard_active={}\n\
             last memory: total={:.0} MB · ptys={:.0} MB · webview={:.0} MB · {} processes\n\
             orphan sweep at this boot: {orphans_reaped} process tree(s) killed",
            prev.app_version,
            prev.started_at_ms,
            prev.last_heartbeat_ms,
            prev.job_guard_active,
            prev.total_mb,
            prev.ptys_mb,
            prev.webview_mb,
            prev.process_count,
        );
    }
}

/// novo `clean_exit:false` e sobe a thread de heartbeat.
pub fn start(app: AppHandle) {
    let Ok(dir) = crate::logging::logs_dir(&app) else {
        return;
    };
    let _ = fs::create_dir_all(&dir);
    let path = dir.join("last_session.json");

    // raro do Job Object (`pty::install_kill_on_close_guard`) ter falhado

    let prev_crash = fs::read(&path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<SessionRecord>(&bytes).ok())
        .filter(|prev| !prev.clean_exit);
    let last_crash = if let Some(prev) = prev_crash {
        let orphans_reaped = crate::process_tree::sweep_orphans_from_previous_session();
        append_unclean_log(&dir, &prev, orphans_reaped);
        Some(CrashReport {
            session: prev,
            orphans_reaped,
        })
    } else {
        None
    };
    let _ = LAST_CRASH.set(last_crash);

    let fresh = SessionRecord {
        started_at_ms: now_ms(),
        clean_exit: false,
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        job_guard_active: crate::pty::job_guard_active(),
        ..Default::default()
    };
    let _ = FILE.set(path);
    let _ = STATE.set(Mutex::new(fresh.clone()));
    write_record(&fresh);

    thread::spawn(|| loop {
        thread::sleep(Duration::from_secs(HEARTBEAT_SECS));
        let stats = crate::stats::memory_stats_cached();
        if let Some(state) = STATE.get() {
            let mut rec = state.lock().unwrap_or_else(|p| p.into_inner());
            rec.last_heartbeat_ms = now_ms();
            rec.total_mb = stats.total_mb;
            rec.ptys_mb = stats.ptys_mb;
            rec.webview_mb = stats.webview_mb;
            rec.process_count = stats.process_count;
            write_record(&rec);
        }
    });
}

pub fn mark_clean_exit() {
    if let Some(state) = STATE.get() {
        let mut rec = state.lock().unwrap_or_else(|p| p.into_inner());
        rec.clean_exit = true;
        write_record(&rec);
    }
}

#[tauri::command]
pub fn get_last_crash_report() -> Option<CrashReport> {
    LAST_CRASH.get().cloned().flatten()
}

#[tauri::command]
pub fn get_job_guard_status() -> bool {
    crate::pty::job_guard_active()
}
