//! Drives the delegation core through the same MCP entry point Claude Code uses.
//!
//! The core is compiled directly rather than linked from `alethe_lib`: a Rust test binary carries
//! no application manifest, so linking the GUI stack makes it fail to start on Windows.
//!
//! Worker tests spawn real Codex processes and are ignored by default:
//! `cargo test --test orchestrator -- --ignored --test-threads=1`

#[path = "../src/orchestrator_core.rs"]
mod orchestrator_core;

use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde_json::{json, Value};

use orchestrator_core::{handle_mcp_body, Core, Launcher};

fn rpc(core: &Core, id: u32, method: &str, params: Value) -> Value {
    let body = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
    let raw = handle_mcp_body(core, &body.to_string(), None).expect("a response");
    serde_json::from_str(&raw).expect("valid json")
}

fn call(core: &Core, name: &str, arguments: Value) -> Value {
    let response = rpc(
        core,
        10,
        "tools/call",
        json!({ "name": name, "arguments": arguments }),
    );
    let text = response["result"]["content"][0]["text"]
        .as_str()
        .expect("tool text")
        .to_string();
    if response["result"]["isError"] == json!(true) {
        return json!({ "error": text });
    }
    serde_json::from_str(&text).unwrap_or_else(|_| json!({ "raw": text }))
}

fn codex_launcher() -> Launcher {
    let output = Command::new("where")
        .arg("codex")
        .output()
        .expect("where codex");
    let found = String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .find(|line| line.to_ascii_lowercase().ends_with(".cmd"))
        .map(ToOwned::to_owned)
        .expect("codex on PATH");
    Launcher::codex_app_server(PathBuf::from(found))
}

fn workspace(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("alethe-orch-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("workspace");
    dir
}

struct PeakWatcher {
    peak: Arc<Mutex<usize>>,
    stop: Arc<Mutex<bool>>,
    handle: Option<thread::JoinHandle<()>>,
}

impl PeakWatcher {
    fn start(core: Core) -> Self {
        let peak = Arc::new(Mutex::new(0usize));
        let stop = Arc::new(Mutex::new(false));
        let sampled = Arc::clone(&peak);
        let stopped = Arc::clone(&stop);
        let handle = thread::spawn(move || loop {
            let (running, _) = core.counts();
            {
                let mut peak = sampled.lock().expect("peak");
                *peak = (*peak).max(running);
            }
            if *stopped.lock().expect("stop") {
                break;
            }
            thread::sleep(Duration::from_millis(50));
        });
        Self {
            peak,
            stop,
            handle: Some(handle),
        }
    }

    fn finish(mut self) -> usize {
        *self.stop.lock().expect("stop") = true;
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
        let peak = *self.peak.lock().expect("peak");
        peak
    }
}

#[test]
fn the_handshake_advertises_every_tool() {
    let core = Core::default();
    let initialized = rpc(&core, 1, "initialize", json!({}));
    assert_eq!(initialized["result"]["serverInfo"]["name"], json!("alethe"));

    let listed = rpc(&core, 2, "tools/list", json!({}));
    let names: Vec<&str> = listed["result"]["tools"]
        .as_array()
        .expect("tools")
        .iter()
        .map(|tool| tool["name"].as_str().expect("name"))
        .collect();

    for expected in [
        "alethe_delegate",
        "alethe_check",
        "alethe_status",
        "alethe_steer",
        "alethe_send",
        "alethe_cancel",
        "alethe_release",
        "alethe_diff",
    ] {
        assert!(names.contains(&expected), "missing {expected} in {names:?}");
    }
}

#[test]
fn a_notification_gets_no_response_body() {
    let core = Core::default();
    let body = r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#;
    assert!(handle_mcp_body(&core, body, None).is_none());
}

#[test]
fn history_outlives_the_process_and_in_flight_work_is_not_reported_as_running() {
    let dir = workspace("persist");
    let store = dir.join("orchestrator-jobs.json");

    let first = Core::default();
    first.set_store(store.clone());
    first.set_launcher(silent_launcher());
    call(
        &first,
        "alethe_delegate",
        json!({ "tasks": ["keep this"], "cwd": dir.to_string_lossy(), "label": "a run" }),
    );
    std::thread::sleep(std::time::Duration::from_millis(300));
    assert!(store.exists(), "the store must be written as work is created");

    let second = Core::default();
    second.set_store(store);
    second.restore();
    let jobs = second.snapshot();
    let jobs = jobs["jobs"].as_array().expect("jobs");
    assert_eq!(jobs.len(), 1, "the record survives a new process");
    assert_eq!(jobs[0]["spec"], "keep this");
    assert_eq!(jobs[0]["runLabel"], "a run");
    assert_eq!(
        jobs[0]["status"], "interrupted",
        "a worker whose process is gone must not be shown as running"
    );
    assert_eq!(
        second.snapshot()["running"], 0,
        "restored work holds no slot"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_new_id_never_collides_with_a_restored_one() {
    let dir = workspace("persist-ids");
    let store = dir.join("orchestrator-jobs.json");

    let first = Core::default();
    first.set_store(store.clone());
    first.set_launcher(silent_launcher());
    call(
        &first,
        "alethe_delegate",
        json!({ "tasks": ["one", "two"], "cwd": dir.to_string_lossy() }),
    );
    std::thread::sleep(std::time::Duration::from_millis(300));

    let second = Core::default();
    second.set_store(store);
    second.restore();
    second.set_launcher(silent_launcher());
    let created = call(
        &second,
        "alethe_delegate",
        json!({ "tasks": ["three"], "cwd": dir.to_string_lossy() }),
    );
    let id = created["jobs"][0]["id"].as_str().expect("an id");
    assert_eq!(id, "job-03", "counting resumes past the restored ids");

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_settled_worker_reports_its_own_outcome() {
    let dir = workspace("report");
    let core = Core::default();
    core.set_launcher(silent_launcher());
    call(
        &core,
        "alethe_delegate",
        json!({ "tasks": ["do the thing"], "cwd": dir.to_string_lossy(), "timeoutSeconds": 1 }),
    );
    // The fake worker never speaks, so the watchdog is what settles it. Even then the job must
    // carry a readable account of itself rather than falling back to the instruction it was given.
    std::thread::sleep(std::time::Duration::from_millis(2500));
    let snapshot = core.snapshot();
    let job = &snapshot["jobs"][0];
    assert_eq!(job["status"], "failed");
    let summary = job["summary"].as_str().unwrap_or_default();
    assert!(!summary.is_empty(), "a settled job must keep its report");
    assert_ne!(
        summary, "do the thing",
        "the report is what the worker said, never an echo of the task"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn the_handshake_offers_a_way_to_answer_a_blocked_worker() {
    let core = Core::default();
    let tools = rpc(&core, 1, "tools/list", json!({}));
    let names: Vec<&str> = tools["result"]["tools"]
        .as_array()
        .expect("tools")
        .iter()
        .filter_map(|tool| tool["name"].as_str())
        .collect();
    assert!(names.contains(&"alethe_answer"));

    let delegate = tools["result"]["tools"]
        .as_array()
        .expect("tools")
        .iter()
        .find(|tool| tool["name"] == "alethe_delegate")
        .expect("the delegate tool");
    assert!(
        delegate["inputSchema"]["properties"]["askForApproval"].is_object(),
        "delegation has to be able to ask for approval"
    );
}

#[test]
fn answering_is_refused_when_nothing_is_waiting() {
    let dir = workspace("answer");
    let core = Core::default();
    core.set_launcher(silent_launcher());
    call(
        &core,
        "alethe_delegate",
        json!({ "tasks": ["work"], "cwd": dir.to_string_lossy() }),
    );
    std::thread::sleep(std::time::Duration::from_millis(300));

    let refused = core.answer("job-01", "accept").expect_err("nothing to answer");
    assert!(refused.contains("not waiting"), "got: {refused}");

    let unknown = core.answer("job-99", "accept").expect_err("no such job");
    assert!(unknown.contains("unknown job"), "got: {unknown}");

    let bad = core.answer("job-01", "maybe").expect_err("not a decision");
    assert!(bad.contains("decision must be"), "got: {bad}");

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn delegating_nothing_is_an_error() {
    let core = Core::default();
    let result = call(&core, "alethe_delegate", json!({ "tasks": [] }));
    assert!(
        result["error"]
            .as_str()
            .unwrap_or_default()
            .contains("at least one"),
        "{result}"
    );
}

#[test]
fn steering_an_unknown_job_is_refused() {
    let core = Core::default();
    let result = call(
        &core,
        "alethe_steer",
        json!({ "jobId": "job-99", "message": "turn left" }),
    );
    assert!(
        result["error"]
            .as_str()
            .unwrap_or_default()
            .contains("unknown job"),
        "{result}"
    );
}

#[test]
fn checking_with_no_work_returns_at_once() {
    let core = Core::default();
    let result = call(&core, "alethe_check", json!({ "wait": true }));
    assert_eq!(result["workersStillBusy"], json!(0), "{result}");
    assert_eq!(result["deliveries"].as_array().expect("deliveries").len(), 0);
}

#[test]
fn a_job_fails_cleanly_when_no_launcher_is_configured() {
    let core = Core::default();
    let dir = workspace("nolauncher");
    let delegated = call(
        &core,
        "alethe_delegate",
        json!({ "cwd": dir.to_string_lossy(), "tasks": ["anything"] }),
    );
    assert_eq!(delegated["accepted"], json!(1), "{delegated}");

    let checked = call(&core, "alethe_check", json!({ "wait": true, "timeoutMs": 5000 }));
    let deliveries = checked["deliveries"].as_array().expect("deliveries");
    assert_eq!(deliveries.len(), 1, "{checked}");
    assert_eq!(deliveries[0]["outcome"], json!("failed"));
    assert!(
        deliveries[0]["text"]
            .as_str()
            .unwrap_or_default()
            .contains("launcher"),
        "{checked}"
    );
    assert_eq!(checked["workersStillBusy"], json!(0));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn the_observer_sees_every_state_change() {
    let core = Core::default();
    let seen = Arc::new(Mutex::new(Vec::<Value>::new()));
    let recorder = Arc::clone(&seen);
    core.set_observer(Arc::new(move |snapshot| {
        recorder.lock().expect("seen").push(snapshot);
    }));

    let dir = workspace("observer");
    call(
        &core,
        "alethe_delegate",
        json!({ "cwd": dir.to_string_lossy(), "tasks": ["anything"] }),
    );

    let snapshots = seen.lock().expect("seen");
    assert!(!snapshots.is_empty(), "the observer was never called");
    let last = snapshots.last().expect("a snapshot");
    assert!(last["jobs"].as_array().is_some_and(|jobs| !jobs.is_empty()));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
#[ignore = "spawns real codex workers"]
fn two_workers_overlap_and_check_waits_for_both() {
    let core = Core::default();
    core.set_launcher(codex_launcher());
    let dir = workspace("parallel");
    let watcher = PeakWatcher::start(core.clone());

    let delegated = call(
        &core,
        "alethe_delegate",
        json!({
            "cwd": dir.to_string_lossy(),
            "tasks": [
                "Create a file ALPHA.txt whose entire content is the word ALPHA.",
                "Create a file BETA.txt whose entire content is the word BETA."
            ]
        }),
    );
    assert_eq!(delegated["accepted"], json!(2), "{delegated}");

    let checked = call(
        &core,
        "alethe_check",
        json!({ "wait": true, "timeoutMs": 540000 }),
    );
    let peak = watcher.finish();

    assert_eq!(
        checked["workersStillBusy"],
        json!(0),
        "untilAllSettled returned early: {checked}"
    );
    assert_eq!(
        checked["deliveries"].as_array().expect("deliveries").len(),
        2,
        "both workers must land in one call: {checked}"
    );
    assert_eq!(peak, 2, "the workers never overlapped");
    assert!(dir.join("ALPHA.txt").exists(), "ALPHA.txt missing: {checked}");
    assert!(dir.join("BETA.txt").exists(), "BETA.txt missing: {checked}");

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
#[ignore = "spawns real codex workers"]
fn the_queue_never_breaches_the_concurrency_limit() {
    let core = Core::default();
    core.set_launcher(codex_launcher());
    core.set_concurrency_limit(2);
    let dir = workspace("queue");
    let watcher = PeakWatcher::start(core.clone());

    let tasks: Vec<String> = (1..=4)
        .map(|index| {
            format!("Create a file Q{index}.txt whose entire content is the number {index}.")
        })
        .collect();
    let delegated = call(
        &core,
        "alethe_delegate",
        json!({ "cwd": dir.to_string_lossy(), "tasks": tasks }),
    );
    assert_eq!(delegated["accepted"], json!(4), "{delegated}");

    let (running, queued) = core.counts();
    assert!(running <= 2, "started {running} workers over the limit");
    assert_eq!(queued, 2, "the remainder must queue");

    let checked = call(
        &core,
        "alethe_check",
        json!({ "wait": true, "timeoutMs": 600000 }),
    );
    let peak = watcher.finish();

    assert_eq!(peak, 2, "the limit was breached, peak was {peak}");
    assert_eq!(
        checked["deliveries"].as_array().expect("deliveries").len(),
        4,
        "every queued job must drain: {checked}"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

/// A worker that starts, holds its pipes open and never speaks the protocol. It exercises the
/// watchdog without spending a real Codex turn. Registered under the "codex" kind: `alethe_delegate`
/// defaults a job's agent to "codex" when the call does not name one, same as these tests do.
fn silent_launcher() -> Launcher {
    Launcher {
        kind: "codex".into(),
        program: PathBuf::from("cmd"),
        args: vec![
            "/c".into(),
            "ping".into(),
            "-n".into(),
            "60".into(),
            "127.0.0.1".into(),
        ],
        env: Vec::new(),
    }
}

/// Plays back a fixed Claude stream-json transcript instead of spawning the real CLI.
fn fake_claude_launcher(dir: &std::path::Path, transcript: &str) -> Launcher {
    let path = dir.join("transcript.jsonl");
    std::fs::write(&path, transcript).expect("write fake transcript");
    Launcher {
        kind: "claude".into(),
        program: PathBuf::from("cmd"),
        args: vec!["/c".into(), "type".into(), path.to_string_lossy().into_owned()],
        env: Vec::new(),
    }
}

#[test]
fn a_claude_worker_reports_its_result_and_tokens() {
    let dir = workspace("claude-worker");
    let core = Core::default();
    let transcript = concat!(
        r#"{"type":"system","subtype":"init","session_id":"fake-session-1"}"#, "\n",
        r#"{"type":"assistant","message":{"content":[{"type":"text","text":"working on it"}]}}"#, "\n",
        r#"{"type":"result","is_error":false,"result":"CLAUDE_DONE_OK","usage":{"input_tokens":3,"output_tokens":5}}"#, "\n",
    );
    core.set_launcher(fake_claude_launcher(&dir, transcript));

    call(
        &core,
        "alethe_delegate",
        json!({ "tasks": ["do something"], "cwd": dir.to_string_lossy(), "agent": "claude" }),
    );
    std::thread::sleep(std::time::Duration::from_millis(500));

    let snapshot = core.snapshot();
    let job = &snapshot["jobs"][0];
    assert_eq!(job["agent"], "claude");
    assert_eq!(job["status"], "done");
    assert_eq!(job["outcome"], "succeeded");
    assert_eq!(job["threadId"], "fake-session-1");
    assert_eq!(job["summary"], "CLAUDE_DONE_OK");
    assert_eq!(job["tokens"]["input_tokens"], 3);
    assert_eq!(job["tokens"]["output_tokens"], 5);

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_claude_worker_picks_up_its_own_uncommitted_changes_as_a_diff() {
    let dir = workspace("claude-diff");
    for args in [
        vec!["init", "-q"],
        vec!["config", "user.email", "lab@example.com"],
        vec!["config", "user.name", "lab"],
    ] {
        let status = Command::new("git")
            .args(&args)
            .current_dir(&dir)
            .status()
            .expect("git");
        assert!(status.success(), "git {args:?} failed");
    }
    std::fs::write(dir.join("file.txt"), "before\n").expect("seed file");
    for args in [vec!["add", "-A"], vec!["commit", "-qm", "seed"]] {
        let status = Command::new("git")
            .args(&args)
            .current_dir(&dir)
            .status()
            .expect("git");
        assert!(status.success(), "git {args:?} failed");
    }
    std::fs::write(dir.join("file.txt"), "after\n").expect("simulate the worker's edit");

    let core = Core::default();
    let transcript = concat!(
        r#"{"type":"system","subtype":"init","session_id":"fake-session-diff"}"#, "\n",
        r#"{"type":"result","is_error":false,"result":"CHANGED_FILE_OK","usage":{"input_tokens":1,"output_tokens":1}}"#, "\n",
    );
    core.set_launcher(fake_claude_launcher(&dir, transcript));

    call(
        &core,
        "alethe_delegate",
        json!({ "tasks": ["edit file.txt"], "cwd": dir.to_string_lossy(), "agent": "claude" }),
    );
    std::thread::sleep(std::time::Duration::from_millis(500));

    let snapshot = core.snapshot();
    let job = &snapshot["jobs"][0];
    assert_eq!(job["status"], "done");
    assert_eq!(job["hasDiff"], true, "{snapshot}");

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn delegating_to_an_unconfigured_agent_fails_cleanly_like_any_other_agent() {
    let dir = workspace("claude-unconfigured");
    let core = Core::default();
    // No launcher registered for "claude" at all — same async-failure path as the codex case in
    // `a_job_fails_cleanly_when_no_launcher_is_configured`, just naming a different agent.
    let delegated = call(
        &core,
        "alethe_delegate",
        json!({ "tasks": ["anything"], "cwd": dir.to_string_lossy(), "agent": "claude" }),
    );
    assert_eq!(delegated["accepted"], json!(1), "{delegated}");

    let checked = call(&core, "alethe_check", json!({ "wait": true, "timeoutMs": 5000 }));
    let deliveries = checked["deliveries"].as_array().expect("deliveries");
    assert_eq!(deliveries.len(), 1, "{checked}");
    assert_eq!(deliveries[0]["outcome"], json!("failed"));
    assert!(
        deliveries[0]["text"]
            .as_str()
            .unwrap_or_default()
            .contains("claude"),
        "{checked}"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_worker_that_never_finishes_is_stopped_by_its_budget() {
    let core = Core::default();
    core.set_launcher(silent_launcher());
    let dir = workspace("timeout");

    let delegated = call(
        &core,
        "alethe_delegate",
        json!({
            "cwd": dir.to_string_lossy(),
            "tasks": ["hang forever"],
            "timeoutSeconds": 2
        }),
    );
    assert_eq!(delegated["accepted"], json!(1), "{delegated}");
    assert_eq!(delegated["timeoutSeconds"], json!(2), "{delegated}");

    let checked = call(
        &core,
        "alethe_check",
        json!({ "wait": true, "timeoutMs": 30000 }),
    );
    let deliveries = checked["deliveries"].as_array().expect("deliveries");
    assert_eq!(deliveries.len(), 1, "{checked}");
    assert_eq!(deliveries[0]["outcome"], json!("timeout"), "{checked}");
    assert_eq!(
        checked["workersStillBusy"],
        json!(0),
        "the slot must be freed: {checked}"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn isolating_outside_a_repository_says_so() {
    let core = Core::default();
    core.set_launcher(silent_launcher());
    let dir = workspace("norepo");

    let result = call(
        &core,
        "alethe_delegate",
        json!({ "cwd": dir.to_string_lossy(), "tasks": ["anything"], "isolate": true }),
    );
    assert!(
        result["error"]
            .as_str()
            .unwrap_or_default()
            .contains("git repository"),
        "{result}"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn isolating_gives_each_worker_its_own_worktree() {
    let core = Core::default();
    core.set_launcher(silent_launcher());
    let dir = workspace("isolate");

    for args in [
        vec!["init", "-q"],
        vec!["config", "user.email", "lab@example.com"],
        vec!["config", "user.name", "lab"],
    ] {
        let status = Command::new("git")
            .args(&args)
            .current_dir(&dir)
            .status()
            .expect("git");
        assert!(status.success(), "git {args:?} failed");
    }
    std::fs::write(dir.join("seed.txt"), "seed").expect("seed");
    for args in [vec!["add", "-A"], vec!["commit", "-qm", "seed"]] {
        let status = Command::new("git")
            .args(&args)
            .current_dir(&dir)
            .status()
            .expect("git");
        assert!(status.success(), "git {args:?} failed");
    }

    let delegated = call(
        &core,
        "alethe_delegate",
        json!({
            "cwd": dir.to_string_lossy(),
            "tasks": ["one", "two"],
            "isolate": true,
            "timeoutSeconds": 2
        }),
    );
    assert_eq!(delegated["accepted"], json!(2), "{delegated}");
    assert_eq!(delegated["isolated"], json!(true), "{delegated}");

    let jobs = delegated["jobs"].as_array().expect("jobs");
    let mut paths = Vec::new();
    for job in jobs {
        let path = job["worktree"].as_str().expect("a worktree path").to_string();
        let seeded = PathBuf::from(&path).join("seed.txt");
        assert!(seeded.exists(), "worktree was not checked out at {path}");
        paths.push(path);
    }
    assert_ne!(paths[0], paths[1], "both workers landed in the same directory");

    let _ = call(&core, "alethe_check", json!({ "wait": true, "timeoutMs": 30000 }));
    for path in &paths {
        let _ = Command::new("git")
            .args(["worktree", "remove", "--force", path])
            .current_dir(&dir)
            .status();
    }
    let _ = std::fs::remove_dir_all(&dir);
    if let Some(parent) = dir.parent() {
        let _ = std::fs::remove_dir_all(parent.join(".alethe-worktrees"));
    }
}
