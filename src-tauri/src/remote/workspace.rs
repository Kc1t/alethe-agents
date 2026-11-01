//! Builds the workspace snapshot and per-terminal sharing checks exposed to
//! paired remote devices, honoring the per-terminal `remoteShared` flag.

use serde_json::{json, Value};
use tauri::AppHandle;

use super::appearance::projects_document;

/// Opt-in: a terminal is only visible/controllable remotely once explicitly
/// marked shared. Everything else — including terminals that predate this
/// flag — stays private by default.
fn tab_is_shared(terminal: &Value) -> bool {
    terminal.get("remoteShared").and_then(Value::as_bool) == Some(true)
}

pub(crate) struct SharedTab {
    pub pty_id: String,
    pub agent: String,
    pub cwd: String,
    pub session_id: Option<String>,
}

fn shared_tabs(app: &AppHandle) -> Vec<SharedTab> {
    let document = projects_document(app);
    let mut tabs: Vec<SharedTab> = Vec::new();
    for project in document
        .get("projects")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
    {
        for terminal in project
            .get("terminals")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
        {
            if !tab_is_shared(&terminal) {
                continue;
            }
            let terminal_cwd = terminal.get("cwd").and_then(Value::as_str).unwrap_or("");
            for tab in terminal
                .get("tabs")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
            {
                let Some(pty_id) = tab.get("ptyId").and_then(Value::as_str) else {
                    continue;
                };
                let cwd = tab
                    .get("cwd")
                    .and_then(Value::as_str)
                    .filter(|value| !value.trim().is_empty())
                    .unwrap_or(terminal_cwd);
                tabs.push(SharedTab {
                    pty_id: pty_id.to_string(),
                    agent: tab
                        .get("type")
                        .and_then(Value::as_str)
                        .unwrap_or("shell")
                        .to_string(),
                    cwd: cwd.to_string(),
                    session_id: tab
                        .get("sessionId")
                        .and_then(Value::as_str)
                        .filter(|value| !value.trim().is_empty())
                        .map(ToOwned::to_owned),
                });
            }
        }
    }
    tabs
}

pub(crate) fn pty_agent(app: &AppHandle, pty_id: &str) -> Option<String> {
    shared_tab(app, pty_id).map(|tab| tab.agent)
}

pub(crate) fn shared_tab(app: &AppHandle, pty_id: &str) -> Option<SharedTab> {
    shared_tabs(app)
        .into_iter()
        .find(|tab| tab.pty_id == pty_id)
}

pub(crate) fn pty_is_shared(app: &AppHandle, pty_id: &str) -> bool {
    shared_tabs(app).iter().any(|tab| tab.pty_id == pty_id)
}

fn document_has_project(document: &Value, project_id: &str) -> bool {
    document
        .get("projects")
        .and_then(Value::as_array)
        .is_some_and(|projects| {
            projects
                .iter()
                .any(|project| project.get("id").and_then(Value::as_str) == Some(project_id))
        })
}

pub(crate) fn project_exists(app: &AppHandle, project_id: &str) -> bool {
    document_has_project(&projects_document(app), project_id)
}

/// Folders of projects that share at least one terminal: the only places whose orchestrator
/// workers a paired device may see.
fn shared_project_roots(document: &Value) -> Vec<String> {
    let mut roots = Vec::new();
    for project in document
        .get("projects")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let terminals: Vec<&Value> = project
            .get("terminals")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter(|terminal| tab_is_shared(terminal))
            .collect();
        if terminals.is_empty() {
            continue;
        }
        let folders = project
            .get("defaultCwd")
            .into_iter()
            .chain(terminals.iter().filter_map(|terminal| terminal.get("cwd")));
        for folder in folders.filter_map(Value::as_str) {
            let folder = normalize_folder(folder);
            if !folder.is_empty() && !roots.contains(&folder) {
                roots.push(folder);
            }
        }
    }
    roots
}

fn normalize_folder(path: &str) -> String {
    path.trim()
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_lowercase()
}

fn within_roots(cwd: &str, roots: &[String]) -> bool {
    let cwd = normalize_folder(cwd);
    roots
        .iter()
        .any(|root| cwd == *root || cwd.starts_with(&format!("{root}/")))
}

fn clip(text: &str, max_chars: usize) -> String {
    match text.char_indices().nth(max_chars) {
        Some((cut, _)) => format!("{}…", &text[..cut]),
        None => text.to_string(),
    }
}

/// The orchestrator board, cut down to what a phone needs and to shared projects only.
fn orchestration_for_device(snapshot: &Value, roots: &[String]) -> Value {
    let jobs: Vec<Value> = snapshot
        .get("jobs")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|job| job.get("supersededBy").is_none_or(Value::is_null))
        .filter(|job| within_roots(job.get("cwd").and_then(Value::as_str).unwrap_or(""), roots))
        .map(|job| {
            let text = |key: &str| job.get(key).and_then(Value::as_str).unwrap_or("");
            json!({
                "id": job.get("id"),
                "agent": job.get("agent"),
                "status": job.get("status"),
                "outcome": job.get("outcome"),
                "seconds": job.get("seconds"),
                "costUsd": job.get("costUsd"),
                "needsApproval": job.get("pendingApproval").is_some_and(|value| !value.is_null()),
                "task": clip(text("spec").lines().next().unwrap_or(""), 160),
                "summary": clip(text("summary"), 600),
            })
        })
        .collect();
    json!({ "jobs": jobs })
}

pub(crate) fn orchestration_snapshot(app: &AppHandle, board: &Value) -> Value {
    orchestration_for_device(board, &shared_project_roots(&projects_document(app)))
}

pub(crate) fn workspace_snapshot(app: &AppHandle) -> Result<Value, String> {
    let document = projects_document(app);
    let groups: Vec<Value> = document
        .get("groups")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .iter()
        .map(|group| {
            json!({
                "id": group.get("id"),
                "name": group.get("name"),
                "color": group.get("color"),
            })
        })
        .collect();
    let mut projects = Vec::new();
    for project in document
        .get("projects")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
    {
        let mut chats = Vec::new();
        for terminal in project
            .get("terminals")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
        {
            if !tab_is_shared(&terminal) {
                continue;
            }
            let terminal_id = terminal.get("id").cloned().unwrap_or(Value::Null);
            let terminal_name = terminal
                .get("name")
                .cloned()
                .unwrap_or_else(|| Value::String("Terminal".into()));
            for tab in terminal
                .get("tabs")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
            {
                let Some(pty_id) = tab.get("ptyId").and_then(Value::as_str) else {
                    continue;
                };
                chats.push(json!({
                    "id": tab.get("id"),
                    "ptyId": pty_id,
                    "name": terminal_name,
                    "agent": tab.get("type"),
                    "terminalId": terminal_id,
                }));
            }
        }
        projects.push(json!({
            "id": project.get("id"),
            "name": project.get("name"),
            "groupId": project.get("groupId"),
            "color": project.get("color"),
            "chats": chats,
        }));
    }
    Ok(json!({ "groups": groups, "projects": projects }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_lookup_matches_ids_only() {
        let document = json!({ "projects": [{ "id": "p1", "name": "p2" }] });
        assert!(document_has_project(&document, "p1"));
        assert!(!document_has_project(&document, "p2"));
        assert!(!document_has_project(&json!({}), "p1"));
    }

    #[test]
    fn orchestration_shows_only_workers_in_shared_projects() {
        let document = json!({ "projects": [
            { "id": "a", "defaultCwd": "C:\\Sites\\shop", "terminals": [{ "remoteShared": true }] },
            { "id": "b", "defaultCwd": "C:\\Private", "terminals": [{ "remoteShared": false }] },
        ] });
        let roots = shared_project_roots(&document);
        let board = json!({ "jobs": [
            { "id": "1", "cwd": "c:/sites/shop/.alethe/worktrees/x", "spec": "Build the cart\nmore", "pendingApproval": { "kind": "exec" } },
            { "id": "2", "cwd": "C:\\Private", "spec": "secret" },
            { "id": "3", "cwd": "C:\\Sites\\shopping", "spec": "sibling folder" },
            { "id": "4", "cwd": "C:\\Sites\\shop", "spec": "old", "supersededBy": "1" },
        ] });
        let jobs = orchestration_for_device(&board, &roots)["jobs"].clone();
        let ids: Vec<&str> = jobs
            .as_array()
            .unwrap()
            .iter()
            .map(|job| job["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, ["1"]);
        assert_eq!(jobs[0]["task"], "Build the cart");
        assert_eq!(jobs[0]["needsApproval"], true);
    }

    #[test]
    fn clip_cuts_on_characters() {
        assert_eq!(clip("ééé", 2), "éé…");
        assert_eq!(clip("ok", 5), "ok");
    }
}
