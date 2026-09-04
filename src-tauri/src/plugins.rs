//! Discovery and import of the plugins an agent loads.
//!
//! OpenCode loads plugins two different ways, and telling them apart is most of the value here —
//! "why is my plugin not loading" is the question this exists to answer:
//!
//! - **Directory plugins** — every file in `<config root>/plugin/` is picked up automatically, with
//!   nothing to declare. Alethe's own bridge lives here, which is why the working/idle signal works
//!   without the user configuring anything.
//! - **Declared plugins** — entries in the `plugin` array of `opencode.json`, each an explicit
//!   path. A file in some other folder loads only because it is named there; remove the entry and
//!   it goes quiet while the file stays on disk, looking installed.
//!
//! Both are reported, tagged with the mechanism that found them, because a file sitting in a folder
//! nothing scans is indistinguishable from one that failed to load.
//!
//! Scope matters as much as mechanism. Alethe hands its agents a configuration root of its own (see
//! `agent_config`), so a plugin under the user's `~/.config/opencode/` is **not** loaded by agents
//! started from Alethe. Reporting both scopes side by side is what stops the panel from showing a
//! plugin as active when it is not — and it is why the copy here runs along scope rather than
//! agent, unlike MCP servers and skills: OpenCode is the only agent with this concept today, so a
//! four-agent matrix would be three permanently empty columns.

use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;

use crate::provider_common::provider_home_dir;

/// Directory whose contents OpenCode loads with no declaration needed.
const AUTO_PLUGIN_DIR: &str = "plugin";
/// Only these are plugin sources; a stray README or lockfile in the folder is not a plugin.
const PLUGIN_EXTENSIONS: [&str; 4] = ["js", "ts", "mjs", "cjs"];
/// Enough of a file to show in a detail view without loading a bundle into memory: `claude-mem.js`
/// on the reference machine is 336 KB of compiled output nobody reads top to bottom.
const MAX_SOURCE_BYTES: usize = 64 * 1024;
/// Written and rewritten by Alethe on every launch, so an edit made to it would vanish unexplained.
const MANAGED_PLUGINS: [&str; 1] = ["alethe-bridge.js"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PluginOrigin {
    /// Found in the auto-loaded `plugin/` directory.
    Directory,
    /// Named in the `plugin` array of the configuration file.
    Declared,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PluginScope {
    /// Alethe's own configuration root — what agents started from Alethe actually load.
    Alethe,
    /// The user's OpenCode configuration. Not loaded inside Alethe.
    User,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginSummary {
    pub name: String,
    pub agent: String,
    pub path: String,
    pub origin: PluginOrigin,
    pub scope: PluginScope,
    /// False when the configuration names a path that is not on disk. The entry still looks
    /// installed and loads nothing, which is worth showing rather than hiding as an absent row.
    pub exists: bool,
    pub size: u64,
    pub managed: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginScopeSnapshot {
    pub agent: String,
    pub scope: PluginScope,
    /// Configuration root scanned, so an empty result is explainable rather than just empty.
    pub root: Option<String>,
    pub exists: bool,
    pub plugins: Vec<PluginSummary>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginDetail {
    pub summary: PluginSummary,
    pub source: String,
    /// True when `source` is only the head of the file.
    pub truncated: bool,
}

/// Result of importing one plugin, shaped like `SkillSyncOutcome` and `McpSyncOutcome` so the three
/// panels can report a copy the same way.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginImportOutcome {
    pub name: String,
    /// `ok` | `skipped` | `failed`
    pub status: &'static str,
    pub reason: Option<String>,
    pub path: Option<String>,
}

fn user_opencode_config_dir() -> Option<PathBuf> {
    provider_home_dir(&[".config", "opencode"])
}

fn alethe_opencode_config_dir() -> Option<PathBuf> {
    crate::agent_config::registered_agent_config_root().map(|root| root.join("opencode"))
}

fn is_plugin_extension(name: &str) -> bool {
    name.rsplit_once('.')
        .map(|(_, ext)| PLUGIN_EXTENSIONS.contains(&ext.to_lowercase().as_str()))
        .unwrap_or(false)
}

fn is_plugin_file(path: &Path) -> bool {
    path.is_file()
        && path
            .file_name()
            .and_then(|name| name.to_str())
            .map(is_plugin_extension)
            .unwrap_or(false)
}

fn summary_for(path: &Path, origin: PluginOrigin, scope: PluginScope) -> PluginSummary {
    let name = path
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_default();
    PluginSummary {
        managed: MANAGED_PLUGINS.contains(&name.as_str()),
        name,
        agent: "opencode".to_string(),
        path: path.to_string_lossy().into_owned(),
        origin,
        scope,
        exists: path.is_file(),
        size: std::fs::metadata(path).map(|meta| meta.len()).unwrap_or(0),
    }
}

/// Reads the `plugin` array of a configuration file, resolving each entry the way OpenCode does.
/// Entries are kept even when the file is missing.
fn declared_plugins(config_dir: &Path, scope: PluginScope) -> Vec<PluginSummary> {
    let Ok(raw) = std::fs::read_to_string(config_dir.join("opencode.json")) else {
        return Vec::new();
    };
    let Ok(Value::Object(config)) = serde_json::from_str::<Value>(&raw) else {
        return Vec::new();
    };
    let Some(Value::Array(entries)) = config.get("plugin") else {
        return Vec::new();
    };
    entries
        .iter()
        .filter_map(|entry| entry.as_str())
        .map(|entry| {
            // A relative entry is relative to the config directory; an absolute one is used as is.
            let candidate = PathBuf::from(entry);
            let resolved = if candidate.is_absolute() {
                candidate
            } else {
                config_dir.join(entry.trim_start_matches("./"))
            };
            summary_for(&resolved, PluginOrigin::Declared, scope)
        })
        .collect()
}

fn directory_plugins(config_dir: &Path, scope: PluginScope) -> Vec<PluginSummary> {
    let Ok(entries) = std::fs::read_dir(config_dir.join(AUTO_PLUGIN_DIR)) else {
        return Vec::new();
    };
    let mut found: Vec<PluginSummary> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| is_plugin_file(path))
        .map(|path| summary_for(&path, PluginOrigin::Directory, scope))
        .collect();
    found.sort_by(|a, b| a.name.cmp(&b.name));
    found
}

fn snapshot_at(config_dir: Option<PathBuf>, scope: PluginScope) -> PluginScopeSnapshot {
    let exists = config_dir.as_ref().map(|dir| dir.is_dir()).unwrap_or(false);
    let plugins = match (&config_dir, exists) {
        (Some(dir), true) => {
            let mut all = directory_plugins(dir, scope);
            all.extend(declared_plugins(dir, scope));
            all
        }
        _ => Vec::new(),
    };
    PluginScopeSnapshot {
        agent: "opencode".to_string(),
        scope,
        root: config_dir.map(|dir| dir.to_string_lossy().into_owned()),
        exists,
        plugins,
    }
}

/// Both scopes, Alethe's first: it is the one that decides what an agent launched here loads, and
/// the user's is shown for comparison and as the source for importing.
pub fn scan_plugins() -> Vec<PluginScopeSnapshot> {
    vec![
        snapshot_at(alethe_opencode_config_dir(), PluginScope::Alethe),
        snapshot_at(user_opencode_config_dir(), PluginScope::User),
    ]
}

/// Rejects anything that is not a plain plugin file name. The name is joined onto the plugin
/// directory and the import can overwrite, so an unchecked `../../` would write outside the store
/// rather than merely read the wrong file.
fn validate_plugin_name(name: &str) -> Result<(), String> {
    if name.trim().is_empty()
        || name == "."
        || name == ".."
        || name.contains('/')
        || name.contains('\\')
        || name.contains(':')
        || !is_plugin_extension(name)
    {
        return Err("invalid_name".to_string());
    }
    Ok(())
}

/// Copies plugins from the user's OpenCode configuration into Alethe's, which is what makes them
/// load for agents started here. Being in `plugin/` is all it takes — there is no registration
/// step — so the import takes effect on the next launch.
fn import_at(
    source_dir: &Path,
    target_dir: &Path,
    names: Vec<String>,
    overwrite: bool,
) -> Vec<PluginImportOutcome> {
    names
        .into_iter()
        .map(|name| {
            if let Err(reason) = validate_plugin_name(&name) {
                return PluginImportOutcome {
                    name,
                    status: "failed",
                    reason: Some(reason),
                    path: None,
                };
            }
            let source = source_dir.join(AUTO_PLUGIN_DIR).join(&name);
            if !source.is_file() {
                return PluginImportOutcome {
                    name,
                    status: "failed",
                    reason: Some("plugin_not_found".to_string()),
                    path: None,
                };
            }
            let destination_dir = target_dir.join(AUTO_PLUGIN_DIR);
            let destination = destination_dir.join(&name);
            if destination.exists() && !overwrite {
                // Left alone rather than replaced: the copy already there may be a different
                // version, and swapping it silently is indistinguishable from a successful import.
                return PluginImportOutcome {
                    name,
                    status: "skipped",
                    reason: None,
                    path: Some(destination.to_string_lossy().into_owned()),
                };
            }
            if let Err(error) = std::fs::create_dir_all(&destination_dir) {
                return PluginImportOutcome {
                    name,
                    status: "failed",
                    reason: Some(error.to_string()),
                    path: None,
                };
            }
            match std::fs::copy(&source, &destination) {
                Ok(_) => PluginImportOutcome {
                    name,
                    status: "ok",
                    reason: None,
                    path: Some(destination.to_string_lossy().into_owned()),
                },
                Err(error) => PluginImportOutcome {
                    name,
                    status: "failed",
                    reason: Some(error.to_string()),
                    path: None,
                },
            }
        })
        .collect()
}

pub fn plugin_detail_at(path: &Path) -> Result<PluginDetail, String> {
    if !path.is_file() {
        return Err("plugin_not_found".to_string());
    }
    let bytes = std::fs::read(path).map_err(|error| format!("read_failed:{error}"))?;
    let truncated = bytes.len() > MAX_SOURCE_BYTES;
    let head = if truncated {
        &bytes[..MAX_SOURCE_BYTES]
    } else {
        &bytes[..]
    };
    let scope = match crate::agent_config::registered_agent_config_root() {
        Some(root) if path.starts_with(root) => PluginScope::Alethe,
        _ => PluginScope::User,
    };
    let origin = if path
        .parent()
        .and_then(Path::file_name)
        .and_then(|name| name.to_str())
        == Some(AUTO_PLUGIN_DIR)
    {
        PluginOrigin::Directory
    } else {
        PluginOrigin::Declared
    };
    Ok(PluginDetail {
        summary: summary_for(path, origin, scope),
        source: String::from_utf8_lossy(head).into_owned(),
        truncated,
    })
}

#[tauri::command]
pub async fn plugins_scan() -> Result<Vec<PluginScopeSnapshot>, String> {
    tokio::task::spawn_blocking(scan_plugins)
        .await
        .map_err(|error| format!("plugins_scan: blocking task failed: {error}"))
}

#[tauri::command]
pub async fn plugins_detail(path: String) -> Result<PluginDetail, String> {
    tokio::task::spawn_blocking(move || plugin_detail_at(Path::new(&path)))
        .await
        .map_err(|error| format!("plugins_detail: blocking task failed: {error}"))?
}

#[tauri::command]
pub async fn plugins_import(
    names: Vec<String>,
    overwrite: Option<bool>,
) -> Result<Vec<PluginImportOutcome>, String> {
    let source = user_opencode_config_dir().ok_or_else(|| "user_config_not_found".to_string())?;
    let target = alethe_opencode_config_dir().ok_or_else(|| "agent_config_not_ready".to_string())?;
    tokio::task::spawn_blocking(move || {
        import_at(&source, &target, names, overwrite.unwrap_or(false))
    })
    .await
    .map_err(|error| format!("plugins_import: blocking task failed: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(label: &str) -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("alethe-plugins-{label}-{suffix}"));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn finds_directory_plugins_and_ignores_files_that_are_not_plugins() {
        let dir = temp_dir("auto");
        fs::create_dir_all(dir.join("plugin")).unwrap();
        fs::write(dir.join("plugin").join("bridge.js"), "export const a = 1").unwrap();
        fs::write(dir.join("plugin").join("typed.ts"), "export const b = 2").unwrap();
        fs::write(dir.join("plugin").join("README.md"), "not a plugin").unwrap();

        let found = directory_plugins(&dir, PluginScope::User);

        assert_eq!(
            found.iter().map(|p| p.name.as_str()).collect::<Vec<_>>(),
            vec!["bridge.js", "typed.ts"]
        );
        assert!(found.iter().all(|p| p.origin == PluginOrigin::Directory));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn resolves_a_declared_plugin_relative_to_the_config_directory() {
        // The reference machine declares `./plugins/claude-mem.js` — a folder the auto-load scan
        // never looks at. Resolving it wrong would report a plugin as missing while OpenCode loads
        // it perfectly well.
        let dir = temp_dir("declared");
        fs::create_dir_all(dir.join("plugins")).unwrap();
        fs::write(dir.join("plugins").join("mem.js"), "export const c = 3").unwrap();
        fs::write(
            dir.join("opencode.json"),
            r#"{"plugin":["./plugins/mem.js"]}"#,
        )
        .unwrap();

        let found = declared_plugins(&dir, PluginScope::User);

        assert_eq!(found.len(), 1);
        assert_eq!(found[0].name, "mem.js");
        assert_eq!(found[0].origin, PluginOrigin::Declared);
        assert!(found[0].exists);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn keeps_a_declared_plugin_whose_file_is_gone_and_marks_it_missing() {
        // Dropping it would hide the actual problem: the entry still loads nothing, and the user
        // has no way to see why. Same failure that took an MCP server down silently when its
        // script was wiped from the temp folder.
        let dir = temp_dir("missing");
        fs::write(dir.join("opencode.json"), r#"{"plugin":["./gone.js"]}"#).unwrap();

        let found = declared_plugins(&dir, PluginScope::User);

        assert_eq!(found.len(), 1);
        assert!(!found[0].exists);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn marks_alethes_own_bridge_as_managed() {
        // It is rewritten on every launch, so an edit made here would vanish without explanation.
        let dir = temp_dir("managed");
        fs::create_dir_all(dir.join("plugin")).unwrap();
        fs::write(dir.join("plugin").join("alethe-bridge.js"), "x").unwrap();
        fs::write(dir.join("plugin").join("mine.js"), "y").unwrap();

        let found = directory_plugins(&dir, PluginScope::Alethe);

        assert!(
            found
                .iter()
                .find(|p| p.name == "alethe-bridge.js")
                .unwrap()
                .managed
        );
        assert!(!found.iter().find(|p| p.name == "mine.js").unwrap().managed);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_config_without_a_plugin_array_yields_nothing_rather_than_failing() {
        let dir = temp_dir("noplugins");
        fs::write(dir.join("opencode.json"), r#"{"mcp":{}}"#).unwrap();
        assert!(declared_plugins(&dir, PluginScope::User).is_empty());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn importing_puts_the_plugin_where_alethes_agents_load_it() {
        let base = temp_dir("import-ok");
        let source = base.join("user");
        let target = base.join("alethe");
        fs::create_dir_all(source.join("plugin")).unwrap();
        fs::write(source.join("plugin").join("mine.js"), "export const z = 1").unwrap();

        let outcomes = import_at(&source, &target, vec!["mine.js".to_string()], false);

        assert_eq!(outcomes[0].status, "ok");
        assert!(target.join("plugin").join("mine.js").is_file());
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn an_existing_plugin_is_skipped_rather_than_replaced() {
        // The copy already there may be a different version; swapping it silently is
        // indistinguishable from a successful import.
        let base = temp_dir("import-skip");
        let source = base.join("user");
        let target = base.join("alethe");
        fs::create_dir_all(source.join("plugin")).unwrap();
        fs::create_dir_all(target.join("plugin")).unwrap();
        fs::write(source.join("plugin").join("dup.js"), "new").unwrap();
        fs::write(target.join("plugin").join("dup.js"), "keep me").unwrap();

        let outcomes = import_at(&source, &target, vec!["dup.js".to_string()], false);

        assert_eq!(outcomes[0].status, "skipped");
        assert_eq!(
            fs::read_to_string(target.join("plugin").join("dup.js")).unwrap(),
            "keep me"
        );
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn a_crafted_name_cannot_escape_the_plugin_directory() {
        // The import can overwrite, so an unchecked name would write outside the store, not merely
        // read the wrong file.
        let base = temp_dir("import-traversal");
        let source = base.join("user");
        let target = base.join("alethe");
        fs::create_dir_all(source.join("plugin")).unwrap();

        let outcomes = import_at(
            &source,
            &target,
            vec!["../../escape.js".to_string(), "no-extension".to_string()],
            true,
        );

        assert!(outcomes.iter().all(|o| o.status == "failed"));
        assert!(
            outcomes
                .iter()
                .all(|o| o.reason.as_deref() == Some("invalid_name"))
        );
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn one_missing_plugin_does_not_stop_the_rest_of_the_import() {
        let base = temp_dir("import-partial");
        let source = base.join("user");
        let target = base.join("alethe");
        fs::create_dir_all(source.join("plugin")).unwrap();
        fs::write(source.join("plugin").join("real.js"), "ok").unwrap();

        let outcomes = import_at(
            &source,
            &target,
            vec!["real.js".to_string(), "ghost.js".to_string()],
            false,
        );

        let real = outcomes.iter().find(|o| o.name == "real.js").unwrap();
        let ghost = outcomes.iter().find(|o| o.name == "ghost.js").unwrap();
        assert_eq!(real.status, "ok");
        assert_eq!(ghost.status, "failed");
        assert_eq!(ghost.reason.as_deref(), Some("plugin_not_found"));
        fs::remove_dir_all(base).unwrap();
    }
}
