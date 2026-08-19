// Install and remove library agents under `.claude/agents`.

use serde::Serialize;
use std::fs;
use std::path::PathBuf;

const MARKER: &str = "gerado pelo Alethe";

#[derive(Serialize)]
pub struct InstalledAgent {
    pub name: String,
    /// Whether the file contains the Alethe marker and can be removed safely.
    pub from_alethe: bool,
}

fn agents_dir(folder: &str) -> PathBuf {
    PathBuf::from(folder).join(".claude").join("agents")
}

/// `async` + `spawn_blocking`: varredura de disco, mesma classe de I/O

/// despacho de IPC do Tauri.
#[tauri::command]
pub async fn list_installed_agents(folder: String) -> Vec<InstalledAgent> {
    tokio::task::spawn_blocking(move || list_installed_agents_inner(folder))
        .await
        .unwrap_or_default()
}

fn list_installed_agents_inner(folder: String) -> Vec<InstalledAgent> {
    let dir = agents_dir(&folder);
    let Ok(entries) = fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut agents: Vec<InstalledAgent> = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("md") {
                return None;
            }
            let name = path.file_stem()?.to_str()?.to_string();
            let from_alethe = fs::read_to_string(&path)
                .map(|c| c.contains(MARKER))
                .unwrap_or(false);
            Some(InstalledAgent { name, from_alethe })
        })
        .collect();
    agents.sort_by(|a, b| a.name.cmp(&b.name));
    agents
}

/// Install a library agent, returning `conflict` for an unowned file unless forced.
#[tauri::command]
pub fn install_agent(
    folder: String,
    name: String,
    content: String,
    force: bool,
) -> Result<String, String> {
    if name.is_empty() || name.contains(['/', '\\', '.']) {
        return Err(format!("nome de agent inválido: {name}"));
    }
    let dir = agents_dir(&folder);
    fs::create_dir_all(&dir).map_err(|e| format!("criar {}: {e}", dir.display()))?;
    let path = dir.join(format!("{name}.md"));

    if path.exists() && !force {
        let ours = fs::read_to_string(&path)
            .map(|c| c.contains(MARKER))
            .unwrap_or(false);
        if !ours {
            return Err("conflict".to_string());
        }
    }

    fs::write(&path, content).map_err(|e| format!("escrever {}: {e}", path.display()))?;
    eprintln!("[agent_library] instalado {}", path.display());
    Ok(path.to_string_lossy().to_string())
}

/// Remove an installed agent. Unowned files require `force`.
#[tauri::command]
pub fn uninstall_agent(folder: String, name: String, force: bool) -> Result<(), String> {
    if name.is_empty() || name.contains(['/', '\\', '.']) {
        return Err(format!("nome de agent inválido: {name}"));
    }
    let path = agents_dir(&folder).join(format!("{name}.md"));
    if !path.exists() {
        return Ok(());
    }
    let ours = fs::read_to_string(&path)
        .map(|c| c.contains(MARKER))
        .unwrap_or(false);
    if !ours && !force {
        return Err("not-ours".to_string());
    }
    fs::remove_file(&path).map_err(|e| format!("remover {}: {e}", path.display()))?;
    eprintln!("[agent_library] removido {}", path.display());
    Ok(())
}
