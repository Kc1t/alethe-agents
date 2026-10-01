//! Voice intent routing through TypeSafe Jev (System One model).
//!
//! Jev never generates text: it picks one option out of sets this module builds from live
//! workspace state. The prompt handed to an agent is a verbatim span of what the user said,
//! selected by the model but never written by it.

use std::sync::OnceLock;
use std::time::Duration;

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

const DECISIONS_URL: &str = "https://openrouter.ai/api/alpha/decisions";
const NATIVE_URL: &str = "https://api.typesafe.ai/v1/decisions";
const MODEL: &str = "typesafe/jev-1.13";
const MAX_CHOICES: usize = 200;
const MAX_SPANS: usize = 24;
const MAX_TASKS: usize = 3;
const NONE: &str = "none";

fn resolve_model(model: Option<&str>) -> &str {
    model
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(MODEL)
}

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(25))
            .build()
            .expect("reqwest client")
    })
}

fn span_trigger() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"(?i)\b(?:doing|to do|that|which|making|building|fixing|refactoring|writing|so that|about|reply|answer|respond|say|tell it|tell him|tell them|with|run|execute)\b",
        )
        .expect("static pattern")
    })
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalRef {
    pub id: String,
    pub project: String,
    pub agent: String,
    pub cwd: String,
    #[serde(default)]
    pub busy: bool,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub ordinal: u32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRef {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub path: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JevContext {
    #[serde(default)]
    pub projects: Vec<ProjectRef>,
    #[serde(default)]
    pub terminals: Vec<TerminalRef>,
    #[serde(default)]
    pub agents: Vec<String>,
    #[serde(default)]
    pub focused_project: Option<String>,
    #[serde(default)]
    pub focused_terminal: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Answer {
    pub choice: String,
    pub confidence: f64,
    pub probabilities: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JevTask {
    pub prompt: String,
    pub prompt_confidence: f64,
    pub agent: Answer,
    pub count: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JevDecision {
    pub action: Answer,
    pub agent: Answer,
    pub project: Answer,
    pub terminal: Answer,
    pub prompt: String,
    pub prompt_confidence: f64,
    pub tasks: Vec<JevTask>,
    pub lead_count: f64,
    pub multi_task: f64,
    pub parallel: f64,
    pub how_many: f64,
    pub addressed_to_app: f64,
    pub destructive: f64,
    pub latency_ms: u64,
    pub cost_usd: f64,
}

fn actions() -> Map<String, Value> {
    let mut map = Map::new();
    let mut put = |k: &str, v: &str| {
        map.insert(k.to_string(), Value::String(v.to_string()));
    };
    put(
        "new_project",
        "Add a folder on disk to the workspace as a project. The user names a folder or \
         repository path, not a task and not a terminal. Phrases like: open the folder X as \
         a project, add X to the workspace",
    );
    put(
        "new_terminal",
        "Launch one or more brand new agents or terminals, whether or not a task comes with \
         them. Phrases like: open a terminal, open three terminals, open two agents, spin up \
         X, start an agent, fire up claude, I want an agent doing X, get someone working on X. \
         Any sentence asking to open or start a COUNT of terminals or agents belongs here",
    );
    put(
        "reuse_terminal",
        "Send the work to a pane that is ALREADY OPEN instead of launching another one. Covers \
         answering or replying to an agent that is waiting, continuing what one was doing, and \
         running a shell command in a shell that is already there",
    );
    put(
        "send_prompt",
        "Type text into whichever pane already has focus, without naming one and without \
         launching anything",
    );
    put(
        "focus_terminal",
        "Only bring a terminal that is ALREADY OPEN into view, without creating anything. No \
         task is handed over and no new terminal is started. Phrases like: show me X, bring up \
         X, go to X, switch to X",
    );
    put("kill_terminal", "Stop or kill a running agent or terminal");
    put("nothing", "Not a command addressed to the app");
    map
}

fn describe_project(p: &ProjectRef) -> String {
    if p.path.is_empty() {
        format!("The project \"{}\"", p.name)
    } else {
        format!("The project \"{}\" at {}", p.name, p.path)
    }
}

fn is_shell(agent: &str) -> bool {
    agent == "shell" || agent == "wsl"
}

fn describe_terminal(t: &TerminalRef) -> String {
    let state = if t.busy { "working" } else { "idle" };
    let name = if t.name.is_empty() {
        t.agent.clone()
    } else {
        t.name.clone()
    };
    let kind = if is_shell(&t.agent) {
        "a plain command shell, not an AI agent: it only runs shell commands typed into it, so it \
         fits things like running a build, installing packages or checking git, and never fits a \
         task described in prose"
    } else {
        "an AI coding agent: it takes work described in prose, such as writing, reading or \
         refactoring code"
    };
    format!(
        "Pane {ordinal}, also called \"{name}\" or \"the {agent}\", the {ordinal_word} one opened. \
         It is {kind}. Running {agent} in project \"{project}\" at {cwd}, currently {state}",
        ordinal = t.ordinal,
        ordinal_word = ordinal_word(t.ordinal),
        name = name,
        kind = kind,
        agent = t.agent,
        project = t.project,
        cwd = t.cwd,
        state = state
    )
}

fn ordinal_word(n: u32) -> &'static str {
    match n {
        1 => "first",
        2 => "second",
        3 => "third",
        4 => "fourth",
        5 => "fifth",
        _ => "later",
    }
}

// Instruction strings travel to the model verbatim, so line-wrap artifacts from
// source formatting must not become part of the prompt.
fn one_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn choice(instructions: &str, criteria: Map<String, Value>) -> Value {
    json!({ "type": "choice", "instructions": one_line(instructions), "criteria": criteria })
}

fn noul(instructions: &str) -> Value {
    json!({ "type": "noul", "instructions": one_line(instructions) })
}

fn score(instructions: &str, criteria: Vec<&str>) -> Value {
    json!({ "type": "score", "instructions": one_line(instructions), "criteria": criteria })
}

fn clause_split() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)[.!?;]+\s+|\s+and then\s+|\s+and also\s+|\s+and\s+|\s+then\s+|\s+also\s+")
            .expect("static pattern")
    })
}

fn task_tail() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)\bto\s+").expect("static pattern"))
}

// "in the shell" says which pane, never what to do there, unlike "in the web folder".
fn pane_suffix() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"(?i)\s+(?:in|on|inside)\s+(?:the\s+|that\s+|this\s+)?(?:shell|terminal|console|powershell|wsl|bash|codex|claude(?:\s+code)?|copilot|cursor|opencode|agent(?:\s+(?:one|two|three|\d+))?|first\s+agent|second\s+agent|third\s+agent)\s*$",
        )
        .expect("static pattern")
    })
}

fn without_pane_suffix(span: &str) -> Option<String> {
    let trimmed = pane_suffix().replace(span, "");
    if trimmed.len() == span.len() {
        return None;
    }
    let trimmed = trimmed.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

// Speech mishears the pane name often enough that the suffix has to be cut by shape too.
fn locative_suffix() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)\s+(?:in|on|inside)\s+(?:the\s+|that\s+|this\s+)?([a-z0-9_-]+(?:\s+[a-z0-9_-]+)?)\s*$")
            .expect("static pattern")
    })
}

const WORK_PLACES: &[&str] = &[
    "folder",
    "directory",
    "dir",
    "repo",
    "repository",
    "project",
    "path",
    "file",
    "package",
    "root",
    "workspace",
    "branch",
    "background",
];

fn without_locative_suffix(span: &str) -> Option<String> {
    let caught = locative_suffix().captures(span)?;
    let tail = caught.get(1)?.as_str().to_lowercase();
    if tail
        .split_whitespace()
        .any(|word| WORK_PLACES.contains(&word))
    {
        return None;
    }
    let head = span[..caught.get(0)?.start()].trim();
    (head.split_whitespace().count() >= 2).then(|| head.to_string())
}

fn clauses(spoken: &str) -> Vec<String> {
    clause_split()
        .split(spoken)
        .map(|part| {
            part.trim_matches(|c: char| c.is_whitespace() || c == ',' || c == '.')
                .to_string()
        })
        .filter(|part| part.split_whitespace().count() >= 2)
        .collect()
}

fn prompt_spans(spoken: &str) -> Vec<String> {
    let mut spans = Vec::new();
    for clause in clauses(spoken) {
        if let Some(m) = task_tail().find(&clause) {
            let tail = clause[m.end()..].trim();
            if tail.split_whitespace().count() >= 2 && !spans.iter().any(|s| s == tail) {
                spans.push(tail.to_string());
            }
        }
        if !spans.contains(&clause) {
            spans.push(clause);
        }
    }
    for m in span_trigger().find_iter(spoken) {
        let rest = spoken[m.end()..].trim_matches(|c: char| c.is_whitespace() || c == ',');
        if rest.is_empty() {
            continue;
        }
        if !spans.iter().any(|s| s == rest) {
            spans.push(rest.to_string());
        }
    }
    let trimmed = spoken.trim();
    if !trimmed.is_empty() && !spans.iter().any(|s| s == trimmed) {
        spans.push(trimmed.to_string());
    }
    let mut shorter: Vec<String> = Vec::new();
    for span in &spans {
        for stripped in [without_pane_suffix(span), without_locative_suffix(span)]
            .into_iter()
            .flatten()
        {
            if !spans.contains(&stripped) && !shorter.contains(&stripped) {
                shorter.push(stripped);
            }
        }
    }
    spans.splice(0..0, shorter);
    spans.truncate(MAX_SPANS);
    spans
}

// Every agent takes the same kind of work, so without live state the options read alike and the
// answer spreads evenly across them. What is open, and what is focused, is the only real tiebreak.
fn describe_agent(agent: &str, context: &JevContext) -> String {
    let open = context
        .terminals
        .iter()
        .filter(|t| t.agent == agent)
        .count();
    let focused = context
        .focused_terminal
        .as_deref()
        .and_then(|id| context.terminals.iter().find(|t| t.id == id))
        .is_some_and(|t| t.agent == agent);

    let mut standing = match open {
        0 => "It has no pane open right now".to_string(),
        1 => "It already has one pane open".to_string(),
        n => format!("It already has {n} panes open"),
    };
    if focused {
        standing.push_str(
            ", and one of them is the pane the user is looking at, so an \
                           unnamed follow up most likely means this one",
        );
    }

    format!(
        "The {agent} coding agent: it takes work described in prose, such as writing, reading or \
         refactoring code. {standing}"
    )
}

fn labelled(entries: Vec<(String, String)>, fallback: &str) -> Map<String, Value> {
    let mut map = Map::new();
    for (key, description) in entries.into_iter().take(MAX_CHOICES) {
        map.insert(key, Value::String(description));
    }
    map.insert(NONE.to_string(), Value::String(fallback.to_string()));
    map
}

fn build_questions(spoken: &str, context: &JevContext) -> Map<String, Value> {
    let projects = labelled(
        context
            .projects
            .iter()
            .map(|p| (p.id.clone(), describe_project(p)))
            .collect(),
        "No existing project, or a brand new one",
    );

    let terminals = labelled(
        context
            .terminals
            .iter()
            .map(|t| (t.id.clone(), describe_terminal(t)))
            .collect(),
        "No existing terminal fits, start a new one",
    );

    let agents = labelled(
        context
            .agents
            .iter()
            .map(|a| (a.clone(), describe_agent(a, context)))
            .collect(),
        "No specific agent",
    );

    let spans: Map<String, Value> = prompt_spans(spoken)
        .into_iter()
        .map(|s| (s.clone(), Value::String(s)))
        .chain(std::iter::once((
            NONE.to_string(),
            Value::String("No prompt to hand over".to_string()),
        )))
        .collect();

    let mut questions = Map::new();
    questions.insert(
        "action".into(),
        choice("What does the user want the workspace to do", actions()),
    );
    questions.insert(
        "agent".into(),
        choice(
            "Which coding agent should run this work. When the user named several agents in one sentence, answer with the FIRST one they named",
            agents.clone(),
        ),
    );
    questions.insert(
        "project".into(),
        choice("Which project does this work belong to", projects),
    );
    questions.insert(
        "terminal".into(),
        choice(
            "Which already open terminal should take this work, if any",
            terminals,
        ),
    );
    questions.insert(
        "prompt".into(),
        choice(
            "Which snippet is exactly the task the user wants the first agent to carry out, \
             copied word for word. Prefer the shortest snippet that is only the work itself, \
             with no agent name in it and no word asking to open anything. Answer none when \
             the sentence only names agents to open and never says what work they should do",
            spans.clone(),
        ),
    );
    questions.insert(
        "count_1".into(),
        score(
            "How many copies of the first agent the user asked to open",
            vec!["One", "Two", "Three or more"],
        ),
    );
    for slot in 2..=MAX_TASKS {
        questions.insert(
            format!("count_{slot}"),
            score(
                &format!("How many copies of the {slot}th named agent the user asked to open"),
                vec!["One", "Two", "Three or more"],
            ),
        );
        questions.insert(
            format!("agent_{slot}"),
            choice(
                &format!(
                    "The user may name several agents to open in one sentence, such as one \
                     codex and one claude. Which agent is the {slot}th one named. Answer none \
                     when fewer than {slot} agents were named"
                ),
                agents.clone(),
            ),
        );
        questions.insert(
            format!("task_{slot}"),
            choice(
                &format!(
                    "Which snippet is the separate job for that {slot}th agent, copied word \
                     for word. Prefer the shortest snippet that is only the work itself, with \
                     no agent name in it and no word asking to open anything. Answer none when \
                     it was given no distinct job of its own"
                ),
                spans.clone(),
            ),
        );
    }
    questions.insert(
        "multi_task".into(),
        noul(
            "The sentence asks for two or more DIFFERENT jobs, each needing its own agent, rather than one job repeated across several agents",
        ),
    );
    questions.insert(
        "parallel".into(),
        noul("The user asked for more than one agent working at the same time"),
    );
    questions.insert(
        "how_many".into(),
        score(
            "How many agents the user wants working on this",
            vec!["One", "Two or three", "As many as possible"],
        ),
    );
    questions.insert(
        "addressed_to_app".into(),
        noul(
            "The sentence was spoken to the app as a command, and is not part of a \
             conversation with another person",
        ),
    );
    questions.insert(
        "destructive".into(),
        noul("The action stops a running process, discards work or deletes a worktree"),
    );
    questions
}

fn read_answer(answers: &Map<String, Value>, key: &str) -> Answer {
    let node = answers.get(key);
    Answer {
        choice: node
            .and_then(|n| n.get("choice"))
            .and_then(Value::as_str)
            .unwrap_or(NONE)
            .to_string(),
        confidence: node
            .and_then(|n| n.get("confidence"))
            .and_then(Value::as_f64)
            .unwrap_or(0.0),
        probabilities: node
            .and_then(|n| n.get("probabilities"))
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default(),
    }
}

fn read_noul(answers: &Map<String, Value>, key: &str) -> f64 {
    answers
        .get(key)
        .and_then(|n| n.get("noul"))
        .and_then(Value::as_f64)
        .unwrap_or(0.0)
}

fn read_score(answers: &Map<String, Value>, key: &str) -> f64 {
    answers
        .get(key)
        .and_then(|n| n.get("score"))
        .and_then(Value::as_f64)
        .unwrap_or(0.0)
}

const MAX_ATTEMPTS: u32 = 3;

enum AttemptError {
    Fatal(String),
    Retriable(String),
}

// One attempt at the decisions endpoint. Transport errors and 429/5xx earn a retry;
// any other 4xx fails fast, because asking again will not change the answer.
async fn request_decision(
    url: &str,
    api_key: &str,
    payload: &Value,
) -> Result<Value, AttemptError> {
    let response = client()
        .post(url)
        .bearer_auth(api_key.trim())
        .json(payload)
        .send()
        .await
        .map_err(|e| AttemptError::Retriable(format!("jev request failed: {e}")))?;

    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|e| AttemptError::Retriable(format!("jev reply unreadable: {e}")))?;

    if !status.is_success() {
        let detail = serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|body| {
                body.get("error")
                    .and_then(|error| error.get("message"))
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .unwrap_or_else(|| text.chars().take(200).collect());
        let message = format!("jev returned {status}: {detail}");
        return Err(if status.as_u16() == 429 || status.is_server_error() {
            AttemptError::Retriable(message)
        } else {
            AttemptError::Fatal(message)
        });
    }

    serde_json::from_str(&text)
        .map_err(|e| AttemptError::Fatal(format!("jev returned invalid json: {e}")))
}

/// Routes one spoken sentence into a typed workspace decision.
///
/// `native` selects TypeSafe's own endpoint; anything else goes through the OpenRouter
/// decisions endpoint, which needs no waitlist.
#[tauri::command]
pub async fn jev_decide(
    spoken: String,
    context: JevContext,
    api_key: String,
    native: Option<bool>,
    model: Option<String>,
) -> Result<JevDecision, String> {
    if api_key.trim().is_empty() {
        return Err("missing Jev API key".into());
    }

    let state = json!({
        "spoken_command": spoken,
        "focused_project": context.focused_project,
        "focused_terminal": context.focused_terminal,
        "open_terminals": context
            .terminals
            .iter()
            .map(|t| format!("{}: {}", t.id, describe_terminal(t)))
            .collect::<Vec<_>>(),
    });

    let url = if native.unwrap_or(false) {
        NATIVE_URL
    } else {
        DECISIONS_URL
    };

    let started = std::time::Instant::now();
    let payload = json!({
        "model": resolve_model(model.as_deref()),
        "state": state,
        "questions": build_questions(&spoken, &context),
    });

    let mut attempts = 0u32;
    let body = loop {
        match request_decision(url, &api_key, &payload).await {
            Ok(body) => break body,
            Err(AttemptError::Fatal(message)) => return Err(message),
            Err(AttemptError::Retriable(message)) => {
                attempts += 1;
                if attempts >= MAX_ATTEMPTS {
                    return Err(format!(
                        "jev failed after {attempts} attempts. last error: {message}"
                    ));
                }
                tokio::time::sleep(Duration::from_millis(300 * u64::from(attempts))).await;
            }
        }
    };

    let answers = body
        .get("answers")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();

    let prompt = read_answer(&answers, "prompt");

    let mut tasks: Vec<JevTask> = Vec::new();
    for slot in 2..=MAX_TASKS {
        let agent = read_answer(&answers, &format!("agent_{slot}"));
        let task = read_answer(&answers, &format!("task_{slot}"));
        let named_agent = agent.choice != NONE;
        let own_task = task.choice != NONE && task.choice != prompt.choice;
        if !named_agent && !own_task {
            continue;
        }
        if own_task && tasks.iter().any(|t| t.prompt == task.choice) {
            continue;
        }
        tasks.push(JevTask {
            prompt: if own_task { task.choice } else { String::new() },
            prompt_confidence: if own_task { task.confidence } else { 0.0 },
            agent,
            count: read_score(&answers, &format!("count_{slot}")),
        });
    }

    Ok(JevDecision {
        action: read_answer(&answers, "action"),
        agent: read_answer(&answers, "agent"),
        project: read_answer(&answers, "project"),
        terminal: read_answer(&answers, "terminal"),
        prompt: if prompt.choice == NONE {
            String::new()
        } else {
            prompt.choice.clone()
        },
        prompt_confidence: prompt.confidence,
        tasks,
        lead_count: read_score(&answers, "count_1"),
        multi_task: read_noul(&answers, "multi_task"),
        parallel: read_noul(&answers, "parallel"),
        how_many: read_score(&answers, "how_many"),
        addressed_to_app: read_noul(&answers, "addressed_to_app"),
        destructive: read_noul(&answers, "destructive"),
        latency_ms: started.elapsed().as_millis() as u64,
        cost_usd: body
            .get("usage")
            .and_then(|u| u.get("cost"))
            .and_then(Value::as_f64)
            .unwrap_or(0.0),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spans_keep_the_task_verbatim() {
        let spans = prompt_spans("I want an agent doing the login refactor and the tests");
        assert!(spans.contains(&"the login refactor and the tests".to_string()));
    }

    #[test]
    fn agents_are_told_apart_by_what_is_open() {
        let context = JevContext {
            terminals: vec![
                TerminalRef {
                    id: "t1".into(),
                    agent: "claude".into(),
                    ..Default::default()
                },
                TerminalRef {
                    id: "t2".into(),
                    agent: "claude".into(),
                    ..Default::default()
                },
            ],
            focused_terminal: Some("t2".into()),
            ..Default::default()
        };
        let claude = describe_agent("claude", &context);
        let codex = describe_agent("codex", &context);
        assert!(claude.contains("2 panes open"));
        assert!(claude.contains("looking at"));
        assert!(codex.contains("no pane open"));
        assert_ne!(claude, codex);
    }

    #[test]
    fn a_shell_pane_is_described_as_not_an_agent() {
        let t = TerminalRef {
            id: "t9".into(),
            project: "alethe".into(),
            agent: "shell".into(),
            cwd: "/repo".into(),
            busy: false,
            name: "Shell".into(),
            ordinal: 5,
        };
        let described = describe_terminal(&t);
        assert!(described.contains("not an AI agent"));
        assert!(described.contains("Pane 5"));
    }

    #[test]
    fn spans_drop_the_pane_the_user_named() {
        let spans = prompt_spans("run git status in the shell");
        assert!(spans.contains(&"git status".to_string()));
    }

    #[test]
    fn spans_keep_a_folder_that_is_part_of_the_work() {
        let spans = prompt_spans("run the build in the web folder");
        assert!(spans.iter().any(|s| s.contains("web folder")));
        assert!(!spans.contains(&"the build".to_string()));
    }

    #[test]
    fn spans_drop_a_misheard_pane_name() {
        let spans = prompt_spans("run git status in the show");
        assert!(spans.contains(&"git status".to_string()));
        assert!(spans.iter().position(|s| s == "git status").unwrap() < spans.len() - 1);
    }

    #[test]
    fn spans_offer_a_one_word_reply() {
        let spans = prompt_spans("agent one answer yes");
        assert!(spans.contains(&"yes".to_string()));
    }

    #[test]
    fn spans_offer_the_task_without_the_agent_in_front() {
        let spans = prompt_spans(
            "open one codex to run the build in the web folder and one claude code to read the first line of main ts",
        );
        assert!(spans.contains(&"run the build in the web folder".to_string()));
        assert!(spans.contains(&"read the first line of main ts".to_string()));
    }

    #[test]
    fn spans_always_include_the_whole_sentence() {
        let spans = prompt_spans("open a terminal");
        assert_eq!(spans.last().unwrap(), "open a terminal");
    }

    #[test]
    fn terminal_description_carries_state() {
        let t = TerminalRef {
            id: "t1".into(),
            project: "alethe".into(),
            agent: "claude".into(),
            cwd: "/repo".into(),
            busy: true,
            name: "Claude Code 2".into(),
            ordinal: 2,
        };
        let described = describe_terminal(&t);
        assert!(described.contains("working"));
        assert!(described.contains("Pane 2"));
        assert!(described.contains("AI coding agent"));
        assert!(described.contains("second"));
        assert!(described.contains("Claude Code 2"));
    }

    #[test]
    fn model_defaults_and_overrides() {
        assert_eq!(resolve_model(None), MODEL);
        assert_eq!(resolve_model(Some("")), MODEL);
        assert_eq!(resolve_model(Some("   ")), MODEL);
        assert_eq!(resolve_model(Some("typesafe/jev-2.0")), "typesafe/jev-2.0");
    }

    #[test]
    fn question_instructions_are_single_spaced() {
        let questions = build_questions(
            "open two claude agents to fix the login",
            &JevContext::default(),
        );
        for question in questions.values() {
            let text = question
                .get("instructions")
                .and_then(Value::as_str)
                .unwrap_or_default();
            assert!(!text.contains("  "), "double space leaked into: {text}");
        }
    }
}
