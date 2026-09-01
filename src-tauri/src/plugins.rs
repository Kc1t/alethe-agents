//! RFC-012 — Plugin System.
//!

//!

//! - `skill` — habilidade customizada (spec: markdown/gatilho, ex. skills de
//!   merge por classe da RFC-006);

//!

//! no Event Bus para quem quiser reagir.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use tauri::AppHandle;

const PLUGINS_DIR: &str = "plugins";
const MANIFEST_FILE: &str = "plugin.json";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum PluginKind {
    AgentType,
    Skill,
    ValidationPipeline,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginManifest {
    pub id: String,
    pub name: String,
    pub version: String,
    pub kind: PluginKind,
    #[serde(default)]
    pub description: String,

    #[serde(default)]
    pub spec: serde_json::Value,
}

fn validate_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("invalid_plugin_id".to_string());
    }
    Ok(())
}

fn plugins_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(crate::paths::profile_data_dir(app)?.join(PLUGINS_DIR))
}

fn list_in(root: &Path) -> Result<Vec<PluginManifest>, String> {
    let mut result = Vec::new();
    if !root.is_dir() {
        return Ok(result);
    }
    let entries = std::fs::read_dir(root).map_err(|e| format!("read_dir_failed:{e}"))?;
    for entry in entries.flatten() {
        let manifest_path = entry.path().join(MANIFEST_FILE);
        let Ok(raw) = std::fs::read_to_string(&manifest_path) else {
            continue;
        };

        if let Ok(manifest) = serde_json::from_str::<PluginManifest>(&raw) {
            result.push(manifest);
        }
    }
    result.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(result)
}

fn install_in(root: &Path, manifest: &PluginManifest) -> Result<(), String> {
    validate_id(&manifest.id)?;
    if manifest.name.trim().is_empty() {
        return Err("invalid_plugin_name".to_string());
    }
    let dir = root.join(&manifest.id);
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir_failed:{e}"))?;
    let body = serde_json::to_string_pretty(manifest).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(MANIFEST_FILE), body).map_err(|e| format!("write_failed:{e}"))?;
    Ok(())
}

fn uninstall_in(root: &Path, id: &str) -> Result<(), String> {
    validate_id(id)?;
    let dir = root.join(id);
    if !dir.join(MANIFEST_FILE).is_file() {
        return Err("plugin_not_found".to_string());
    }
    std::fs::remove_dir_all(&dir).map_err(|e| format!("remove_failed:{e}"))?;
    Ok(())
}

fn emit(event_type: &str, manifest_id: &str, data: serde_json::Value) {
    crate::event_bus::publish_event_simple(
        event_type,
        &format!("plugin-{manifest_id}"),
        None,
        None,
        data,
    );
}

// --- Comandos ----------------------------------------------------------------

#[tauri::command]
pub fn plugins_list(
    app: AppHandle,
    kind: Option<PluginKind>,
) -> Result<Vec<PluginManifest>, String> {
    let root = plugins_root(&app)?;
    let all = list_in(&root)?;
    Ok(match kind {
        Some(kind) => all.into_iter().filter(|p| p.kind == kind).collect(),
        None => all,
    })
}

#[tauri::command]
pub fn plugin_install(app: AppHandle, manifest: PluginManifest) -> Result<(), String> {
    let root = plugins_root(&app)?;
    install_in(&root, &manifest)?;
    emit(
        "PluginInstalled",
        &manifest.id,
        serde_json::json!({ "id": manifest.id, "kind": manifest.kind, "version": manifest.version }),
    );
    Ok(())
}

#[tauri::command]
pub fn plugin_uninstall(app: AppHandle, id: String) -> Result<(), String> {
    let root = plugins_root(&app)?;
    uninstall_in(&root, &id)?;
    emit("PluginRemoved", &id, serde_json::json!({ "id": id }));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn manifest(id: &str, kind: PluginKind) -> PluginManifest {
        PluginManifest {
            id: id.to_string(),
            name: format!("Plugin {id}"),
            version: "1.0.0".to_string(),
            kind,
            description: String::new(),
            spec: serde_json::json!({ "commands": ["echo ok"] }),
        }
    }

    #[test]
    fn installs_lists_filters_and_uninstalls() {
        let root = std::env::temp_dir().join(format!("alethe-plugins-{}", nanoid::nanoid!(8)));

        assert!(list_in(&root).unwrap().is_empty());

        install_in(
            &root,
            &manifest("val-default", PluginKind::ValidationPipeline),
        )
        .unwrap();
        install_in(&root, &manifest("merge-rust", PluginKind::Skill)).unwrap();

        install_in(&root, &manifest("merge-rust", PluginKind::Skill)).unwrap();

        let all = list_in(&root).unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].id, "merge-rust");
        assert_eq!(all[0].spec["commands"][0], "echo ok");

        let skills: Vec<_> = all
            .into_iter()
            .filter(|p| p.kind == PluginKind::Skill)
            .collect();
        assert_eq!(skills.len(), 1);

        let broken = root.join("broken");
        fs::create_dir_all(&broken).unwrap();
        fs::write(broken.join(MANIFEST_FILE), "{ not json").unwrap();
        assert_eq!(list_in(&root).unwrap().len(), 2);

        uninstall_in(&root, "merge-rust").unwrap();
        assert_eq!(list_in(&root).unwrap().len(), 1);
        assert!(uninstall_in(&root, "merge-rust").is_err());
        // Id forjado nunca vira path.
        assert!(uninstall_in(&root, "../evil").is_err());
        assert!(install_in(&root, &manifest("../evil", PluginKind::Skill)).is_err());

        fs::remove_dir_all(root).unwrap();
    }
}
