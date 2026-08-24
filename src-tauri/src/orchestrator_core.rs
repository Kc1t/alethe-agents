//! Delegation core: queue, workers and the MCP tool surface.
//!
//! Deliberately free of Tauri and of anything else in this crate. The app layer supplies a
//! launcher and an optional observer; everything else here is plain `std` + `serde_json`, which
//! is what lets `tests/orchestrator.rs` compile this file directly instead of linking the GUI
//! stack a Rust test binary cannot load.

use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Map, Value};

const DEFAULT_MAX_CONCURRENT: usize = 4;
const MAX_WAIT_MS: u64 = 600_000;
const REPLY_LIMIT: usize = 16_000;

pub const STATUS_QUEUED: &str = "queued";
pub const STATUS_RUNNING: &str = "running";
pub const STATUS_DONE: &str = "done";
pub const STATUS_FAILED: &str = "failed";
pub const STATUS_CANCELLED: &str = "cancelled";
pub const STATUS_RELEASED: &str = "released";
/// Its process died with the app, but Codex keeps the thread on disk, so the worker can be brought
/// back with everything it had read still in context.
pub const STATUS_INTERRUPTED: &str = "interrupted";

pub type Observer = Arc<dyn Fn(Value) + Send + Sync>;

/// How to start one worker. The app layer resolves this once; the core never guesses.
#[derive(Clone, Debug)]
pub struct Launcher {
    /// Which CLI this launcher starts, so the UI can say who did the work.
    pub kind: String,
    pub program: PathBuf,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
}

impl Launcher {
    pub fn codex_app_server(program: PathBuf) -> Self {
        Self {
            kind: "codex".into(),
            program,
            args: vec!["app-server".into(), "--stdio".into()],
            env: Vec::new(),
        }
    }
}

/// A worker runs its commands inside Codex's sandbox, which uses a lowered token that cannot start
/// anything installed from the Microsoft Store: the launch fails with access denied before the
/// command runs, so the worker can write files but never run a build or a test. Dropping the Store
/// aliases from its PATH leaves it on the system shell, which the sandbox can start. This narrows
/// only what the worker sees, not what it is allowed to touch.
pub fn path_without_store_aliases(path: &str) -> String {
    path.split(';')
        .filter(|entry| !entry.is_empty() && !entry.to_ascii_lowercase().contains("\\windowsapps"))
        .collect::<Vec<_>>()
        .join(";")
}

const DEFAULT_JOB_TIMEOUT_MS: u64 = 900_000;

/// Finished workers stay alive so the lead can follow up on what they just did, but each one holds
/// a process, so only the most recent few are kept and older ones are let go.
const PARKED_LIMIT: usize = 4;

fn git(cwd: &std::path::Path, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(|error| format!("git not available: {error}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// A detached worktree per job, parked next to the repository rather than inside it, so parallel
/// workers editing the same files cannot overwrite each other. It is left in place on purpose:
/// the work still has to be reviewed and merged.
fn isolate_worktree(cwd: &str, job_id: &str) -> Result<String, String> {
    let origin = PathBuf::from(cwd);
    let root = git(&origin, &["rev-parse", "--show-toplevel"])?;
    let root = PathBuf::from(root.replace('/', std::path::MAIN_SEPARATOR_STR));
    let name = root
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| "repo".to_string());
    let parent = root
        .parent()
        .ok_or_else(|| "repository has no parent directory".to_string())?;
    let target = parent
        .join(".alethe-worktrees")
        .join(&name)
        .join(format!("{job_id}-{}", now_ms()));
    if let Some(dir) = target.parent() {
        std::fs::create_dir_all(dir).map_err(|error| error.to_string())?;
    }
    git(
        &root,
        &[
            "worktree",
            "add",
            "--detach",
            &target.to_string_lossy(),
            "HEAD",
        ],
    )?;
    Ok(target.to_string_lossy().into_owned())
}

/// `job-07` -> 7, so restored ids never collide with new ones.
fn trailing_number(id: &str) -> u64 {
    id.rsplit('-')
        .next()
        .and_then(|tail| tail.parse::<u64>().ok())
        .unwrap_or(0)
}

/// Keeps the end of a long text: a worker's conclusion is the last thing it says, never the first.
fn tail(text: &str, limit: usize) -> String {
    let trimmed = text.trim();
    let count = trimmed.chars().count();
    if count <= limit {
        return trimmed.to_string();
    }
    trimmed.chars().skip(count - limit).collect()
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis() as u64)
        .unwrap_or_default()
}

/// The agent session that called the tools. Alethe writes one MCP config per terminal, so the
/// request carries the terminal's own id and the app can say which session a run belongs to.
#[derive(Clone)]
pub struct Planner {
    pub id: String,
    pub label: String,
    pub agent: String,
}

struct Job {
    id: String,
    planner_id: Option<String>,
    agent: String,
    run_id: String,
    run_label: Option<String>,
    spec: String,
    cwd: String,
    status: String,
    thread_id: Option<String>,
    active_turn_id: Option<String>,
    reply: String,
    /// The worker's last finished message. `reply` is the live stream, which opens with narration
    /// and only reaches the conclusion at the end, so the two are not the same thing.
    report: String,
    plan: Vec<String>,
    diff: Option<String>,
    tokens: Option<Value>,
    outcome: Option<String>,
    started_at: Option<u64>,
    ended_at: Option<u64>,
    worktree: Option<String>,
    timeout_ms: Option<u64>,
    child: Option<Arc<Mutex<Child>>>,
    stdin: Option<Arc<Mutex<ChildStdin>>>,
    inbox: VecDeque<String>,
    next_request_id: i64,
}

impl Job {
    fn snapshot(&self) -> Value {
        let elapsed = match (self.started_at, self.ended_at) {
            (Some(start), Some(end)) => Some(end.saturating_sub(start) as f64 / 1000.0),
            (Some(start), None) => Some(now_ms().saturating_sub(start) as f64 / 1000.0),
            _ => None,
        };
        json!({
            "id": self.id,
            "plannerId": self.planner_id,
            "agent": self.agent,
            "runId": self.run_id,
            "runLabel": self.run_label,
            "spec": self.spec,
            "cwd": self.cwd,
            "status": self.status,
            "threadId": self.thread_id,
            "outcome": self.outcome,
            "seconds": elapsed,
            "plan": self.plan,
            "tokens": self.tokens,
            "worktree": self.worktree,
            "hasDiff": self.diff.is_some(),
            "summary": tail(if self.report.is_empty() { &self.reply } else { &self.report }, 1200),
        })
    }

    fn record(&self) -> Value {
        json!({
            "id": self.id,
            "plannerId": self.planner_id,
            "agent": self.agent,
            "runId": self.run_id,
            "runLabel": self.run_label,
            "spec": self.spec,
            "cwd": self.cwd,
            "status": self.status,
            "threadId": self.thread_id,
            "outcome": self.outcome,
            "plan": self.plan,
            "worktree": self.worktree,
            "summary": self.report,
            "startedAt": self.started_at,
            "endedAt": self.ended_at,
        })
    }

    fn from_record(value: &Value) -> Option<Self> {
        let text = |key: &str| value.get(key).and_then(Value::as_str).map(ToOwned::to_owned);
        let status = text("status").unwrap_or_else(|| STATUS_DONE.to_string());
        // Work that was in flight did not finish and its process is gone. Restoring it as running
        // would show a live worker that does not exist.
        let status = match status.as_str() {
            STATUS_RUNNING | STATUS_QUEUED => STATUS_INTERRUPTED.to_string(),
            _ => status,
        };
        Some(Self {
            id: text("id")?,
            planner_id: text("plannerId"),
            agent: text("agent").unwrap_or_else(|| "codex".to_string()),
            run_id: text("runId").unwrap_or_else(|| "run-00".to_string()),
            run_label: text("runLabel"),
            spec: text("spec").unwrap_or_default(),
            cwd: text("cwd").unwrap_or_default(),
            status,
            thread_id: text("threadId"),
            active_turn_id: None,
            reply: String::new(),
            report: text("summary").unwrap_or_default(),
            plan: value
                .get("plan")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(Value::as_str)
                        .map(ToOwned::to_owned)
                        .collect()
                })
                .unwrap_or_default(),
            diff: None,
            tokens: None,
            outcome: text("outcome"),
            started_at: value.get("startedAt").and_then(Value::as_u64),
            ended_at: value.get("endedAt").and_then(Value::as_u64),
            worktree: text("worktree"),
            timeout_ms: Some(DEFAULT_JOB_TIMEOUT_MS),
            child: None,
            stdin: None,
            inbox: VecDeque::new(),
            next_request_id: 10,
        })
    }

    fn settled(&self) -> bool {
        matches!(
            self.status.as_str(),
            STATUS_DONE | STATUS_FAILED | STATUS_CANCELLED | STATUS_RELEASED | STATUS_INTERRUPTED
        )
    }

    fn teardown(&mut self) {
        if let Some(child) = self.child.take() {
            if let Ok(mut child) = child.lock() {
                let _ = child.kill();
                // Without the wait the killed worker is never reaped and stays as a zombie.
                let _ = child.wait();
            }
        }
        self.stdin = None;
    }
}

struct Delivery {
    seq: u64,
    kind: String,
    job_id: String,
    outcome: Option<String>,
    text: String,
}

impl Delivery {
    fn to_value(&self) -> Value {
        json!({
            "seq": self.seq,
            "type": self.kind,
            "jobId": self.job_id,
            "outcome": self.outcome,
            "text": self.text,
        })
    }
}

#[derive(Default)]
struct Inner {
    jobs: HashMap<String, Job>,
    order: Vec<String>,
    queue: VecDeque<String>,
    deliveries: VecDeque<Delivery>,
    seq: u64,
    running: usize,
    max_concurrent: usize,
    job_counter: u64,
    run_counter: u64,
    planners: HashMap<String, Planner>,
}

impl Inner {
    fn snapshot(&self) -> Value {
        let jobs: Vec<Value> = self
            .order
            .iter()
            .filter_map(|id| self.jobs.get(id))
            .map(Job::snapshot)
            .collect();
        let planners: Vec<Value> = self
            .planners
            .values()
            .map(|planner| {
                json!({ "id": planner.id, "label": planner.label, "agent": planner.agent })
            })
            .collect();
        json!({
            "jobs": jobs,
            "planners": planners,
            "running": self.running,
            "queued": self.queue.len(),
            "concurrencyLimit": self.max_concurrent
        })
    }

    fn push_delivery(&mut self, kind: &str, job_id: &str, outcome: Option<String>, text: String) {
        self.seq += 1;
        let seq = self.seq;
        self.deliveries.push_back(Delivery {
            seq,
            kind: kind.to_string(),
            job_id: job_id.to_string(),
            outcome,
            text,
        });
    }
}

#[derive(Clone)]
pub struct Core {
    inner: Arc<Mutex<Inner>>,
    signal: Arc<Condvar>,
    launcher: Arc<Mutex<Option<Launcher>>>,
    observer: Arc<Mutex<Option<Observer>>>,
    dispatch: Arc<Mutex<Option<Sender<Value>>>>,
    store: Arc<Mutex<Option<PathBuf>>>,
}

impl Default for Core {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner {
                max_concurrent: DEFAULT_MAX_CONCURRENT,
                ..Inner::default()
            })),
            signal: Arc::new(Condvar::new()),
            launcher: Arc::new(Mutex::new(None)),
            observer: Arc::new(Mutex::new(None)),
            dispatch: Arc::new(Mutex::new(None)),
            store: Arc::new(Mutex::new(None)),
        }
    }
}

fn guard<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    match mutex.lock() {
        Ok(value) => value,
        Err(poisoned) => poisoned.into_inner(),
    }
}

fn send_rpc(stdin: &Arc<Mutex<ChildStdin>>, value: &Value) -> Result<(), String> {
    let mut stdin = guard(stdin);
    serde_json::to_writer(&mut *stdin, value).map_err(|error| error.to_string())?;
    stdin.write_all(b"\n").map_err(|error| error.to_string())?;
    stdin.flush().map_err(|error| error.to_string())
}

/// Builds a request without sending it. Writing to a worker's stdin blocks once that pipe fills, so
/// doing it under the orchestrator lock would let one stuck worker freeze every other job. Callers
/// stage the request, release the lock, and only then hand it to `send_rpc`.
fn stage_rpc(
    inner: &mut Inner,
    job_id: &str,
    method: &str,
    params: Value,
) -> Result<(Arc<Mutex<ChildStdin>>, Value), String> {
    let job = inner
        .jobs
        .get_mut(job_id)
        .ok_or_else(|| format!("unknown job {job_id}"))?;
    let stdin = job
        .stdin
        .clone()
        .ok_or_else(|| format!("job {job_id} has no live worker"))?;
    job.next_request_id += 1;
    let id = job.next_request_id;
    Ok((
        stdin,
        json!({ "id": id, "method": method, "params": params }),
    ))
}

/// Pops the next queued message for a worker and turns it into a fresh turn on its own thread, so
/// the follow-up keeps everything the worker already read.
fn next_from_inbox(
    inner: &mut Inner,
    job_id: &str,
) -> Option<(Arc<Mutex<ChildStdin>>, Value)> {
    let job = inner.jobs.get_mut(job_id)?;
    if job.stdin.is_none() {
        return None;
    }
    let thread_id = job.thread_id.clone()?;
    let message = job.inbox.pop_front()?;
    stage_rpc(
        inner,
        job_id,
        "turn/start",
        json!({
            "threadId": thread_id,
            "input": [{ "type": "text", "text": message }],
            "approvalPolicy": "never"
        }),
    )
    .ok()
}

/// Finished workers are kept so the lead can follow up, but each one is a live process. Past the
/// limit the least recently finished is let go; its record stays, only the process is gone.
fn release_oldest_parked(inner: &mut Inner) {
    loop {
        let parked: Vec<String> = inner
            .order
            .iter()
            .filter(|id| {
                inner
                    .jobs
                    .get(*id)
                    .is_some_and(|job| job.settled() && job.stdin.is_some())
            })
            .cloned()
            .collect();
        if parked.len() <= PARKED_LIMIT {
            return;
        }
        let Some(oldest) = parked.first().cloned() else {
            return;
        };
        if let Some(job) = inner.jobs.get_mut(&oldest) {
            job.teardown();
            job.status = STATUS_RELEASED.to_string();
        }
    }
}

impl Core {
    /// Called once per agent terminal, so a run can name the session that asked for it.
    pub fn register_planner(&self, planner: Planner) {
        {
            let mut inner = guard(&self.inner);
            inner.planners.insert(planner.id.clone(), planner);
            self.notify(&inner);
        }
        self.persist();
    }

    /// Points the core at the file that outlives the app. Loading is separate so the caller decides
    /// whether a fresh instance should adopt the previous session's history.
    pub fn set_store(&self, path: PathBuf) {
        *guard(&self.store) = Some(path);
    }

    pub fn restore(&self) {
        let Some(path) = guard(&self.store).clone() else {
            return;
        };
        let Ok(bytes) = std::fs::read(&path) else {
            return;
        };
        let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
            return;
        };
        let mut inner = guard(&self.inner);
        for record in value.get("jobs").and_then(Value::as_array).unwrap_or(&vec![]) {
            let Some(job) = Job::from_record(record) else {
                continue;
            };
            let id = job.id.clone();
            inner.job_counter = inner.job_counter.max(trailing_number(&id));
            inner.run_counter = inner.run_counter.max(trailing_number(&job.run_id));
            inner.order.push(id.clone());
            inner.jobs.insert(id, job);
        }
        for record in value
            .get("planners")
            .and_then(Value::as_array)
            .unwrap_or(&vec![])
        {
            let text = |key: &str| record.get(key).and_then(Value::as_str).map(ToOwned::to_owned);
            let Some(id) = text("id") else { continue };
            inner.planners.insert(
                id.clone(),
                Planner {
                    label: text("label").unwrap_or_else(|| id.clone()),
                    agent: text("agent").unwrap_or_default(),
                    id,
                },
            );
        }
        self.notify(&inner);
    }

    /// Written on the transitions that matter rather than on every token update, which streams.
    fn persist(&self) {
        let Some(path) = guard(&self.store).clone() else {
            return;
        };
        let payload = {
            let inner = guard(&self.inner);
            json!({
                "version": 1,
                "jobs": inner
                    .order
                    .iter()
                    .filter_map(|id| inner.jobs.get(id))
                    .map(Job::record)
                    .collect::<Vec<_>>(),
                "planners": inner
                    .planners
                    .values()
                    .map(|planner| json!({
                        "id": planner.id,
                        "label": planner.label,
                        "agent": planner.agent
                    }))
                    .collect::<Vec<_>>(),
            })
        };
        let Ok(bytes) = serde_json::to_vec_pretty(&payload) else {
            return;
        };
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let temp = path.with_extension("json.tmp");
        if std::fs::write(&temp, &bytes).is_ok() {
            let _ = std::fs::rename(&temp, &path);
        }
    }

    pub fn set_launcher(&self, launcher: Launcher) {
        *guard(&self.launcher) = Some(launcher);
    }

    pub fn set_observer(&self, observer: Observer) {
        *guard(&self.observer) = Some(observer.clone());
        let (sender, receiver) = channel::<Value>();
        *guard(&self.dispatch) = Some(sender);
        thread::spawn(move || {
            while let Ok(snapshot) = receiver.recv() {
                observer(snapshot);
            }
        });
    }

    pub fn set_concurrency_limit(&self, limit: usize) {
        guard(&self.inner).max_concurrent = limit.clamp(1, 16);
    }

    pub fn snapshot(&self) -> Value {
        guard(&self.inner).snapshot()
    }

    /// Running and queued counts, for tests and for the UI.
    pub fn counts(&self) -> (usize, usize) {
        let inner = guard(&self.inner);
        (inner.running, inner.queue.len())
    }

    /// Every caller holds the lock, so the observer must not run here: it belongs to the app layer
    /// and whatever it does - emitting to a webview, in practice - would block every other job for
    /// as long as it took. Snapshots go to a channel instead, and one thread delivers them in order.
    fn notify(&self, inner: &Inner) {
        let sender = guard(&self.dispatch).clone();
        if let Some(sender) = sender {
            let _ = sender.send(inner.snapshot());
        }
    }

    fn spawn_worker(&self, job_id: &str) {
        let (cwd, spec, resume_thread) = {
            let mut inner = guard(&self.inner);
            let Some(job) = inner.jobs.get_mut(job_id) else {
                return;
            };
            job.status = STATUS_RUNNING.to_string();
            job.started_at = Some(now_ms());
            job.ended_at = None;
            // Work that arrived while the worker was down leads; otherwise this is its first turn.
            let first_turn = job.inbox.pop_front().unwrap_or_else(|| job.spec.clone());
            let trio = (job.cwd.clone(), first_turn, job.thread_id.clone());
            inner.running += 1;
            trio
        };

        let Some(launcher) = guard(&self.launcher).clone() else {
            self.settle(job_id, STATUS_FAILED, "failed", "no worker launcher configured");
            return;
        };

        let mut command = Command::new(&launcher.program);
        command
            .args(&launcher.args)
            .current_dir(PathBuf::from(&cwd))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        for (key, value) in &launcher.env {
            command.env(key, value);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }

        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                self.settle(
                    job_id,
                    STATUS_FAILED,
                    "failed",
                    &format!("worker spawn failed: {error}"),
                );
                return;
            }
        };

        let stdin = match child.stdin.take() {
            Some(stdin) => Arc::new(Mutex::new(stdin)),
            None => {
                let _ = child.kill();
                self.settle(job_id, STATUS_FAILED, "failed", "worker has no stdin");
                return;
            }
        };
        let stdout = child.stdout.take();
        let child = Arc::new(Mutex::new(child));

        {
            let mut inner = guard(&self.inner);
            if let Some(job) = inner.jobs.get_mut(job_id) {
                job.child = Some(Arc::clone(&child));
                job.stdin = Some(Arc::clone(&stdin));
            }
            self.notify(&inner);
        }

        let _ = send_rpc(
            &stdin,
            &json!({
                "id": 1,
                "method": "initialize",
                "params": { "clientInfo": { "name": "alethe-orchestrator", "title": "Alethe", "version": "1" } }
            }),
        );
        let _ = send_rpc(&stdin, &json!({ "method": "initialized" }));
        // Codex keeps threads on disk, so a worker whose process died can pick up its own history
        // instead of reading everything again.
        let opening = match &resume_thread {
            Some(thread_id) => json!({
                "id": 2,
                "method": "thread/resume",
                "params": { "threadId": thread_id, "cwd": cwd }
            }),
            None => json!({
                "id": 2,
                "method": "thread/start",
                "params": { "cwd": cwd, "approvalPolicy": "never", "sandbox": "workspace-write" }
            }),
        };
        let _ = send_rpc(&stdin, &opening);

        let timeout_ms = guard(&self.inner)
            .jobs
            .get(job_id)
            .and_then(|job| job.timeout_ms);
        if let Some(timeout_ms) = timeout_ms {
            self.arm_watchdog(job_id, timeout_ms);
        }

        if let Some(stdout) = stdout {
            let core = self.clone();
            let owned_id = job_id.to_string();
            let stdin = Arc::clone(&stdin);
            thread::spawn(move || {
                for line in BufReader::new(stdout).lines() {
                    let Ok(line) = line else { break };
                    if line.trim().is_empty() {
                        continue;
                    }
                    let Ok(message) = serde_json::from_str::<Value>(&line) else {
                        continue;
                    };
                    core.on_worker_message(&owned_id, &stdin, &spec, &message);
                }
                core.finish(
                    &owned_id,
                    STATUS_FAILED,
                    Some("failed".into()),
                    "worker connection closed".into(),
                    true,
                );
            });
        }
    }

    /// A worker that never finishes its turn would otherwise hold a slot forever, so the budget
    /// is enforced here rather than left to the lead remembering to cancel.
    fn arm_watchdog(&self, job_id: &str, timeout_ms: u64) {
        let core = self.clone();
        let job_id = job_id.to_string();
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(timeout_ms));
            let payload = {
                let inner = guard(&core.inner);
                let Some(job) = inner.jobs.get(&job_id) else {
                    return;
                };
                if job.settled() {
                    return;
                }
                match (job.thread_id.clone(), job.active_turn_id.clone()) {
                    (Some(thread_id), Some(turn_id)) => {
                        Some(json!({ "threadId": thread_id, "turnId": turn_id }))
                    }
                    _ => None,
                }
            };
            if let Some(payload) = payload {
                let staged = {
                    let mut inner = guard(&core.inner);
                    stage_rpc(&mut inner, &job_id, "turn/interrupt", payload)
                };
                if let Ok((stdin, request)) = staged {
                    let _ = send_rpc(&stdin, &request);
                }
            }
            core.finish(
                &job_id,
                STATUS_FAILED,
                Some("timeout".into()),
                format!("worker passed its {}s budget and was stopped", timeout_ms / 1000),
                true,
            );
        });
    }

    fn settle(&self, job_id: &str, status: &str, outcome: &str, text: &str) {
        self.finish(
            job_id,
            status,
            Some(outcome.to_string()),
            text.to_string(),
            true,
        );
    }

    fn on_worker_message(
        &self,
        job_id: &str,
        stdin: &Arc<Mutex<ChildStdin>>,
        spec: &str,
        message: &Value,
    ) {
        let method = message.get("method").and_then(Value::as_str).unwrap_or("");
        let params = message.get("params").cloned().unwrap_or(Value::Null);
        let result = message.get("result").cloned().unwrap_or(Value::Null);

        if message.get("id").and_then(Value::as_i64) == Some(2) {
            let thread_id = result
                .get("thread")
                .and_then(|thread| thread.get("id"))
                .and_then(Value::as_str)
                .map(ToOwned::to_owned);
            if let Some(thread_id) = thread_id {
                {
                    let mut inner = guard(&self.inner);
                    if let Some(job) = inner.jobs.get_mut(job_id) {
                        job.thread_id = Some(thread_id.clone());
                    }
                    self.notify(&inner);
                }
                let _ = send_rpc(
                    stdin,
                    &json!({
                        "id": 3,
                        "method": "turn/start",
                        "params": {
                            "threadId": thread_id,
                            "input": [{ "type": "text", "text": spec }],
                            "approvalPolicy": "never"
                        }
                    }),
                );
            }
            return;
        }

        if method.ends_with("requestApproval") {
            if let Some(id) = message.get("id") {
                let _ = send_rpc(
                    stdin,
                    &json!({ "id": id, "result": { "decision": "accept" } }),
                );
            }
            return;
        }

        let mut inner = guard(&self.inner);
        let Some(job) = inner.jobs.get_mut(job_id) else {
            return;
        };

        match method {
            "turn/started" => {
                job.active_turn_id = params
                    .get("turn")
                    .and_then(|turn| turn.get("id"))
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned);
            }
            "item/completed" => {
                let item = params.get("item");
                let is_message = item
                    .and_then(|item| item.get("type"))
                    .and_then(Value::as_str)
                    == Some("agentMessage");
                if is_message {
                    let text = item
                        .and_then(|item| item.get("text"))
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .trim();
                    if !text.is_empty() {
                        job.report = text.to_string();
                    }
                }
            }
            "item/agentMessage/delta" => {
                if let Some(delta) = params.get("delta").and_then(Value::as_str) {
                    job.reply.push_str(delta);
                    if job.reply.len() > REPLY_LIMIT {
                        let cut = job.reply.len() - REPLY_LIMIT;
                        job.reply = job.reply.split_off(cut);
                    }
                }
                return;
            }
            "turn/plan/updated" => {
                job.plan = params
                    .get("plan")
                    .and_then(Value::as_array)
                    .map(|steps| {
                        steps
                            .iter()
                            .filter_map(|step| step.get("step").and_then(Value::as_str))
                            .map(ToOwned::to_owned)
                            .collect()
                    })
                    .unwrap_or_default();
            }
            "turn/diff/updated" => {
                job.diff = params
                    .get("diff")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned);
            }
            "thread/tokenUsage/updated" => {
                job.tokens = params.get("tokenUsage").cloned();
            }
            "turn/completed" | "turn/failed" => {
                let completed = method == "turn/completed";
                let summary = if job.report.is_empty() {
                    tail(job.reply.trim(), REPLY_LIMIT)
                } else {
                    job.report.clone()
                };
                drop(inner);
                self.finish(
                    job_id,
                    if completed { STATUS_DONE } else { STATUS_FAILED },
                    Some(if completed { "succeeded".into() } else { "failed".into() }),
                    summary,
                    false,
                );
                return;
            }
            _ => return,
        }

        self.notify(&inner);
    }

    /// `terminal` decides whether the worker process dies with the turn. A completed turn keeps
    /// it alive so `alethe_send` can hand it more work on the same thread; cancelling kills it.
    fn finish(
        &self,
        job_id: &str,
        status: &str,
        outcome: Option<String>,
        text: String,
        terminal: bool,
    ) {
        let staged;
        {
            let mut inner = guard(&self.inner);
            let Some(job) = inner.jobs.get_mut(job_id) else {
                return;
            };
            if job.settled() {
                return;
            }
            job.status = status.to_string();
            if !text.trim().is_empty() {
                job.report = text.trim().to_string();
            }
            job.outcome = outcome.clone();
            job.ended_at = Some(now_ms());
            job.active_turn_id = None;
            if terminal {
                job.teardown();
            }
            inner.running = inner.running.saturating_sub(1);
            inner.push_delivery("worker_done", job_id, outcome, text);

            // Anything sent while this worker was busy waited here rather than interrupting it or
            // being refused. It goes out now, on the slot the worker just gave back.
            staged = (!terminal)
                .then(|| next_from_inbox(&mut inner, job_id))
                .flatten();
            if staged.is_some() {
                if let Some(job) = inner.jobs.get_mut(job_id) {
                    job.status = STATUS_RUNNING.to_string();
                    job.outcome = None;
                    job.ended_at = None;
                    job.reply.clear();
                    job.report.clear();
                }
                inner.running += 1;
            } else {
                release_oldest_parked(&mut inner);
            }
            self.notify(&inner);
        }
        if let Some((stdin, request)) = staged {
            if let Err(error) = send_rpc(&stdin, &request) {
                self.settle(job_id, STATUS_FAILED, "send-failed", &error);
                return;
            }
        }
        self.persist();
        self.signal.notify_all();
        self.drain_queue();
    }

    fn drain_queue(&self) {
        loop {
            let next = {
                let mut inner = guard(&self.inner);
                if inner.running >= inner.max_concurrent {
                    None
                } else {
                    inner.queue.pop_front()
                }
            };
            let Some(job_id) = next else { break };
            self.spawn_worker(&job_id);
        }
    }
}

// ---------------------------------------------------------------------- tools

pub fn tools() -> Value {
    json!([
        {
            "name": "alethe_delegate",
            "description": "Hand independent units of work to Codex workers that Alethe runs as separate processes. These are NOT your own subagents: they are a different agent on its own token budget, so their reading and writing costs you nothing but the task text. Prefer this over launching subagents of your own for the same work. They also outlive the turn, can be corrected mid-run with alethe_steer, and can each take an isolated git worktree. Returns job ids immediately; the workers run in parallel. Delegate when the work splits into units that each need their own reading and judgement, and there are at least two of them: one unit per area of the codebase, per service, per feature. Send every unit in ONE call so they run at the same time, and make each task self contained. Do NOT delegate work that is uniform across its inputs, that one command or script does in a single pass, or that is quicker to finish than to describe.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "tasks": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "One self contained instruction per worker."
                    },
                    "cwd": { "type": "string", "description": "Working directory. Defaults to the lead's directory." },
                    "label": { "type": "string", "description": "A short name for this batch, in the user's words - what it is for, not how it is done. It is how the person watching tells one round of delegation from another." },
                    "isolate": {
                        "type": "boolean",
                        "description": "Give each worker its own detached git worktree. Use it whenever two units could touch the same files; without it parallel workers share one directory and can overwrite each other. Requires a git repository. The worktree path comes back with the job and is left in place for review."
                    },
                    "timeoutSeconds": {
                        "type": "number",
                        "description": "Budget per worker before Alethe stops it, default 900. Pass 0 to let a worker run without a limit."
                    }
                },
                "required": ["tasks"]
            }
        },
        {
            "name": "alethe_check",
            "description": "Collect what workers reported. With wait set it blocks until they settle. Process every delivery it returns before calling it again.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "wait": { "type": "boolean" },
                    "untilAllSettled": {
                        "type": "boolean",
                        "description": "Default true: block until every worker has settled, so you never report on a partial set. Set false only when you want to react to the first worker that finishes."
                    },
                    "timeoutMs": { "type": "number" }
                }
            }
        },
        {
            "name": "alethe_status",
            "description": "Snapshot of every worker without blocking: status, elapsed time, current plan and token usage.",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "alethe_steer",
            "description": "Correct a worker while its turn is still running, without killing it or losing its context. Use this instead of cancelling when the worker is heading the wrong way.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "jobId": { "type": "string" },
                    "message": { "type": "string" }
                },
                "required": ["jobId", "message"]
            }
        },
        {
            "name": "alethe_send",
            "description": "Give a worker more work on its existing thread, keeping everything it already learned. If it is still busy the message waits and starts as its next turn, so you never have to interrupt it or poll for it to be free. Use alethe_steer instead when the turn it is running now is going the wrong way.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "jobId": { "type": "string" },
                    "message": { "type": "string" }
                },
                "required": ["jobId", "message"]
            }
        },
        {
            "name": "alethe_cancel",
            "description": "Interrupt running workers.",
            "inputSchema": {
                "type": "object",
                "properties": { "jobIds": { "type": "array", "items": { "type": "string" } } },
                "required": ["jobIds"]
            }
        },
        {
            "name": "alethe_release",
            "description": "Let go of settled workers you have no more work for. Account for every worker you started: either send it more work or release it.",
            "inputSchema": {
                "type": "object",
                "properties": { "jobIds": { "type": "array", "items": { "type": "string" } } },
                "required": ["jobIds"]
            }
        },
        {
            "name": "alethe_diff",
            "description": "Read the unified diff a worker has produced so far.",
            "inputSchema": {
                "type": "object",
                "properties": { "jobId": { "type": "string" } },
                "required": ["jobId"]
            }
        }
    ])
}

fn string_list(arguments: &Map<String, Value>, key: &str) -> Vec<String> {
    arguments
        .get(key)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(ToOwned::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

fn required_str(arguments: &Map<String, Value>, key: &str) -> Result<String, String> {
    arguments
        .get(key)
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .ok_or_else(|| format!("{key} is required"))
}

pub fn call_tool(
    core: &Core,
    name: &str,
    arguments: &Map<String, Value>,
    planner: Option<&str>,
) -> Result<Value, String> {
    match name {
        "alethe_delegate" => {
            let tasks = string_list(arguments, "tasks");
            if tasks.is_empty() {
                return Err("tasks must contain at least one instruction".into());
            }
            let cwd = arguments
                .get("cwd")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
                .or_else(|| {
                    std::env::current_dir()
                        .ok()
                        .map(|path| path.to_string_lossy().into_owned())
                })
                .ok_or_else(|| "cwd is required".to_string())?;

            let isolate = arguments
                .get("isolate")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let timeout_ms = match arguments.get("timeoutSeconds").and_then(Value::as_u64) {
                Some(0) => None,
                Some(seconds) => Some(seconds.saturating_mul(1000)),
                None => Some(DEFAULT_JOB_TIMEOUT_MS),
            };

            // Ids are reserved under the lock, but the worktrees are not built under it: each one
            // shells out to git, and holding the lock across that would stall every running job.
            let label = arguments
                .get("label")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned);

            // One delegate call is one run: the batch the lead asked for at one moment. Grouping by
            // it is what lets several rounds of delegation stay apart instead of piling into one list.
            let planner_id = planner.map(ToOwned::to_owned);
            let agent = guard(&core.launcher)
                .as_ref()
                .map(|launcher| launcher.kind.clone())
                .unwrap_or_else(|| "codex".to_string());

            let (run_id, ids): (String, Vec<String>) = {
                let mut inner = guard(&core.inner);
                inner.run_counter += 1;
                let run_id = format!("run-{:02}", inner.run_counter);
                let ids = tasks
                    .iter()
                    .map(|_| {
                        inner.job_counter += 1;
                        format!("job-{:02}", inner.job_counter)
                    })
                    .collect();
                (run_id, ids)
            };

            // A batch is accepted whole or not at all. Half of it left queued with worktrees on
            // disk and no worker coming would be worse than a clean refusal.
            let mut prepared: Vec<(String, Option<String>)> = Vec::new();
            if isolate {
                for id in &ids {
                    match isolate_worktree(&cwd, id) {
                        Ok(path) => prepared.push((path.clone(), Some(path))),
                        Err(error) => {
                            for (_, worktree) in &prepared {
                                if let Some(path) = worktree {
                                    let _ = git(
                                        std::path::Path::new(&cwd),
                                        &["worktree", "remove", "--force", path],
                                    );
                                }
                            }
                            return Err(format!(
                                "isolate needs a git repository at {cwd}: {error}"
                            ));
                        }
                    }
                }
            } else {
                prepared = ids.iter().map(|_| (cwd.clone(), None)).collect();
            }

            let mut created = Vec::new();
            {
                let mut inner = guard(&core.inner);
                for ((spec, id), (job_cwd, worktree)) in
                    tasks.into_iter().zip(ids).zip(prepared.into_iter())
                {
                    inner.jobs.insert(
                        id.clone(),
                        Job {
                            id: id.clone(),
                            planner_id: planner_id.clone(),
                            agent: agent.clone(),
                            run_id: run_id.clone(),
                            run_label: label.clone(),
                            spec: spec.clone(),
                            cwd: job_cwd,
                            status: STATUS_QUEUED.to_string(),
                            thread_id: None,
                            active_turn_id: None,
                            reply: String::new(),
                            report: String::new(),
                            plan: Vec::new(),
                            diff: None,
                            tokens: None,
                            outcome: None,
                            started_at: None,
                            ended_at: None,
                            worktree: worktree.clone(),
                            timeout_ms,
                            child: None,
                            stdin: None,
                            inbox: VecDeque::new(),
                            next_request_id: 10,
                        },
                    );
                    inner.order.push(id.clone());
                    inner.queue.push_back(id.clone());
                    created.push(json!({ "id": id, "spec": spec, "worktree": worktree }));
                }
                core.notify(&inner);
            }
            core.persist();
            core.drain_queue();

            let limit = guard(&core.inner).max_concurrent;
            Ok(json!({
                "accepted": created.len(),
                "runId": run_id,
                "runningInParallel": true,
                "concurrencyLimit": limit,
                "isolated": isolate,
                "timeoutSeconds": timeout_ms.map(|ms| ms / 1000),
                "jobs": created,
                "next": "call alethe_check with wait true"
            }))
        }

        "alethe_check" => {
            let wait = arguments.get("wait").and_then(Value::as_bool).unwrap_or(false);
            let until_all_settled = arguments
                .get("untilAllSettled")
                .and_then(Value::as_bool)
                .unwrap_or(true);
            let timeout = arguments
                .get("timeoutMs")
                .and_then(Value::as_u64)
                .unwrap_or(300_000)
                .min(MAX_WAIT_MS);

            let mut inner = guard(&core.inner);
            if wait {
                let deadline = Instant::now() + Duration::from_millis(timeout);
                loop {
                    let busy = inner.running > 0 || !inner.queue.is_empty();
                    if !busy {
                        break;
                    }
                    if !until_all_settled && !inner.deliveries.is_empty() {
                        break;
                    }
                    let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                        break;
                    };
                    let (next, timed_out) = core
                        .signal
                        .wait_timeout(inner, remaining)
                        .map_err(|_| "orchestrator state poisoned".to_string())?;
                    inner = next;
                    if timed_out.timed_out() {
                        break;
                    }
                }
            }

            let mut deliveries = Vec::new();
            while let Some(delivery) = inner.deliveries.pop_front() {
                deliveries.push(delivery.to_value());
            }
            let pending = inner.running + inner.queue.len();
            Ok(json!({
                "deliveries": deliveries,
                "workersStillBusy": pending,
                "note": if pending > 0 {
                    "timed out with workers still running: call alethe_check again"
                } else {
                    "every worker settled"
                }
            }))
        }

        "alethe_status" => Ok(core.snapshot()),

        "alethe_steer" => {
            let job_id = required_str(arguments, "jobId")?;
            let message = required_str(arguments, "message")?;
            let mut inner = guard(&core.inner);
            let job = inner
                .jobs
                .get(&job_id)
                .ok_or_else(|| format!("unknown job {job_id}"))?;
            let thread_id = job
                .thread_id
                .clone()
                .ok_or_else(|| format!("job {job_id} has no thread yet"))?;
            let turn_id = job
                .active_turn_id
                .clone()
                .ok_or_else(|| format!("job {job_id} has no running turn to steer"))?;
            let (stdin, request) = stage_rpc(
                &mut inner,
                &job_id,
                "turn/steer",
                json!({
                    "threadId": thread_id,
                    "input": [{ "type": "text", "text": message }],
                    "expectedTurnId": turn_id
                }),
            )?;
            drop(inner);
            send_rpc(&stdin, &request)?;
            Ok(json!({ "steered": job_id, "turnId": turn_id }))
        }

        "alethe_send" => {
            let job_id = required_str(arguments, "jobId")?;
            let message = required_str(arguments, "message")?;
            let mut inner = guard(&core.inner);
            let job = inner
                .jobs
                .get(&job_id)
                .ok_or_else(|| format!("unknown job {job_id}"))?;
            let thread_id = job
                .thread_id
                .clone()
                .ok_or_else(|| format!("job {job_id} has no thread"))?;
            // A worker whose process is gone still has its thread on disk, so instead of refusing
            // the message it is started again and picks up where it left off.
            if job.stdin.is_none() {
                drop(inner);
                let queued = {
                    let mut inner = guard(&core.inner);
                    let job = inner
                        .jobs
                        .get_mut(&job_id)
                        .ok_or_else(|| format!("unknown job {job_id}"))?;
                    job.inbox.push_back(message);
                    job.status = STATUS_QUEUED.to_string();
                    inner.queue.push_back(job_id.clone());
                    core.notify(&inner);
                    true
                };
                core.drain_queue();
                return Ok(json!({ "revived": job_id, "resumedThread": thread_id, "queued": queued }));
            }
            // Waiting beats both alternatives: refusing would make the lead babysit the worker,
            // and steering would bend the turn already in flight instead of adding to it.
            if !job.settled() {
                let job = inner
                    .jobs
                    .get_mut(&job_id)
                    .ok_or_else(|| format!("unknown job {job_id}"))?;
                job.inbox.push_back(message);
                let queued = job.inbox.len();
                core.notify(&inner);
                return Ok(json!({ "queued": job_id, "waiting": queued }));
            }
            if inner.running >= inner.max_concurrent {
                return Err(format!(
                    "concurrency limit {} reached, call alethe_check first",
                    inner.max_concurrent
                ));
            }
            let (stdin, request) = stage_rpc(
                &mut inner,
                &job_id,
                "turn/start",
                json!({
                    "threadId": thread_id,
                    "input": [{ "type": "text", "text": message }],
                    "approvalPolicy": "never"
                }),
            )?;
            if let Some(job) = inner.jobs.get_mut(&job_id) {
                job.status = STATUS_RUNNING.to_string();
                job.outcome = None;
                job.ended_at = None;
                job.reply.clear();
                job.report.clear();
            }
            inner.running += 1;
            core.notify(&inner);
            drop(inner);
            // The slot was taken before the write, so a worker that never receives the turn has to
            // give it back rather than hold it until the process dies.
            if let Err(error) = send_rpc(&stdin, &request) {
                core.settle(&job_id, STATUS_FAILED, "send-failed", &error);
                return Err(error);
            }
            Ok(json!({ "sent": job_id }))
        }

        "alethe_cancel" => {
            let ids = string_list(arguments, "jobIds");
            let mut cancelled = Vec::new();
            for job_id in ids {
                let payload = {
                    let inner = guard(&core.inner);
                    inner.jobs.get(&job_id).and_then(|job| {
                        match (job.thread_id.clone(), job.active_turn_id.clone()) {
                            (Some(thread_id), Some(turn_id)) => {
                                Some(json!({ "threadId": thread_id, "turnId": turn_id }))
                            }
                            _ => None,
                        }
                    })
                };
                if let Some(payload) = payload {
                    let staged = {
                        let mut inner = guard(&core.inner);
                        stage_rpc(&mut inner, &job_id, "turn/interrupt", payload)
                    };
                    if let Ok((stdin, request)) = staged {
                        let _ = send_rpc(&stdin, &request);
                    }
                }
                core.finish(
                    &job_id,
                    STATUS_CANCELLED,
                    Some("cancelled".into()),
                    "cancelled by the lead".into(),
                    true,
                );
                cancelled.push(job_id);
            }
            Ok(json!({ "cancelled": cancelled }))
        }

        "alethe_release" => {
            let ids = string_list(arguments, "jobIds");
            let mut released = Vec::new();
            {
                let mut inner = guard(&core.inner);
                for job_id in &ids {
                    let Some(job) = inner.jobs.get_mut(job_id) else {
                        continue;
                    };
                    if job.status == STATUS_RUNNING {
                        continue;
                    }
                    job.teardown();
                    job.status = STATUS_RELEASED.to_string();
                    released.push(job_id.clone());
                }
                core.notify(&inner);
            }
            Ok(json!({ "released": released }))
        }

        "alethe_diff" => {
            let job_id = required_str(arguments, "jobId")?;
            let inner = guard(&core.inner);
            let job = inner
                .jobs
                .get(&job_id)
                .ok_or_else(|| format!("unknown job {job_id}"))?;
            Ok(json!({ "jobId": job_id, "diff": job.diff.clone().unwrap_or_default() }))
        }

        other => Err(format!("unknown tool {other}")),
    }
}

// ------------------------------------------------------------------ transport

/// One JSON-RPC message in, one response out. `None` means the message was a notification and
/// the caller should answer 202 with no body.
pub fn handle_mcp_body(core: &Core, body: &str, planner: Option<&str>) -> Option<String> {
    let message: Value = serde_json::from_str(body).ok()?;
    let id = message.get("id").cloned()?;
    let method = message.get("method").and_then(Value::as_str).unwrap_or("");
    let params = message.get("params").cloned().unwrap_or(Value::Null);

    let response = match method {
        "initialize" => json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {
                "protocolVersion": params
                    .get("protocolVersion")
                    .and_then(Value::as_str)
                    .unwrap_or("2025-06-18"),
                "capabilities": { "tools": { "listChanged": false } },
                "serverInfo": { "name": "alethe", "title": "Alethe", "version": "1" }
            }
        }),
        "tools/list" => json!({ "jsonrpc": "2.0", "id": id, "result": { "tools": tools() } }),
        "tools/call" => {
            let name = params.get("name").and_then(Value::as_str).unwrap_or_default();
            let empty = Map::new();
            let arguments = params
                .get("arguments")
                .and_then(Value::as_object)
                .unwrap_or(&empty);
            match call_tool(core, name, arguments, planner) {
                Ok(value) => json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": { "content": [{ "type": "text", "text": value.to_string() }] }
                }),
                Err(error) => json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": {
                        "content": [{ "type": "text", "text": format!("error: {error}") }],
                        "isError": true
                    }
                }),
            }
        }
        "ping" => json!({ "jsonrpc": "2.0", "id": id, "result": {} }),
        other => json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": -32601, "message": format!("unknown method {other}") }
        }),
    };

    Some(response.to_string())
}
