//! RFC-012 — Plugin System.
//!
//! Manifest storage and enable/disable state for plugins. A plugin is a
//! directory under `<profile_data_dir>/plugins/<id>/` holding a `plugin.json`
//! manifest and, for UI plugins, the assets named by `entry`/`styles`.
//!
//! Bundled plugins ship inside the application bundle and have no directory
//! here, but their enable/disable state is tracked in the same `state.json` so
//! the user's choice survives an update.

use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use tauri::AppHandle;

const PLUGINS_DIR: &str = "plugins";
const MANIFEST_FILE: &str = "plugin.json";
const STATE_FILE: &str = "state.json";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PluginKind {
    AgentType,
    Skill,
    ValidationPipeline,
    Ui,
    Theme,
}

fn default_api_version() -> u32 {
    1
}

/// `deny_unknown_fields` is deliberate: a manifest written for a future
/// `apiVersion` must fail loudly rather than load with half its meaning lost.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginManifest {
    pub id: String,
    pub name: String,
    pub version: String,
    pub kind: PluginKind,

    #[serde(default = "default_api_version")]
    pub api_version: u32,

    #[serde(default)]
    pub description: String,

    /// Script asset, relative to the plugin directory. UI and theme plugins
    /// without an entry contribute through `spec` alone.
    #[serde(default)]
    pub entry: Option<String>,

    #[serde(default)]
    pub styles: Option<String>,

    /// Capabilities the plugin declares it needs, matched against host-side
    /// allowlists (for example `invoke:git_*`).
    #[serde(default)]
    pub capabilities: Vec<String>,

    #[serde(default)]
    pub spec: serde_json::Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledPlugin {
    #[serde(flatten)]
    pub manifest: PluginManifest,
    pub enabled: bool,
    pub path: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct PluginState {
    #[serde(default)]
    disabled: BTreeSet<String>,
}

fn validate_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
    {
        return Err("invalid_plugin_id".to_string());
    }
    // A bare `.` or `..` passes the character check but is still a traversal.
    if id.chars().all(|c| c == '.') {
        return Err("invalid_plugin_id".to_string());
    }
    Ok(())
}

fn plugins_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(crate::paths::profile_data_dir(app)?.join(PLUGINS_DIR))
}

fn read_state(root: &Path) -> PluginState {
    std::fs::read_to_string(root.join(STATE_FILE))
        .ok()
        .and_then(|raw| serde_json::from_str::<PluginState>(&raw).ok())
        .unwrap_or_default()
}

fn write_state(root: &Path, state: &PluginState) -> Result<(), String> {
    std::fs::create_dir_all(root).map_err(|e| format!("mkdir_failed:{e}"))?;
    let body = serde_json::to_string_pretty(state).map_err(|e| e.to_string())?;
    let tmp = root.join(format!("{STATE_FILE}.tmp"));
    std::fs::write(&tmp, body).map_err(|e| format!("write_failed:{e}"))?;
    std::fs::rename(&tmp, root.join(STATE_FILE)).map_err(|e| format!("rename_failed:{e}"))?;
    Ok(())
}

fn list_in(root: &Path) -> Result<Vec<InstalledPlugin>, String> {
    let mut result = Vec::new();
    if !root.is_dir() {
        return Ok(result);
    }
    let state = read_state(root);
    let entries = std::fs::read_dir(root).map_err(|e| format!("read_dir_failed:{e}"))?;
    for entry in entries.flatten() {
        let dir = entry.path();
        let Ok(raw) = std::fs::read_to_string(dir.join(MANIFEST_FILE)) else {
            continue;
        };

        if let Ok(manifest) = serde_json::from_str::<PluginManifest>(&raw) {
            let enabled = !state.disabled.contains(&manifest.id);
            result.push(InstalledPlugin {
                manifest,
                enabled,
                path: dir.to_string_lossy().to_string(),
            });
        }
    }
    result.sort_by(|a, b| a.manifest.id.cmp(&b.manifest.id));
    Ok(result)
}

fn install_in(root: &Path, manifest: &PluginManifest) -> Result<(), String> {
    validate_id(&manifest.id)?;
    if manifest.name.trim().is_empty() {
        return Err("invalid_plugin_name".to_string());
    }
    if manifest.api_version != default_api_version() {
        return Err(format!("unsupported_api_version:{}", manifest.api_version));
    }
    for asset in [manifest.entry.as_deref(), manifest.styles.as_deref()]
        .into_iter()
        .flatten()
    {
        validate_asset_name(asset)?;
    }
    let dir = root.join(&manifest.id);
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir_failed:{e}"))?;
    let body = serde_json::to_string_pretty(manifest).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(MANIFEST_FILE), body).map_err(|e| format!("write_failed:{e}"))?;
    Ok(())
}

/// Assets are resolved by joining onto the plugin directory, so they must be a
/// plain file name — no separators, no traversal, no drive prefix.
fn validate_asset_name(name: &str) -> Result<(), String> {
    if name.is_empty()
        || name.contains('/')
        || name.contains('\\')
        || name.contains("..")
        || name.contains(':')
    {
        return Err("invalid_plugin_asset".to_string());
    }
    Ok(())
}

fn uninstall_in(root: &Path, id: &str) -> Result<(), String> {
    validate_id(id)?;
    let dir = root.join(id);
    if !dir.join(MANIFEST_FILE).is_file() {
        return Err("plugin_not_found".to_string());
    }
    std::fs::remove_dir_all(&dir).map_err(|e| format!("remove_failed:{e}"))?;
    let mut state = read_state(root);
    if state.disabled.remove(id) {
        write_state(root, &state)?;
    }
    Ok(())
}

fn set_enabled_in(root: &Path, id: &str, enabled: bool) -> Result<(), String> {
    validate_id(id)?;
    let mut state = read_state(root);
    let changed = if enabled {
        state.disabled.remove(id)
    } else {
        state.disabled.insert(id.to_string())
    };
    if changed {
        write_state(root, &state)?;
    }
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

// --- Commands ----------------------------------------------------------------

#[tauri::command]
pub fn plugins_list(
    app: AppHandle,
    kind: Option<PluginKind>,
) -> Result<Vec<InstalledPlugin>, String> {
    let root = plugins_root(&app)?;
    let all = list_in(&root)?;
    Ok(match kind {
        Some(kind) => all
            .into_iter()
            .filter(|p| p.manifest.kind == kind)
            .collect(),
        None => all,
    })
}

/// Disabled ids for every plugin, including bundled ones that have no directory
/// on disk. The frontend needs this before it decides what to activate.
#[tauri::command]
pub fn plugins_disabled(app: AppHandle) -> Result<Vec<String>, String> {
    let root = plugins_root(&app)?;
    Ok(read_state(&root).disabled.into_iter().collect())
}

#[tauri::command]
pub fn plugins_dir(app: AppHandle) -> Result<String, String> {
    let root = plugins_root(&app)?;
    std::fs::create_dir_all(&root).map_err(|e| format!("mkdir_failed:{e}"))?;
    Ok(root.to_string_lossy().to_string())
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

#[tauri::command]
pub fn plugin_set_enabled(app: AppHandle, id: String, enabled: bool) -> Result<(), String> {
    let root = plugins_root(&app)?;
    set_enabled_in(&root, &id, enabled)?;
    emit(
        if enabled {
            "PluginEnabled"
        } else {
            "PluginDisabled"
        },
        &id,
        serde_json::json!({ "id": id, "enabled": enabled }),
    );
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
            api_version: 1,
            description: String::new(),
            entry: None,
            styles: None,
            capabilities: Vec::new(),
            spec: serde_json::json!({ "commands": ["echo ok"] }),
        }
    }

    fn temp_root(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!("alethe-plugins-{tag}-{}", nanoid::nanoid!(8)))
    }

    #[test]
    fn installs_lists_filters_and_uninstalls() {
        let root = temp_root("crud");

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
        assert_eq!(all[0].manifest.id, "merge-rust");
        assert_eq!(all[0].manifest.spec["commands"][0], "echo ok");
        assert!(all[0].enabled);

        let skills: Vec<_> = all
            .into_iter()
            .filter(|p| p.manifest.kind == PluginKind::Skill)
            .collect();
        assert_eq!(skills.len(), 1);

        let broken = root.join("broken");
        fs::create_dir_all(&broken).unwrap();
        fs::write(broken.join(MANIFEST_FILE), "{ not json").unwrap();
        assert_eq!(list_in(&root).unwrap().len(), 2);

        uninstall_in(&root, "merge-rust").unwrap();
        assert_eq!(list_in(&root).unwrap().len(), 1);
        assert!(uninstall_in(&root, "merge-rust").is_err());

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_forged_ids_and_assets() {
        let root = temp_root("forged");

        assert!(uninstall_in(&root, "../evil").is_err());
        assert!(install_in(&root, &manifest("../evil", PluginKind::Skill)).is_err());
        assert!(install_in(&root, &manifest("..", PluginKind::Skill)).is_err());
        assert!(set_enabled_in(&root, "../evil", false).is_err());

        // Dots are allowed inside a namespaced id like `alethe.git-control`.
        assert!(validate_id("alethe.git-control").is_ok());

        let mut with_asset = manifest("assets", PluginKind::Ui);
        with_asset.entry = Some("../../evil.js".to_string());
        assert!(install_in(&root, &with_asset).is_err());

        with_asset.entry = Some("main.js".to_string());
        with_asset.styles = Some("nested/styles.css".to_string());
        assert!(install_in(&root, &with_asset).is_err());

        with_asset.styles = Some("styles.css".to_string());
        assert!(install_in(&root, &with_asset).is_ok());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn rejects_unsupported_api_version() {
        let root = temp_root("api-version");
        let mut future = manifest("from-the-future", PluginKind::Ui);
        future.api_version = 99;
        assert!(install_in(&root, &future).is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn tracks_disabled_state_for_installed_and_bundled_ids() {
        let root = temp_root("state");
        install_in(&root, &manifest("local-one", PluginKind::Ui)).unwrap();

        set_enabled_in(&root, "local-one", false).unwrap();
        // A bundled plugin has no directory here but its choice is still stored.
        set_enabled_in(&root, "alethe.git-control", false).unwrap();

        let listed = list_in(&root).unwrap();
        assert_eq!(listed.len(), 1);
        assert!(!listed[0].enabled);
        assert_eq!(read_state(&root).disabled.len(), 2);

        set_enabled_in(&root, "local-one", true).unwrap();
        assert!(list_in(&root).unwrap()[0].enabled);

        // Uninstalling clears the leftover disabled entry.
        set_enabled_in(&root, "local-one", false).unwrap();
        uninstall_in(&root, "local-one").unwrap();
        assert_eq!(
            read_state(&root).disabled.into_iter().collect::<Vec<_>>(),
            vec!["alethe.git-control".to_string()]
        );

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn unknown_manifest_fields_are_rejected() {
        let raw = r#"{
            "id": "future",
            "name": "Future",
            "version": "1.0.0",
            "kind": "ui",
            "somethingFromApiVersion2": true
        }"#;
        assert!(serde_json::from_str::<PluginManifest>(raw).is_err());
    }

    #[test]
    fn a_manifest_with_an_unknown_field_never_reaches_the_list() {
        let root = temp_root("unknown-field");
        let dir = root.join("broken");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join(MANIFEST_FILE),
            r#"{"id":"broken","name":"B","version":"1.0.0","kind":"ui","futureField":1}"#,
        )
        .unwrap();
        assert!(list_in(&root).unwrap().is_empty());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn legacy_manifests_without_v2_fields_still_parse() {
        let raw = r#"{
            "id": "legacy",
            "name": "Legacy",
            "version": "0.1.0",
            "kind": "skill",
            "spec": { "commands": [] }
        }"#;
        let parsed: PluginManifest = serde_json::from_str(raw).unwrap();
        assert_eq!(parsed.api_version, 1);
        assert!(parsed.entry.is_none());
        assert!(parsed.capabilities.is_empty());
    }
}
