//! Delegation core: queue, workers and the MCP tool surface.
//!
//! Deliberately free of Tauri and of anything else in this crate. The app layer supplies a
//! launcher and an optional observer; everything else here is plain `std` + `serde_json`, which
//! is what lets `tests/orchestrator.rs` compile this file directly instead of linking the GUI
//! stack a Rust test binary cannot load.

use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Read, Write};
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

    /// The permission mode is not part of the launcher: it depends on whether the delegation asks
    /// for approvals, so `spawn_worker` appends it per job (see `claude_permission_args`).
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
            ],
            env: Vec::new(),
        }
    }
}

/// A Claude worker left unattended bypasses permissions: nobody would be there to answer. One that
/// asks edits files in its directory on its own and sends everything else (commands, reads and
/// writes elsewhere, the network) to the host over stdio as `can_use_tool`, which is this core.
fn claude_permission_args(asks: bool) -> Vec<String> {
    let args: &[&str] = if asks {
        &[
            "--permission-mode",
            "acceptEdits",
            "--permission-prompt-tool",
            "stdio",
        ]
    } else {
        &["--permission-mode", "bypassPermissions"]
    };
    args.iter().map(|arg| (*arg).to_string()).collect()
}

/// What the person allows workers to do, set in Preferences and pushed in by the app layer. A
/// delegation decides within these rules; where a rule is fixed, the planner's choice is overridden.
#[derive(Clone, Debug, PartialEq)]
pub struct WorkerPolicy {
    /// The CLI for a delegation that names none: `codex`, `claude`, or `auto`, which takes the
    /// installed one with the most room left.
    pub default_agent: String,
    /// Each turn's budget when the planner sets none; None lets a turn run without one.
    pub timeout_ms: Option<u64>,
    /// `planner` leaves `askForApproval` to the delegation; `always` and `never` fix it.
    pub approvals: String,
    /// `planner` leaves `isolate` to the delegation; `always` gives every worker its own worktree.
    pub isolation: String,
    /// `planner` leaves `webSearch` to the delegation; `never` turns it off.
    pub web_search: String,
    /// How many finished workers stay alive for follow-ups before the oldest is let go.
    pub parked_limit: usize,
    /// Sandbox for Codex workers: `workspace-write`, or `danger-full-access` where the platform
    /// sandbox cannot run (some containers and kernels refuse it).
    pub codex_sandbox: String,
}

impl Default for WorkerPolicy {
    fn default() -> Self {
        Self {
            default_agent: "auto".into(),
            timeout_ms: Some(DEFAULT_JOB_TIMEOUT_MS),
            approvals: "planner".into(),
            isolation: "planner".into(),
            web_search: "planner".into(),
            parked_limit: PARKED_LIMIT,
            codex_sandbox: "workspace-write".into(),
        }
    }
}

impl WorkerPolicy {
    /// Anything unrecognised falls back to the default for that rule, so a value written by a newer
    /// version never turns into a looser rule here.
    pub fn sanitized(self) -> Self {
        let fallback = Self::default();
        let pick = |value: String, allowed: &[&str], default: String| {
            if allowed.contains(&value.as_str()) {
                value
            } else {
                default
            }
        };
        Self {
            default_agent: pick(
                self.default_agent,
                &["auto", "codex", "claude"],
                fallback.default_agent,
            ),
            timeout_ms: self
                .timeout_ms
                .map(|ms| ms.clamp(MIN_JOB_TIMEOUT_MS, MAX_JOB_TIMEOUT_MS)),
            approvals: pick(
                self.approvals,
                &["planner", "always", "never"],
                fallback.approvals,
            ),
            isolation: pick(self.isolation, &["planner", "always"], fallback.isolation),
            web_search: pick(self.web_search, &["planner", "never"], fallback.web_search),
            parked_limit: self.parked_limit.min(MAX_PARKED_LIMIT),
            codex_sandbox: pick(
                self.codex_sandbox,
                &["workspace-write", "danger-full-access"],
                fallback.codex_sandbox,
            ),
        }
    }
}

/// The model and effort the person chose for workers of one CLI. Either can be absent, which leaves
/// that CLI on its own configured default.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct WorkerDefaults {
    pub model: Option<String>,
    pub effort: Option<String>,
}

/// A model name becomes an argv token and, for Codex, a TOML value, so it is held to the characters
/// real model ids use (`provider/model`, `opus[1m]`, `gpt-5:latest`) and nothing that needs quoting.
fn is_safe_model_name(value: &str) -> bool {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    value.len() <= 120
        && first.is_ascii_alphanumeric()
        && chars.all(|c| c.is_ascii_alphanumeric() || "._:/[]-".contains(c))
}

fn effort_levels(agent: &str) -> &'static [&'static str] {
    match agent {
        "claude" => &["low", "medium", "high", "xhigh", "max"],
        // Codex takes whatever the chosen model advertises in `model/list`, and newer models go
        // past `high`. This is every level any of them advertises; one the model does not support
        // fails its turn with Codex's own error, which reaches the planner and the board.
        "codex" => &[
            "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra",
        ],
        _ => &[],
    }
}

impl WorkerDefaults {
    /// Drops whatever this CLI could not be started with, so a stale preference never reaches argv.
    pub fn sanitized(self, agent: &str) -> Self {
        Self {
            model: self
                .model
                .map(|model| model.trim().to_string())
                .filter(|model| is_safe_model_name(model)),
            effort: self
                .effort
                .filter(|effort| effort_levels(agent).contains(&effort.as_str())),
        }
    }

    /// This choice where it says something, `fallback` where it does not.
    fn over(self, fallback: WorkerDefaults) -> WorkerDefaults {
        WorkerDefaults {
            model: self.model.or(fallback.model),
            effort: self.effort.or(fallback.effort),
        }
    }

    /// What a planner asked for in `alethe_delegate`, refused with a reason it can act on rather
    /// than dropped: a silently ignored model would run the work somewhere the planner did not mean.
    fn requested(agent: &str, arguments: &Map<String, Value>) -> Result<Self, String> {
        let field = |key: &str| {
            arguments
                .get(key)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned)
        };
        let requested = WorkerDefaults {
            model: field("model"),
            effort: field("effort"),
        };
        let accepted = requested.clone().sanitized(agent);
        if requested.model.is_some() && accepted.model.is_none() {
            return Err(format!(
                "model {:?} is not a model id this CLI can be started with",
                requested.model.unwrap_or_default()
            ));
        }
        if requested.effort.is_some() && accepted.effort.is_none() {
            return Err(format!(
                "a {agent} worker accepts effort {}",
                effort_levels(agent).join(", ")
            ));
        }
        Ok(accepted)
    }

    /// Passed on the worker's command line rather than per thread, so a worker revived through
    /// `thread/resume` runs with the same settings as one started fresh.
    fn launch_args(&self, agent: &str) -> Vec<String> {
        let mut args = Vec::new();
        match agent {
            "claude" => {
                if let Some(model) = &self.model {
                    args.extend(["--model".to_string(), model.clone()]);
                }
                if let Some(effort) = &self.effort {
                    args.extend(["--effort".to_string(), effort.clone()]);
                }
            }
            "codex" => {
                if let Some(model) = &self.model {
                    args.extend(["-c".to_string(), format!("model=\"{model}\"")]);
                }
                if let Some(effort) = &self.effort {
                    args.extend([
                        "-c".to_string(),
                        format!("model_reasoning_effort=\"{effort}\""),
                    ]);
                }
            }
            _ => {}
        }
        args
    }
}

fn default_routing_policy() -> Value {
    json!({
        "watchPercent": 60,
        "protectPercent": 80,
        "criticalPercent": 95,
        "tiers": {
            "light": [
                { "agent": "claude", "model": "haiku", "effort": "low" },
                { "agent": "codex", "effort": "low" }
            ],
            "standard": [
                { "agent": "codex", "effort": "medium" },
                { "agent": "claude", "model": "sonnet", "effort": "medium" }
            ],
            "deep": [
                { "agent": "claude", "model": "opus", "effort": "high" },
                { "agent": "codex", "effort": "high" }
            ]
        }
    })
}

/// How many routes one tier can chain.
const MAX_TIER_ROUTES: usize = 4;

/// One route of a tier, or None for an entry that names no usable CLI. `base` is the route the
/// default policy has in the same place, which fills in what the entry leaves out.
fn sanitize_route(source: &Value, base: Option<&Value>) -> Option<Value> {
    if !source.is_object() {
        return None;
    }
    let base_agent = base.and_then(|base| base["agent"].as_str());
    let agent = source["agent"]
        .as_str()
        .filter(|agent| matches!(*agent, "claude" | "codex"))
        .or(base_agent)?;
    // A default's model belongs to the default's provider: a route moved to the other CLI must
    // not inherit it, or Codex would be started on a Claude model name and the reverse.
    let same_agent = base_agent == Some(agent);
    let mut result = Map::new();
    result.insert("agent".into(), Value::String(agent.to_string()));
    for key in ["model", "effort"] {
        let inherits = key == "effort" || same_agent;
        let selected = source[key]
            .as_str()
            .or_else(|| {
                base.and_then(|base| base[key].as_str())
                    .filter(|_| inherits)
            })
            .map(str::trim)
            .filter(|selected| !selected.is_empty());
        if let Some(selected) = selected {
            result.insert(key.into(), Value::String(selected.to_string()));
        }
    }
    Some(Value::Object(result))
}

fn sanitize_routing_policy(value: Value) -> Value {
    let fallback = default_routing_policy();
    let percent = |key: &str| {
        value
            .get(key)
            .and_then(Value::as_f64)
            .unwrap_or_else(|| fallback[key].as_f64().unwrap_or(0.0))
            .round()
            .clamp(0.0, 100.0)
    };
    let mut watch = percent("watchPercent");
    let mut protect = percent("protectPercent");
    let mut critical = percent("criticalPercent");
    protect = protect.max(watch + 1.0);
    critical = critical.max(protect + 1.0).min(100.0);
    protect = protect.min(critical - 1.0);
    watch = watch.min(protect - 1.0);

    // A tier is its routes in the order they are tried. A policy written before a tier could chain
    // more than two holds `{ primary, fallback }`, which reads as a list of two.
    let routes = |tier: &str| {
        let source = &value["tiers"][tier];
        let base = fallback["tiers"][tier]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let entries: Vec<Value> = match source.as_array() {
            Some(list) => list.clone(),
            None => vec![source["primary"].clone(), source["fallback"].clone()],
        };
        let routes: Vec<Value> = entries
            .iter()
            .enumerate()
            .filter_map(|(index, entry)| sanitize_route(entry, base.get(index).or(base.last())))
            .take(MAX_TIER_ROUTES)
            .collect();
        // A tier with no route could never place a task.
        Value::Array(if routes.is_empty() { base } else { routes })
    };

    json!({
        "watchPercent": watch,
        "protectPercent": protect,
        "criticalPercent": critical,
        "tiers": {
            "light": routes("light"),
            "standard": routes("standard"),
            "deep": routes("deep")
        }
    })
}

#[derive(Clone)]
struct DelegatedTask {
    spec: String,
    kind: String,
    complexity: String,
    structured: bool,
}

#[derive(Clone)]
struct RoutedTask {
    task: DelegatedTask,
    agent: String,
    launch: WorkerDefaults,
    routing: Value,
    /// The place in its tier of the route that took the task; None when no tier was involved.
    position: Option<usize>,
}

/// Which of a tier's routes takes a task, given how used each one's provider is, in route order.
/// The order is the person's preference, so it is followed for as long as a route has room: the
/// first one below the watch band, then the first below the protect band. With every route past
/// that, the one with the most room left takes the task, the earlier one on a tie. The frontend's
/// preview implements the same rule and both are checked against one fixture.
pub fn pick_route(pressures: &[f64], watch: f64, protect: f64) -> usize {
    pressures
        .iter()
        .position(|used| *used < watch)
        .or_else(|| pressures.iter().position(|used| *used < protect))
        .unwrap_or_else(|| {
            pressures.iter().enumerate().fold(
                0,
                |best, (index, used)| {
                    if *used < pressures[best] {
                        index
                    } else {
                        best
                    }
                },
            )
        })
}

/// Whether a failure says the provider's quota ran out, rather than that the work itself failed.
fn is_usage_limit(text: &str) -> bool {
    let text = text.to_ascii_lowercase();
    [
        "usagelimitexceeded",
        "usage limit",
        "rate limit",
        "rate_limit",
        "quota",
    ]
    .iter()
    .any(|needle| text.contains(needle))
}

/// Stops a worker and what it started, so the commands it launched (a test run, a build) go with
/// it instead of being left running.
///
/// On Unix the worker leads its own process group, which is signalled before the worker is reaped:
/// until then its id cannot have been given to anything else. On Windows `taskkill /T` walks the
/// tree from the worker down, so it has to run while the worker is still there; it can take a
/// moment and the caller holds the orchestrator lock, so it runs on a thread of its own. The open
/// handle to the worker keeps its id from being reused in the meantime.
fn stop_worker(child: Arc<Mutex<Child>>) {
    #[cfg(windows)]
    {
        thread::spawn(move || {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            let pid = guard(&child).id();
            let _ = Command::new("taskkill")
                .args(["/T", "/F", "/PID", &pid.to_string()])
                .creation_flags(CREATE_NO_WINDOW)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
            let mut child = guard(&child);
            let _ = child.kill();
            let _ = child.wait();
        });
    }
    #[cfg(not(windows))]
    {
        let mut child = guard(&child);
        #[cfg(unix)]
        {
            // SAFETY: plain syscall; the id is this child's, which has not been waited on yet.
            unsafe {
                libc::killpg(child.id() as libc::pid_t, libc::SIGKILL);
            }
        }
        let _ = child.kill();
        // Without the wait the killed worker is never reaped and stays as a zombie.
        let _ = child.wait();
    }
}

fn delegated_tasks(arguments: &Map<String, Value>) -> Vec<DelegatedTask> {
    arguments
        .get("tasks")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let (spec, kind, complexity, structured) = if let Some(spec) = item.as_str() {
                        (spec, "general", "standard", false)
                    } else {
                        let spec = item
                            .get("task")
                            .or_else(|| item.get("prompt"))
                            .and_then(Value::as_str)?;
                        let kind = item
                            .get("kind")
                            .and_then(Value::as_str)
                            .filter(|kind| {
                                matches!(*kind, "research" | "code" | "review" | "ops" | "general")
                            })
                            .unwrap_or("general");
                        let complexity = item
                            .get("complexity")
                            .and_then(Value::as_str)
                            .filter(|level| matches!(*level, "light" | "standard" | "deep"))
                            .unwrap_or("standard");
                        (spec, kind, complexity, true)
                    };
                    let spec = spec.trim();
                    (!spec.is_empty()).then(|| DelegatedTask {
                        spec: spec.to_string(),
                        kind: kind.to_string(),
                        complexity: complexity.to_string(),
                        structured,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// How much of a worker's stderr is kept for its failure report.
const STDERR_TAIL_BYTES: usize = 4096;

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
const MIN_JOB_TIMEOUT_MS: u64 = 60_000;
const MAX_JOB_TIMEOUT_MS: u64 = 24 * 60 * 60 * 1000;

const MAX_PENDING_DELIVERIES: usize = 256;

/// Finished workers stay alive so the lead can follow up on what they just did, but each one holds
/// a process, so only the most recent few are kept and older ones are let go.
const PARKED_LIMIT: usize = 4;
const MAX_PARKED_LIMIT: usize = 8;

/// How often a watchdog looks again while its worker waits on a person.
const BLOCKED_RECHECK_MS: u64 = 2_000;

/// Paths remembered per Codex file-change item, so an approval can say which files it is about.
const MAX_TRACKED_FILE_CHANGES: usize = 64;

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

/// Keeps the last `limit` bytes of a streaming reply. The cut moves forward to a character
/// boundary: model output is rarely plain ASCII, and cutting inside a character panics, which would
/// take the worker's reader thread down with it.
fn keep_tail(text: &mut String, limit: usize) {
    if text.len() <= limit {
        return;
    }
    let mut cut = text.len() - limit;
    while !text.is_char_boundary(cut) {
        cut += 1;
    }
    text.drain(..cut);
}

/// Puts a closing line after a report: the board shows a worker's last line, and the reason it
/// stopped is what the person needs to see there.
fn with_closing_line(report: &str, closing: &str) -> String {
    let report = report.trim();
    if report.is_empty() {
        closing.to_string()
    } else {
        format!("{report}\n\n{closing}")
    }
}

/// A Codex `TurnError` as one readable line: the message, then the details and error code when
/// they add something.
fn turn_error_text(error: &Value) -> String {
    let message = error
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("unknown error")
        .trim()
        .to_string();
    let details = error
        .get("additionalDetails")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|details| !details.is_empty() && !message.contains(details));
    let code = error.get("codexErrorInfo").and_then(Value::as_str);
    let mut text = message;
    if let Some(details) = details {
        text = format!("{text} ({details})");
    }
    if let Some(code) = code {
        text = format!("{text} [{code}]");
    }
    text
}

/// A one-line picture of a tool call for the board: the tool and its most telling argument.
fn tool_call_summary(tool: &str, input: &Value) -> String {
    const KEYS: [&str; 7] = [
        "url",
        "query",
        "pattern",
        "path",
        "file_path",
        "prompt",
        "command",
    ];
    let detail = KEYS
        .iter()
        .find_map(|key| input.get(*key).and_then(Value::as_str))
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| match input.as_object() {
            Some(map) if !map.is_empty() => input.to_string(),
            _ => String::new(),
        });
    let detail: String = detail.chars().take(240).collect();
    if detail.is_empty() {
        tool.to_string()
    } else {
        format!("{tool} {detail}")
    }
}

/// "Approve for the session" as Claude permission rules that last only as long as the worker: the
/// rules its CLI suggested, moved off every settings file, or else a rule for exactly this call.
/// Suggestions that would switch the whole permission mode are left out: one answer must not stop
/// the worker asking about everything else.
fn session_permissions(context: Option<&Value>) -> Value {
    let suggested: Vec<Value> = context
        .and_then(|context| context.get("suggestions"))
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter(|item| {
                    matches!(
                        item.get("type").and_then(Value::as_str),
                        Some("addRules" | "addDirectories")
                    )
                })
                .cloned()
                .map(|mut item| {
                    item["destination"] = json!("session");
                    item
                })
                .collect()
        })
        .unwrap_or_default();
    if !suggested.is_empty() {
        return Value::Array(suggested);
    }
    let tool = context
        .and_then(|context| context.get("tool"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    if tool.is_empty() {
        return json!([]);
    }
    let mut rule = json!({ "toolName": tool });
    let command = context
        .and_then(|context| context.get("input"))
        .and_then(|input| input.get("command"))
        .and_then(Value::as_str);
    if let (true, Some(command)) = (tool == "Bash", command) {
        rule["ruleContent"] = json!(command);
    }
    json!([{ "type": "addRules", "rules": [rule], "behavior": "allow", "destination": "session" }])
}

/// The `control_response` that answers a Claude worker's `can_use_tool`, in the shape the Agent SDK
/// sends: allow with the call's own input, or deny with a message the model reads.
fn claude_permission_reply(request_id: &Value, decision: &str, question: &Question) -> Value {
    let context = question.context.as_ref();
    let input = context
        .and_then(|context| context.get("input"))
        .filter(|input| input.is_object())
        .cloned()
        .unwrap_or_else(|| json!({}));
    let verdict = match decision {
        "accept" => json!({ "behavior": "allow", "updatedInput": input }),
        "acceptForSession" => json!({
            "behavior": "allow",
            "updatedInput": input,
            "updatedPermissions": session_permissions(context),
        }),
        "decline" => json!({
            "behavior": "deny",
            "message": "The person declined this. Carry on another way, or say in your report what you needed it for."
        }),
        _ => json!({
            "behavior": "deny",
            "message": "The person stopped this turn.",
            "interrupt": true
        }),
    };
    json!({
        "type": "control_response",
        "response": { "subtype": "success", "request_id": request_id, "response": verdict }
    })
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
    /// Where that terminal runs, which is where its workers start unless a delegation says otherwise.
    pub cwd: Option<String>,
}

/// One request a worker is stopped on.
struct Question {
    /// What the board shows, including the `rpcId` the answer goes back on.
    ask: Value,
    /// What answering needs but the board must not carry around: a Claude tool call's full input
    /// and the permission rules its CLI suggested.
    context: Option<Value>,
}

impl Question {
    fn rpc_id(&self) -> Option<&Value> {
        self.ask.get("rpcId")
    }
}

/// What a delegation decides about one job before it is queued.
struct JobSeed {
    id: String,
    planner_id: Option<String>,
    agent: String,
    run_id: String,
    run_label: Option<String>,
    spec: String,
    cwd: String,
    worktree: Option<String>,
    timeout_ms: Option<u64>,
    approval_policy: String,
    sandbox: String,
    web_search: bool,
    launch: WorkerDefaults,
    tier: Option<String>,
    kind: String,
    route_position: Option<usize>,
    overrides: Vec<String>,
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
    /// The model and effort the planner chose for this delegation; empty fields fall back to the
    /// worker defaults from preferences.
    launch: WorkerDefaults,
    /// What the worker actually runs on: the resolved launch settings, replaced by what the CLI
    /// itself reports once it starts, so the board names a model even when nobody chose one.
    ran: WorkerDefaults,
    /// The requests the worker is stopped on, oldest first, each kept with the id it must be
    /// answered on. More than one can be open: both CLIs make tool calls in parallel.
    questions: VecDeque<Question>,
    /// When the current wait on a person began, and how long this turn has waited so far: the
    /// watchdog does not spend a worker's budget on time it spent waiting for an answer.
    blocked_since: Option<u64>,
    blocked_ms: u64,
    /// Requests staged to a Codex worker that are still unanswered, by rpc id: the method, and for
    /// a steer the text, so a steer that lost its turn can still be delivered as the next one.
    inflight: HashMap<i64, (String, Option<String>)>,
    /// Paths of the file-change items in the current Codex turn, by item id.
    file_changes: HashMap<String, Vec<String>>,
    /// The last error Codex reported in this turn, for a failure that arrives without one.
    last_error: Option<String>,
    /// Set when the person stopped this turn from an approval, so its end is reported as stopped
    /// rather than as a failure of the worker.
    stop_note: Option<String>,
    /// The complexity tier and kind this job was routed by; None for a delegation that named its
    /// own agent. With it, a worker that runs out of quota can be moved to the tier's next route.
    tier: Option<String>,
    kind: String,
    /// Places in the tier already tried, so a moved job never goes back to a route that failed.
    tried_routes: Vec<usize>,
    /// Whether a turn of this job has ended. Only a job that never got that far is moved to
    /// another route: after that, starting over would redo work instead of continuing it.
    finished_once: bool,
    /// Restored from before a restart while still waiting for a slot. It starts once its CLI has
    /// been found again, rather than failing because the lookup had not happened yet.
    awaits_launcher: bool,
    /// The person's rules that won over what the planner asked for, for the board to show.
    overrides: Vec<String>,
    /// Counts the turns this process has started. A watchdog belongs to one turn, so a parked
    /// worker that gets a follow-up is timed afresh instead of by the timer of its first turn.
    turn: u64,
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
            "costUsd": self.cost_usd,
            "quota": self.quota,
            "routing": self.routing,
            "worktree": self.worktree,
            "pendingApproval": self.questions.front().map(|question| &question.ask),
            "waitingApprovals": self.questions.len(),
            "hasDiff": self.diff.is_some(),
            "model": self.ran.model.as_ref().or(self.launch.model.as_ref()),
            "effort": self.ran.effort.as_ref().or(self.launch.effort.as_ref()),
            "asksForApproval": self.asks_for_approval(),
            "overrides": self.overrides,
            // A finished worker whose process is still up can take a follow-up without starting
            // again; the board offers to let it go.
            "live": self.stdin.is_some(),
            "summary": tail(if self.report.is_empty() { &self.reply } else { &self.report }, 1200),
        })
    }

    fn asks_for_approval(&self) -> bool {
        approval_policy_value(&self.approval_policy) != Value::String("never".into())
    }

    /// Whether this job is counted in `running`: queued work has no slot yet and settled work gave
    /// its slot back.
    fn holds_slot(&self) -> bool {
        matches!(self.status.as_str(), STATUS_RUNNING | STATUS_BLOCKED)
    }

    /// Ends a wait on a person, adding it to the time this turn's watchdog does not count.
    fn unblock(&mut self) {
        if let Some(since) = self.blocked_since.take() {
            self.blocked_ms = self
                .blocked_ms
                .saturating_add(now_ms().saturating_sub(since));
        }
        self.questions.clear();
    }

    /// Drops the question answered or withdrawn on `rpc_id`. With none left open the worker is
    /// running again.
    fn close_question(&mut self, rpc_id: &Value) -> Option<Question> {
        let index = self
            .questions
            .iter()
            .position(|question| question.rpc_id() == Some(rpc_id))?;
        let question = self.questions.remove(index);
        if self.questions.is_empty() {
            self.unblock();
            if self.status == STATUS_BLOCKED {
                self.status = STATUS_RUNNING.to_string();
            }
        }
        question
    }

    /// Clears what belonged to the turn that just ended or is about to start.
    fn reset_turn_state(&mut self) {
        self.blocked_since = None;
        self.blocked_ms = 0;
        self.file_changes.clear();
        self.last_error = None;
        self.stop_note = None;
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
            "model": self.launch.model,
            "effort": self.launch.effort,
            "ranModel": self.ran.model,
            "ranEffort": self.ran.effort,
            "summary": self.report,
            "startedAt": self.started_at,
            "endedAt": self.ended_at,
            "timeoutMs": self.timeout_ms,
            "tier": self.tier,
            "kind": self.kind,
            "triedRoutes": self.tried_routes,
            "overrides": self.overrides,
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
        // Work that had not started lost nothing when the app closed: it is put back in line.
        let waiting = status == STATUS_QUEUED && text("threadId").is_none();
        // Work that was in flight did not finish and its process is gone. Restoring it as running
        // would show a live worker that does not exist.
        let status = match status.as_str() {
            STATUS_QUEUED if waiting => status,
            // A blocked worker was waiting on a question whose process died with the app; left as
            // blocked it would count as live work and hold its planner's `alethe_check` open.
            STATUS_RUNNING | STATUS_QUEUED | STATUS_BLOCKED => STATUS_INTERRUPTED.to_string(),
            _ => status,
        };
        let strings = |key: &str| -> Vec<String> {
            value
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
            // Absent in a record written before budgets were saved; null means none was set.
            timeout_ms: match value.get("timeoutMs") {
                Some(Value::Null) => None,
                Some(saved) => saved.as_u64(),
                None => Some(DEFAULT_JOB_TIMEOUT_MS),
            },
            approval_policy: text("approvalPolicy").unwrap_or_else(|| "never".to_string()),
            sandbox: text("sandbox").unwrap_or_else(|| "workspace-write".to_string()),
            web_search: value
                .get("webSearch")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            launch: WorkerDefaults {
                model: text("model"),
                effort: text("effort"),
            },
            ran: WorkerDefaults {
                model: text("ranModel"),
                effort: text("ranEffort"),
            },
            questions: VecDeque::new(),
            blocked_since: None,
            blocked_ms: 0,
            inflight: HashMap::new(),
            file_changes: HashMap::new(),
            last_error: None,
            stop_note: None,
            tier: text("tier"),
            kind: text("kind").unwrap_or_default(),
            tried_routes: value
                .get("triedRoutes")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(Value::as_u64)
                        .map(|place| place as usize)
                        .collect()
                })
                .unwrap_or_default(),
            // Restored work that already ran is never started over on another route.
            finished_once: !waiting,
            awaits_launcher: waiting,
            overrides: strings("overrides"),
            turn: 0,
            child: None,
            stdin: None,
            inbox: VecDeque::new(),
            routing: None,
            awaiting_steer: false,
            next_request_id: 10,
        })
    }

    /// A job as `alethe_delegate` queues it; everything else starts empty.
    fn queued(seed: JobSeed) -> Self {
        Self {
            id: seed.id,
            planner_id: seed.planner_id,
            agent: seed.agent,
            run_id: seed.run_id,
            run_label: seed.run_label,
            spec: seed.spec,
            cwd: seed.cwd,
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
            worktree: seed.worktree,
            timeout_ms: seed.timeout_ms,
            approval_policy: seed.approval_policy,
            sandbox: seed.sandbox,
            web_search: seed.web_search,
            launch: seed.launch,
            ran: WorkerDefaults::default(),
            questions: VecDeque::new(),
            blocked_since: None,
            blocked_ms: 0,
            inflight: HashMap::new(),
            file_changes: HashMap::new(),
            last_error: None,
            stop_note: None,
            tier: seed.tier,
            kind: seed.kind,
            tried_routes: seed.route_position.into_iter().collect(),
            finished_once: false,
            awaits_launcher: false,
            overrides: seed.overrides,
            turn: 0,
            child: None,
            stdin: None,
            inbox: VecDeque::new(),
            routing: None,
            awaiting_steer: false,
            next_request_id: 10,
        }
    }

    fn settled(&self) -> bool {
        matches!(
            self.status.as_str(),
            STATUS_DONE | STATUS_FAILED | STATUS_CANCELLED | STATUS_RELEASED | STATUS_INTERRUPTED
        )
    }

    fn teardown(&mut self) {
        if let Some(child) = self.child.take() {
            stop_worker(child);
        }
        self.stdin = None;
        self.inflight.clear();
    }
}

struct Delivery {
    seq: u64,
    kind: String,
    job_id: String,
    /// The planner whose delegation produced it: only that planner's `alethe_check` takes it.
    planner_id: Option<String>,
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
    max_concurrent: usize,
    job_counter: u64,
    run_counter: u64,
    planners: HashMap<String, Planner>,
}

impl Inner {
    /// How many jobs hold a slot. Counted from the jobs themselves rather than kept as a tally: a
    /// tally has to be adjusted at every status change, and one missed adjustment leaks a slot for
    /// good, while this cannot disagree with what the jobs say.
    fn running(&self) -> usize {
        self.jobs.values().filter(|job| job.holds_slot()).count()
    }

    /// Everything about the state that must hold whenever the lock is free, as a list of what
    /// does not. Empty when the state is sound.
    fn audit(&self) -> Vec<String> {
        let mut problems = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for id in &self.queue {
            if !seen.insert(id) {
                problems.push(format!("{id} is queued twice"));
            }
            match self.jobs.get(id) {
                None => problems.push(format!("{id} is queued but does not exist")),
                Some(job) if job.status != STATUS_QUEUED => {
                    problems.push(format!("{id} is in the queue with status {}", job.status))
                }
                Some(_) => {}
            }
        }
        for (id, job) in &self.jobs {
            if job.status == STATUS_QUEUED && !self.queue.contains(id) {
                problems.push(format!(
                    "{id} is waiting for a slot but is not in the queue"
                ));
            }
            if job.status == STATUS_BLOCKED && job.questions.is_empty() {
                problems.push(format!("{id} is blocked on no question"));
            }
            if job.settled() && !job.questions.is_empty() {
                problems.push(format!("{id} is settled with a question still open"));
            }
            if !self.order.contains(id) {
                problems.push(format!("{id} is missing from the board order"));
            }
        }
        for id in &self.order {
            if !self.jobs.contains_key(id) {
                problems.push(format!("{id} is listed on the board but does not exist"));
            }
        }
        problems
    }

    fn snapshot(&self) -> Value {
        let jobs: Vec<Value> = self
            .order
            .iter()
            .filter_map(|id| self.jobs.get(id))
            .map(|job| {
                let mut snapshot = job.snapshot();
                // Where the job stands among those waiting for a slot, so the board can show the
                // order they will start in and let the person change it.
                snapshot["queuePosition"] = json!(self.queue.iter().position(|id| id == &job.id));
                snapshot
            })
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
            "running": self.running(),
            "queued": self.queue.len(),
            "concurrencyLimit": self.max_concurrent
        })
    }

    /// Marks a new turn on the job and returns what its watchdog needs: the turn number it guards
    /// and its budget, or None when the job runs without one.
    fn begin_turn(&mut self, job_id: &str) -> Option<(u64, u64)> {
        let job = self.jobs.get_mut(job_id)?;
        job.turn += 1;
        job.reset_turn_state();
        job.timeout_ms.map(|timeout_ms| (job.turn, timeout_ms))
    }

    /// Work a planner is still waiting on. Scoped to it, so one planner's long-running batch never
    /// keeps another planner's `alethe_check` waiting.
    fn pending_for(&self, planner: Option<&str>) -> usize {
        self.jobs
            .values()
            .filter(|job| !job.settled() && job.planner_id.as_deref() == planner)
            .count()
    }

    fn has_delivery_for(&self, planner: Option<&str>) -> bool {
        self.deliveries
            .iter()
            .any(|delivery| delivery.planner_id.as_deref() == planner)
    }

    /// Removes and returns this planner's deliveries in order, leaving every other planner's.
    fn take_deliveries_for(&mut self, planner: Option<&str>) -> Vec<Delivery> {
        let (mine, others): (VecDeque<Delivery>, VecDeque<Delivery>) =
            std::mem::take(&mut self.deliveries)
                .into_iter()
                .partition(|delivery| delivery.planner_id.as_deref() == planner);
        self.deliveries = others;
        mine.into_iter().collect()
    }

    fn push_delivery(&mut self, kind: &str, job_id: &str, outcome: Option<String>, text: String) {
        self.seq += 1;
        let seq = self.seq;
        let planner_id = self.jobs.get(job_id).and_then(|job| job.planner_id.clone());
        // Results wait for the planner that delegated them; one that closed never collects its own,
        // so past this many the oldest go rather than piling up until the app exits.
        while self.deliveries.len() >= MAX_PENDING_DELIVERIES {
            self.deliveries.pop_front();
        }
        self.deliveries.push_back(Delivery {
            seq,
            kind: kind.to_string(),
            job_id: job_id.to_string(),
            planner_id,
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
    /// Per-agent model and effort for workers, pushed in by the app layer like `fitness`.
    worker_defaults: Arc<Mutex<HashMap<String, WorkerDefaults>>>,
    /// The person's rules for workers, pushed in by the app layer like `worker_defaults`.
    policy: Arc<Mutex<WorkerPolicy>>,
    /// Tier routes and quota bands. Kept as JSON because the persisted source of truth lives in
    /// the frontend and model ids are discovered per signed-in CLI account.
    routing_policy: Arc<Mutex<Value>>,
    /// Routing for the planners of a project that has its own profile, by planner id; the rest use
    /// `routing_policy`.
    planner_routing: Arc<Mutex<HashMap<String, Value>>>,
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
            launchers: Arc::new(Mutex::new(HashMap::new())),
            fitness: Arc::new(Mutex::new(HashMap::new())),
            worker_defaults: Arc::new(Mutex::new(HashMap::new())),
            policy: Arc::new(Mutex::new(WorkerPolicy::default())),
            routing_policy: Arc::new(Mutex::new(default_routing_policy())),
            planner_routing: Arc::new(Mutex::new(HashMap::new())),
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
    let steer_text = (method == "turn/steer")
        .then(|| params["input"][0]["text"].as_str().map(ToOwned::to_owned))
        .flatten();
    job.inflight.insert(id, (method.to_string(), steer_text));
    Ok((
        stdin,
        json!({ "id": id, "method": method, "params": params }),
    ))
}

/// The policy a job was delegated with, as Codex expects it. A follow-up `turn/start` carries it
/// too, because a turn's policy replaces the thread's for that turn and every one after it.
fn approval_policy_value(policy: &str) -> Value {
    serde_json::from_str::<Value>(policy).unwrap_or(Value::String("never".into()))
}

/// Pops the next queued message for a worker and turns it into a fresh turn on its own thread, so
/// the follow-up keeps everything the worker already read.
fn next_from_inbox(inner: &mut Inner, job_id: &str) -> Option<(Arc<Mutex<ChildStdin>>, Value)> {
    let job = inner.jobs.get_mut(job_id)?;
    let stdin = job.stdin.clone()?;
    let thread_id = job.thread_id.clone()?;
    let is_claude = job.agent == "claude";
    let approval_policy = approval_policy_value(&job.approval_policy);
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
            "approvalPolicy": approval_policy
        }),
    )
    .ok()
}

/// Finished workers are kept so the lead can follow up, but each one is a live process. Past the
/// limit the least recently finished is let go; its record stays, only the process is gone.
fn release_oldest_parked(inner: &mut Inner, limit: usize) {
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
        if parked.len() <= limit {
            return;
        }
        let Some(oldest) = parked.first().cloned() else {
            return;
        };
        // Only the process goes. The job keeps the outcome it finished with, and a follow-up
        // still reaches it: `alethe_send` starts it again on its saved thread.
        if let Some(job) = inner.jobs.get_mut(&oldest) {
            job.teardown();
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
        // Work that was waiting for a slot goes back in the order it was left in; anything the
        // saved order does not name follows in the order it was delegated.
        let mut waiting: Vec<String> = value
            .get("queue")
            .and_then(Value::as_array)
            .map(|ids| {
                ids.iter()
                    .filter_map(Value::as_str)
                    .map(ToOwned::to_owned)
                    .collect()
            })
            .unwrap_or_default();
        waiting.retain(|id| {
            inner
                .jobs
                .get(id)
                .is_some_and(|job| job.status == STATUS_QUEUED)
        });
        waiting.dedup();
        for id in inner.order.clone() {
            let queued = inner
                .jobs
                .get(&id)
                .is_some_and(|job| job.status == STATUS_QUEUED);
            if queued && !waiting.contains(&id) {
                waiting.push(id);
            }
        }
        inner.queue = waiting.into();
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
                    cwd: text("cwd"),
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
                "queue": inner.queue,
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
                        "agent": planner.agent,
                        "cwd": planner.cwd
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
        {
            let inner = guard(&self.inner);
            self.notify(&inner);
        }
        // Work restored from before a restart was waiting for exactly this.
        self.drain_queue();
    }

    pub fn has_launcher(&self, kind: &str) -> bool {
        guard(&self.launchers).contains_key(kind)
    }

    pub fn remove_launcher(&self, kind: &str) {
        guard(&self.launchers).remove(kind);
        let inner = guard(&self.inner);
        self.notify(&inner);
    }

    fn set_job_routing(&self, job_id: &str, routing: Value) {
        let mut inner = guard(&self.inner);
        if let Some(job) = inner.jobs.get_mut(job_id) {
            job.routing = Some(routing);
        }
        self.notify(&inner);
    }

    pub fn set_agent_fitness(&self, agent: &str, snapshot: Value) {
        guard(&self.fitness).insert(agent.to_string(), snapshot);
    }

    /// Applies to workers started from now on; one already running keeps what it was started with.
    pub fn set_worker_defaults(&self, agent: &str, defaults: WorkerDefaults) {
        guard(&self.worker_defaults).insert(agent.to_string(), defaults.sanitized(agent));
    }

    /// Applies to delegations from now on; work already queued keeps the rules it was given.
    pub fn set_policy(&self, policy: WorkerPolicy) {
        let policy = policy.sanitized();
        let parked_limit = policy.parked_limit;
        *guard(&self.policy) = policy;
        // A lower limit takes effect at once, not when the next worker happens to finish.
        let mut inner = guard(&self.inner);
        release_oldest_parked(&mut inner, parked_limit);
        self.notify(&inner);
    }

    pub fn set_routing_policy(&self, policy: Value) {
        *guard(&self.routing_policy) = sanitize_routing_policy(policy);
    }

    /// Gives one planner its own routing, or takes it back to the shared one with `None`.
    pub fn set_planner_routing(&self, planner: &str, policy: Option<Value>) {
        let mut routing = guard(&self.planner_routing);
        match policy {
            Some(policy) => {
                routing.insert(planner.to_string(), sanitize_routing_policy(policy));
            }
            None => {
                routing.remove(planner);
            }
        }
    }

    fn routing_for(&self, planner: Option<&str>) -> Value {
        planner
            .and_then(|planner| guard(&self.planner_routing).get(planner).cloned())
            .unwrap_or_else(|| guard(&self.routing_policy).clone())
    }

    /// A tier's routes that can take work right now: the ones whose CLI is installed, each with
    /// its place in the tier and how used its provider is.
    fn tier_candidates(
        &self,
        routing: &Value,
        tier: &str,
    ) -> Vec<(usize, String, WorkerDefaults, f64)> {
        routing["tiers"][tier]
            .as_array()
            .map(|routes| {
                routes
                    .iter()
                    .enumerate()
                    .filter_map(|(position, route)| {
                        let agent = route["agent"].as_str()?.to_string();
                        if !self.has_launcher(&agent) {
                            return None;
                        }
                        let launch = WorkerDefaults {
                            model: route["model"].as_str().map(ToOwned::to_owned),
                            effort: route["effort"].as_str().map(ToOwned::to_owned),
                        }
                        .sanitized(&agent);
                        let pressure = self.route_pressure(&agent, launch.model.as_deref());
                        Some((position, agent, launch, pressure))
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    /// A worker that ran out of quota before finishing anything is started again on the next
    /// route of its tier, instead of failing and leaving the planner to delegate the work again.
    /// False when the job was not routed by a tier, already finished a turn, or has no route left.
    fn try_reroute(&self, job_id: &str, error: &str) -> bool {
        if !is_usage_limit(error) {
            return false;
        }
        let (tier, planner, tried, from) = {
            let inner = guard(&self.inner);
            let Some(job) = inner.jobs.get(job_id) else {
                return false;
            };
            let Some(tier) = job
                .tier
                .clone()
                .filter(|_| job.holds_slot() && !job.finished_once)
            else {
                return false;
            };
            (
                tier,
                job.planner_id.clone(),
                job.tried_routes.clone(),
                job.agent.clone(),
            )
        };
        let routing = self.routing_for(planner.as_deref());
        let critical = routing["criticalPercent"].as_f64().unwrap_or(95.0);
        let untried: Vec<_> = self
            .tier_candidates(&routing, &tier)
            .into_iter()
            .filter(|route| !tried.contains(&route.0))
            .collect();
        // A route with room comes first. Failing that, another provider is still worth a try: the
        // reading that says it is full may be older than the failure that says this one is.
        let Some((position, agent, launch, pressure)) = untried
            .iter()
            .find(|route| route.3 < critical)
            .or_else(|| untried.iter().find(|route| route.1 != from))
            .cloned()
        else {
            return false;
        };

        {
            let mut inner = guard(&self.inner);
            let Some(job) = inner.jobs.get_mut(job_id) else {
                return false;
            };
            if !job.holds_slot() {
                return false;
            }
            job.teardown();
            job.unblock();
            job.reset_turn_state();
            // Whatever was timing the turn that just ended must not stop the one about to start.
            job.turn += 1;
            job.reply = format!(
                "{from} ran out of usage ({}); starting again on {agent}.\n",
                tail(error.trim(), 200)
            );
            job.report.clear();
            job.routing = Some(json!({
                "verdict": "routed",
                "agent": agent.clone(),
                "tier": tier,
                "kind": job.kind.clone(),
                "route": if position == 0 { "primary" } else { "fallback" },
                "position": position,
                "used": if pressure == f64::MAX { 100.0 } else { pressure.round() },
                "avoided": { "agent": from, "used": 100.0, "rateLimited": true },
            }));
            job.agent = agent;
            job.launch = launch;
            job.ran = WorkerDefaults::default();
            job.thread_id = None;
            job.active_turn_id = None;
            job.tokens = None;
            job.status = STATUS_QUEUED.to_string();
            job.started_at = None;
            job.ended_at = None;
            job.outcome = None;
            job.tried_routes.push(position);
            // It already had a slot, so it goes back in ahead of work that never started.
            inner.queue.push_front(job_id.to_string());
            self.notify(&inner);
        }
        self.persist();
        self.drain_queue();
        true
    }

    pub fn policy(&self) -> WorkerPolicy {
        guard(&self.policy).clone()
    }

    /// The CLI for a delegation that names none. `auto` takes the first installed one, unless it is
    /// running out and another installed one has more room.
    fn default_agent(&self) -> String {
        let configured = guard(&self.policy).default_agent.clone();
        if configured != "auto" {
            return configured;
        }
        let installed: Vec<&str> = ["codex", "claude"]
            .into_iter()
            .filter(|agent| self.has_launcher(agent))
            .collect();
        let Some(first) = installed.first().copied() else {
            return "codex".into();
        };
        if let Some(block) = self.fitness_block() {
            let strained = block.get(first).is_some_and(past_threshold);
            if let Some(other) = block
                .get("headroom")
                .and_then(Value::as_str)
                .filter(|other| strained && installed.contains(other))
            {
                return other.to_string();
            }
        }
        first.to_string()
    }

    fn route_pressure(&self, agent: &str, model: Option<&str>) -> f64 {
        let fitness = guard(&self.fitness);
        let Some(snapshot) = fitness.get(agent) else {
            return 0.0;
        };
        if snapshot
            .get("rateLimited")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            return f64::MAX;
        }
        let Some(windows) = snapshot.get("windows").and_then(Value::as_object) else {
            return strain_of(snapshot);
        };
        let is_opus = agent == "claude"
            && model
                .map(|model| model.to_ascii_lowercase().contains("opus"))
                .unwrap_or(false);
        windows
            .iter()
            .filter(|(name, _)| name.as_str() != "opus" || is_opus)
            .filter_map(|(_, window)| window.get("used").and_then(Value::as_f64))
            .fold(0.0, f64::max)
    }

    fn route_task(
        &self,
        task: DelegatedTask,
        force: bool,
        planner: Option<&str>,
    ) -> Result<RoutedTask, String> {
        let routing = self.routing_for(planner);
        // Only routes whose CLI is installed can take the task; each keeps its place in the tier.
        let candidates = self.tier_candidates(&routing, &task.complexity);
        if candidates.is_empty() {
            return Err("no configured Claude or Codex worker is available".into());
        }
        let critical = routing["criticalPercent"].as_f64().unwrap_or(95.0);
        let protect = routing["protectPercent"].as_f64().unwrap_or(80.0);
        let watch = routing["watchPercent"].as_f64().unwrap_or(60.0);
        let pressures: Vec<f64> = candidates.iter().map(|route| route.3).collect();
        let pick = pick_route(&pressures, watch, protect);
        // `avoided` is the route this task was moved away from, kept so the board can say why a
        // worker did not run on the tier's first choice.
        let avoided = (pick > 0).then(|| {
            let first = &candidates[0];
            json!({
                "agent": first.1,
                "used": if first.3 == f64::MAX { 100.0 } else { first.3.round() },
                "rateLimited": first.3 == f64::MAX,
            })
        });
        let (position, agent, launch, pressure) = candidates[pick].clone();
        if !force && pressure >= critical {
            let shown = if pressure == f64::MAX {
                "rate-limited".to_string()
            } else {
                format!("at {pressure:.0}%")
            };
            return Err(format!(
                "every available route for this {} task is critical; {agent} is {shown}. Ask the person whether to continue, then repeat with forceRoute true only if they approve",
                task.complexity
            ));
        }
        let used = if pressure == f64::MAX {
            100.0
        } else {
            pressure
        };
        let routing_note = json!({
            "verdict": "routed",
            "agent": agent.clone(),
            "tier": task.complexity.clone(),
            "kind": task.kind.clone(),
            "route": if position == 0 { "primary" } else { "fallback" },
            "position": position,
            "used": used.round(),
            "avoided": avoided,
        });
        Ok(RoutedTask {
            task,
            agent,
            launch,
            routing: routing_note,
            position: Some(position),
        })
    }

    /// Takes finished workers off the board for good: their processes are stopped and their rows
    /// forgotten. Work that is still running, queued or waiting on the person is left alone, and a
    /// result the planner has not collected yet still reaches it.
    pub fn clear_finished(&self, job_ids: &[String]) -> Value {
        let mut cleared = Vec::new();
        {
            let mut inner = guard(&self.inner);
            for id in job_ids {
                let settled = inner.jobs.get(id).is_some_and(Job::settled);
                if !settled {
                    continue;
                }
                if let Some(mut job) = inner.jobs.remove(id) {
                    job.teardown();
                }
                inner.order.retain(|listed| listed != id);
                cleared.push(id.clone());
            }
            self.notify(&inner);
        }
        self.persist();
        json!({ "cleared": cleared })
    }

    /// Puts queued work in the order the person asked for. Only the places in the queue held by
    /// the named jobs change hands, so reordering one planner's workers never moves another's;
    /// a job that is not waiting any more is ignored.
    pub fn reorder_queue(&self, job_ids: &[String]) -> Value {
        let mut inner = guard(&self.inner);
        let mut wanted: Vec<String> = Vec::new();
        for id in job_ids {
            if inner.queue.contains(id) && !wanted.contains(id) {
                wanted.push(id.clone());
            }
        }
        let slots: Vec<usize> = inner
            .queue
            .iter()
            .enumerate()
            .filter(|(_, id)| wanted.contains(id))
            .map(|(index, _)| index)
            .collect();
        for (slot, id) in slots.into_iter().zip(wanted) {
            inner.queue[slot] = id;
        }
        self.notify(&inner);
        let queue = json!({ "queue": inner.queue });
        drop(inner);
        // The order is the person's; it has to outlive a restart like the work itself.
        self.persist();
        queue
    }

    fn planner_cwd(&self, planner: Option<&str>) -> Option<String> {
        let inner = guard(&self.inner);
        inner
            .planners
            .get(planner?)
            .and_then(|planner| planner.cwd.clone())
            .filter(|cwd| !cwd.trim().is_empty())
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
        // Raising the limit starts work that was waiting for a slot instead of leaving it queued
        // until some other worker happens to finish.
        self.drain_queue();
        let inner = guard(&self.inner);
        self.notify(&inner);
    }

    pub fn snapshot(&self) -> Value {
        let inner = guard(&self.inner);
        self.board_snapshot(&inner)
    }

    /// The jobs plus which worker CLIs are installed, which only this layer knows.
    fn board_snapshot(&self, inner: &Inner) -> Value {
        let mut snapshot = inner.snapshot();
        let installed: Vec<String> = ["claude", "codex"]
            .into_iter()
            .filter(|agent| self.has_launcher(agent))
            .map(ToOwned::to_owned)
            .collect();
        snapshot["installedAgents"] = json!(installed);
        snapshot
    }

    /// What is wrong with the orchestrator's state, for tests: an empty list means every job, the
    /// queue and the board agree with each other.
    pub fn audit(&self) -> Vec<String> {
        guard(&self.inner).audit()
    }

    /// Running and queued counts, for tests and for the UI.
    pub fn counts(&self) -> (usize, usize) {
        let inner = guard(&self.inner);
        (inner.running(), inner.queue.len())
    }

    /// Every caller holds the lock, so the observer must not run here: it belongs to the app layer
    /// and whatever it does - emitting to a webview, in practice - would block every other job for
    /// as long as it took. Snapshots go to a channel instead, and one thread delivers them in order.
    fn notify(&self, inner: &Inner) {
        let sender = guard(&self.dispatch).clone();
        if let Some(sender) = sender {
            let _ = sender.send(self.board_snapshot(inner));
        }
    }

    fn spawn_worker(&self, job_id: &str) {
        if self.start_parked_turn(job_id) {
            return;
        }
        let (agent, cwd, spec, resume_thread, approval_policy, sandbox, web_search, launch, asks) = {
            let mut inner = guard(&self.inner);
            let Some(job) = inner.jobs.get_mut(job_id) else {
                return;
            };
            // Cancelled or released while it waited for a slot: it must not start after all.
            if job.status != STATUS_QUEUED {
                return;
            }
            job.status = STATUS_RUNNING.to_string();
            job.awaits_launcher = false;
            job.started_at = Some(now_ms());
            job.ended_at = None;
            job.outcome = None;
            job.turn += 1;
            job.reset_turn_state();
            // A worker coming back on its thread starts with the message that brought it back. A
            // new one starts with its task: anything sent to it before it ran waits its turn.
            let first_turn = match job.thread_id {
                Some(_) => job.inbox.pop_front().unwrap_or_else(|| job.spec.clone()),
                None => job.spec.clone(),
            };
            let started = (
                job.agent.clone(),
                job.cwd.clone(),
                first_turn,
                job.thread_id.clone(),
                job.approval_policy.clone(),
                job.sandbox.clone(),
                job.web_search,
                job.launch.clone(),
                job.asks_for_approval(),
            );
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

        let resolved = {
            let defaults = guard(&self.worker_defaults)
                .get(&agent)
                .cloned()
                .unwrap_or_default();
            launch.over(defaults)
        };
        {
            let mut inner = guard(&self.inner);
            if let Some(job) = inner.jobs.get_mut(job_id) {
                job.ran = resolved.clone();
            }
        }

        // A directory removed since the delegation (a worktree cleaned up, a project moved) would
        // otherwise fail as a bare "No such file or directory" that names neither the path nor why.
        if !std::path::Path::new(&cwd).is_dir() {
            self.settle(
                job_id,
                STATUS_FAILED,
                "failed",
                &format!("the working directory {cwd} does not exist any more"),
            );
            return;
        }

        let mut command = Command::new(&launcher.program);
        command.args(&launcher.args);
        if is_claude {
            command.args(claude_permission_args(asks));
        }
        command
            .args(resolved.launch_args(&agent))
            .current_dir(PathBuf::from(&cwd))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        // Claude keeps its own session on disk under this id — no separate resume RPC like Codex's
        // `thread/resume`, the CLI just needs the id up front.
        if is_claude {
            if let Some(thread_id) = &resume_thread {
                command.args(["--resume", thread_id]);
            }
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
        // Its own process group, so stopping the worker can stop everything it started.
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
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
        // A CLI that is logged out or misconfigured says so on stderr and exits. Keeping the end of
        // it is what turns "connection closed" into something the person can act on. It has to be
        // drained either way: a full pipe would stall a worker that logs a lot.
        let stderr_tail = Arc::new(Mutex::new(Vec::<u8>::new()));
        let stderr_done = Arc::new(Mutex::new(false));
        match child.stderr.take() {
            Some(mut stderr) => {
                let tail = Arc::clone(&stderr_tail);
                let done = Arc::clone(&stderr_done);
                thread::spawn(move || {
                    let mut chunk = [0u8; 1024];
                    while let Ok(read) = stderr.read(&mut chunk) {
                        if read == 0 {
                            break;
                        }
                        let mut tail = guard(&tail);
                        tail.extend_from_slice(&chunk[..read]);
                        let excess = tail.len().saturating_sub(STDERR_TAIL_BYTES);
                        tail.drain(..excess);
                    }
                    *guard(&done) = true;
                });
            }
            None => *guard(&stderr_done) = true,
        }
        let child = Arc::new(Mutex::new(child));

        {
            let mut inner = guard(&self.inner);
            let adopted = match inner.jobs.get_mut(job_id) {
                // Cancelled while its process was starting: nothing would ever stop this one.
                Some(job) if !job.settled() => {
                    job.child = Some(Arc::clone(&child));
                    job.stdin = Some(Arc::clone(&stdin));
                    true
                }
                _ => false,
            };
            if !adopted {
                drop(inner);
                stop_worker(child);
                return;
            }
            self.notify(&inner);
        }
        // Saved as started: a restart must not mistake work that was running for work that was
        // still waiting, and run it a second time.
        self.persist();

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
            // A resumed thread is opened with the same settings as a new one: otherwise a worker
            // revived after the app restarted would lose its approval policy, sandbox and web
            // search, and run on whatever the person's own Codex config says.
            let mut params = json!({
                "cwd": cwd,
                "approvalPolicy": approval_policy_value(&approval_policy),
                "approvalsReviewer": "user",
                "sandbox": sandbox,
                // A top-level `web_search` is the key Codex reads ("live", "cached", "indexed" or
                // "disabled"); `tools.web_search` only tunes the tool and cannot switch it.
                "config": { "web_search": if web_search { "live" } else { "disabled" } }
            });
            // Codex keeps threads on disk, so a worker whose process died can pick up its own history
            // instead of reading everything again.
            let method = match &resume_thread {
                Some(thread_id) => {
                    params["threadId"] = Value::String(thread_id.clone());
                    "thread/resume"
                }
                None => "thread/start",
            };
            let _ = send_rpc(
                &stdin,
                &json!({ "id": 2, "method": method, "params": params }),
            );
        }

        let watch = guard(&self.inner)
            .jobs
            .get(job_id)
            .and_then(|job| job.timeout_ms.map(|timeout_ms| (job.turn, timeout_ms)));
        if let Some((turn, timeout_ms)) = watch {
            self.arm_watchdog(job_id, turn, timeout_ms);
        }

        if let Some(stdout) = stdout {
            let core = self.clone();
            let owned_id = job_id.to_string();
            let stdin = Arc::clone(&stdin);
            let child = Arc::clone(&child);
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
                        core.on_worker_message_claude(&owned_id, &stdin, &message);
                    } else {
                        core.on_worker_message(&owned_id, &stdin, &spec, &message);
                    }
                }
                // stderr usually closes with stdout, but a descendant can hold it open, so this
                // waits briefly for the last lines instead of joining the reader.
                for _ in 0..20 {
                    if *guard(&stderr_done) {
                        break;
                    }
                    thread::sleep(Duration::from_millis(10));
                }
                let said = String::from_utf8_lossy(&guard(&stderr_tail))
                    .trim()
                    .to_string();
                let report = if said.is_empty() {
                    "worker connection closed".to_string()
                } else {
                    format!("worker connection closed: {said}")
                };
                core.on_worker_exit(&owned_id, &child, report);
            });
        }
    }

    /// A queued follow-up for a worker whose process is still up goes to that process as a new turn
    /// on its own thread, instead of a second process being started. False when there is no such
    /// process, and the caller starts one.
    fn start_parked_turn(&self, job_id: &str) -> bool {
        let (staged, watch) = {
            let mut inner = guard(&self.inner);
            let parked = inner
                .jobs
                .get(job_id)
                .is_some_and(|job| job.status == STATUS_QUEUED && job.stdin.is_some());
            if !parked {
                return false;
            }
            let Some(staged) = next_from_inbox(&mut inner, job_id) else {
                // Nothing it could be given as a turn: start it over instead.
                if let Some(job) = inner.jobs.get_mut(job_id) {
                    job.teardown();
                }
                return false;
            };
            if let Some(job) = inner.jobs.get_mut(job_id) {
                job.status = STATUS_RUNNING.to_string();
                job.outcome = None;
                job.ended_at = None;
                job.reply.clear();
                job.report.clear();
            }
            let watch = inner.begin_turn(job_id);
            self.notify(&inner);
            (staged, watch)
        };
        let (stdin, request) = staged;
        // The slot was taken before the write, so a worker that never receives the turn has to
        // give it back rather than hold it until the process dies.
        if let Err(error) = send_rpc(&stdin, &request) {
            self.settle(job_id, STATUS_FAILED, "send-failed", &error);
            return true;
        }
        if let Some((turn, timeout_ms)) = watch {
            self.arm_watchdog(job_id, turn, timeout_ms);
        }
        true
    }

    /// The process behind a job closed its output. Only the process the job still points at counts:
    /// one that was replaced (the worker was started again on its thread) must not take its
    /// successor down with it.
    fn on_worker_exit(&self, job_id: &str, child: &Arc<Mutex<Child>>, report: String) {
        let running = {
            let mut inner = guard(&self.inner);
            let Some(job) = inner.jobs.get_mut(job_id) else {
                return;
            };
            let ours = job
                .child
                .as_ref()
                .is_some_and(|current| Arc::ptr_eq(current, child));
            if !ours {
                return;
            }
            if job.settled() || job.status == STATUS_QUEUED {
                // A parked worker that exited on its own is no longer live; a follow-up now
                // starts it again on its thread instead of writing into a dead pipe. One whose
                // follow-up is still waiting for a slot keeps its place in the queue.
                job.teardown();
                self.notify(&inner);
                false
            } else {
                true
            }
        };
        if running && !self.try_reroute(job_id, &report) {
            self.finish(job_id, STATUS_FAILED, Some("failed".into()), report, true);
        }
    }

    /// A worker that never finishes its turn would otherwise hold a slot forever, so the budget
    /// is enforced here rather than left to the lead remembering to cancel.
    fn arm_watchdog(&self, job_id: &str, turn: u64, timeout_ms: u64) {
        let core = self.clone();
        let job_id = job_id.to_string();
        let armed_at = now_ms();
        thread::spawn(move || {
            // Time spent waiting on a person is not the worker's: the deadline moves by however
            // long it was blocked, and it is never stopped while the question is still open.
            loop {
                let wait = {
                    let inner = guard(&core.inner);
                    let Some(job) = inner.jobs.get(&job_id) else {
                        return;
                    };
                    // A later turn has its own watchdog; this one only ever stops the turn it timed.
                    if job.settled() || job.turn != turn {
                        return;
                    }
                    let now = now_ms();
                    let blocked = job.blocked_ms.saturating_add(
                        job.blocked_since
                            .map(|since| now.saturating_sub(since))
                            .unwrap_or(0),
                    );
                    let deadline = armed_at.saturating_add(timeout_ms).saturating_add(blocked);
                    if job.blocked_since.is_some() {
                        Some(BLOCKED_RECHECK_MS)
                    } else if now < deadline {
                        Some(deadline - now)
                    } else {
                        None
                    }
                };
                match wait {
                    Some(ms) => thread::sleep(Duration::from_millis(ms)),
                    None => break,
                }
            }
            let payload = {
                let inner = guard(&core.inner);
                let Some(job) = inner.jobs.get(&job_id) else {
                    return;
                };
                if job.settled() || job.turn != turn {
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
                format!(
                    "worker passed its {}s budget and was stopped",
                    timeout_ms / 1000
                ),
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

        // A file-change request names only its item; the paths came earlier, when the item started.
        let mut files: Vec<String> = Vec::new();
        if kind == "fileChange" {
            if let Some(item_id) = params.get("itemId").and_then(Value::as_str) {
                let inner = guard(&self.inner);
                if let Some(paths) = inner
                    .jobs
                    .get(job_id)
                    .and_then(|job| job.file_changes.get(item_id))
                {
                    files.extend(paths.iter().cloned());
                }
            }
            if let Some(root) = params.get("grantRoot").and_then(Value::as_str) {
                files.push(root.to_string());
            }
        }

        let ask = json!({
            "rpcId": rpc_id,
            "kind": kind,
            "command": params.get("command").and_then(Value::as_str),
            "cwd": params.get("cwd").and_then(Value::as_str),
            "reason": params.get("reason").and_then(Value::as_str),
            "files": files,
            "askedAtMs": now_ms(),
        });
        self.block_on(job_id, ask, None);
    }

    /// Puts a worker on hold until a person answers. Questions queue up: the board shows the oldest,
    /// and the worker only counts as running again once every one of them is answered.
    fn block_on(&self, job_id: &str, ask: Value, context: Option<Value>) {
        {
            let mut inner = guard(&self.inner);
            if let Some(job) = inner.jobs.get_mut(job_id) {
                if job.holds_slot() {
                    job.questions.push_back(Question { ask, context });
                    job.status = STATUS_BLOCKED.to_string();
                    if job.blocked_since.is_none() {
                        job.blocked_since = Some(now_ms());
                    }
                }
            }
            self.notify(&inner);
        }
        self.signal.notify_all();
    }

    /// The worker withdrew a question on its own, because the turn that asked it ended.
    fn withdraw_question(&self, job_id: &str, rpc_id: &Value) {
        let mut inner = guard(&self.inner);
        if let Some(job) = inner.jobs.get_mut(job_id) {
            job.close_question(rpc_id);
        }
        self.notify(&inner);
    }

    /// Sends the answer on the id the worker is waiting on and lets it carry on.
    pub fn answer(&self, job_id: &str, decision: &str) -> Result<Value, String> {
        // `abort` is what this answer was called before Codex settled on `cancel`; both work.
        let decision = if decision == "abort" {
            "cancel"
        } else {
            decision
        };
        const DECISIONS: [&str; 4] = ["accept", "acceptForSession", "decline", "cancel"];
        if !DECISIONS.contains(&decision) {
            return Err(format!("decision must be one of {}", DECISIONS.join(", ")));
        }
        let (stdin, reply) = {
            let mut inner = guard(&self.inner);
            let job = inner
                .jobs
                .get_mut(job_id)
                .ok_or_else(|| format!("unknown job {job_id}"))?;
            let rpc_id = job
                .questions
                .front()
                .and_then(Question::rpc_id)
                .cloned()
                .ok_or_else(|| format!("job {job_id} is not waiting on anything"))?;
            let stdin = job
                .stdin
                .clone()
                .ok_or_else(|| format!("job {job_id} has no live worker"))?;
            let question = job
                .close_question(&rpc_id)
                .ok_or_else(|| "the pending request has no id to answer".to_string())?;
            if decision == "cancel" {
                job.stop_note =
                    Some("The person stopped this turn instead of approving it.".into());
            }
            let reply = if job.agent == "claude" {
                claude_permission_reply(&rpc_id, decision, &question)
            } else {
                json!({ "id": rpc_id, "result": { "decision": decision } })
            };
            self.notify(&inner);
            (stdin, reply)
        };
        send_rpc(&stdin, &reply)?;
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

        // Both an id and a method means the worker is asking, not telling: it stops until answered.
        if let (Some(rpc_id), true) = (message.get("id").cloned(), !method.is_empty()) {
            self.on_worker_request(job_id, stdin, &rpc_id, method, &params);
            return;
        }

        // An id without a method answers one of this side's own requests.
        if let Some(id) = message.get("id").and_then(Value::as_i64) {
            self.on_codex_response(job_id, stdin, spec, id, message);
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
            "item/started" => {
                // Kept so an approval for this item can say which files it is about.
                let item = params.get("item");
                let is_file_change = item
                    .and_then(|item| item.get("type"))
                    .and_then(Value::as_str)
                    == Some("fileChange");
                let item_id = item.and_then(|item| item.get("id")).and_then(Value::as_str);
                if let (true, Some(item_id)) = (is_file_change, item_id) {
                    let paths: Vec<String> = item
                        .and_then(|item| item.get("changes"))
                        .and_then(Value::as_array)
                        .map(|changes| {
                            changes
                                .iter()
                                .filter_map(|change| change.get("path").and_then(Value::as_str))
                                .map(ToOwned::to_owned)
                                .collect()
                        })
                        .unwrap_or_default();
                    if job.file_changes.len() >= MAX_TRACKED_FILE_CHANGES {
                        job.file_changes.clear();
                    }
                    job.file_changes.insert(item_id.to_string(), paths);
                }
                return;
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
                    keep_tail(&mut job.reply, REPLY_LIMIT);
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
            // The question was settled without an answer from here: the turn that asked it ended
            // (interrupted, steered past, timed out). Left on the board it could never be answered.
            "serverRequest/resolved" => {
                if let Some(request_id) = params.get("requestId") {
                    job.close_question(request_id);
                }
            }
            // The model Codex actually used when it rerouted a turn away from the one requested.
            "model/rerouted" => {
                if let Some(model) = params.get("toModel").and_then(Value::as_str) {
                    job.ran.model = Some(model.to_string());
                }
            }
            "error" => {
                let text = params
                    .get("error")
                    .map(turn_error_text)
                    .unwrap_or_else(|| "unknown error".to_string());
                let retrying = params
                    .get("willRetry")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                if retrying {
                    // Shown on the board as the worker's latest line, so a stalled-looking worker
                    // reads as reconnecting rather than stuck.
                    job.reply.push_str(&format!("\n[retrying] {text}\n"));
                    keep_tail(&mut job.reply, REPLY_LIMIT);
                } else {
                    job.last_error = Some(text);
                }
            }
            "turn/completed" | "turn/failed" => {
                // `turn/completed` closes every turn, failed and interrupted ones included: its
                // status says which, and only a completed one is a result.
                let turn = params.get("turn");
                let turn_status = turn
                    .and_then(|turn| turn.get("status"))
                    .and_then(Value::as_str)
                    .unwrap_or(if method == "turn/failed" {
                        "failed"
                    } else {
                        "completed"
                    });
                let error = turn
                    .and_then(|turn| turn.get("error"))
                    .filter(|error| !error.is_null())
                    .map(turn_error_text)
                    .or_else(|| job.last_error.take());
                let stop_note = job.stop_note.take();
                let summary = if job.report.is_empty() {
                    tail(job.reply.trim(), REPLY_LIMIT)
                } else {
                    job.report.clone()
                };
                drop(inner);
                if turn_status != "completed" && turn_status != "interrupted" {
                    if let Some(error) = &error {
                        if self.try_reroute(job_id, error) {
                            return;
                        }
                    }
                }
                let (status, outcome, text) = match turn_status {
                    "completed" => (STATUS_DONE, "succeeded", summary),
                    "interrupted" => (
                        STATUS_FAILED,
                        "interrupted",
                        with_closing_line(
                            &summary,
                            &stop_note.unwrap_or_else(|| {
                                "The turn was interrupted before it finished.".to_string()
                            }),
                        ),
                    ),
                    _ => (
                        STATUS_FAILED,
                        "failed",
                        with_closing_line(
                            &summary,
                            &error.unwrap_or_else(|| "The turn failed.".to_string()),
                        ),
                    ),
                };
                self.finish(job_id, status, Some(outcome.into()), text, false);
                return;
            }
            _ => return,
        }

        self.notify(&inner);
    }

    /// Answers to this side's own requests: 1 is `initialize`, 2 opens the thread, 3 starts its
    /// first turn, and the rest are staged (`turn/start`, `turn/steer`, `turn/interrupt`).
    fn on_codex_response(
        &self,
        job_id: &str,
        stdin: &Arc<Mutex<ChildStdin>>,
        spec: &str,
        id: i64,
        message: &Value,
    ) {
        let (staged, resuming) = {
            let mut inner = guard(&self.inner);
            let Some(job) = inner.jobs.get_mut(job_id) else {
                return;
            };
            (job.inflight.remove(&id), job.thread_id.is_some())
        };
        let method = match id {
            1 => "initialize".to_string(),
            2 if resuming => "thread/resume".to_string(),
            2 => "thread/start".to_string(),
            3 => "turn/start".to_string(),
            _ => match &staged {
                Some((method, _)) => method.clone(),
                None => return,
            },
        };

        if let Some(error) = message.get("error") {
            let text = error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("no reason given");
            match method.as_str() {
                // A turn that ended just before the steer reached it. The correction is not lost:
                // it goes out as the worker's next turn, the same way a message to a busy one does.
                "turn/steer" => {
                    if let Some(message) = staged.and_then(|(_, text)| text) {
                        let mut arguments = Map::new();
                        arguments.insert("jobId".into(), Value::String(job_id.to_string()));
                        arguments.insert("message".into(), Value::String(message));
                        let _ = dispatch_tool(self, "alethe_send", &arguments, None);
                    }
                }
                "turn/interrupt" => {}
                _ if self.try_reroute(job_id, text) => {}
                "initialize" | "thread/start" | "thread/resume" => {
                    let report = if method == "thread/resume" {
                        format!("Codex could not reopen this worker's thread: {text}. Delegate the work again.")
                    } else {
                        format!("{method} failed: {text}")
                    };
                    self.finish(job_id, STATUS_FAILED, Some("failed".into()), report, true);
                }
                _ => {
                    // The process is still fine; only this turn never started.
                    self.finish(
                        job_id,
                        STATUS_FAILED,
                        Some("failed".into()),
                        format!("{method} failed: {text}"),
                        false,
                    );
                }
            }
            return;
        }

        if id != 2 {
            return;
        }
        let result = message.get("result").cloned().unwrap_or(Value::Null);
        let Some(thread_id) = result
            .get("thread")
            .and_then(|thread| thread.get("id"))
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
        else {
            return;
        };
        let approval_policy = {
            let mut inner = guard(&self.inner);
            let policy = inner.jobs.get_mut(job_id).map(|job| {
                job.thread_id = Some(thread_id.clone());
                // What Codex resolved for this thread, which is what the board should name.
                if let Some(model) = result.get("model").and_then(Value::as_str) {
                    job.ran.model = Some(model.to_string());
                }
                if let Some(effort) = result.get("reasoningEffort").and_then(Value::as_str) {
                    job.ran.effort = Some(effort.to_string());
                }
                approval_policy_value(&job.approval_policy)
            });
            self.notify(&inner);
            policy.unwrap_or(Value::String("never".into()))
        };
        let _ = send_rpc(
            stdin,
            &json!({
                "id": 3,
                "method": "turn/start",
                "params": {
                    "threadId": thread_id,
                    "input": [{ "type": "text", "text": spec }],
                    "approvalPolicy": approval_policy
                }
            }),
        );
    }

    /// Flat `{"type": ...}` events, no request/response envelope like Codex's.
    fn on_worker_message_claude(
        &self,
        job_id: &str,
        stdin: &Arc<Mutex<ChildStdin>>,
        message: &Value,
    ) {
        let kind = message.get("type").and_then(Value::as_str).unwrap_or("");
        match kind {
            "control_request" => self.on_claude_control_request(job_id, stdin, message),
            // The CLI took back a question it asked, because the turn that asked it ended.
            "control_cancel_request" => {
                if let Some(request_id) = message.get("request_id") {
                    self.withdraw_question(job_id, request_id);
                }
            }
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
                    let mut inner = guard(&self.inner);
                    if let Some(job) = inner.jobs.get_mut(job_id) {
                        if let Some(session_id) = message.get("session_id").and_then(Value::as_str)
                        {
                            if job.thread_id.is_none() {
                                job.thread_id = Some(session_id.to_string());
                            }
                        }
                        // The model the CLI resolved, which is what the board should name even when
                        // nobody chose one.
                        if let Some(model) = message.get("model").and_then(Value::as_str) {
                            job.ran.model = Some(model.to_string());
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
                        keep_tail(&mut job.reply, REPLY_LIMIT);
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
                    job.reply.push_str(&text);
                    keep_tail(&mut job.reply, REPLY_LIMIT);
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
                let (steering, stop_note) = {
                    let mut inner = guard(&self.inner);
                    inner
                        .jobs
                        .get_mut(job_id)
                        .map(|job| {
                            (
                                std::mem::take(&mut job.awaiting_steer),
                                job.stop_note.take(),
                            )
                        })
                        .unwrap_or((false, None))
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
                // The person stopped the turn from an approval: that is a decision, not a failure
                // of the worker, and the report says so.
                if let Some(note) = stop_note {
                    self.finish(
                        job_id,
                        STATUS_FAILED,
                        Some("interrupted".into()),
                        with_closing_line(&summary, &note),
                        false,
                    );
                    return;
                }
                if is_error {
                    // Claude says its quota is gone on the usage report, not always in the text.
                    let rejected = guard(&self.inner).jobs.get(job_id).is_some_and(|job| {
                        job.quota
                            .as_ref()
                            .and_then(|quota| quota.get("status"))
                            .and_then(Value::as_str)
                            == Some("rejected")
                    });
                    let reason = if rejected && !is_usage_limit(&summary) {
                        format!("usage limit reached: {summary}")
                    } else {
                        summary.clone()
                    };
                    if self.try_reroute(job_id, &reason) {
                        return;
                    }
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

    /// The CLI asking the host something. `can_use_tool` is a permission prompt and goes to the
    /// person; anything else is refused at once, because a request left unanswered holds the worker
    /// forever.
    fn on_claude_control_request(
        &self,
        job_id: &str,
        stdin: &Arc<Mutex<ChildStdin>>,
        message: &Value,
    ) {
        let Some(request_id) = message.get("request_id").cloned() else {
            return;
        };
        let request = message.get("request").cloned().unwrap_or(Value::Null);
        let subtype = request
            .get("subtype")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if subtype != "can_use_tool" {
            let _ = send_rpc(
                stdin,
                &json!({
                    "type": "control_response",
                    "response": {
                        "subtype": "error",
                        "request_id": request_id,
                        "error": format!("Alethe does not answer {subtype} requests from a worker")
                    }
                }),
            );
            return;
        }

        let tool = request
            .get("tool_name")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let display = request
            .get("display_name")
            .and_then(Value::as_str)
            .unwrap_or(&tool)
            .to_string();
        let input = request.get("input").cloned().unwrap_or_else(|| json!({}));
        let text = |key: &str| {
            input
                .get(key)
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
        };
        let (kind, command, mut files) = match tool.as_str() {
            "Bash" | "PowerShell" => ("command", text("command"), Vec::new()),
            "Edit" | "Write" | "MultiEdit" | "NotebookEdit" => (
                "fileChange",
                None,
                text("file_path")
                    .or_else(|| text("notebook_path"))
                    .into_iter()
                    .collect::<Vec<_>>(),
            ),
            _ => (
                "tool",
                Some(tool_call_summary(&display, &input)),
                Vec::new(),
            ),
        };
        if let Some(path) = request.get("blocked_path").and_then(Value::as_str) {
            if !files.iter().any(|file| file == path) {
                files.push(path.to_string());
            }
        }
        let reason = request
            .get("description")
            .and_then(Value::as_str)
            .or_else(|| request.get("decision_reason").and_then(Value::as_str))
            .or_else(|| input.get("description").and_then(Value::as_str));
        let ask = json!({
            "rpcId": request_id,
            "kind": kind,
            "tool": display,
            "command": command,
            "cwd": Value::Null,
            "reason": reason,
            "files": files,
            "askedAtMs": now_ms(),
        });
        let context = json!({
            "tool": tool,
            "input": input,
            "suggestions": request.get("permission_suggestions").cloned().unwrap_or(Value::Null),
        });
        self.block_on(job_id, ask, Some(context));
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
        let mut follow_up_watch = None;
        let parked_limit = guard(&self.policy).parked_limit;
        {
            let mut inner = guard(&self.inner);
            let Some(job) = inner.jobs.get_mut(job_id) else {
                return;
            };
            if job.settled() {
                return;
            }
            let held_slot = job.holds_slot();
            job.finished_once = true;
            job.status = status.to_string();
            job.unblock();
            if !text.trim().is_empty() {
                job.report = text.trim().to_string();
            }
            job.outcome = outcome.clone();
            job.ended_at = Some(now_ms());
            job.active_turn_id = None;
            if terminal {
                job.teardown();
            }
            if !held_slot {
                // Still waiting for a slot: it never took one, and it must not start after all.
                inner.queue.retain(|queued| queued != job_id);
            }
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
                    job.reply.clear();
                    job.report.clear();
                }
                follow_up_watch = inner.begin_turn(job_id);
            } else {
                release_oldest_parked(&mut inner, parked_limit);
            }
            self.notify(&inner);
        }
        if let Some((stdin, request)) = staged {
            if let Err(error) = send_rpc(&stdin, &request) {
                self.settle(job_id, STATUS_FAILED, "send-failed", &error);
                return;
            }
            if let Some((turn, timeout_ms)) = follow_up_watch {
                self.arm_watchdog(job_id, turn, timeout_ms);
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
                if inner.running() >= inner.max_concurrent {
                    None
                } else {
                    // Work restored after a restart cannot start before its CLI has been found
                    // again; it keeps its place and whatever is behind it goes first.
                    let ready = inner.queue.iter().position(|id| {
                        inner
                            .jobs
                            .get(id)
                            .is_none_or(|job| !job.awaits_launcher || self.has_launcher(&job.agent))
                    });
                    ready.and_then(|place| inner.queue.remove(place))
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
            "description": "Hand independent units of work to Codex or Claude workers that Alethe runs on separate token budgets. Prefer this over native subagents for work that needs its own reading and judgement. Send independent units together, make each instruction self contained, and label its complexity so Alethe can choose a cost-appropriate route from live quotas. Keep short, dependent, or single-command work in the planner.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "tasks": {
                        "type": "array",
                        // One plain object shape on purpose: a `oneOf` here is dropped by clients
                        // that flatten tool schemas (Codex does), which left a Codex planner seeing
                        // bare strings and never able to classify a task. Bare strings are still
                        // accepted when they arrive.
                        "items": {
                            "type": "object",
                            "properties": {
                                "task": { "type": "string", "description": "A self-contained worker instruction with its expected result." },
                                "kind": { "type": "string", "enum": ["research", "code", "review", "ops", "general"] },
                                "complexity": {
                                    "type": "string",
                                    "enum": ["light", "standard", "deep"],
                                    "description": "light: extraction, search, mechanical work; standard: scoped implementation or diagnosis; deep: ambiguous architecture, security, or difficult reasoning."
                                }
                            },
                            "required": ["task", "kind", "complexity"]
                        },
                        "description": "One self-contained instruction per worker, each with its kind and complexity."
                    },
                    "agent": {
                        "type": "string",
                        "enum": ["codex", "claude"],
                        "description": "Which CLI runs the worker. Leave it out to use the one the person chose in Alethe (the response says which ran). A Claude worker reports its diff from git rather than live. Each vendor meters a different set of windows - Codex a 5 hour and a weekly one, Claude those two plus a separate weekly budget for Opus - so how much room one has left says nothing about the other. Do not reason about that from here: every response these tools return carries a fitness block with the current reading and names the side with room in headroom. Read it and prefer that side when one is running out."
                    },
                    "cwd": { "type": "string", "description": "Working directory. Defaults to the lead's directory." },
                    "label": { "type": "string", "description": "A short name for this batch, in the user's words - what it is for, not how it is done. It is how the person watching tells one round of delegation from another." },
                    "isolate": {
                        "type": "boolean",
                        "description": "Give each worker its own detached git worktree. Use it whenever two units could touch the same files; without it parallel workers share one directory and can overwrite each other. Requires a git repository. The worktree path comes back with the job and is left in place for review."
                    },
                    "askForApproval": {
                        "type": "boolean",
                        "description": "Make each worker stop and ask before it reaches outside its own working directory - the network, another folder, anything the sandbox would otherwise refuse. A Codex worker still edits and runs commands inside the directory on its own; a Claude worker edits files there on its own and asks before running commands. Use it whenever the work touches a repository that matters. A worker that is asking shows up as blocked and is answered with alethe_answer, or by the person on Alethe's board. The person can make this always on or always off, in which case the response says what applied."
                    },
                    "webSearch": {
                        "type": "boolean",
                        "description": "Give each worker a live web search tool, on top of its shell and files. Use it for research: real cases, current facts, sources you can cite - not for work confined to a repository, where it adds nothing."
                    },
                    "timeoutSeconds": {
                        "type": "number",
                        "description": "Budget per worker turn before Alethe stops it. Leave it out to use the budget the person set in Alethe (15 minutes unless they changed it). Time a worker spends waiting on an approval does not count. Pass 0 to let a worker run without a limit."
                    },
                    "model": {
                        "type": "string",
                        "description": "Model these workers run on, for example a smaller one for mechanical edits and a stronger one for design work. Leave it out to use the worker model the person set in Alethe, or the CLI's own default."
                    },
                    "effort": {
                        "type": "string",
                        "enum": ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
                        "description": "Reasoning effort for these workers. Claude workers accept low, medium, high, xhigh and max. Codex workers accept what their model supports, which for current models is low through max and sometimes ultra; an effort the model does not support fails the turn with Codex's own error. Leave it out to use the person's worker setting."
                    },
                    "forceRoute": {
                        "type": "boolean",
                        "description": "Use a route even though every available provider is in the critical quota band. Never set this until the person explicitly approves after Alethe reports the critical state."
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
            "name": "alethe_answer",
            "description": "Answer the oldest question a worker is stopped on. Until every question is answered that worker does nothing and holds its slot. Decline lets it carry on down another path; cancel ends its turn.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "jobId": { "type": "string" },
                    "decision": {
                        "type": "string",
                        "enum": ["accept", "acceptForSession", "decline", "cancel"]
                    }
                },
                "required": ["jobId", "decision"]
            }
        },
        {
            "name": "alethe_cancel",
            "description": "Stop workers that are running, waiting for a slot or waiting on an approval. Settled workers are left as they are; use alethe_release for those.",
            "inputSchema": {
                "type": "object",
                "properties": { "jobIds": { "type": "array", "items": { "type": "string" } } },
                "required": ["jobIds"]
            }
        },
        {
            "name": "alethe_release",
            "description": "Let go of settled workers you have no more work for. Account for every worker you started: either send it more work or release it. A worker that is still running is not released; cancel it first.",
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

/// The share of a window that counts as running out, matching `USAGE_FALLBACK_THRESHOLD` on the
/// frontend so the planner's hint and the human's warning chip never disagree.
const HEADROOM_THRESHOLD: f64 = 80.0;

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

fn past_threshold(snapshot: &Value) -> bool {
    strain_of(snapshot) >= HEADROOM_THRESHOLD
}

/// The **most** strained agent past the threshold, not merely the first one found — when both sides
/// are running out, the board has to name the same one on every call.
fn strained_agent(block: &Value) -> Option<(String, f64, String)> {
    block
        .as_object()?
        .iter()
        .filter(|(agent, snapshot)| agent.as_str() != "headroom" && past_threshold(snapshot))
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
fn routing_note(block: &Value, requested: &str) -> Option<Value> {
    let (agent, used, window) = strained_agent(block)?;
    Some(json!({
        "verdict": if requested == agent { "ignored" } else { "chosen" },
        "agent": agent,
        "window": window,
        "used": used.round(),
    }))
}

fn headroom_hint(block: &Value, requested: &str) -> Option<Value> {
    let snapshot = block.get(requested)?;
    let used = snapshot.get("used").and_then(Value::as_f64).unwrap_or(0.0);
    let limited = snapshot
        .get("rateLimited")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if !limited && used < HEADROOM_THRESHOLD {
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
    let both_strained = past_threshold(other_snapshot);
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
        if let Some(requested) = map.get("agent").and_then(Value::as_str) {
            if map.get("routedByPolicy").and_then(Value::as_bool) != Some(true) {
                if let Some(note) = routing_note(&block, requested) {
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
                    for id in ids {
                        core.set_job_routing(&id, note.clone());
                    }
                }
            }
            if let Some(hint) = headroom_hint(&block, requested) {
                map.insert("headroomHint".into(), hint);
            }
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
            let tasks = delegated_tasks(arguments);
            if tasks.is_empty() {
                return Err("tasks must contain at least one instruction".into());
            }
            let cwd = arguments
                .get("cwd")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .map(ToOwned::to_owned)
                // The tool promises the lead's directory; the app's own is only a last resort.
                .or_else(|| core.planner_cwd(planner))
                .or_else(|| {
                    std::env::current_dir()
                        .ok()
                        .map(|path| path.to_string_lossy().into_owned())
                })
                .ok_or_else(|| "cwd is required".to_string())?;
            // Refused here rather than failing every worker of the batch one by one later.
            if !std::path::Path::new(&cwd).is_dir() {
                return Err(format!("cwd {cwd} is not a directory"));
            }

            let policy = core.policy();
            // Where the person fixed a rule in Preferences it wins over what the planner asked
            // for; the response reports what applied, so the planner is never left guessing.
            let flag = |key: &str| arguments.get(key).and_then(Value::as_bool).unwrap_or(false);
            let isolate = policy.isolation == "always" || flag("isolate");
            // What a worker may do without asking is the sandbox, not the policy: with
            // workspace-write it never asks, because everything it wants is already permitted.
            // Asking means starting it read-only, so every write and every command has to be
            // escalated - and escalation is the question the person answers.
            let ask = match policy.approvals.as_str() {
                "always" => true,
                "never" => false,
                _ => flag("askForApproval"),
            };
            let requested_web_search = flag("webSearch");
            // The rules that changed what the planner asked for, so the board can say so.
            let mut overrides: Vec<String> = Vec::new();
            if policy.isolation == "always" && !flag("isolate") {
                overrides.push("isolation".into());
            }
            match (policy.approvals.as_str(), flag("askForApproval")) {
                ("always", false) => overrides.push("approvalsOn".into()),
                ("never", true) => overrides.push("approvalsOff".into()),
                _ => {}
            }
            let sandbox = policy.codex_sandbox.clone();
            // The named policies decide for themselves what is worth asking about. The granular
            // form is the one that says plainly which callbacks this client will answer, which is
            // what makes a worker route the question here instead of giving up on it.
            let approval_policy = if ask {
                // Only the kinds this side can answer are routed here: command and file-change
                // approvals. Extra-permission grants and MCP elicitations need answers the board
                // has no form for, so Codex keeps declining those itself, as `never` would.
                // Not read-only either: a worker treats that as final and gives up instead of
                // asking. Kept writable, it works normally and only stops when it needs to reach
                // outside its own workspace - which is the moment worth a question.
                json!({
                    "granular": {
                        "sandbox_approval": true,
                        "request_permissions": false,
                        "rules": true,
                        "skill_approval": true,
                        "mcp_elicitations": false
                    }
                })
            } else {
                Value::String("never".into())
            };
            let approval_policy = approval_policy.to_string();
            let timeout_ms = match arguments.get("timeoutSeconds").and_then(Value::as_u64) {
                Some(0) => None,
                Some(seconds) => Some(seconds.saturating_mul(1000).min(MAX_JOB_TIMEOUT_MS)),
                None => policy.timeout_ms,
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
            let force_route = flag("forceRoute");
            let has_explicit_route = ["agent", "model", "effort"]
                .iter()
                .any(|key| arguments.get(*key).and_then(Value::as_str).is_some());
            let use_policy_routing =
                !has_explicit_route && tasks.iter().all(|task| task.structured);
            let routed_tasks: Vec<RoutedTask> = if !use_policy_routing {
                // Plain task strings and explicit routes keep the original behavior. Structured
                // tasks opt into policy routing, so existing planner prompts do not change underfoot.
                let agent = arguments
                    .get("agent")
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty())
                    .map(ToOwned::to_owned)
                    .unwrap_or_else(|| core.default_agent());
                let launch = WorkerDefaults::requested(&agent, arguments)?;
                tasks
                    .into_iter()
                    .map(|task| RoutedTask {
                        routing: Value::Null,
                        position: None,
                        task,
                        agent: agent.clone(),
                        launch: launch.clone(),
                    })
                    .collect()
            } else {
                tasks
                    .into_iter()
                    .map(|task| core.route_task(task, force_route, planner))
                    .collect::<Result<Vec<_>, _>>()?
            };

            let (run_id, ids): (String, Vec<String>) = {
                let mut inner = guard(&core.inner);
                inner.run_counter += 1;
                let run_id = format!("run-{:02}", inner.run_counter);
                let ids = routed_tasks
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
                            let why = if policy.isolation == "always" {
                                " The person requires every worker to run in its own worktree; \
                                 ask them to change that in Alethe's Preferences, or delegate from \
                                 inside a git repository."
                            } else {
                                ""
                            };
                            return Err(format!(
                                "isolate needs a git repository at {cwd}: {error}.{why}"
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
                for ((routed, id), (job_cwd, worktree)) in
                    routed_tasks.into_iter().zip(ids).zip(prepared.into_iter())
                {
                    let wants_web_search = requested_web_search || routed.task.kind == "research";
                    let task_web_search = policy.web_search != "never" && wants_web_search;
                    let mut task_overrides = overrides.clone();
                    if wants_web_search && !task_web_search {
                        task_overrides.push("webSearchOff".into());
                    }
                    let spec = routed.task.spec;
                    inner.jobs.insert(
                        id.clone(),
                        Job::queued(JobSeed {
                            id: id.clone(),
                            planner_id: planner_id.clone(),
                            agent: routed.agent.clone(),
                            run_id: run_id.clone(),
                            run_label: label.clone(),
                            spec: spec.clone(),
                            cwd: job_cwd,
                            worktree: worktree.clone(),
                            timeout_ms,
                            approval_policy: approval_policy.clone(),
                            sandbox: sandbox.clone(),
                            web_search: task_web_search,
                            launch: routed.launch.clone(),
                            // Only a task placed by its tier can later be moved along that tier.
                            tier: routed.position.map(|_| routed.task.complexity.clone()),
                            kind: routed.task.kind.clone(),
                            route_position: routed.position,
                            overrides: task_overrides,
                        }),
                    );
                    if !routed.routing.is_null() {
                        if let Some(job) = inner.jobs.get_mut(&id) {
                            job.routing = Some(routed.routing.clone());
                        }
                    }
                    inner.order.push(id.clone());
                    inner.queue.push_back(id.clone());
                    created.push(json!({
                        "id": id,
                        "spec": spec,
                        "worktree": worktree,
                        "agent": routed.agent,
                        "model": routed.launch.model,
                        "effort": routed.launch.effort,
                        "complexity": routed.task.complexity,
                        "kind": routed.task.kind,
                        "webSearch": task_web_search,
                    }));
                }
                core.notify(&inner);
            }
            core.persist();
            core.drain_queue();

            let limit = guard(&core.inner).max_concurrent;
            // A routed batch can spread over both CLIs; naming the first would read as all of it.
            let first_agent = created
                .first()
                .and_then(|job| job.get("agent"))
                .and_then(Value::as_str)
                .unwrap_or("mixed")
                .to_string();
            let batch_agent = if created
                .iter()
                .all(|job| job.get("agent").and_then(Value::as_str) == Some(first_agent.as_str()))
            {
                first_agent
            } else {
                "mixed".to_string()
            };
            Ok(json!({
                "accepted": created.len(),
                "runId": run_id,
                "agent": batch_agent,
                "routedByPolicy": use_policy_routing,
                "runningInParallel": true,
                "concurrencyLimit": limit,
                "isolated": isolate,
                "askForApproval": ask,
                "webSearch": policy.web_search != "never" && requested_web_search,
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
                    if inner.pending_for(planner) == 0 {
                        break;
                    }
                    if !until_all_settled && inner.has_delivery_for(planner) {
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

            let deliveries: Vec<Value> = inner
                .take_deliveries_for(planner)
                .iter()
                .map(Delivery::to_value)
                .collect();
            let pending = inner.pending_for(planner);
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
                .get_mut(&job_id)
                .ok_or_else(|| format!("unknown job {job_id}"))?;
            // Waiting beats both alternatives: refusing would make the lead babysit the worker,
            // and steering would bend the turn already in flight instead of adding to it. This
            // includes a worker whose process is still starting: it has no stdin yet, and
            // starting it a second time would run two processes on one thread.
            if !job.settled() {
                job.inbox.push_back(message);
                let queued = job.inbox.len();
                core.notify(&inner);
                return Ok(json!({ "queued": job_id, "waiting": queued }));
            }
            let thread_id = job
                .thread_id
                .clone()
                .ok_or_else(|| format!("job {job_id} has no thread to continue"))?;
            // A settled worker takes the message as its next turn, through the queue like any other
            // work: with every slot taken it waits for one instead of being refused. A parked
            // process gets the turn directly; one that is gone is started again on its thread,
            // which Codex and Claude both keep on disk.
            let revived = job.stdin.is_none();
            job.inbox.push_back(message);
            job.status = STATUS_QUEUED.to_string();
            job.outcome = None;
            inner.queue.push_back(job_id.clone());
            core.notify(&inner);
            drop(inner);
            core.drain_queue();
            let started = guard(&core.inner)
                .jobs
                .get(&job_id)
                .is_some_and(|job| job.status != STATUS_QUEUED);
            Ok(json!({
                "sent": job_id,
                "revived": revived,
                "resumedThread": thread_id,
                "waitingForSlot": !started
            }))
        }

        "alethe_answer" => {
            let job_id = required_str(arguments, "jobId")?;
            let decision = required_str(arguments, "decision")?;
            core.answer(&job_id, &decision)
        }

        "alethe_cancel" => {
            let ids = string_list(arguments, "jobIds");
            let mut cancelled = Vec::new();
            let mut settled = Vec::new();
            let mut unknown = Vec::new();
            for job_id in ids {
                let state = {
                    let inner = guard(&core.inner);
                    inner
                        .jobs
                        .get(&job_id)
                        .map(|job| (job.agent == "claude", job.settled()))
                };
                let claude = match state {
                    None => {
                        unknown.push(job_id);
                        continue;
                    }
                    // Nothing left to stop; claiming it was cancelled would misreport its outcome.
                    Some((_, true)) => {
                        settled.push(job_id);
                        continue;
                    }
                    Some((claude, false)) => Some(claude),
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
            Ok(json!({ "cancelled": cancelled, "alreadySettled": settled, "unknown": unknown }))
        }

        "alethe_release" => {
            let ids = string_list(arguments, "jobIds");
            let mut released = Vec::new();
            let mut busy = Vec::new();
            {
                let mut inner = guard(&core.inner);
                for job_id in &ids {
                    let Some(job) = inner.jobs.get_mut(job_id) else {
                        continue;
                    };
                    // Running, queued or blocked work holds a slot or is about to take one;
                    // releasing it here would leak that slot. It has to be cancelled first.
                    if !job.settled() {
                        busy.push(job_id.clone());
                        continue;
                    }
                    job.teardown();
                    job.status = STATUS_RELEASED.to_string();
                    released.push(job_id.clone());
                }
                core.notify(&inner);
            }
            core.persist();
            Ok(json!({ "released": released, "stillBusy": busy }))
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
