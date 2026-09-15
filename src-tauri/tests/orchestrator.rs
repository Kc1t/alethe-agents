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

/// One check blocks for at most 45 seconds, so waiting on real workers means calling again,
/// acknowledging what already arrived, until nothing is left running.
fn check_until_settled(core: &Core) -> (Value, Vec<Value>) {
    let mut deliveries = Vec::new();
    let mut ack = Value::Null;
    loop {
        let checked = call(core, "alethe_check", json!({ "wait": true, "ack": ack }));
        deliveries.extend(checked["deliveries"].as_array().expect("deliveries").iter().cloned());
        ack = checked["ack"].clone();
        if checked["workersStillBusy"] == json!(0) {
            return (checked, deliveries);
        }
    }
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
fn the_handshake_tells_the_planner_it_is_inside_alethe() {
    let core = Core::default();
    core.set_launcher(silent_launcher());
    let initialized = rpc(&core, 1, "initialize", json!({}));
    let text = initialized["result"]["instructions"]
        .as_str()
        .expect("server instructions");

    assert!(text.contains("inside Alethe"), "{text}");
    assert!(text.contains("alethe_delegate"), "{text}");
    assert!(text.contains("Workers available now: codex."), "{text}");
    assert!(text.contains("Up to 4 run at once"), "{text}");
}

#[test]
fn with_no_worker_configured_the_instructions_say_delegation_will_fail() {
    let core = Core::default();
    let initialized = rpc(&core, 1, "initialize", json!({}));
    let text = initialized["result"]["instructions"]
        .as_str()
        .expect("server instructions");

    assert!(!text.contains("Workers available now"), "{text}");
    assert!(text.contains("No worker is configured"), "{text}");
}

#[test]
fn the_guide_tool_answers_in_plain_markdown() {
    let core = Core::default();
    let listed = rpc(&core, 1, "tools/list", json!({}));
    assert!(
        listed["result"]["tools"]
            .as_array()
            .expect("tools")
            .iter()
            .any(|tool| tool["name"] == "alethe_guide"),
        "{listed}"
    );

    let response = rpc(
        &core,
        2,
        "tools/call",
        json!({ "name": "alethe_guide", "arguments": {} }),
    );
    let text = response["result"]["content"][0]["text"]
        .as_str()
        .expect("guide text");
    let opening: String = text.chars().take(80).collect();
    assert!(text.starts_with("# "), "markdown, not an escaped JSON string: {opening}");
    assert!(text.contains("Preferences"), "{opening}");
    assert!(text.contains("orchestration board"), "{opening}");
}

#[test]
fn the_instructions_send_questions_about_alethe_to_the_guide() {
    let core = Core::default();
    let initialized = rpc(&core, 1, "initialize", json!({}));
    let text = initialized["result"]["instructions"]
        .as_str()
        .expect("server instructions");
    assert!(text.contains("alethe_guide"), "{text}");
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
fn a_delivery_stays_until_the_planner_acknowledges_it() {
    let core = Core::default();
    let dir = workspace("ack");
    call(
        &core,
        "alethe_delegate",
        json!({ "cwd": dir.to_string_lossy(), "tasks": ["anything"] }),
    );

    let first = call(&core, "alethe_check", json!({ "wait": true, "timeoutMs": 5000 }));
    let seq = first["deliveries"][0]["seq"].as_u64().expect("a delivery");
    assert_eq!(first["deliveries"][0]["repeat"], json!(false), "{first}");
    assert_eq!(first["ack"], json!(seq), "the response names what to acknowledge: {first}");

    // The client gave up before that response arrived, so the planner never saw it.
    let retried = call(&core, "alethe_check", json!({}));
    let again = retried["deliveries"].as_array().expect("deliveries");
    assert_eq!(again.len(), 1, "an unacknowledged delivery was dropped: {retried}");
    assert_eq!(again[0]["seq"], json!(seq), "{retried}");
    assert_eq!(again[0]["repeat"], json!(true), "{retried}");

    let acked = call(&core, "alethe_check", json!({ "ack": seq }));
    assert_eq!(
        acked["deliveries"].as_array().expect("deliveries").len(),
        0,
        "an acknowledged delivery came back: {acked}"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
#[ignore = "waits out the whole cap, about 45 seconds"]
fn a_blocking_check_returns_before_the_mcp_client_gives_up() {
    let core = Core::default();
    core.set_launcher(silent_launcher());
    let dir = workspace("cap");
    call(
        &core,
        "alethe_delegate",
        json!({ "cwd": dir.to_string_lossy(), "tasks": ["hold"], "timeoutSeconds": 120 }),
    );

    let started = std::time::Instant::now();
    let checked = call(&core, "alethe_check", json!({ "wait": true, "timeoutMs": 600000 }));
    let waited = started.elapsed();

    // Claude Code drops an MCP call somewhere past 45 seconds. A check still blocked by then
    // answers into a closed connection, and whatever it handed out is lost with it.
    assert!(waited < Duration::from_secs(50), "blocked for {waited:?}: {checked}");
    assert_eq!(checked["workersStillBusy"], json!(1), "{checked}");

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn an_unacknowledged_delivery_does_not_cut_short_a_wait_for_the_next_one() {
    let core = Core::default();
    core.set_launcher(silent_launcher());
    let dir = workspace("stale");
    // One worker holds its slot; the other fails at once, since no Claude launcher is set.
    call(
        &core,
        "alethe_delegate",
        json!({ "cwd": dir.to_string_lossy(), "tasks": ["hold"], "timeoutSeconds": 120 }),
    );
    call(
        &core,
        "alethe_delegate",
        json!({ "cwd": dir.to_string_lossy(), "agent": "claude", "tasks": ["fail"] }),
    );

    let wait_for_first = json!({ "wait": true, "untilAllSettled": false, "timeoutMs": 2000 });
    let first = call(&core, "alethe_check", wait_for_first.clone());
    assert_eq!(first["deliveries"].as_array().expect("deliveries").len(), 1, "{first}");

    let started = std::time::Instant::now();
    let second = call(&core, "alethe_check", wait_for_first);
    assert!(
        started.elapsed() >= Duration::from_millis(1500),
        "returned at once on a delivery it had already handed out: {second}"
    );

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

    let (checked, deliveries) = check_until_settled(&core);
    let peak = watcher.finish();

    assert_eq!(
        checked["workersStillBusy"],
        json!(0),
        "untilAllSettled returned early: {checked}"
    );
    assert_eq!(deliveries.len(), 2, "both workers must land: {deliveries:?}");
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

    let (_, deliveries) = check_until_settled(&core);
    let peak = watcher.finish();

    assert_eq!(peak, 2, "the limit was breached, peak was {peak}");
    assert_eq!(deliveries.len(), 4, "every queued job must drain: {deliveries:?}");

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

/// Emits a transcript and then holds the process open, so the job stays mid-turn while the test
/// exercises a control message against it.
fn fake_claude_holding_launcher(dir: &std::path::Path, transcript: &str) -> Launcher {
    let path = dir.join("holding.jsonl");
    std::fs::write(&path, transcript).expect("write fake transcript");
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
    Launcher {
        kind: "claude".into(),
        program: PathBuf::from("cmd"),
        args: vec!["/c".into(), script.to_string_lossy().into_owned()],
        env: Vec::new(),
    }
}

#[test]
fn steering_a_running_claude_worker_interrupts_instead_of_waiting_out_the_turn() {
    let dir = workspace("claude-steer-live");
    let core = Core::default();
    let transcript = concat!(
        r#"{"type":"system","subtype":"init","session_id":"steer-session"}"#, "\n",
        r#"{"type":"assistant","message":{"content":[{"type":"text","text":"heading the wrong way"}]}}"#, "\n",
    );
    core.set_launcher(fake_claude_holding_launcher(&dir, transcript));

    call(
        &core,
        "alethe_delegate",
        json!({ "tasks": ["go somewhere"], "cwd": dir.to_string_lossy(), "agent": "claude" }),
    );
    std::thread::sleep(std::time::Duration::from_millis(600));

    let job_id = core.snapshot()["jobs"][0]["id"].as_str().expect("a job id").to_string();
    assert_eq!(core.snapshot()["jobs"][0]["status"], "running");

    let steered = call(
        &core,
        "alethe_steer",
        json!({ "jobId": &job_id, "message": "turn around" }),
    );
    assert_eq!(steered["steered"], json!(job_id), "{steered}");
    assert!(steered.get("queued").is_none(), "the steer only queued: {steered}");
    assert_eq!(
        core.snapshot()["jobs"][0]["status"], "running",
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
        r#"{"type":"system","subtype":"init","session_id":"idle-session"}"#, "\n",
        r#"{"type":"result","is_error":false,"result":"CLAUDE_DONE_OK"}"#, "\n",
    );
    core.set_launcher(fake_claude_launcher(&dir, transcript));

    call(
        &core,
        "alethe_delegate",
        json!({ "tasks": ["finish quickly"], "cwd": dir.to_string_lossy(), "agent": "claude" }),
    );
    std::thread::sleep(std::time::Duration::from_millis(500));

    let job_id = core.snapshot()["jobs"][0]["id"].as_str().expect("a job id").to_string();
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
    core.set_agent_fitness("claude", json!({ "worst": "week", "used": 19, "rateLimited": false }));
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
    core.set_agent_fitness("claude", json!({ "worst": "week", "used": 19, "rateLimited": false }));
    core.set_agent_fitness("codex", json!({ "worst": "week", "used": 60, "rateLimited": false }));

    let status = call(&core, "alethe_status", json!({}));
    assert_eq!(status["fitness"]["headroom"], "claude", "{status}");
}

#[test]
fn delegating_to_an_exhausted_agent_names_the_other_side() {
    let dir = workspace("headroom-hint");
    let core = Core::default();
    core.set_launcher(silent_launcher());
    core.set_agent_fitness("claude", json!({ "worst": "week", "used": 12, "rateLimited": false }));
    core.set_agent_fitness("codex", json!({ "worst": "week", "used": 91, "rateLimited": false }));

    let delegated = call(
        &core,
        "alethe_delegate",
        json!({ "tasks": ["something"], "cwd": dir.to_string_lossy(), "agent": "codex" }),
    );
    assert_eq!(delegated["headroomHint"]["agent"], "claude", "{delegated}");
    let reason = delegated["headroomHint"]["reason"].as_str().unwrap_or_default();
    assert!(reason.contains("91"), "the hint hides the number it is grounded in: {reason}");

    let _ = call(&core, "alethe_cancel", json!({ "jobIds": [delegated["jobs"][0]["id"].clone()] }));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_rested_agent_gets_no_hint() {
    let dir = workspace("headroom-quiet");
    let core = Core::default();
    core.set_launcher(silent_launcher());
    core.set_agent_fitness("claude", json!({ "worst": "week", "used": 12, "rateLimited": false }));
    core.set_agent_fitness("codex", json!({ "worst": "week", "used": 40, "rateLimited": false }));

    let delegated = call(
        &core,
        "alethe_delegate",
        json!({ "tasks": ["something"], "cwd": dir.to_string_lossy(), "agent": "codex" }),
    );
    assert!(
        delegated.get("headroomHint").is_none(),
        "nagged about headroom that is not running out: {delegated}"
    );

    let _ = call(&core, "alethe_cancel", json!({ "jobIds": [delegated["jobs"][0]["id"].clone()] }));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn the_board_records_why_a_worker_ran_where_it_ran() {
    let dir = workspace("routing-trace");
    let core = Core::default();
    core.set_launcher(silent_launcher());
    core.set_agent_fitness("claude", json!({ "worst": "week", "used": 12, "rateLimited": false }));
    core.set_agent_fitness("codex", json!({ "worst": "week", "used": 91, "rateLimited": false }));

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

    let first = ignored["jobs"][0]["id"].as_str().expect("an id").to_string();
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
    core.set_agent_fitness("claude", json!({ "worst": "week", "used": 12, "rateLimited": false }));
    core.set_agent_fitness("codex", json!({ "worst": "week", "used": 40, "rateLimited": false }));

    let delegated = call(
        &core,
        "alethe_delegate",
        json!({ "tasks": ["nothing notable"], "cwd": dir.to_string_lossy(), "agent": "codex" }),
    );
    let id = delegated["jobs"][0]["id"].as_str().expect("an id").to_string();
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
fn with_both_sides_strained_the_board_blames_the_worse_one_every_time() {
    let dir = workspace("routing-both-strained");
    let core = Core::default();
    core.set_launcher(silent_launcher());
    // The reading that came back from a real run: both past the threshold, codex worse.
    core.set_agent_fitness("claude", json!({ "worst": "5h", "used": 80, "rateLimited": false }));
    core.set_agent_fitness("codex", json!({ "worst": "5h", "used": 98, "rateLimited": false }));

    let mut ids = Vec::new();
    for _ in 0..5 {
        let delegated = call(
            &core,
            "alethe_delegate",
            json!({ "tasks": ["work"], "cwd": dir.to_string_lossy(), "agent": "codex" }),
        );
        let id = delegated["jobs"][0]["id"].as_str().expect("an id").to_string();
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
    core.set_agent_fitness("claude", json!({ "worst": "5h", "used": 80, "rateLimited": false }));
    core.set_agent_fitness("codex", json!({ "worst": "5h", "used": 98, "rateLimited": false }));

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

    let _ = call(&core, "alethe_cancel", json!({ "jobIds": [delegated["jobs"][0]["id"].clone()] }));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_rate_limited_agent_outranks_any_percentage() {
    let core = Core::default();
    core.set_agent_fitness("claude", json!({ "worst": "5h", "used": 99, "rateLimited": false }));
    core.set_agent_fitness("codex", json!({ "worst": "5h", "used": 10, "rateLimited": true }));

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
