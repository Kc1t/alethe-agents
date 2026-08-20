use serde::Serialize;
use std::path::Path;
use std::process::Command;

#[derive(Serialize)]
pub struct OpenCodeSessionSnapshot {
    pub id: String,
    pub modified_at_ms: u128,
}

/// `/home/u/project`).
///

fn normalize_path(path: &str) -> String {
    let trimmed = path
        .trim()
        .trim_end_matches(|c: char| c == '\\' || c == '/');
    let unprefixed = trimmed
        .strip_prefix(r"\\?\UNC\")
        .map(|rest| format!(r"\\{rest}"))
        .unwrap_or_else(|| trimmed.strip_prefix(r"\\?\").unwrap_or(trimmed).to_string());
    if cfg!(windows) {
        unprefixed.replace('/', "\\").to_ascii_lowercase()
    } else {
        unprefixed
    }
}

///
/// `async` + `spawn_blocking`: roda um subprocesso (`opencode session list`)

#[tauri::command]
pub async fn snapshot_opencode_sessions(
    cwd: String,
) -> Result<Vec<OpenCodeSessionSnapshot>, String> {
    tokio::task::spawn_blocking(move || snapshot_opencode_sessions_inner(cwd))
        .await
        .map_err(|error| format!("snapshot_opencode_sessions: falha na task bloqueante: {error}"))?
}

fn snapshot_opencode_sessions_inner(cwd: String) -> Result<Vec<OpenCodeSessionSnapshot>, String> {
    let mut command = Command::new("opencode");
    command.args(["session", "list", "--format", "json", "--max-count", "50"]);
    if !cwd.is_empty() && Path::new(&cwd).is_dir() {
        command.current_dir(crate::worktrees::git_arg(Path::new(&cwd)));
    }
    let output = command
        .output()
        .map_err(|e| format!("falha ao executar opencode: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("opencode session list falhou: {stderr}"));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);

    if stdout.trim().is_empty() {
        return Ok(Vec::new());
    }
    let entries: Vec<serde_json::Value> =
        serde_json::from_str(&stdout).map_err(|e| format!("falha ao parsear JSON: {e}"))?;

    let target = normalize_path(&cwd);
    let mut sessions: Vec<OpenCodeSessionSnapshot> = entries
        .into_iter()
        .filter_map(|entry| {
            let id = entry.get("id")?.as_str()?.to_string();
            let updated = entry.get("updated")?.as_f64()? as u128;

            if !target.is_empty() {
                if let Some(directory) = entry.get("directory").and_then(|d| d.as_str()) {
                    if normalize_path(directory) != target {
                        return None;
                    }
                }
            }
            Some(OpenCodeSessionSnapshot {
                id,
                modified_at_ms: updated,
            })
        })
        .collect();

    sessions.sort_by(|a, b| b.modified_at_ms.cmp(&a.modified_at_ms));
    Ok(sessions)
}

/// Exporta o histórico estruturado (mensagens, chamadas de ferramenta, patches
/// de arquivo) de uma sessão via `opencode export <sessionID>` — devolvido
/// como JSON opaco pro frontend interpretar, sem tentar modelar cada `part`
/// possível em Rust (o schema tem vários `type`s hoje — `text`, `reasoning`,
/// `tool`, `patch`, `step-start`, `step-finish` — e provavelmente ganha mais
/// no futuro; um passthrough tolera isso sem quebrar).
///
/// Usado pra renderizar a sessão-filha do GSD Sync como um feed de atividade
/// somente-leitura (sem terminal PTY nenhum no caminho) — ver
/// `useGsdSyncSessionsWatcher` no frontend.
///
/// `async` + `spawn_blocking`: mesmo motivo de `snapshot_opencode_sessions`
/// (subprocesso de verdade, não pode rodar na thread de despacho do Tauri).
#[tauri::command]
pub async fn opencode_export_session(
    cwd: String,
    session_id: String,
) -> Result<serde_json::Value, String> {
    tokio::task::spawn_blocking(move || opencode_export_session_inner(cwd, session_id))
        .await
        .map_err(|error| format!("opencode_export_session: falha na task bloqueante: {error}"))?
}

fn opencode_export_session_inner(
    cwd: String,
    session_id: String,
) -> Result<serde_json::Value, String> {
    if session_id.is_empty() {
        return Err("session_id vazio".to_string());
    }
    let mut command = Command::new("opencode");
    command.args(["export", &session_id]);
    if !cwd.is_empty() && Path::new(&cwd).is_dir() {
        command.current_dir(crate::worktrees::git_arg(Path::new(&cwd)));
    }
    let output = command
        .output()
        .map_err(|e| format!("falha ao executar opencode: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("opencode export falhou: {stderr}"));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    // O CLI imprime uma linha de status ("Exporting session: <id>") ANTES do
    // JSON de verdade no stdout — confirmado ao vivo rodando o comando. Pula
    // pro primeiro `{` em vez de assumir que o stdout inteiro é JSON.
    let json_start = stdout
        .find('{')
        .ok_or_else(|| "opencode export não devolveu JSON".to_string())?;
    serde_json::from_str(&stdout[json_start..]).map_err(|e| format!("falha ao parsear JSON: {e}"))
}
