//! Alethe's own MCP server: the lead agent delegates through it, Alethe owns the policy.
//!
//! The server is hosted in-process over HTTP on the `agent_events` listener, so worker state
//! lives next to the UI instead of in a sidecar. Workers are Codex threads driven over
//! `codex app-server --stdio`, which is what makes completion, steering and cancellation
//! protocol facts rather than conventions parsed out of a terminal.

use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Stdio};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Map, Value};
use tauri::{AppHandle, Emitter};

use crate::cli_resolver;

const DEFAULT_MAX_CONCURRENT: usize = 4;
const MAX_WAIT_MS: u64 = 600_000;
const REPLY_LIMIT: usize = 16_000;
const JOBS_EVENT: &str = "orchestrator://jobs";

pub const STATUS_QUEUED: &str = "queued";
pub const STATUS_RUNNING: &str = "running";
pub const STATUS_DONE: &str = "done";
pub const STATUS_FAILED: &str = "failed";
pub const STATUS_CANCELLED: &str = "cancelled";
pub const STATUS_RELEASED: &str = "released";

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
            (Some(start), Some(end)) => Some((end.saturating_sub(start)) as f64 / 1000.0),
            (Some(start), None) => Some((now_ms().saturating_sub(start)) as f64 / 1000.0),
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

pub struct OrchestratorState {
    inner: Arc<Mutex<Inner>>,
    signal: Arc<Condvar>,
}

impl Default for OrchestratorState {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner {
                max_concurrent: DEFAULT_MAX_CONCURRENT,
                ..Inner::default()
            })),
            signal: Arc::new(Condvar::new()),
        }
    }
}

fn lock(inner: &Arc<Mutex<Inner>>) -> std::sync::MutexGuard<'_, Inner> {
    match inner.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

fn emit_jobs(app: &AppHandle, inner: &Inner) {
    let jobs: Vec<Value> = inner
        .order
        .iter()
        .filter_map(|id| inner.jobs.get(id))
        .map(Job::snapshot)
        .collect();
    let _ = app.emit(JOBS_EVENT, json!({ "jobs": jobs }));
}

fn push_delivery(inner: &mut Inner, kind: &str, job_id: &str, outcome: Option<String>, text: String) {
    inner.seq += 1;
    let seq = inner.seq;
    inner.deliveries.push_back(Delivery {
        seq,
        kind: kind.to_string(),
        job_id: job_id.to_string(),
        outcome,
        text,
    });
}

fn send_rpc(stdin: &Arc<Mutex<ChildStdin>>, value: &Value) -> Result<(), String> {
    let mut stdin = match stdin.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
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
    send_rpc(&stdin, &json!({ "id": id, "method": method, "params": params }))
}

impl OrchestratorState {
    fn spawn_worker(&self, app: &AppHandle, job_id: &str) {
        let (cwd, spec) = {
            let mut guard = lock(&self.inner);
            let Some(job) = guard.jobs.get_mut(job_id) else {
                return;
            };
            job.status = STATUS_RUNNING.to_string();
            job.started_at = Some(now_ms());
            guard.running += 1;
            let job = guard.jobs.get(job_id).expect("job present");
            (job.cwd.clone(), job.spec.clone())
        };

        let launcher = match cli_resolver::find_windows_cli_launcher("codex") {
            Some(launcher) => launcher,
            None => {
                self.settle(app, job_id, STATUS_FAILED, Some("failed".into()), "codex not found".into());
                return;
            }
        };

        let mut command = std::process::Command::new(&launcher);
        command
            .arg("app-server")
            .arg("--stdio")
            .current_dir(PathBuf::from(&cwd))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        #[cfg(windows)]
        command.env("Path", cli_resolver::rebuilt_path());

        crate::git_control::hide_console(&mut command);

        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                self.settle(
                    app,
                    job_id,
                    STATUS_FAILED,
                    Some("failed".into()),
                    format!("codex app-server spawn failed: {error}"),
                );
                return;
            }
        };

        let stdin = match child.stdin.take() {
            Some(stdin) => Arc::new(Mutex::new(stdin)),
            None => {
                let _ = child.kill();
                self.settle(app, job_id, STATUS_FAILED, Some("failed".into()), "no stdin".into());
                return;
            }
        };
        let stdout = child.stdout.take();
        let child = Arc::new(Mutex::new(child));

        {
            let mut guard = lock(&self.inner);
            if let Some(job) = guard.jobs.get_mut(job_id) {
                job.child = Some(Arc::clone(&child));
                job.stdin = Some(Arc::clone(&stdin));
            }
            emit_jobs(app, &guard);
        }

        let _ = send_rpc(
            &stdin,
            &json!({
                "id": 1,
                "method": "initialize",
                "params": {
                    "clientInfo": {
                        "name": "alethe-orchestrator",
                        "title": "Alethe",
                        "version": env!("CARGO_PKG_VERSION")
                    }
                }
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
            let inner = Arc::clone(&self.inner);
            let signal = Arc::clone(&self.signal);
            let app = app.clone();
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
                    handle_worker_message(&app, &inner, &signal, &owned_id, &stdin, &spec, &message);
                }
                finish_job(
                    &app,
                    &inner,
                    &signal,
                    &owned_id,
                    STATUS_FAILED,
                    Some("failed".into()),
                    "worker connection closed".into(),
                    true,
                );
            });
        }
    }

    fn settle(&self, app: &AppHandle, job_id: &str, status: &str, outcome: Option<String>, text: String) {
        finish_job(app, &self.inner, &self.signal, job_id, status, outcome, text, true);
    }
}

fn handle_worker_message(
    app: &AppHandle,
    inner: &Arc<Mutex<Inner>>,
    signal: &Arc<Condvar>,
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
                let mut guard = lock(inner);
                if let Some(job) = guard.jobs.get_mut(job_id) {
                    job.thread_id = Some(thread_id.clone());
                }
                emit_jobs(app, &guard);
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
            let _ = send_rpc(stdin, &json!({ "id": id, "result": { "decision": "accept" } }));
        }
        return;
    }

    let mut guard = lock(inner);
    let Some(job) = guard.jobs.get_mut(job_id) else {
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
            job.diff = params.get("diff").and_then(Value::as_str).map(ToOwned::to_owned);
        }
        "thread/tokenUsage/updated" => {
            job.tokens = params.get("tokenUsage").cloned();
        }
        "turn/completed" | "turn/failed" => {
            let status = if method == "turn/completed" { STATUS_DONE } else { STATUS_FAILED };
            let outcome = if method == "turn/completed" { "succeeded" } else { "failed" };
            let summary = job.reply.trim().to_string();
            drop(guard);
            finish_job(app, inner, signal, job_id, status, Some(outcome.into()), summary, false);
            return;
        }
        _ => return,
    }

    emit_jobs(app, &guard);
}

fn teardown(job: &mut Job) {
    if let Some(child) = job.child.take() {
        if let Ok(mut child) = child.lock() {
            let _ = child.kill();
        }
    }
    job.stdin = None;
}

/// `terminal` decides whether the worker process dies with the turn. A completed turn keeps it
/// alive so `alethe_send` can hand it more work on the same thread; cancelling kills it.
fn finish_job(
    app: &AppHandle,
    inner: &Arc<Mutex<Inner>>,
    signal: &Arc<Condvar>,
    job_id: &str,
    status: &str,
    outcome: Option<String>,
    text: String,
    terminal: bool,
) {
    let mut guard = lock(inner);
    let Some(job) = guard.jobs.get_mut(job_id) else {
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
        teardown(job);
    }
    guard.running = guard.running.saturating_sub(1);
    push_delivery(&mut guard, "worker_done", job_id, outcome, text);
    emit_jobs(app, &guard);
    drop(guard);
    signal.notify_all();
    drain_queue(app, inner, signal);
}

fn drain_queue(app: &AppHandle, inner: &Arc<Mutex<Inner>>, signal: &Arc<Condvar>) {
    loop {
        let next = {
            let mut guard = lock(inner);
            if guard.running >= guard.max_concurrent {
                None
            } else {
                guard.queue.pop_front()
            }
        };
        let Some(job_id) = next else { break };
        let state = OrchestratorState {
            inner: Arc::clone(inner),
            signal: Arc::clone(signal),
        };
        state.spawn_worker(app, &job_id);
    }
}

// ---------------------------------------------------------------------- tools

fn tools() -> Value {
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
            "description": "Collect what workers reported. With wait set it blocks until at least one worker settles or the timeout expires. Process every delivery it returns before calling it again.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "wait": { "type": "boolean" },
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
                "properties": {
                    "jobIds": { "type": "array", "items": { "type": "string" } }
                },
                "required": ["jobIds"]
            }
        },
        {
            "name": "alethe_release",
            "description": "Let go of settled workers you have no more work for. Account for every worker you started: either send it more work or release it.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "jobIds": { "type": "array", "items": { "type": "string" } }
                },
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

fn call_tool(
    app: &AppHandle,
    state: &OrchestratorState,
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
                .or_else(default_cwd)
                .ok_or_else(|| "cwd is required".to_string())?;

            let mut created = Vec::new();
            {
                let mut guard = lock(&state.inner);
                for spec in tasks {
                    guard.job_counter += 1;
                    let id = format!("job-{:02}", guard.job_counter);
                    guard.jobs.insert(
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
                    guard.order.push(id.clone());
                    guard.queue.push_back(id.clone());
                    created.push(json!({ "id": id, "spec": spec }));
                }
                emit_jobs(app, &guard);
            }
            drain_queue(app, &state.inner, &state.signal);

            let guard = lock(&state.inner);
            Ok(json!({
                "accepted": created.len(),
                "runningInParallel": true,
                "concurrencyLimit": guard.max_concurrent,
                "jobs": created,
                "next": "call alethe_check with wait true"
            }))
        }

        "alethe_check" => {
            let wait = arguments.get("wait").and_then(Value::as_bool).unwrap_or(false);
            let timeout = arguments
                .get("timeoutMs")
                .and_then(Value::as_u64)
                .unwrap_or(300_000)
                .min(MAX_WAIT_MS);

            let mut guard = lock(&state.inner);
            if wait && guard.deliveries.is_empty() {
                let has_work = guard.running > 0 || !guard.queue.is_empty();
                if has_work {
                    let (next, _) = state
                        .signal
                        .wait_timeout_while(guard, Duration::from_millis(timeout), |inner| {
                            inner.deliveries.is_empty()
                        })
                        .map_err(|_| "orchestrator state poisoned".to_string())?;
                    guard = next;
                }
            }

            let mut deliveries = Vec::new();
            while let Some(delivery) = guard.deliveries.pop_front() {
                deliveries.push(delivery.to_value());
            }
            let pending = guard.running + guard.queue.len();
            Ok(json!({
                "deliveries": deliveries,
                "workersStillBusy": pending,
                "note": if pending > 0 { "call alethe_check again" } else { "every worker settled" }
            }))
        }

        "alethe_status" => {
            let guard = lock(&state.inner);
            let jobs: Vec<Value> = guard
                .order
                .iter()
                .filter_map(|id| guard.jobs.get(id))
                .map(Job::snapshot)
                .collect();
            Ok(json!({
                "jobs": jobs,
                "running": guard.running,
                "queued": guard.queue.len(),
                "concurrencyLimit": guard.max_concurrent
            }))
        }

        "alethe_steer" => {
            let job_id = arguments
                .get("jobId")
                .and_then(Value::as_str)
                .ok_or_else(|| "jobId is required".to_string())?;
            let message = arguments
                .get("message")
                .and_then(Value::as_str)
                .ok_or_else(|| "message is required".to_string())?;
            let mut guard = lock(&state.inner);
            let job = guard
                .jobs
                .get(job_id)
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
                &mut guard,
                job_id,
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
            let job_id = arguments
                .get("jobId")
                .and_then(Value::as_str)
                .ok_or_else(|| "jobId is required".to_string())?;
            let message = arguments
                .get("message")
                .and_then(Value::as_str)
                .ok_or_else(|| "message is required".to_string())?;
            let mut guard = lock(&state.inner);
            let job = guard
                .jobs
                .get(job_id)
                .ok_or_else(|| format!("unknown job {job_id}"))?;
            let thread_id = job
                .thread_id
                .clone()
                .ok_or_else(|| format!("job {job_id} has no thread"))?;
            if job.stdin.is_none() {
                return Err(format!("job {job_id} was released and cannot take more work"));
            }
            if guard.running >= guard.max_concurrent {
                return Err(format!(
                    "concurrency limit {} reached, call alethe_check first",
                    guard.max_concurrent
                ));
            }
            job_rpc(
                &mut guard,
                job_id,
                "turn/start",
                json!({
                    "threadId": thread_id,
                    "input": [{ "type": "text", "text": message }],
                    "approvalPolicy": "never"
                }),
            )?;
            if let Some(job) = guard.jobs.get_mut(job_id) {
                job.status = STATUS_RUNNING.to_string();
                job.outcome = None;
                job.ended_at = None;
                job.reply.clear();
            }
            guard.running += 1;
            emit_jobs(app, &guard);
            Ok(json!({ "sent": job_id }))
        }

        "alethe_cancel" => {
            let ids = string_list(arguments, "jobIds");
            let mut cancelled = Vec::new();
            for job_id in ids {
                let payload = {
                    let guard = lock(&state.inner);
                    guard.jobs.get(&job_id).and_then(|job| {
                        match (job.thread_id.clone(), job.active_turn_id.clone()) {
                            (Some(thread_id), Some(turn_id)) => Some(json!({
                                "threadId": thread_id,
                                "turnId": turn_id
                            })),
                            _ => None,
                        }
                    })
                };
                if let Some(payload) = payload {
                    let mut guard = lock(&state.inner);
                    let _ = job_rpc(&mut guard, &job_id, "turn/interrupt", payload);
                }
                finish_job(
                    app,
                    &state.inner,
                    &state.signal,
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
                let mut guard = lock(&state.inner);
                for job_id in &ids {
                    let Some(job) = guard.jobs.get_mut(job_id) else {
                        continue;
                    };
                    if job.status == STATUS_RUNNING {
                        continue;
                    }
                    teardown(job);
                    job.status = STATUS_RELEASED.to_string();
                    released.push(job_id.clone());
                }
                emit_jobs(app, &guard);
            }
            Ok(json!({ "released": released }))
        }

        "alethe_diff" => {
            let job_id = arguments
                .get("jobId")
                .and_then(Value::as_str)
                .ok_or_else(|| "jobId is required".to_string())?;
            let guard = lock(&state.inner);
            let job = guard
                .jobs
                .get(job_id)
                .ok_or_else(|| format!("unknown job {job_id}"))?;
            Ok(json!({ "jobId": job_id, "diff": job.diff.clone().unwrap_or_default() }))
        }

        other => Err(format!("unknown tool {other}")),
    }
}

fn default_cwd() -> Option<String> {
    std::env::current_dir()
        .ok()
        .map(|path| path.to_string_lossy().into_owned())
}

// ----------------------------------------------------------------- transport

pub fn handle_mcp_body(app: &AppHandle, state: &OrchestratorState, body: &str) -> Option<String> {
    let message: Value = serde_json::from_str(body).ok()?;
    let id = message.get("id").cloned();
    let id = id?;
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
                "serverInfo": {
                    "name": "alethe",
                    "title": "Alethe",
                    "version": env!("CARGO_PKG_VERSION")
                }
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
            match call_tool(app, state, name, arguments) {
                Ok(value) => json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": {
                        "content": [{ "type": "text", "text": value.to_string() }]
                    }
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

#[tauri::command]
pub fn orchestrator_mcp_config_path() -> Result<String, String> {
    let endpoint = crate::agent_events::agent_hooks_endpoint()?;
    let token = crate::agent_events::agent_hooks_token();
    let config = json!({
        "mcpServers": {
            "alethe": {
                "type": "http",
                "url": format!("{endpoint}/mcp"),
                "headers": { "X-Alethe-Token": token }
            }
        }
    });
    let path = std::env::temp_dir().join("alethe-orchestrator-mcp.json");
    let body = serde_json::to_string_pretty(&config).map_err(|error| error.to_string())?;
    std::fs::write(&path, body).map_err(|error| format!("write_failed:{error}"))?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn orchestrator_jobs(state: tauri::State<'_, OrchestratorState>) -> Value {
    let guard = lock(&state.inner);
    let jobs: Vec<Value> = guard
        .order
        .iter()
        .filter_map(|id| guard.jobs.get(id))
        .map(Job::snapshot)
        .collect();
    json!({
        "jobs": jobs,
        "running": guard.running,
        "queued": guard.queue.len(),
        "concurrencyLimit": guard.max_concurrent
    })
}

#[tauri::command]
pub fn orchestrator_set_concurrency(state: tauri::State<'_, OrchestratorState>, limit: usize) {
    let mut guard = lock(&state.inner);
    guard.max_concurrent = limit.clamp(1, 16);
}
