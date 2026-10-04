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

use orchestrator_core::{handle_mcp_body, Core, Launcher, Planner, WorkerDefaults, WorkerPolicy};

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

/// A CLI found on PATH, for the opt-in tests that run the real thing.
fn cli_on_path(name: &str) -> PathBuf {
    let names: Vec<String> = if cfg!(windows) {
        vec![format!("{name}.cmd"), format!("{name}.exe")]
    } else {
        vec![name.to_string()]
    };
    let path = std::env::var_os("PATH").expect("PATH");
    std::env::split_paths(&path)
        .flat_map(|dir| names.iter().map(|name| dir.join(name)).collect::<Vec<_>>())
        .find(|candidate| candidate.is_file())
        .unwrap_or_else(|| panic!("{name} on PATH"))
}

fn codex_launcher() -> Launcher {
    Launcher::codex_app_server(cli_on_path("codex"))
}

fn claude_launcher() -> Launcher {
    Launcher::claude_headless(cli_on_path("claude"))
}

/// Like `wait_for_job`, with the patience a real model needs.
fn wait_live(core: &Core, job: &str, seconds: u64, done: impl Fn(&Value) -> bool) -> Value {
    for _ in 0..seconds * 4 {
        let snapshot = core.snapshot();
        if let Some(found) = snapshot["jobs"]
            .as_array()
            .and_then(|jobs| jobs.iter().find(|entry| entry["id"] == json!(job)))
        {
            if done(found) {
                return found.clone();
            }
        }
        thread::sleep(Duration::from_millis(250));
    }
    panic!("{job} never got there: {}", core.snapshot());
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
    assert!(
        store.exists(),
        "the store must be written as work is created"
    );

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
        second.snapshot()["running"],
        0,
        "restored work holds no slot"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn work_that_was_waiting_for_a_slot_is_back_in_line_after_a_restart() {
    let dir = workspace("persist-queue");
    let store = dir.join("orchestrator-jobs.json");

    let first = Core::default();
    first.set_store(store.clone());
    first.set_launcher(silent_launcher());
    first.set_concurrency_limit(1);
    call(
        &first,
        "alethe_delegate",
        json!({ "tasks": ["one", "two", "three"], "cwd": dir.to_string_lossy(), "agent": "codex" }),
    );
    first.reorder_queue(&["job-03".to_string(), "job-02".to_string()]);
    call(&first, "alethe_cancel", json!({ "jobIds": ["job-01"] }));
    // job-03 took the slot job-01 gave back; job-02 is the one still waiting.
    wait_for_job(&first, "job-03", |job| job["status"] == "running");

    let second = Core::default();
    second.set_store(store);
    second.restore();
    let status = |core: &Core, id: &str| {
        core.snapshot()["jobs"]
            .as_array()
            .expect("jobs")
            .iter()
            .find(|job| job["id"] == id)
            .expect("the job")["status"]
            .clone()
    };
    assert_eq!(status(&second, "job-03"), "interrupted", "it had started");
    assert_eq!(status(&second, "job-02"), "queued", "it had not");
    assert_eq!(
        second.counts(),
        (0, 1),
        "nothing starts before its CLI is found"
    );
    assert!(second.audit().is_empty(), "{:?}", second.audit());

    // The app layer resolves the worker CLIs a moment after it starts.
    second.set_launcher(silent_launcher());
    wait_for_job(&second, "job-02", |job| job["status"] == "running");
    assert_eq!(second.counts(), (1, 0));

    let _ = call(&first, "alethe_cancel", json!({ "jobIds": ["job-03"] }));
    let _ = call(&second, "alethe_cancel", json!({ "jobIds": ["job-02"] }));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn the_board_is_told_which_of_the_persons_rules_won_over_the_planner() {
    let dir = workspace("rule-overrides");
    let core = Core::default();
    core.set_launcher(silent_launcher());
    core.set_policy(WorkerPolicy {
        approvals: "always".into(),
        web_search: "never".into(),
        ..WorkerPolicy::default()
    });

    call(
        &core,
        "alethe_delegate",
        json!({ "tasks": ["look it up"], "cwd": dir.to_string_lossy(), "agent": "codex", "webSearch": true }),
    );
    assert_eq!(
        core.snapshot()["jobs"][0]["overrides"],
        json!(["approvalsOn", "webSearchOff"])
    );

    // Asking for what the rules already say changes nothing, so nothing is reported.
    core.set_policy(WorkerPolicy::default());
    call(
        &core,
        "alethe_delegate",
        json!({ "tasks": ["plain"], "cwd": dir.to_string_lossy(), "agent": "codex" }),
    );
    assert_eq!(core.snapshot()["jobs"][1]["overrides"], json!([]));

    let _ = call(
        &core,
        "alethe_cancel",
        json!({ "jobIds": ["job-01", "job-02"] }),
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

    let refused = core
        .answer("job-01", "accept")
        .expect_err("nothing to answer");
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
    assert_eq!(
        result["deliveries"].as_array().expect("deliveries").len(),
        0
    );
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

    let checked = call(
        &core,
        "alethe_check",
        json!({ "wait": true, "timeoutMs": 5000 }),
    );
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

    // Notifications are deliberately delivered on another thread so a slow webview cannot hold
    // the core lock. Under load that thread may not run before `alethe_delegate` returns.
    for _ in 0..100 {
        if !seen.lock().expect("seen").is_empty() {
            break;
        }
        thread::sleep(Duration::from_millis(10));
    }
    let snapshots = seen.lock().expect("seen");
    assert!(!snapshots.is_empty(), "the observer was never called");
    let last = snapshots.last().expect("a snapshot");
    assert!(last["jobs"].as_array().is_some_and(|jobs| !jobs.is_empty()));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
#[ignore = "runs a real Claude worker and spends a few tokens"]
fn a_real_claude_worker_finishes_a_small_task() {
    let dir = workspace("live-claude");
    let core = Core::default();
    core.set_launcher(claude_launcher());
    call(
        &core,
        "alethe_delegate",
        json!({
            "tasks": ["Reply with exactly this and nothing else: ALETHE-OK"],
            "cwd": dir.to_string_lossy(),
            "agent": "claude",
            "model": "haiku",
            "effort": "low"
        }),
    );

    let job = wait_live(&core, "job-01", 180, |job| {
        job["status"] != "running" && job["status"] != "queued"
    });
    assert_eq!(job["status"], "done", "{job}");
    assert!(
        job["summary"]
            .as_str()
            .unwrap_or_default()
            .contains("ALETHE-OK"),
        "{job}"
    );
    assert!(
        job["threadId"].is_string(),
        "the session can be continued: {job}"
    );
    let _ = call(&core, "alethe_release", json!({ "jobIds": ["job-01"] }));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
#[ignore = "runs a real Claude worker and spends a few tokens"]
fn a_real_claude_worker_asks_before_running_a_command_and_carries_on_when_approved() {
    let dir = workspace("live-claude-ask");
    let core = Core::default();
    core.set_launcher(claude_launcher());
    call(
        &core,
        "alethe_delegate",
        json!({
            "tasks": ["Use your Bash tool to run exactly this command: python3 -c \"print('alethe-' + 'live-check')\" . Then reply with only what it printed."],
            "cwd": dir.to_string_lossy(),
            "agent": "claude",
            "model": "haiku",
            "effort": "low",
            "askForApproval": true
        }),
    );

    let asking = wait_live(&core, "job-01", 180, |job| job["status"] != "running");
    assert_eq!(asking["status"], "blocked", "it has to ask first: {asking}");
    let ask = &asking["pendingApproval"];
    assert_eq!(ask["kind"], "command", "{ask}");
    assert!(
        ask["command"]
            .as_str()
            .unwrap_or_default()
            .contains("python3"),
        "{ask}"
    );

    call(
        &core,
        "alethe_answer",
        json!({ "jobId": "job-01", "decision": "accept" }),
    );
    let job = wait_live(&core, "job-01", 180, |job| {
        job["status"] != "running" && job["status"] != "blocked"
    });
    assert_eq!(job["status"], "done", "{job}");
    assert!(
        job["summary"]
            .as_str()
            .unwrap_or_default()
            .contains("alethe-live-check"),
        "{job}"
    );
    let _ = call(&core, "alethe_release", json!({ "jobIds": ["job-01"] }));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
#[ignore = "runs a real Codex worker and spends a few tokens"]
fn a_real_codex_worker_finishes_a_small_task() {
    let dir = workspace("live-codex");
    let core = Core::default();
    core.set_launcher(codex_launcher());
    call(
        &core,
        "alethe_delegate",
        json!({
            "tasks": ["Reply with exactly this and nothing else: ALETHE-OK"],
            "cwd": dir.to_string_lossy(),
            "agent": "codex",
            "effort": "low"
        }),
    );

    let job = wait_live(&core, "job-01", 180, |job| {
        job["status"] != "running" && job["status"] != "queued"
    });
    assert_eq!(job["status"], "done", "{job}");
    assert!(
        job["summary"]
            .as_str()
            .unwrap_or_default()
            .contains("ALETHE-OK"),
        "{job}"
    );
    assert!(
        job["model"].is_string(),
        "the model Codex resolved is reported: {job}"
    );
    let _ = call(&core, "alethe_release", json!({ "jobIds": ["job-01"] }));
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
    assert!(
        dir.join("ALPHA.txt").exists(),
        "ALPHA.txt missing: {checked}"
    );
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
    #[cfg(windows)]
    let (program, args): (&str, Vec<String>) = (
        "cmd",
        vec![
            "/c".into(),
            "ping".into(),
            "-n".into(),
            "60".into(),
            "127.0.0.1".into(),
        ],
    );
    #[cfg(not(windows))]
    let (program, args): (&str, Vec<String>) = ("sleep", vec!["60".into()]);
    Launcher {
        kind: "codex".into(),
        program: PathBuf::from(program),
        args,
        env: Vec::new(),
    }
}

/// Plays back a fixed Claude stream-json transcript instead of spawning the real CLI. Arguments the
/// core appends (such as `--resume`) are ignored: `type` only complains on stderr, and after
/// `sh -c` they become unused positional parameters.
fn fake_claude_launcher(dir: &std::path::Path, transcript: &str) -> Launcher {
    let path = dir.join("transcript.jsonl");
    std::fs::write(&path, transcript).expect("write fake transcript");
    #[cfg(windows)]
    let (program, args): (&str, Vec<String>) = (
        "cmd",
        vec![
            "/c".into(),
            "type".into(),
            path.to_string_lossy().into_owned(),
        ],
    );
    #[cfg(not(windows))]
    let (program, args): (&str, Vec<String>) =
        ("sh", vec!["-c".into(), format!("cat '{}'", path.display())]);
    Launcher {
        kind: "claude".into(),
        program: PathBuf::from(program),
        args,
        env: Vec::new(),
    }
}

#[test]
fn a_claude_worker_reports_its_result_and_tokens() {
    let dir = workspace("claude-worker");
    let core = Core::default();
    let store = dir.join("orchestrator.json");
    core.set_store(store.clone());
    let transcript = concat!(
        r#"{"type":"system","subtype":"init","session_id":"fake-session-1"}"#,
        "\n",
        r#"{"type":"assistant","message":{"content":[{"type":"text","text":"working on it"}]}}"#,
        "\n",
        r#"{"type":"result","is_error":false,"result":"CLAUDE_DONE_OK","total_cost_usd":0.0123,"usage":{"input_tokens":3,"output_tokens":5,"cache_read_input_tokens":7}}"#,
        "\n",
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
    assert_eq!(job["tokens"]["total"]["totalTokens"], 15);
    assert_eq!(job["tokens"]["total"]["inputTokens"], 3);
    assert_eq!(job["tokens"]["last"]["outputTokens"], 5);
    assert_eq!(job["costUsd"], 0.0123);

    let restored = Core::default();
    restored.set_store(store);
    restored.restore();
    let restored_snapshot = restored.snapshot();
    let restored_job = &restored_snapshot["jobs"][0];
    assert_eq!(restored_job["tokens"]["total"]["totalTokens"], 15);
    assert_eq!(restored_job["costUsd"], 0.0123);

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
        r#"{"type":"system","subtype":"init","session_id":"fake-session-diff"}"#,
        "\n",
        r#"{"type":"result","is_error":false,"result":"CHANGED_FILE_OK","usage":{"input_tokens":1,"output_tokens":1}}"#,
        "\n",
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

    let checked = call(
        &core,
        "alethe_check",
        json!({ "wait": true, "timeoutMs": 5000 }),
    );
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
        let path = job["worktree"]
            .as_str()
            .expect("a worktree path")
            .to_string();
        let seeded = PathBuf::from(&path).join("seed.txt");
        assert!(seeded.exists(), "worktree was not checked out at {path}");
        paths.push(path);
    }
    assert_ne!(
        paths[0], paths[1],
        "both workers landed in the same directory"
    );

    let _ = call(
        &core,
        "alethe_check",
        json!({ "wait": true, "timeoutMs": 30000 }),
    );
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

/// Emits a transcript and then holds the process open, so the job stays mid-turn while the test
/// exercises a control message against it.
fn fake_claude_holding_launcher(dir: &std::path::Path, transcript: &str) -> Launcher {
    let path = dir.join("holding.jsonl");
    std::fs::write(&path, transcript).expect("write fake transcript");
    #[cfg(windows)]
    let (program, args): (&str, Vec<String>) = {
        let script = dir.join("holding.bat");
        std::fs::write(
            &script,
            format!(
                "@echo off
type \"{}\"
ping -n 60 127.0.0.1 >NUL
",
                path.to_string_lossy()
            ),
        )
        .expect("write holding script");
        (
            "cmd",
            vec!["/c".into(), script.to_string_lossy().into_owned()],
        )
    };
    #[cfg(not(windows))]
    let (program, args): (&str, Vec<String>) = (
        "sh",
        vec!["-c".into(), format!("cat '{}'; sleep 60", path.display())],
    );
    Launcher {
        kind: "claude".into(),
        program: PathBuf::from(program),
        args,
        env: Vec::new(),
    }
}

#[test]
fn steering_a_running_claude_worker_interrupts_instead_of_waiting_out_the_turn() {
    let dir = workspace("claude-steer-live");
    let core = Core::default();
    let transcript = concat!(
        r#"{"type":"system","subtype":"init","session_id":"steer-session"}"#,
        "\n",
        r#"{"type":"assistant","message":{"content":[{"type":"text","text":"heading the wrong way"}]}}"#,
        "\n",
    );
    core.set_launcher(fake_claude_holding_launcher(&dir, transcript));

    call(
        &core,
        "alethe_delegate",
        json!({ "tasks": ["go somewhere"], "cwd": dir.to_string_lossy(), "agent": "claude" }),
    );
    std::thread::sleep(std::time::Duration::from_millis(600));

    let job_id = core.snapshot()["jobs"][0]["id"]
        .as_str()
        .expect("a job id")
        .to_string();
    assert_eq!(core.snapshot()["jobs"][0]["status"], "running");

    let steered = call(
        &core,
        "alethe_steer",
        json!({ "jobId": &job_id, "message": "turn around" }),
    );
    assert_eq!(steered["steered"], json!(job_id), "{steered}");
    assert!(
        steered.get("queued").is_none(),
        "the steer only queued: {steered}"
    );
    assert_eq!(
        core.snapshot()["jobs"][0]["status"],
        "running",
        "the interrupt settled the job instead of restarting it"
    );

    let _ = call(&core, "alethe_cancel", json!({ "jobIds": [&job_id] }));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn steering_a_settled_claude_worker_queues_the_next_turn() {
    let dir = workspace("claude-steer-idle");
    let core = Core::default();
    let transcript = concat!(
        r#"{"type":"system","subtype":"init","session_id":"idle-session"}"#,
        "\n",
        r#"{"type":"result","is_error":false,"result":"CLAUDE_DONE_OK"}"#,
        "\n",
    );
    core.set_launcher(fake_claude_launcher(&dir, transcript));

    call(
        &core,
        "alethe_delegate",
        json!({ "tasks": ["finish quickly"], "cwd": dir.to_string_lossy(), "agent": "claude" }),
    );
    std::thread::sleep(std::time::Duration::from_millis(500));

    let job_id = core.snapshot()["jobs"][0]["id"]
        .as_str()
        .expect("a job id")
        .to_string();
    assert_eq!(core.snapshot()["jobs"][0]["status"], "done");

    let steered = call(
        &core,
        "alethe_steer",
        json!({ "jobId": &job_id, "message": "one more thing" }),
    );
    assert_eq!(steered["queued"], json!(job_id), "{steered}");
    assert_eq!(steered["waiting"], json!(1), "{steered}");

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn every_tool_response_carries_the_current_headroom() {
    let core = Core::default();
    core.set_agent_fitness(
        "claude",
        json!({ "worst": "week", "used": 19, "rateLimited": false }),
    );
    core.set_agent_fitness(
        "codex",
        json!({ "worst": "week", "used": 60, "plan": "plus", "rateLimited": false }),
    );

    let status = call(&core, "alethe_status", json!({}));
    assert_eq!(status["fitness"]["headroom"], "claude", "{status}");
    assert_eq!(status["fitness"]["codex"]["plan"], "plus", "{status}");

    let checked = call(&core, "alethe_check", json!({}));
    assert_eq!(
        checked["fitness"]["headroom"], "claude",
        "alethe_check is the one response the planner must read: {checked}"
    );
}

#[test]
fn the_worst_window_decides_headroom_even_when_the_five_hour_ones_are_tied() {
    let core = Core::default();
    core.set_agent_fitness(
        "claude",
        json!({ "worst": "week", "used": 19, "rateLimited": false }),
    );
    core.set_agent_fitness(
        "codex",
        json!({ "worst": "week", "used": 60, "rateLimited": false }),
    );

    let status = call(&core, "alethe_status", json!({}));
    assert_eq!(status["fitness"]["headroom"], "claude", "{status}");
}

#[test]
fn delegating_to_an_exhausted_agent_names_the_other_side() {
    let dir = workspace("headroom-hint");
    let core = Core::default();
    core.set_launcher(silent_launcher());
    core.set_agent_fitness(
        "claude",
        json!({ "worst": "week", "used": 12, "rateLimited": false }),
    );
    core.set_agent_fitness(
        "codex",
        json!({ "worst": "week", "used": 91, "rateLimited": false }),
    );

    let delegated = call(
        &core,
        "alethe_delegate",
        json!({ "tasks": ["something"], "cwd": dir.to_string_lossy(), "agent": "codex" }),
    );
    assert_eq!(delegated["headroomHint"]["agent"], "claude", "{delegated}");
    let reason = delegated["headroomHint"]["reason"]
        .as_str()
        .unwrap_or_default();
    assert!(
        reason.contains("91"),
        "the hint hides the number it is grounded in: {reason}"
    );

    let _ = call(
        &core,
        "alethe_cancel",
        json!({ "jobIds": [delegated["jobs"][0]["id"].clone()] }),
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_rested_agent_gets_no_hint() {
    let dir = workspace("headroom-quiet");
    let core = Core::default();
    core.set_launcher(silent_launcher());
    core.set_agent_fitness(
        "claude",
        json!({ "worst": "week", "used": 12, "rateLimited": false }),
    );
    core.set_agent_fitness(
        "codex",
        json!({ "worst": "week", "used": 40, "rateLimited": false }),
    );

    let delegated = call(
        &core,
        "alethe_delegate",
        json!({ "tasks": ["something"], "cwd": dir.to_string_lossy(), "agent": "codex" }),
    );
    assert!(
        delegated.get("headroomHint").is_none(),
        "nagged about headroom that is not running out: {delegated}"
    );

    let _ = call(
        &core,
        "alethe_cancel",
        json!({ "jobIds": [delegated["jobs"][0]["id"].clone()] }),
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn the_board_records_why_a_worker_ran_where_it_ran() {
    let dir = workspace("routing-trace");
    let core = Core::default();
    core.set_launcher(silent_launcher());
    core.set_agent_fitness(
        "claude",
        json!({ "worst": "week", "used": 12, "rateLimited": false }),
    );
    core.set_agent_fitness(
        "codex",
        json!({ "worst": "week", "used": 91, "rateLimited": false }),
    );

    let ignored = call(
        &core,
        "alethe_delegate",
        json!({ "tasks": ["into the strained side"], "cwd": dir.to_string_lossy(), "agent": "codex" }),
    );
    let chosen = call(
        &core,
        "alethe_delegate",
        json!({ "tasks": ["into the rested side"], "cwd": dir.to_string_lossy(), "agent": "claude" }),
    );

    let snapshot = core.snapshot();
    let routing_of = |id: &str| {
        snapshot["jobs"]
            .as_array()
            .expect("jobs")
            .iter()
            .find(|job| job["id"] == id)
            .expect("the job")["routing"]
            .clone()
    };

    let first = ignored["jobs"][0]["id"]
        .as_str()
        .expect("an id")
        .to_string();
    let second = chosen["jobs"][0]["id"].as_str().expect("an id").to_string();
    assert_eq!(routing_of(&first)["verdict"], "ignored");
    assert_eq!(routing_of(&first)["used"], 91.0);
    assert_eq!(routing_of(&second)["verdict"], "chosen");

    let _ = call(&core, "alethe_cancel", json!({ "jobIds": [first, second] }));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_board_with_room_on_both_sides_records_no_reason_at_all() {
    let dir = workspace("routing-quiet");
    let core = Core::default();
    core.set_launcher(silent_launcher());
    core.set_agent_fitness(
        "claude",
        json!({ "worst": "week", "used": 12, "rateLimited": false }),
    );
    core.set_agent_fitness(
        "codex",
        json!({ "worst": "week", "used": 40, "rateLimited": false }),
    );

    let delegated = call(
        &core,
        "alethe_delegate",
        json!({ "tasks": ["nothing notable"], "cwd": dir.to_string_lossy(), "agent": "codex" }),
    );
    let id = delegated["jobs"][0]["id"]
        .as_str()
        .expect("an id")
        .to_string();
    let snapshot = core.snapshot();
    let job = snapshot["jobs"]
        .as_array()
        .expect("jobs")
        .iter()
        .find(|job| job["id"] == id.as_str())
        .expect("the job");
    assert!(
        job["routing"].is_null(),
        "labelled an edge that had nothing to say: {job}"
    );

    let _ = call(&core, "alethe_cancel", json!({ "jobIds": [id] }));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn structured_tasks_use_the_tier_route_and_switch_when_the_primary_is_protected() {
    let dir = workspace("smart-routing");
    let core = Core::default();
    let mut claude = silent_launcher();
    claude.kind = "claude".into();
    core.set_launcher(claude);
    core.set_launcher(silent_launcher());
    core.set_agent_fitness(
        "claude",
        json!({
            "worst": "week", "used": 85, "rateLimited": false,
            "windows": { "5h": { "used": 20 }, "week": { "used": 85 }, "opus": { "used": 10 } }
        }),
    );
    core.set_agent_fitness(
        "codex",
        json!({
            "worst": "week", "used": 25, "rateLimited": false,
            "windows": { "5h": { "used": 25 }, "week": { "used": 20 } }
        }),
    );

    let delegated = call(
        &core,
        "alethe_delegate",
        json!({
            "tasks": [{ "task": "Collect the release notes", "kind": "research", "complexity": "light" }],
            "cwd": dir.to_string_lossy()
        }),
    );
    assert_eq!(delegated["jobs"][0]["agent"], "codex", "{delegated}");
    assert_eq!(delegated["jobs"][0]["effort"], "low", "{delegated}");
    assert_eq!(delegated["jobs"][0]["webSearch"], true, "{delegated}");

    // The board is told why the worker is not on the tier's primary route.
    let routing = core.snapshot()["jobs"][0]["routing"].clone();
    assert_eq!(routing["verdict"], "routed", "{routing}");
    assert_eq!(routing["tier"], "light", "{routing}");
    assert_eq!(routing["route"], "fallback", "{routing}");
    assert_eq!(routing["avoided"]["agent"], "claude", "{routing}");
    assert_eq!(routing["avoided"]["used"], json!(85.0), "{routing}");

    let _ = call(
        &core,
        "alethe_cancel",
        json!({ "jobIds": [delegated["jobs"][0]["id"].clone()] }),
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_route_moved_to_the_other_cli_does_not_inherit_the_presets_model() {
    let dir = workspace("smart-routing-model");
    let core = Core::default();
    let mut claude = silent_launcher();
    claude.kind = "claude".into();
    core.set_launcher(claude);
    core.set_launcher(silent_launcher());
    // The default light route is Claude on haiku. Pointing it at Codex without naming a model
    // must leave the model to Codex, not hand it a Claude model name.
    core.set_routing_policy(json!({
        "tiers": { "light": { "primary": { "agent": "codex", "effort": "low" } } }
    }));

    let delegated = call(
        &core,
        "alethe_delegate",
        json!({
            "tasks": [
                { "task": "Extract headings", "kind": "general", "complexity": "light" },
                { "task": "Resolve the architecture", "kind": "code", "complexity": "deep" }
            ],
            "cwd": dir.to_string_lossy()
        }),
    );
    assert_eq!(delegated["jobs"][0]["agent"], "codex", "{delegated}");
    assert_eq!(delegated["jobs"][0]["model"], Value::Null, "{delegated}");
    assert_eq!(delegated["jobs"][1]["agent"], "claude", "{delegated}");
    assert_eq!(delegated["agent"], "mixed", "{delegated}");

    let ids = [
        delegated["jobs"][0]["id"].clone(),
        delegated["jobs"][1]["id"].clone(),
    ];
    let _ = call(&core, "alethe_cancel", json!({ "jobIds": ids }));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_tier_follows_its_routes_in_order_for_as_long_as_they_have_room() {
    let dir = workspace("smart-routing-chain");
    let core = Core::default();
    let mut claude = silent_launcher();
    claude.kind = "claude".into();
    core.set_launcher(claude);
    core.set_launcher(silent_launcher());
    core.set_routing_policy(json!({
        "tiers": { "deep": [
            { "agent": "claude", "model": "opus", "effort": "high" },
            { "agent": "codex", "effort": "high" },
            { "agent": "claude", "model": "sonnet", "effort": "medium" }
        ] }
    }));
    let usage = |core: &Core, claude: Value, codex: f64| {
        core.set_agent_fitness("claude", json!({ "rateLimited": false, "windows": claude }));
        core.set_agent_fitness(
            "codex",
            json!({ "rateLimited": false, "windows": { "5h": { "used": codex } } }),
        );
    };
    let route = |core: &Core| {
        let delegated = call(
            core,
            "alethe_delegate",
            json!({
                "tasks": [{ "task": "Resolve the architecture", "kind": "code", "complexity": "deep" }],
                "cwd": dir.to_string_lossy()
            }),
        );
        let id = delegated["jobs"][0]["id"].clone();
        let job = delegated["jobs"][0].clone();
        let routing = core.snapshot()["jobs"]
            .as_array()
            .expect("jobs")
            .iter()
            .find(|entry| entry["id"] == id)
            .expect("the job")["routing"]
            .clone();
        let _ = call(core, "alethe_cancel", json!({ "jobIds": [id] }));
        (job, routing)
    };

    // The first route is past the watch band and the second is not: the second takes it.
    usage(&core, json!({ "5h": { "used": 70 } }), 30.0);
    let (job, routing) = route(&core);
    assert_eq!(job["agent"], "codex", "{job}");
    assert_eq!(routing["position"], json!(1), "{routing}");
    assert_eq!(routing["avoided"]["agent"], "claude", "{routing}");

    // Nothing is below the watch band, so the order is followed up to the protect band.
    usage(&core, json!({ "5h": { "used": 70 } }), 65.0);
    let (job, routing) = route(&core);
    assert_eq!(job["agent"], "claude", "{job}");
    assert_eq!(job["model"], "opus", "{job}");
    assert_eq!(routing["route"], "primary", "{routing}");
    assert!(routing["avoided"].is_null(), "{routing}");

    // Opus is nearly spent and Codex is past the protect band: the third route still has room.
    usage(
        &core,
        json!({ "5h": { "used": 20 }, "opus": { "used": 97 } }),
        88.0,
    );
    let (job, routing) = route(&core);
    assert_eq!(job["agent"], "claude", "{job}");
    assert_eq!(job["model"], "sonnet", "{job}");
    assert_eq!(routing["position"], json!(2), "{routing}");

    // With every route past the protect band, the one with the most room left takes it.
    usage(&core, json!({ "5h": { "used": 92 } }), 85.0);
    let (job, routing) = route(&core);
    assert_eq!(job["agent"], "codex", "{job}");
    assert_eq!(routing["avoided"]["used"], json!(92.0), "{routing}");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn queued_work_starts_in_the_order_the_person_dragged_it_into() {
    let dir = workspace("queue-reorder");
    let core = Core::default();
    core.set_launcher(silent_launcher());
    core.set_concurrency_limit(1);
    call(
        &core,
        "alethe_delegate",
        json!({
            "tasks": ["one", "two", "three", "four"],
            "cwd": dir.to_string_lossy(),
            "agent": "codex"
        }),
    );
    assert_eq!(core.counts(), (1, 3));

    // Only the places held by the named jobs change hands; a job that is not waiting is ignored.
    let reordered = core.reorder_queue(&[
        "job-04".to_string(),
        "job-01".to_string(),
        "job-02".to_string(),
        "job-99".to_string(),
    ]);
    assert_eq!(reordered["queue"], json!(["job-04", "job-03", "job-02"]));
    let position = |id: &str| {
        core.snapshot()["jobs"]
            .as_array()
            .expect("jobs")
            .iter()
            .find(|entry| entry["id"] == id)
            .expect("the job")["queuePosition"]
            .clone()
    };
    assert_eq!(position("job-04"), json!(0));
    assert_eq!(position("job-03"), json!(1));
    assert_eq!(position("job-01"), Value::Null);

    call(&core, "alethe_cancel", json!({ "jobIds": ["job-01"] }));
    wait_for_job(&core, "job-04", |job| job["status"] == "running");
    assert_eq!(position("job-03"), json!(0));

    let _ = call(
        &core,
        "alethe_cancel",
        json!({ "jobIds": ["job-02", "job-03", "job-04"] }),
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn the_opus_window_only_pressures_an_opus_route() {
    let dir = workspace("smart-routing-opus");
    let core = Core::default();
    let mut claude = silent_launcher();
    claude.kind = "claude".into();
    core.set_launcher(claude);
    core.set_launcher(silent_launcher());
    core.set_agent_fitness(
        "claude",
        json!({
            "worst": "opus", "used": 99, "rateLimited": false,
            "windows": { "5h": { "used": 10 }, "week": { "used": 12 }, "opus": { "used": 99 } }
        }),
    );
    core.set_agent_fitness(
        "codex",
        json!({
            "worst": "week", "used": 70, "rateLimited": false,
            "windows": { "5h": { "used": 70 }, "week": { "used": 65 } }
        }),
    );

    let light = call(
        &core,
        "alethe_delegate",
        json!({
            "tasks": [{ "task": "Extract headings", "kind": "research", "complexity": "light" }],
            "cwd": dir.to_string_lossy()
        }),
    );
    assert_eq!(light["jobs"][0]["agent"], "claude", "{light}");
    assert_eq!(light["jobs"][0]["model"], "haiku", "{light}");

    let deep = call(
        &core,
        "alethe_delegate",
        json!({
            "tasks": [{ "task": "Resolve the architecture", "kind": "code", "complexity": "deep" }],
            "cwd": dir.to_string_lossy()
        }),
    );
    assert_eq!(deep["jobs"][0]["agent"], "codex", "{deep}");

    let ids = [
        light["jobs"][0]["id"].clone(),
        deep["jobs"][0]["id"].clone(),
    ];
    let _ = call(&core, "alethe_cancel", json!({ "jobIds": ids }));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn critical_structured_routes_require_the_persons_force_flag() {
    let dir = workspace("smart-routing-critical");
    let core = Core::default();
    let mut claude = silent_launcher();
    claude.kind = "claude".into();
    core.set_launcher(claude);
    core.set_launcher(silent_launcher());
    for agent in ["claude", "codex"] {
        core.set_agent_fitness(
            agent,
            json!({
                "worst": "week", "used": 99, "rateLimited": false,
                "windows": { "5h": { "used": 99 }, "week": { "used": 99 }, "opus": { "used": 99 } }
            }),
        );
    }
    let task = json!([{ "task": "Investigate", "kind": "research", "complexity": "light" }]);
    let blocked = call(
        &core,
        "alethe_delegate",
        json!({ "tasks": task, "cwd": dir.to_string_lossy() }),
    );
    assert!(
        blocked["error"]
            .as_str()
            .unwrap_or_default()
            .contains("forceRoute"),
        "{blocked}"
    );

    let allowed = call(
        &core,
        "alethe_delegate",
        json!({ "tasks": task, "cwd": dir.to_string_lossy(), "forceRoute": true }),
    );
    assert_eq!(allowed["accepted"], 1, "{allowed}");
    let _ = call(
        &core,
        "alethe_cancel",
        json!({ "jobIds": [allowed["jobs"][0]["id"].clone()] }),
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn with_both_sides_strained_the_board_blames_the_worse_one_every_time() {
    let dir = workspace("routing-both-strained");
    let core = Core::default();
    core.set_launcher(silent_launcher());
    // The reading that came back from a real run: both past the threshold, codex worse.
    core.set_agent_fitness(
        "claude",
        json!({ "worst": "5h", "used": 80, "rateLimited": false }),
    );
    core.set_agent_fitness(
        "codex",
        json!({ "worst": "5h", "used": 98, "rateLimited": false }),
    );

    let mut ids = Vec::new();
    for _ in 0..5 {
        let delegated = call(
            &core,
            "alethe_delegate",
            json!({ "tasks": ["work"], "cwd": dir.to_string_lossy(), "agent": "codex" }),
        );
        let id = delegated["jobs"][0]["id"]
            .as_str()
            .expect("an id")
            .to_string();
        let snapshot = core.snapshot();
        let job = snapshot["jobs"]
            .as_array()
            .expect("jobs")
            .iter()
            .find(|job| job["id"] == id.as_str())
            .expect("the job")
            .clone();
        assert_eq!(
            job["routing"]["agent"], "codex",
            "named the less strained side, or a different one each call: {job}"
        );
        assert_eq!(job["routing"]["verdict"], "ignored", "{job}");
        ids.push(id);
    }
    let _ = call(&core, "alethe_cancel", json!({ "jobIds": ids }));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_hint_never_presents_an_equally_exhausted_agent_as_the_way_out() {
    let dir = workspace("hint-both-strained");
    let core = Core::default();
    core.set_launcher(silent_launcher());
    core.set_agent_fitness(
        "claude",
        json!({ "worst": "5h", "used": 80, "rateLimited": false }),
    );
    core.set_agent_fitness(
        "codex",
        json!({ "worst": "5h", "used": 98, "rateLimited": false }),
    );

    let delegated = call(
        &core,
        "alethe_delegate",
        json!({ "tasks": ["work"], "cwd": dir.to_string_lossy(), "agent": "codex" }),
    );
    let hint = &delegated["headroomHint"];
    assert_eq!(hint["agent"], "claude", "{delegated}");
    assert_eq!(hint["bothStrained"], true, "{delegated}");
    let reason = hint["reason"].as_str().unwrap_or_default();
    assert!(
        reason.contains("both are running out"),
        "recommended a side that is itself at the ceiling without saying so: {reason}"
    );

    let _ = call(
        &core,
        "alethe_cancel",
        json!({ "jobIds": [delegated["jobs"][0]["id"].clone()] }),
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_rate_limited_agent_outranks_any_percentage() {
    let core = Core::default();
    core.set_agent_fitness(
        "claude",
        json!({ "worst": "5h", "used": 99, "rateLimited": false }),
    );
    core.set_agent_fitness(
        "codex",
        json!({ "worst": "5h", "used": 10, "rateLimited": true }),
    );

    let status = call(&core, "alethe_status", json!({}));
    assert_eq!(
        status["fitness"]["headroom"], "claude",
        "sent work to a side that is already refusing it: {status}"
    );
}

#[test]
fn the_delegate_schema_points_at_the_live_reading_instead_of_quoting_numbers() {
    let core = Core::default();
    let listed = rpc(&core, 1, "tools/list", json!({}));
    let description = listed["result"]["tools"]
        .as_array()
        .expect("tools")
        .iter()
        .find(|tool| tool["name"] == "alethe_delegate")
        .expect("alethe_delegate")["inputSchema"]["properties"]["agent"]["description"]
        .as_str()
        .expect("a description")
        .to_string();

    assert!(description.contains("fitness"), "{description}");
    assert!(description.contains("headroom"), "{description}");
    // A description is a session-start snapshot on this transport, so a figure baked in here would
    // be a claim that goes stale mid-session with no way to correct it.
    assert!(
        !description.contains('%'),
        "a percentage was baked into a description that cannot be refreshed: {description}"
    );
}

/// A worker that records the arguments the core appended, then plays back `transcript` (or exits
/// when it is empty). `sh -c script sh` turns everything after it into `$@`.
#[cfg(unix)]
fn argv_recording_launcher(dir: &std::path::Path, kind: &str, transcript: &str) -> Launcher {
    let transcript_path = dir.join("transcript.jsonl");
    std::fs::write(&transcript_path, transcript).expect("write fake transcript");
    let script = format!(
        // A loop rather than one printf: with no arguments printf still prints its format once.
        // Written aside and renamed, so a reader never sees the file half written.
        "for arg in \"$@\"; do printf '%s\\n' \"$arg\"; done > '{argv}.tmp' && mv '{argv}.tmp' '{argv}'; cat '{transcript}'",
        argv = dir.join("argv.txt").display(),
        transcript = transcript_path.display(),
    );
    Launcher {
        kind: kind.into(),
        program: PathBuf::from("sh"),
        args: vec!["-c".into(), script, "sh".into()],
        env: Vec::new(),
    }
}

#[cfg(unix)]
fn recorded_argv(dir: &std::path::Path) -> Vec<String> {
    for _ in 0..50 {
        if let Ok(text) = std::fs::read_to_string(dir.join("argv.txt")) {
            return text.lines().map(ToOwned::to_owned).collect();
        }
        thread::sleep(Duration::from_millis(20));
    }
    panic!("the worker never started");
}

#[cfg(unix)]
const CLAUDE_DONE: &str = concat!(
    r#"{"type":"system","subtype":"init","session_id":"fake-session"}"#,
    "\n",
    r#"{"type":"result","is_error":false,"result":"DONE","usage":{"input_tokens":1,"output_tokens":1}}"#,
    "\n",
);

#[cfg(unix)]
#[test]
fn a_claude_worker_starts_with_the_configured_model_and_effort() {
    let dir = workspace("claude-defaults");
    let core = Core::default();
    core.set_launcher(argv_recording_launcher(&dir, "claude", CLAUDE_DONE));
    core.set_worker_defaults(
        "claude",
        WorkerDefaults {
            model: Some("opus".into()),
            effort: Some("high".into()),
        },
    );

    call(
        &core,
        "alethe_delegate",
        json!({ "tasks": ["anything"], "cwd": dir.to_string_lossy(), "agent": "claude" }),
    );

    assert_eq!(
        recorded_argv(&dir),
        [
            "--permission-mode",
            "bypassPermissions",
            "--model",
            "opus",
            "--effort",
            "high"
        ]
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[cfg(unix)]
#[test]
fn a_codex_worker_takes_its_model_and_effort_as_config_overrides() {
    let dir = workspace("codex-defaults");
    let core = Core::default();
    core.set_launcher(argv_recording_launcher(&dir, "codex", ""));
    core.set_worker_defaults(
        "codex",
        WorkerDefaults {
            model: Some("gpt-5.6-sol".into()),
            effort: Some("high".into()),
        },
    );

    call(
        &core,
        "alethe_delegate",
        json!({ "tasks": ["anything"], "cwd": dir.to_string_lossy() }),
    );

    assert_eq!(
        recorded_argv(&dir),
        [
            "-c",
            "model=\"gpt-5.6-sol\"",
            "-c",
            "model_reasoning_effort=\"high\""
        ]
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[cfg(unix)]
#[test]
fn worker_defaults_a_cli_cannot_take_never_reach_its_command_line() {
    let dir = workspace("unsafe-defaults");
    let core = Core::default();
    core.set_launcher(argv_recording_launcher(&dir, "claude", CLAUDE_DONE));
    core.set_worker_defaults(
        "claude",
        WorkerDefaults {
            model: Some("opus; rm -rf ~".into()),
            effort: Some("extreme".into()),
        },
    );

    call(
        &core,
        "alethe_delegate",
        json!({ "tasks": ["anything"], "cwd": dir.to_string_lossy(), "agent": "claude" }),
    );

    assert_eq!(
        recorded_argv(&dir),
        ["--permission-mode", "bypassPermissions"]
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[cfg(unix)]
#[test]
fn a_worker_that_dies_reports_what_it_said_on_stderr() {
    let dir = workspace("stderr-report");
    let core = Core::default();
    core.set_launcher(Launcher {
        kind: "claude".into(),
        program: PathBuf::from("sh"),
        args: vec![
            "-c".into(),
            "echo 'Invalid API key. Please run /login' >&2; exit 1".into(),
        ],
        env: Vec::new(),
    });

    call(
        &core,
        "alethe_delegate",
        json!({ "tasks": ["anything"], "cwd": dir.to_string_lossy(), "agent": "claude" }),
    );
    let checked = call(
        &core,
        "alethe_check",
        json!({ "wait": true, "timeoutMs": 5000 }),
    );

    let text = checked["deliveries"][0]["text"]
        .as_str()
        .unwrap_or_default()
        .to_string();
    assert!(text.starts_with("worker connection closed"), "{checked}");
    assert!(text.contains("Invalid API key"), "{checked}");
    let _ = std::fs::remove_dir_all(&dir);
}

#[cfg(unix)]
#[test]
fn a_delegation_without_a_cwd_runs_where_its_planner_does() {
    let dir = workspace("planner-cwd");
    let core = Core::default();
    core.set_launcher(argv_recording_launcher(&dir, "claude", CLAUDE_DONE));
    core.register_planner(Planner {
        id: "planner-1".into(),
        label: "Lead".into(),
        agent: "claude".into(),
        cwd: Some(dir.to_string_lossy().into_owned()),
    });

    let body = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": { "name": "alethe_delegate", "arguments": { "tasks": ["anything"], "agent": "claude" } }
    });
    handle_mcp_body(&core, &body.to_string(), Some("planner-1")).expect("a response");

    let snapshot = core.snapshot();
    assert_eq!(
        snapshot["jobs"][0]["cwd"],
        json!(dir.to_string_lossy()),
        "{snapshot}"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[cfg(unix)]
fn call_as(core: &Core, planner: &str, name: &str, arguments: Value) -> Value {
    let body = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": { "name": name, "arguments": arguments }
    });
    let raw = handle_mcp_body(core, &body.to_string(), Some(planner)).expect("a response");
    let response: Value = serde_json::from_str(&raw).expect("valid json");
    let text = response["result"]["content"][0]["text"]
        .as_str()
        .expect("tool text")
        .to_string();
    serde_json::from_str(&text).unwrap_or_else(|_| json!({ "raw": text }))
}

#[cfg(unix)]
#[test]
fn each_planner_only_collects_the_results_of_its_own_delegations() {
    let dir = workspace("two-planners");
    let core = Core::default();
    core.set_launcher(argv_recording_launcher(&dir, "claude", CLAUDE_DONE));

    let first = call_as(
        &core,
        "planner-a",
        "alethe_delegate",
        json!({ "tasks": ["a's task"], "cwd": dir.to_string_lossy(), "agent": "claude" }),
    );
    let second = call_as(
        &core,
        "planner-b",
        "alethe_delegate",
        json!({ "tasks": ["b's task"], "cwd": dir.to_string_lossy(), "agent": "claude" }),
    );
    let first_job = first["jobs"][0]["id"].clone();
    let second_job = second["jobs"][0]["id"].clone();

    let a = call_as(
        &core,
        "planner-a",
        "alethe_check",
        json!({ "wait": true, "timeoutMs": 5000 }),
    );
    let a_jobs: Vec<Value> = a["deliveries"]
        .as_array()
        .expect("deliveries")
        .iter()
        .map(|delivery| delivery["jobId"].clone())
        .collect();
    assert_eq!(a_jobs, vec![first_job], "{a}");

    let b = call_as(
        &core,
        "planner-b",
        "alethe_check",
        json!({ "wait": true, "timeoutMs": 5000 }),
    );
    let b_jobs: Vec<Value> = b["deliveries"]
        .as_array()
        .expect("deliveries")
        .iter()
        .map(|delivery| delivery["jobId"].clone())
        .collect();
    assert_eq!(b_jobs, vec![second_job], "{b}");
    assert_eq!(b["workersStillBusy"], json!(0), "{b}");

    let _ = std::fs::remove_dir_all(&dir);
}

/// A Codex app-server stand-in: answers `thread/start` with a thread id, then records the params of
/// the first `turn/start` it receives and exits.
#[cfg(unix)]
fn turn_recording_codex(dir: &std::path::Path) -> Launcher {
    let script = r#"
import json, sys
out = sys.argv[1]
for line in sys.stdin:
    message = json.loads(line)
    if message.get("method") == "thread/start":
        print(json.dumps({"id": message["id"], "result": {"thread": {"id": "thread-1"}}}), flush=True)
    elif message.get("method") == "turn/start":
        with open(out + ".tmp", "w") as handle:
            json.dump(message["params"], handle)
        import os
        os.replace(out + ".tmp", out)
        break
"#;
    Launcher {
        kind: "codex".into(),
        program: PathBuf::from("python3"),
        args: vec![
            "-c".into(),
            script.into(),
            dir.join("turn.json").to_string_lossy().into_owned(),
        ],
        env: Vec::new(),
    }
}

#[cfg(unix)]
fn recorded_turn(dir: &std::path::Path) -> Value {
    for _ in 0..100 {
        if let Ok(text) = std::fs::read_to_string(dir.join("turn.json")) {
            return serde_json::from_str(&text).expect("turn params");
        }
        thread::sleep(Duration::from_millis(20));
    }
    panic!("the worker never started a turn");
}

#[cfg(unix)]
#[test]
fn a_worker_delegated_to_ask_is_not_switched_to_never_by_its_first_turn() {
    let dir = workspace("ask-turn");
    let core = Core::default();
    core.set_launcher(turn_recording_codex(&dir));

    call(
        &core,
        "alethe_delegate",
        json!({ "tasks": ["anything"], "cwd": dir.to_string_lossy(), "askForApproval": true }),
    );

    let turn = recorded_turn(&dir);
    assert_eq!(
        turn["approvalPolicy"]["granular"]["sandbox_approval"],
        json!(true),
        "{turn}"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[cfg(unix)]
#[test]
fn a_worker_delegated_without_asking_still_runs_its_turns_unattended() {
    let dir = workspace("never-turn");
    let core = Core::default();
    core.set_launcher(turn_recording_codex(&dir));

    call(
        &core,
        "alethe_delegate",
        json!({ "tasks": ["anything"], "cwd": dir.to_string_lossy() }),
    );

    assert_eq!(recorded_turn(&dir)["approvalPolicy"], json!("never"));
    let _ = std::fs::remove_dir_all(&dir);
}

/// A Claude stand-in that answers its first turn at once and every later one after `delay`.
#[cfg(unix)]
fn slow_follow_up_claude(delay_seconds: f64) -> Launcher {
    let script = format!(
        r#"
import json, sys, time
print(json.dumps({{"type": "system", "subtype": "init", "session_id": "slow-1"}}), flush=True)
turns = 0
for line in sys.stdin:
    turns += 1
    if turns > 1:
        time.sleep({delay_seconds})
    print(json.dumps({{"type": "result", "is_error": False, "result": "TURN %d" % turns,
                       "usage": {{"input_tokens": 1, "output_tokens": 1}}}}), flush=True)
"#
    );
    Launcher {
        kind: "claude".into(),
        program: PathBuf::from("python3"),
        args: vec!["-c".into(), script],
        env: Vec::new(),
    }
}

#[cfg(unix)]
#[test]
fn a_follow_up_turn_is_timed_on_its_own_budget_not_the_first_turns() {
    let dir = workspace("turn-watchdog");
    let core = Core::default();
    core.set_launcher(slow_follow_up_claude(1.5));

    let delegated = call(
        &core,
        "alethe_delegate",
        json!({
            "tasks": ["first"],
            "cwd": dir.to_string_lossy(),
            "agent": "claude",
            "timeoutSeconds": 2
        }),
    );
    let job_id = delegated["jobs"][0]["id"]
        .as_str()
        .expect("job id")
        .to_string();
    let first = call(
        &core,
        "alethe_check",
        json!({ "wait": true, "timeoutMs": 5000 }),
    );
    assert_eq!(first["deliveries"][0]["text"], json!("TURN 1"), "{first}");

    // The first turn's two-second budget runs out halfway through this one.
    thread::sleep(Duration::from_millis(1000));
    call(
        &core,
        "alethe_send",
        json!({ "jobId": job_id, "message": "second" }),
    );
    let second = call(
        &core,
        "alethe_check",
        json!({ "wait": true, "timeoutMs": 5000 }),
    );

    assert_eq!(
        second["deliveries"][0]["outcome"],
        json!("succeeded"),
        "{second}"
    );
    assert_eq!(second["deliveries"][0]["text"], json!("TURN 2"), "{second}");
    let _ = std::fs::remove_dir_all(&dir);
}

#[cfg(unix)]
#[test]
fn a_planner_can_pick_the_model_for_one_delegation_over_the_worker_default() {
    let dir = workspace("delegate-model");
    let core = Core::default();
    core.set_launcher(argv_recording_launcher(&dir, "claude", CLAUDE_DONE));
    core.set_worker_defaults(
        "claude",
        WorkerDefaults {
            model: Some("opus".into()),
            effort: Some("high".into()),
        },
    );

    call(
        &core,
        "alethe_delegate",
        json!({
            "tasks": ["rename a variable"],
            "cwd": dir.to_string_lossy(),
            "agent": "claude",
            "model": "haiku"
        }),
    );

    // The planner's model wins; the effort it left out still comes from the default.
    assert_eq!(
        recorded_argv(&dir),
        [
            "--permission-mode",
            "bypassPermissions",
            "--model",
            "haiku",
            "--effort",
            "high"
        ]
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_delegation_asking_for_something_the_cli_cannot_take_is_refused_with_the_reason() {
    let core = Core::default();

    let effort = call(
        &core,
        "alethe_delegate",
        json!({ "tasks": ["x"], "cwd": ".", "agent": "claude", "effort": "ultra" }),
    );
    assert!(
        effort["error"]
            .as_str()
            .is_some_and(|text| text.contains("low, medium, high, xhigh, max")),
        "{effort}"
    );

    let model = call(
        &core,
        "alethe_delegate",
        json!({ "tasks": ["x"], "cwd": ".", "agent": "claude", "model": "opus; rm -rf ~" }),
    );
    assert!(
        model["error"]
            .as_str()
            .is_some_and(|text| text.contains("model")),
        "{model}"
    );
    assert_eq!(core.snapshot()["jobs"], json!([]), "nothing was queued");
}

#[test]
fn the_chosen_model_outlives_a_restart() {
    let dir = workspace("delegate-model-store");
    let store = dir.join("orchestrator.json");
    let core = Core::default();
    core.set_store(store.clone());
    call(
        &core,
        "alethe_delegate",
        json!({ "tasks": ["x"], "cwd": dir.to_string_lossy(), "model": "gpt-5.6-sol", "effort": "low" }),
    );

    let saved: Value =
        serde_json::from_slice(&std::fs::read(&store).expect("store")).expect("json");
    assert_eq!(saved["jobs"][0]["model"], json!("gpt-5.6-sol"));
    assert_eq!(saved["jobs"][0]["effort"], json!("low"));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_worker_blocked_when_the_app_closed_does_not_hold_its_planner_waiting() {
    let dir = workspace("blocked-restore");
    let store = dir.join("orchestrator.json");
    std::fs::write(
        &store,
        json!({
            "version": 2,
            "jobs": [{
                "id": "job-01",
                "plannerId": "planner-1",
                "agent": "codex",
                "runId": "run-01",
                "spec": "touch something outside",
                "cwd": dir.to_string_lossy(),
                "status": "blocked",
                "threadId": "thread-1"
            }],
            "planners": []
        })
        .to_string(),
    )
    .expect("seed store");
    let core = Core::default();
    core.set_store(store);
    core.restore();

    assert_eq!(core.snapshot()["jobs"][0]["status"], json!("interrupted"));
    let started = std::time::Instant::now();
    let body = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": { "name": "alethe_check", "arguments": { "wait": true, "timeoutMs": 5000 } }
    });
    let raw = handle_mcp_body(&core, &body.to_string(), Some("planner-1")).expect("a response");
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "check waited on a dead worker: {raw}"
    );
    assert!(raw.contains("workersStillBusy\\\":0"), "{raw}");
    let _ = std::fs::remove_dir_all(&dir);
}

/// A worker stand-in written in Python, which both CLIs' protocols are easy to script in. The
/// script gets `send(message)` and `record(name, value)` (written atomically into `dir`) and runs
/// `on(message)` for every line it reads; the arguments the core appended are recorded first.
#[cfg(unix)]
fn scripted_worker(dir: &std::path::Path, kind: &str, prelude: &str, handler: &str) -> Launcher {
    let script = format!(
        r#"
import json, os, sys
out = sys.argv[1]
def send(message):
    print(json.dumps(message), flush=True)
def record(name, value):
    path = os.path.join(out, name)
    with open(path + ".tmp", "w") as handle:
        json.dump(value, handle)
    os.replace(path + ".tmp", path)
record("argv.json", sys.argv[2:])
{prelude}
def on(m):
{handler}
for line in sys.stdin:
    on(json.loads(line))
"#,
        handler = handler
            .lines()
            .map(|line| format!("    {line}"))
            .collect::<Vec<_>>()
            .join("\n"),
    );
    Launcher {
        kind: kind.into(),
        program: PathBuf::from("python3"),
        args: vec!["-c".into(), script, dir.to_string_lossy().into_owned()],
        env: Vec::new(),
    }
}

#[cfg(unix)]
fn recorded(dir: &std::path::Path, name: &str) -> Value {
    for _ in 0..150 {
        if let Ok(text) = std::fs::read_to_string(dir.join(name)) {
            if let Ok(value) = serde_json::from_str(&text) {
                return value;
            }
        }
        thread::sleep(Duration::from_millis(20));
    }
    panic!("the worker never wrote {name}");
}

/// Polls the board until `job` satisfies `done`, so a test waits on state rather than on time.
fn wait_for_job(core: &Core, job: &str, done: impl Fn(&Value) -> bool) -> Value {
    for _ in 0..250 {
        let snapshot = core.snapshot();
        if let Some(found) = snapshot["jobs"]
            .as_array()
            .and_then(|jobs| jobs.iter().find(|entry| entry["id"] == json!(job)))
        {
            if done(found) {
                return found.clone();
            }
        }
        thread::sleep(Duration::from_millis(20));
    }
    panic!("{job} never got there: {}", core.snapshot());
}

#[cfg(unix)]
const CODEX_THREAD: &str = r#"if m.get("method") == "thread/start":
    send({"id": m["id"], "result": {"thread": {"id": "t-1"}, "model": "gpt-test", "reasoningEffort": "high"}})"#;

#[cfg(unix)]
#[test]
fn a_worker_that_runs_out_of_usage_starts_again_on_the_tiers_next_route() {
    let dir = workspace("reroute-on-limit");
    let codex_dir = dir.join("codex");
    let claude_dir = dir.join("claude");
    std::fs::create_dir_all(&codex_dir).unwrap();
    std::fs::create_dir_all(&claude_dir).unwrap();
    let core = Core::default();
    core.set_launcher(scripted_worker(
        &codex_dir,
        "codex",
        "",
        &format!(
            r#"{CODEX_THREAD}
elif m.get("method") == "turn/start":
    send({{"method": "turn/started", "params": {{"threadId": "t-1", "turn": {{"id": "turn-1", "items": [], "status": "inProgress"}}}}}})
    send({{"method": "turn/completed", "params": {{"threadId": "t-1", "turn": {{"id": "turn-1", "items": [], "status": "failed", "error": {{"message": "You've hit your usage limit.", "codexErrorInfo": "usageLimitExceeded"}}}}}}}})"#
        ),
    ));
    core.set_launcher(scripted_worker(
        &claude_dir,
        "claude",
        "",
        r#"if m.get("type") == "user":
    send({"type": "system", "subtype": "init", "session_id": "c-1"})
    send({"type": "result", "is_error": False, "result": "GOT " + m["message"]["content"][0]["text"]})"#,
    ));

    // The standard tier leads with Codex and falls back to Claude.
    let delegated = call(
        &core,
        "alethe_delegate",
        json!({
            "tasks": [{ "task": "fix the parser", "kind": "code", "complexity": "standard" }],
            "cwd": dir.to_string_lossy()
        }),
    );
    assert_eq!(delegated["jobs"][0]["agent"], "codex", "{delegated}");

    let job = wait_for_job(&core, "job-01", |job| job["status"] == "done");
    assert_eq!(job["agent"], "claude", "{job}");
    assert_eq!(job["summary"], "GOT fix the parser", "{job}");
    assert_eq!(job["routing"]["position"], json!(1), "{job}");
    assert_eq!(job["routing"]["avoided"]["agent"], "codex", "{job}");
    assert_eq!(
        job["routing"]["avoided"]["rateLimited"],
        json!(true),
        "{job}"
    );
    assert_eq!(core.counts(), (0, 0));
    let _ = std::fs::remove_dir_all(&dir);
}

#[cfg(unix)]
#[test]
fn stopping_a_worker_stops_the_commands_it_started() {
    let dir = workspace("stop-process-group");
    let core = Core::default();
    core.set_launcher(scripted_worker(
        &dir,
        "claude",
        r#"import subprocess
child = subprocess.Popen(["sleep", "300"])
record("child.json", child.pid)"#,
        "pass",
    ));

    call(
        &core,
        "alethe_delegate",
        json!({ "tasks": ["run the tests"], "cwd": dir.to_string_lossy(), "agent": "claude" }),
    );
    let pid = recorded(&dir, "child.json")
        .as_i64()
        .expect("a pid")
        .to_string();
    let alive = |pid: &str| {
        std::process::Command::new("kill")
            .args(["-0", pid])
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
    };
    assert!(alive(&pid), "the command the worker started is running");

    call(&core, "alethe_cancel", json!({ "jobIds": ["job-01"] }));
    let mut gone = false;
    for _ in 0..150 {
        if !alive(&pid) {
            gone = true;
            break;
        }
        thread::sleep(Duration::from_millis(20));
    }
    assert!(gone, "the command outlived the worker that started it");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn clearing_takes_finished_workers_off_the_board_and_leaves_the_rest() {
    let dir = workspace("clear-finished");
    let core = Core::default();
    core.set_launcher(silent_launcher());
    call(
        &core,
        "alethe_delegate",
        json!({ "tasks": ["one", "two"], "cwd": dir.to_string_lossy(), "agent": "codex" }),
    );
    call(&core, "alethe_cancel", json!({ "jobIds": ["job-01"] }));

    let cleared = core.clear_finished(&["job-01".to_string(), "job-02".to_string()]);
    assert_eq!(
        cleared["cleared"],
        json!(["job-01"]),
        "a running worker is not cleared"
    );
    let listed: Vec<Value> = core.snapshot()["jobs"]
        .as_array()
        .expect("jobs")
        .iter()
        .map(|job| job["id"].clone())
        .collect();
    assert_eq!(listed, vec![json!("job-02")]);

    let _ = call(&core, "alethe_cancel", json!({ "jobIds": ["job-02"] }));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn the_route_choice_matches_the_fixture_the_frontend_preview_is_checked_against() {
    let fixture: Value =
        serde_json::from_str(include_str!("fixtures/routing_cases.json")).expect("valid fixture");
    let cases = fixture["cases"].as_array().expect("cases");
    assert!(!cases.is_empty());
    for case in cases {
        let pressures: Vec<f64> = case["pressures"]
            .as_array()
            .expect("pressures")
            .iter()
            .map(|value| value.as_f64().expect("a number"))
            .collect();
        let picked = orchestrator_core::pick_route(
            &pressures,
            case["watch"].as_f64().expect("watch"),
            case["protect"].as_f64().expect("protect"),
        );
        assert_eq!(json!(picked), case["expected"], "{}", case["name"]);
    }
}

#[test]
fn no_sequence_of_operations_leaves_the_queue_and_the_slots_disagreeing() {
    let dir = workspace("audit-stress");
    let core = Core::default();
    let mut claude = silent_launcher();
    claude.kind = "claude".into();
    core.set_launcher(claude);
    core.set_launcher(silent_launcher());

    // A fixed pseudo-random walk, so a failure reproduces exactly.
    let mut seed: u64 = 0x5eed_1234_abcd_ef01;
    let mut next = |bound: u64| {
        seed = seed
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        (seed >> 33) % bound
    };
    let mut delegated: Vec<String> = Vec::new();
    for step in 0..120 {
        let pick = |next: &mut dyn FnMut(u64) -> u64, ids: &[String]| {
            ids[next(ids.len() as u64) as usize].clone()
        };
        match next(8) {
            0 | 1 => {
                let agent = if next(2) == 0 { "codex" } else { "claude" };
                let tasks: Vec<String> =
                    (0..=next(2)).map(|n| format!("task {step}-{n}")).collect();
                let response = call(
                    &core,
                    "alethe_delegate",
                    json!({ "tasks": tasks, "cwd": dir.to_string_lossy(), "agent": agent }),
                );
                for job in response["jobs"].as_array().into_iter().flatten() {
                    delegated.push(job["id"].as_str().expect("an id").to_string());
                }
            }
            2 if !delegated.is_empty() => {
                let id = pick(&mut next, &delegated);
                call(&core, "alethe_cancel", json!({ "jobIds": [id] }));
            }
            3 if !delegated.is_empty() => {
                let id = pick(&mut next, &delegated);
                call(&core, "alethe_release", json!({ "jobIds": [id] }));
            }
            4 if !delegated.is_empty() => {
                let ids = [pick(&mut next, &delegated), pick(&mut next, &delegated)];
                core.reorder_queue(&ids);
            }
            5 if !delegated.is_empty() => {
                let id = pick(&mut next, &delegated);
                core.clear_finished(std::slice::from_ref(&id));
            }
            6 => core.set_concurrency_limit(1 + next(4) as usize),
            7 if !delegated.is_empty() => {
                // Refused for a job with no thread yet; the state must be left as it was.
                let id = pick(&mut next, &delegated);
                let mut arguments = serde_json::Map::new();
                arguments.insert("jobId".into(), json!(id));
                arguments.insert("message".into(), json!("more"));
                let _ = orchestrator_core::call_tool(&core, "alethe_send", &arguments, None);
            }
            _ => {}
        }
        let problems = core.audit();
        assert!(problems.is_empty(), "after step {step}: {problems:?}");
        let (running, queued) = core.counts();
        let limit = core.snapshot()["concurrencyLimit"].as_u64().expect("limit") as usize;
        assert!(
            queued == 0 || running >= limit,
            "after step {step}: {queued} waiting with {running}/{limit} slots taken"
        );
    }

    call(&core, "alethe_cancel", json!({ "jobIds": delegated }));
    assert_eq!(core.counts(), (0, 0));
    assert!(core.audit().is_empty(), "{:?}", core.audit());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_planner_with_its_own_routing_is_routed_by_it() {
    let dir = workspace("planner-routing");
    let core = Core::default();
    let mut claude = silent_launcher();
    claude.kind = "claude".into();
    core.set_launcher(claude);
    core.set_launcher(silent_launcher());
    assert_eq!(
        core.snapshot()["installedAgents"],
        json!(["claude", "codex"])
    );
    core.set_planner_routing(
        "planner-a",
        Some(json!({ "tiers": { "standard": [{ "agent": "claude", "model": "sonnet", "effort": "high" }] } })),
    );
    let task = json!({
        "tasks": [{ "task": "fix the parser", "kind": "code", "complexity": "standard" }],
        "cwd": dir.to_string_lossy()
    });

    let own = call_as(&core, "planner-a", "alethe_delegate", task.clone());
    assert_eq!(own["jobs"][0]["agent"], "claude", "{own}");
    assert_eq!(own["jobs"][0]["effort"], "high", "{own}");
    let shared = call_as(&core, "planner-b", "alethe_delegate", task.clone());
    assert_eq!(shared["jobs"][0]["agent"], "codex", "{shared}");

    // Taking the profile back puts the planner on the shared routing again.
    core.set_planner_routing("planner-a", None);
    let back = call_as(&core, "planner-a", "alethe_delegate", task);
    assert_eq!(back["jobs"][0]["agent"], "codex", "{back}");

    let ids: Vec<Value> = [own, shared, back]
        .iter()
        .map(|delegated| delegated["jobs"][0]["id"].clone())
        .collect();
    let _ = call(&core, "alethe_cancel", json!({ "jobIds": ids }));
    let _ = std::fs::remove_dir_all(&dir);
}

#[cfg(unix)]
#[test]
fn a_codex_turn_that_fails_is_reported_as_a_failure_with_codexs_reason() {
    let dir = workspace("codex-turn-failed");
    let core = Core::default();
    core.set_launcher(scripted_worker(
        &dir,
        "codex",
        "",
        &format!(
            r#"{CODEX_THREAD}
elif m.get("method") == "turn/start":
    send({{"method": "turn/started", "params": {{"threadId": "t-1", "turn": {{"id": "turn-1", "items": [], "status": "inProgress"}}}}}})
    send({{"method": "error", "params": {{"threadId": "t-1", "turnId": "turn-1", "willRetry": True, "error": {{"message": "stream disconnected"}}}}}})
    send({{"method": "turn/completed", "params": {{"threadId": "t-1", "turn": {{"id": "turn-1", "items": [], "status": "failed", "error": {{"message": "You've hit your usage limit.", "codexErrorInfo": "usageLimitExceeded"}}}}}}}})"#
        ),
    ));

    call(
        &core,
        "alethe_delegate",
        json!({ "tasks": ["anything"], "cwd": dir.to_string_lossy() }),
    );
    let job = wait_for_job(&core, "job-01", |job| {
        job["status"] != "running" && job["status"] != "queued"
    });

    assert_eq!(job["status"], "failed", "{job}");
    assert_eq!(job["outcome"], "failed", "{job}");
    let summary = job["summary"].as_str().unwrap_or_default();
    assert!(
        summary.ends_with("You've hit your usage limit. [usageLimitExceeded]"),
        "{summary}"
    );
    // What Codex resolved for the thread, which nobody chose here.
    assert_eq!(job["model"], "gpt-test");
    assert_eq!(job["effort"], "high");
    let _ = std::fs::remove_dir_all(&dir);
}

#[cfg(unix)]
#[test]
fn a_codex_worker_whose_thread_cannot_open_fails_instead_of_hanging() {
    let dir = workspace("codex-thread-error");
    let core = Core::default();
    core.set_launcher(scripted_worker(
        &dir,
        "codex",
        "",
        r#"if m.get("method") == "thread/start":
    send({"id": m["id"], "error": {"code": -32600, "message": "model gpt-nope is not supported"}})"#,
    ));

    call(
        &core,
        "alethe_delegate",
        json!({ "tasks": ["anything"], "cwd": dir.to_string_lossy() }),
    );
    let job = wait_for_job(&core, "job-01", |job| job["status"] == "failed");

    assert_eq!(
        job["summary"],
        "thread/start failed: model gpt-nope is not supported"
    );
    assert_eq!(core.counts(), (0, 0), "the slot is given back");
    let _ = std::fs::remove_dir_all(&dir);
}

#[cfg(unix)]
#[test]
fn stopping_a_codex_turn_from_an_approval_sends_cancel_and_says_who_stopped_it() {
    let dir = workspace("codex-approvals");
    let core = Core::default();
    core.set_launcher(scripted_worker(
        &dir,
        "codex",
        "",
        &format!(
            r#"{CODEX_THREAD}
elif m.get("method") == "turn/start":
    send({{"method": "turn/started", "params": {{"threadId": "t-1", "turn": {{"id": "turn-1", "items": [], "status": "inProgress"}}}}}})
    send({{"method": "item/started", "params": {{"threadId": "t-1", "turnId": "turn-1", "item": {{"type": "fileChange", "id": "item-1", "status": "inProgress", "changes": [{{"path": "src/a.rs", "kind": {{"type": "update"}}, "diff": ""}}]}}}}}})
    send({{"id": 0, "method": "item/fileChange/requestApproval", "params": {{"threadId": "t-1", "turnId": "turn-1", "itemId": "item-1", "reason": "outside the sandbox"}}}})
    send({{"id": 1, "method": "item/commandExecution/requestApproval", "params": {{"threadId": "t-1", "turnId": "turn-1", "itemId": "item-2", "command": "curl example.com"}}}})
elif "method" not in m and m.get("id") == 0:
    record("answer.json", m)
    send({{"method": "serverRequest/resolved", "params": {{"threadId": "t-1", "requestId": 1}}}})
    send({{"method": "turn/completed", "params": {{"threadId": "t-1", "turn": {{"id": "turn-1", "items": [], "status": "interrupted"}}}}}})"#
        ),
    ));

    let delegated = call(
        &core,
        "alethe_delegate",
        json!({ "tasks": ["anything"], "cwd": dir.to_string_lossy(), "askForApproval": true }),
    );
    assert_eq!(delegated["askForApproval"], json!(true));
    let blocked = wait_for_job(&core, "job-01", |job| job["waitingApprovals"] == json!(2));
    assert_eq!(blocked["status"], "blocked");
    assert_eq!(blocked["pendingApproval"]["kind"], "fileChange");
    assert_eq!(blocked["pendingApproval"]["files"], json!(["src/a.rs"]));

    // The tool still takes the old name for it; Codex only knows `cancel`.
    core.answer("job-01", "abort").expect("answered");
    assert_eq!(
        recorded(&dir, "answer.json")["result"]["decision"],
        "cancel"
    );

    let job = wait_for_job(&core, "job-01", |job| job["status"] == "failed");
    assert_eq!(job["outcome"], "interrupted", "{job}");
    assert_eq!(
        job["pendingApproval"],
        Value::Null,
        "the withdrawn question is gone"
    );
    assert_eq!(
        job["summary"],
        "The person stopped this turn instead of approving it."
    );
    assert_eq!(core.counts(), (0, 0));
    let _ = std::fs::remove_dir_all(&dir);
}

#[cfg(unix)]
#[test]
fn time_spent_waiting_on_a_person_does_not_count_against_the_budget() {
    let dir = workspace("blocked-budget");
    let core = Core::default();
    core.set_launcher(scripted_worker(
        &dir,
        "codex",
        "import time",
        &format!(
            r#"{CODEX_THREAD}
elif m.get("method") == "turn/start":
    send({{"method": "turn/started", "params": {{"threadId": "t-1", "turn": {{"id": "turn-1", "items": [], "status": "inProgress"}}}}}})
    send({{"id": 0, "method": "item/commandExecution/requestApproval", "params": {{"threadId": "t-1", "turnId": "turn-1", "itemId": "item-1", "command": "make deploy"}}}})
elif "method" not in m and m.get("id") == 0:
    time.sleep(0.3)
    send({{"method": "item/completed", "params": {{"threadId": "t-1", "turnId": "turn-1", "item": {{"type": "agentMessage", "id": "msg", "text": "DEPLOYED"}}}}}})
    send({{"method": "turn/completed", "params": {{"threadId": "t-1", "turn": {{"id": "turn-1", "items": [], "status": "completed"}}}}}})"#
        ),
    ));

    call(
        &core,
        "alethe_delegate",
        json!({
            "tasks": ["deploy"],
            "cwd": dir.to_string_lossy(),
            "askForApproval": true,
            "timeoutSeconds": 1
        }),
    );
    wait_for_job(&core, "job-01", |job| job["status"] == "blocked");
    // Twice the budget passes while the question is open.
    thread::sleep(Duration::from_millis(2_200));
    assert_eq!(core.snapshot()["jobs"][0]["status"], "blocked");

    core.answer("job-01", "accept").expect("answered");
    let job = wait_for_job(&core, "job-01", |job| {
        job["status"] != "running" && job["status"] != "blocked"
    });
    assert_eq!(job["status"], "done", "{job}");
    assert_eq!(job["summary"], "DEPLOYED");
    let _ = std::fs::remove_dir_all(&dir);
}

#[cfg(unix)]
const CLAUDE_ASKING: &str = r#"if m.get("type") == "user":
    send({"type": "control_request", "request_id": "perm-1", "request": {"subtype": "can_use_tool", "tool_name": "Bash", "display_name": "Bash", "input": {"command": "npm test", "description": "Run the tests"}, "permission_suggestions": [{"type": "addRules", "rules": [{"toolName": "Bash", "ruleContent": "npm test:*"}], "behavior": "allow", "destination": "localSettings"}, {"type": "setMode", "mode": "bypassPermissions", "destination": "session"}]}})
    send({"type": "control_request", "request_id": "hook-1", "request": {"subtype": "hook_callback", "callback_id": "cb"}})
elif m.get("type") == "control_response":
    record(m["response"]["request_id"] + ".json", m)
    if m["response"]["request_id"] == "perm-1":
        decision = m["response"]["response"]
        if decision.get("behavior") == "allow":
            send({"type": "result", "is_error": False, "result": "TESTS PASS", "usage": {"input_tokens": 1, "output_tokens": 1}})
        else:
            send({"type": "result", "is_error": True, "result": "", "usage": {"input_tokens": 1, "output_tokens": 1}})"#;

#[cfg(unix)]
const CLAUDE_INIT: &str = r#"send({"type": "system", "subtype": "init", "session_id": "c-1", "model": "claude-test-model"})"#;

#[cfg(unix)]
#[test]
fn a_claude_worker_that_asks_routes_its_permission_prompt_to_the_board() {
    let dir = workspace("claude-asks");
    let core = Core::default();
    core.set_launcher(scripted_worker(&dir, "claude", CLAUDE_INIT, CLAUDE_ASKING));

    call(
        &core,
        "alethe_delegate",
        json!({
            "tasks": ["run the tests"],
            "cwd": dir.to_string_lossy(),
            "agent": "claude",
            "askForApproval": true
        }),
    );
    let argv = recorded(&dir, "argv.json");
    assert_eq!(
        argv,
        json!([
            "--permission-mode",
            "acceptEdits",
            "--permission-prompt-tool",
            "stdio"
        ])
    );

    let blocked = wait_for_job(&core, "job-01", |job| job["status"] == "blocked");
    assert_eq!(blocked["pendingApproval"]["kind"], "command");
    assert_eq!(blocked["pendingApproval"]["command"], "npm test");
    assert_eq!(blocked["pendingApproval"]["reason"], "Run the tests");
    assert_eq!(blocked["model"], "claude-test-model");
    // A request the board has no answer for is refused at once instead of hanging the worker.
    assert_eq!(
        recorded(&dir, "hook-1.json")["response"]["subtype"],
        "error"
    );

    core.answer("job-01", "acceptForSession").expect("answered");
    let reply = recorded(&dir, "perm-1.json");
    let verdict = &reply["response"]["response"];
    assert_eq!(reply["response"]["subtype"], "success");
    assert_eq!(verdict["behavior"], "allow");
    assert_eq!(
        verdict["updatedInput"],
        json!({ "command": "npm test", "description": "Run the tests" })
    );
    // Only the rule, kept to this session; the mode switch it also suggested is left out.
    assert_eq!(
        verdict["updatedPermissions"],
        json!([{ "type": "addRules", "rules": [{ "toolName": "Bash", "ruleContent": "npm test:*" }], "behavior": "allow", "destination": "session" }])
    );

    let job = wait_for_job(&core, "job-01", |job| job["status"] == "done");
    assert_eq!(job["summary"], "TESTS PASS");
    let _ = std::fs::remove_dir_all(&dir);
}

#[cfg(unix)]
#[test]
fn stopping_a_claude_turn_from_an_approval_is_reported_as_the_persons_decision() {
    let dir = workspace("claude-stopped");
    let core = Core::default();
    core.set_launcher(scripted_worker(&dir, "claude", CLAUDE_INIT, CLAUDE_ASKING));

    call(
        &core,
        "alethe_delegate",
        json!({
            "tasks": ["run the tests"],
            "cwd": dir.to_string_lossy(),
            "agent": "claude",
            "askForApproval": true
        }),
    );
    wait_for_job(&core, "job-01", |job| job["status"] == "blocked");
    core.answer("job-01", "cancel").expect("answered");

    let verdict = &recorded(&dir, "perm-1.json")["response"]["response"];
    assert_eq!(verdict["behavior"], "deny");
    assert_eq!(verdict["interrupt"], json!(true));
    let job = wait_for_job(&core, "job-01", |job| job["status"] == "failed");
    assert_eq!(job["outcome"], "interrupted", "{job}");
    assert_eq!(
        job["summary"],
        "The person stopped this turn instead of approving it."
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn cancelling_queued_work_keeps_it_from_starting_and_frees_no_slot_it_never_had() {
    let core = Core::default();
    core.set_launcher(silent_launcher());
    core.set_concurrency_limit(1);

    call(
        &core,
        "alethe_delegate",
        json!({ "tasks": ["first", "second"], "cwd": ".", "agent": "codex" }),
    );
    assert_eq!(core.counts(), (1, 1));

    let cancelled = call(&core, "alethe_cancel", json!({ "jobIds": ["job-02"] }));
    assert_eq!(cancelled["cancelled"], json!(["job-02"]));
    assert_eq!(
        core.counts(),
        (1, 0),
        "the running worker still holds its slot"
    );

    call(&core, "alethe_cancel", json!({ "jobIds": ["job-01"] }));
    thread::sleep(Duration::from_millis(200));
    assert_eq!(core.counts(), (0, 0), "the cancelled job never started");
    assert_eq!(core.snapshot()["jobs"][1]["status"], "cancelled");

    let again = call(
        &core,
        "alethe_cancel",
        json!({ "jobIds": ["job-01", "job-99"] }),
    );
    assert_eq!(again["cancelled"], json!([]));
    assert_eq!(again["alreadySettled"], json!(["job-01"]));
    assert_eq!(again["unknown"], json!(["job-99"]));
}

#[test]
fn releasing_a_worker_that_is_still_running_is_refused() {
    let core = Core::default();
    core.set_launcher(silent_launcher());

    call(
        &core,
        "alethe_delegate",
        json!({ "tasks": ["busy"], "cwd": ".", "agent": "codex" }),
    );
    let released = call(&core, "alethe_release", json!({ "jobIds": ["job-01"] }));
    assert_eq!(released["released"], json!([]));
    assert_eq!(released["stillBusy"], json!(["job-01"]));
    assert_eq!(core.counts(), (1, 0), "its slot is still counted");
    call(&core, "alethe_cancel", json!({ "jobIds": ["job-01"] }));
    assert_eq!(core.counts(), (0, 0));
}

#[cfg(unix)]
#[test]
fn the_persons_rules_win_over_what_the_planner_asked_for() {
    let dir = workspace("policy");
    let core = Core::default();
    core.set_launcher(argv_recording_launcher(&dir, "claude", CLAUDE_DONE));
    core.set_policy(WorkerPolicy {
        default_agent: "claude".into(),
        timeout_ms: Some(120_000),
        approvals: "always".into(),
        isolation: "planner".into(),
        web_search: "never".into(),
        parked_limit: 4,
        codex_sandbox: "workspace-write".into(),
    });

    let delegated = call(
        &core,
        "alethe_delegate",
        json!({ "tasks": ["anything"], "cwd": dir.to_string_lossy(), "webSearch": true }),
    );

    assert_eq!(delegated["agent"], "claude", "{delegated}");
    assert_eq!(delegated["askForApproval"], json!(true));
    assert_eq!(delegated["webSearch"], json!(false));
    assert_eq!(delegated["timeoutSeconds"], json!(120));
    assert_eq!(
        &recorded_argv(&dir)[..2],
        ["--permission-mode", "acceptEdits"]
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn required_isolation_outside_a_repository_says_where_to_change_it() {
    let dir = workspace("policy-isolation");
    let core = Core::default();
    core.set_policy(WorkerPolicy {
        isolation: "always".into(),
        ..WorkerPolicy::default()
    });

    let refused = call(
        &core,
        "alethe_delegate",
        json!({ "tasks": ["anything"], "cwd": dir.to_string_lossy() }),
    );

    let error = refused["error"].as_str().unwrap_or_default();
    assert!(error.contains("Preferences"), "{refused}");
    assert_eq!(core.snapshot()["jobs"], json!([]));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_rule_from_a_newer_version_never_loosens_into_something_else() {
    let policy = WorkerPolicy {
        default_agent: "gemini".into(),
        timeout_ms: Some(1),
        approvals: "sometimes".into(),
        isolation: "maybe".into(),
        web_search: "always".into(),
        parked_limit: 99,
        codex_sandbox: "no-sandbox".into(),
    }
    .sanitized();

    assert_eq!(policy.default_agent, "auto");
    assert_eq!(policy.timeout_ms, Some(60_000));
    assert_eq!(policy.approvals, "planner");
    assert_eq!(policy.isolation, "planner");
    assert_eq!(policy.web_search, "planner");
    assert_eq!(policy.parked_limit, 8);
    assert_eq!(policy.codex_sandbox, "workspace-write");
}

#[cfg(unix)]
#[test]
fn a_finished_worker_past_the_kept_limit_keeps_its_outcome_and_comes_back_on_its_thread() {
    let dir = workspace("parked-limit");
    let core = Core::default();
    core.set_launcher(slow_follow_up_claude(0.0));
    core.set_policy(WorkerPolicy {
        parked_limit: 0,
        ..WorkerPolicy::default()
    });

    call(
        &core,
        "alethe_delegate",
        json!({ "tasks": ["first"], "cwd": dir.to_string_lossy(), "agent": "claude" }),
    );
    let job = wait_for_job(&core, "job-01", |job| job["status"] == "done");
    let job = if job["live"] == json!(false) {
        job
    } else {
        wait_for_job(&core, "job-01", |job| job["live"] == json!(false))
    };
    assert_eq!(job["outcome"], "succeeded");

    let sent = call(
        &core,
        "alethe_send",
        json!({ "jobId": "job-01", "message": "second" }),
    );
    assert_eq!(sent["revived"], json!(true), "{sent}");
    let job = wait_for_job(&core, "job-01", |job| {
        job["status"] == "done" && job["summary"] == "TURN 1"
    });
    assert_eq!(job["threadId"], "slow-1");
    let _ = std::fs::remove_dir_all(&dir);
}

#[cfg(unix)]
#[test]
fn a_message_to_a_parked_worker_waits_for_a_slot_instead_of_being_refused() {
    let dir = workspace("parked-queue");
    let core = Core::default();
    core.set_launcher(slow_follow_up_claude(0.0));

    call(
        &core,
        "alethe_delegate",
        json!({ "tasks": ["first"], "cwd": dir.to_string_lossy(), "agent": "claude" }),
    );
    wait_for_job(&core, "job-01", |job| {
        job["status"] == "done" && job["live"] == json!(true)
    });

    core.set_launcher(silent_launcher());
    core.set_concurrency_limit(1);
    call(
        &core,
        "alethe_delegate",
        json!({ "tasks": ["busy"], "cwd": ".", "agent": "codex" }),
    );
    let sent = call(
        &core,
        "alethe_send",
        json!({ "jobId": "job-01", "message": "second" }),
    );
    assert_eq!(sent["waitingForSlot"], json!(true), "{sent}");
    assert_eq!(core.snapshot()["jobs"][0]["status"], "queued");

    call(&core, "alethe_cancel", json!({ "jobIds": ["job-02"] }));
    let job = wait_for_job(&core, "job-01", |job| {
        job["status"] == "done" && job["summary"] == "TURN 2"
    });
    assert_eq!(job["live"], json!(true), "the same process took the turn");
    let _ = std::fs::remove_dir_all(&dir);
}

#[cfg(unix)]
#[test]
fn a_parked_worker_that_exits_while_its_message_waits_for_a_slot_still_gets_the_message() {
    let dir = workspace("parked-exit-queued");
    let core = Core::default();
    core.set_launcher(scripted_worker(
        &dir,
        "claude",
        r#"import threading, time
def leave_when_told():
    quit = os.path.join(out, "quit")
    while not os.path.exists(quit):
        time.sleep(0.02)
    os.remove(quit)
    os._exit(0)
threading.Thread(target=leave_when_told, daemon=True).start()"#,
        r#"if m.get("type") == "user":
    send({"type": "system", "subtype": "init", "session_id": "c-1"})
    send({"type": "result", "is_error": False, "result": "GOT " + m["message"]["content"][0]["text"]})"#,
    ));

    call(
        &core,
        "alethe_delegate",
        json!({ "tasks": ["first"], "cwd": dir.to_string_lossy(), "agent": "claude" }),
    );
    wait_for_job(&core, "job-01", |job| {
        job["status"] == "done" && job["live"] == json!(true)
    });

    core.set_launcher(silent_launcher());
    core.set_concurrency_limit(1);
    call(
        &core,
        "alethe_delegate",
        json!({ "tasks": ["busy"], "cwd": ".", "agent": "codex" }),
    );
    let sent = call(
        &core,
        "alethe_send",
        json!({ "jobId": "job-01", "message": "second" }),
    );
    assert_eq!(sent["waitingForSlot"], json!(true), "{sent}");

    std::fs::write(dir.join("quit"), "").unwrap();
    let job = wait_for_job(&core, "job-01", |job| job["live"] == json!(false));
    assert_eq!(job["status"], "queued", "the message is still owed: {job}");

    call(&core, "alethe_cancel", json!({ "jobIds": ["job-02"] }));
    let job = wait_for_job(&core, "job-01", |job| job["status"] == "done");
    assert_eq!(job["summary"], "GOT second");
    assert_eq!(core.counts(), (0, 0));
    let _ = std::fs::remove_dir_all(&dir);
}

#[cfg(unix)]
#[test]
fn a_long_reply_in_a_script_with_wide_characters_never_takes_the_worker_down() {
    let dir = workspace("wide-reply");
    let core = Core::default();
    // Three bytes a character, so trimming the reply to its byte limit lands inside one.
    let wide = "€".repeat(5_400);
    let transcript = format!(
        "{}\n{}\n{}\n",
        json!({ "type": "system", "subtype": "init", "session_id": "wide" }),
        json!({ "type": "assistant", "message": { "content": [{ "type": "text", "text": wide }] } }),
        json!({ "type": "result", "is_error": false, "result": "WIDE DONE", "usage": { "input_tokens": 1, "output_tokens": 1 } }),
    );
    core.set_launcher(fake_claude_launcher(&dir, &transcript));

    call(
        &core,
        "alethe_delegate",
        json!({ "tasks": ["anything"], "cwd": dir.to_string_lossy(), "agent": "claude" }),
    );

    let job = wait_for_job(&core, "job-01", |job| job["status"] == "done");
    assert_eq!(job["summary"], "WIDE DONE");
    let _ = std::fs::remove_dir_all(&dir);
}

#[cfg(unix)]
#[test]
fn a_codex_worker_gets_web_search_through_the_key_codex_reads() {
    for (asked, expected) in [(true, "live"), (false, "disabled")] {
        let dir = workspace(&format!("codex-web-search-{asked}"));
        let core = Core::default();
        core.set_launcher(scripted_worker(
            &dir,
            "codex",
            "",
            r#"if m.get("method") in ("thread/start", "thread/resume"):
    record("thread.json", m["params"])"#,
        ));

        call(
            &core,
            "alethe_delegate",
            json!({ "tasks": ["research"], "cwd": dir.to_string_lossy(), "webSearch": asked }),
        );

        let params = recorded(&dir, "thread.json");
        assert_eq!(params["config"]["web_search"], json!(expected), "{params}");
        assert_eq!(params["config"].get("tools"), None, "{params}");
        call(&core, "alethe_cancel", json!({ "jobIds": ["job-01"] }));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
