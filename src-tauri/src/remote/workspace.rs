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
