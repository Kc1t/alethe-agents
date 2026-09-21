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
const PLUGIN_DATA_DIR: &str = "plugin-data";
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

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ViewContainer {
    LeftSidebar,
    RightSidebar,
}

/// A view the plugin announces without loading its code, so the shell can draw
/// the tab and only activate the plugin when it is revealed.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManifestView {
    pub id: String,
    pub container: ViewContainer,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub panel_title_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub order: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManifestCommand {
    pub id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keywords: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManifestContributes {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub views: Vec<ManifestView>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub commands: Vec<ManifestCommand>,
}

impl ManifestContributes {
    fn is_empty(&self) -> bool {
        self.views.is_empty() && self.commands.is_empty()
    }
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

    /// Activation events. Empty means `onStartupFinished`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub activation: Vec<String>,

    /// Contributions announced without loading the plugin's code.
    #[serde(default, skip_serializing_if = "ManifestContributes::is_empty")]
    pub contributes: ManifestContributes,

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

/// Bundled plugins are on unless listed in `disabled`. Local plugins are the
/// other way round: they run only after the user explicitly enables them, so
/// dropping a folder in never grants anything by itself.
#[derive(Debug, Default, Serialize, Deserialize)]
struct PluginState {
    #[serde(default)]
    disabled: BTreeSet<String>,
    #[serde(default)]
    enabled: BTreeSet<String>,
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
            // Assets resolve as `<plugins_root>/<id>/…`, so a directory whose
            // name does not match the id would list but never load its entry.
            if dir.file_name().and_then(|name| name.to_str()) != Some(manifest.id.as_str()) {
                continue;
            }
            let enabled =
                state.enabled.contains(&manifest.id) && !state.disabled.contains(&manifest.id);
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
    validate_contributes(&manifest.contributes)?;
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

/// Contribution ids are used as registry keys and as DOM-visible tab ids, so
/// they follow the same shape as a plugin id.
fn validate_contribution_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.chars().all(|c| c == '.')
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
    {
        return Err("invalid_contribution_id".to_string());
    }
    Ok(())
}

fn validate_contributes(contributes: &ManifestContributes) -> Result<(), String> {
    let mut seen = BTreeSet::new();
    for view in &contributes.views {
        validate_contribution_id(&view.id)?;
        if view.title.trim().is_empty() {
            return Err("invalid_contribution_title".to_string());
        }
        if !seen.insert(format!("view:{}", view.id)) {
            return Err(format!("duplicate_contribution:{}", view.id));
        }
    }
    for command in &contributes.commands {
        validate_contribution_id(&command.id)?;
        if command.title.trim().is_empty() {
            return Err("invalid_contribution_title".to_string());
        }
        if !seen.insert(format!("command:{}", command.id)) {
            return Err(format!("duplicate_contribution:{}", command.id));
        }
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
    let cleared = state.disabled.remove(id) | state.enabled.remove(id);
    if cleared {
        write_state(root, &state)?;
    }
    Ok(())
}

fn set_enabled_in(root: &Path, id: &str, enabled: bool) -> Result<(), String> {
    validate_id(id)?;
    let mut state = read_state(root);
    let changed = if enabled {
        let removed = state.disabled.remove(id);
        state.enabled.insert(id.to_string()) || removed
    } else {
        let removed = state.enabled.remove(id);
        state.disabled.insert(id.to_string()) || removed
    };
    if changed {
        write_state(root, &state)?;
    }
    Ok(())
}

const MAX_IMPORT_FILES: usize = 200;
const MAX_IMPORT_BYTES: u64 = 10 * 1024 * 1024;
const MAX_IMPORT_DEPTH: usize = 5;

/// Copies a plugin directory in, bounded and refusing symlinks so an import can
/// never pull in a target outside the folder the user picked.
fn copy_tree(
    source: &Path,
    destination: &Path,
    depth: usize,
    files: &mut usize,
    bytes: &mut u64,
) -> Result<(), String> {
    if depth > MAX_IMPORT_DEPTH {
        return Err("plugin_too_deep".to_string());
    }
    std::fs::create_dir_all(destination).map_err(|e| format!("mkdir_failed:{e}"))?;
    let entries = std::fs::read_dir(source).map_err(|e| format!("read_dir_failed:{e}"))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("read_dir_failed:{e}"))?;
        let kind = entry
            .file_type()
            .map_err(|e| format!("read_dir_failed:{e}"))?;
        if kind.is_symlink() {
            return Err("plugin_contains_symlink".to_string());
        }
        let target = destination.join(entry.file_name());
        if kind.is_dir() {
            copy_tree(&entry.path(), &target, depth + 1, files, bytes)?;
            continue;
        }
        if !kind.is_file() {
            continue;
        }
        *files += 1;
        if *files > MAX_IMPORT_FILES {
            return Err("plugin_too_many_files".to_string());
        }
        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
        *bytes += size;
        if *bytes > MAX_IMPORT_BYTES {
            return Err("plugin_too_large".to_string());
        }
        std::fs::copy(entry.path(), &target).map_err(|e| format!("copy_failed:{e}"))?;
    }
    Ok(())
}

fn import_dir_into(root: &Path, source: &Path) -> Result<PluginManifest, String> {
    let source = source
        .canonicalize()
        .map_err(|_| "plugin_source_not_found".to_string())?;
    if !source.is_dir() {
        return Err("plugin_source_not_a_directory".to_string());
    }
    let raw = std::fs::read_to_string(source.join(MANIFEST_FILE))
        .map_err(|_| "plugin_manifest_missing".to_string())?;
    let manifest: PluginManifest =
        serde_json::from_str(&raw).map_err(|e| format!("invalid_manifest:{e}"))?;

    validate_id(&manifest.id)?;
    if manifest.name.trim().is_empty() {
        return Err("invalid_plugin_name".to_string());
    }
    if manifest.api_version != default_api_version() {
        return Err(format!("unsupported_api_version:{}", manifest.api_version));
    }
    validate_contributes(&manifest.contributes)?;
    for asset in [manifest.entry.as_deref(), manifest.styles.as_deref()]
        .into_iter()
        .flatten()
    {
        validate_asset_name(asset)?;
        if !source.join(asset).is_file() {
            return Err(format!("missing_plugin_asset:{asset}"));
        }
    }

    let destination = root.join(&manifest.id);
    if destination.canonicalize().ok().as_deref() == Some(source.as_path()) {
        return Err("plugin_already_installed".to_string());
    }
    if destination.exists() {
        std::fs::remove_dir_all(&destination).map_err(|e| format!("remove_failed:{e}"))?;
    }
    let mut files = 0usize;
    let mut bytes = 0u64;
    if let Err(error) = copy_tree(&source, &destination, 0, &mut files, &mut bytes) {
        let _ = std::fs::remove_dir_all(&destination);
        return Err(error);
    }
    Ok(manifest)
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

/// Copies a plugin directory into the profile's plugins folder. The plugin stays
/// disabled: arriving on disk is not consent to run.
pub fn import_dir(app: &AppHandle, source: &Path) -> Result<PluginManifest, String> {
    let root = plugins_root(app)?;
    let manifest = import_dir_into(&root, source)?;
    emit(
        "PluginInstalled",
        &manifest.id,
        serde_json::json!({ "id": manifest.id, "kind": manifest.kind, "version": manifest.version }),
    );
    Ok(manifest)
}

#[tauri::command]
pub fn plugin_import_dir(app: AppHandle, source: String) -> Result<PluginManifest, String> {
    import_dir(&app, Path::new(&source))
}

/// A plugin's own data. Deliberately outside `plugins/`: everything under a
/// plugin directory is reachable over `alethe-plugin://`, and a reimport
/// replaces that directory, which would take the user's data with it.
fn plugin_data_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(crate::paths::profile_data_dir(app)?.join(PLUGIN_DATA_DIR))
}

const MAX_STORAGE_BYTES: usize = 1024 * 1024;

fn storage_file(root: &Path, id: &str) -> Result<PathBuf, String> {
    validate_id(id)?;
    Ok(root.join(format!("{id}.json")))
}

fn storage_read_in(root: &Path, id: &str) -> Result<Option<String>, String> {
    let file = storage_file(root, id)?;
    match std::fs::read_to_string(&file) {
        Ok(body) => Ok(Some(body)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("read_failed:{error}")),
    }
}

fn storage_write_in(root: &Path, id: &str, body: Option<&str>) -> Result<(), String> {
    let file = storage_file(root, id)?;
    let Some(body) = body else {
        return match std::fs::remove_file(&file) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!("remove_failed:{error}")),
        };
    };
    if body.len() > MAX_STORAGE_BYTES {
        return Err("storage_too_large".to_string());
    }
    serde_json::from_str::<serde_json::Value>(body).map_err(|_| "storage_not_json".to_string())?;

    std::fs::create_dir_all(root).map_err(|e| format!("mkdir_failed:{e}"))?;
    let tmp = root.join(format!("{id}.json.tmp"));
    std::fs::write(&tmp, body).map_err(|e| format!("write_failed:{e}"))?;
    std::fs::rename(&tmp, &file).map_err(|e| format!("rename_failed:{e}"))?;
    Ok(())
}

#[tauri::command]
pub fn plugin_storage_read(app: AppHandle, id: String) -> Result<Option<String>, String> {
    storage_read_in(&plugin_data_root(&app)?, &id)
}

#[tauri::command]
pub fn plugin_storage_write(
    app: AppHandle,
    id: String,
    body: Option<String>,
) -> Result<(), String> {
    storage_write_in(&plugin_data_root(&app)?, &id, body.as_deref())
}

#[tauri::command]
pub fn plugin_uninstall(app: AppHandle, id: String) -> Result<(), String> {
    let root = plugins_root(&app)?;
    uninstall_in(&root, &id)?;
    // Uninstall is the user asking for the plugin gone, data included.
    storage_write_in(&plugin_data_root(&app)?, &id, None)?;
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
            activation: Vec::new(),
            contributes: ManifestContributes::default(),
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
        // A local plugin is off until the user says otherwise.
        assert!(!all[0].enabled);

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

        // Dropping a plugin in the folder grants nothing on its own.
        assert!(!list_in(&root).unwrap()[0].enabled);

        set_enabled_in(&root, "local-one", true).unwrap();
        assert!(list_in(&root).unwrap()[0].enabled);

        set_enabled_in(&root, "local-one", false).unwrap();
        assert!(!list_in(&root).unwrap()[0].enabled);

        // A bundled plugin has no directory here but its choice is still stored.
        set_enabled_in(&root, "alethe.git-control", false).unwrap();
        assert!(read_state(&root).disabled.contains("alethe.git-control"));

        // Uninstalling clears both leftover entries for that id.
        set_enabled_in(&root, "local-one", true).unwrap();
        uninstall_in(&root, "local-one").unwrap();
        let state = read_state(&root);
        assert!(!state.enabled.contains("local-one"));
        assert!(!state.disabled.contains("local-one"));
        assert_eq!(
            state.disabled.into_iter().collect::<Vec<_>>(),
            vec!["alethe.git-control".to_string()]
        );

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn declared_contributions_round_trip_and_validate() {
        let raw = r#"{
            "id": "alethe.git-control",
            "name": "Git Control",
            "version": "1.0.0",
            "kind": "ui",
            "activation": ["onView:git", "onCommand:git.reveal"],
            "contributes": {
                "views": [
                    { "id": "git", "container": "leftSidebar", "title": "Source Control",
                      "titleKey": "ui.sidebar.git", "icon": "git-branch", "order": 10 }
                ],
                "commands": [
                    { "id": "git.reveal", "title": "Source Control", "icon": "git-branch" }
                ]
            }
        }"#;
        let parsed: PluginManifest = serde_json::from_str(raw).unwrap();
        assert_eq!(
            parsed.activation,
            vec!["onView:git", "onCommand:git.reveal"]
        );
        assert_eq!(parsed.contributes.views.len(), 1);
        assert_eq!(
            parsed.contributes.views[0].container,
            ViewContainer::LeftSidebar
        );
        assert_eq!(parsed.contributes.commands[0].id, "git.reveal");
        assert!(validate_contributes(&parsed.contributes).is_ok());

        // An empty contributes block is not serialized back out.
        let plain = manifest("plain", PluginKind::Ui);
        let body = serde_json::to_string(&plain).unwrap();
        assert!(!body.contains("contributes"));
        assert!(!body.contains("activation"));
    }

    #[test]
    fn rejects_bad_contribution_ids_titles_and_duplicates() {
        let mut contributes = ManifestContributes::default();
        contributes.views.push(ManifestView {
            id: "../evil".to_string(),
            container: ViewContainer::RightSidebar,
            title: "Evil".to_string(),
            title_key: None,
            panel_title_key: None,
            icon: None,
            order: None,
        });
        assert!(validate_contributes(&contributes).is_err());

        contributes.views[0].id = "ok".to_string();
        contributes.views[0].title = "   ".to_string();
        assert!(validate_contributes(&contributes).is_err());

        contributes.views[0].title = "Ok".to_string();
        assert!(validate_contributes(&contributes).is_ok());

        let duplicate = contributes.views[0].clone();
        contributes.views.push(duplicate);
        assert!(validate_contributes(&contributes)
            .unwrap_err()
            .starts_with("duplicate_contribution:"));
    }

    #[test]
    fn an_unknown_field_inside_contributes_is_rejected() {
        let raw = r#"{
            "id": "future", "name": "F", "version": "1.0.0", "kind": "ui",
            "contributes": { "views": [
                { "id": "v", "container": "leftSidebar", "title": "V", "somethingNew": 1 }
            ] }
        }"#;
        assert!(serde_json::from_str::<PluginManifest>(raw).is_err());

        let unknown_container = r#"{
            "id": "future", "name": "F", "version": "1.0.0", "kind": "ui",
            "contributes": { "views": [
                { "id": "v", "container": "statusBar", "title": "V" }
            ] }
        }"#;
        assert!(serde_json::from_str::<PluginManifest>(unknown_container).is_err());
    }

    fn write_source_plugin(dir: &Path, manifest_json: &str) {
        fs::create_dir_all(dir).unwrap();
        fs::write(dir.join(MANIFEST_FILE), manifest_json).unwrap();
        fs::write(dir.join("main.js"), "// entry").unwrap();
    }

    const IMPORTABLE: &str = r#"{
        "id": "example.notes", "name": "Notes", "version": "1.0.0", "kind": "ui",
        "entry": "main.js", "capabilities": ["ui.sidebarTab"],
        "contributes": { "views": [
            { "id": "notes", "container": "leftSidebar", "title": "Notes" }
        ] }
    }"#;

    #[test]
    fn imports_a_directory_and_leaves_the_plugin_switched_off() {
        let root = temp_root("import");
        let source = temp_root("import-src").join("example.notes");
        write_source_plugin(&source, IMPORTABLE);
        fs::create_dir_all(source.join("assets")).unwrap();
        fs::write(source.join("assets").join("logo.svg"), "<svg/>").unwrap();

        let manifest = import_dir_into(&root, &source).unwrap();
        assert_eq!(manifest.id, "example.notes");

        let installed = list_in(&root).unwrap();
        assert_eq!(installed.len(), 1);
        assert!(!installed[0].enabled, "importing is not consent to run");
        assert!(root.join("example.notes").join("main.js").is_file());
        assert!(root
            .join("example.notes")
            .join("assets")
            .join("logo.svg")
            .is_file());

        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(source.parent().unwrap());
    }

    #[test]
    fn import_rejects_a_bad_source() {
        let root = temp_root("import-bad");
        let base = temp_root("import-bad-src");

        assert_eq!(
            import_dir_into(&root, &base.join("nope")).unwrap_err(),
            "plugin_source_not_found"
        );

        let empty = base.join("empty");
        fs::create_dir_all(&empty).unwrap();
        assert_eq!(
            import_dir_into(&root, &empty).unwrap_err(),
            "plugin_manifest_missing"
        );

        let no_entry = base.join("no-entry");
        fs::create_dir_all(&no_entry).unwrap();
        fs::write(no_entry.join(MANIFEST_FILE), IMPORTABLE).unwrap();
        assert_eq!(
            import_dir_into(&root, &no_entry).unwrap_err(),
            "missing_plugin_asset:main.js"
        );

        let future = base.join("future");
        write_source_plugin(
            &future,
            r#"{"id":"f","name":"F","version":"1.0.0","kind":"ui","apiVersion":9,"entry":"main.js"}"#,
        );
        assert_eq!(
            import_dir_into(&root, &future).unwrap_err(),
            "unsupported_api_version:9"
        );

        assert!(list_in(&root).unwrap().is_empty());
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn reimporting_keeps_the_enabled_choice() {
        let root = temp_root("reimport");
        let source = temp_root("reimport-src").join("example.notes");
        write_source_plugin(&source, IMPORTABLE);

        import_dir_into(&root, &source).unwrap();
        set_enabled_in(&root, "example.notes", true).unwrap();
        assert!(list_in(&root).unwrap()[0].enabled);

        import_dir_into(&root, &source).unwrap();
        assert!(
            list_in(&root).unwrap()[0].enabled,
            "an update must not silently switch a plugin off"
        );

        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(source.parent().unwrap());
    }

    #[test]
    fn a_directory_whose_name_does_not_match_the_id_is_skipped() {
        let root = temp_root("dir-name");
        let dir = root.join("wrong-folder-name");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join(MANIFEST_FILE),
            r#"{"id":"example.notes","name":"Notes","version":"1.0.0","kind":"ui","entry":"main.js"}"#,
        )
        .unwrap();
        assert!(list_in(&root).unwrap().is_empty());

        let right = root.join("example.notes");
        fs::create_dir_all(&right).unwrap();
        fs::write(
            right.join(MANIFEST_FILE),
            r#"{"id":"example.notes","name":"Notes","version":"1.0.0","kind":"ui","entry":"main.js"}"#,
        )
        .unwrap();
        assert_eq!(list_in(&root).unwrap().len(), 1);

        let _ = fs::remove_dir_all(root);
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

    #[test]
    fn stores_a_plugin_blob_outside_the_served_plugin_directory() {
        let root = temp_root("storage");
        assert_eq!(storage_read_in(&root, "a.b").unwrap(), None);

        storage_write_in(&root, "a.b", Some(r#"{"n":1}"#)).unwrap();
        assert_eq!(
            storage_read_in(&root, "a.b").unwrap().as_deref(),
            Some(r#"{"n":1}"#)
        );
        assert!(!root.join("a.b").is_dir());

        storage_write_in(&root, "a.b", None).unwrap();
        assert_eq!(storage_read_in(&root, "a.b").unwrap(), None);
        storage_write_in(&root, "a.b", None).unwrap();
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn refuses_a_traversing_id_oversized_and_non_json_bodies() {
        let root = temp_root("storage-guards");
        assert!(storage_write_in(&root, "../evil", Some("{}")).is_err());
        assert!(storage_read_in(&root, "..").is_err());
        assert_eq!(
            storage_write_in(&root, "a.b", Some("not json")).unwrap_err(),
            "storage_not_json"
        );

        let huge = format!("{{\"v\":\"{}\"}}", "x".repeat(MAX_STORAGE_BYTES));
        assert_eq!(
            storage_write_in(&root, "a.b", Some(&huge)).unwrap_err(),
            "storage_too_large"
        );
        assert_eq!(storage_read_in(&root, "a.b").unwrap(), None);
        let _ = fs::remove_dir_all(root);
    }
}
