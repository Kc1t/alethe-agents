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

use orchestrator_core::{handle_mcp_body, Core, Launcher, RuleSet, ShellHost};

fn rpc(core: &Core, id: u32, method: &str, params: Value) -> Value {
    rpc_as(core, id, method, params, None)
}

fn rpc_as(core: &Core, id: u32, method: &str, params: Value, planner: Option<&str>) -> Value {
    let body = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
    let raw = handle_mcp_body(core, &body.to_string(), planner).expect("a response");
    serde_json::from_str(&raw).expect("valid json")
}

fn call(core: &Core, name: &str, arguments: Value) -> Value {
    call_as(core, None, name, arguments)
}

/// Like `call`, but on behalf of a named planner - for tools whose behaviour depends on which
/// planner is calling, such as `alethe_open_shell` adopting an already-running shell.
fn call_as(core: &Core, planner: Option<&str>, name: &str, arguments: Value) -> Value {
    let response = rpc_as(
        core,
        10,
        "tools/call",
        json!({ "name": name, "arguments": arguments }),
        planner,
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

#[derive(Default)]
struct FakeShellHost {
    calls: Mutex<Vec<String>>,
    printed: Mutex<String>,
    refuse_open: bool,
}

impl ShellHost for FakeShellHost {
    fn open(&self, pty_id: &str, run: u64, command_line: &str, cwd: &str) -> Result<(), String> {
        self.calls
            .lock()
            .expect("calls")
            .push(format!("open {pty_id} run={run} {command_line} @ {cwd}"));
        if self.refuse_open {
            Err("the folder does not exist".to_string())
        } else {
            Ok(())
        }
    }

    fn output(&self, pty_id: &str, _max_bytes: usize) -> Result<String, String> {
        self.calls.lock().expect("calls").push(format!("output {pty_id}"));
        Ok(self.printed.lock().expect("printed").clone())
    }

    fn stop(&self, pty_id: &str) -> Result<(), String> {
        self.calls.lock().expect("calls").push(format!("stop {pty_id}"));
        Ok(())
    }
}

fn shell_core() -> (Core, Arc<FakeShellHost>) {
    let core = Core::default();
    let host = Arc::new(FakeShellHost::default());
    core.set_shell_host(host.clone());
    (core, host)
}

fn tool_names(listed: &Value) -> Vec<String> {
    listed["result"]["tools"]
        .as_array()
        .expect("tools")
        .iter()
        .filter_map(|tool| tool["name"].as_str().map(ToOwned::to_owned))
        .collect()
}

fn open_npm(core: &Core) -> Value {
    call(core, "alethe_open_shell", json!({ "command": "npm run dev", "cwd": "C:\\app" }))
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
fn the_core_serves_the_shipped_rules_until_the_app_injects_its_own() {
    let core = Core::default();
    let names: Vec<String> = core.rule_sets().into_iter().map(|set| set.name).collect();
    assert_eq!(names, vec!["General", "Backend", "Frontend"]);

    core.set_rule_sets(vec![RuleSet {
        id: "general".into(),
        name: "Geral".into(),
        text: "minhas regras".into(),
    }]);
    let names: Vec<String> = core.rule_sets().into_iter().map(|set| set.name).collect();
    assert_eq!(names, vec!["Geral"], "the person's list replaces ours entirely");

    core.set_rule_sets(vec![]);
    assert!(
        core.rule_sets().is_empty(),
        "an empty injection is the person's choice and must not fall back to ours"
    );
}

#[test]
fn shells_are_offered_only_where_something_can_run_them() {
    let bare = Core::default();
    let names = tool_names(&rpc(&bare, 1, "tools/list", json!({})));
    assert!(!names.iter().any(|name| name == "alethe_open_shell"), "{names:?}");

    let (core, _) = shell_core();
    let names = tool_names(&rpc(&core, 1, "tools/list", json!({})));
    assert!(names.iter().any(|name| name == "alethe_open_shell"), "{names:?}");
    assert!(names.iter().any(|name| name == "alethe_shell_output"), "{names:?}");
}

#[test]
fn opening_a_shell_starts_it_and_lists_it() {
    let (core, host) = shell_core();
    let opened = open_npm(&core);
    assert_eq!(opened["shellId"], "shell-01", "{opened}");
    assert_eq!(opened["status"], "running", "{opened}");
    assert_eq!(
        host.calls.lock().expect("calls")[0],
        "open orchestrator-shell-01 run=1 npm run dev @ C:\\app"
    );
    let listed = &core.snapshot()["shells"][0];
    assert_eq!(listed["name"], "npm", "{listed}");
    assert_eq!(listed["ptyId"], "orchestrator-shell-01", "{listed}");
}

#[test]
fn a_shell_that_fails_to_open_leaves_nothing_behind() {
    let core = Core::default();
    core.set_shell_host(Arc::new(FakeShellHost {
        refuse_open: true,
        ..FakeShellHost::default()
    }));
    let opened = open_npm(&core);
    assert!(
        opened["error"].as_str().unwrap_or_default().contains("does not exist"),
        "{opened}"
    );
    assert_eq!(core.snapshot()["shells"].as_array().expect("shells").len(), 0);
}

#[test]
fn the_output_is_the_clean_tail() {
    let (core, host) = shell_core();
    open_npm(&core);
    *host.printed.lock().expect("printed") =
        "\u{1b}[32mcompiled\u{1b}[0m\r\nlistening on :3000\r\n".to_string();
    let read = call(&core, "alethe_shell_output", json!({ "shellId": "shell-01", "lines": 1 }));
    assert_eq!(read["output"], "listening on :3000", "{read}");
    assert_eq!(read["status"], "running", "{read}");
}

#[test]
fn an_unknown_shell_is_refused() {
    let (core, _) = shell_core();
    let read = call(&core, "alethe_shell_output", json!({ "shellId": "shell-99" }));
    assert!(
        read["error"].as_str().unwrap_or_default().contains("unknown shell"),
        "{read}"
    );
}

#[test]
fn an_exit_report_marks_the_shell_exited_and_keeps_what_it_printed() {
    let (core, host) = shell_core();
    open_npm(&core);
    *host.printed.lock().expect("printed") = "Error: port 3000 is taken\r\n".to_string();
    core.shell_exited("shell-01", 1, Some(1));

    let shell = &core.snapshot()["shells"][0];
    assert_eq!(shell["status"], "exited", "{shell}");
    assert_eq!(shell["exitCode"], 1, "{shell}");

    *host.printed.lock().expect("printed") = String::new();
    let read = call(&core, "alethe_shell_output", json!({ "shellId": "shell-01" }));
    assert_eq!(read["output"], "Error: port 3000 is taken", "{read}");
}

#[test]
fn an_exit_report_from_an_earlier_run_is_ignored() {
    let (core, _) = shell_core();
    open_npm(&core);
    core.shell_exited("shell-01", 0, Some(1));
    assert_eq!(core.snapshot()["shells"][0]["status"], "running");
}

#[test]
fn stopping_a_shell_ignores_the_exit_its_own_stop_causes() {
    let (core, host) = shell_core();
    open_npm(&core);
    core.stop_shell("shell-01").expect("stopped");
    core.shell_exited("shell-01", 1, Some(-1073741510));

    let shell = &core.snapshot()["shells"][0];
    assert_eq!(shell["status"], "stopped", "{shell}");
    assert!(host
        .calls
        .lock()
        .expect("calls")
        .contains(&"stop orchestrator-shell-01".to_string()));
}

#[test]
fn restarting_runs_the_same_command_again_as_a_new_run() {
    let (core, host) = shell_core();
    open_npm(&core);
    core.shell_exited("shell-01", 1, Some(1));
    core.restart_shell("shell-01").expect("restarted");

    let calls = host.calls.lock().expect("calls").clone();
    assert!(calls.contains(&"stop orchestrator-shell-01".to_string()), "{calls:?}");
    assert_eq!(
        calls.last().map(String::as_str),
        Some("open orchestrator-shell-01 run=2 npm run dev @ C:\\app"),
        "{calls:?}"
    );
    let shell = &core.snapshot()["shells"][0];
    assert_eq!(shell["status"], "running", "{shell}");
    assert_eq!(shell["exitCode"], Value::Null, "{shell}");
}

#[test]
fn a_running_shell_cannot_be_removed() {
    let (core, _) = shell_core();
    open_npm(&core);
    assert!(core.remove_shell("shell-01").is_err());
    core.stop_shell("shell-01").expect("stopped");
    core.remove_shell("shell-01").expect("removed");
    assert_eq!(core.snapshot()["shells"].as_array().expect("shells").len(), 0);
}

#[test]
fn a_second_open_with_the_same_command_and_cwd_adopts_the_running_shell() {
    let (core, host) = shell_core();
    let first = call_as(
        &core,
        Some("planner-a"),
        "alethe_open_shell",
        json!({ "command": "npm run dev", "cwd": "C:\\app" }),
    );
    assert_eq!(first["shellId"], "shell-01", "{first}");
    assert!(first.get("reused").is_none(), "{first}");

    let second = call_as(
        &core,
        Some("planner-b"),
        "alethe_open_shell",
        json!({ "command": "npm run dev", "cwd": "C:\\app" }),
    );
    assert_eq!(second["shellId"], "shell-01", "a second call must adopt the same shell: {second}");
    assert_eq!(second["reused"], json!(true), "{second}");

    let calls = host.calls.lock().expect("calls").clone();
    assert_eq!(
        calls.iter().filter(|call| call.starts_with("open ")).count(),
        1,
        "a second process must not be spawned: {calls:?}"
    );
    let shells = core.snapshot()["shells"].as_array().expect("shells").clone();
    assert_eq!(shells.len(), 1, "only one shell must remain in the snapshot");
    assert_eq!(shells[0]["owner"]["kind"], json!("planner"), "{shells:?}");
    assert_eq!(
        shells[0]["owner"]["id"], json!("planner-b"),
        "the new planner must adopt the shell: {shells:?}"
    );
}

#[test]
fn a_stopped_shell_is_not_reused_and_a_fresh_one_opens_instead() {
    let (core, host) = shell_core();
    open_npm(&core);
    core.stop_shell("shell-01").expect("stopped");

    let reopened = open_npm(&core);
    assert_eq!(reopened["shellId"], "shell-02", "a stopped shell must not be reused: {reopened}");
    assert!(reopened.get("reused").is_none(), "{reopened}");

    let calls = host.calls.lock().expect("calls").clone();
    assert_eq!(
        calls.iter().filter(|call| call.starts_with("open ")).count(),
        2,
        "{calls:?}"
    );
}

#[test]
fn shells_come_back_stopped_after_a_restart_and_keep_counting() {
    let dir = workspace("shell-store");
    let store = dir.join("orchestrator.json");
    let (core, _) = shell_core();
    core.set_store(store.clone());
    open_npm(&core);

    let (reopened, _) = shell_core();
    reopened.set_store(store);
    reopened.restore();
    assert_eq!(reopened.snapshot()["shells"][0]["status"], "stopped");
    let next = call(
        &reopened,
        "alethe_open_shell",
        json!({ "command": "cargo watch", "cwd": "C:\\app" }),
    );
    assert_eq!(next["shellId"], "shell-02", "{next}");

    let _ = std::fs::remove_dir_all(&dir);
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
fn the_briefing_names_the_rule_sets_and_says_to_choose_one() {
    let core = Core::default();
    let initialized = rpc(&core, 1, "initialize", json!({}));
    let text = initialized["result"]["instructions"].as_str().expect("instructions");

    assert!(text.contains("General (always applied)"), "{text}");
    assert!(text.contains("Backend") && text.contains("Frontend"), "{text}");
    assert!(text.contains("name the set"), "it tells the planner to choose: {text}");

    // With the general set alone there is nothing to choose, so asking for a choice would send the
    // planner looking for names that do not exist.
    core.set_rule_sets(vec![RuleSet {
        id: "general".into(),
        name: "General".into(),
        text: "always".into(),
    }]);
    let alone = instructions_of(&core);
    assert!(alone.contains("General (always applied)"), "{alone}");
    assert!(!alone.contains("name the set"), "nothing to name: {alone}");
    assert!(alone.contains("alethe_rules"), "reading one still applies: {alone}");
}

#[test]
fn the_briefing_names_come_from_live_state_not_the_defaults() {
    // Proves the section is built from `core.rule_sets()` rather than a hardcoded string: a
    // custom list replaces the shipped names entirely, the same way `the_core_serves_the_shipped_
    // rules_until_the_app_injects_its_own` proves it for `rule_sets()` itself.
    let core = Core::default();
    core.set_rule_sets(vec![
        RuleSet { id: "general".into(), name: "General".into(), text: "g".into() },
        RuleSet { id: "db".into(), name: "Banco de Dados".into(), text: "sql".into() },
    ]);
    let text = instructions_of(&core);
    assert!(text.contains("Banco de Dados"), "{text}");
    assert!(!text.contains("Backend"), "stale defaults must not leak through: {text}");
}

#[test]
fn with_no_rule_sets_at_all_the_briefing_says_nothing_about_them() {
    let core = Core::default();
    core.set_rule_sets(vec![]);
    let text = instructions_of(&core);
    assert!(!text.contains("Rule sets"), "{text}");
    assert!(!text.contains("General (always applied)"), "{text}");
}

#[test]
fn without_a_general_set_the_briefing_does_not_claim_one_applies() {
    // The core trusts nothing but its own state: General cannot be deleted through the editor,
    // but that invariant lives in the frontend, not here.
    let core = Core::default();
    core.set_rule_sets(vec![RuleSet {
        id: "db".into(),
        name: "Banco de Dados".into(),
        text: "sql".into(),
    }]);
    let text = instructions_of(&core);
    assert!(text.contains("Banco de Dados"), "{text}");
    assert!(!text.contains("General (always applied)"), "{text}");
}

#[test]
fn the_rules_tool_lists_names_and_returns_one_set() {
    let core = Core::default();
    let listed = call(&core, "alethe_rules", json!({}));
    let names = listed["sets"].as_array().expect("names");
    assert!(names.iter().any(|value| value == "Frontend"), "{listed}");

    let one = rpc(
        &core,
        2,
        "tools/call",
        json!({ "name": "alethe_rules", "arguments": { "name": "frontend" } }),
    );
    let text = one["result"]["content"][0]["text"].as_str().expect("text");
    assert!(text.starts_with("# Frontend"), "plain markdown, not escaped JSON: {text}");
}

#[test]
fn the_rules_tool_refuses_an_unknown_name() {
    let core = Core::default();
    let result = call(&core, "alethe_rules", json!({ "name": "Backhand" }));
    let text = result["error"].as_str().unwrap_or_default();
    assert!(text.contains("unknown rule set"), "the call must be refused: {result}");
    assert!(text.contains("Backend"), "the refusal lists what exists: {text}");
}

fn instructions_of(core: &Core) -> String {
    rpc(core, 1, "initialize", json!({}))["result"]["instructions"]
        .as_str()
        .expect("server instructions")
        .to_string()
}

#[test]
fn the_instructions_send_questions_about_alethe_to_the_guide() {
    let core = Core::default();
    let text = instructions_of(&core);
    assert!(text.contains("alethe_guide"), "{text}");
}

#[test]
fn the_instructions_teach_shells_only_where_they_exist() {
    let bare = instructions_of(&Core::default());
    assert!(!bare.contains("alethe_open_shell"), "{bare}");

    let (core, _) = shell_core();
    let text = instructions_of(&core);
    assert!(text.contains("alethe_open_shell"), "{text}");
    assert!(text.contains("in two ways"), "{text}");
    assert!(text.contains("up -d"), "{text}");
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
        args: vec![
            "/c".into(),
            "type".into(),
            path.to_string_lossy().into_owned(),
        ],
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
fn a_delegated_job_records_the_rule_set_it_was_given() {
    let core = Core::default();
    core.set_launcher(silent_launcher());
    let dir = workspace("rules-name");
    call(
        &core,
        "alethe_delegate",
        json!({ "cwd": dir.to_string_lossy(), "tasks": ["one"], "rules": "backend" }),
    );

    let job = &core.snapshot()["jobs"][0];
    // Resolved, not as typed: the board shows the set that was actually used.
    assert_eq!(job["rules"], json!("Backend"), "{job}");

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn delegating_without_a_rule_set_records_none() {
    let core = Core::default();
    core.set_launcher(silent_launcher());
    let dir = workspace("rules-none");
    call(&core, "alethe_delegate", json!({ "cwd": dir.to_string_lossy(), "tasks": ["one"] }));

    assert_eq!(core.snapshot()["jobs"][0]["rules"], json!(null));

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn an_unknown_rule_set_refuses_the_call_and_starts_no_worker() {
    let core = Core::default();
    core.set_launcher(silent_launcher());
    let dir = workspace("rules-unknown");
    let result = call(
        &core,
        "alethe_delegate",
        json!({ "cwd": dir.to_string_lossy(), "tasks": ["one"], "rules": "Backhand" }),
    );

    let text = result["error"].as_str().unwrap_or_default();
    assert!(text.contains("unknown rule set"), "the call must be refused: {result}");
    assert!(text.contains("Backend"), "the refusal lists what exists: {text}");
    assert_eq!(core.snapshot()["jobs"].as_array().map(Vec::len), Some(0), "no worker started");

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
fn cancelling_through_the_core_settles_the_worker() {
    let core = Core::default();
    core.set_launcher(silent_launcher());
    let dir = workspace("cancel-method");
    call(
        &core,
        "alethe_delegate",
        json!({ "cwd": dir.to_string_lossy(), "tasks": ["hold"], "timeoutSeconds": 120 }),
    );
    let job_id = core.snapshot()["jobs"][0]["id"].as_str().expect("a job").to_string();

    let cancelled = core.cancel_jobs(&[job_id.clone()]);

    assert_eq!(cancelled, vec![job_id.clone()]);
    let status = core.snapshot()["jobs"][0]["status"].clone();
    assert_eq!(status, json!("cancelled"), "{status}");

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
