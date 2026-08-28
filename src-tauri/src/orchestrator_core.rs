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

pub type Observer = Arc<dyn Fn(Value) + Send + Sync>;

/// How to start one worker. The app layer resolves this once; the core never guesses.
#[derive(Clone, Debug)]
pub struct Launcher {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
}

impl Launcher {
    pub fn codex_app_server(program: PathBuf) -> Self {
        Self {
            program,
            args: vec!["app-server".into(), "--stdio".into()],
            env: Vec::new(),
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis() as u64)
        .unwrap_or_default()
}

struct Job {
    id: String,
    spec: String,
    cwd: String,
    status: String,
    thread_id: Option<String>,
    active_turn_id: Option<String>,
    reply: String,
    plan: Vec<String>,
    diff: Option<String>,
    tokens: Option<Value>,
    outcome: Option<String>,
    started_at: Option<u64>,
    ended_at: Option<u64>,
    child: Option<Arc<Mutex<Child>>>,
    stdin: Option<Arc<Mutex<ChildStdin>>>,
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
            "spec": self.spec,
            "cwd": self.cwd,
            "status": self.status,
            "threadId": self.thread_id,
            "outcome": self.outcome,
            "seconds": elapsed,
            "plan": self.plan,
            "tokens": self.tokens,
            "hasDiff": self.diff.is_some(),
            "summary": self.reply.trim().chars().take(1200).collect::<String>(),
        })
    }

    fn settled(&self) -> bool {
        matches!(
            self.status.as_str(),
            STATUS_DONE | STATUS_FAILED | STATUS_CANCELLED | STATUS_RELEASED
        )
    }

    fn teardown(&mut self) {
        if let Some(child) = self.child.take() {
            if let Ok(mut child) = child.lock() {
                let _ = child.kill();
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
}

impl Inner {
    fn snapshot(&self) -> Value {
        let jobs: Vec<Value> = self
            .order
            .iter()
            .filter_map(|id| self.jobs.get(id))
            .map(Job::snapshot)
            .collect();
        json!({
            "jobs": jobs,
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

fn job_rpc(inner: &mut Inner, job_id: &str, method: &str, params: Value) -> Result<(), String> {
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
    send_rpc(
        &stdin,
        &json!({ "id": id, "method": method, "params": params }),
    )
}

impl Core {
    pub fn set_launcher(&self, launcher: Launcher) {
        *guard(&self.launcher) = Some(launcher);
    }

    pub fn set_observer(&self, observer: Observer) {
        *guard(&self.observer) = Some(observer);
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

    fn notify(&self, inner: &Inner) {
        let observer = guard(&self.observer).clone();
        if let Some(observer) = observer {
            observer(inner.snapshot());
        }
    }

    fn spawn_worker(&self, job_id: &str) {
        let (cwd, spec) = {
            let mut inner = guard(&self.inner);
            let Some(job) = inner.jobs.get_mut(job_id) else {
                return;
            };
            job.status = STATUS_RUNNING.to_string();
            job.started_at = Some(now_ms());
            let pair = (job.cwd.clone(), job.spec.clone());
            inner.running += 1;
            pair
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
        let _ = send_rpc(
            &stdin,
            &json!({
                "id": 2,
                "method": "thread/start",
                "params": { "cwd": cwd, "approvalPolicy": "never", "sandbox": "workspace-write" }
            }),
        );

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
                let summary = job.reply.trim().to_string();
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
        {
            let mut inner = guard(&self.inner);
            let Some(job) = inner.jobs.get_mut(job_id) else {
                return;
            };
            if job.settled() {
                return;
            }
            job.status = status.to_string();
            job.outcome = outcome.clone();
            job.ended_at = Some(now_ms());
            job.active_turn_id = None;
            if terminal {
                job.teardown();
            }
            inner.running = inner.running.saturating_sub(1);
            inner.push_delivery("worker_done", job_id, outcome, text);
            self.notify(&inner);
        }
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
            "description": "Hand independent units of work to worker agents that Alethe runs for you. Returns job ids immediately; the workers run in parallel. Delegate any unit that would make you read more than 5 files or that you estimate at over 2 minutes of your own work, and send every qualifying unit in ONE call so they run at the same time. Each task must be self contained.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "tasks": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "One self contained instruction per worker."
                    },
                    "cwd": { "type": "string", "description": "Working directory. Defaults to the lead's directory." }
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
            "description": "Give a settled worker more work on its existing thread, keeping everything it already learned.",
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

            let mut created = Vec::new();
            {
                let mut inner = guard(&core.inner);
                for spec in tasks {
                    inner.job_counter += 1;
                    let id = format!("job-{:02}", inner.job_counter);
                    inner.jobs.insert(
                        id.clone(),
                        Job {
                            id: id.clone(),
                            spec: spec.clone(),
                            cwd: cwd.clone(),
                            status: STATUS_QUEUED.to_string(),
                            thread_id: None,
                            active_turn_id: None,
                            reply: String::new(),
                            plan: Vec::new(),
                            diff: None,
                            tokens: None,
                            outcome: None,
                            started_at: None,
                            ended_at: None,
                            child: None,
                            stdin: None,
                            next_request_id: 10,
                        },
                    );
                    inner.order.push(id.clone());
                    inner.queue.push_back(id.clone());
                    created.push(json!({ "id": id, "spec": spec }));
                }
                core.notify(&inner);
            }
            core.drain_queue();

            let limit = guard(&core.inner).max_concurrent;
            Ok(json!({
                "accepted": created.len(),
                "runningInParallel": true,
                "concurrencyLimit": limit,
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
            job_rpc(
                &mut inner,
                &job_id,
                "turn/steer",
                json!({
                    "threadId": thread_id,
                    "input": [{ "type": "text", "text": message }],
                    "expectedTurnId": turn_id
                }),
            )?;
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
            if job.stdin.is_none() {
                return Err(format!("job {job_id} was released and cannot take more work"));
            }
            if inner.running >= inner.max_concurrent {
                return Err(format!(
                    "concurrency limit {} reached, call alethe_check first",
                    inner.max_concurrent
                ));
            }
            job_rpc(
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
            }
            inner.running += 1;
            core.notify(&inner);
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
                    let mut inner = guard(&core.inner);
                    let _ = job_rpc(&mut inner, &job_id, "turn/interrupt", payload);
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
pub fn handle_mcp_body(core: &Core, body: &str) -> Option<String> {
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
            match call_tool(core, name, arguments) {
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
