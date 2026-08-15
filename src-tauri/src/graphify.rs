//!

//!

//!    para `{ nodes, edges }` prontos para o Cytoscape (parsing pesado no Rust,

//! 3. **Versionamento + memory policy:** snapshot/list/diff/rollback de
//!    `graphify-out/graph.json` em `<repo>/.alethe/graph-snapshots/`, e `prune`

//!
//! O comando/args exatos do CLI do Graphify ainda dependem de pinar a fonte

use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::process::Command;

use nanoid::nanoid;
use serde::Serialize;
use serde_json::Value;

use crate::git_control::{hide_console, repository_root};
use crate::provider_common::now_ms;

const DEFAULT_COMMAND: &str = "graphify";

/// resultado vem truncado (com a flag `truncated`), preservando os N primeiros

const MAX_VIZ_NODES: usize = 3000;

const GRAPH_SUBDIR: &str = "graphify-out";
const GRAPH_FILE: &str = "graph.json";
const SNAPSHOTS_SUBDIR: &str = "graph-snapshots";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphifyStatus {
    available: bool,
    command: String,
    version: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphNode {
    id: String,
    label: String,
    kind: Option<String>,
    group: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphEdge {
    id: String,
    source: String,
    target: String,
    label: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphData {
    nodes: Vec<GraphNode>,
    edges: Vec<GraphEdge>,
    node_count: usize,
    edge_count: usize,
    truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotInfo {
    id: String,
    path: String,
    created_ms: u64,
    size_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphDiff {
    nodes_added: usize,
    nodes_removed: usize,
    edges_added: usize,
    edges_removed: usize,
}

fn short_hash(input: &str) -> String {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    input.hash(&mut hasher);
    format!("{:x}", hasher.finish())
}

fn graph_path(root: &Path) -> PathBuf {
    root.join(GRAPH_SUBDIR).join(GRAPH_FILE)
}

fn snapshots_dir(root: &Path) -> PathBuf {
    root.join(".alethe").join(SNAPSHOTS_SUBDIR)
}

fn mcp_server_spec(command: &str, root: &Path) -> Value {
    serde_json::json!({
        "command": command,
        "args": [ root.to_string_lossy(), "--mcp" ]
    })
}

fn emit(event_type: &str, project_id: Option<String>, data: Value) {
    crate::event_bus::publish_event_simple(
        event_type,
        &format!("graphify-{}", nanoid!()),
        project_id,
        None,
        data,
    );
}

static GENERATING: std::sync::OnceLock<std::sync::Mutex<std::collections::HashSet<PathBuf>>> =
    std::sync::OnceLock::new();

fn generating_set() -> &'static std::sync::Mutex<std::collections::HashSet<PathBuf>> {
    GENERATING.get_or_init(|| std::sync::Mutex::new(std::collections::HashSet::new()))
}

// de verdade (git, probe do CLI do Graphify) — rodavam direto na thread de

// em projetos com Graphify ligado (ver XTermView/index.tsx). Sob AV escaneando

fn graphify_ensure_graph_inner(repo: String, command: Option<String>) -> Result<String, String> {
    let root = repository_root(&repo)?;
    if graph_path(&root).is_file() {
        return Ok("exists".to_string());
    }

    if generating_set()
        .lock()
        .map_err(|e| e.to_string())?
        .contains(&root)
    {
        return Ok("generating".to_string());
    }

    let cmd = command.unwrap_or_else(|| DEFAULT_COMMAND.to_string());

    let available = {
        let mut probe = Command::new(&cmd);
        probe.arg("--version");
        hide_console(&mut probe);
        probe.output().map(|o| o.status.success()).unwrap_or(false)
    };
    if !available {
        return Ok("unavailable".to_string());
    }

    {
        let mut set = generating_set().lock().map_err(|e| e.to_string())?;
        if set.contains(&root) {
            return Ok("generating".to_string());
        }
        set.insert(root.clone());
    }

    let root_for_task = root.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut generate = Command::new(&cmd);
        generate.arg(&root_for_task).current_dir(&root_for_task);
        hide_console(&mut generate);
        let outcome = generate.output();
        if let Ok(mut set) = generating_set().lock() {
            set.remove(&root_for_task);
        }
        match outcome {
            Ok(output) if output.status.success() => {
                emit(
                    "GraphUpdated",
                    None,
                    serde_json::json!({ "action": "bootstrap", "repo": root_for_task.to_string_lossy() }),
                );
            }
            Ok(output) => {
                let stderr = String::from_utf8_lossy(&output.stderr);
                eprintln!("[graphify] geração falhou: {}", stderr.trim());
            }
            Err(error) => eprintln!("[graphify] geração não executou: {error}"),
        }
    });

    Ok("started".to_string())
}

#[tauri::command]
pub async fn graphify_ensure_graph(
    repo: String,
    command: Option<String>,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || graphify_ensure_graph_inner(repo, command))
        .await
        .map_err(|error| format!("graphify_ensure_graph: falha na task bloqueante: {error}"))?
}

fn graphify_detect_inner(command: Option<String>) -> Result<GraphifyStatus, String> {
    let cmd = command.unwrap_or_else(|| DEFAULT_COMMAND.to_string());
    let mut probe = Command::new(&cmd);
    probe.arg("--version");
    hide_console(&mut probe);
    match probe.output() {
        Ok(output) if output.status.success() => {
            let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
            Ok(GraphifyStatus {
                available: true,
                command: cmd,
                version: (!version.is_empty()).then_some(version),
            })
        }
        _ => Ok(GraphifyStatus {
            available: false,
            command: cmd,
            version: None,
        }),
    }
}

#[tauri::command]
pub async fn graphify_detect(command: Option<String>) -> Result<GraphifyStatus, String> {
    tokio::task::spawn_blocking(move || graphify_detect_inner(command))
        .await
        .map_err(|error| format!("graphify_detect: falha na task bloqueante: {error}"))?
}

fn graphify_mcp_config_path_inner(repo: String, command: Option<String>) -> Result<String, String> {
    let root = repository_root(&repo)?;
    let cmd = command.unwrap_or_else(|| DEFAULT_COMMAND.to_string());
    let config = serde_json::json!({
        "mcpServers": { "graphify": mcp_server_spec(&cmd, &root) }
    });
    let file_name = format!(
        "alethe-graphify-mcp-{}.json",
        short_hash(&root.to_string_lossy())
    );
    let path = std::env::temp_dir().join(file_name);
    let body = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    std::fs::write(&path, body).map_err(|e| format!("write_failed:{e}"))?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn graphify_mcp_config_path(
    repo: String,
    command: Option<String>,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || graphify_mcp_config_path_inner(repo, command))
        .await
        .map_err(|error| format!("graphify_mcp_config_path: falha na task bloqueante: {error}"))?
}

/// `mcp` (schema em https://opencode.ai/docs/config/ e
/// https://opencode.ai/docs/mcp-servers/); Codex usa `.codex/config.toml` no

/// `[mcp_servers.<nome>]` (schema em
/// https://developers.openai.com/codex/config-schema.json).

///

/// `spawn_blocking`.
pub(crate) fn graphify_opencode_config_write_inner(
    repo: String,
    command: Option<String>,
) -> Result<(), String> {
    let root = repository_root(&repo)?;
    let cmd = command.unwrap_or_else(|| DEFAULT_COMMAND.to_string());
    let path = root.join("opencode.json");

    let mut config: serde_json::Map<String, Value> = if path.is_file() {
        let raw = std::fs::read_to_string(&path).map_err(|e| format!("read_failed:{e}"))?;
        match serde_json::from_str::<Value>(&raw) {
            Ok(Value::Object(map)) => map,

            _ => return Ok(()),
        }
    } else {
        let mut map = serde_json::Map::new();
        map.insert(
            "$schema".to_string(),
            Value::String("https://opencode.ai/config.json".to_string()),
        );
        map
    };

    let mcp = config
        .entry("mcp".to_string())
        .or_insert_with(|| Value::Object(serde_json::Map::new()));
    if let Value::Object(mcp_map) = mcp {
        mcp_map.insert(
            "graphify".to_string(),
            serde_json::json!({
                "type": "local",
                "command": [cmd, root.to_string_lossy(), "--mcp"],
                "enabled": true,
            }),
        );
    }

    let body = serde_json::to_string_pretty(&Value::Object(config)).map_err(|e| e.to_string())?;
    std::fs::write(&path, body).map_err(|e| format!("write_failed:{e}"))
}

#[tauri::command]
pub async fn graphify_opencode_config_write(
    repo: String,
    command: Option<String>,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || graphify_opencode_config_write_inner(repo, command))
        .await
        .map_err(|error| {
            format!("graphify_opencode_config_write: falha na task bloqueante: {error}")
        })?
}

fn graphify_codex_config_write_inner(repo: String, command: Option<String>) -> Result<(), String> {
    let root = repository_root(&repo)?;
    let cmd = command.unwrap_or_else(|| DEFAULT_COMMAND.to_string());
    let codex_dir = root.join(".codex");
    std::fs::create_dir_all(&codex_dir).map_err(|e| format!("mkdir_failed:{e}"))?;
    let path = codex_dir.join("config.toml");

    let existing = if path.is_file() {
        std::fs::read_to_string(&path).map_err(|e| format!("read_failed:{e}"))?
    } else {
        String::new()
    };

    let mut kept_lines: Vec<&str> = Vec::new();
    let mut skipping = false;
    for line in existing.lines() {
        let trimmed = line.trim();
        if trimmed == "[mcp_servers.graphify]" {
            skipping = true;
            continue;
        }
        if skipping && trimmed.starts_with('[') {
            skipping = false;
        }
        if !skipping {
            kept_lines.push(line);
        }
    }
    let mut body = kept_lines.join("\n");
    if !body.is_empty() && !body.ends_with('\n') {
        body.push('\n');
    }

    let toml_escape = |s: &str| s.replace('\\', "\\\\").replace('"', "\\\"");
    let cmd_toml = toml_escape(&cmd);
    let args_toml = format!("\"{}\", \"--mcp\"", toml_escape(&root.to_string_lossy()));
    body.push_str(&format!(
        "\n[mcp_servers.graphify]\ncommand = \"{cmd_toml}\"\nargs = [{args_toml}]\n",
    ));

    std::fs::write(&path, body).map_err(|e| format!("write_failed:{e}"))
}

#[tauri::command]
pub async fn graphify_codex_config_write(
    repo: String,
    command: Option<String>,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || graphify_codex_config_write_inner(repo, command))
        .await
        .map_err(|error| {
            format!("graphify_codex_config_write: falha na task bloqueante: {error}")
        })?
}

fn value_to_id(value: &Value) -> Option<String> {
    match value {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

fn first_str<'a>(obj: &'a serde_json::Map<String, Value>, keys: &[&str]) -> Option<&'a str> {
    keys.iter()
        .find_map(|k| obj.get(*k).and_then(|v| v.as_str()))
}

/// nomes de campo comuns.
fn graphify_read_graph_inner(repo: String) -> Result<GraphData, String> {
    let root = repository_root(&repo)?;
    let path = graph_path(&root);
    if !path.is_file() {
        return Err("graph_not_found".to_string());
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| format!("read_failed:{e}"))?;
    let value: Value = serde_json::from_str(&raw).map_err(|e| format!("invalid_graph_json:{e}"))?;

    let node_values = value
        .get("nodes")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let edge_values = value
        .get("edges")
        .or_else(|| value.get("links"))
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let total_nodes = node_values.len();
    let total_edges = edge_values.len();
    let truncated = total_nodes > MAX_VIZ_NODES;

    let mut nodes = Vec::new();
    let mut kept_ids = std::collections::HashSet::new();
    for node in node_values.into_iter().take(MAX_VIZ_NODES) {
        let Some(obj) = node.as_object() else {
            continue;
        };
        let Some(id) = obj.get("id").and_then(value_to_id) else {
            continue;
        };
        let label = first_str(obj, &["label", "name", "title"])
            .map(|s| s.to_string())
            .unwrap_or_else(|| id.clone());
        let kind = first_str(obj, &["type", "kind", "category"]).map(|s| s.to_string());
        let group = first_str(obj, &["group", "community", "module"]).map(|s| s.to_string());
        kept_ids.insert(id.clone());
        nodes.push(GraphNode {
            id,
            label,
            kind,
            group,
        });
    }

    let mut edges = Vec::new();
    for edge in edge_values {
        let Some(obj) = edge.as_object() else {
            continue;
        };
        let (Some(source), Some(target)) = (
            obj.get("source").and_then(value_to_id),
            obj.get("target").and_then(value_to_id),
        ) else {
            continue;
        };

        if !kept_ids.contains(&source) || !kept_ids.contains(&target) {
            continue;
        }
        let label = first_str(obj, &["label", "relation", "type"]).map(|s| s.to_string());
        let id = obj
            .get("id")
            .and_then(value_to_id)
            .unwrap_or_else(|| format!("{source}->{target}"));
        edges.push(GraphEdge {
            id,
            source,
            target,
            label,
        });
    }

    Ok(GraphData {
        nodes,
        edges,
        node_count: total_nodes,
        edge_count: total_edges,
        truncated,
    })
}

#[tauri::command]
pub async fn graphify_read_graph(repo: String) -> Result<GraphData, String> {
    tokio::task::spawn_blocking(move || graphify_read_graph_inner(repo))
        .await
        .map_err(|error| format!("graphify_read_graph: falha na task bloqueante: {error}"))?
}

/// Copia o `graph.json` atual para `.alethe/graph-snapshots/<ts>.json`.

pub(crate) fn graphify_snapshot_inner(
    repo: String,
    project_id: Option<String>,
) -> Result<SnapshotInfo, String> {
    let root = repository_root(&repo)?;
    let source = graph_path(&root);
    if !source.is_file() {
        return Err("graph_not_found".to_string());
    }
    let dir = snapshots_dir(&root);
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir_failed:{e}"))?;
    let ts = now_ms();
    let dest = dir.join(format!("{ts}.json"));
    std::fs::copy(&source, &dest).map_err(|e| format!("copy_failed:{e}"))?;
    let size_bytes = std::fs::metadata(&dest).map(|m| m.len()).unwrap_or(0);

    let info = SnapshotInfo {
        id: ts.to_string(),
        path: dest.to_string_lossy().into_owned(),
        created_ms: ts,
        size_bytes,
    };
    emit(
        "GraphSnapshotted",
        project_id,
        serde_json::json!({ "snapshot_id": info.id, "size_bytes": size_bytes }),
    );
    Ok(info)
}

#[tauri::command]
pub async fn graphify_snapshot(
    repo: String,
    project_id: Option<String>,
) -> Result<SnapshotInfo, String> {
    tokio::task::spawn_blocking(move || graphify_snapshot_inner(repo, project_id))
        .await
        .map_err(|error| format!("graphify_snapshot: falha na task bloqueante: {error}"))?
}

fn read_snapshots(root: &Path) -> Result<Vec<SnapshotInfo>, String> {
    let dir = snapshots_dir(root);
    let mut result = Vec::new();
    if !dir.is_dir() {
        return Ok(result);
    }
    let entries = std::fs::read_dir(&dir).map_err(|e| format!("read_dir_failed:{e}"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        let Ok(created_ms) = stem.parse::<u64>() else {
            continue;
        };
        let size_bytes = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        result.push(SnapshotInfo {
            id: stem.to_string(),
            path: path.to_string_lossy().into_owned(),
            created_ms,
            size_bytes,
        });
    }
    result.sort_by(|a, b| b.created_ms.cmp(&a.created_ms));
    Ok(result)
}

fn graphify_list_snapshots_inner(repo: String) -> Result<Vec<SnapshotInfo>, String> {
    let root = repository_root(&repo)?;
    read_snapshots(&root)
}

#[tauri::command]
pub async fn graphify_list_snapshots(repo: String) -> Result<Vec<SnapshotInfo>, String> {
    tokio::task::spawn_blocking(move || graphify_list_snapshots_inner(repo))
        .await
        .map_err(|error| format!("graphify_list_snapshots: falha na task bloqueante: {error}"))?
}

fn id_sets(
    path: &Path,
) -> Result<
    (
        std::collections::HashSet<String>,
        std::collections::HashSet<String>,
    ),
    String,
> {
    let raw = std::fs::read_to_string(path).map_err(|e| format!("read_failed:{e}"))?;
    let value: Value = serde_json::from_str(&raw).map_err(|e| format!("invalid_graph_json:{e}"))?;
    let mut node_ids = std::collections::HashSet::new();
    if let Some(arr) = value.get("nodes").and_then(|v| v.as_array()) {
        for node in arr {
            if let Some(id) = node.get("id").and_then(value_to_id) {
                node_ids.insert(id);
            }
        }
    }
    let mut edge_ids = std::collections::HashSet::new();
    let edges = value
        .get("edges")
        .or_else(|| value.get("links"))
        .and_then(|v| v.as_array());
    if let Some(arr) = edges {
        for edge in arr {
            if let (Some(s), Some(t)) = (
                edge.get("source").and_then(value_to_id),
                edge.get("target").and_then(value_to_id),
            ) {
                edge_ids.insert(format!("{s}->{t}"));
            }
        }
    }
    Ok((node_ids, edge_ids))
}

fn snapshot_file(root: &Path, id: &str) -> Result<PathBuf, String> {
    // permitir path traversal via id forjado.
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_digit()) {
        return Err("invalid_snapshot_id".to_string());
    }
    let path = snapshots_dir(root).join(format!("{id}.json"));
    if !path.is_file() {
        return Err("snapshot_not_found".to_string());
    }
    Ok(path)
}

fn graphify_diff_snapshot_inner(
    repo: String,
    base_id: String,
    compare_id: Option<String>,
) -> Result<GraphDiff, String> {
    let root = repository_root(&repo)?;
    let base_path = snapshot_file(&root, &base_id)?;
    let compare_path = match compare_id {
        Some(id) => snapshot_file(&root, &id)?,
        None => graph_path(&root),
    };
    let (base_nodes, base_edges) = id_sets(&base_path)?;
    let (cmp_nodes, cmp_edges) = id_sets(&compare_path)?;
    Ok(GraphDiff {
        nodes_added: cmp_nodes.difference(&base_nodes).count(),
        nodes_removed: base_nodes.difference(&cmp_nodes).count(),
        edges_added: cmp_edges.difference(&base_edges).count(),
        edges_removed: base_edges.difference(&cmp_edges).count(),
    })
}

#[tauri::command]
pub async fn graphify_diff_snapshot(
    repo: String,
    base_id: String,
    compare_id: Option<String>,
) -> Result<GraphDiff, String> {
    tokio::task::spawn_blocking(move || graphify_diff_snapshot_inner(repo, base_id, compare_id))
        .await
        .map_err(|error| format!("graphify_diff_snapshot: falha na task bloqueante: {error}"))?
}

/// Restaura um snapshot sobre `graphify-out/graph.json`.
fn graphify_rollback_inner(
    repo: String,
    snapshot_id: String,
    project_id: Option<String>,
) -> Result<(), String> {
    let root = repository_root(&repo)?;
    let source = snapshot_file(&root, &snapshot_id)?;
    let dest = graph_path(&root);
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir_failed:{e}"))?;
    }
    std::fs::copy(&source, &dest).map_err(|e| format!("copy_failed:{e}"))?;
    emit(
        "GraphUpdated",
        project_id,
        serde_json::json!({ "action": "rollback", "snapshot_id": snapshot_id }),
    );
    Ok(())
}

#[tauri::command]
pub async fn graphify_rollback(
    repo: String,
    snapshot_id: String,
    project_id: Option<String>,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || graphify_rollback_inner(repo, snapshot_id, project_id))
        .await
        .map_err(|error| format!("graphify_rollback: falha na task bloqueante: {error}"))?
}

fn graphify_prune_snapshots_inner(
    repo: String,
    keep_last: usize,
    max_age_days: Option<u64>,
    project_id: Option<String>,
) -> Result<usize, String> {
    let root = repository_root(&repo)?;
    let snapshots = read_snapshots(&root)?;
    let now = now_ms();
    let max_age_ms = max_age_days.map(|d| d.saturating_mul(24 * 60 * 60 * 1000));
    let mut removed = 0usize;

    for (index, snap) in snapshots.iter().enumerate() {
        let too_many = index >= keep_last;
        let too_old = max_age_ms
            .map(|age| now.saturating_sub(snap.created_ms) > age)
            .unwrap_or(false);
        if too_many || too_old {
            if std::fs::remove_file(&snap.path).is_ok() {
                removed += 1;
            }
        }
    }

    if removed > 0 {
        emit(
            "GraphSnapshotted",
            project_id,
            serde_json::json!({ "action": "prune", "removed": removed }),
        );
    }
    Ok(removed)
}

#[tauri::command]
pub async fn graphify_prune_snapshots(
    repo: String,
    keep_last: usize,
    max_age_days: Option<u64>,
    project_id: Option<String>,
) -> Result<usize, String> {
    tokio::task::spawn_blocking(move || {
        graphify_prune_snapshots_inner(repo, keep_last, max_age_days, project_id)
    })
    .await
    .map_err(|error| format!("graphify_prune_snapshots: falha na task bloqueante: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    use super::graphify_codex_config_write_inner as graphify_codex_config_write;
    use super::graphify_diff_snapshot_inner as graphify_diff_snapshot;
    use super::graphify_ensure_graph_inner as graphify_ensure_graph;
    use super::graphify_list_snapshots_inner as graphify_list_snapshots;
    use super::graphify_opencode_config_write_inner as graphify_opencode_config_write;
    use super::graphify_prune_snapshots_inner as graphify_prune_snapshots;
    use super::graphify_read_graph_inner as graphify_read_graph;
    use super::graphify_rollback_inner as graphify_rollback;
    use super::graphify_snapshot_inner as graphify_snapshot;
    use crate::git_control::checked_output;
    use std::fs;

    fn temp_repo_with_graph() -> PathBuf {
        let suffix = now_ms();
        let root = std::env::temp_dir().join(format!("alethe-graphify-{suffix}-{}", nanoid!(6)));
        fs::create_dir_all(&root).unwrap();
        let run = |args: &[&str]| checked_output(&root, args).unwrap();
        run(&["init"]);
        run(&["config", "user.name", "Alethe Test"]);
        run(&["config", "user.email", "alethe@example.invalid"]);
        let out_dir = root.join(GRAPH_SUBDIR);
        fs::create_dir_all(&out_dir).unwrap();
        let graph = serde_json::json!({
            "nodes": [
                { "id": "a", "label": "File A", "type": "file" },
                { "id": "b", "name": "func_b", "kind": "function" },
                { "id": "c" }
            ],
            "links": [
                { "source": "a", "target": "b", "relation": "calls" },
                { "source": "b", "target": "c" }
            ]
        });
        fs::write(out_dir.join(GRAPH_FILE), graph.to_string()).unwrap();
        root
    }

    #[test]
    fn reads_and_normalizes_graph() {
        let root = temp_repo_with_graph();
        let root_str = root.to_string_lossy().into_owned();
        let data = graphify_read_graph(root_str).unwrap();
        assert_eq!(data.node_count, 3);
        assert_eq!(data.nodes.len(), 3);
        assert_eq!(data.edges.len(), 2);
        assert!(!data.truncated);

        let c = data.nodes.iter().find(|n| n.id == "c").unwrap();
        assert_eq!(c.label, "c");
        let a = data.nodes.iter().find(|n| n.id == "a").unwrap();
        assert_eq!(a.kind.as_deref(), Some("file"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn snapshot_list_diff_rollback_and_prune() {
        let root = temp_repo_with_graph();
        let root_str = root.to_string_lossy().into_owned();

        let snap = graphify_snapshot(root_str.clone(), None).unwrap();
        assert!(snap.size_bytes > 0);
        assert_eq!(graphify_list_snapshots(root_str.clone()).unwrap().len(), 1);

        let out = root.join(GRAPH_SUBDIR).join(GRAPH_FILE);
        let smaller = serde_json::json!({
            "nodes": [ { "id": "a" }, { "id": "b" } ],
            "links": [ { "source": "a", "target": "b" } ]
        });
        fs::write(&out, smaller.to_string()).unwrap();
        let diff = graphify_diff_snapshot(root_str.clone(), snap.id.clone(), None).unwrap();
        assert_eq!(diff.nodes_removed, 1); // 'c' sumiu
        assert_eq!(diff.edges_removed, 1);

        graphify_rollback(root_str.clone(), snap.id.clone(), None).unwrap();
        assert_eq!(graphify_read_graph(root_str.clone()).unwrap().node_count, 3);

        // Prune keep_last=0 remove tudo.
        let removed = graphify_prune_snapshots(root_str.clone(), 0, None, None).unwrap();
        assert_eq!(removed, 1);
        assert_eq!(graphify_list_snapshots(root_str).unwrap().len(), 0);

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn ensure_graph_bootstrap_states() {
        let root = temp_repo_with_graph();
        let root_str = root.to_string_lossy().into_owned();
        assert_eq!(graphify_ensure_graph(root_str, None).unwrap(), "exists");

        let bare = std::env::temp_dir().join(format!("alethe-graphify-lock-{}", nanoid!(6)));
        fs::create_dir_all(&bare).unwrap();
        let run = |args: &[&str]| checked_output(&bare, args).unwrap();
        run(&["init"]);
        let canon = bare.canonicalize().unwrap();
        generating_set().lock().unwrap().insert(canon.clone());
        let bare_str = bare.to_string_lossy().into_owned();
        assert_eq!(
            graphify_ensure_graph(bare_str.clone(), None).unwrap(),
            "generating"
        );
        generating_set().lock().unwrap().remove(&canon);

        let status = graphify_ensure_graph(
            bare_str,
            Some("alethe-nonexistent-graphify-cli".to_string()),
        )
        .unwrap();
        assert_eq!(status, "unavailable");

        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(bare).unwrap();
    }

    #[test]
    fn rejects_forged_snapshot_id() {
        let root = temp_repo_with_graph();
        let root_str = root.to_string_lossy().into_owned();
        assert!(graphify_rollback(root_str.clone(), "../evil".into(), None).is_err());
        assert!(graphify_diff_snapshot(root_str, "abc".into(), None).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn opencode_config_write_creates_and_merges_without_clobbering() {
        let root = temp_repo_with_graph();
        let root_str = root.to_string_lossy().into_owned();

        graphify_opencode_config_write(root_str.clone(), None).unwrap();
        let path = root.join("opencode.json");
        let body = fs::read_to_string(&path).unwrap();
        let parsed: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(parsed["mcp"]["graphify"]["type"], "local");
        assert_eq!(parsed["mcp"]["graphify"]["command"][0], "graphify");
        assert_eq!(parsed["mcp"]["graphify"]["enabled"], true);

        fs::write(&path, r#"{"model": "anthropic/claude-sonnet-4-5", "mcp": {"other": {"type": "local", "command": ["x"]}}}"#).unwrap();
        graphify_opencode_config_write(root_str, None).unwrap();
        let merged: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(merged["model"], "anthropic/claude-sonnet-4-5");
        assert_eq!(merged["mcp"]["other"]["command"][0], "x");
        assert_eq!(merged["mcp"]["graphify"]["type"], "local");

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn codex_config_write_creates_and_replaces_only_its_own_block() {
        let root = temp_repo_with_graph();
        let root_str = root.to_string_lossy().into_owned();

        let codex_dir = root.join(".codex");
        fs::create_dir_all(&codex_dir).unwrap();
        fs::write(
            codex_dir.join("config.toml"),
            "model = \"gpt-5\"\n\n[mcp_servers.other]\ncommand = \"other-cmd\"\n",
        )
        .unwrap();

        graphify_codex_config_write(root_str.clone(), None).unwrap();
        let body = fs::read_to_string(codex_dir.join("config.toml")).unwrap();
        assert!(
            body.contains("model = \"gpt-5\""),
            "chave do usuário deve sobreviver: {body}"
        );
        assert!(
            body.contains("[mcp_servers.other]"),
            "outro servidor MCP deve sobreviver: {body}"
        );
        assert!(body.contains("command = \"other-cmd\""));
        assert!(body.contains("[mcp_servers.graphify]"));
        assert!(body.contains("command = \"graphify\""));

        graphify_codex_config_write(root_str, None).unwrap();
        let body2 = fs::read_to_string(codex_dir.join("config.toml")).unwrap();
        assert_eq!(body2.matches("[mcp_servers.graphify]").count(), 1);
        assert_eq!(body2.matches("[mcp_servers.other]").count(), 1);

        fs::remove_dir_all(root).unwrap();
    }
}
