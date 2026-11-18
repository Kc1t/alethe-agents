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

use orchestrator_core::{
    handle_mcp_body, Core, Launcher, OrchestrationSettings, Planner, RuleSet, ShellHost,
};

fn rpc(core: &Core, id: u32, method: &str, params: Value) -> Value {
    rpc_as(core, None, id, method, params)
}

/// The request as the agent terminal registered as `planner` sends it.
fn rpc_as(core: &Core, planner: Option<&str>, id: u32, method: &str, params: Value) -> Value {
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
        planner,
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

/// Delegates one task as the given planner, waits for its worker to settle and returns its id.
fn delegate_as(core: &Core, planner: &str, arguments: Value) -> String {
    let body = json!({
        "jsonrpc": "2.0",
        "id": 10,
        "method": "tools/call",
        "params": { "name": "alethe_delegate", "arguments": arguments }
    });
    let raw = handle_mcp_body(core, &body.to_string(), Some(planner)).expect("a response");
    let response: Value = serde_json::from_str(&raw).expect("valid json");
    let text = response["result"]["content"][0]["text"]
        .as_str()
        .expect("tool text");
    let created: Value = serde_json::from_str(text).expect("a delegation");
    let id = created["jobs"][0]["id"]
        .as_str()
        .expect("a job id")
        .to_string();
    call(
        core,
        "alethe_check",
        json!({ "wait": true, "timeoutMs": 5000 }),
    );
    id
}

fn job_field(core: &Core, job_id: &str, key: &str) -> Value {
    let snapshot = core.snapshot();
    let jobs = snapshot["jobs"].as_array().expect("jobs");
    let job = jobs
        .iter()
        .find(|job| job["id"] == job_id)
        .unwrap_or_else(|| panic!("no {job_id} in {snapshot}"));
    job[key].clone()
}

#[test]
fn sending_a_task_again_supersedes_the_worker_that_did_not_finish() {
    let dir = workspace("superseded");
    let store = dir.join("orchestrator-jobs.json");
    let core = Core::default();
    core.set_store(store.clone());
    let task = json!({ "tasks": ["fix the parser"], "cwd": dir.to_string_lossy() });

    // No launcher is registered, so each worker fails as it starts.
    let first = delegate_as(&core, "planner-a", task.clone());
    assert_eq!(job_field(&core, &first, "status"), "failed");
    let second = delegate_as(&core, "planner-a", task);

    assert_eq!(job_field(&core, &first, "supersededBy"), json!(second));
    assert_eq!(
        job_field(&core, &second, "supersededBy"),
        Value::Null,
        "the replacement is the current worker"
    );

    let restored = Core::default();
    restored.set_store(store);
    restored.restore();
    assert_eq!(
        job_field(&restored, &first, "supersededBy"),
        json!(second),
        "the mark survives a restart"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_finished_worker_another_planner_and_another_task_are_not_superseded() {
    let dir = workspace("superseded-others");
    let core = Core::default();
    let cwd = dir.to_string_lossy().into_owned();

    let failed = delegate_as(
        &core,
        "planner-a",
        json!({ "tasks": ["task one"], "cwd": cwd }),
    );
    let other_planner = delegate_as(
        &core,
        "planner-b",
        json!({ "tasks": ["task one"], "cwd": cwd }),
    );
    delegate_as(
        &core,
        "planner-a",
        json!({ "tasks": ["task two"], "cwd": cwd }),
    );
    assert_eq!(job_field(&core, &failed, "supersededBy"), Value::Null);
    assert_eq!(
        job_field(&core, &other_planner, "supersededBy"),
        Value::Null
    );

    let transcript = concat!(
        r#"{"type":"system","subtype":"init","session_id":"finished-session"}"#,
        "\n",
        r#"{"type":"result","is_error":false,"result":"CLAUDE_DONE_OK"}"#,
        "\n",
    );
    core.set_launcher(fake_claude_launcher(&dir, transcript));
    let task = json!({ "tasks": ["task three"], "cwd": cwd, "agent": "claude" });
    let finished = delegate_as(&core, "planner-a", task.clone());
    assert_eq!(job_field(&core, &finished, "status"), "done");
    delegate_as(&core, "planner-a", task);
    assert_eq!(
        job_field(&core, &finished, "supersededBy"),
        Value::Null,
        "a worker that finished its task stays on the board"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_superseded_worker_that_gets_more_work_is_current_again() {
    let dir = workspace("superseded-revived");
    let store = dir.join("orchestrator-jobs.json");
    let core = Core::default();
    core.set_store(store.clone());
    let transcript = concat!(
        r#"{"type":"system","subtype":"init","session_id":"revived-session"}"#,
        "\n",
        r#"{"type":"assistant","message":{"content":[{"type":"text","text":"on my way"}]}}"#,
        "\n",
    );
    core.set_launcher(fake_claude_holding_launcher(&dir, transcript));
    let task =
        json!({ "tasks": ["go somewhere"], "cwd": dir.to_string_lossy(), "agent": "claude" });

    call(&core, "alethe_delegate", task.clone());
    std::thread::sleep(std::time::Duration::from_millis(600));
    call(&core, "alethe_cancel", json!({ "jobIds": ["job-01"] }));
    assert_eq!(job_field(&core, "job-01", "status"), "cancelled");
    call(&core, "alethe_delegate", task);
    assert_eq!(job_field(&core, "job-01", "supersededBy"), json!("job-02"));

    let sent = call(
        &core,
        "alethe_send",
        json!({ "jobId": "job-01", "message": "pick it up again" }),
    );
    assert_eq!(sent["revived"], json!("job-01"), "{sent}");
    assert_eq!(
        job_field(&core, "job-01", "supersededBy"),
        Value::Null,
        "a worker that is running again has to show"
    );
    let restored = Core::default();
    restored.set_store(store);
    restored.restore();
    assert_eq!(
        job_field(&restored, "job-01", "supersededBy"),
        Value::Null,
        "and it still shows after a restart"
    );

    let _ = call(
        &core,
        "alethe_cancel",
        json!({ "jobIds": ["job-01", "job-02"] }),
    );
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

    // Snapshots reach the observer on its own thread, so a slow machine may not have delivered
    // them yet when the call returns.
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while seen.lock().expect("seen").is_empty() && std::time::Instant::now() < deadline {
        thread::sleep(Duration::from_millis(20));
    }
    let snapshots = seen.lock().expect("seen");
    assert!(!snapshots.is_empty(), "the observer was never called");
    let last = snapshots.last().expect("a snapshot");
    assert!(last["jobs"].as_array().is_some_and(|jobs| !jobs.is_empty()));
    let _ = std::fs::remove_dir_all(&dir);
}

// The Orchestration settings list the models Codex offers. Codex shuts down on end of input, so
// asking and closing at once never got an answer ("codex did not list its models in time").
#[test]
#[ignore = "spawns the real codex app-server"]
fn the_installed_codex_lists_its_models() {
    let core = Core::default();
    core.set_launcher(codex_launcher());
    let models = core.list_codex_models().expect("a model list");
    let listed = models.as_array().expect("a list");
    assert!(!listed.is_empty(), "{models}");
    assert!(
        listed.iter().all(|model| model["efforts"].is_array()),
        "{models}"
    );
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
    wait_for_job(&core, 20, |job| job["status"] == "done");

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

    // The store is written just after the job turns done.
    let deadline = std::time::Instant::now() + Duration::from_secs(20);
    let restored_job = loop {
        let restored = Core::default();
        restored.set_store(store.clone());
        restored.restore();
        let job = restored.snapshot()["jobs"][0].clone();
        if job["tokens"]["total"]["totalTokens"] == 15 || std::time::Instant::now() > deadline {
            break job;
        }
        thread::sleep(Duration::from_millis(100));
    };
    assert_eq!(restored_job["tokens"]["total"]["totalTokens"], 15, "{restored_job}");
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
    // The diff runs git more than once now (tracked, then untracked files): no fixed wait is enough.
    let job = wait_for_job(&core, 20, |job| job["status"] == "done");
    assert_eq!(job["status"], "done", "{job}");
    assert_eq!(job["hasDiff"], true, "{job}");

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
fn a_worker_stopped_by_its_budget_hands_over_what_it_had_written() {
    let dir = workspace("timeout-partial");
    let core = Core::default();
    let transcript = concat!(
        r#"{"type":"system","subtype":"init","session_id":"partial-session"}"#,
        "\n",
        r#"{"type":"assistant","message":{"content":[{"type":"text","text":"three of the five sources read so far"}]}}"#,
        "\n",
    );
    core.set_launcher(fake_claude_holding_launcher(&dir, transcript));

    call(
        &core,
        "alethe_delegate",
        json!({
            "cwd": dir.to_string_lossy(),
            "tasks": ["read five sources"],
            "agent": "claude",
            "timeoutSeconds": 2
        }),
    );
    let checked = call(
        &core,
        "alethe_check",
        json!({ "wait": true, "timeoutMs": 30000 }),
    );
    let deliveries = checked["deliveries"].as_array().expect("deliveries");
    assert_eq!(deliveries.len(), 1, "{checked}");
    assert_eq!(deliveries[0]["outcome"], json!("timeout"), "{checked}");
    let text = deliveries[0]["text"].as_str().unwrap_or_default();
    assert!(text.contains("2s budget"), "{checked}");
    assert!(
        text.contains("three of the five sources read so far"),
        "what the worker wrote before the budget ended is lost: {checked}"
    );
    let snapshot = core.snapshot();
    assert!(
        snapshot["jobs"][0]["summary"]
            .as_str()
            .unwrap_or_default()
            .contains("three of the five sources read so far"),
        "the board shows only the budget message: {snapshot}"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

/// Plays `first`, waits about `pause_secs`, plays `then`, and holds the process open.
fn fake_claude_two_part_launcher(
    dir: &std::path::Path,
    first: &str,
    pause_secs: u32,
    then: &str,
) -> Launcher {
    let first_path = dir.join("first.jsonl");
    let then_path = dir.join("then.jsonl");
    std::fs::write(&first_path, first).expect("write first part");
    std::fs::write(&then_path, then).expect("write second part");
    #[cfg(windows)]
    let (program, args): (&str, Vec<String>) = {
        let script = dir.join("two-part.bat");
        std::fs::write(
            &script,
            format!(
                "@echo off
type \"{}\"
ping -n {} 127.0.0.1 >NUL
type \"{}\"
ping -n 60 127.0.0.1 >NUL
",
                first_path.to_string_lossy(),
                pause_secs + 1,
                then_path.to_string_lossy()
            ),
        )
        .expect("write two-part script");
        (
            "cmd",
            vec!["/c".into(), script.to_string_lossy().into_owned()],
        )
    };
    #[cfg(not(windows))]
    let (program, args): (&str, Vec<String>) = (
        "sh",
        vec![
            "-c".into(),
            format!(
                "cat '{}'; sleep {}; cat '{}'; sleep 60",
                first_path.display(),
                pause_secs,
                then_path.display()
            ),
        ],
    );
    Launcher {
        kind: "claude".into(),
        program: PathBuf::from(program),
        args,
        env: Vec::new(),
    }
}

#[test]
fn a_claude_worker_keeps_what_it_wrote_when_a_steer_interrupts_it() {
    let dir = workspace("timeout-claude-steered");
    let core = Core::default();
    // Claude takes a steer as an interrupt: the turn in flight ends (the `result` below, three
    // seconds in, after the steer at one and a half) and a new turn starts with the steer. The
    // worker then writes nothing more before the budget ends at six.
    let first = concat!(
        r#"{"type":"system","subtype":"init","session_id":"claude-wrap-up"}"#,
        "\n",
        r#"{"type":"assistant","message":{"content":[{"type":"text","text":"draft of section B1"}]}}"#,
        "\n",
    );
    let then = concat!(
        r#"{"type":"result","subtype":"error_during_execution","is_error":true,"result":""}"#,
        "\n",
    );
    core.set_launcher(fake_claude_two_part_launcher(&dir, first, 3, then));

    call(
        &core,
        "alethe_delegate",
        json!({
            "cwd": dir.to_string_lossy(),
            "tasks": ["write section B1"],
            "agent": "claude",
            "timeoutSeconds": 6
        }),
    );
    std::thread::sleep(std::time::Duration::from_millis(1500));
    let steered = call(
        &core,
        "alethe_steer",
        json!({ "jobId": "job-01", "message": "cover section B2 too" }),
    );
    assert_eq!(steered["steered"], json!("job-01"), "{steered}");
    let checked = call(
        &core,
        "alethe_check",
        json!({ "wait": true, "timeoutMs": 30000 }),
    );
    let deliveries = checked["deliveries"].as_array().expect("deliveries");
    assert_eq!(deliveries.len(), 1, "{checked}");
    assert_eq!(deliveries[0]["outcome"], json!("timeout"), "{checked}");
    assert!(
        deliveries[0]["text"]
            .as_str()
            .unwrap_or_default()
            .contains("draft of section B1"),
        "the draft written before the steer is lost: {checked}"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_revived_worker_gets_its_own_budget_not_the_one_before() {
    let dir = workspace("timeout-revived");
    let core = Core::default();
    let transcript = concat!(
        r#"{"type":"system","subtype":"init","session_id":"revived-budget"}"#,
        "\n",
    );
    core.set_launcher(fake_claude_holding_launcher(&dir, transcript));

    call(
        &core,
        "alethe_delegate",
        json!({
            "cwd": dir.to_string_lossy(),
            "tasks": ["long task"],
            "agent": "claude",
            "timeoutSeconds": 5
        }),
    );
    std::thread::sleep(std::time::Duration::from_millis(800));
    call(&core, "alethe_cancel", json!({ "jobIds": ["job-01"] }));
    let sent = call(
        &core,
        "alethe_send",
        json!({ "jobId": "job-01", "message": "carry on" }),
    );
    assert_eq!(sent["revived"], json!("job-01"), "{sent}");

    // The first run would have been stopped at 5 s; this run is stopped near 5.8 s.
    std::thread::sleep(std::time::Duration::from_millis(4500));
    let at_five = core.snapshot();
    assert_eq!(
        at_five["jobs"][0]["status"], "running",
        "stopped on the budget of the run before: {at_five}"
    );

    let _ = call(&core, "alethe_cancel", json!({ "jobIds": ["job-01"] }));
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
    wait_for_job(&core, 20, |job| job["status"] == "done");

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
fn a_null_snapshot_forgets_an_agent_whose_usage_is_no_longer_read() {
    let core = Core::default();
    core.set_agent_fitness(
        "claude",
        json!({ "worst": "week", "used": 95, "rateLimited": false }),
    );
    assert!(call(&core, "alethe_status", json!({}))["fitness"]["claude"].is_object());

    core.set_agent_fitness("claude", Value::Null);

    let status = call(&core, "alethe_status", json!({}));
    assert!(status["fitness"]["claude"].is_null(), "{status}");
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

// What alethe_status returns has to fit a planner; the UI keeps reading the full snapshot (#258).
#[test]
fn the_status_stays_small_however_long_the_tasks_are() {
    let dir = workspace("status-small");
    let core = Core::default();
    // About 6,000 characters each, with accents, like a real review brief.
    let brief = "Revisão do diff com atenção à validação e às exceções — ".repeat(110);
    let tasks: Vec<String> = (0..12).map(|i| format!("{i}: {brief}")).collect();
    call_as(
        &core,
        Some("planner-a"),
        "alethe_delegate",
        json!({ "tasks": tasks, "cwd": dir.to_string_lossy() }),
    );
    // No launcher is registered, so every worker settles at once.
    call_as(
        &core,
        Some("planner-a"),
        "alethe_check",
        json!({ "wait": true, "timeoutMs": 5000 }),
    );

    let status = call_as(&core, Some("planner-a"), "alethe_status", json!({}));
    let size = status.to_string().chars().count();
    assert!(size < 12_000, "the status has {size} characters");
    let jobs = status["jobs"].as_array().expect("jobs");
    assert!(!jobs.is_empty(), "{status}");
    for job in jobs {
        let spec = job["spec"].as_str().unwrap_or_default();
        assert!(spec.chars().count() <= 241, "task text not trimmed: {spec}");
    }
    // Of twelve settled workers, the ten most recent are listed, in order, and two are counted.
    let listed: Vec<&str> = jobs.iter().filter_map(|job| job["id"].as_str()).collect();
    let expected: Vec<String> = (3..=12).map(|n| format!("job-{n:02}")).collect();
    assert_eq!(listed, expected, "{status}");
    assert_eq!(status["omitted"], json!(2), "{status}");

    let snapshot = core.snapshot();
    assert_eq!(
        snapshot["jobs"].as_array().map(Vec::len),
        Some(12),
        "the UI still gets every worker"
    );
    assert!(
        snapshot["jobs"][0]["spec"]
            .as_str()
            .unwrap_or_default()
            .chars()
            .count()
            > 5_000,
        "the UI still gets the whole task text"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_planner_sees_its_own_workers_and_a_count_of_the_rest() {
    let dir = workspace("status-mine");
    let core = Core::default();
    let cwd = dir.to_string_lossy().into_owned();
    call_as(
        &core,
        Some("planner-a"),
        "alethe_delegate",
        json!({ "tasks": ["task of a"], "cwd": cwd }),
    );
    call_as(
        &core,
        Some("planner-b"),
        "alethe_delegate",
        json!({ "tasks": ["task of b"], "cwd": cwd }),
    );

    let mine = call_as(&core, Some("planner-a"), "alethe_status", json!({}));
    let jobs = mine["jobs"].as_array().expect("jobs");
    assert_eq!(jobs.len(), 1, "{mine}");
    assert_eq!(jobs[0]["plannerId"], "planner-a");
    assert_eq!(mine["omitted"], json!(1), "{mine}");

    let all = call_as(&core, Some("planner-a"), "alethe_status", json!({ "all": true }));
    assert_eq!(all["jobs"].as_array().map(Vec::len), Some(2), "{all}");
    assert_eq!(all["omitted"], json!(0), "{all}");

    let _ = std::fs::remove_dir_all(&dir);
}

// A planner picks the model, the effort and a read-only sandbox for the workers it delegates (#252).
#[test]
fn a_worker_keeps_the_model_effort_and_read_only_it_was_delegated_with() {
    let dir = workspace("model-options");
    let store = dir.join("orchestrator-jobs.json");
    let core = Core::default();
    core.set_store(store.clone());

    let delegated = call(
        &core,
        "alethe_delegate",
        json!({
            "tasks": ["review the diff"],
            "cwd": dir.to_string_lossy(),
            "model": "gpt-6-astra",
            "effort": "high",
            "readOnly": true
        }),
    );
    assert_eq!(delegated["accepted"], json!(1), "{delegated}");
    // No launcher is registered, so the worker settles at once; what matters is what it was given.
    call(
        &core,
        "alethe_check",
        json!({ "wait": true, "timeoutMs": 5000 }),
    );

    let snapshot = core.snapshot();
    let job = &snapshot["jobs"][0];
    assert_eq!(job["model"], "gpt-6-astra", "{job}");
    assert_eq!(job["effort"], "high", "{job}");
    assert_eq!(job["readOnly"], true, "{job}");

    let restored = Core::default();
    restored.set_store(store);
    restored.restore();
    let restored_snapshot = restored.snapshot();
    let restored_job = &restored_snapshot["jobs"][0];
    assert_eq!(restored_job["model"], "gpt-6-astra", "{restored_job}");
    assert_eq!(restored_job["effort"], "high", "{restored_job}");
    assert_eq!(restored_job["readOnly"], true, "{restored_job}");

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_worker_delegated_without_model_options_runs_as_before() {
    let dir = workspace("model-defaults");
    let core = Core::default();

    let delegated = call(
        &core,
        "alethe_delegate",
        json!({ "tasks": ["anything"], "cwd": dir.to_string_lossy() }),
    );
    assert_eq!(delegated["accepted"], json!(1), "{delegated}");

    let snapshot = core.snapshot();
    let job = &snapshot["jobs"][0];
    assert_eq!(job["model"], Value::Null, "{job}");
    assert_eq!(job["effort"], Value::Null, "{job}");
    assert_eq!(job["readOnly"], false, "{job}");

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn model_options_that_cannot_hold_are_refused_without_creating_a_job() {
    let dir = workspace("model-refused");
    let core = Core::default();
    let cwd = dir.to_string_lossy().into_owned();

    let cases = [
        // The headless Claude launch bypasses permissions: dropping readOnly would let it write.
        (
            "read-only claude worker",
            json!({ "agent": "claude", "readOnly": true }),
        ),
        (
            "read-only worker that asks",
            json!({ "readOnly": true, "askForApproval": true }),
        ),
        // Read as false it would start a writable worker the caller meant to only read.
        ("read-only given as text", json!({ "readOnly": "true" })),
        ("effort with whitespace", json!({ "effort": "very high" })),
        (
            "model read as a flag",
            json!({ "model": "--dangerously-skip-permissions" }),
        ),
        ("model with whitespace", json!({ "model": "gpt 6" })),
        ("empty model", json!({ "model": "" })),
    ];
    for (case, options) in cases {
        let mut arguments = json!({ "tasks": ["anything"], "cwd": cwd });
        for (key, value) in options.as_object().expect("options") {
            arguments[key] = value.clone();
        }
        let result = call(&core, "alethe_delegate", arguments);
        assert!(
            result.get("error").is_some(),
            "{case} must be refused: {result}"
        );
    }
    assert_eq!(
        core.snapshot()["jobs"].as_array().map(Vec::len),
        Some(0),
        "a refused call creates no job"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

// Roles configured in Preferences decide what a delegated worker runs on (#254).
fn settings(value: Value) -> OrchestrationSettings {
    serde_json::from_value(value).expect("settings in the shape the app sends")
}

fn reviewer_on(model: &str) -> OrchestrationSettings {
    settings(json!({
        "roles": [{
            "name": "reviewer",
            "agent": "codex",
            "model": model,
            "effort": "high",
            "readOnly": true,
            "timeoutSeconds": 600
        }],
        "maxConcurrent": 4,
        "defaultTimeoutSeconds": 900
    }))
}

#[test]
fn a_role_decides_what_its_workers_run_on() {
    let dir = workspace("role-applied");
    let core = Core::default();
    core.apply_settings(reviewer_on("gpt-6.1-sol"));

    let delegated = call(
        &core,
        "alethe_delegate",
        json!({ "tasks": ["review the diff"], "cwd": dir.to_string_lossy(), "role": "reviewer" }),
    );
    assert_eq!(delegated["accepted"], json!(1), "{delegated}");
    assert_eq!(delegated["timeoutSeconds"], json!(600), "{delegated}");

    let snapshot = core.snapshot();
    let job = &snapshot["jobs"][0];
    assert_eq!(job["role"], "reviewer", "{job}");
    assert_eq!(job["agent"], "codex", "{job}");
    assert_eq!(job["model"], "gpt-6.1-sol", "{job}");
    assert_eq!(job["effort"], "high", "{job}");
    assert_eq!(job["readOnly"], true, "{job}");

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_role_is_the_only_source_for_what_it_sets() {
    let dir = workspace("role-refused");
    let core = Core::default();
    core.apply_settings(reviewer_on("gpt-6.1-sol"));
    let cwd = dir.to_string_lossy().into_owned();

    let cases = [
        ("another model", json!({ "role": "reviewer", "model": "gpt-6-astra" })),
        ("another effort", json!({ "role": "reviewer", "effort": "low" })),
        // A planner must not be able to run a read-only role as a writable worker.
        ("writable", json!({ "role": "reviewer", "readOnly": false })),
        ("another agent", json!({ "role": "reviewer", "agent": "claude" })),
        ("another budget", json!({ "role": "reviewer", "timeoutSeconds": 60 })),
        ("unknown role", json!({ "role": "auditor" })),
        ("a field left null", json!({ "role": "reviewer", "model": null })),
        ("role that is not a name", json!({ "role": true })),
    ];
    for (case, options) in cases {
        let mut arguments = json!({ "tasks": ["anything"], "cwd": cwd });
        for (key, value) in options.as_object().expect("options") {
            arguments[key] = value.clone();
        }
        let result = call(&core, "alethe_delegate", arguments);
        assert!(result.get("error").is_some(), "{case} must be refused: {result}");
    }
    let unknown = call(
        &core,
        "alethe_delegate",
        json!({ "tasks": ["anything"], "cwd": cwd, "role": "auditor" }),
    );
    assert!(
        unknown["error"].as_str().unwrap_or_default().contains("reviewer"),
        "an unknown role names the ones that exist: {unknown}"
    );
    assert_eq!(
        core.snapshot()["jobs"].as_array().map(Vec::len),
        Some(0),
        "a refused call creates no job"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn editing_a_role_changes_the_next_delegation_but_not_one_already_made() {
    let dir = workspace("role-edited");
    let core = Core::default();
    let cwd = dir.to_string_lossy().into_owned();

    core.apply_settings(reviewer_on("gpt-6-astra"));
    call(
        &core,
        "alethe_delegate",
        json!({ "tasks": ["first"], "cwd": cwd, "role": "reviewer" }),
    );
    core.apply_settings(reviewer_on("gpt-6.1-sol"));
    call(
        &core,
        "alethe_delegate",
        json!({ "tasks": ["second"], "cwd": cwd, "role": "reviewer" }),
    );

    let snapshot = core.snapshot();
    assert_eq!(snapshot["jobs"][0]["model"], "gpt-6-astra", "{snapshot}");
    assert_eq!(snapshot["jobs"][1]["model"], "gpt-6.1-sol", "{snapshot}");

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn the_status_lists_the_roles_a_planner_can_ask_for() {
    let core = Core::default();
    core.apply_settings(reviewer_on("gpt-6.1-sol"));

    let status = call(&core, "alethe_status", json!({}));
    let roles = status["roles"].as_array().expect("roles in the status");
    assert_eq!(roles.len(), 1, "{status}");
    assert_eq!(roles[0]["name"], "reviewer");
    assert_eq!(roles[0]["model"], "gpt-6.1-sol");
    assert_eq!(roles[0]["readOnly"], true);
}

#[test]
fn the_limits_from_preferences_reach_the_orchestrator() {
    let dir = workspace("role-limits");
    let core = Core::default();
    core.apply_settings(settings(json!({
        "roles": [],
        "maxConcurrent": 2,
        "defaultTimeoutSeconds": 300
    })));

    let delegated = call(
        &core,
        "alethe_delegate",
        json!({ "tasks": ["anything"], "cwd": dir.to_string_lossy() }),
    );
    assert_eq!(delegated["concurrencyLimit"], json!(2), "{delegated}");
    assert_eq!(delegated["timeoutSeconds"], json!(300), "{delegated}");

    let _ = std::fs::remove_dir_all(&dir);
}

// Claude Code takes an effort on its command line (`--effort`), so a Claude worker gets one too.
#[test]
fn a_claude_worker_keeps_the_effort_it_was_delegated_with() {
    let dir = workspace("claude-effort");
    let core = Core::default();

    let delegated = call(
        &core,
        "alethe_delegate",
        json!({
            "tasks": ["implement it"],
            "cwd": dir.to_string_lossy(),
            "agent": "claude",
            "model": "claude-opus-5-5",
            "effort": "high"
        }),
    );
    assert_eq!(delegated["accepted"], json!(1), "{delegated}");

    let snapshot = core.snapshot();
    let job = &snapshot["jobs"][0];
    assert_eq!(job["model"], "claude-opus-5-5", "{job}");
    assert_eq!(job["effort"], "high", "{job}");
    assert_eq!(job["readOnly"], false, "{job}");

    let _ = std::fs::remove_dir_all(&dir);
}

// An executor role runs Claude on the model and effort the settings give it.
#[test]
fn a_claude_role_runs_on_its_model_and_effort() {
    let dir = workspace("role-claude");
    let core = Core::default();
    core.apply_settings(settings(json!({
        "roles": [{
            "name": "executor-t2",
            "agent": "claude",
            "model": "claude-opus-5-5",
            "effort": "high",
            "readOnly": false,
            "timeoutSeconds": 600
        }],
        "maxConcurrent": 4,
        "defaultTimeoutSeconds": 900
    })));

    let delegated = call(
        &core,
        "alethe_delegate",
        json!({ "tasks": ["implement it"], "cwd": dir.to_string_lossy(), "role": "executor-t2" }),
    );
    assert_eq!(delegated["accepted"], json!(1), "{delegated}");

    let snapshot = core.snapshot();
    let job = &snapshot["jobs"][0];
    assert_eq!(job["agent"], "claude", "{job}");
    assert_eq!(job["model"], "claude-opus-5-5", "{job}");
    assert_eq!(job["effort"], "high", "{job}");
    assert_eq!(job["readOnly"], false, "{job}");

    let _ = std::fs::remove_dir_all(&dir);
}

// A role falls back to the role it names when its provider is running out (#268).
fn roles_with_fallbacks() -> OrchestrationSettings {
    settings(json!({
        "roles": [
            {
                "name": "executor-t2",
                "agent": "claude",
                "model": "claude-opus-5-5",
                "effort": "high",
                "readOnly": false,
                "timeoutSeconds": 600,
                "fallback": "executor-codex"
            },
            {
                "name": "executor-codex",
                "agent": "codex",
                "model": "gpt-6.1-sol",
                "effort": "medium",
                "readOnly": false,
                "timeoutSeconds": 900
            },
            {
                "name": "reviewer",
                "agent": "codex",
                "model": "gpt-6.1-sol",
                "effort": "medium",
                "readOnly": true,
                "timeoutSeconds": 600,
                "fallback": "executor-t2"
            }
        ],
        "maxConcurrent": 4,
        "defaultTimeoutSeconds": 900
    }))
}

fn quota(core: &Core, claude: u32, codex: u32) {
    core.set_agent_fitness(
        "claude",
        json!({ "worst": "5h", "used": claude, "rateLimited": false }),
    );
    core.set_agent_fitness(
        "codex",
        json!({ "worst": "week", "used": codex, "rateLimited": false }),
    );
}

fn delegate_role(core: &Core, dir: &std::path::Path, role: &str) -> (Value, Value) {
    delegate_role_as(core, dir, role, None)
}

fn delegate_role_as(
    core: &Core,
    dir: &std::path::Path,
    role: &str,
    planner: Option<&str>,
) -> (Value, Value) {
    let delegated = call_as(
        core,
        planner,
        "alethe_delegate",
        json!({ "tasks": ["do the work"], "cwd": dir.to_string_lossy(), "role": role }),
    );
    let snapshot = core.snapshot();
    let job = snapshot["jobs"]
        .as_array()
        .and_then(|jobs| jobs.last())
        .cloned()
        .unwrap_or(Value::Null);
    (delegated, job)
}

#[test]
fn a_role_falls_back_when_its_provider_is_running_out() {
    let dir = workspace("role-fallback");
    let core = Core::default();
    core.apply_settings(roles_with_fallbacks());
    quota(&core, 86, 20);

    let (delegated, job) = delegate_role(&core, &dir, "executor-t2");
    assert_eq!(delegated["timeoutSeconds"], json!(900), "{delegated}");
    assert_eq!(
        job["role"], "executor-t2",
        "the planner's role is kept: {job}"
    );
    assert_eq!(job["agent"], "codex", "{job}");
    assert_eq!(job["model"], "gpt-6.1-sol", "{job}");
    assert_eq!(job["effort"], "medium", "{job}");
    assert_eq!(
        job["routing"],
        json!({
            "verdict": "fallback",
            "from": "executor-t2",
            "to": "executor-codex",
            "agent": "claude",
            "window": "5h",
            "used": 86.0
        }),
        "{job}"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_role_runs_as_configured_unless_its_fallback_has_room() {
    let dir = workspace("role-no-fallback");
    let core = Core::default();
    core.apply_settings(roles_with_fallbacks());

    quota(&core, 50, 20);
    let (_, below) = delegate_role(&core, &dir, "executor-t2");
    assert_eq!(below["agent"], "claude", "below the threshold: {below}");

    quota(&core, 86, 90);
    let (_, both) = delegate_role(&core, &dir, "executor-t2");
    assert_eq!(both["agent"], "claude", "both running out: {both}");
    assert_eq!(both["model"], "claude-opus-5-5", "{both}");

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_read_only_role_never_falls_back_to_a_writable_one() {
    let dir = workspace("role-fallback-read-only");
    let core = Core::default();
    core.apply_settings(roles_with_fallbacks());
    quota(&core, 10, 95);

    let (_, job) = delegate_role(&core, &dir, "reviewer");
    assert_eq!(job["agent"], "codex", "{job}");
    assert_eq!(job["readOnly"], true, "{job}");
    assert_ne!(
        job["routing"]["verdict"], "fallback",
        "a read-only role was run writable: {job}"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn the_headroom_hint_reads_the_agent_a_role_runs_on() {
    let dir = workspace("role-headroom-hint");
    let core = Core::default();
    // No fallback configured for this one, so the hint is all the planner gets.
    core.apply_settings(settings(json!({
        "roles": [{
            "name": "executor-t2",
            "agent": "claude",
            "model": "claude-opus-5-5",
            "effort": null,
            "readOnly": false,
            "timeoutSeconds": null
        }],
        "maxConcurrent": 4,
        "defaultTimeoutSeconds": 900
    })));
    quota(&core, 86, 20);

    let (delegated, job) = delegate_role(&core, &dir, "executor-t2");
    assert_eq!(job["agent"], "claude", "{job}");
    assert_eq!(
        delegated["headroomHint"]["agent"], "codex",
        "the hint has to be about claude, the agent this role runs on: {delegated}"
    );
    assert_eq!(job["routing"]["verdict"], "ignored", "{job}");

    let _ = std::fs::remove_dir_all(&dir);
}

// A role name means the row for the orchestrator that delegates, else the row for any (#276).
fn roles_per_orchestrator() -> OrchestrationSettings {
    settings(json!({
        "roles": [
            {
                "name": "executor-t2",
                "orchestrator": "claude",
                "agent": "claude",
                "model": "claude-opus-5-5",
                "fallback": "spare"
            },
            {
                "name": "executor-t2",
                "orchestrator": "codex",
                "agent": "codex",
                "model": "gpt-6.1-sol",
                "fallback": "spare"
            },
            { "name": "reviewer", "agent": "codex", "model": "gpt-6-astra", "readOnly": true },
            {
                "name": "scout",
                "orchestrator": "claude",
                "agent": "claude",
                "model": "claude-sonnet-5-5"
            },
            { "name": "scout", "agent": "codex", "model": "gpt-6-astra" },
            { "name": "spare", "orchestrator": "claude", "agent": "codex", "model": "gpt-6-spare" },
            {
                "name": "spare",
                "orchestrator": "codex",
                "agent": "claude",
                "model": "claude-haiku-5"
            }
        ],
        "maxConcurrent": 4,
        "defaultTimeoutSeconds": 900
    }))
}

fn with_planners(core: &Core) {
    for agent in ["claude", "codex"] {
        core.register_planner(Planner {
            id: format!("{agent}-pane"),
            label: agent.to_string(),
            agent: agent.to_string(),
        });
    }
}

#[test]
fn a_role_runs_as_the_row_for_the_orchestrator_that_delegates() {
    let dir = workspace("role-per-orchestrator");
    let core = Core::default();
    core.apply_settings(roles_per_orchestrator());
    with_planners(&core);

    let (_, claude) = delegate_role_as(&core, &dir, "executor-t2", Some("claude-pane"));
    assert_eq!(claude["agent"], "claude", "{claude}");
    assert_eq!(claude["model"], "claude-opus-5-5", "{claude}");
    let (_, codex) = delegate_role_as(&core, &dir, "executor-t2", Some("codex-pane"));
    assert_eq!(codex["agent"], "codex", "{codex}");
    assert_eq!(codex["model"], "gpt-6.1-sol", "{codex}");

    // A role with only a row for any orchestrator is the same for every planner.
    for planner in [Some("claude-pane"), Some("codex-pane"), None] {
        let (_, job) = delegate_role_as(&core, &dir, "reviewer", planner);
        assert_eq!(job["model"], "gpt-6-astra", "{planner:?}: {job}");
    }

    // A row for another orchestrator is not this planner's: it gets the row for any.
    let (_, scout) = delegate_role_as(&core, &dir, "scout", Some("codex-pane"));
    assert_eq!(scout["agent"], "codex", "{scout}");
    assert_eq!(scout["model"], "gpt-6-astra", "{scout}");
    let (_, scout) = delegate_role_as(&core, &dir, "scout", Some("claude-pane"));
    assert_eq!(scout["model"], "claude-sonnet-5-5", "{scout}");

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_role_with_no_row_for_the_planner_is_refused() {
    let dir = workspace("role-per-orchestrator-refused");
    let core = Core::default();
    core.apply_settings(roles_per_orchestrator());
    with_planners(&core);
    let cwd = dir.to_string_lossy().into_owned();

    // No planner, or one Alethe does not know, only reaches the rows for any orchestrator.
    for planner in [None, Some("unregistered-pane")] {
        let refused = call_as(
            &core,
            planner,
            "alethe_delegate",
            json!({ "tasks": ["anything"], "cwd": cwd, "role": "executor-t2" }),
        );
        assert_eq!(
            refused["error"], "error: unknown role executor-t2; configured roles: reviewer, scout",
            "{planner:?}"
        );
    }
    let unknown = call_as(
        &core,
        Some("claude-pane"),
        "alethe_delegate",
        json!({ "tasks": ["anything"], "cwd": cwd, "role": "auditor" }),
    );
    assert_eq!(
        unknown["error"],
        "error: unknown role auditor; configured roles: executor-t2, reviewer, scout, spare",
        "each name once"
    );
    assert_eq!(core.snapshot()["jobs"].as_array().map(Vec::len), Some(0));

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_fallback_name_resolves_for_the_orchestrator_that_delegates() {
    let dir = workspace("role-fallback-per-orchestrator");
    let core = Core::default();
    core.apply_settings(roles_per_orchestrator());
    with_planners(&core);

    quota(&core, 90, 10);
    let (_, claude) = delegate_role_as(&core, &dir, "executor-t2", Some("claude-pane"));
    assert_eq!(claude["agent"], "codex", "{claude}");
    assert_eq!(claude["model"], "gpt-6-spare", "{claude}");
    assert_eq!(claude["routing"]["to"], "spare", "{claude}");

    quota(&core, 10, 90);
    let (_, codex) = delegate_role_as(&core, &dir, "executor-t2", Some("codex-pane"));
    assert_eq!(codex["agent"], "claude", "{codex}");
    assert_eq!(codex["model"], "claude-haiku-5", "{codex}");
    assert_eq!(codex["routing"]["to"], "spare", "{codex}");

    let _ = std::fs::remove_dir_all(&dir);
}

// Fallbacks between a row for one orchestrator and a row for any (#276).
fn fallbacks_across_rows() -> OrchestrationSettings {
    settings(json!({
        "roles": [
            {
                "name": "lead",
                "orchestrator": "claude",
                "agent": "claude",
                "model": "claude-opus-5-5",
                "fallback": "backup"
            },
            { "name": "backup", "agent": "codex", "model": "gpt-6-backup" },
            { "name": "auditor", "agent": "claude", "model": "claude-sonnet-5-5", "fallback": "helper" },
            { "name": "helper", "orchestrator": "codex", "agent": "codex", "model": "gpt-6-helper" },
            { "name": "helper", "agent": "codex", "model": "gpt-6-helper-any" },
            {
                "name": "inspector",
                "orchestrator": "claude",
                "agent": "codex",
                "model": "gpt-6-astra",
                "readOnly": true,
                "fallback": "writer"
            },
            { "name": "writer", "orchestrator": "claude", "agent": "claude", "model": "claude-haiku-5" }
        ],
        "maxConcurrent": 4,
        "defaultTimeoutSeconds": 900
    }))
}

#[test]
fn a_row_for_one_orchestrator_falls_back_to_the_row_for_any() {
    let dir = workspace("role-fallback-to-any");
    let core = Core::default();
    core.apply_settings(fallbacks_across_rows());
    with_planners(&core);
    quota(&core, 90, 10);

    let (_, job) = delegate_role_as(&core, &dir, "lead", Some("claude-pane"));
    assert_eq!(job["agent"], "codex", "{job}");
    assert_eq!(job["model"], "gpt-6-backup", "{job}");
    assert_eq!(job["routing"]["to"], "backup", "{job}");

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_row_for_any_falls_back_to_the_row_for_the_planner() {
    let dir = workspace("role-fallback-from-any");
    let core = Core::default();
    core.apply_settings(fallbacks_across_rows());
    with_planners(&core);
    quota(&core, 90, 10);

    let (_, job) = delegate_role_as(&core, &dir, "auditor", Some("codex-pane"));
    assert_eq!(job["agent"], "codex", "{job}");
    assert_eq!(job["model"], "gpt-6-helper", "{job}");
    assert_eq!(job["routing"]["to"], "helper", "{job}");

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_read_only_row_never_falls_back_to_the_planners_writable_row() {
    let dir = workspace("role-fallback-read-only-row");
    let core = Core::default();
    core.apply_settings(fallbacks_across_rows());
    with_planners(&core);
    quota(&core, 10, 90);

    let (_, job) = delegate_role_as(&core, &dir, "inspector", Some("claude-pane"));
    assert_eq!(job["agent"], "codex", "{job}");
    assert_eq!(job["model"], "gpt-6-astra", "{job}");
    assert_eq!(job["readOnly"], true, "{job}");
    assert_ne!(job["routing"]["verdict"], "fallback", "{job}");

    let _ = std::fs::remove_dir_all(&dir);
}

// A thread Codex refuses to open, e.g. on a model or effort it does not accept, gets no further
// message. The worker has to fail with Codex's reason instead of showing running, holding its
// slot, until its budget runs out, or for good without one.
#[test]
fn a_codex_thread_that_fails_to_open_fails_its_worker() {
    let dir = workspace("thread-start-error");
    let core = Core::default();
    let transcript = concat!(
        r#"{"id":1,"result":{}}"#,
        "\n",
        r#"{"id":2,"error":{"code":-32602,"message":"unknown model: gpt-nope"}}"#,
        "\n",
    );
    core.set_launcher(Launcher {
        kind: "codex".into(),
        ..fake_claude_holding_launcher(&dir, transcript)
    });
    let delegated = call(
        &core,
        "alethe_delegate",
        json!({
            "tasks": ["review the diff"],
            "cwd": dir.to_string_lossy(),
            "agent": "codex",
            "model": "gpt-nope",
            "timeoutSeconds": 0
        }),
    );
    assert_eq!(delegated["accepted"], json!(1), "{delegated}");

    for _ in 0..100 {
        if job_field(&core, "job-01", "status") != "running" {
            break;
        }
        thread::sleep(Duration::from_millis(50));
    }
    assert_eq!(job_field(&core, "job-01", "status"), "failed");
    let summary = job_field(&core, "job-01", "summary");
    assert!(
        summary.as_str().unwrap_or_default().contains("unknown model: gpt-nope"),
        "{summary}"
    );
    assert_eq!(core.counts().0, 0, "the failed worker gives its slot back");
}

/// Answers the model list from a fixed reply and counts how often it was started.
fn fake_codex_model_launcher(dir: &std::path::Path, reply: &str) -> Launcher {
    let path = dir.join("models.jsonl");
    std::fs::write(&path, reply).expect("write fake reply");
    let runs = dir.join("runs");
    #[cfg(windows)]
    let (program, args): (&str, Vec<String>) = {
        let script = dir.join("models.bat");
        std::fs::write(
            &script,
            format!(
                "@echo off\r\necho run>>\"{}\"\r\ntype \"{}\"\r\n",
                runs.to_string_lossy(),
                path.to_string_lossy()
            ),
        )
        .expect("write fake script");
        (
            "cmd",
            vec!["/c".into(), script.to_string_lossy().into_owned()],
        )
    };
    #[cfg(not(windows))]
    let (program, args): (&str, Vec<String>) = (
        "sh",
        vec![
            "-c".into(),
            format!("echo run >> '{}'; cat '{}'", runs.display(), path.display()),
        ],
    );
    Launcher {
        kind: "codex".into(),
        program: PathBuf::from(program),
        args,
        env: Vec::new(),
    }
}

// Each ask starts a Codex process, so reopening the settings reuses the last list (#202, #255).
#[test]
fn the_codex_model_list_is_reused_instead_of_asked_again() {
    let dir = workspace("model-list-reuse");
    let core = Core::default();
    let reply = concat!(
        r#"{"id":1,"result":{}}"#,
        "\n",
        r#"{"id":2,"result":{"data":[{"id":"m1","model":"m1","displayName":"M1","defaultReasoningEffort":"low","supportedReasoningEfforts":[{"reasoningEffort":"low"}],"hidden":false}],"nextCursor":null}}"#,
        "\n",
    );
    core.set_launcher(fake_codex_model_launcher(&dir, reply));

    let first = core.list_codex_models().expect("models");
    let again = core.list_codex_models().expect("models");
    assert_eq!(first, again);
    assert_eq!(first[0]["model"], "m1", "{first}");
    let runs = std::fs::read_to_string(dir.join("runs")).unwrap_or_default();
    assert_eq!(runs.lines().count(), 1, "codex was started {runs:?}");
}

// ------------------------------------------------------------------ Antigravity (agy) workers (#218)

/// A fake `agy` that keeps reading stdin like the real one. It records its argv, its working folder
/// and then the launch itself, and every stdin line, in `fake`, starts its `--log-file` over as agy does, answers
/// `init` once, and for turn N plays `turnN.jsonl` (else `turn.jsonl`): first it waits `holdN`
/// seconds when that file exists and appends `denyN.log` to its log, then `partialN.log` as it is,
/// with no line break added; after the turn it appends `lateN.log` there 30 ms later. It appends the way agy does, leaving the log readable meanwhile. Its files live apart from the worker's folder, so they never show
/// up in the worker's diff. Launched while `linger` exists, it leaves behind a process that holds
/// its output open until `eof` appears (30 s at most), then writes `stale.jsonl` there, as a
/// worker's own child can.
fn scripted_agy_launcher(fake: &std::path::Path) -> Launcher {
    #[cfg(windows)]
    let (program, args): (&str, Vec<String>) = {
        std::fs::write(
            fake.join("linger.ps1"),
            r#"$until = (Get-Date).AddSeconds(30)
while (-not (Test-Path (Join-Path $PSScriptRoot 'eof')) -and (Get-Date) -lt $until) { Start-Sleep -Milliseconds 50 }
$stale = Join-Path $PSScriptRoot 'stale.jsonl'
if (Test-Path $stale) { foreach ($event in Get-Content $stale) { [Console]::Out.WriteLine($event) }; [Console]::Out.Flush() }
"#,
        )
        .expect("write lingering child");
        let script = fake.join("fake-agy.ps1");
        std::fs::write(
            &script,
            r#"$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Content -Path (Join-Path $dir 'args.txt') -Value ($args -join "`n")
Add-Content -Path (Join-Path $dir 'cwd.txt') -Value (Get-Location).Path
Add-Content -Path (Join-Path $dir 'launches.txt') -Value 'launch'
if (Test-Path (Join-Path $dir 'linger')) { Start-Process -NoNewWindow -FilePath powershell -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',"`"$(Join-Path $dir 'linger.ps1')`"" }
$log = $null
for ($i = 0; $i -lt $args.Count - 1; $i++) { if ($args[$i] -eq '--log-file') { $log = $args[$i + 1] } }
function Write-Log($text) { try { [IO.File]::AppendAllText($log, "$text`n") } catch {} }
if ($log) { try { [IO.File]::WriteAllText($log, "I0000 fake agy started`n") } catch {} }
[Console]::Out.WriteLine('{"event":"init","conversation_id":"agy-conv","init":{}}')
[Console]::Out.Flush()
$turn = 0
while ($null -ne ($line = [Console]::In.ReadLine())) {
  $turn++
  Add-Content -Path (Join-Path $dir 'stdin.txt') -Value $line
  $hold = Join-Path $dir "hold$turn"
  if (Test-Path $hold) { Start-Sleep -Seconds ([int](Get-Content $hold)) }
  $deny = Join-Path $dir "deny$turn.log"
  if ($log -and (Test-Path $deny)) { Write-Log ((Get-Content $deny) -join "`n") }
  $part = Join-Path $dir "partial$turn.log"
  if ($log -and (Test-Path $part)) { try { [IO.File]::AppendAllText($log, (Get-Content -Raw $part)) } catch {} }
  $out = Join-Path $dir "turn$turn.jsonl"
  if (-not (Test-Path $out)) { $out = Join-Path $dir 'turn.jsonl' }
  foreach ($event in Get-Content $out) { [Console]::Out.WriteLine($event) }
  [Console]::Out.Flush()
  $late = Join-Path $dir "late$turn.log"
  if ($log -and (Test-Path $late)) { Start-Sleep -Milliseconds 30; Write-Log ((Get-Content $late) -join "`n") }
}
"#,
        )
        .expect("write fake agy");
        (
            "powershell",
            vec![
                "-NoProfile".into(),
                "-ExecutionPolicy".into(),
                "Bypass".into(),
                "-File".into(),
                script.to_string_lossy().into_owned(),
            ],
        )
    };
    #[cfg(not(windows))]
    let (program, args): (&str, Vec<String>) = {
        let script = fake.join("fake-agy.sh");
        std::fs::write(
            &script,
            r#"dir=$(dirname "$0")
printf '%s\n' "$@" > "$dir/args.txt"
pwd >> "$dir/cwd.txt"
echo launch >> "$dir/launches.txt"
if [ -f "$dir/linger" ]; then
  (i=0; while [ ! -f "$dir/eof" ] && [ $i -lt 600 ]; do sleep 0.05; i=$((i + 1)); done
   [ -f "$dir/stale.jsonl" ] && cat "$dir/stale.jsonl") &
fi
log=; prev=
for arg in "$@"; do [ "$prev" = "--log-file" ] && log=$arg; prev=$arg; done
if [ -n "$log" ]; then echo 'I0000 fake agy started' > "$log"; fi
echo '{"event":"init","conversation_id":"agy-conv","init":{}}'
turn=0
while IFS= read -r line; do
  turn=$((turn + 1))
  printf '%s\n' "$line" >> "$dir/stdin.txt"
  if [ -f "$dir/hold$turn" ]; then sleep "$(cat "$dir/hold$turn")"; fi
  if [ -n "$log" ] && [ -f "$dir/deny$turn.log" ]; then { cat "$dir/deny$turn.log"; echo; } >> "$log"; fi
  if [ -n "$log" ] && [ -f "$dir/partial$turn.log" ]; then cat "$dir/partial$turn.log" >> "$log"; fi
  out="$dir/turn$turn.jsonl"; [ -f "$out" ] || out="$dir/turn.jsonl"
  cat "$out"
  if [ -n "$log" ] && [ -f "$dir/late$turn.log" ]; then sleep 0.03; { cat "$dir/late$turn.log"; echo; } >> "$log"; fi
done
"#,
        )
        .expect("write fake agy");
        ("sh", vec![script.to_string_lossy().into_owned()])
    };
    Launcher {
        kind: "antigravity".into(),
        program: PathBuf::from(program),
        args,
        env: Vec::new(),
    }
}

/// One `result` line of agy 1.3.3; its usage is cumulative over the conversation.
fn agy_result(response: &str, input: u64, output: u64, total: u64) -> String {
    json!({
        "event": "result",
        "result": {
            "conversation_id": "agy-conv",
            "status": "SUCCESS",
            "response": response,
            "num_turns": 1,
            "usage": {
                "input_tokens": input,
                "output_tokens": output,
                "thinking_tokens": 0,
                "cache_read_tokens": 0,
                "total_tokens": total
            }
        }
    })
    .to_string()
}

fn agy_delta(text: &str) -> String {
    json!({
        "event": "step_update",
        "step_update": {
            "conversation_id": "agy-conv",
            "step_index": 3,
            "state": "ACTIVE",
            "step_type": "agent_response",
            "text_delta": text
        }
    })
    .to_string()
}

/// Polls job-01 until `done` holds or `secs` pass, and returns its last snapshot.
fn wait_for_job(core: &Core, secs: u64, done: impl Fn(&Value) -> bool) -> Value {
    let deadline = std::time::Instant::now() + Duration::from_secs(secs);
    loop {
        let job = core.snapshot()["jobs"][0].clone();
        if done(&job) || std::time::Instant::now() > deadline {
            return job;
        }
        thread::sleep(Duration::from_millis(100));
    }
}

/// What the fake wrote; Windows PowerShell writes it in the ANSI code page, not UTF-8.
fn read_lossy(path: &std::path::Path) -> String {
    String::from_utf8_lossy(&std::fs::read(path).unwrap_or_default()).into_owned()
}

/// The lines of `path` once it has at least `count` of them, or what it has after `secs`.
fn wait_for_lines(path: &std::path::Path, count: usize, secs: u64) -> Vec<String> {
    let deadline = std::time::Instant::now() + Duration::from_secs(secs);
    loop {
        let lines: Vec<String> = read_lossy(path).lines().map(ToOwned::to_owned).collect();
        if lines.len() >= count || std::time::Instant::now() > deadline {
            return lines;
        }
        thread::sleep(Duration::from_millis(100));
    }
}

fn git_repo(dir: &std::path::Path) {
    for args in [
        vec!["init", "-q"],
        vec!["config", "user.email", "lab@example.com"],
        vec!["config", "user.name", "lab"],
    ] {
        let status = Command::new("git")
            .args(&args)
            .current_dir(dir)
            .status()
            .expect("git");
        assert!(status.success(), "git {args:?} failed");
    }
    std::fs::write(dir.join("seed.txt"), "seed\n").expect("seed");
    for args in [vec!["add", "-A"], vec!["commit", "-qm", "seed"]] {
        let status = Command::new("git")
            .args(&args)
            .current_dir(dir)
            .status()
            .expect("git");
        assert!(status.success(), "git {args:?} failed");
    }
}

#[test]
fn the_antigravity_launcher_streams_turns_in_accept_edits_and_never_bypasses() {
    let launcher = Launcher::antigravity_headless(PathBuf::from("agy"));
    assert_eq!(launcher.kind, "antigravity");
    // `-p` takes the prompt as its value in agy, so stdin streaming runs without it.
    assert_eq!(
        launcher.args,
        [
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--project",
            "alethe-worker",
            "--mode",
            "accept-edits",
            "--sandbox"
        ]
    );
    assert!(!launcher
        .args
        .iter()
        .any(|arg| arg == "--dangerously-skip-permissions"));
}

// agy 1.3.3 refuses a variant id next to --effort at start-up (exit 1), so the core never builds it.
#[test]
fn an_antigravity_worker_runs_a_variant_or_a_family_with_effort_but_never_both() {
    let args = |resume, model, effort| {
        orchestrator_core::agy_worker_args(r"C:\wt", r"C:\jobs\agy-cli.log", resume, model, effort)
    };
    assert_eq!(
        args(None, Some("claude-sonnet-5-5-medium"), None).expect("a variant alone"),
        [
            "--add-dir",
            r"C:\wt",
            "--model",
            "claude-sonnet-5-5-medium",
            "--log-file",
            r"C:\jobs\agy-cli.log"
        ]
    );
    assert_eq!(
        args(Some("conv-9"), Some("claude-sonnet-5-5"), Some("high")).expect("a family"),
        [
            "--add-dir",
            r"C:\wt",
            "--model",
            "claude-sonnet-5-5",
            "--effort",
            "high",
            "--log-file",
            r"C:\jobs\agy-cli.log",
            "--conversation",
            "conv-9"
        ]
    );
    assert_eq!(
        args(None, None, None).expect("the CLI default"),
        ["--add-dir", r"C:\wt", "--log-file", r"C:\jobs\agy-cli.log"]
    );
    assert!(args(None, Some("claude-sonnet-5-5-medium"), Some("high")).is_err());
    assert!(args(None, Some("gemini-3.8-flash-low"), Some("low")).is_err());
    // Effort alone would ride on whatever variant agy defaults to.
    assert!(args(None, None, Some("high")).is_err());
}

#[test]
fn antigravity_refuses_what_it_cannot_enforce_before_creating_anything() {
    let dir = workspace("agy-refused");
    let core = Core::default();
    // `isolate` outside a repository would fail later, so a refusal naming the flag came first.
    for (arguments, named) in [
        (json!({ "readOnly": true }), "readOnly"),
        (json!({ "askForApproval": true }), "askForApproval"),
        (
            json!({ "model": "claude-sonnet-5-5-medium", "effort": "high" }),
            "effort",
        ),
        (json!({ "effort": "high" }), "effort"),
    ] {
        let mut call_arguments = json!({
            "tasks": ["review"],
            "cwd": dir.to_string_lossy(),
            "agent": "antigravity",
            "isolate": true
        });
        for (key, value) in arguments.as_object().expect("arguments") {
            call_arguments[key] = value.clone();
        }
        let refused = call(&core, "alethe_delegate", call_arguments);
        let error = refused["error"].as_str().unwrap_or_default().to_string();
        assert!(error.contains(named), "{arguments}: {refused}");
    }
    assert_eq!(core.snapshot()["jobs"], json!([]));

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn an_antigravity_worker_takes_its_follow_up_on_the_same_process() {
    let dir = workspace("agy-turns");
    let fake = workspace("agy-turns-fake");
    std::fs::write(
        fake.join("turn1.jsonl"),
        format!(
            "{}\n{}\n",
            agy_delta("FIRST"),
            agy_result("FIRST", 100, 10, 110)
        ),
    )
    .expect("turn 1");
    // agy's own total leaves reasoning out (measured with agy 1.3.3); the board counts it as output.
    let mut second: Value =
        serde_json::from_str(&agy_result("SECOND", 250, 25, 275)).expect("result");
    second["result"]["usage"]["thinking_tokens"] = json!(5);
    std::fs::write(fake.join("turn2.jsonl"), format!("{second}\n")).expect("turn 2");
    let core = Core::default();
    core.set_launcher(scripted_agy_launcher(&fake));

    call(
        &core,
        "alethe_delegate",
        json!({
            "tasks": ["first task"],
            "cwd": dir.to_string_lossy(),
            "agent": "antigravity",
            "model": "claude-sonnet-5-5",
            "effort": "high"
        }),
    );
    let job = wait_for_job(&core, 20, |job| job["status"] == "done");
    assert_eq!(job["agent"], "antigravity", "{job}");
    assert_eq!(job["status"], "done", "{job}");
    assert_eq!(job["outcome"], "succeeded", "{job}");
    assert_eq!(job["threadId"], "agy-conv", "{job}");
    assert_eq!(job["summary"], "FIRST", "{job}");
    assert_eq!(job["tokens"]["last"]["inputTokens"], 100, "{job}");
    assert_eq!(job["tokens"]["total"]["totalTokens"], 110, "{job}");
    // Outside a repository there is no diff to report, and no failure to report either.
    assert_eq!(job["hasDiff"], false, "{job}");

    let sent = call(
        &core,
        "alethe_send",
        json!({ "jobId": "job-01", "message": "second task" }),
    );
    assert_eq!(sent["sent"], json!("job-01"), "{sent}");
    let job = wait_for_job(&core, 20, |job| job["summary"] == "SECOND");
    assert_eq!(job["status"], "done", "{job}");
    // agy reports usage for the whole conversation, so a turn's own is the difference.
    assert_eq!(job["tokens"]["last"]["inputTokens"], 150, "{job}");
    assert_eq!(job["tokens"]["last"]["outputTokens"], 20, "{job}");
    assert_eq!(job["tokens"]["last"]["totalTokens"], 170, "{job}");
    assert_eq!(job["tokens"]["total"]["totalTokens"], 280, "{job}");

    let launches = wait_for_lines(&fake.join("launches.txt"), 1, 5);
    assert_eq!(launches.len(), 1, "a follow-up started another agy");
    let stdin = wait_for_lines(&fake.join("stdin.txt"), 2, 5);
    assert_eq!(stdin.len(), 2, "{stdin:?}");
    let first: Value = serde_json::from_str(&stdin[0]).expect("a json line");
    assert_eq!(first["event"], "user", "{first}");
    assert!(first.get("type").is_none(), "{first}");
    assert!(stdin[1].contains("second task"), "{stdin:?}");

    let args = wait_for_lines(&fake.join("args.txt"), 1, 5);
    let after = |flag: &str| {
        args.iter()
            .position(|arg| arg == flag)
            .and_then(|at| args.get(at + 1))
            .cloned()
            .unwrap_or_default()
    };
    // Resolved: on macOS the temp folder is behind a link, on Windows CI behind a short name.
    assert_eq!(
        std::fs::canonicalize(after("--add-dir")).ok(),
        std::fs::canonicalize(&dir).ok(),
        "{args:?}"
    );
    assert_eq!(after("--model"), "claude-sonnet-5-5", "{args:?}");
    assert_eq!(after("--effort"), "high", "{args:?}");
    assert!(after("--log-file").ends_with("agy-cli.log"), "{args:?}");
    assert!(!args.iter().any(|arg| arg == "--conversation"), "{args:?}");

    let _ = call(&core, "alethe_cancel", json!({ "jobIds": ["job-01"] }));
    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::remove_dir_all(&fake);
}

#[test]
fn a_revived_antigravity_worker_resumes_its_conversation() {
    let dir = workspace("agy-resume");
    let fake = workspace("agy-resume-fake");
    std::fs::write(
        fake.join("turn.jsonl"),
        format!("{}\n", agy_result("DONE", 10, 1, 11)),
    )
    .expect("turn");
    let core = Core::default();
    core.set_launcher(scripted_agy_launcher(&fake));

    call(
        &core,
        "alethe_delegate",
        json!({ "tasks": ["task"], "cwd": dir.to_string_lossy(), "agent": "antigravity" }),
    );
    let job = wait_for_job(&core, 20, |job| job["status"] == "done");
    assert_eq!(job["threadId"], "agy-conv", "{job}");
    // Its process goes; its conversation stays with agy.
    call(&core, "alethe_release", json!({ "jobIds": ["job-01"] }));

    let sent = call(
        &core,
        "alethe_send",
        json!({ "jobId": "job-01", "message": "carry on" }),
    );
    assert_eq!(sent["revived"], json!("job-01"), "{sent}");
    let launches = wait_for_lines(&fake.join("launches.txt"), 2, 20);
    assert_eq!(launches.len(), 2, "the worker was not started again");
    let args = wait_for_lines(&fake.join("args.txt"), 1, 5);
    let at = args
        .iter()
        .position(|arg| arg == "--conversation")
        .unwrap_or_else(|| panic!("no --conversation: {args:?}"));
    assert_eq!(args[at + 1], "agy-conv", "{args:?}");
    assert!(args.iter().any(|arg| arg == "--add-dir"), "{args:?}");

    let _ = call(&core, "alethe_cancel", json!({ "jobIds": ["job-01"] }));
    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::remove_dir_all(&fake);
}

#[test]
fn antigravity_steers_wait_for_the_turn_and_go_first_in_the_order_sent() {
    let dir = workspace("agy-steer");
    let fake = workspace("agy-steer-fake");
    std::fs::write(fake.join("hold1"), "4").expect("hold");
    std::fs::write(
        fake.join("turn.jsonl"),
        format!("{}\n", agy_result("OK", 1, 1, 2)),
    )
    .expect("turn");
    let core = Core::default();
    core.set_launcher(scripted_agy_launcher(&fake));

    call(
        &core,
        "alethe_delegate",
        json!({ "tasks": ["first task"], "cwd": dir.to_string_lossy(), "agent": "antigravity" }),
    );
    let job = wait_for_job(&core, 20, |job| job["threadId"] == "agy-conv");
    assert_eq!(job["status"], "running", "{job}");

    let sent = call(
        &core,
        "alethe_send",
        json!({ "jobId": "job-01", "message": "follow-up" }),
    );
    assert_eq!(sent["queued"], json!("job-01"), "{sent}");
    // agy has no interrupt: a steer waits for the turn, then runs ahead of queued work.
    let steered = call(
        &core,
        "alethe_steer",
        json!({ "jobId": "job-01", "message": "turn A" }),
    );
    assert_eq!(steered["queued"], json!("job-01"), "{steered}");
    assert!(steered["note"].as_str().is_some(), "{steered}");
    call(
        &core,
        "alethe_steer",
        json!({ "jobId": "job-01", "message": "turn B" }),
    );
    assert_eq!(core.snapshot()["jobs"][0]["status"], "running");

    let stdin = wait_for_lines(&fake.join("stdin.txt"), 4, 30);
    let _ = call(&core, "alethe_cancel", json!({ "jobIds": ["job-01"] }));
    assert_eq!(stdin.len(), 4, "{stdin:?}");
    assert!(stdin[1].contains("turn A"), "{stdin:?}");
    assert!(stdin[2].contains("turn B"), "{stdin:?}");
    assert!(stdin[3].contains("follow-up"), "{stdin:?}");

    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::remove_dir_all(&fake);
}

#[test]
fn cancelling_an_antigravity_worker_tears_it_down_without_a_codex_rpc() {
    let dir = workspace("agy-cancel");
    let fake = workspace("agy-cancel-fake");
    std::fs::write(fake.join("hold1"), "60").expect("hold");
    std::fs::write(fake.join("turn.jsonl"), "").expect("turn");
    let core = Core::default();
    core.set_launcher(scripted_agy_launcher(&fake));

    call(
        &core,
        "alethe_delegate",
        json!({ "tasks": ["hold"], "cwd": dir.to_string_lossy(), "agent": "antigravity" }),
    );
    let stdin = wait_for_lines(&fake.join("stdin.txt"), 1, 20);
    assert_eq!(stdin.len(), 1, "the first turn never arrived");

    assert_eq!(core.cancel_jobs(&["job-01".to_string()]), ["job-01"]);
    let job = core.snapshot()["jobs"][0].clone();
    assert_eq!(job["status"], "cancelled", "{job}");
    assert_eq!(core.counts().0, 0, "the slot was not freed");
    thread::sleep(Duration::from_millis(500));
    assert_only_the_first_turn_was_written(&fake);

    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::remove_dir_all(&fake);
}

/// agy takes no JSON-RPC: the one line it got is its first turn, and no interrupt followed it.
fn assert_only_the_first_turn_was_written(fake: &std::path::Path) {
    let stdin = read_lossy(&fake.join("stdin.txt"));
    assert_eq!(stdin.lines().count(), 1, "{stdin}");
    let first: Value = serde_json::from_str(stdin.trim()).expect("a json line");
    assert_eq!(first["event"], "user", "{first}");
}

#[test]
fn an_antigravity_worker_past_its_budget_is_stopped() {
    let dir = workspace("agy-timeout");
    let fake = workspace("agy-timeout-fake");
    std::fs::write(fake.join("hold1"), "60").expect("hold");
    std::fs::write(fake.join("turn.jsonl"), "").expect("turn");
    let core = Core::default();
    core.set_launcher(scripted_agy_launcher(&fake));

    call(
        &core,
        "alethe_delegate",
        json!({
            "tasks": ["hang"],
            "cwd": dir.to_string_lossy(),
            "agent": "antigravity",
            "timeoutSeconds": 3
        }),
    );
    let checked = call(
        &core,
        "alethe_check",
        json!({ "wait": true, "timeoutMs": 30000 }),
    );
    let deliveries = checked["deliveries"].as_array().expect("deliveries");
    assert_eq!(deliveries.len(), 1, "{checked}");
    assert_eq!(deliveries[0]["outcome"], json!("timeout"), "{checked}");
    assert_eq!(checked["workersStillBusy"], json!(0), "{checked}");
    assert_only_the_first_turn_was_written(&fake);

    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::remove_dir_all(&fake);
}

// The cut of a long reply used to land inside a multi-byte character and abort the app (#256).
#[test]
fn a_long_unicode_reply_from_antigravity_is_kept_whole_at_its_end() {
    let dir = workspace("agy-unicode");
    let core = Core::default();
    let transcript = format!(
        "{}\n{}\n{}\n{}\n",
        r#"{"event":"init","conversation_id":"agy-utf8","init":{}}"#,
        agy_delta(&"ã".repeat(16_000)),
        agy_delta("a"),
        agy_result("revisão concluída ✓", 1, 1, 2),
    );
    let mut launcher = fake_claude_launcher(&dir, &transcript);
    launcher.kind = "antigravity".into();
    core.set_launcher(launcher);
    // This fake only replays its output, so the log agy would have started is made here.
    let store = workspace("agy-unicode-store");
    core.set_store(store.join("orchestrator.json"));
    let log = agy_log_of_first_job(&store);
    std::fs::create_dir_all(log.parent().expect("job dir")).expect("job dir");
    std::fs::write(&log, "I0000 started\n").expect("log");

    call(
        &core,
        "alethe_delegate",
        json!({ "tasks": ["write"], "cwd": dir.to_string_lossy(), "agent": "antigravity" }),
    );
    let job = wait_for_job(&core, 20, |job| {
        job["status"] != "running" && job["status"] != "queued"
    });
    assert_eq!(job["status"], "done", "{job}");
    assert_eq!(job["summary"], "revisão concluída ✓", "{job}");

    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::remove_dir_all(&store);
}

/// Where the core puts job-01's agy log for a core whose store is in `store`.
fn agy_log_of_first_job(store: &std::path::Path) -> PathBuf {
    store.join("jobs").join("job-01").join("agy-cli.log")
}

fn agy_tool_step(index: u64, state: &str) -> String {
    json!({
        "event": "step_update",
        "step_update": {
            "conversation_id": "agy-conv",
            "step_index": index,
            "state": state,
            "step_type": "tool",
            "tool_name": "run_command",
            "tool_info": { "name": "run_command", "parameters": { "CommandLine": "whoami" } }
        }
    })
    .to_string()
}

// The log is the only exact record of a denial: a turn it cannot be checked against is not done.
#[test]
fn an_antigravity_turn_whose_log_is_missing_is_not_done() {
    let dir = workspace("agy-log-missing");
    let store = workspace("agy-log-missing-store");
    let core = Core::default();
    core.set_store(store.join("orchestrator.json"));
    let transcript = format!(
        "{}\n{}\n{}\n",
        r#"{"event":"init","conversation_id":"agy-nolog","init":{}}"#,
        agy_tool_step(4, "ERROR"),
        agy_result("all done", 1, 1, 2),
    );
    let mut launcher = fake_claude_launcher(&dir, &transcript);
    launcher.kind = "antigravity".into();
    core.set_launcher(launcher);

    call(
        &core,
        "alethe_delegate",
        json!({ "tasks": ["x"], "cwd": dir.to_string_lossy(), "agent": "antigravity" }),
    );
    let job = wait_for_job(&core, 20, |job| {
        job["status"] != "running" && job["status"] != "queued"
    });
    assert_eq!(job["status"], "failed", "{job}");
    let summary = job["summary"].as_str().unwrap_or_default();
    assert!(summary.contains("agy's log"), "{job}");
    assert!(summary.contains("all done"), "the reply was dropped: {job}");

    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::remove_dir_all(&store);
}

#[test]
fn an_antigravity_turn_whose_log_cannot_be_read_is_not_done() {
    let dir = workspace("agy-log-unreadable");
    let fake = workspace("agy-log-unreadable-fake");
    let store = workspace("agy-log-unreadable-store");
    // A folder where the log file should be: it exists, but no read of it succeeds.
    std::fs::create_dir_all(agy_log_of_first_job(&store)).expect("a folder in the log's place");
    std::fs::write(
        fake.join("turn.jsonl"),
        format!("{}\n", agy_result("all done", 1, 1, 2)),
    )
    .expect("turn");
    let core = Core::default();
    core.set_store(store.join("orchestrator.json"));
    core.set_launcher(scripted_agy_launcher(&fake));

    call(
        &core,
        "alethe_delegate",
        json!({ "tasks": ["x"], "cwd": dir.to_string_lossy(), "agent": "antigravity" }),
    );
    let job = wait_for_job(&core, 20, |job| {
        job["status"] != "running" && job["status"] != "queued"
    });
    let _ = call(&core, "alethe_cancel", json!({ "jobIds": ["job-01"] }));
    assert_eq!(job["status"], "failed", "{job}");
    let summary = job["summary"].as_str().unwrap_or_default();
    assert!(summary.contains("agy's log"), "{job}");
    assert!(summary.contains("all done"), "the reply was dropped: {job}");

    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::remove_dir_all(&fake);
    let _ = std::fs::remove_dir_all(&store);
}

// agy logged the denial about 40 ms before `result` in the one run measured; a line that lands just
// after it still belongs to the turn whose step it names.
#[test]
fn a_denial_logged_just_after_the_result_still_blocks_its_turn() {
    let dir = workspace("agy-late-denial");
    let fake = workspace("agy-late-denial-fake");
    let store = workspace("agy-late-denial-store");
    std::fs::write(
        fake.join("turn1.jsonl"),
        format!(
            "{}\n{}\n",
            agy_tool_step(9, "ERROR"),
            agy_result("looks fine", 1, 1, 2)
        ),
    )
    .expect("turn 1");
    std::fs::write(
        fake.join("late1.log"),
        "I1010 04:11:11 soft-denying tool confirmation \"RunCommand\" at step 9",
    )
    .expect("late 1");
    // The contract: a soft-denied command step can also end DONE, with no error at all.
    std::fs::write(
        fake.join("turn2.jsonl"),
        format!(
            "{}\n{}\n",
            agy_tool_step(12, "DONE"),
            agy_result("still fine", 2, 2, 4)
        ),
    )
    .expect("turn 2");
    std::fs::write(
        fake.join("late2.log"),
        "I1010 04:11:14 soft-denying tool confirmation \"RunCommand\" at step 12",
    )
    .expect("late 2");
    let core = Core::default();
    core.set_store(store.join("orchestrator.json"));
    core.set_launcher(scripted_agy_launcher(&fake));
    // The fake writes each late line 30 ms after `result`; on a loaded machine that write could
    // land after the production wait (ACH-0022), so this core waits long enough for it anyway.
    core.set_agy_log_grace(Duration::from_secs(2));

    call(
        &core,
        "alethe_delegate",
        json!({ "tasks": ["x"], "cwd": dir.to_string_lossy(), "agent": "antigravity" }),
    );
    let job = wait_for_job(&core, 20, |job| {
        job["status"] != "running" && job["status"] != "queued"
    });
    assert_eq!(job["outcome"], "blocked", "{job}");
    assert!(
        job["summary"]
            .as_str()
            .unwrap_or_default()
            .contains("at step 9"),
        "{job}"
    );

    call(
        &core,
        "alethe_send",
        json!({ "jobId": "job-01", "message": "again" }),
    );
    let job = wait_for_job(&core, 20, |job| {
        job["status"] != "running"
            && !job["summary"]
                .as_str()
                .unwrap_or_default()
                .contains("at step 9")
    });
    let _ = call(&core, "alethe_cancel", json!({ "jobIds": ["job-01"] }));
    assert_eq!(job["outcome"], "blocked", "{job}");
    assert!(
        job["summary"]
            .as_str()
            .unwrap_or_default()
            .contains("at step 12"),
        "{job}"
    );

    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::remove_dir_all(&fake);
    let _ = std::fs::remove_dir_all(&store);
}

#[test]
fn a_denial_line_for_an_earlier_turns_step_does_not_block_the_next_turn() {
    let dir = workspace("agy-stale-denial");
    let fake = workspace("agy-stale-denial-fake");
    let store = workspace("agy-stale-denial-store");
    std::fs::write(
        fake.join("turn1.jsonl"),
        format!(
            "{}\n{}\n",
            agy_tool_step(4, "DONE"),
            agy_result("first", 1, 1, 2)
        ),
    )
    .expect("turn 1");
    // Step 4 was turn 1's; its line reaches the log only while turn 2 runs.
    std::fs::write(
        fake.join("deny2.log"),
        "I1010 04:11:12 soft-denying tool confirmation \"RunCommand\" at step 4",
    )
    .expect("deny 2");
    std::fs::write(
        fake.join("turn2.jsonl"),
        format!(
            "{}\n{}\n",
            agy_tool_step(8, "DONE"),
            agy_result("second", 2, 2, 4)
        ),
    )
    .expect("turn 2");
    let core = Core::default();
    core.set_store(store.join("orchestrator.json"));
    core.set_launcher(scripted_agy_launcher(&fake));

    call(
        &core,
        "alethe_delegate",
        json!({ "tasks": ["x"], "cwd": dir.to_string_lossy(), "agent": "antigravity" }),
    );
    wait_for_job(&core, 20, |job| job["summary"] == "first");
    call(
        &core,
        "alethe_send",
        json!({ "jobId": "job-01", "message": "next" }),
    );
    let job = wait_for_job(&core, 20, |job| {
        job["status"] != "running" && job["summary"] != "first"
    });
    let _ = call(&core, "alethe_cancel", json!({ "jobIds": ["job-01"] }));
    assert_eq!(job["status"], "done", "{job}");
    assert_eq!(job["summary"], "second", "{job}");

    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::remove_dir_all(&fake);
    let _ = std::fs::remove_dir_all(&store);
}

// agy 1.3.3 starts its `--log-file` over on every launch (measured), so a resumed worker's log can
// outgrow the last run's with its denial inside what the last run had already read.
#[test]
fn a_resumed_antigravity_worker_sees_a_denial_early_in_its_restarted_log() {
    let dir = workspace("agy-restarted-log");
    let fake = workspace("agy-restarted-log-fake");
    let store = workspace("agy-restarted-log-store");
    let chatter = "I1010 04:11:10 plain agy chatter\n".repeat(40);
    std::fs::write(fake.join("deny1.log"), chatter.trim_end()).expect("deny 1");
    std::fs::write(
        fake.join("turn1.jsonl"),
        format!("{}\n", agy_result("first", 1, 1, 2)),
    )
    .expect("turn 1");
    let core = Core::default();
    core.set_store(store.join("orchestrator.json"));
    core.set_launcher(scripted_agy_launcher(&fake));

    call(
        &core,
        "alethe_delegate",
        json!({ "tasks": ["x"], "cwd": dir.to_string_lossy(), "agent": "antigravity" }),
    );
    let job = wait_for_job(&core, 20, |job| job["status"] == "done");
    assert_eq!(job["summary"], "first", "{job}");
    call(&core, "alethe_release", json!({ "jobIds": ["job-01"] }));

    // The revived process plays turn 1 again: its denial first, then more than the old log held.
    std::fs::write(
        fake.join("deny1.log"),
        format!(
            "I1010 04:12:00 soft-denying tool confirmation \"RunCommand\" at step 20\n{}",
            chatter.repeat(2).trim_end()
        ),
    )
    .expect("deny 1 again");
    std::fs::write(
        fake.join("turn1.jsonl"),
        format!(
            "{}\n{}\n",
            agy_tool_step(20, "DONE"),
            agy_result("second", 2, 2, 4)
        ),
    )
    .expect("turn 1 again");
    let sent = call(
        &core,
        "alethe_send",
        json!({ "jobId": "job-01", "message": "carry on" }),
    );
    assert_eq!(sent["revived"], json!("job-01"), "{sent}");
    let job = wait_for_job(&core, 20, |job| {
        job["status"] != "running" && job["status"] != "queued" && job["summary"] != "first"
    });
    let _ = call(&core, "alethe_cancel", json!({ "jobIds": ["job-01"] }));
    assert_eq!(job["outcome"], "blocked", "{job}");
    assert!(
        job["summary"]
            .as_str()
            .unwrap_or_default()
            .contains("at step 20"),
        "{job}"
    );

    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::remove_dir_all(&fake);
    let _ = std::fs::remove_dir_all(&store);
}

/// Plays a turn on a `kind` worker the scripted fake stands in for and releases it while a process
/// it left behind still holds its output open. Only once the worker is revived does that output say
/// `stale` (when asked) and close, while the revived turn is still in flight. `turn` is the input
/// line, counted from each launch, that `reply` answers; `opening` are the fake's other files.
fn revive_while_the_released_output_is_open(
    kind: &str,
    turn: usize,
    opening: &[(&str, String)],
    reply: impl Fn(&str) -> String,
    stale: bool,
) -> Value {
    let dir = workspace(&format!("late-eof-{kind}"));
    git_repo(&dir);
    let fake = workspace(&format!("late-eof-{kind}-fake"));
    for (name, text) in opening {
        std::fs::write(fake.join(name), text).expect("opening");
    }
    let played = fake.join(format!("turn{turn}.jsonl"));
    std::fs::write(&played, reply("first")).expect("first turn");
    std::fs::write(fake.join("linger"), "").expect("linger");
    let core = Core::default();
    let mut launcher = scripted_agy_launcher(&fake);
    launcher.kind = kind.into();
    core.set_launcher(launcher);

    call(
        &core,
        "alethe_delegate",
        json!({ "tasks": ["x"], "cwd": dir.to_string_lossy(), "agent": kind }),
    );
    let job = wait_for_job(&core, 20, |job| job["status"] == "done");
    assert_eq!(job["summary"], "first", "{job}");
    call(&core, "alethe_release", json!({ "jobIds": ["job-01"] }));

    std::fs::remove_file(fake.join("linger")).expect("linger gone");
    std::fs::write(fake.join(format!("hold{turn}")), "3").expect("hold");
    std::fs::write(&played, reply("second")).expect("second turn");
    if stale {
        std::fs::write(fake.join("stale.jsonl"), reply("stale")).expect("stale");
    }
    let sent = call(
        &core,
        "alethe_send",
        json!({ "jobId": "job-01", "message": "carry on" }),
    );
    assert_eq!(sent["revived"], json!("job-01"), "{sent}");
    let launches = wait_for_lines(&fake.join("launches.txt"), 2, 20);
    assert_eq!(launches.len(), 2, "the worker was not started again");
    // The released process's output closes only now, inside the revived turn's hold.
    std::fs::write(fake.join("eof"), "").expect("eof");
    let job = wait_for_job(&core, 20, |job| {
        job["status"] != "running" && job["status"] != "queued"
    });

    let _ = call(&core, "alethe_cancel", json!({ "jobIds": ["job-01"] }));
    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::remove_dir_all(&fake);
    job
}

// ACH-0023: a released worker's process said nothing more, but its output closing after the revive
// failed the revived run with "worker connection closed".
#[test]
fn a_released_antigravity_process_closing_late_does_not_end_its_revived_run() {
    let job = revive_while_the_released_output_is_open(
        "antigravity",
        1,
        &[],
        |text| format!("{}\n", agy_result(text, 1, 1, 2)),
        false,
    );
    assert_eq!(job["status"], "done", "{job}");
    assert_eq!(job["summary"], "second", "{job}");
}

#[test]
fn a_released_claude_process_speaking_late_does_not_reach_its_revived_run() {
    let job = revive_while_the_released_output_is_open(
        "claude",
        1,
        &[],
        |text| {
            format!(
                "{}\n{}\n",
                r#"{"type":"system","subtype":"init","session_id":"late-session"}"#,
                json!({ "type": "result", "is_error": false, "result": text })
            )
        },
        true,
    );
    assert_eq!(job["status"], "done", "{job}");
    assert_eq!(job["summary"], "second", "{job}");
}

#[test]
fn a_released_codex_process_speaking_late_does_not_reach_its_revived_run() {
    // Input lines 1-3 are initialize, initialized and the thread's opening; line 4 is the turn.
    let thread = json!({ "id": 2, "result": { "thread": { "id": "late-thread" } } });
    let job = revive_while_the_released_output_is_open(
        "codex",
        4,
        &[("turn3.jsonl", format!("{thread}\n"))],
        |text| {
            format!(
                "{}\n{}\n",
                json!({ "method": "item/completed", "params": { "item": { "type": "agentMessage", "text": text } } }),
                json!({ "method": "turn/completed", "params": {} })
            )
        },
        true,
    );
    assert_eq!(job["status"], "done", "{job}");
    assert_eq!(job["summary"], "second", "{job}");
}

// The released process's reader may already have found an event current when the release lands; the
// revive must still not start its run under that event.
#[test]
fn an_event_found_current_before_a_release_never_lands_in_the_revived_run() {
    let dir = workspace("held-event");
    git_repo(&dir);
    let fake = workspace("held-event-fake");
    let thread_reply = json!({ "id": 2, "result": { "thread": { "id": "held-thread" } } });
    std::fs::write(fake.join("turn3.jsonl"), format!("{thread_reply}\n")).expect("thread");
    let said = |text: &str| {
        let item = json!({ "type": "agentMessage", "text": text });
        json!({ "method": "item/completed", "params": { "item": item } })
    };
    let completed = json!({ "method": "turn/completed", "params": {} });
    // Its last line comes after the turn ended, so the reader takes it while the job is done.
    let late = json!({ "method": "turn/completed", "params": { "late": true } });
    std::fs::write(
        fake.join("turn4.jsonl"),
        format!("{}\n{completed}\n{late}\n", said("first")),
    )
    .expect("turn 4");
    let core = Core::default();
    let mut launcher = scripted_agy_launcher(&fake);
    launcher.kind = "codex".into();
    core.set_launcher(launcher);
    let (reached, held) = std::sync::mpsc::channel();
    let (resume, go) = std::sync::mpsc::channel::<()>();
    let go = Mutex::new(go);
    core.set_reader_hook(Arc::new(move |message: &Value| {
        if message["params"]["late"] == true {
            let _ = reached.send(());
            let _ = go.lock().expect("go").recv();
        }
    }));

    call(
        &core,
        "alethe_delegate",
        json!({ "tasks": ["x"], "cwd": dir.to_string_lossy(), "agent": "codex" }),
    );
    held.recv_timeout(Duration::from_secs(20))
        .expect("the reader took the late line");
    let job = core.snapshot()["jobs"][0].clone();
    assert_eq!(job["summary"], "first", "{job}");

    call(&core, "alethe_release", json!({ "jobIds": ["job-01"] }));
    std::fs::write(fake.join("hold4"), "3").expect("hold");
    std::fs::write(
        fake.join("turn4.jsonl"),
        format!("{}\n{completed}\n", said("second")),
    )
    .expect("turn 4 again");
    let reviver = core.clone();
    let (answered, answer) = std::sync::mpsc::channel();
    thread::spawn(move || {
        let sent = call(
            &reviver,
            "alethe_send",
            json!({ "jobId": "job-01", "message": "carry on" }),
        );
        let _ = answered.send(sent);
    });
    // A revive that does not wait for the held event gets this long to start its run first.
    let early = answer.recv_timeout(Duration::from_secs(2));
    resume.send(()).expect("the reader goes on");
    let sent = early
        .or_else(|_| answer.recv_timeout(Duration::from_secs(20)))
        .expect("the revive answered");
    assert_eq!(sent["revived"], json!("job-01"), "{sent}");
    let job = wait_for_job(&core, 20, |job| {
        !["running", "queued", "released"].contains(&job["status"].as_str().unwrap_or_default())
    });

    let _ = call(&core, "alethe_cancel", json!({ "jobIds": ["job-01"] }));
    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::remove_dir_all(&fake);
    assert_eq!(job["status"], "done", "{job}");
    assert_eq!(job["summary"], "second", "{job}");
}

/// A Codex worker the scripted fake plays says "first", is released, and is revived into a turn
/// that streams "second" as deltas only, with no `item/completed` of its own. With `late`, the
/// first process also says "stale" after its turn ended, held by its reader until the release has
/// landed. Returns the revived run's job.
fn revive_into_a_turn_without_its_own_report(late: bool) -> Value {
    let tag = if late { "late-report" } else { "kept-report" };
    let dir = workspace(tag);
    let fake = workspace(&format!("{tag}-fake"));
    let thread_reply = json!({ "id": 2, "result": { "thread": { "id": "report-thread" } } });
    std::fs::write(fake.join("turn3.jsonl"), format!("{thread_reply}\n")).expect("thread");
    let said = |text: &str, late: bool| {
        let item = json!({ "type": "agentMessage", "text": text });
        json!({ "method": "item/completed", "params": { "item": item, "late": late } })
    };
    let completed = json!({ "method": "turn/completed", "params": {} });
    let mut first = format!("{}\n{completed}\n", said("first", false));
    if late {
        first.push_str(&format!("{}\n", said("stale", true)));
    }
    std::fs::write(fake.join("turn4.jsonl"), first).expect("turn 4");
    let core = Core::default();
    let mut launcher = scripted_agy_launcher(&fake);
    launcher.kind = "codex".into();
    core.set_launcher(launcher);
    let (reached, held) = std::sync::mpsc::channel();
    let (resume, go) = std::sync::mpsc::channel::<()>();
    let go = Mutex::new(go);
    core.set_reader_hook(Arc::new(move |message: &Value| {
        if message["params"]["late"] == true {
            let _ = reached.send(());
            let _ = go.lock().expect("go").recv();
        }
    }));

    call(
        &core,
        "alethe_delegate",
        json!({ "tasks": ["x"], "cwd": dir.to_string_lossy(), "agent": "codex" }),
    );
    if late {
        held.recv_timeout(Duration::from_secs(20))
            .expect("the reader took the late line");
    }
    let job = wait_for_job(&core, 20, |job| job["status"] == "done");
    assert_eq!(job["summary"], "first", "{job}");
    call(&core, "alethe_release", json!({ "jobIds": ["job-01"] }));
    if late {
        resume.send(()).expect("the reader goes on");
        let job = wait_for_job(&core, 20, |job| job["summary"] == "stale");
        assert_eq!(job["summary"], "stale", "the late line never landed: {job}");
    }

    let delta = json!({ "method": "item/agentMessage/delta", "params": { "delta": "second" } });
    std::fs::write(fake.join("turn4.jsonl"), format!("{delta}\n{completed}\n")).expect("turn 4");
    let sent = call(
        &core,
        "alethe_send",
        json!({ "jobId": "job-01", "message": "carry on" }),
    );
    assert_eq!(sent["revived"], json!("job-01"), "{sent}");
    let job = wait_for_job(&core, 20, |job| {
        job["status"] != "running" && job["status"] != "queued"
    });

    let _ = call(&core, "alethe_cancel", json!({ "jobIds": ["job-01"] }));
    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::remove_dir_all(&fake);
    job
}

#[test]
fn a_report_written_after_the_release_is_not_delivered_by_the_revived_run() {
    let job = revive_into_a_turn_without_its_own_report(true);
    assert_eq!(job["status"], "done", "{job}");
    assert_eq!(job["summary"], "second", "{job}");
}

#[test]
fn a_revived_turn_without_its_own_report_does_not_deliver_the_last_one() {
    let job = revive_into_a_turn_without_its_own_report(false);
    assert_eq!(job["status"], "done", "{job}");
    assert_eq!(job["summary"], "second", "{job}");
}

// agy wrote whole lines in every run measured, but a line caught mid-write may be this turn's denial.
#[test]
fn a_denial_line_still_being_written_never_reads_as_no_denial() {
    let dir = workspace("agy-partial-denial");
    let fake = workspace("agy-partial-denial-fake");
    let store = workspace("agy-partial-denial-store");
    let denial = |step: u64| {
        format!("I1010 04:11:11 soft-denying tool confirmation \"RunCommand\" at step {step}")
    };
    // Turn 1: the line ends 30 ms after `result`, inside the wait.
    std::fs::write(fake.join("partial1.log"), denial(9)).expect("partial 1");
    std::fs::write(fake.join("late1.log"), "").expect("late 1");
    std::fs::write(
        fake.join("turn1.jsonl"),
        format!(
            "{}\n{}\n",
            agy_tool_step(9, "DONE"),
            agy_result("looks fine", 1, 1, 2)
        ),
    )
    .expect("turn 1");
    // Turn 2: the line never ends.
    std::fs::write(fake.join("partial2.log"), denial(12)).expect("partial 2");
    std::fs::write(
        fake.join("turn2.jsonl"),
        format!(
            "{}\n{}\n",
            agy_tool_step(12, "DONE"),
            agy_result("still fine", 2, 2, 4)
        ),
    )
    .expect("turn 2");
    let core = Core::default();
    core.set_store(store.join("orchestrator.json"));
    core.set_launcher(scripted_agy_launcher(&fake));

    call(
        &core,
        "alethe_delegate",
        json!({ "tasks": ["x"], "cwd": dir.to_string_lossy(), "agent": "antigravity" }),
    );
    let job = wait_for_job(&core, 20, |job| {
        job["status"] != "running" && job["status"] != "queued"
    });
    assert_eq!(job["outcome"], "blocked", "{job}");

    call(
        &core,
        "alethe_send",
        json!({ "jobId": "job-01", "message": "again" }),
    );
    let job = wait_for_job(&core, 20, |job| {
        job["status"] != "running" && job["outcome"] != "blocked"
    });
    let _ = call(&core, "alethe_cancel", json!({ "jobIds": ["job-01"] }));
    assert_eq!(job["status"], "failed", "{job}");
    let summary = job["summary"].as_str().unwrap_or_default();
    assert!(summary.contains("[unverified]"), "{job}");
    assert!(summary.contains("still fine"), "the reply was dropped: {job}");

    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::remove_dir_all(&fake);
    let _ = std::fs::remove_dir_all(&store);
}

// A relative folder would be read twice, by the process start and again by `--add-dir` from inside
// it: `..` would reach the grandparent.
#[test]
fn an_antigravity_worker_given_a_relative_folder_stays_in_it_when_resumed() {
    let name = format!("agy-relative-{}", std::process::id());
    let base = std::env::current_dir().expect("cwd").join("target");
    let absolute = base.join(&name);
    let _ = std::fs::remove_dir_all(&absolute);
    std::fs::create_dir_all(absolute.join("inner")).expect("folder");
    git_repo(&absolute);
    let fake = workspace("agy-relative-fake");
    std::fs::write(
        fake.join("turn.jsonl"),
        format!("{}\n", agy_result("OK", 1, 1, 2)),
    )
    .expect("turn");
    let core = Core::default();
    core.set_launcher(scripted_agy_launcher(&fake));
    let same = |path: &str| {
        std::path::Path::new(path).is_absolute()
            && std::fs::canonicalize(path).ok() == std::fs::canonicalize(&absolute).ok()
    };

    call(
        &core,
        "alethe_delegate",
        json!({
            "tasks": ["x"],
            "cwd": format!("target/{name}/inner/.."),
            "agent": "antigravity"
        }),
    );
    let job = wait_for_job(&core, 20, |job| job["status"] == "done");
    assert!(same(job["cwd"].as_str().unwrap_or_default()), "{job}");
    call(&core, "alethe_release", json!({ "jobIds": ["job-01"] }));
    call(
        &core,
        "alethe_send",
        json!({ "jobId": "job-01", "message": "again" }),
    );
    let launches = wait_for_lines(&fake.join("launches.txt"), 2, 20);
    let started_in = wait_for_lines(&fake.join("cwd.txt"), 2, 5);
    let args = wait_for_lines(&fake.join("args.txt"), 1, 5);
    // A finished worker stays parked in the folder until released, which keeps it from deletion.
    wait_for_job(&core, 20, |job| job["status"] != "running");
    let _ = call(&core, "alethe_release", json!({ "jobIds": ["job-01"] }));
    assert_eq!(launches.len(), 2, "the worker was not resumed");
    assert!(args.iter().any(|arg| arg == "--conversation"), "{args:?}");
    let add_dir = args
        .iter()
        .position(|arg| arg == "--add-dir")
        .and_then(|at| args.get(at + 1))
        .cloned()
        .unwrap_or_default();
    assert!(same(&add_dir), "--add-dir {add_dir} is not the folder");
    for folder in &started_in {
        assert!(same(folder.trim()), "started in {folder}: {started_in:?}");
    }

    let _ = std::fs::remove_dir_all(&absolute);
    // Only when this run created it and nothing else is in it.
    let _ = std::fs::remove_dir(&base);
    let _ = std::fs::remove_dir_all(&fake);
}

// `git ls-files -z` separates names with NUL; trimming its output cut the space a name starts with.
#[test]
fn a_new_file_whose_name_starts_with_a_space_is_in_the_diff() {
    let dir = workspace("diff-leading-space");
    git_repo(&dir);
    std::fs::write(dir.join(" novo.txt"), "conteudo\n").expect("new file");
    let core = Core::default();
    let transcript = concat!(
        r#"{"type":"system","subtype":"init","session_id":"space"}"#,
        "\n",
        r#"{"type":"result","is_error":false,"result":"ADDED","usage":{"input_tokens":1,"output_tokens":1}}"#,
        "\n",
    );
    core.set_launcher(fake_claude_launcher(&dir.join(".git"), transcript));

    call(
        &core,
        "alethe_delegate",
        json!({ "tasks": ["add"], "cwd": dir.to_string_lossy(), "agent": "claude" }),
    );
    let job = wait_for_job(&core, 20, |job| job["status"] == "done");
    assert_eq!(job["hasDiff"], true, "{job}");
    let diff = call(&core, "alethe_diff", json!({ "jobId": "job-01" }));
    assert!(
        diff["diff"]
            .as_str()
            .unwrap_or_default()
            .contains("+conteudo"),
        "{diff}"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

// Measured: git lists a file whose name ends in a dot, but Windows strips that dot when git opens it,
// so `git diff --no-index` exits 1, as for a real difference, with no output and "Could not access".
#[cfg(windows)]
#[test]
fn a_new_file_git_cannot_read_makes_the_diff_say_so_instead_of_no_changes() {
    let dir = workspace("diff-unreadable");
    git_repo(&dir);
    // The `\\?\` form keeps the trailing dot that Windows would otherwise drop.
    let ghost = PathBuf::from(format!(r"\\?\{}\ghost.", dir.to_string_lossy()));
    std::fs::write(&ghost, "boo\n").expect("a file named with a trailing dot");
    let core = Core::default();
    let transcript = concat!(
        r#"{"type":"system","subtype":"init","session_id":"ghost"}"#,
        "\n",
        r#"{"type":"result","is_error":false,"result":"ADDED","usage":{"input_tokens":1,"output_tokens":1}}"#,
        "\n",
    );
    core.set_launcher(fake_claude_launcher(&dir.join(".git"), transcript));

    call(
        &core,
        "alethe_delegate",
        json!({ "tasks": ["add"], "cwd": dir.to_string_lossy(), "agent": "claude" }),
    );
    let job = wait_for_job(&core, 20, |job| job["status"] == "done");
    let _ = std::fs::remove_file(&ghost);
    assert_eq!(job["hasDiff"], true, "the diff claims no changes: {job}");
    // The reply is not empty, so the summary is the worker's own text: the planner reads it.
    assert!(
        job["summary"]
            .as_str()
            .unwrap_or_default()
            .contains("[diff unavailable]"),
        "the planner is not told: {job}"
    );
    let diff = call(&core, "alethe_diff", json!({ "jobId": "job-01" }));
    let text = diff["diff"].as_str().unwrap_or_default();
    assert!(text.contains("[diff unavailable]"), "{diff}");
    assert!(text.contains("ghost."), "{diff}");

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn an_antigravity_start_up_error_fails_the_worker_with_its_reason() {
    let dir = workspace("agy-startup");
    let core = Core::default();
    let transcript = concat!(
        r#"{"event":"result","result":{"conversation_id":"","status":"ERROR","response":"","error":"invalid model selection: --model x conflicts with --effort=high","num_turns":0,"usage":{"input_tokens":0,"output_tokens":0,"total_tokens":0}}}"#,
        "\n",
    );
    let mut launcher = fake_claude_launcher(&dir, transcript);
    launcher.kind = "antigravity".into();
    core.set_launcher(launcher);

    call(
        &core,
        "alethe_delegate",
        json!({ "tasks": ["x"], "cwd": dir.to_string_lossy(), "agent": "antigravity" }),
    );
    let job = wait_for_job(&core, 20, |job| job["status"] == "failed");
    assert_eq!(job["status"], "failed", "{job}");
    assert_eq!(job["outcome"], "failed", "{job}");
    assert!(
        job["summary"]
            .as_str()
            .unwrap_or_default()
            .contains("invalid model selection"),
        "{job}"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

// agy 1.3.3 ends a turn whose command it denied with status SUCCESS and an empty reply; its
// `--log-file` is the only exact record of the denial (soft-denying ... at step N).
#[test]
fn a_denied_antigravity_turn_is_blocked_not_done() {
    let dir = workspace("agy-denied");
    let fake = workspace("agy-denied-fake");
    let store = workspace("agy-denied-store");
    let denied_step = json!({
        "event": "step_update",
        "step_update": {
            "conversation_id": "agy-conv",
            "step_index": 4,
            "state": "ERROR",
            "step_type": "tool",
            "tool_name": "run_command",
            "tool_info": {
                "name": "run_command",
                "parameters": { "CommandLine": "git status --short" },
                "error": { "type": "TOOL_ERROR", "message": "permission check failed for command" }
            }
        }
    });
    let sticky = |response: &str| {
        let mut line: Value =
            serde_json::from_str(&agy_result(response, 10, 1, 11)).expect("result");
        line["result"]["denied_actions"] =
            json!([{ "action": "command", "display_name": "RunCommand" }]);
        line.to_string()
    };
    // Turn 1: denied, empty reply. Turn 2: denied, with a reply. Turn 3: the denial list agy keeps
    // repeating, but nothing was denied in this turn.
    std::fs::write(
        fake.join("turn1.jsonl"),
        format!("{denied_step}\n{}\n", sticky("")),
    )
    .expect("turn 1");
    std::fs::write(
        fake.join("deny1.log"),
        "I1010 03:00:00 soft-denying tool confirmation \"RunCommand\" at step 4",
    )
    .expect("deny 1");
    // A soft-denied step can still end DONE; its index ties the log line to this turn.
    std::fs::write(
        fake.join("turn2.jsonl"),
        format!("{}\n{}\n", agy_tool_step(7, "DONE"), sticky("partly done")),
    )
    .expect("turn 2");
    std::fs::write(
        fake.join("deny2.log"),
        "I1010 03:00:09 soft-denying tool confirmation \"RunCommand\" at step 7",
    )
    .expect("deny 2");
    std::fs::write(
        fake.join("turn3.jsonl"),
        format!("{}\n", sticky("all fine")),
    )
    .expect("turn 3");
    let core = Core::default();
    core.set_store(store.join("orchestrator.json"));
    core.set_launcher(scripted_agy_launcher(&fake));

    call(
        &core,
        "alethe_delegate",
        json!({ "tasks": ["run git status"], "cwd": dir.to_string_lossy(), "agent": "antigravity" }),
    );
    let job = wait_for_job(&core, 20, |job| {
        job["status"] != "running" && job["status"] != "queued"
    });
    assert_eq!(job["status"], "failed", "{job}");
    assert_eq!(job["outcome"], "blocked", "{job}");
    let summary = job["summary"].as_str().unwrap_or_default();
    assert!(summary.contains("[blocked]"), "{job}");
    assert!(summary.contains("at step 4"), "{job}");

    call(
        &core,
        "alethe_send",
        json!({ "jobId": "job-01", "message": "again" }),
    );
    // The live reply names the step before the turn settles.
    let job = wait_for_job(&core, 20, |job| {
        job["status"] != "running"
            && job["summary"]
                .as_str()
                .unwrap_or_default()
                .contains("at step 7")
    });
    assert_eq!(job["outcome"], "blocked", "{job}");
    assert!(
        !job["summary"]
            .as_str()
            .unwrap_or_default()
            .contains("at step 4"),
        "{job}"
    );

    call(
        &core,
        "alethe_send",
        json!({ "jobId": "job-01", "message": "once more" }),
    );
    let job = wait_for_job(&core, 20, |job| job["summary"] == "all fine");
    assert_eq!(job["status"], "done", "{job}");
    assert_eq!(job["outcome"], "succeeded", "{job}");

    let _ = call(&core, "alethe_cancel", json!({ "jobIds": ["job-01"] }));
    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::remove_dir_all(&fake);
    let _ = std::fs::remove_dir_all(&store);
}

#[test]
fn an_antigravity_diff_shows_a_new_file_and_clears_after_a_revert() {
    let dir = workspace("agy-diff");
    let fake = workspace("agy-diff-fake");
    git_repo(&dir);
    std::fs::write(
        fake.join("turn.jsonl"),
        format!("{}\n", agy_result("EDITED", 1, 1, 2)),
    )
    .expect("turn");
    // What the worker would write: a file git does not track yet.
    std::fs::write(dir.join("new.txt"), "fresh line\n").expect("new file");
    let core = Core::default();
    core.set_launcher(scripted_agy_launcher(&fake));

    call(
        &core,
        "alethe_delegate",
        json!({ "tasks": ["add new.txt"], "cwd": dir.to_string_lossy(), "agent": "antigravity" }),
    );
    let job = wait_for_job(&core, 20, |job| job["status"] == "done");
    assert_eq!(job["hasDiff"], true, "{job}");
    let diff = call(&core, "alethe_diff", json!({ "jobId": "job-01" }));
    let text = diff["diff"].as_str().unwrap_or_default();
    assert!(text.contains("new.txt"), "{diff}");
    assert!(text.contains("+fresh line"), "{diff}");

    std::fs::remove_file(dir.join("new.txt")).expect("revert");
    call(
        &core,
        "alethe_send",
        json!({ "jobId": "job-01", "message": "undo it" }),
    );
    wait_for_lines(&fake.join("stdin.txt"), 2, 20);
    let job = wait_for_job(&core, 20, |job| {
        job["status"] == "done" && job["hasDiff"] == false
    });
    assert_eq!(
        job["hasDiff"], false,
        "a reverted change kept its diff: {job}"
    );
    let diff = call(&core, "alethe_diff", json!({ "jobId": "job-01" }));
    assert_eq!(diff["diff"], "", "{diff}");

    let _ = call(&core, "alethe_cancel", json!({ "jobIds": ["job-01"] }));
    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::remove_dir_all(&fake);
}

/// Runs the real `agy` for one tiny edit (costs a little Antigravity quota). Needs the owner's
/// `alethe-worker` agy project. `cargo test --test orchestrator -- --ignored real_antigravity`
#[test]
#[ignore]
fn a_real_antigravity_worker_edits_inside_its_own_workspace() {
    let finder = if cfg!(windows) { "where" } else { "which" };
    let output = Command::new(finder).arg("agy").output().expect("where agy");
    let program = String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .find(|line| !cfg!(windows) || line.to_ascii_lowercase().ends_with(".exe"))
        .map(ToOwned::to_owned)
        .expect("agy on PATH");
    let dir = workspace("agy-real");
    let store = workspace("agy-real-store");
    git_repo(&dir);
    let core = Core::default();
    core.set_store(store.join("orchestrator.json"));
    core.set_launcher(Launcher::antigravity_headless(PathBuf::from(program)));

    call(
        &core,
        "alethe_delegate",
        json!({
            "tasks": ["Create a file named hello.txt in the current directory containing the word hi. Do nothing else and do not run any command."],
            "cwd": dir.to_string_lossy(),
            "agent": "antigravity",
            "model": "gemini-3.8-flash",
            "effort": "medium",
            "timeoutSeconds": 240
        }),
    );
    let job = wait_for_job(&core, 260, |job| {
        job["status"] != "running" && job["status"] != "queued"
    });
    let _ = call(&core, "alethe_cancel", json!({ "jobIds": ["job-01"] }));
    eprintln!("real agy job: {job}");
    assert_eq!(job["status"], "done", "{job}");
    assert!(job["threadId"].as_str().is_some(), "{job}");
    assert!(
        job["tokens"]["last"]["totalTokens"]
            .as_u64()
            .unwrap_or_default()
            > 0,
        "{job}"
    );
    assert_eq!(job["hasDiff"], true, "{job}");
    let written =
        std::fs::read_to_string(dir.join("hello.txt")).expect("hello.txt in the workspace");
    assert_eq!(written.trim(), "hi");

    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::remove_dir_all(&store);
}
