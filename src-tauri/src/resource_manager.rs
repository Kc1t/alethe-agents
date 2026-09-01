use crate::event_bus;
use crate::stats;
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::hash::Hash;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

// ── Memory Thresholds (MB de RAM livre) ──────────────────────────────────
const MEM_OK_RESET: f64 = 2.5 * 1024.0;
const MEM_LOW_THRESHOLD: f64 = 2.0 * 1024.0;
const MEM_MEDIUM_RESET: f64 = 1.5 * 1024.0;
const MEM_MEDIUM_THRESHOLD: f64 = 1.0 * 1024.0;
const MEM_HIGH_RESET: f64 = 1024.0;
const MEM_HIGH_THRESHOLD: f64 = 512.0;
const MEM_CRITICAL_RESET: f64 = 512.0;
const MEM_CRITICAL_THRESHOLD: f64 = 256.0;

// ── Cooldowns (segundos) ─────────────────────────────────────────────────
const COOLDOWN_LOW_SECS: u64 = 15;
const COOLDOWN_MEDIUM_SECS: u64 = 30;
const COOLDOWN_HIGH_SECS: u64 = 60;
const COOLDOWN_CRITICAL_SECS: u64 = 60;
const COOLDOWN_OK_SECS: u64 = 10;

// ── Polling ──────────────────────────────────────────────────────────────
const POLL_INTERVAL_MS: u64 = 5000;

static RUNNING: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
pub enum MemoryPressureLevel {
    Ok,
    Low,
    Medium,
    High,
    Critical,
}

#[derive(Clone, Serialize)]
pub struct ResourceMetrics {
    pub memory_pressure: MemoryPressureLevel,
    pub system_available_mb: f64,
    pub system_total_mb: f64,
    pub app_mb: f64,
    pub webview_mb: f64,
    pub ptys_mb: f64,
    pub process_count: usize,
    pub policy_trigger_count: u64,
}

// ── Task Priority ────────────────────────────────────────────────────────
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum TaskPriority {
    Idle = 0,
    Low = 1,
    Medium = 2,
    High = 3,
}

#[allow(dead_code)]
pub struct ScheduledTask {
    pub priority: TaskPriority,
    pub description: &'static str,
    pub action: Box<dyn FnOnce() + Send>,
    pub cancel_key: Option<String>,
}

impl ScheduledTask {
    #[allow(dead_code)]
    pub fn new(
        priority: TaskPriority,
        description: &'static str,
        action: impl FnOnce() + Send + 'static,
    ) -> Self {
        Self {
            priority,
            description,
            action: Box::new(action),
            cancel_key: None,
        }
    }

    #[allow(dead_code)]
    pub fn with_cancel_key(mut self, key: &str) -> Self {
        self.cancel_key = Some(key.to_string());
        self
    }
}

// ── Global State ─────────────────────────────────────────────────────────
#[allow(dead_code)]
struct ResourceState {
    pressure: MemoryPressureLevel,
    cooldowns: HashMap<MemoryPressureLevel, Instant>,
    trigger_count: u64,
    task_queue: VecDeque<ScheduledTask>,
    running: bool,
}

static RESOURCE_STATE: OnceLock<Mutex<ResourceState>> = OnceLock::new();

fn state() -> &'static Mutex<ResourceState> {
    RESOURCE_STATE.get_or_init(|| {
        Mutex::new(ResourceState {
            pressure: MemoryPressureLevel::Ok,
            cooldowns: std::collections::HashMap::new(),
            trigger_count: 0,
            task_queue: VecDeque::new(),
            running: false,
        })
    })
}

// ── Policy Engine ────────────────────────────────────────────────────────

fn evaluate_memory_pressure(available_mb: f64) -> MemoryPressureLevel {
    if available_mb < MEM_CRITICAL_THRESHOLD {
        MemoryPressureLevel::Critical
    } else if available_mb < MEM_HIGH_THRESHOLD {
        MemoryPressureLevel::High
    } else if available_mb < MEM_MEDIUM_THRESHOLD {
        MemoryPressureLevel::Medium
    } else if available_mb < MEM_LOW_THRESHOLD {
        MemoryPressureLevel::Low
    } else {
        MemoryPressureLevel::Ok
    }
}

fn hysteresis_reset(current: MemoryPressureLevel, available_mb: f64) -> MemoryPressureLevel {
    match current {
        MemoryPressureLevel::Critical if available_mb >= MEM_CRITICAL_RESET => {
            MemoryPressureLevel::High
        }
        MemoryPressureLevel::High if available_mb >= MEM_HIGH_RESET => MemoryPressureLevel::Medium,
        MemoryPressureLevel::Medium if available_mb >= MEM_MEDIUM_RESET => MemoryPressureLevel::Low,
        MemoryPressureLevel::Low if available_mb >= MEM_OK_RESET => MemoryPressureLevel::Ok,
        _ => current,
    }
}

fn cooldown_for(level: MemoryPressureLevel) -> Duration {
    match level {
        MemoryPressureLevel::Critical => Duration::from_secs(COOLDOWN_CRITICAL_SECS),
        MemoryPressureLevel::High => Duration::from_secs(COOLDOWN_HIGH_SECS),
        MemoryPressureLevel::Medium => Duration::from_secs(COOLDOWN_MEDIUM_SECS),
        MemoryPressureLevel::Low => Duration::from_secs(COOLDOWN_LOW_SECS),
        MemoryPressureLevel::Ok => Duration::from_secs(COOLDOWN_OK_SECS),
    }
}

// ── Task Scheduler ───────────────────────────────────────────────────────

pub fn enqueue_task(task: ScheduledTask) {
    if let Ok(mut s) = state().lock() {
        // Cancela tarefa obsoleta com a mesma cancel_key
        if let Some(ref key) = task.cancel_key {
            s.task_queue
                .retain(|t| t.cancel_key.as_deref() != Some(key));
        }
        s.task_queue.push_back(task);
    }
}

fn drain_queue() {
    let tasks: Vec<ScheduledTask> = {
        let mut s = state().lock().unwrap();
        let mut vec: Vec<ScheduledTask> = s.task_queue.drain(..).collect();
        // Ordena por prioridade (maior primeiro)
        vec.sort_by_key(|t| std::cmp::Reverse(t.priority));
        vec
    };

    for task in tasks {
        (task.action)();
    }
}

// ── Metrics Publishing ───────────────────────────────────────────────────

fn publish_metrics(app: &AppHandle, metrics: &ResourceMetrics) {
    let payload = serde_json::json!({
        "memory_pressure": metrics.memory_pressure,
        "system_available_mb": metrics.system_available_mb,
        "system_total_mb": metrics.system_total_mb,
        "app_mb": metrics.app_mb,
        "webview_mb": metrics.webview_mb,
        "ptys_mb": metrics.ptys_mb,
        "process_count": metrics.process_count,
        "policy_trigger_count": metrics.policy_trigger_count,
    });
    let _ = app.emit("resource://metrics", &payload);
    event_bus::publish_event_simple(
        "ResourceMetricsUpdated",
        "resource-manager",
        None,
        None,
        payload,
    );
}

fn tick(app: &AppHandle) {
    let mem = stats::collect_memory_stats();
    let available_mb = mem.system_available_mb;

    let mut s = state().lock().unwrap();
    let raw = evaluate_memory_pressure(available_mb);
    let candidate = if raw != s.pressure {
        hysteresis_reset(s.pressure, available_mb)
    } else {
        raw
    };

    let new_pressure = if (candidate as u8) > (s.pressure as u8) {
        candidate
    } else if (candidate as u8) < (s.pressure as u8) {
        if (raw as u8) < (s.pressure as u8) {
            candidate
        } else {
            s.pressure
        }
    } else {
        candidate
    };

    let now = Instant::now();
    let cooldown_ok = s
        .cooldowns
        .get(&new_pressure)
        .map(|cooldown_until| now >= *cooldown_until)
        .unwrap_or(true);

    if new_pressure != s.pressure && cooldown_ok {
        s.pressure = new_pressure;
        s.trigger_count += 1;
        s.cooldowns
            .insert(new_pressure, now + cooldown_for(new_pressure));

        let handle = app.clone();
        match new_pressure {
            MemoryPressureLevel::Low => {
                enqueue_task(
                    ScheduledTask::new(
                        TaskPriority::Medium,
                        "hibernate-idle-terminals",
                        move || {
                            let _ = handle.emit("resource://hibernate-idle", "");
                        },
                    )
                    .with_cancel_key("hibernate-idle"),
                );
            }
            MemoryPressureLevel::Medium => {
                enqueue_task(
                    ScheduledTask::new(TaskPriority::High, "webview-low-memory", move || {
                        #[cfg(windows)]
                        if let Err(e) = crate::windows_webview::set_memory_mode(true) {
                            eprintln!("[ResourceManager] WebView low-memory failed: {e}");
                        }
                        let _ = handle.emit("resource://webview-low-memory", "");
                    })
                    .with_cancel_key("webview-low-memory"),
                );
            }
            MemoryPressureLevel::High => {
                enqueue_task(
                    ScheduledTask::new(TaskPriority::High, "reduce-pool-limit", move || {
                        let _ = handle.emit("resource://reduce-pool", "");
                    })
                    .with_cancel_key("reduce-pool"),
                );
            }
            MemoryPressureLevel::Critical => {
                enqueue_task(
                    ScheduledTask::new(TaskPriority::High, "drop-caches-gc", move || {
                        let _ = handle.emit("resource://drop-caches", "");
                    })
                    .with_cancel_key("drop-caches"),
                );
            }
            MemoryPressureLevel::Ok => {}
        }
    }

    drain_queue();

    let metrics = ResourceMetrics {
        memory_pressure: s.pressure,
        policy_trigger_count: s.trigger_count,
        system_available_mb: mem.system_available_mb,
        system_total_mb: mem.system_total_mb,
        app_mb: mem.app_mb,
        webview_mb: mem.webview_mb,
        ptys_mb: mem.ptys_mb,
        process_count: mem.process_count,
    };

    drop(s);
    publish_metrics(app, &metrics);
}

// ── Start (chamado do setup) ─────────────────────────────────────────────

pub fn start(app: AppHandle) {
    if RUNNING.load(Ordering::SeqCst) {
        return;
    }
    RUNNING.store(true, Ordering::SeqCst);

    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_millis(POLL_INTERVAL_MS));
        interval.tick().await; // primeiro tick imediato

        loop {
            interval.tick().await;
            tick(&app);
        }
    });
}

// ── Tauri Commands ───────────────────────────────────────────────────────

#[tauri::command]
pub fn get_resource_metrics() -> ResourceMetrics {
    let mem = stats::collect_memory_stats();
    let s = state().lock().unwrap();
    ResourceMetrics {
        memory_pressure: s.pressure,
        system_available_mb: mem.system_available_mb,
        system_total_mb: mem.system_total_mb,
        app_mb: mem.app_mb,
        webview_mb: mem.webview_mb,
        ptys_mb: mem.ptys_mb,
        process_count: mem.process_count,
        policy_trigger_count: s.trigger_count,
    }
}
