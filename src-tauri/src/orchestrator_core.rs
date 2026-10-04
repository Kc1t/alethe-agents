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
use std::sync::mpsc::{channel, RecvTimeoutError, Sender};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
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
/// Holding its slot, but stopped on a question only a person can answer.
pub const STATUS_BLOCKED: &str = "blocked";

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

    /// `bypassPermissions`: this stream has no interactive approval channel — a tool call needing
    /// permission is auto-denied and reported, not paused for an answer.
    pub fn claude_headless(program: PathBuf) -> Self {
        Self {
            kind: "claude".into(),
            program,
            args: vec![
                "-p".into(),
                "--input-format".into(),
                "stream-json".into(),
                "--output-format".into(),
                "stream-json".into(),
                "--verbose".into(),
                "--permission-mode".into(),
                "bypassPermissions".into(),
            ],
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

const SANDBOX_READ_ONLY: &str = "read-only";

/// A named preset from the Orchestration settings. A delegate call that names it gets exactly
/// these values: the role is the only source for what it sets.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Role {
    pub name: String,
    pub agent: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    #[serde(default)]
    pub read_only: bool,
    /// None uses the default budget; 0 lets the worker run without a limit.
    #[serde(default)]
    pub timeout_seconds: Option<u64>,
    /// The role to run instead while this one's provider is running out of quota (#268).
    #[serde(default)]
    pub fallback: Option<String>,
    /// The planner agent this row is for ("claude" or "codex"); None serves any planner (#276).
    #[serde(default)]
    pub orchestrator: Option<String>,
}

/// The row a role name means for a planner on `orchestrator` (#276): the row for that orchestrator,
/// else the row for any. No planner, or one Alethe does not know, only reaches the rows for any.
fn role_for<'a>(roles: &'a [Role], name: &str, orchestrator: Option<&str>) -> Option<&'a Role> {
    let row = |wanted: Option<&str>| {
        roles
            .iter()
            .find(|role| role.name == name && role.orchestrator.as_deref() == wanted)
    };
    row(orchestrator).or_else(|| row(None))
}

/// The default share of a quota window that counts as critical, matching
/// `USAGE_FALLBACK_THRESHOLD` on the frontend; the routing settings can move it.
pub const DEFAULT_CRITICAL_THRESHOLD: f64 = 80.0;

fn default_true() -> bool {
    true
}

fn default_critical_threshold() -> f64 {
    DEFAULT_CRITICAL_THRESHOLD
}

fn default_on_both_critical() -> String {
    "ask".to_string()
}

/// A quota condition on a routing rule: the named window of the named agent must sit below
/// `below` percent for the rule to fire. `window` is "short" (5h), "week" (7d) or "opus"
/// (Claude's 7d-Opus; Codex reads it as its secondary window).
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotaGate {
    pub agent: String,
    pub window: String,
    pub below: f64,
}

/// One routing rule. Empty `kinds`/`efforts` match any kind/effort; every gate must pass.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutingRule {
    pub id: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub kinds: Vec<String>,
    #[serde(default)]
    pub efforts: Vec<String>,
    #[serde(default)]
    pub gates: Vec<QuotaGate>,
    /// The role a matching call runs as.
    pub role: String,
}

/// The kind/effort/quota rules that pick a role when a delegate call names neither `role` nor
/// `model`. Absent from older settings payloads, everything defaults to today's behavior.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutingSettings {
    #[serde(default = "default_preset")]
    pub preset: String,
    #[serde(default)]
    pub rules: Vec<RoutingRule>,
    #[serde(default = "default_critical_threshold")]
    pub critical_threshold: f64,
    #[serde(default = "default_true")]
    pub allow_opus_on_deep: bool,
    /// "ask" | "run-cheapest" | "block", for when every provider sits past the threshold.
    #[serde(default = "default_on_both_critical")]
    pub on_both_critical: String,
}

fn default_preset() -> String {
    "balanced".to_string()
}

impl Default for RoutingSettings {
    fn default() -> Self {
        Self {
            preset: default_preset(),
            rules: Vec::new(),
            critical_threshold: DEFAULT_CRITICAL_THRESHOLD,
            allow_opus_on_deep: true,
            on_both_critical: default_on_both_critical(),
        }
    }
}

/// What the Orchestration settings in Preferences hand to the orchestrator.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrchestrationSettings {
    #[serde(default)]
    pub roles: Vec<Role>,
    pub max_concurrent: usize,
    /// 0 lets a worker run without a limit.
    pub default_timeout_seconds: u64,
    /// Codex plugin ids turned off in worker threads (#266).
    #[serde(default)]
    pub worker_disabled_plugins: Vec<String>,
    #[serde(default)]
    pub routing: RoutingSettings,
}

/// How long a Codex model list is reused; a Codex update shows up after this.
const CODEX_MODELS_TTL: Duration = Duration::from_secs(10 * 60);

/// What a role decides. Passing any of these next to a role is refused.
const ROLE_FIELDS: [&str; 5] = ["agent", "model", "effort", "readOnly", "timeoutSeconds"];

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

/// Same path/branch convention as `worktrees.rs` (`<repo>/.alethe/worktrees/<id>/`,
/// `alethe/agent-<id>`) on purpose, so its functions can later commit/fetch/remove this worktree —
/// this module stays crate-free (see file header), so it can't call `worktrees.rs` directly.
fn isolate_worktree(cwd: &str, job_id: &str) -> Result<String, String> {
    let origin = PathBuf::from(cwd);
    let root = git(&origin, &["rev-parse", "--show-toplevel"])?;
    let root = PathBuf::from(root.replace('/', std::path::MAIN_SEPARATOR_STR));
    let base = root.join(".alethe").join("worktrees");
    std::fs::create_dir_all(&base).map_err(|error| error.to_string())?;
    let target = base.join(job_id);
    if target.exists() {
        return Err(format!("a worktree already exists for {job_id}"));
    }
    let branch = format!("alethe/agent-{job_id}");
    git(
        &root,
        &[
            "worktree",
            "add",
            "-b",
            &branch,
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

/// Appends to a worker's live reply and keeps only its last `REPLY_LIMIT` bytes. The cut moves
/// forward to a character boundary: splitting inside a multi-byte character panics, and a release
/// build aborts on panic, which closes the whole app.
fn push_reply(reply: &mut String, text: &str) {
    reply.push_str(text);
    if reply.len() > REPLY_LIMIT {
        let mut cut = reply.len() - REPLY_LIMIT;
        while !reply.is_char_boundary(cut) {
            cut += 1;
        }
        *reply = reply.split_off(cut);
    }
}

#[cfg(test)]
mod reply_tests {
    use super::{push_reply, REPLY_LIMIT};

    // A cut inside a multi-byte character used to panic, and a release build aborts on panic (#256).
    #[test]
    fn a_long_reply_with_accents_is_trimmed_at_a_character_boundary() {
        let mut reply = String::new();
        // Each 'ã' is two bytes, so one more byte puts the cut in the middle of a character.
        push_reply(&mut reply, &"ã".repeat(REPLY_LIMIT));
        push_reply(&mut reply, "a");
        assert!(reply.len() <= REPLY_LIMIT);
        assert!(reply.ends_with("ãa"));

        push_reply(&mut reply, "çã");
        assert!(reply.len() <= REPLY_LIMIT);
        assert!(reply.ends_with("açã"));
    }

    #[test]
    fn a_short_reply_is_kept_whole() {
        let mut reply = String::from("olá");
        push_reply(&mut reply, ", revisão concluída");
        assert_eq!(reply, "olá, revisão concluída");
    }
}

/// The start of a long text, cut at a character boundary.
fn head(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_string();
    }
    let mut cut: String = text.chars().take(limit).collect();
    cut.push('…');
    cut
}

/// How much of a worker a planner gets from `alethe_status`. The UI reads the whole snapshot.
const STATUS_SPEC_CHARS: usize = 240;
const STATUS_SUMMARY_CHARS: usize = 400;
const STATUS_PLAN_STEPS: usize = 3;
/// Settled workers listed by default, and when the planner asks for all of them.
const STATUS_SETTLED: usize = 10;
const STATUS_SETTLED_ALL: usize = 40;

/// The snapshot reduced to what a planner can take in. Returned whole, a dozen workers with long
/// briefs pass the size a planner's tool result may have, and the call fails instead of answering.
/// A planner gets its own workers unless it asks for all: the active ones and the most recent
/// settled ones, each with its long texts trimmed. `omitted` counts the workers left out.
fn planner_status(mut snapshot: Value, planner: Option<&str>, all: bool) -> Value {
    let jobs = snapshot
        .get_mut("jobs")
        .and_then(Value::as_array_mut)
        .map(std::mem::take)
        .unwrap_or_default();
    let total = jobs.len();
    let active = |job: &Value| {
        matches!(
            job.get("status").and_then(Value::as_str),
            Some(STATUS_QUEUED | STATUS_RUNNING | STATUS_BLOCKED)
        )
    };
    let listed: Vec<Value> = jobs
        .into_iter()
        .filter(|job| {
            all || planner.is_none() || job.get("plannerId").and_then(Value::as_str) == planner
        })
        .collect();
    let limit = if all {
        STATUS_SETTLED_ALL
    } else {
        STATUS_SETTLED
    };
    let settled = listed.iter().filter(|job| !active(job)).count();
    let mut older = settled.saturating_sub(limit);
    let kept: Vec<Value> = listed
        .into_iter()
        .filter(|job| {
            if active(job) || older == 0 {
                return true;
            }
            older -= 1;
            false
        })
        .map(trimmed_job)
        .collect();
    snapshot["omitted"] = json!(total - kept.len());
    snapshot["jobs"] = Value::Array(kept);
    snapshot
}

fn trimmed_job(mut job: Value) -> Value {
    if let Some(spec) = job.get("spec").and_then(Value::as_str) {
        job["spec"] = json!(head(spec, STATUS_SPEC_CHARS));
    }
    if let Some(summary) = job.get("summary").and_then(Value::as_str) {
        job["summary"] = json!(tail(summary, STATUS_SUMMARY_CHARS));
    }
    if let Some(plan) = job.get_mut("plan").and_then(Value::as_array_mut) {
        let earlier = plan.len().saturating_sub(STATUS_PLAN_STEPS);
        plan.drain(..earlier);
    }
    if let Some(total) = job
        .get("tokens")
        .and_then(|tokens| tokens.get("total"))
        .cloned()
    {
        job["tokens"] = json!({ "total": total });
    }
    job
}

/// The worker's time budget, stated at the start of its first turn. A warning sent mid-turn does
/// not help: Codex only reads it once the text it is writing is done, which is often the answer
/// itself, and then spends another round replying to it.
fn with_budget(text: String, timeout_ms: Option<u64>) -> String {
    let Some(seconds) = timeout_ms
        .map(|ms| ms / 1000)
        .filter(|seconds| *seconds > 0)
    else {
        return text;
    };
    format!(
        "[Alethe] Time budget: {seconds} s from now. Write your answer by {} s; anything not \
         written when the budget ends is lost.\n\n{text}",
        seconds * 7 / 10
    )
}

#[cfg(test)]
mod budget_tests {
    use super::with_budget;

    #[test]
    fn the_first_turn_states_the_budget_and_when_to_answer() {
        let text = with_budget("Review the diff.".into(), Some(600_000));
        assert!(text.starts_with("[Alethe] Time budget: 600 s"), "{text}");
        assert!(text.contains("by 420 s"), "{text}");
        assert!(text.ends_with("\n\nReview the diff."), "{text}");
    }

    #[test]
    fn a_worker_without_a_budget_gets_its_task_as_is() {
        assert_eq!(
            with_budget("Review the diff.".into(), None),
            "Review the diff."
        );
        assert_eq!(
            with_budget("Review the diff.".into(), Some(500)),
            "Review the diff."
        );
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis() as u64)
        .unwrap_or_default()
}

fn token_value(value: &Value, key: &str) -> u64 {
    value.get(key).and_then(Value::as_u64).unwrap_or_default()
}

fn claude_token_count(usage: &Value) -> Value {
    let input = token_value(usage, "input_tokens");
    let output = token_value(usage, "output_tokens");
    let cached = token_value(usage, "cache_read_input_tokens");
    let cache_creation = token_value(usage, "cache_creation_input_tokens");
    json!({
        "totalTokens": input
            .saturating_add(output)
            .saturating_add(cached)
            .saturating_add(cache_creation),
        "inputTokens": input,
        "outputTokens": output,
        "cachedInputTokens": cached,
        "cacheCreationInputTokens": cache_creation,
    })
}

fn add_token_counts(total: &Value, turn: &Value) -> Value {
    let add = |key: &str| token_value(total, key).saturating_add(token_value(turn, key));
    json!({
        "totalTokens": add("totalTokens"),
        "inputTokens": add("inputTokens"),
        "outputTokens": add("outputTokens"),
        "cachedInputTokens": add("cachedInputTokens"),
        "cacheCreationInputTokens": add("cacheCreationInputTokens"),
    })
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
    cost_usd: Option<f64>,
    /// Live only, like `diff` — never persisted.
    quota: Option<Value>,
    outcome: Option<String>,
    started_at: Option<u64>,
    ended_at: Option<u64>,
    worktree: Option<String>,
    timeout_ms: Option<u64>,
    approval_policy: String,
    sandbox: String,
    web_search: bool,
    /// The role it was delegated under, if any; what the role set is in the fields below.
    role: Option<String>,
    /// The model the planner asked for; None runs the CLI's own default.
    model: Option<String>,
    /// Codex reasoning effort (`model_reasoning_effort`); None keeps the CLI's own setting.
    effort: Option<String>,
    /// The request the worker is stopped on, kept with the rpc id it must be answered with.
    pending: Option<Value>,
    child: Option<Arc<Mutex<Child>>>,
    stdin: Option<Arc<Mutex<ChildStdin>>>,
    inbox: VecDeque<String>,
    /// Why this worker ran on the agent it ran on, recorded only when one side was actually
    /// running out — so the board stays quiet when the choice carried no signal.
    routing: Option<Value>,
    /// Set while an interrupt this side requested is still in flight, so the `result` it aborts is
    /// not reported to the planner as a finished turn.
    awaiting_steer: bool,
    next_request_id: i64,
    /// The worker that took this one's task over after it ended without finishing. The board
    /// leaves a superseded worker out, so a task shows only the worker that currently has it.
    superseded_by: Option<String>,
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
            "role": self.role,
            "plan": self.plan,
            "tokens": self.tokens,
            "costUsd": self.cost_usd,
            "quota": self.quota,
            "routing": self.routing,
            "worktree": self.worktree,
            "model": self.model,
            "effort": self.effort,
            "readOnly": self.sandbox == SANDBOX_READ_ONLY,
            "pendingApproval": self.pending,
            "supersededBy": self.superseded_by,
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
            "tokens": self.tokens,
            "costUsd": self.cost_usd,
            "worktree": self.worktree,
            "approvalPolicy": self.approval_policy,
            "sandbox": self.sandbox,
            "webSearch": self.web_search,
            "supersededBy": self.superseded_by,
            // 0 is "no limit", so a record that lacks the field can still mean the old default.
            "timeoutMs": self.timeout_ms.unwrap_or(0),
            "role": self.role,
            "model": self.model,
            "effort": self.effort,
            "summary": self.report,
            "startedAt": self.started_at,
            "endedAt": self.ended_at,
        })
    }

    fn from_record(value: &Value) -> Option<Self> {
        let text = |key: &str| {
            value
                .get(key)
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
        };
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
            tokens: value
                .get("tokens")
                .cloned()
                .filter(|entry| !entry.is_null()),
            cost_usd: value.get("costUsd").and_then(Value::as_f64),
            quota: None,
            outcome: text("outcome"),
            started_at: value.get("startedAt").and_then(Value::as_u64),
            ended_at: value.get("endedAt").and_then(Value::as_u64),
            worktree: text("worktree"),
            timeout_ms: match value.get("timeoutMs").and_then(Value::as_u64) {
                Some(0) => None,
                Some(ms) => Some(ms),
                None => Some(DEFAULT_JOB_TIMEOUT_MS),
            },
            approval_policy: text("approvalPolicy").unwrap_or_else(|| "never".to_string()),
            sandbox: text("sandbox").unwrap_or_else(|| "workspace-write".to_string()),
            web_search: value
                .get("webSearch")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            role: text("role"),
            model: text("model"),
            effort: text("effort"),
            pending: None,
            child: None,
            stdin: None,
            inbox: VecDeque::new(),
            routing: None,
            awaiting_steer: false,
            next_request_id: 10,
            superseded_by: text("supersededBy"),
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
    /// The budget a worker gets when the call names none; None lets it run without a limit.
    default_timeout_ms: Option<u64>,
    roles: Vec<Role>,
    /// Codex plugins turned off in worker threads.
    worker_disabled_plugins: Vec<String>,
    /// Kind/effort/quota rules that pick a role when the call leaves the choice to Alethe.
    routing: RoutingSettings,
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
            "concurrencyLimit": self.max_concurrent,
            "roles": self.roles
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
    /// One launcher per worker backend (`"codex"`, `"claude"`, ...), keyed by `Launcher::kind`, so
    /// more than one CLI can serve as a worker at the same time.
    launchers: Arc<Mutex<HashMap<String, Launcher>>>,
    /// Per-agent remaining-limit snapshot, pushed in by the app layer. The core never polls for it:
    /// the usage commands live in the full crate and this module is deliberately Tauri-free.
    fitness: Arc<Mutex<HashMap<String, Value>>>,
    observer: Arc<Mutex<Option<Observer>>>,
    dispatch: Arc<Mutex<Option<Sender<Value>>>>,
    store: Arc<Mutex<Option<PathBuf>>>,
    /// The last model list Codex gave, and when; see `list_codex_models`.
    codex_models: Arc<Mutex<Option<(Instant, Value)>>>,
}

impl Default for Core {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner {
                max_concurrent: DEFAULT_MAX_CONCURRENT,
                default_timeout_ms: Some(DEFAULT_JOB_TIMEOUT_MS),
                ..Inner::default()
            })),
            signal: Arc::new(Condvar::new()),
            launchers: Arc::new(Mutex::new(HashMap::new())),
            fitness: Arc::new(Mutex::new(HashMap::new())),
            observer: Arc::new(Mutex::new(None)),
            dispatch: Arc::new(Mutex::new(None)),
            store: Arc::new(Mutex::new(None)),
            codex_models: Arc::new(Mutex::new(None)),
        }
    }
}

fn guard<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    match mutex.lock() {
        Ok(value) => value,
        Err(poisoned) => poisoned.into_inner(),
    }
}

/// What a new Codex thread starts with. Model and effort are sent only when the planner chose them,
/// so a worker delegated without them runs on whatever the person's own Codex config says.
fn thread_start_params(
    cwd: &str,
    approval_policy: &str,
    sandbox: &str,
    web_search: bool,
    model: Option<&str>,
    effort: Option<&str>,
) -> Value {
    let mut config = json!({
        "tools": { "web_search": { "mode": if web_search { "live" } else { "disabled" } } }
    });
    if let Some(effort) = effort {
        config["model_reasoning_effort"] = json!(effort);
    }
    let mut params = json!({
        "cwd": cwd,
        "approvalPolicy": serde_json::from_str::<Value>(approval_policy)
            .unwrap_or(Value::String("never".into())),
        "approvalsReviewer": "user",
        "sandbox": sandbox,
        "config": config
    });
    if let Some(model) = model {
        params["model"] = json!(model);
    }
    params
}

/// Turns the given Codex plugins off for this thread only. Each one otherwise runs its hooks on
/// every worker start and prompt and sends its context with every call, which a worker that only
/// reads and reports has no use for. The person's own hooks and MCP servers are not plugins and stay.
fn disable_plugins(params: &mut Value, plugins: &[String]) {
    for plugin in plugins {
        params["config"]["plugins"][plugin] = json!({ "enabled": false });
    }
}

/// Picking a thread up again takes the same settings it started with. Without them the resumed
/// thread would fall back to the person's config, and a read-only worker could start writing.
fn thread_resume_params(
    thread_id: &str,
    cwd: &str,
    approval_policy: &str,
    sandbox: &str,
    web_search: bool,
    model: Option<&str>,
    effort: Option<&str>,
) -> Value {
    let mut params = thread_start_params(cwd, approval_policy, sandbox, web_search, model, effort);
    params["threadId"] = json!(thread_id);
    params
}

/// Whether the process ended within `limit`. Never waits past it, even when the OS cannot say.
fn exited_within(child: &mut Child, limit: Duration) -> bool {
    let deadline = Instant::now() + limit;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return true,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(50)),
            _ => return false,
        }
    }
}

/// Kills a process and what it started. On Windows the child is often the `cmd.exe` running
/// `codex.cmd`, and killing only that would leave Codex running. `taskkill` is started, not waited
/// on, so a slow one cannot hold the caller.
fn kill_tree(child: &mut Child) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let _ = Command::new("taskkill")
            .args(["/T", "/F", "/PID", &child.id().to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn();
    }
    let _ = child.kill();
}

#[cfg(test)]
mod process_tests {
    use super::{exited_within, kill_tree};
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    fn long_running() -> std::process::Child {
        #[cfg(windows)]
        let mut command = {
            let mut command = Command::new("cmd");
            command.args(["/c", "ping -n 30 127.0.0.1 >NUL"]);
            command
        };
        #[cfg(not(windows))]
        let mut command = {
            let mut command = Command::new("sh");
            command.args(["-c", "sleep 30"]);
            command
        };
        command
            .stdout(Stdio::null())
            .spawn()
            .expect("a long-running process")
    }

    #[test]
    fn a_process_that_does_not_end_is_waited_on_only_as_long_as_allowed() {
        let mut child = long_running();
        let started = Instant::now();
        assert!(!exited_within(&mut child, Duration::from_millis(300)));
        assert!(started.elapsed() < Duration::from_secs(3));

        kill_tree(&mut child);
        assert!(
            exited_within(&mut child, Duration::from_secs(10)),
            "the process survived the kill"
        );
    }
}

/// The models Codex offers, reduced to what the Orchestration settings need: the value to pass
/// as `model`, a name to show and the efforts that model accepts. Hidden models are left out.
fn codex_models(result: &Value) -> Value {
    let models: Vec<Value> = result
        .get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|entry| {
            !entry
                .get("hidden")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        })
        .filter_map(|entry| {
            let model = entry.get("model").and_then(Value::as_str)?;
            let efforts: Vec<&str> = entry
                .get("supportedReasoningEfforts")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|option| option.get("reasoningEffort").and_then(Value::as_str))
                .collect();
            Some(json!({
                "model": model,
                "name": entry.get("displayName").and_then(Value::as_str).unwrap_or(model),
                "defaultEffort": entry.get("defaultReasoningEffort"),
                "efforts": efforts
            }))
        })
        .collect();
    Value::Array(models)
}

/// The role to run instead of `role` while its provider is running out (#268): the one it names,
/// for the same orchestrator, when that one's provider has room and it does not make read-only work
/// writable. One level only, and the note says why, for the worker card.
fn fallback_of<'a>(
    fitness: &HashMap<String, Value>,
    roles: &'a [Role],
    role: &Role,
    orchestrator: Option<&str>,
    threshold: f64,
) -> Option<(&'a Role, Value)> {
    let name = role.fallback.as_deref()?;
    let fallback = role_for(roles, name, orchestrator).filter(|other| other.name != role.name)?;
    if role.read_only && !fallback.read_only {
        return None;
    }
    let snapshot = fitness
        .get(&role.agent)
        .filter(|snapshot| past_threshold(snapshot, threshold))?;
    if fitness
        .get(&fallback.agent)
        .is_some_and(|snapshot| past_threshold(snapshot, threshold))
    {
        return None;
    }
    Some((
        fallback,
        json!({
            "verdict": "fallback",
            "from": role.name,
            "to": fallback.name,
            "agent": role.agent,
            "window": snapshot.get("worst").and_then(Value::as_str).unwrap_or_default(),
            "used": snapshot.get("used").and_then(Value::as_f64).unwrap_or(0.0).round(),
        }),
    ))
}

/// The task categories a delegate call may report; routing rules match on them.
const DELEGATE_KINDS: [&str; 6] = ["research", "code", "review", "command", "scrap", "docs"];
/// The coarse effort classes a delegate call may report; routing rules match on them.
const EFFORT_CLASSES: [&str; 3] = ["light", "standard", "deep"];

/// The kind and effort class a delegate call reports, validated. `effort_class` is accepted as an
/// alias of `effortClass` for planners that snake_case their arguments.
fn delegate_kind_and_effort(
    arguments: &Map<String, Value>,
) -> Result<(Option<String>, Option<String>), String> {
    let kind = match arguments.get("kind") {
        None | Some(Value::Null) => None,
        Some(Value::String(kind)) if DELEGATE_KINDS.contains(&kind.as_str()) => Some(kind.clone()),
        Some(other) => {
            return Err(format!(
                "kind must be one of {}, got {other}",
                DELEGATE_KINDS.join(", ")
            ))
        }
    };
    let effort = match arguments
        .get("effortClass")
        .or_else(|| arguments.get("effort_class"))
    {
        None | Some(Value::Null) => None,
        Some(Value::String(effort)) if EFFORT_CLASSES.contains(&effort.as_str()) => {
            Some(effort.clone())
        }
        Some(other) => {
            return Err(format!(
                "effortClass must be one of {}, got {other}",
                EFFORT_CLASSES.join(", ")
            ))
        }
    };
    Ok((kind, effort))
}

/// A gate reads the cached fitness snapshot the frontend pushes: the per-window table when it is
/// there, else the worst window when it is the one named. A window Alethe has no reading for
/// passes — a gate must never hold work back on a guess.
fn gate_passes(fitness: &HashMap<String, Value>, gate: &QuotaGate) -> bool {
    let Some(snapshot) = fitness.get(&gate.agent) else {
        return true;
    };
    // Codex has no Opus window; its secondary (weekly) window is the closest reading.
    let label = match gate.window.as_str() {
        "short" => "5h",
        "opus" if gate.agent == "codex" => "week",
        other => other,
    };
    let used = snapshot
        .get("windows")
        .and_then(|windows| windows.get(label))
        .and_then(Value::as_f64)
        .or_else(|| {
            (snapshot.get("worst").and_then(Value::as_str) == Some(label))
                .then(|| snapshot.get("used").and_then(Value::as_f64))
                .flatten()
        });
    used.is_none_or(|used| used < gate.below)
}

/// Whether the role runs Claude on an Opus-class model.
fn is_opus_role(role: &Role) -> bool {
    role.agent == "claude"
        && role
            .model
            .as_deref()
            .is_some_and(|model| model.to_ascii_lowercase().contains("opus"))
}

/// The rule that picks a role for a call that leaves the choice to Alethe: the first enabled rule
/// whose kinds, efforts and gates all match, skipping rules whose role this planner cannot reach
/// and — with allowOpusOnDeep off — rules that would land on Opus. The matched call runs exactly
/// as if it had named the role itself. Returns the rewritten arguments and the routing note for
/// the worker card.
fn resolve_routing_rule(
    core: &Core,
    arguments: &Map<String, Value>,
    planner: Option<&str>,
) -> Result<Option<(Map<String, Value>, Value)>, String> {
    let (kind, effort) = delegate_kind_and_effort(arguments)?;
    // An explicit role or model always wins over the rules; without a kind there is nothing to
    // match on.
    if kind.is_none()
        || arguments.get("role").is_some_and(|value| !value.is_null())
        || arguments.get("model").is_some_and(|value| !value.is_null())
    {
        return Ok(None);
    }
    let kind = kind.expect("rule routing requires a kind");
    let inner = guard(&core.inner);
    if inner.routing.rules.is_empty() {
        return Ok(None);
    }
    let orchestrator = planner
        .and_then(|id| inner.planners.get(id))
        .map(|planner| planner.agent.as_str());
    let fitness = guard(&core.fitness);
    for rule in &inner.routing.rules {
        if !rule.enabled {
            continue;
        }
        if !rule.kinds.is_empty() && !rule.kinds.contains(&kind) {
            continue;
        }
        // A call that names no effort only matches a rule open to any effort.
        let effort_matches = match &effort {
            None => rule.efforts.is_empty(),
            Some(effort) => rule.efforts.is_empty() || rule.efforts.contains(effort),
        };
        if !effort_matches {
            continue;
        }
        if !rule.gates.iter().all(|gate| gate_passes(&fitness, gate)) {
            continue;
        }
        let Some(role) = role_for(&inner.roles, &rule.role, orchestrator) else {
            continue;
        };
        if !inner.routing.allow_opus_on_deep && is_opus_role(role) {
            continue;
        }
        let mut resolved = arguments.clone();
        resolved.insert("role".into(), json!(rule.role));
        let note = json!({ "verdict": "rule", "rule": rule.id, "role": rule.role });
        return Ok(Some((resolved, note)));
    }
    Ok(None)
}

/// A delegate call that names a role gets that role's settings and nothing else, so a planner can
/// neither run a read-only role writable nor switch its model. Unknown roles are refused. A role
/// whose provider is running out runs as its fallback, with a routing note that says so. The row
/// used is the one for the calling planner's agent, if there is one (#276).
fn resolve_role(
    core: &Core,
    arguments: &Map<String, Value>,
    planner: Option<&str>,
) -> Result<Option<(Map<String, Value>, Option<Value>)>, String> {
    let name = match arguments.get("role") {
        None | Some(Value::Null) => return Ok(None),
        Some(Value::String(name)) => name,
        Some(other) => return Err(format!("role must be a role name, got {other}")),
    };
    if let Some(field) = ROLE_FIELDS
        .iter()
        .find(|field| arguments.contains_key(**field))
    {
        return Err(format!(
            "role {name} already sets {field}; pass the role or {field}, not both"
        ));
    }
    let inner = guard(&core.inner);
    let orchestrator = planner
        .and_then(|id| inner.planners.get(id))
        .map(|planner| planner.agent.as_str());
    let Some(asked) = role_for(&inner.roles, name, orchestrator) else {
        // The names this planner can ask for, each once.
        let mut known: Vec<&str> = Vec::new();
        for role in &inner.roles {
            let reachable =
                role.orchestrator.is_none() || role.orchestrator.as_deref() == orchestrator;
            if reachable && !known.contains(&role.name.as_str()) {
                known.push(&role.name);
            }
        }
        return Err(format!(
            "unknown role {name}; configured roles: {}",
            if known.is_empty() {
                "none".to_string()
            } else {
                known.join(", ")
            }
        ));
    };
    let (role, note) = match fallback_of(
        &guard(&core.fitness),
        &inner.roles,
        asked,
        orchestrator,
        inner.routing.critical_threshold,
    ) {
        Some((fallback, note)) => (fallback, Some(note)),
        None => (asked, None),
    };
    // The worker keeps the role the planner asked for, so the next delegation of that role decides
    // again. A worker picked up with alethe_send stays where it ran: its thread lives on that agent.
    let mut resolved = arguments.clone();
    resolved.insert("agent".into(), json!(role.agent));
    if let Some(model) = &role.model {
        resolved.insert("model".into(), json!(model));
    }
    if let Some(effort) = &role.effort {
        resolved.insert("effort".into(), json!(effort));
    }
    resolved.insert("readOnly".into(), json!(role.read_only));
    if let Some(seconds) = role.timeout_seconds {
        resolved.insert("timeoutSeconds".into(), json!(seconds));
    }
    Ok(Some((resolved, note)))
}

/// What a Claude worker's command line adds to its launcher: the session to resume, if any, and the
/// model and effort the planner chose.
fn claude_worker_args(
    resume_thread: Option<&str>,
    model: Option<&str>,
    effort: Option<&str>,
) -> Vec<String> {
    let mut args = Vec::new();
    if let Some(thread_id) = resume_thread {
        args.extend(["--resume".to_string(), thread_id.to_string()]);
    }
    if let Some(model) = model {
        args.extend(["--model".to_string(), model.to_string()]);
    }
    if let Some(effort) = effort {
        args.extend(["--effort".to_string(), effort.to_string()]);
    }
    args
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
fn next_from_inbox(inner: &mut Inner, job_id: &str) -> Option<(Arc<Mutex<ChildStdin>>, Value)> {
    let job = inner.jobs.get_mut(job_id)?;
    let stdin = job.stdin.clone()?;
    let thread_id = job.thread_id.clone()?;
    let is_claude = job.agent == "claude";
    let message = job.inbox.pop_front()?;
    if is_claude {
        return Some((
            stdin,
            json!({
                "type": "user",
                "message": { "role": "user", "content": [{ "type": "text", "text": message }] }
            }),
        ));
    }
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
        for record in value
            .get("jobs")
            .and_then(Value::as_array)
            .unwrap_or(&vec![])
        {
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
            let text = |key: &str| {
                record
                    .get(key)
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned)
            };
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
                "version": 2,
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
        guard(&self.launchers).insert(launcher.kind.clone(), launcher);
    }

    /// A fallback note, written when the worker was created, says more than a headroom note and
    /// is kept.
    fn set_job_routing(&self, job_id: &str, routing: Value) {
        let mut inner = guard(&self.inner);
        if let Some(job) = inner
            .jobs
            .get_mut(job_id)
            .filter(|job| job.routing.is_none())
        {
            job.routing = Some(routing);
        }
        self.notify(&inner);
    }

    pub fn set_agent_fitness(&self, agent: &str, snapshot: Value) {
        guard(&self.fitness).insert(agent.to_string(), snapshot);
    }

    /// Every vendor's windows already collapsed to the worst one by the caller, so `used` is
    /// comparable across agents that do not report the same set of windows.
    fn fitness_block(&self) -> Option<Value> {
        let fitness = guard(&self.fitness);
        if fitness.is_empty() {
            return None;
        }
        // Sorted, because the source is a HashMap and both the key order the planner reads and the
        // agent picked on a tie have to be the same on every call.
        let mut entries: Vec<(&String, &Value)> = fitness.iter().collect();
        entries.sort_by(|a, b| a.0.cmp(b.0));
        let mut block = Map::new();
        let mut best: Option<(String, f64)> = None;
        for (agent, snapshot) in entries {
            let score = strain_of(snapshot);
            if best.as_ref().is_none_or(|(_, top)| score < *top) {
                best = Some((agent.clone(), score));
            }
            block.insert(agent.clone(), snapshot.clone());
        }
        if let Some((agent, _)) = best {
            block.insert("headroom".into(), Value::String(agent));
        }
        Some(Value::Object(block))
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

    /// Takes the Orchestration settings from Preferences. Workers already delegated keep what they
    /// were given; the next call and a Restart see the new values.
    pub fn apply_settings(&self, settings: OrchestrationSettings) {
        {
            let mut inner = guard(&self.inner);
            inner.max_concurrent = settings.max_concurrent.clamp(1, 16);
            inner.default_timeout_ms = match settings.default_timeout_seconds {
                0 => None,
                seconds => Some(seconds.saturating_mul(1000)),
            };
            inner.roles = settings.roles;
            inner.worker_disabled_plugins = settings.worker_disabled_plugins;
            inner.routing = settings.routing;
            self.notify(&inner);
        }
        // A higher limit lets queued work start now instead of after the next worker finishes.
        self.drain_queue();
    }

    /// The models the installed Codex offers. Each ask starts a short-lived `app-server`, and
    /// short-lived Codex processes are tied to lsass crashes on Windows (#202), so an answer is
    /// reused for a while instead of asking again every time the settings open. A failed ask is not
    /// kept.
    pub fn list_codex_models(&self) -> Result<Value, String> {
        if let Some((at, models)) = guard(&self.codex_models).as_ref() {
            if at.elapsed() < CODEX_MODELS_TTL {
                return Ok(models.clone());
            }
        }
        let models = self.ask_codex_models()?;
        *guard(&self.codex_models) = Some((Instant::now(), models.clone()));
        Ok(models)
    }

    fn ask_codex_models(&self) -> Result<Value, String> {
        let launcher = guard(&self.launchers)
            .get("codex")
            .cloned()
            .ok_or_else(|| "codex is not installed".to_string())?;
        let mut command = Command::new(&launcher.program);
        command
            .args(&launcher.args)
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
        let mut child = command
            .spawn()
            .map_err(|error| format!("codex did not start: {error}"))?;
        let stdout = child.stdout.take();
        // Codex shuts down at the end of its input, before a pending model/list is answered, so
        // stdin stays open until the answer is in.
        let mut stdin = child.stdin.take();
        let written = stdin.as_mut().map(|stdin| {
            [
                json!({ "id": 1, "method": "initialize", "params": {
                    "clientInfo": { "name": "alethe-orchestrator", "title": "Alethe", "version": "1" }
                } }),
                json!({ "method": "initialized" }),
                // ponytail: one page of 100; follow nextCursor if Codex ever lists more.
                json!({ "id": 2, "method": "model/list", "params": { "limit": 100 } }),
            ]
            .iter()
            .try_for_each(|request| writeln!(stdin, "{request}"))
        });
        let (sender, receiver) = channel();
        if let Some(stdout) = stdout {
            thread::spawn(move || {
                for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                    let Ok(message) = serde_json::from_str::<Value>(&line) else {
                        continue;
                    };
                    if message.get("id") == Some(&json!(2)) {
                        let _ = sender.send(message);
                        break;
                    }
                }
            });
        }
        let reply = receiver.recv_timeout(Duration::from_secs(15));
        // Closing the input lets Codex exit on its own. Killing it mid-call is tied to lsass
        // crashes on Windows (#202), so that is only the fallback. Both waits are bounded, so the
        // settings page never hangs on a Codex that will not go.
        drop(stdin);
        if !exited_within(&mut child, Duration::from_secs(5)) {
            kill_tree(&mut child);
            let _ = exited_within(&mut child, Duration::from_secs(5));
        }
        if !matches!(written, Some(Ok(()))) {
            return Err("codex did not take the request".into());
        }
        let reply = reply.map_err(|error| match error {
            RecvTimeoutError::Timeout => "codex did not list its models in time".to_string(),
            RecvTimeoutError::Disconnected => {
                "codex exited before it listed its models".to_string()
            }
        })?;
        if let Some(error) = reply.get("error") {
            return Err(format!("codex could not list its models: {error}"));
        }
        Ok(codex_models(reply.get("result").unwrap_or(&Value::Null)))
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
        let (agent, cwd, spec, resume_thread, approval_policy, sandbox, web_search, model, effort) = {
            let mut inner = guard(&self.inner);
            let Some(job) = inner.jobs.get_mut(job_id) else {
                return;
            };
            // A worker that ended while it waited in the queue stays ended.
            if job.settled() {
                return;
            }
            job.status = STATUS_RUNNING.to_string();
            // A worker that runs again is current again, whatever replaced it meanwhile.
            job.superseded_by = None;
            job.started_at = Some(now_ms());
            job.ended_at = None;
            // Work that arrived while the worker was down leads; otherwise this is its first turn.
            let first_turn = with_budget(
                job.inbox.pop_front().unwrap_or_else(|| job.spec.clone()),
                job.timeout_ms,
            );
            let started = (
                job.agent.clone(),
                job.cwd.clone(),
                first_turn,
                job.thread_id.clone(),
                job.approval_policy.clone(),
                job.sandbox.clone(),
                job.web_search,
                job.model.clone(),
                job.effort.clone(),
            );
            inner.running += 1;
            started
        };

        let Some(launcher) = guard(&self.launchers).get(&agent).cloned() else {
            self.settle(
                job_id,
                STATUS_FAILED,
                "failed",
                &format!("no worker launcher configured for agent {agent}"),
            );
            return;
        };
        let is_claude = agent == "claude";

        let mut command = Command::new(&launcher.program);
        command
            .args(&launcher.args)
            .current_dir(PathBuf::from(&cwd))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        // Claude keeps its own session on disk under this id — no separate resume RPC like Codex's
        // `thread/resume`, the CLI just needs the id up front.
        if is_claude {
            command.args(claude_worker_args(
                resume_thread.as_deref(),
                model.as_deref(),
                effort.as_deref(),
            ));
        }
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

        if is_claude {
            // no handshake: the first line written is the first turn
            let _ = send_rpc(
                &stdin,
                &json!({
                    "type": "user",
                    "message": { "role": "user", "content": [{ "type": "text", "text": spec }] }
                }),
            );
        } else {
            let _ = send_rpc(
                &stdin,
                &json!({
                    "id": 1,
                    "method": "initialize",
                    "params": {
                        "clientInfo": { "name": "alethe-orchestrator", "title": "Alethe", "version": "1" },
                        // Granular approvals are gated behind this: without it the worker cannot route
                        // its question here and gives up on the write instead of asking.
                        "capabilities": { "experimentalApi": true }
                    }
                }),
            );
            let _ = send_rpc(&stdin, &json!({ "method": "initialized" }));
            // Codex keeps threads on disk, so a worker whose process died can pick up its own history
            // instead of reading everything again.
            let mut opening = match &resume_thread {
                Some(thread_id) => json!({
                    "id": 2,
                    "method": "thread/resume",
                    "params": thread_resume_params(
                        thread_id,
                        &cwd,
                        &approval_policy,
                        &sandbox,
                        web_search,
                        model.as_deref(),
                        effort.as_deref(),
                    )
                }),
                None => json!({
                    "id": 2,
                    "method": "thread/start",
                    "params": thread_start_params(
                        &cwd,
                        &approval_policy,
                        &sandbox,
                        web_search,
                        model.as_deref(),
                        effort.as_deref(),
                    )
                }),
            };
            let plugins = guard(&self.inner).worker_disabled_plugins.clone();
            disable_plugins(&mut opening["params"], &plugins);
            let _ = send_rpc(&stdin, &opening);
        }

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
                    if is_claude {
                        core.on_worker_message_claude(&owned_id, &message);
                    } else {
                        core.on_worker_message(&owned_id, &stdin, &spec, &message);
                    }
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
        // A revived worker is armed again when it starts, so this watchdog answers only for the
        // run that armed it.
        let run = guard(&self.inner)
            .jobs
            .get(&job_id)
            .and_then(|job| job.started_at);
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(timeout_ms));
            let (payload, written) = {
                let inner = guard(&core.inner);
                let Some(job) = inner.jobs.get(&job_id) else {
                    return;
                };
                if job.settled() || job.started_at != run {
                    return;
                }
                let payload = match (job.thread_id.clone(), job.active_turn_id.clone()) {
                    (Some(thread_id), Some(turn_id)) => {
                        Some(json!({ "threadId": thread_id, "turnId": turn_id }))
                    }
                    _ => None,
                };
                // The live stream holds what the worker said this turn and the report its last
                // finished message, which for Codex is part of the stream. Neither is dropped.
                let reply = job.reply.trim();
                let report = job.report.trim();
                let written = if reply.is_empty() {
                    report.to_string()
                } else if report.is_empty() || reply.contains(report) {
                    tail(reply, REPLY_LIMIT)
                } else {
                    tail(&format!("{report}\n\n{reply}"), REPLY_LIMIT)
                };
                (payload, written)
            };
            if let Some(payload) = payload {
                let staged = {
                    let mut inner = guard(&core.inner);
                    stage_rpc(&mut inner, &job_id, "turn/interrupt", payload)
                };
                if let Ok((stdin, request)) = staged {
                    // Detached: a worker that stopped reading its input can hold the write, and
                    // the stop below still has to happen on time. The teardown closes the pipe.
                    thread::spawn(move || {
                        let _ = send_rpc(&stdin, &request);
                    });
                }
            }
            let stopped = format!(
                "worker passed its {}s budget and was stopped",
                timeout_ms / 1000
            );
            core.finish(
                &job_id,
                STATUS_FAILED,
                Some("timeout".into()),
                if written.is_empty() {
                    stopped
                } else {
                    format!("{stopped}. What it had written by then:\n\n{written}")
                },
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

    /// A worker stops on these until someone answers. Anything we do not recognise is refused
    /// rather than left pending, because an unanswered request hangs that worker for good.
    fn on_worker_request(
        &self,
        job_id: &str,
        stdin: &Arc<Mutex<ChildStdin>>,
        rpc_id: &Value,
        method: &str,
        params: &Value,
    ) {
        let kind = match method {
            "item/commandExecution/requestApproval" => "command",
            "item/fileChange/requestApproval" => "fileChange",
            _ => {
                let _ = send_rpc(
                    stdin,
                    &json!({
                        "id": rpc_id,
                        "error": { "code": -32601, "message": format!("unsupported request {method}") }
                    }),
                );
                return;
            }
        };

        let ask = json!({
            "rpcId": rpc_id,
            "kind": kind,
            "command": params.get("command").and_then(Value::as_str),
            "cwd": params.get("cwd").and_then(Value::as_str),
            "reason": params.get("reason").and_then(Value::as_str),
            "askedAtMs": now_ms(),
        });

        {
            let mut inner = guard(&self.inner);
            if let Some(job) = inner.jobs.get_mut(job_id) {
                job.pending = Some(ask);
                job.status = STATUS_BLOCKED.to_string();
            }
            self.notify(&inner);
        }
        self.signal.notify_all();
    }

    /// Sends the answer on the id the worker is waiting on and lets it carry on.
    pub fn answer(&self, job_id: &str, decision: &str) -> Result<Value, String> {
        const DECISIONS: [&str; 4] = ["accept", "acceptForSession", "decline", "abort"];
        if !DECISIONS.contains(&decision) {
            return Err(format!("decision must be one of {}", DECISIONS.join(", ")));
        }
        let (stdin, rpc_id) = {
            let mut inner = guard(&self.inner);
            let job = inner
                .jobs
                .get_mut(job_id)
                .ok_or_else(|| format!("unknown job {job_id}"))?;
            let pending = job
                .pending
                .take()
                .ok_or_else(|| format!("job {job_id} is not waiting on anything"))?;
            let rpc_id = pending
                .get("rpcId")
                .cloned()
                .ok_or_else(|| "the pending request has no id to answer".to_string())?;
            let stdin = job
                .stdin
                .clone()
                .ok_or_else(|| format!("job {job_id} has no live worker"))?;
            job.status = STATUS_RUNNING.to_string();
            self.notify(&inner);
            (stdin, rpc_id)
        };
        send_rpc(
            &stdin,
            &json!({ "id": rpc_id, "result": { "decision": decision } }),
        )?;
        Ok(json!({ "answered": job_id, "decision": decision }))
    }

    /// The unified diff a Codex worker has produced so far, straight off its own `turn/diff/updated`
    /// reports — the same text `alethe_diff` hands the planner, now for the person to read too.
    pub fn job_diff(&self, job_id: &str) -> Result<String, String> {
        let inner = guard(&self.inner);
        let job = inner
            .jobs
            .get(job_id)
            .ok_or_else(|| format!("unknown job {job_id}"))?;
        Ok(job.diff.clone().unwrap_or_default())
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

        // Both an id and a method means the worker is asking, not telling: it stops until answered.
        if let (Some(rpc_id), true) = (message.get("id").cloned(), !method.is_empty()) {
            self.on_worker_request(job_id, stdin, &rpc_id, method, &params);
            return;
        }

        // Codex refused to open the thread or start its first turn, e.g. on a model or effort it
        // does not accept. Nothing else follows, so without this the worker would show running,
        // holding its slot, until its budget ran out, or for good without one.
        if let (Some(2 | 3), Some(error)) = (
            message.get("id").and_then(Value::as_i64),
            message.get("error"),
        ) {
            let reason = error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("no reason given");
            self.settle(
                job_id,
                STATUS_FAILED,
                "start-failed",
                &format!("codex did not start the worker: {reason}"),
            );
            return;
        }

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
                    push_reply(&mut job.reply, delta);
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
                    if completed {
                        STATUS_DONE
                    } else {
                        STATUS_FAILED
                    },
                    Some(if completed {
                        "succeeded".into()
                    } else {
                        "failed".into()
                    }),
                    summary,
                    false,
                );
                return;
            }
            _ => return,
        }

        self.notify(&inner);
    }

    /// Flat `{"type": ...}` events, no request/response envelope like Codex's.
    fn on_worker_message_claude(&self, job_id: &str, message: &Value) {
        let kind = message.get("type").and_then(Value::as_str).unwrap_or("");
        match kind {
            "rate_limit_event" => {
                let Some(info) = message.get("rate_limit_info").cloned() else {
                    return;
                };
                let mut inner = guard(&self.inner);
                if let Some(job) = inner.jobs.get_mut(job_id) {
                    job.quota = Some(info);
                }
                self.notify(&inner);
            }
            "system" => match message.get("subtype").and_then(Value::as_str).unwrap_or("") {
                "init" => {
                    let Some(session_id) = message.get("session_id").and_then(Value::as_str) else {
                        return;
                    };
                    let mut inner = guard(&self.inner);
                    if let Some(job) = inner.jobs.get_mut(job_id) {
                        if job.thread_id.is_none() {
                            job.thread_id = Some(session_id.to_string());
                        }
                    }
                    self.notify(&inner);
                }
                "permission_denied" => {
                    let note = message
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("a tool call was denied permission");
                    let mut inner = guard(&self.inner);
                    if let Some(job) = inner.jobs.get_mut(job_id) {
                        job.reply.push_str(&format!("\n[blocked] {note}\n"));
                    }
                    self.notify(&inner);
                }
                _ => {}
            },
            "assistant" => {
                let text = message
                    .get("message")
                    .and_then(|m| m.get("content"))
                    .and_then(Value::as_array)
                    .map(|blocks| {
                        blocks
                            .iter()
                            .filter(|block| {
                                block.get("type").and_then(Value::as_str) == Some("text")
                            })
                            .filter_map(|block| block.get("text").and_then(Value::as_str))
                            .collect::<Vec<_>>()
                            .join("")
                    })
                    .unwrap_or_default();
                if text.is_empty() {
                    return;
                }
                let mut inner = guard(&self.inner);
                if let Some(job) = inner.jobs.get_mut(job_id) {
                    push_reply(&mut job.reply, &text);
                }
                self.notify(&inner);
            }
            "result" => {
                let is_error = message
                    .get("is_error")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let result_text = message
                    .get("result")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .trim()
                    .to_string();
                let usage = message.get("usage");
                let turn_cost = message.get("total_cost_usd").and_then(Value::as_f64);
                let cwd = {
                    let mut inner = guard(&self.inner);
                    let cwd = inner.jobs.get(job_id).map(|job| job.cwd.clone());
                    if let Some(job) = inner.jobs.get_mut(job_id) {
                        if let Some(usage) = usage {
                            let last = claude_token_count(usage);
                            let total = job
                                .tokens
                                .as_ref()
                                .and_then(|tokens| tokens.get("total"))
                                .map(|current| add_token_counts(current, &last))
                                .unwrap_or_else(|| last.clone());
                            job.tokens = Some(json!({ "total": total, "last": last }));
                        }
                        if let Some(cost) =
                            turn_cost.filter(|cost| cost.is_finite() && *cost >= 0.0)
                        {
                            job.cost_usd = Some(job.cost_usd.unwrap_or_default() + cost);
                        }
                    }
                    cwd
                };
                if let Some(cwd) = cwd {
                    if let Ok(diff) = git(&PathBuf::from(&cwd), &["diff", "HEAD"]) {
                        if !diff.trim().is_empty() {
                            let mut inner = guard(&self.inner);
                            if let Some(job) = inner.jobs.get_mut(job_id) {
                                job.diff = Some(diff);
                            }
                        }
                    }
                }
                let summary = if result_text.is_empty() {
                    let inner = guard(&self.inner);
                    inner
                        .jobs
                        .get(job_id)
                        .map(|job| tail(job.reply.trim(), REPLY_LIMIT))
                        .unwrap_or_default()
                } else {
                    result_text
                };
                let steering = {
                    let mut inner = guard(&self.inner);
                    inner
                        .jobs
                        .get_mut(job_id)
                        .map(|job| std::mem::take(&mut job.awaiting_steer))
                        .unwrap_or(false)
                };
                if steering {
                    self.finish_turn(
                        job_id,
                        STATUS_INTERRUPTED,
                        None,
                        String::new(),
                        false,
                        false,
                    );
                    return;
                }
                self.finish(
                    job_id,
                    if is_error { STATUS_FAILED } else { STATUS_DONE },
                    Some(if is_error {
                        "failed".into()
                    } else {
                        "succeeded".into()
                    }),
                    summary,
                    false,
                );
            }
            _ => {}
        }
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
        self.finish_turn(job_id, status, outcome, text, terminal, true);
    }

    /// `announce` is false for the `result` that only acknowledges an interrupt this side asked
    /// for: the turn ended, but nothing was delivered, so the planner must not be told it was.
    fn finish_turn(
        &self,
        job_id: &str,
        status: &str,
        outcome: Option<String>,
        text: String,
        terminal: bool,
        announce: bool,
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
            // Only a running worker, or one blocked on a question, holds a slot. A queued one never
            // took a slot and is still in the queue, which would start it despite this ending.
            let held_slot = matches!(job.status.as_str(), STATUS_RUNNING | STATUS_BLOCKED);
            job.status = status.to_string();
            job.pending = None;
            if !text.trim().is_empty() {
                job.report = text.trim().to_string();
            }
            job.outcome = outcome.clone();
            job.ended_at = Some(now_ms());
            job.active_turn_id = None;
            if terminal {
                job.teardown();
            }
            if held_slot {
                inner.running = inner.running.saturating_sub(1);
            }
            inner.queue.retain(|queued| queued != job_id);
            if announce {
                inner.push_delivery("worker_done", job_id, outcome, text);
            }

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
                    // A turn this side interrupted delivered nothing, so what it had written stays
                    // as the report until the next turn says more; a budget running out mid-way
                    // must not lose it.
                    job.report = if announce {
                        String::new()
                    } else if job.reply.trim().is_empty() {
                        std::mem::take(&mut job.report)
                    } else {
                        tail(job.reply.trim(), REPLY_LIMIT)
                    };
                    job.reply.clear();
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
            "description": "Hand independent units of work to Codex or Claude workers that Alethe runs as separate processes. These are NOT your own subagents: they are a different agent on its own token budget, so their reading and writing costs you nothing but the task text. Prefer this over launching subagents of your own for the same work. They also outlive the turn, can be corrected mid-run with alethe_steer, and can each take an isolated git worktree. Returns job ids immediately; the workers run in parallel. Delegate when the work splits into units that each need their own reading and judgement, and there are at least two of them: one unit per area of the codebase, per service, per feature. Send every unit in ONE call so they run at the same time, and make each task self contained. Always say what the work is in kind, and set effortClass when you can tell how much thinking it needs. Name neither role nor model and Alethe picks the role from the person's routing rules - kind, effortClass and the live quotas decide; a role or model you name always wins over the rules. Do NOT delegate work that is uniform across its inputs, that one command or script does in a single pass, or that is quicker to finish than to describe.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "tasks": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "One self contained instruction per worker."
                    },
                    "agent": {
                        "type": "string",
                        "enum": ["codex", "claude"],
                        "description": "Which CLI runs the worker. Defaults to codex. A Claude worker runs without an approval channel (bypasses permissions) and does not yet report a live diff. Each vendor meters a different set of windows - Codex a 5 hour and a weekly one, Claude those two plus a separate weekly budget for Opus - so how much room one has left says nothing about the other. Do not reason about that from here: every response these tools return carries a fitness block with the current reading and names the side with room in headroom. Read it and prefer that side when one is running out."
                    },
                    "cwd": { "type": "string", "description": "Working directory. Defaults to the lead's directory." },
                    "label": { "type": "string", "description": "A short name for this batch, in the user's words - what it is for, not how it is done. It is how the person watching tells one round of delegation from another." },
                    "isolate": {
                        "type": "boolean",
                        "description": "Give each worker its own detached git worktree. Use it whenever two units could touch the same files; without it parallel workers share one directory and can overwrite each other. Requires a git repository. The worktree path comes back with the job and is left in place for review."
                    },
                    "askForApproval": {
                        "type": "boolean",
                        "description": "Make each worker stop and ask you before it reaches outside its own working directory - the network, another folder, anything the sandbox would otherwise refuse. Work inside the directory still proceeds on its own. Use it whenever the work touches a repository that matters. A worker that is asking shows up as blocked and is answered with alethe_answer."
                    },
                    "webSearch": {
                        "type": "boolean",
                        "description": "Give each worker a live web search tool, on top of its shell and files. Use it for research: real cases, current facts, sources you can cite - not for work confined to a repository, where it adds nothing."
                    },
                    "model": {
                        "type": "string",
                        "description": "The model each worker runs, as the chosen CLI names it (for example a Codex model for agent codex, a Claude model for agent claude). Omit it to use the CLI's own default. Pick a different model when the unit needs one - such as an independent review by another model than the one that wrote the code."
                    },
                    "effort": {
                        "type": "string",
                        "description": "Reasoning effort. For Codex, one the model supports (commonly low, medium, high or xhigh); for Claude, low, medium, high, xhigh or max. Omit it to keep the CLI's own setting."
                    },
                    "kind": {
                        "type": "string",
                        "enum": ["research", "code", "review", "command", "scrap", "docs"],
                        "description": "What the work is. Always set it: with no role and no model named, it is what Alethe's routing rules match on to pick the role."
                    },
                    "effortClass": {
                        "type": "string",
                        "enum": ["light", "standard", "deep"],
                        "description": "How much thinking the work needs, coarse: light, standard or deep. Routing rules can send deep work to stronger roles. Omit it when you cannot tell; rules that ask for an effort class then do not match."
                    },
                    "readOnly": {
                        "type": "boolean",
                        "description": "Start each Codex worker in a read-only sandbox: it can read files and run commands, but cannot write. Use it for reviews and audits that must not change anything. Cannot be combined with askForApproval, and not available for Claude workers."
                    },
                    "timeoutSeconds": {
                        "type": "number",
                        "description": "Budget per worker before Alethe stops it, default 900 unless the person changed it in the Orchestration settings. The worker is told its budget when it starts, and a worker that is stopped still delivers what it had written. Pass 0 to let a worker run without a limit."
                    },
                    "role": {
                        "type": "string",
                        "description": "A role the person configured in Alethe's Orchestration settings, such as a reviewer. alethe_status lists the roles and what each one runs on; a row whose orchestrator is your own agent wins over the row with no orchestrator of the same name. The role sets agent, model, effort, readOnly and the time budget, so do not pass any of those with it. Prefer a role over spelling those out when one fits the work."
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
            "description": "Your workers without blocking: status, elapsed time, the last plan steps and token usage, with long texts trimmed. Lists the ones still active plus your most recent settled ones; omitted says how many were left out. Use alethe_check for what a worker reported.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "all": {
                        "type": "boolean",
                        "description": "Also list other planners' workers and older settled ones, still trimmed."
                    }
                }
            }
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
            "name": "alethe_answer",
            "description": "Answer the question a worker is stopped on. Until it is answered that worker does nothing and holds its slot. Decline lets it carry on down another path; abort ends its turn.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "jobId": { "type": "string" },
                    "decision": {
                        "type": "string",
                        "enum": ["accept", "acceptForSession", "decline", "abort"]
                    }
                },
                "required": ["jobId", "decision"]
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

/// An optional model or effort name. A Claude model becomes a command-line argument, so a value that
/// is empty, contains whitespace or starts with `-` is refused rather than passed on.
fn option_name(arguments: &Map<String, Value>, key: &str) -> Result<Option<String>, String> {
    match arguments.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value))
            if !value.is_empty()
                && !value.starts_with('-')
                && !value.chars().any(|c| c.is_whitespace() || c.is_control()) =>
        {
            Ok(Some(value.clone()))
        }
        Some(other) => Err(format!(
            "{key} must be a name without spaces that does not start with '-', got {other}"
        )),
    }
}

fn required_str(arguments: &Map<String, Value>, key: &str) -> Result<String, String> {
    arguments
        .get(key)
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .ok_or_else(|| format!("{key} is required"))
}

/// How close an agent is to its ceiling. Being rate-limited outranks any percentage: the window is
/// not almost gone, it is gone.
fn strain_of(snapshot: &Value) -> f64 {
    let limited = snapshot
        .get("rateLimited")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if limited {
        return f64::MAX;
    }
    snapshot.get("used").and_then(Value::as_f64).unwrap_or(0.0)
}

/// Past the share of a window the routing settings call critical (default 80%, so the planner's
/// hint and the human's warning chip agree until the person moves it).
fn past_threshold(snapshot: &Value, threshold: f64) -> bool {
    strain_of(snapshot) >= threshold
}

/// The **most** strained agent past the threshold, not merely the first one found — when both sides
/// are running out, the board has to name the same one on every call.
fn strained_agent(block: &Value, threshold: f64) -> Option<(String, f64, String)> {
    block
        .as_object()?
        .iter()
        .filter(|(agent, snapshot)| agent.as_str() != "headroom" && past_threshold(snapshot, threshold))
        .max_by(|a, b| {
            strain_of(a.1)
                .partial_cmp(&strain_of(b.1))
                .unwrap_or(std::cmp::Ordering::Equal)
        })
        .map(|(agent, snapshot)| {
            let used = snapshot.get("used").and_then(Value::as_f64).unwrap_or(0.0);
            let window = snapshot
                .get("worst")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            (agent.clone(), used, window)
        })
}

/// Recorded on the worker so the board can show why it ran where it ran. `ignored` is the case
/// worth seeing: the planner had this same reading in every earlier tool response and delegated
/// into the strained side anyway.
fn routing_note(block: &Value, requested: &str, threshold: f64) -> Option<Value> {
    let (agent, used, window) = strained_agent(block, threshold)?;
    Some(json!({
        "verdict": if requested == agent { "ignored" } else { "chosen" },
        "agent": agent,
        "window": window,
        "used": used.round(),
    }))
}

fn headroom_hint(block: &Value, requested: &str, threshold: f64) -> Option<Value> {
    let snapshot = block.get(requested)?;
    let used = snapshot.get("used").and_then(Value::as_f64).unwrap_or(0.0);
    let limited = snapshot
        .get("rateLimited")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if !limited && used < threshold {
        return None;
    }
    let other = block.get("headroom").and_then(Value::as_str)?;
    if other == requested {
        return None;
    }
    let other_snapshot = block.get(other)?;
    let other_used = other_snapshot
        .get("used")
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    let window = snapshot
        .get("worst")
        .and_then(Value::as_str)
        .unwrap_or("its");
    let here = if limited {
        format!("{requested} is rate-limited right now")
    } else {
        format!("{requested} is at {used:.0}% of its {window} window")
    };
    // Naming the roomier side without saying it is also nearly gone would read as "this one is
    // fine", and it is not.
    let both_strained = past_threshold(other_snapshot, threshold);
    Some(json!({
        "agent": other,
        "bothStrained": both_strained,
        "reason": if both_strained {
            format!("{here}, and {other} is at {other_used:.0}% — both are running out; {other} has the most room left")
        } else {
            format!("{here}; {other} is at {other_used:.0}%")
        }
    }))
}

/// The `alethe_delegate` arguments that run `job`'s request again as a new worker. An isolated
/// worker ran in `<repo>/.alethe/worktrees/<id>` (see `isolate_worktree`), so its rerun asks for a
/// fresh worktree of that same repository instead of reusing the old one.
fn restart_arguments(job: &Job) -> Map<String, Value> {
    let repository = job
        .worktree
        .as_deref()
        .and_then(|path| std::path::Path::new(path).ancestors().nth(3))
        .map(|root| root.to_string_lossy().into_owned());
    let mut arguments = Map::new();
    arguments.insert("tasks".into(), json!([job.spec]));
    arguments.insert(
        "cwd".into(),
        json!(repository.unwrap_or_else(|| job.cwd.clone())),
    );
    if let Some(label) = &job.run_label {
        arguments.insert("label".into(), json!(label));
    }
    arguments.insert("isolate".into(), json!(job.worktree.is_some()));
    // `approval_policy` holds the JSON the delegate built: a `granular` object when the worker was
    // asked to stop before reaching outside its workspace, the string "never" otherwise.
    arguments.insert(
        "askForApproval".into(),
        json!(job.approval_policy.contains("granular")),
    );
    arguments.insert("webSearch".into(), json!(job.web_search));
    // A role sets the agent, model, effort, sandbox and budget again, as it does for the planner,
    // and refuses any of them passed alongside it. Without one, the worker runs again on what it
    // was given.
    if let Some(role) = &job.role {
        arguments.insert("role".into(), json!(role));
        return arguments;
    }
    arguments.insert("agent".into(), json!(job.agent));
    if let Some(model) = &job.model {
        arguments.insert("model".into(), json!(model));
    }
    if let Some(effort) = &job.effort {
        arguments.insert("effort".into(), json!(effort));
    }
    arguments.insert("readOnly".into(), json!(job.sandbox == SANDBOX_READ_ONLY));
    arguments.insert(
        "timeoutSeconds".into(),
        json!(job.timeout_ms.map_or(0, |ms| ms / 1000)),
    );
    arguments
}

/// The board's Restart: runs a worker's request again as a new worker under the same planner,
/// stopping the old one first while it is still active.
pub fn restart_job(core: &Core, job_id: &str) -> Result<Value, String> {
    let (arguments, planner, active) = {
        let inner = guard(&core.inner);
        let job = inner
            .jobs
            .get(job_id)
            .ok_or_else(|| format!("unknown job {job_id}"))?;
        let active = [STATUS_QUEUED, STATUS_RUNNING, STATUS_BLOCKED].contains(&job.status.as_str());
        (restart_arguments(job), job.planner_id.clone(), active)
    };
    if active {
        let mut cancel = Map::new();
        cancel.insert("jobIds".into(), json!([job_id]));
        call_tool(core, "alethe_cancel", &cancel, None)?;
    }
    call_tool(core, "alethe_delegate", &arguments, planner.as_deref())
}

/// Every tool answers with the current per-agent headroom, because a tool result is the only
/// channel this transport can push to the planner — see the roadmap's Phase 5 note on why a
/// `tools/list_changed` notification is not an option here.
pub fn call_tool(
    core: &Core,
    name: &str,
    arguments: &Map<String, Value>,
    planner: Option<&str>,
) -> Result<Value, String> {
    let mut value = dispatch_tool(core, name, arguments, planner)?;
    let (Some(block), Some(map)) = (core.fitness_block(), value.as_object_mut()) else {
        return Ok(value);
    };
    if name == "alethe_delegate" {
        let ids: Vec<String> = map
            .get("jobs")
            .and_then(Value::as_array)
            .map(|jobs| {
                jobs.iter()
                    .filter_map(|job| job.get("id").and_then(Value::as_str))
                    .map(ToOwned::to_owned)
                    .collect()
            })
            .unwrap_or_default();
        // The agent the workers run on: a call made with a role has no `agent` of its own.
        let requested = ids
            .first()
            .and_then(|id| guard(&core.inner).jobs.get(id).map(|job| job.agent.clone()))
            .or_else(|| {
                arguments
                    .get("agent")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned)
            })
            .unwrap_or_else(|| "codex".to_string());
        let requested = requested.as_str();
        let threshold = guard(&core.inner).routing.critical_threshold;
        if let Some(note) = routing_note(&block, requested, threshold) {
            for id in ids {
                core.set_job_routing(&id, note.clone());
            }
        }
        if let Some(hint) = headroom_hint(&block, requested, threshold) {
            map.insert("headroomHint".into(), hint);
        }
    }
    map.insert("fitness".into(), block);
    Ok(value)
}

fn dispatch_tool(
    core: &Core,
    name: &str,
    arguments: &Map<String, Value>,
    planner: Option<&str>,
) -> Result<Value, String> {
    match name {
        "alethe_delegate" => {
            // A rule becomes a role and a role becomes ordinary arguments, so everything goes
            // through the same checks as a call that spells them out.
            let routed = resolve_routing_rule(core, arguments, planner)?;
            let rule_note = routed.as_ref().map(|(_, note)| note.clone());
            let arguments = routed.as_ref().map_or(arguments, |(resolved, _)| resolved);
            let resolved = resolve_role(core, arguments, planner)?;
            let fallback_note = resolved.as_ref().and_then(|(_, note)| note.clone());
            let arguments = resolved
                .as_ref()
                .map_or(arguments, |(resolved, _)| resolved);
            // The note the worker card shows: a fallback says more than the rule that picked the
            // role, so it wins and carries the rule id along.
            let mut routing_at_start = match (fallback_note.clone(), rule_note.clone()) {
                (Some(mut fallback), Some(rule)) => {
                    if let (Some(object), Some(id)) =
                        (fallback.as_object_mut(), rule.get("rule").cloned())
                    {
                        object.insert("rule".into(), id);
                    }
                    Some(fallback)
                }
                (fallback, rule) => fallback.or(rule),
            };
            let role = arguments
                .get("role")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned);
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
            // What a worker may do without asking is the sandbox, not the policy: with
            // workspace-write it never asks, because everything it wants is already permitted.
            // Asking means starting it read-only, so every write and every command has to be
            // escalated - and escalation is the question the person answers.
            let ask = arguments
                .get("askForApproval")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let web_search = arguments
                .get("webSearch")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            // Anything but a boolean is refused: read as false it would start a writable worker the
            // caller meant to only read.
            let read_only = match arguments.get("readOnly") {
                None | Some(Value::Null) => false,
                Some(Value::Bool(value)) => *value,
                Some(other) => return Err(format!("readOnly must be true or false, got {other}")),
            };
            let model = option_name(arguments, "model")?;
            let effort = option_name(arguments, "effort")?;
            // Not validated here on purpose — an unconfigured agent fails cleanly later, in
            // `spawn_worker`, through the normal delivery path.
            let agent = arguments
                .get("agent")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .unwrap_or("codex")
                .to_string();
            // The headless Claude launch bypasses permissions. Dropping readOnly silently would
            // hand a worker meant to only read the right to write.
            if agent == "claude" && read_only {
                return Err("readOnly applies to Codex workers only".into());
            }
            // A read-only worker gives up on a write instead of asking, so it would never ask.
            if read_only && ask {
                return Err("readOnly and askForApproval cannot be combined".into());
            }
            // Both providers past the critical share: the routing settings decide. "block" refuses
            // the batch; "run-cheapest" runs it with a note; "ask" (or anything else) falls back
            // to the headroom hint on the response — a delegate call is one request/response and
            // the existing approval channel answers a running worker's questions, not a routing
            // decision, so there is nobody to pause for here. A provider Alethe has no reading for
            // is not critical.
            if matches!(agent.as_str(), "claude" | "codex") {
                let routing = guard(&core.inner).routing.clone();
                let other = if agent == "claude" { "codex" } else { "claude" };
                let fitness = guard(&core.fitness);
                let past = |name: &str| {
                    fitness
                        .get(name)
                        .is_some_and(|snapshot| past_threshold(snapshot, routing.critical_threshold))
                };
                if past(&agent) && past(other) {
                    let used = |name: &str| {
                        fitness
                            .get(name)
                            .and_then(|snapshot| snapshot.get("used"))
                            .and_then(Value::as_f64)
                            .unwrap_or(0.0)
                    };
                    match routing.on_both_critical.as_str() {
                        "block" => {
                            return Err(format!(
                                "both providers are past {:.0}% of quota ({} at {:.0}%, {} at {:.0}%); the routing settings say to block — wait for a window to reset or change onBothCritical",
                                routing.critical_threshold,
                                agent,
                                used(&agent),
                                other,
                                used(other),
                            ));
                        }
                        "run-cheapest" => {
                            routing_at_start = Some(match routing_at_start.take() {
                                Some(mut note) => {
                                    if let Some(object) = note.as_object_mut() {
                                        object.insert("bothCritical".into(), json!(true));
                                    }
                                    note
                                }
                                None => json!({
                                    "verdict": "both-critical",
                                    "policy": "run-cheapest",
                                    "agent": agent,
                                    "used": used(&agent).round(),
                                }),
                            });
                        }
                        _ => {}
                    }
                }
            }
            // The named policies decide for themselves what is worth asking about. The granular
            // form is the one that says plainly which callbacks this client will answer, which is
            // what makes a worker route the question here instead of giving up on it.
            let (approval_policy, sandbox) = if ask {
                (
                    json!({
                        "granular": {
                            "sandbox_approval": true,
                            "request_permissions": true,
                            "rules": true,
                            "skill_approval": true,
                            "mcp_elicitations": true
                        }
                    }),
                    // Not read-only: a worker treats that as final and gives up instead of asking.
                    // Kept writable, it works normally and only stops when it needs to reach
                    // outside its own workspace - which is the moment worth a question.
                    "workspace-write".to_string(),
                )
            } else if read_only {
                (Value::String("never".into()), SANDBOX_READ_ONLY.to_string())
            } else {
                (Value::String("never".into()), "workspace-write".to_string())
            };
            let approval_policy = approval_policy.to_string();
            let timeout_ms = match arguments.get("timeoutSeconds").and_then(Value::as_u64) {
                Some(0) => None,
                Some(seconds) => Some(seconds.saturating_mul(1000)),
                None => guard(&core.inner).default_timeout_ms,
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
                    // The same planner sending the same task again replaces the worker that ended
                    // without finishing it. A finished worker stays: its result is still the answer.
                    for earlier in inner.jobs.values_mut() {
                        if earlier.superseded_by.is_none()
                            && earlier.planner_id == planner_id
                            && earlier.spec == spec
                            && matches!(
                                earlier.status.as_str(),
                                STATUS_INTERRUPTED | STATUS_CANCELLED | STATUS_FAILED
                            )
                        {
                            earlier.superseded_by = Some(id.clone());
                        }
                    }
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
                            cost_usd: None,
                            quota: None,
                            outcome: None,
                            started_at: None,
                            ended_at: None,
                            worktree: worktree.clone(),
                            timeout_ms,
                            approval_policy: approval_policy.clone(),
                            sandbox: sandbox.clone(),
                            web_search,
                            role: role.clone(),
                            model: model.clone(),
                            effort: effort.clone(),
                            pending: None,
                            child: None,
                            stdin: None,
                            inbox: VecDeque::new(),
                            routing: routing_at_start.clone(),
                            awaiting_steer: false,
                            next_request_id: 10,
                            superseded_by: None,
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
            let wait = arguments
                .get("wait")
                .and_then(Value::as_bool)
                .unwrap_or(false);
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

        "alethe_status" => Ok(planner_status(
            core.snapshot(),
            planner,
            arguments
                .get("all")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        )),

        "alethe_steer" => {
            let job_id = required_str(arguments, "jobId")?;
            let message = required_str(arguments, "message")?;
            let mut inner = guard(&core.inner);
            let (agent, thread_id, turn_id) = {
                let job = inner
                    .jobs
                    .get(&job_id)
                    .ok_or_else(|| format!("unknown job {job_id}"))?;
                let thread_id = job
                    .thread_id
                    .clone()
                    .ok_or_else(|| format!("job {job_id} has no thread yet"))?;
                (job.agent.clone(), thread_id, job.active_turn_id.clone())
            };
            if agent == "claude" {
                let job = inner
                    .jobs
                    .get_mut(&job_id)
                    .ok_or_else(|| format!("unknown job {job_id}"))?;
                // Claude has no mid-turn steer: the only control message that reaches a running
                // turn is `interrupt`. Queueing the correction first and aborting second gets the
                // same result, because `finish_turn` hands the inbox straight back to the worker.
                let live = job.status == STATUS_RUNNING;
                let stdin = job.stdin.clone();
                match (live, stdin) {
                    (true, Some(stdin)) => {
                        job.inbox.push_front(message);
                        job.awaiting_steer = true;
                        job.next_request_id += 1;
                        let request_id = format!("{job_id}-interrupt-{}", job.next_request_id);
                        core.notify(&inner);
                        drop(inner);
                        let request = json!({
                            "type": "control_request",
                            "request_id": request_id,
                            "request": { "subtype": "interrupt" }
                        });
                        send_rpc(&stdin, &request)?;
                        return Ok(json!({ "steered": job_id }));
                    }
                    _ => {
                        job.inbox.push_back(message);
                        let queued = job.inbox.len();
                        core.notify(&inner);
                        return Ok(json!({
                            "queued": job_id,
                            "waiting": queued,
                            "note": "worker is not running a turn; the steer starts as its next one"
                        }));
                    }
                }
            }
            let turn_id =
                turn_id.ok_or_else(|| format!("job {job_id} has no running turn to steer"))?;
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
                    job.superseded_by = None;
                    inner.queue.push_back(job_id.clone());
                    core.notify(&inner);
                    true
                };
                core.persist();
                core.drain_queue();
                return Ok(
                    json!({ "revived": job_id, "resumedThread": thread_id, "queued": queued }),
                );
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
            // Claude's process is already sitting there, multi-turn — the next line written on its
            // stdin just is the next turn, no `turn/start` RPC to build like Codex needs.
            let is_claude = job.agent == "claude";
            let (stdin, request) = if is_claude {
                let stdin = job
                    .stdin
                    .clone()
                    .ok_or_else(|| format!("job {job_id} has no live worker"))?;
                (
                    stdin,
                    json!({
                        "type": "user",
                        "message": { "role": "user", "content": [{ "type": "text", "text": message }] }
                    }),
                )
            } else {
                stage_rpc(
                    &mut inner,
                    &job_id,
                    "turn/start",
                    json!({
                        "threadId": thread_id,
                        "input": [{ "type": "text", "text": message }],
                        "approvalPolicy": "never"
                    }),
                )?
            };
            if let Some(job) = inner.jobs.get_mut(&job_id) {
                job.status = STATUS_RUNNING.to_string();
                job.superseded_by = None;
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
            core.persist();
            Ok(json!({ "sent": job_id }))
        }

        "alethe_answer" => {
            let job_id = required_str(arguments, "jobId")?;
            let decision = required_str(arguments, "decision")?;
            core.answer(&job_id, &decision)
        }

        "alethe_cancel" => {
            let ids = string_list(arguments, "jobIds");
            let mut cancelled = Vec::new();
            for job_id in ids {
                let claude = {
                    let inner = guard(&core.inner);
                    inner.jobs.get(&job_id).map(|job| job.agent == "claude")
                };
                if claude == Some(true) {
                    // `cancel_queued` clears the CLI's own queue in the same round trip, so nothing
                    // it was holding starts a turn between the abort and the teardown below.
                    let staged = {
                        let mut inner = guard(&core.inner);
                        inner.jobs.get_mut(&job_id).and_then(|job| {
                            job.awaiting_steer = false;
                            job.next_request_id += 1;
                            let request_id = format!("{job_id}-interrupt-{}", job.next_request_id);
                            job.stdin.clone().map(|stdin| {
                                (
                                    stdin,
                                    json!({
                                        "type": "control_request",
                                        "request_id": request_id,
                                        "request": { "subtype": "interrupt", "cancel_queued": true }
                                    }),
                                )
                            })
                        })
                    };
                    if let Some((stdin, request)) = staged {
                        let _ = send_rpc(&stdin, &request);
                    }
                    core.finish(
                        &job_id,
                        STATUS_CANCELLED,
                        Some("cancelled".into()),
                        "cancelled by the lead".into(),
                        true,
                    );
                    cancelled.push(job_id);
                    continue;
                }
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
            let name = params
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default();
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

#[cfg(test)]
mod tests {
    use super::*;

    fn finished_job(worktree: Option<&str>, approval_policy: &str, timeout_ms: Option<u64>) -> Job {
        Job {
            id: "job-07".into(),
            planner_id: Some("planner-a".into()),
            agent: "claude".into(),
            run_id: "run-03".into(),
            run_label: Some("fix the parser".into()),
            spec: "Make the parser accept trailing commas.".into(),
            cwd: worktree.unwrap_or("C:/repo/app").into(),
            status: STATUS_FAILED.into(),
            thread_id: Some("thread-1".into()),
            active_turn_id: None,
            reply: String::new(),
            report: String::new(),
            plan: Vec::new(),
            diff: None,
            tokens: None,
            cost_usd: None,
            quota: None,
            outcome: Some("failed".into()),
            started_at: Some(1),
            ended_at: Some(2),
            worktree: worktree.map(Into::into),
            timeout_ms,
            approval_policy: approval_policy.into(),
            sandbox: "workspace-write".into(),
            web_search: true,
            pending: None,
            child: None,
            stdin: None,
            inbox: VecDeque::new(),
            routing: None,
            awaiting_steer: false,
            next_request_id: 10,
            superseded_by: None,
            role: None,
            model: None,
            effort: None,
        }
    }

    // The board's Restart runs the same request again as a new worker (#242).
    #[test]
    fn restart_repeats_the_original_request() {
        let arguments = restart_arguments(&finished_job(None, "\"never\"", Some(900_000)));

        assert_eq!(
            arguments["tasks"],
            json!(["Make the parser accept trailing commas."])
        );
        assert_eq!(arguments["agent"], json!("claude"));
        assert_eq!(arguments["cwd"], json!("C:/repo/app"));
        assert_eq!(arguments["label"], json!("fix the parser"));
        assert_eq!(arguments["isolate"], json!(false));
        assert_eq!(arguments["askForApproval"], json!(false));
        assert_eq!(arguments["webSearch"], json!(true));
        assert_eq!(arguments["timeoutSeconds"], json!(900));
    }

    #[test]
    fn restart_of_an_isolated_worker_gets_a_fresh_worktree_of_the_same_repository() {
        let worktree = PathBuf::from("C:/repo")
            .join(".alethe")
            .join("worktrees")
            .join("job-07");
        let arguments = restart_arguments(&finished_job(
            Some(&worktree.to_string_lossy()),
            "{\"granular\":{\"sandbox_approval\":true}}",
            None,
        ));

        assert_eq!(
            arguments["cwd"],
            json!(PathBuf::from("C:/repo").to_string_lossy())
        );
        assert_eq!(arguments["isolate"], json!(true));
        assert_eq!(arguments["askForApproval"], json!(true));
        assert_eq!(arguments["timeoutSeconds"], json!(0));
    }

    // A worker restarts on the model, effort and sandbox it was delegated with, or on its role.
    #[test]
    fn restart_keeps_the_model_effort_read_only_or_role_of_the_worker() {
        let delegated = Job {
            agent: "codex".into(),
            model: Some("gpt-6-astra".into()),
            effort: Some("high".into()),
            sandbox: SANDBOX_READ_ONLY.into(),
            ..finished_job(None, "\"never\"", Some(900_000))
        };
        let arguments = restart_arguments(&delegated);
        assert_eq!(arguments["agent"], json!("codex"));
        assert_eq!(arguments["model"], json!("gpt-6-astra"));
        assert_eq!(arguments["effort"], json!("high"));
        assert_eq!(arguments["readOnly"], json!(true));

        let reviewer = Job {
            role: Some("reviewer".into()),
            ..delegated
        };
        let arguments = restart_arguments(&reviewer);
        assert_eq!(arguments["role"], json!("reviewer"));
        for field in ROLE_FIELDS {
            assert!(
                !arguments.contains_key(field),
                "{field} is the role's to set"
            );
        }
    }

    // A restored worker restarts with the budget it was given, not the default one (#242).
    #[test]
    fn a_saved_worker_keeps_its_timeout() {
        for timeout_ms in [None, Some(1_800_000)] {
            let saved = finished_job(None, "\"never\"", timeout_ms).record();
            let restored = Job::from_record(&saved).expect("restore");
            assert_eq!(restored.timeout_ms, timeout_ms);
        }

        let mut legacy = finished_job(None, "\"never\"", None).record();
        legacy.as_object_mut().unwrap().remove("timeoutMs");
        let restored = Job::from_record(&legacy).expect("restore");
        assert_eq!(restored.timeout_ms, Some(DEFAULT_JOB_TIMEOUT_MS));
    }

    /// One slot, taken by a running worker, and a second worker waiting for it. The directory does
    /// not exist and no launcher is registered, so nothing can really start if the queue drains.
    fn core_with_a_queued_worker() -> Core {
        let core = Core::default();
        {
            let mut inner = guard(&core.inner);
            inner.max_concurrent = 1;
            for (id, status) in [("job-01", STATUS_RUNNING), ("job-02", STATUS_QUEUED)] {
                let job = Job {
                    id: id.into(),
                    status: status.into(),
                    cwd: "Z:/alethe-test/missing".into(),
                    worktree: None,
                    ended_at: None,
                    ..finished_job(None, "\"never\"", Some(900_000))
                };
                inner.jobs.insert(id.into(), job);
                inner.order.push(id.into());
            }
            inner.queue.push_back("job-02".into());
            inner.running = 1;
        }
        core
    }

    // Stopping a worker that never got a slot must not free one, nor leave it in the queue (#242).
    #[test]
    fn stopping_a_queued_worker_does_not_start_it() {
        let core = core_with_a_queued_worker();
        let mut arguments = Map::new();
        arguments.insert("jobIds".into(), json!(["job-02"]));

        call_tool(&core, "alethe_cancel", &arguments, None).expect("cancel");

        let inner = guard(&core.inner);
        assert_eq!(inner.jobs["job-02"].status, STATUS_CANCELLED);
        assert_eq!(inner.running, 1);
        assert!(inner.queue.is_empty());
    }

    #[test]
    fn restarting_a_queued_worker_leaves_one_worker_waiting() {
        let core = core_with_a_queued_worker();

        restart_job(&core, "job-02").expect("restart");

        let inner = guard(&core.inner);
        assert_eq!(inner.jobs["job-02"].status, STATUS_CANCELLED);
        assert_eq!(inner.running, 1);
        let waiting: Vec<&String> = inner.queue.iter().collect();
        assert_eq!(waiting.len(), 1);
        assert_ne!(waiting[0], "job-02");
        assert_eq!(inner.jobs[waiting[0].as_str()].status, STATUS_QUEUED);
    }

    use super::{
        claude_worker_args, codex_models, disable_plugins, guard, thread_resume_params,
        thread_start_params, Core, OrchestrationSettings,
    };
    use serde_json::json;

    // The model, effort and sandbox a worker was delegated with reach its Codex thread (#252).
    #[test]
    fn a_codex_thread_starts_on_the_delegated_model_effort_and_sandbox() {
        let params = thread_start_params(
            "/repo",
            "\"never\"",
            "read-only",
            false,
            Some("gpt-6-astra"),
            Some("high"),
        );
        assert_eq!(params["model"], "gpt-6-astra");
        assert_eq!(params["config"]["model_reasoning_effort"], "high");
        assert_eq!(params["sandbox"], "read-only");
        assert_eq!(params["approvalPolicy"], "never");
        assert_eq!(params["config"]["tools"]["web_search"]["mode"], "disabled");
    }

    #[test]
    fn a_codex_thread_without_options_keeps_the_cli_defaults() {
        let params = thread_start_params("/repo", "\"never\"", "workspace-write", true, None, None);
        assert!(params.get("model").is_none(), "{params}");
        assert!(
            params["config"].get("model_reasoning_effort").is_none(),
            "{params}"
        );
        assert_eq!(params["sandbox"], "workspace-write");
        assert_eq!(params["config"]["tools"]["web_search"]["mode"], "live");
    }

    // Plugins listed in the Orchestration settings are off in a worker's thread (#266).
    #[test]
    fn a_codex_worker_thread_starts_without_the_listed_plugins() {
        let mut params = thread_start_params("/repo", "\"never\"", "read-only", false, None, None);
        disable_plugins(&mut params, &["ecc@ecc".into(), "ponytail@ponytail".into()]);
        assert_eq!(params["config"]["plugins"]["ecc@ecc"]["enabled"], false);
        assert_eq!(
            params["config"]["plugins"]["ponytail@ponytail"]["enabled"],
            false
        );
        assert_eq!(params["config"]["tools"]["web_search"]["mode"], "disabled");

        let mut untouched =
            thread_start_params("/repo", "\"never\"", "read-only", false, None, None);
        disable_plugins(&mut untouched, &[]);
        assert!(untouched["config"].get("plugins").is_none(), "{untouched}");
    }

    #[test]
    fn the_settings_carry_the_plugins_workers_start_without() {
        let core = Core::default();
        let settings: OrchestrationSettings = serde_json::from_value(json!({
            "maxConcurrent": 4,
            "defaultTimeoutSeconds": 900,
            "workerDisabledPlugins": ["ecc@ecc"]
        }))
        .expect("settings");
        core.apply_settings(settings);
        assert_eq!(
            guard(&core.inner).worker_disabled_plugins,
            vec!["ecc@ecc".to_string()]
        );

        // Settings saved before the list existed still parse.
        let older: OrchestrationSettings =
            serde_json::from_value(json!({ "maxConcurrent": 4, "defaultTimeoutSeconds": 900 }))
                .expect("older settings");
        assert!(older.worker_disabled_plugins.is_empty());
    }

    // A worker picked up again after its process died must not lose its read-only sandbox.
    #[test]
    fn a_resumed_codex_thread_keeps_its_model_effort_and_sandbox() {
        let params = thread_resume_params(
            "thread-1",
            "/repo",
            "\"never\"",
            "read-only",
            false,
            Some("gpt-6-astra"),
            Some("high"),
        );
        assert_eq!(params["threadId"], "thread-1");
        assert_eq!(params["model"], "gpt-6-astra");
        assert_eq!(params["config"]["model_reasoning_effort"], "high");
        assert_eq!(params["sandbox"], "read-only");
    }

    // Preferences list the models Codex reports, with the efforts each one accepts (#254).
    #[test]
    fn the_codex_model_list_keeps_visible_models_and_their_efforts() {
        let result = json!({
            "data": [
                {
                    "id": "gpt-6.1-sol",
                    "model": "gpt-6.1-sol",
                    "displayName": "GPT-6.1 Sol",
                    "defaultReasoningEffort": "low",
                    "supportedReasoningEfforts": [
                        { "reasoningEffort": "low", "description": "fast" },
                        { "reasoningEffort": "high", "description": "deep" }
                    ],
                    "hidden": false
                },
                {
                    "id": "internal",
                    "model": "internal",
                    "displayName": "Internal",
                    "defaultReasoningEffort": "medium",
                    "supportedReasoningEfforts": [],
                    "hidden": true
                }
            ],
            "nextCursor": null
        });
        assert_eq!(
            codex_models(&result),
            json!([{
                "model": "gpt-6.1-sol",
                "name": "GPT-6.1 Sol",
                "defaultEffort": "low",
                "efforts": ["low", "high"]
            }])
        );
    }

    #[test]
    fn a_claude_worker_is_launched_on_the_delegated_model() {
        assert_eq!(
            claude_worker_args(Some("session-1"), Some("claude-sonnet-5-5"), Some("high")),
            [
                "--resume",
                "session-1",
                "--model",
                "claude-sonnet-5-5",
                "--effort",
                "high"
            ]
        );
        assert!(claude_worker_args(None, None, None).is_empty());
    }

    fn routing_core(settings: Value) -> Core {
        let core = Core::default();
        let parsed: OrchestrationSettings = serde_json::from_value(settings).expect("settings");
        core.apply_settings(parsed);
        core
    }

    fn routed(core: &Core, arguments: Value) -> Option<(Map<String, Value>, Value)> {
        resolve_routing_rule(core, arguments.as_object().expect("arguments"), None)
            .expect("routing")
    }

    #[test]
    fn the_first_matching_rule_picks_the_role() {
        let core = routing_core(json!({
            "maxConcurrent": 4,
            "defaultTimeoutSeconds": 900,
            "roles": [
                { "name": "builder", "agent": "codex" },
                { "name": "scout", "agent": "claude", "model": "haiku" }
            ],
            "routing": { "rules": [
                { "id": "r1", "enabled": true, "kinds": ["research"], "efforts": [], "gates": [], "role": "builder" },
                { "id": "r2", "enabled": true, "kinds": ["research"], "efforts": [], "gates": [], "role": "scout" },
                { "id": "r3", "enabled": false, "kinds": ["research"], "efforts": [], "gates": [], "role": "scout" }
            ]}
        }));
        let (arguments, note) =
            routed(&core, json!({ "tasks": ["x"], "kind": "research" })).expect("a match");
        assert_eq!(arguments["role"], json!("builder"), "the first match wins");
        assert_eq!(note, json!({ "verdict": "rule", "rule": "r1", "role": "builder" }));

        // A kind no rule lists still reaches the rules open to any kind — none here.
        assert!(routed(&core, json!({ "tasks": ["x"], "kind": "code" })).is_none());
    }

    #[test]
    fn empty_kinds_and_efforts_match_anything_but_a_call_without_effort_skips_effort_rules() {
        let core = routing_core(json!({
            "maxConcurrent": 4,
            "defaultTimeoutSeconds": 900,
            "roles": [
                { "name": "deep", "agent": "codex" },
                { "name": "any", "agent": "codex" }
            ],
            "routing": { "rules": [
                { "id": "r-deep", "enabled": true, "kinds": [], "efforts": ["deep"], "gates": [], "role": "deep" },
                { "id": "r-any", "enabled": true, "kinds": [], "efforts": [], "gates": [], "role": "any" }
            ]}
        }));
        // No effortClass: the deep rule cannot match, the any-effort one does.
        let (arguments, _) =
            routed(&core, json!({ "tasks": ["x"], "kind": "code" })).expect("a match");
        assert_eq!(arguments["role"], json!("any"));
        // effortClass deep: the deep rule wins; the snake_case alias reads the same.
        for key in ["effortClass", "effort_class"] {
            let mut call = Map::new();
            call.insert("tasks".into(), json!(["x"]));
            call.insert("kind".into(), json!("code"));
            call.insert(key.into(), json!("deep"));
            let (arguments, _) = resolve_routing_rule(&core, &call, None)
                .expect("routing")
                .expect("a match");
            assert_eq!(arguments["role"], json!("deep"), "{key}");
        }
        // A standard effort skips the deep rule and lands on the open one.
        let (arguments, _) =
            routed(&core, json!({ "tasks": ["x"], "kind": "code", "effortClass": "standard" }))
                .expect("a match");
        assert_eq!(arguments["role"], json!("any"));
    }

    #[test]
    fn a_rule_for_an_unknown_role_is_skipped() {
        let core = routing_core(json!({
            "maxConcurrent": 4,
            "defaultTimeoutSeconds": 900,
            "roles": [{ "name": "any", "agent": "codex" }],
            "routing": { "rules": [
                { "id": "r-ghost", "enabled": true, "kinds": [], "efforts": [], "gates": [], "role": "ghost" },
                { "id": "r-any", "enabled": true, "kinds": [], "efforts": [], "gates": [], "role": "any" }
            ]}
        }));
        let (_, note) = routed(&core, json!({ "tasks": ["x"], "kind": "code" })).expect("a match");
        assert_eq!(note["rule"], json!("r-any"));
    }

    #[test]
    fn gates_read_the_cached_windows_and_unknown_readings_pass() {
        let core = routing_core(json!({
            "maxConcurrent": 4,
            "defaultTimeoutSeconds": 900,
            "roles": [
                { "name": "expert", "agent": "claude", "model": "opus" },
                { "name": "any", "agent": "codex" }
            ],
            "routing": { "rules": [
                { "id": "r-gated", "enabled": true, "kinds": [], "efforts": [], "gates": [{ "agent": "claude", "window": "opus", "below": 50 }], "role": "expert" },
                { "id": "r-any", "enabled": true, "kinds": [], "efforts": [], "gates": [], "role": "any" }
            ]}
        }));
        let call = json!({ "tasks": ["x"], "kind": "code", "effortClass": "deep" });

        // No fitness pushed yet: the gate passes on an unknown reading.
        let (arguments, _) = routed(&core, call.clone()).expect("a match");
        assert_eq!(arguments["role"], json!("expert"));

        // Opus at 40% passes a below-50 gate; the other windows do not matter.
        core.set_agent_fitness(
            "claude",
            json!({ "worst": "week", "used": 70, "rateLimited": false,
                    "windows": { "5h": 10, "week": 70, "opus": 40 } }),
        );
        let (arguments, _) = routed(&core, call.clone()).expect("a match");
        assert_eq!(arguments["role"], json!("expert"), "opus is at 40%");

        // Opus at 60% fails the gate even though the worst window is another one.
        core.set_agent_fitness(
            "claude",
            json!({ "worst": "week", "used": 70, "rateLimited": false,
                    "windows": { "5h": 10, "week": 70, "opus": 60 } }),
        );
        let (arguments, _) = routed(&core, call.clone()).expect("a match");
        assert_eq!(arguments["role"], json!("any"), "the gate held the expert rule back");

        // An older snapshot without the per-window table reads its worst window when named.
        core.set_agent_fitness("claude", json!({ "worst": "opus", "used": 90, "rateLimited": false }));
        let (arguments, _) = routed(&core, call.clone()).expect("a match");
        assert_eq!(arguments["role"], json!("any"), "worst = opus at 90%");
        core.set_agent_fitness("claude", json!({ "worst": "week", "used": 90, "rateLimited": false }));
        let (arguments, _) = routed(&core, call.clone()).expect("a match");
        assert_eq!(arguments["role"], json!("expert"), "opus is unknown here, so it passes");
    }

    #[test]
    fn an_explicit_role_or_model_wins_over_the_rules() {
        let core = routing_core(json!({
            "maxConcurrent": 4,
            "defaultTimeoutSeconds": 900,
            "roles": [{ "name": "any", "agent": "codex" }],
            "routing": { "rules": [
                { "id": "r-any", "enabled": true, "kinds": [], "efforts": [], "gates": [], "role": "any" }
            ]}
        }));
        for call in [
            json!({ "tasks": ["x"], "kind": "code", "role": "any" }),
            json!({ "tasks": ["x"], "kind": "code", "model": "gpt-6-astra" }),
        ] {
            assert!(routed(&core, call).is_none(), "an explicit choice skips the rules");
        }
        // No kind, no rules: nothing to match on.
        assert!(routed(&core, json!({ "tasks": ["x"] })).is_none());
        assert!(routed(&Core::default(), json!({ "tasks": ["x"], "kind": "code" })).is_none());
    }

    #[test]
    fn an_unknown_kind_or_effort_class_is_refused() {
        let core = Core::default();
        for (key, value) in [("kind", "wander"), ("effortClass", "endless")] {
            let mut arguments = Map::new();
            arguments.insert("tasks".into(), json!(["x"]));
            arguments.insert(key.into(), json!(value));
            let error = resolve_routing_rule(&core, &arguments, None).expect_err("refused");
            assert!(error.contains(key), "{error}");
        }
    }

    #[test]
    fn allow_opus_off_keeps_rules_away_from_opus_roles() {
        let settings = |allow: bool| {
            json!({
                "maxConcurrent": 4,
                "defaultTimeoutSeconds": 900,
                "roles": [
                    { "name": "expert", "agent": "claude", "model": "claude-opus-4" },
                    { "name": "any", "agent": "codex" }
                ],
                "routing": {
                    "allowOpusOnDeep": allow,
                    "rules": [
                        { "id": "r-expert", "enabled": true, "kinds": [], "efforts": [], "gates": [], "role": "expert" },
                        { "id": "r-any", "enabled": true, "kinds": [], "efforts": [], "gates": [], "role": "any" }
                    ]
                }
            })
        };
        let call = json!({ "tasks": ["x"], "kind": "code" });
        let (arguments, _) = routed(&routing_core(settings(true)), call.clone()).expect("a match");
        assert_eq!(arguments["role"], json!("expert"));
        let (arguments, _) = routed(&routing_core(settings(false)), call.clone()).expect("a match");
        assert_eq!(arguments["role"], json!("any"), "opus is off the rules' table");
    }

    #[test]
    fn the_critical_threshold_moves_with_the_routing_settings() {
        let settings = |threshold: f64| {
            json!({
                "maxConcurrent": 4,
                "defaultTimeoutSeconds": 900,
                "roles": [
                    { "name": "writer", "agent": "claude", "fallback": "typist" },
                    { "name": "typist", "agent": "codex" }
                ],
                "routing": { "criticalThreshold": threshold }
            })
        };
        let fitness = |core: &Core| {
            core.set_agent_fitness(
                "claude",
                json!({ "worst": "week", "used": 60, "rateLimited": false }),
            );
            core.set_agent_fitness(
                "codex",
                json!({ "worst": "week", "used": 10, "rateLimited": false }),
            );
        };
        let mut call = Map::new();
        call.insert("role".into(), json!("writer"));

        let core = routing_core(settings(80.0));
        fitness(&core);
        let (_, note) = resolve_role(&core, &call, None)
            .expect("role")
            .expect("resolved");
        assert!(note.is_none(), "60% is not critical at 80: {note:?}");

        let core = routing_core(settings(50.0));
        fitness(&core);
        let (resolved, note) = resolve_role(&core, &call, None)
            .expect("role")
            .expect("resolved");
        assert_eq!(resolved["agent"], json!("codex"), "60% is critical at 50");
        assert_eq!(
            note.expect("a fallback note")["verdict"],
            json!("fallback")
        );
    }

    #[test]
    fn both_providers_critical_blocks_or_runs_with_a_note_as_configured() {
        let exhausted = |core: &Core| {
            core.set_agent_fitness(
                "claude",
                json!({ "worst": "week", "used": 95, "rateLimited": false }),
            );
            core.set_agent_fitness(
                "codex",
                json!({ "worst": "week", "used": 88, "rateLimited": false }),
            );
        };
        let delegate = |core: &Core| {
            let mut arguments = Map::new();
            arguments.insert("tasks".into(), json!(["something"]));
            arguments.insert("cwd".into(), json!("Z:/alethe-test/missing"));
            call_tool(core, "alethe_delegate", &arguments, None)
        };
        // Asking for the more strained side makes the headroom hint name the other one.
        let delegate_claude = |core: &Core| {
            let mut arguments = Map::new();
            arguments.insert("tasks".into(), json!(["something"]));
            arguments.insert("cwd".into(), json!("Z:/alethe-test/missing"));
            arguments.insert("agent".into(), json!("claude"));
            call_tool(core, "alethe_delegate", &arguments, None)
        };

        let blocking = routing_core(json!({
            "maxConcurrent": 4, "defaultTimeoutSeconds": 900,
            "routing": { "onBothCritical": "block" }
        }));
        exhausted(&blocking);
        let error = delegate(&blocking).expect_err("blocked");
        assert!(error.contains("both providers"), "{error}");

        let cheapest = routing_core(json!({
            "maxConcurrent": 4, "defaultTimeoutSeconds": 900,
            "routing": { "onBothCritical": "run-cheapest" }
        }));
        exhausted(&cheapest);
        let result = delegate(&cheapest).expect("runs anyway");
        let id = result["jobs"][0]["id"].as_str().expect("a job id");
        let inner = guard(&cheapest.inner);
        let note = inner.jobs[id].routing.as_ref().expect("a routing note");
        assert_eq!(note["verdict"], json!("both-critical"));
        assert_eq!(note["policy"], json!("run-cheapest"));

        // The default ("ask") runs too; the planner hears it through the headroom hint.
        let asking = routing_core(json!({ "maxConcurrent": 4, "defaultTimeoutSeconds": 900 }));
        exhausted(&asking);
        let result = delegate_claude(&asking).expect("runs, with a hint");
        assert_eq!(result["headroomHint"]["bothStrained"], json!(true));

        // One provider unknown is not "both critical": block does not fire.
        let half_known = routing_core(json!({
            "maxConcurrent": 4, "defaultTimeoutSeconds": 900,
            "routing": { "onBothCritical": "block" }
        }));
        half_known.set_agent_fitness(
            "codex",
            json!({ "worst": "week", "used": 88, "rateLimited": false }),
        );
        delegate(&half_known).expect("claude unknown is not critical");
    }

    #[test]
    fn a_rule_routed_worker_carries_the_rule_note() {
        let core = routing_core(json!({
            "maxConcurrent": 4,
            "defaultTimeoutSeconds": 900,
            "roles": [{ "name": "scout", "agent": "claude", "model": "haiku" }],
            "routing": { "rules": [
                { "id": "r1", "enabled": true, "kinds": ["research"], "efforts": [], "gates": [], "role": "scout" }
            ]}
        }));
        let mut arguments = Map::new();
        arguments.insert("tasks".into(), json!(["map the flags"]));
        arguments.insert("cwd".into(), json!("Z:/alethe-test/missing"));
        arguments.insert("kind".into(), json!("research"));
        let result = call_tool(&core, "alethe_delegate", &arguments, None).expect("delegated");
        let id = result["jobs"][0]["id"].as_str().expect("a job id");
        let inner = guard(&core.inner);
        let job = &inner.jobs[id];
        assert_eq!(job.role.as_deref(), Some("scout"));
        assert_eq!(job.agent, "claude", "the role set the agent");
        assert_eq!(
            job.routing.as_ref().expect("a routing note"),
            &json!({ "verdict": "rule", "rule": "r1", "role": "scout" })
        );
    }

    #[test]
    fn settings_without_routing_get_the_defaults() {
        let settings: OrchestrationSettings =
            serde_json::from_value(json!({ "maxConcurrent": 4, "defaultTimeoutSeconds": 900 }))
                .expect("older settings");
        assert_eq!(settings.routing.preset, "balanced");
        assert!(settings.routing.rules.is_empty());
        assert_eq!(settings.routing.critical_threshold, DEFAULT_CRITICAL_THRESHOLD);
        assert!(settings.routing.allow_opus_on_deep);
        assert_eq!(settings.routing.on_both_critical, "ask");
    }
}
