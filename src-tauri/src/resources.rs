use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::Duration;
use sysinfo::{Pid, System};
use tauri::{AppHandle, Emitter, State};

use crate::provider_common::now_ms;
use crate::pty::{self, PtySessions};
use crate::stats::MemoryStats;

const SAMPLE_INTERVAL: Duration = Duration::from_secs(5);
const META_STALE_MS: u64 = 30_000;
const RESOURCE_LOG_INTERVAL_MS: u64 = 60_000;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourcePolicy {
    pub mode: String,
    pub memory_budget_mb: f64,
    pub warning_threshold_mb: f64,
    pub recovery_target_mb: f64,
    pub hidden_agent_idle_minutes: u64,
    pub hidden_shell_idle_minutes: u64,
    pub spawn_grace_seconds: u64,
}

impl Default for ResourcePolicy {
    fn default() -> Self {
        Self {
            // Monitoring is safe by default. Terminating an existing PTY must
            // only happen after the user explicitly opts in from Preferences.
            mode: "manual".to_string(),
            memory_budget_mb: 1536.0,
            warning_threshold_mb: 1229.0,
            recovery_target_mb: 1152.0,
            hidden_agent_idle_minutes: 15,
            hidden_shell_idle_minutes: 30,
            spawn_grace_seconds: 120,
        }
    }
}

impl ResourcePolicy {
    fn normalized(mut self) -> Self {
        self.mode = if self.mode == "manual" {
            "manual".to_string()
        } else {
            "smart-lru".to_string()
        };
        self.memory_budget_mb = self.memory_budget_mb.clamp(768.0, 8192.0);
        self.warning_threshold_mb = self
            .warning_threshold_mb
            .clamp(512.0, self.memory_budget_mb - 64.0);
        self.recovery_target_mb = self
            .recovery_target_mb
            .clamp(384.0, self.warning_threshold_mb - 64.0);
        self.hidden_agent_idle_minutes = self.hidden_agent_idle_minutes.clamp(5, 240);
        self.hidden_shell_idle_minutes = self.hidden_shell_idle_minutes.clamp(5, 480);
        self.spawn_grace_seconds = self.spawn_grace_seconds.clamp(30, 900);
        self
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyRuntimeMeta {
    pub id: String,
    pub kind: String,
    pub status: String,
    pub visible: bool,
    pub focused: bool,
    pub protected: bool,
    pub last_io_at_ms: u64,
    pub spawned_at_ms: u64,
    pub last_used_at_ms: u64,
    pub reported_at_ms: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeProcess {
    pub pid: u32,
    pub parent_pid: Option<u32>,
    pub name: String,
    pub working_set_mb: f64,
    pub private_commit_mb: f64,
    pub cpu_percent: f32,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyResourceStats {
    pub id: String,
    pub root_pid: Option<u32>,
    pub command: Option<String>,
    pub cwd: Option<String>,
    pub process_count: usize,
    pub working_set_mb: f64,
    pub private_commit_mb: f64,
    pub effective_memory_mb: f64,
    pub processes: Vec<RuntimeProcess>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PressureState {
    pub level: &'static str,
    pub spawn_blocked: bool,
    pub automatic: bool,
    pub candidate_count: usize,
    pub last_suspended_id: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSnapshot {
    pub sampled_at_ms: u64,
    pub memory: MemoryStats,
    pub private_commit_mb: f64,
    pub effective_total_mb: f64,
    pub ptys: Vec<PtyResourceStats>,
    pub pressure: PressureState,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ResourcePressurePayload {
    level: &'static str,
    total_mb: f64,
    budget_mb: f64,
    spawn_blocked: bool,
    candidate_count: usize,
    suspended_id: Option<String>,
}

struct ResourceState {
    policy: ResourcePolicy,
    metas: HashMap<String, PtyRuntimeMeta>,
    latest: Option<RuntimeSnapshot>,
    last_level: &'static str,
    last_log_at_ms: u64,
}

pub struct ResourceSupervisor {
    state: Mutex<ResourceState>,
    system: Mutex<System>,
}

impl Default for ResourceSupervisor {
    fn default() -> Self {
        Self {
            state: Mutex::new(ResourceState {
                policy: ResourcePolicy::default(),
                metas: HashMap::new(),
                latest: None,
                last_level: "normal",
                last_log_at_ms: 0,
            }),
            system: Mutex::new(System::new()),
        }
    }
}

fn process_private_commit_bytes(pid: u32, fallback: u64) -> u64 {
    #[cfg(windows)]
    {
        use std::mem::size_of;
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::ProcessStatus::{
            K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS, PROCESS_MEMORY_COUNTERS_EX,
        };
        use windows_sys::Win32::System::Threading::{
            OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_VM_READ,
        };

        unsafe {
            let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ, 0, pid);
            if process.is_null() {
                return fallback;
            }
            let mut counters = PROCESS_MEMORY_COUNTERS_EX::default();
            counters.cb = size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32;
            let ok = K32GetProcessMemoryInfo(
                process,
                (&mut counters as *mut PROCESS_MEMORY_COUNTERS_EX)
                    .cast::<PROCESS_MEMORY_COUNTERS>(),
                counters.cb,
            );
            let _ = CloseHandle(process);
            if ok != 0 {
                return counters.PrivateUsage as u64;
            }
        }
    }
    #[cfg(target_os = "linux")]
    {
        // do RSS bruto do sysinfo.
        if let Ok(content) = std::fs::read_to_string(format!("/proc/{pid}/smaps_rollup")) {
            let mut private_kb = 0_u64;
            let mut found = false;
            for line in content.lines() {
                let value = line
                    .strip_prefix("Private_Clean:")
                    .or_else(|| line.strip_prefix("Private_Dirty:"));
                if let Some(rest) = value {
                    if let Some(kb) = rest
                        .trim()
                        .split_whitespace()
                        .next()
                        .and_then(|v| v.parse::<u64>().ok())
                    {
                        private_kb += kb;
                        found = true;
                    }
                }
            }
            if found {
                return private_kb * 1024;
            }
        }
    }
    fallback
}

fn descendants(root: u32, children: &HashMap<u32, Vec<u32>>) -> HashSet<u32> {
    let mut result = HashSet::new();
    let mut stack = vec![root];
    while let Some(pid) = stack.pop() {
        if !result.insert(pid) {
            continue;
        }
        if let Some(next) = children.get(&pid) {
            stack.extend(next.iter().copied());
        }
    }
    result
}

impl ResourceSupervisor {
    fn collect(&self, sessions: &PtySessions) -> RuntimeSnapshot {
        let roots = sessions
            .lock()
            .ok()
            .map(|sessions| {
                sessions
                    .iter()
                    .map(|(id, session)| {
                        (
                            id.clone(),
                            // try_lock: taken while the global session lock is held, and that
                            // lock is what every keystroke goes through.
                            session
                                .child
                                .try_lock()
                                .ok()
                                .and_then(|mut child| child.process_id()),
                            session.command.clone(),
                            session.cwd.clone(),
                        )
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();

        let mut system = self.system.lock().unwrap_or_else(|p| p.into_inner());
        system.refresh_processes(sysinfo::ProcessesToUpdate::All);
        system.refresh_memory();

        let mut children = HashMap::<u32, Vec<u32>>::new();
        for (pid, process) in system.processes() {
            // ex. roda ~30 threads).
            if process.thread_kind().is_some() {
                continue;
            }
            if let Some(parent) = process.parent() {
                children
                    .entry(parent.as_u32())
                    .or_default()
                    .push(pid.as_u32());
            }
        }

        let app_pid = std::process::id();
        let app_tree = descendants(app_pid, &children);
        let mut app_bytes = 0_u64;
        let mut webview_bytes = 0_u64;
        let mut pty_bytes = 0_u64;
        let mut private_total = 0_u64;
        for pid in &app_tree {
            let Some(process) = system.process(Pid::from_u32(*pid)) else {
                continue;
            };
            let working = process.memory();

            // processos.
            let private = process_private_commit_bytes(*pid, working);
            private_total += private;
            let name = process.name().to_string_lossy().to_ascii_lowercase();
            if *pid == app_pid || name.contains("alethe") {
                app_bytes += private;
            } else if name.contains("msedgewebview2") || name.contains("webkit") {
                webview_bytes += private;
            } else {
                pty_bytes += private;
            }
        }

        let to_mb = |bytes: u64| bytes as f64 / 1024.0 / 1024.0;
        let memory = MemoryStats {
            total_mb: to_mb(app_bytes + webview_bytes + pty_bytes),
            app_mb: to_mb(app_bytes),
            webview_mb: to_mb(webview_bytes),
            ptys_mb: to_mb(pty_bytes),
            process_count: app_tree.len(),
            system_total_mb: to_mb(system.total_memory()),
            system_available_mb: to_mb(system.available_memory()),
        };

        let mut ptys = roots
            .into_iter()
            .map(|(id, root_pid, command, cwd)| {
                let tree = root_pid
                    .map(|pid| descendants(pid, &children))
                    .unwrap_or_default();
                let mut working = 0_u64;
                let mut private = 0_u64;
                let mut processes = tree
                    .iter()
                    .filter_map(|pid| {
                        let process = system.process(Pid::from_u32(*pid))?;
                        let process_working = process.memory();
                        let process_private = process_private_commit_bytes(*pid, process_working);
                        working += process_working;
                        private += process_private;
                        Some(RuntimeProcess {
                            pid: *pid,
                            parent_pid: process.parent().map(|parent| parent.as_u32()),
                            name: process.name().to_string_lossy().to_string(),
                            working_set_mb: to_mb(process_working),
                            private_commit_mb: to_mb(process_private),
                            cpu_percent: process.cpu_usage(),
                        })
                    })
                    .collect::<Vec<_>>();
                processes.sort_by(|a, b| b.effective_memory().total_cmp(&a.effective_memory()));
                PtyResourceStats {
                    id,
                    root_pid,
                    command,
                    cwd,
                    process_count: tree.len(),
                    working_set_mb: to_mb(working),
                    private_commit_mb: to_mb(private),
                    effective_memory_mb: to_mb(working.max(private)),
                    processes: processes.into_iter().take(12).collect(),
                }
            })
            .collect::<Vec<_>>();
        ptys.sort_by(|a, b| b.effective_memory_mb.total_cmp(&a.effective_memory_mb));

        let private_commit_mb = to_mb(private_total);
        RuntimeSnapshot {
            sampled_at_ms: now_ms(),
            effective_total_mb: memory.total_mb.max(private_commit_mb),
            private_commit_mb,
            memory,
            ptys,
            pressure: PressureState {
                level: "normal",
                spawn_blocked: false,
                automatic: false,
                candidate_count: 0,
                last_suspended_id: None,
            },
        }
    }
}

impl RuntimeProcess {
    fn effective_memory(&self) -> f64 {
        self.working_set_mb.max(self.private_commit_mb)
    }
}

/// Whether this cycle is allowed to terminate a session. Manual mode means the app never does it
/// on its own, at any pressure level; the warning is what it offers instead.
fn may_suspend(level: &str, policy: &ResourcePolicy) -> bool {
    level == "critical" && policy.mode != "manual"
}

fn eligible_candidates(
    snapshot: &RuntimeSnapshot,
    metas: &HashMap<String, PtyRuntimeMeta>,
    policy: &ResourcePolicy,
    now: u64,
) -> Vec<String> {
    let live = snapshot
        .ptys
        .iter()
        .map(|pty| (pty.id.as_str(), pty))
        .collect::<HashMap<_, _>>();
    let mut candidates = metas
        .values()
        .filter_map(|meta| {
            let stats = live.get(meta.id.as_str())?;
            if meta.visible
                || meta.focused
                || meta.protected
                || meta.status == "working"
                || now.saturating_sub(meta.reported_at_ms) > META_STALE_MS
                || now.saturating_sub(meta.spawned_at_ms) < policy.spawn_grace_seconds * 1000
            {
                return None;
            }
            let idle_minutes = if meta.kind == "shell" {
                policy.hidden_shell_idle_minutes
            } else {
                policy.hidden_agent_idle_minutes
            };
            if now.saturating_sub(meta.last_io_at_ms) < idle_minutes * 60_000 {
                return None;
            }
            Some((
                meta.id.clone(),
                meta.kind != "shell",
                meta.last_used_at_ms,
                stats.effective_memory_mb,
            ))
        })
        .collect::<Vec<_>>();
    candidates.sort_by(|a, b| {
        a.1.cmp(&b.1)
            .then_with(|| a.2.cmp(&b.2))
            .then_with(|| b.3.total_cmp(&a.3))
    });
    candidates.into_iter().map(|entry| entry.0).collect()
}

fn pressure_level(memory: &MemoryStats, previous: &'static str) -> &'static str {
    let total = memory.system_total_mb.max(1.0);
    let available = memory.system_available_mb;
    let critical_at = (total * 0.05).max(512.0);
    let warning_at = (total * 0.10).max(1024.0);

    if available <= critical_at || (previous == "critical" && available <= critical_at * 1.25) {
        "critical"
    } else if available <= warning_at || (previous == "warning" && available <= warning_at * 1.25) {
        "warning"
    } else {
        "normal"
    }
}

fn run_cycle(app: &AppHandle, sessions: &PtySessions, supervisor: &ResourceSupervisor) {
    let mut snapshot = supervisor.collect(sessions);
    let now = snapshot.sampled_at_ms;
    let (policy, metas, previous_level, last_log_at_ms) = {
        let state = supervisor.state.lock().unwrap_or_else(|p| p.into_inner());
        (
            state.policy.clone(),
            state.metas.clone(),
            state.last_level,
            state.last_log_at_ms,
        )
    };
    let candidates = eligible_candidates(&snapshot, &metas, &policy, now);
    let level = pressure_level(&snapshot.memory, previous_level);
    // Suspending is not a pause: the process tree is killed and nothing ever brings it back, so a
    // terminal loses its running agent until it is started again by hand. Doing that to someone who
    // never asked for it is why manual mode has to be honoured even under critical pressure — the
    // warning is what manual mode offers instead.
    let suspended_id = if may_suspend(level, &policy) {
        candidates.first().and_then(|id| {
            match pty::suspend_session_with_reason(app, sessions, id, "memory-pressure") {
                Ok(true) => Some(id.clone()),
                _ => None,
            }
        })
    } else {
        None
    };
    snapshot.pressure = PressureState {
        level,
        spawn_blocked: false,
        automatic: suspended_id.is_some(),
        candidate_count: candidates.len(),
        last_suspended_id: suspended_id.clone(),
    };

    let should_log = previous_level != level
        || suspended_id.is_some()
        || now.saturating_sub(last_log_at_ms) >= RESOURCE_LOG_INTERVAL_MS;
    {
        let mut state = supervisor.state.lock().unwrap_or_else(|p| p.into_inner());
        state.last_level = level;
        if let Some(id) = &suspended_id {
            state.metas.remove(id);
        }
        if should_log {
            state.last_log_at_ms = now;
        }
        state.latest = Some(snapshot.clone());
    }

    if should_log {
        crate::logging::record_resource_snapshot(
            app,
            level,
            &snapshot,
            candidates.len(),
            if suspended_id.is_some() {
                "emergency-suspend"
            } else {
                "none"
            },
        );
    }

    if previous_level != level || suspended_id.is_some() {
        let _ = app.emit(
            "resource://pressure",
            ResourcePressurePayload {
                level,
                total_mb: snapshot.effective_total_mb,
                budget_mb: policy.memory_budget_mb,
                spawn_blocked: false,
                candidate_count: candidates.len(),
                suspended_id,
            },
        );
    }
}

pub fn start(
    app: AppHandle,
    sessions: PtySessions,
    supervisor: std::sync::Arc<ResourceSupervisor>,
) {
    std::thread::spawn(move || loop {
        run_cycle(&app, &sessions, &supervisor);
        std::thread::sleep(SAMPLE_INTERVAL);
    });
}

#[tauri::command]
pub fn set_resource_policy(
    supervisor: State<'_, std::sync::Arc<ResourceSupervisor>>,
    policy: ResourcePolicy,
) {
    let mut state = supervisor.state.lock().unwrap_or_else(|p| p.into_inner());
    state.policy = policy.normalized();
}

#[tauri::command]
pub fn update_pty_runtime_meta(
    sessions: State<'_, PtySessions>,
    supervisor: State<'_, std::sync::Arc<ResourceSupervisor>>,
    metas: Vec<PtyRuntimeMeta>,
) {
    // Visibility is reconciled from this report instead of relying only on set_pty_visible.
    // That call is a no-op when it lands while the session is still spawning or restarting, and
    // an output stream left switched off stays off — the pane accepts keystrokes and renders
    // nothing until it is restarted. Re-asserting the flag every tick heals that within a sample.
    if let Ok(sessions) = sessions.lock() {
        for meta in &metas {
            if let Some(session) = sessions.get(&meta.id) {
                // A silenced pane is indistinguishable from a frozen one, so every flip is
                // recorded: it is the only trace left when a terminal stops showing output.
                let was = session
                    .visible
                    .swap(meta.visible, std::sync::atomic::Ordering::Relaxed);
                if was != meta.visible {
                    let _ = crate::logging::record_app_event(
                        "pty.visibility".to_string(),
                        format!(
                            "id={} visible={} focused={} status={}",
                            meta.id, meta.visible, meta.focused, meta.status
                        ),
                    );
                }
            }
        }
    }

    let mut state = supervisor.state.lock().unwrap_or_else(|p| p.into_inner());
    let ids = metas
        .iter()
        .map(|meta| meta.id.clone())
        .collect::<HashSet<_>>();
    state.metas.retain(|id, _| ids.contains(id));
    for meta in metas {
        state.metas.insert(meta.id.clone(), meta);
    }
}

#[tauri::command]
pub fn get_runtime_snapshot(
    sessions: State<'_, PtySessions>,
    supervisor: State<'_, std::sync::Arc<ResourceSupervisor>>,
) -> RuntimeSnapshot {
    if let Some(snapshot) = supervisor
        .state
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .latest
        .clone()
    {
        return snapshot;
    }
    supervisor.collect(sessions.inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot(id: &str) -> RuntimeSnapshot {
        RuntimeSnapshot {
            sampled_at_ms: 1_000_000,
            memory: MemoryStats {
                total_mb: 1600.0,
                app_mb: 40.0,
                webview_mb: 300.0,
                ptys_mb: 1260.0,
                process_count: 12,
                system_total_mb: 16384.0,
                system_available_mb: 8192.0,
            },
            private_commit_mb: 1700.0,
            effective_total_mb: 1700.0,
            ptys: vec![PtyResourceStats {
                id: id.to_string(),
                root_pid: Some(1),
                command: Some("claude".to_string()),
                cwd: None,
                process_count: 2,
                working_set_mb: 400.0,
                private_commit_mb: 450.0,
                effective_memory_mb: 450.0,
                processes: Vec::new(),
            }],
            pressure: PressureState {
                level: "normal",
                spawn_blocked: false,
                automatic: false,
                candidate_count: 0,
                last_suspended_id: None,
            },
        }
    }

    #[test]
    fn manual_mode_never_terminates_a_session() {
        let policy = ResourcePolicy::default();
        assert_eq!(policy.mode, "manual", "manual is the shipped default");
        for level in ["normal", "warning", "critical"] {
            assert!(
                !may_suspend(level, &policy),
                "at {level} pressure manual mode must warn, never kill"
            );
        }
    }

    #[test]
    fn opting_in_allows_termination_only_when_critical() {
        let policy = ResourcePolicy {
            mode: "smart-lru".to_string(),
            ..ResourcePolicy::default()
        };
        assert!(!may_suspend("normal", &policy));
        assert!(!may_suspend("warning", &policy));
        assert!(may_suspend("critical", &policy));
    }

    fn meta(id: &str) -> PtyRuntimeMeta {
        PtyRuntimeMeta {
            id: id.to_string(),
            kind: "agent".to_string(),
            status: "waiting".to_string(),
            visible: false,
            focused: false,
            protected: false,
            last_io_at_ms: 1,
            spawned_at_ms: 1,
            last_used_at_ms: 1,
            reported_at_ms: 1_000_000,
        }
    }

    #[test]
    fn working_or_visible_agents_are_never_candidates() {
        let policy = ResourcePolicy::default();
        let mut metas = HashMap::from([("a".to_string(), meta("a"))]);
        metas.get_mut("a").unwrap().status = "working".to_string();
        assert!(eligible_candidates(&snapshot("a"), &metas, &policy, 1_000_000).is_empty());
        let meta = metas.get_mut("a").unwrap();
        meta.status = "waiting".to_string();
        meta.visible = true;
        assert!(eligible_candidates(&snapshot("a"), &metas, &policy, 1_000_000).is_empty());
    }

    #[test]
    fn idle_hidden_agent_becomes_candidate() {
        let policy = ResourcePolicy::default();
        let metas = HashMap::from([("a".to_string(), meta("a"))]);
        assert_eq!(
            eligible_candidates(&snapshot("a"), &metas, &policy, 1_000_000),
            vec!["a".to_string()]
        );
    }

    #[test]
    fn spawn_grace_protects_new_runtimes() {
        let policy = ResourcePolicy::default();
        let mut fresh = meta("a");
        fresh.spawned_at_ms = 999_999;
        let metas = HashMap::from([("a".to_string(), fresh)]);
        assert!(eligible_candidates(&snapshot("a"), &metas, &policy, 1_000_000).is_empty());
    }

    #[test]
    fn idle_shells_are_recommended_before_agents() {
        let policy = ResourcePolicy::default();
        let mut sample = snapshot("agent");
        let mut shell_stats = sample.ptys[0].clone();
        shell_stats.id = "shell".to_string();
        sample.ptys.push(shell_stats);
        let mut shell = meta("shell");
        shell.kind = "shell".to_string();
        shell.reported_at_ms = 2_000_000;
        let mut agent = meta("agent");
        agent.reported_at_ms = 2_000_000;
        let metas = HashMap::from([("agent".to_string(), agent), ("shell".to_string(), shell)]);
        assert_eq!(
            eligible_candidates(&sample, &metas, &policy, 2_000_000),
            vec!["shell".to_string(), "agent".to_string()]
        );
    }

    #[test]
    fn pressure_uses_available_system_memory_not_app_usage() {
        let sample = snapshot("a");
        assert_eq!(pressure_level(&sample.memory, "normal"), "normal");
    }

    #[test]
    fn pressure_warns_only_when_windows_memory_is_low() {
        let mut sample = snapshot("a");
        sample.memory.system_available_mb = 1200.0;
        assert_eq!(pressure_level(&sample.memory, "normal"), "warning");
        sample.memory.system_available_mb = 600.0;
        assert_eq!(pressure_level(&sample.memory, "normal"), "critical");
    }

    #[test]
    fn candidate_selection_handles_thousands_of_idle_runtimes() {
        const RUNTIME_COUNT: usize = 5_000;
        let policy = ResourcePolicy::default();
        let mut sample = snapshot("seed");
        sample.ptys.clear();
        let mut metas = HashMap::with_capacity(RUNTIME_COUNT);

        for index in 0..RUNTIME_COUNT {
            let id = if index % 2 == 0 {
                format!("shell-{index}")
            } else {
                format!("agent-{index}")
            };
            let mut runtime_meta = meta(&id);
            runtime_meta.reported_at_ms = 2_000_000;
            runtime_meta.kind = if index % 2 == 0 {
                "shell".to_string()
            } else {
                "agent".to_string()
            };
            let mut stats = snapshot(&id).ptys.remove(0);
            stats.id = id.clone();
            stats.effective_memory_mb = 100.0 + (index % 100) as f64;
            sample.ptys.push(stats);
            metas.insert(id, runtime_meta);
        }

        let candidates = eligible_candidates(&sample, &metas, &policy, 2_000_000);

        assert_eq!(candidates.len(), RUNTIME_COUNT);
        assert!(candidates[..RUNTIME_COUNT / 2]
            .iter()
            .all(|id| id.starts_with("shell-")));
        assert!(candidates[RUNTIME_COUNT / 2..]
            .iter()
            .all(|id| id.starts_with("agent-")));
    }
}
