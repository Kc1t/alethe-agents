//! sincronizado sozinho (ver `assets/opencode-plugins/alethe-gsd-state.ts`),

//! `"mcp"`).
//!

use serde_json::Value;

use crate::git_control::repository_root;

const PLUGIN_TS: &str = include_str!("../assets/opencode-plugins/alethe-gsd-state.ts");
const PLUGIN_REL_PATH: &str = ".opencode/plugins/alethe-gsd-state.ts";
const PLUGIN_CONFIG_ENTRY: &str = "./.opencode/plugins/alethe-gsd-state.ts";
const MANAGED_MARKER_PREFIX: &str = "// alethe-managed: v";
const CURRENT_PLUGIN_VERSION: u32 = 12;

fn should_write_plugin_file(existing: Option<&str>) -> bool {
    match existing {
        None => true,
        Some(content) => match content
            .lines()
            .next()
            .and_then(|l| l.strip_prefix(MANAGED_MARKER_PREFIX))
            .and_then(|v| v.trim().parse::<u32>().ok())
        {
            Some(v) => v <= CURRENT_PLUGIN_VERSION,
            None => false,
        },
    }
}

/// o sidecar `.opencode/alethe-gsd-config.json` com a cadeia de fallback de

///
/// Nome `_inner` porque `repository_root` roda `git rev-parse` de verdade

/// o Monitoramento GSD ligado (mesma classe de bug corrigida em `pty.rs`/

/// `spawn_blocking`.
fn gsd_opencode_plugin_write_inner(repo: String, model_chain: Vec<String>) -> Result<(), String> {
    let root = repository_root(&repo)?;

    let plugin_path = root.join(PLUGIN_REL_PATH);
    let existing = std::fs::read_to_string(&plugin_path).ok();
    if should_write_plugin_file(existing.as_deref()) {
        if let Some(parent) = plugin_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("mkdir_failed:{e}"))?;
        }
        std::fs::write(&plugin_path, PLUGIN_TS).map_err(|e| format!("write_failed:{e}"))?;
    }

    write_gsd_config_sidecar(&root, &model_chain)?;
    write_opencode_plugin_entry(&root)
}

#[tauri::command]
pub async fn gsd_opencode_plugin_write(
    repo: String,
    model_chain: Vec<String>,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || gsd_opencode_plugin_write_inner(repo, model_chain))
        .await
        .map_err(|error| format!("gsd_opencode_plugin_write: falha na task bloqueante: {error}"))?
}

/// Escreve `.opencode/alethe-gsd-config.json` com a cadeia de fallback de

fn write_gsd_config_sidecar(root: &std::path::Path, model_chain: &[String]) -> Result<(), String> {
    let path = root.join(".opencode").join("alethe-gsd-config.json");
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir_failed:{e}"))?;
    }
    let body = serde_json::json!({ "modelChain": model_chain });
    std::fs::write(
        &path,
        serde_json::to_string_pretty(&body).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("write_failed:{e}"))
}

fn write_opencode_plugin_entry(root: &std::path::Path) -> Result<(), String> {
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

    let list = config
        .entry("plugin".to_string())
        .or_insert_with(|| Value::Array(Vec::new()));
    if let Value::Array(arr) = list {
        let already_present = arr.iter().any(|v| v.as_str() == Some(PLUGIN_CONFIG_ENTRY));
        if !already_present {
            arr.push(Value::String(PLUGIN_CONFIG_ENTRY.to_string()));
        }
    }

    let body = serde_json::to_string_pretty(&Value::Object(config)).map_err(|e| e.to_string())?;
    std::fs::write(&path, body).map_err(|e| format!("write_failed:{e}"))
}

#[cfg(test)]
mod tests {
    use super::gsd_opencode_plugin_write_inner as gsd_opencode_plugin_write;
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_repo(label: &str) -> std::path::PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root =
            std::env::temp_dir().join(format!("alethe-opencode-gsd-plugin-{label}-{suffix}"));
        fs::create_dir_all(&root).unwrap();
        crate::git_control::checked_output(&root, &["init", "-b", "main"]).unwrap();
        crate::git_control::checked_output(&root, &["config", "user.name", "Alethe Test"]).unwrap();
        crate::git_control::checked_output(
            &root,
            &["config", "user.email", "alethe@example.invalid"],
        )
        .unwrap();
        fs::write(root.join("a.txt"), "a\n").unwrap();
        crate::git_control::checked_output(&root, &["add", "-A"]).unwrap();
        crate::git_control::checked_output(&root, &["commit", "-m", "base"]).unwrap();
        root
    }

    #[test]
    fn plugin_file_written_when_absent() {
        let root = temp_repo("write-absent");
        gsd_opencode_plugin_write(root.to_string_lossy().into_owned(), vec![]).unwrap();

        let plugin_path = root.join(PLUGIN_REL_PATH);
        let content = fs::read_to_string(&plugin_path).unwrap();
        assert_eq!(content, PLUGIN_TS);
        assert!(content.starts_with("// alethe-managed: v12"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn plugin_entry_merged_without_clobbering_existing_config() {
        let root = temp_repo("merge-no-clobber");
        fs::write(
            root.join("opencode.json"),
            r#"{"model": "some/model", "plugin": ["./outro-plugin.ts"]}"#,
        )
        .unwrap();

        gsd_opencode_plugin_write(root.to_string_lossy().into_owned(), vec![]).unwrap();

        let raw = fs::read_to_string(root.join("opencode.json")).unwrap();
        let parsed: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(parsed["model"], "some/model");
        let plugins = parsed["plugin"].as_array().unwrap();
        assert!(plugins.iter().any(|v| v == "./outro-plugin.ts"));
        assert!(plugins.iter().any(|v| v == PLUGIN_CONFIG_ENTRY));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn plugin_entry_not_duplicated_on_second_call() {
        let root = temp_repo("no-duplicate");
        gsd_opencode_plugin_write(root.to_string_lossy().into_owned(), vec![]).unwrap();
        gsd_opencode_plugin_write(root.to_string_lossy().into_owned(), vec![]).unwrap();

        let raw = fs::read_to_string(root.join("opencode.json")).unwrap();
        let parsed: Value = serde_json::from_str(&raw).unwrap();
        let plugins = parsed["plugin"].as_array().unwrap();
        let count = plugins
            .iter()
            .filter(|v| v.as_str() == Some(PLUGIN_CONFIG_ENTRY))
            .count();
        assert_eq!(count, 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn plugin_file_not_overwritten_when_user_edited() {
        let root = temp_repo("no-overwrite-edited");
        let plugin_dir = root.join(".opencode").join("plugins");
        fs::create_dir_all(&plugin_dir).unwrap();
        fs::write(
            plugin_dir.join("alethe-gsd-state.ts"),
            "// custom user content, no marker\n",
        )
        .unwrap();

        gsd_opencode_plugin_write(root.to_string_lossy().into_owned(), vec![]).unwrap();

        let content = fs::read_to_string(plugin_dir.join("alethe-gsd-state.ts")).unwrap();
        assert_eq!(content, "// custom user content, no marker\n");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn plugin_file_not_overwritten_when_marker_is_a_future_version() {
        let root = temp_repo("no-overwrite-future");
        let plugin_dir = root.join(".opencode").join("plugins");
        fs::create_dir_all(&plugin_dir).unwrap();
        fs::write(
            plugin_dir.join("alethe-gsd-state.ts"),
            "// alethe-managed: v99\ncustom future content\n",
        )
        .unwrap();

        gsd_opencode_plugin_write(root.to_string_lossy().into_owned(), vec![]).unwrap();

        let content = fs::read_to_string(plugin_dir.join("alethe-gsd-state.ts")).unwrap();
        assert!(content.starts_with("// alethe-managed: v99"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn plugin_file_auto_updates_when_marker_is_older_or_equal() {
        let root = temp_repo("auto-update");
        let plugin_dir = root.join(".opencode").join("plugins");
        fs::create_dir_all(&plugin_dir).unwrap();
        fs::write(
            plugin_dir.join("alethe-gsd-state.ts"),
            "// alethe-managed: v1\nold body\n",
        )
        .unwrap();

        gsd_opencode_plugin_write(root.to_string_lossy().into_owned(), vec![]).unwrap();

        let content = fs::read_to_string(plugin_dir.join("alethe-gsd-state.ts")).unwrap();
        assert_eq!(content, PLUGIN_TS);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn opencode_json_created_from_scratch_with_schema() {
        let root = temp_repo("create-scratch");
        gsd_opencode_plugin_write(root.to_string_lossy().into_owned(), vec![]).unwrap();

        let raw = fs::read_to_string(root.join("opencode.json")).unwrap();
        let parsed: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(parsed["$schema"], "https://opencode.ai/config.json");
        assert_eq!(parsed["plugin"][0], PLUGIN_CONFIG_ENTRY);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn model_chain_sidecar_written_and_overwritten_on_every_call() {
        let root = temp_repo("model-chain-sidecar");
        gsd_opencode_plugin_write(
            root.to_string_lossy().into_owned(),
            vec![
                "mimo-v2.5-free".to_string(),
                "laguna-s-2.1-free".to_string(),
            ],
        )
        .unwrap();

        let sidecar_path = root.join(".opencode").join("alethe-gsd-config.json");
        let raw = fs::read_to_string(&sidecar_path).unwrap();
        let parsed: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(parsed["modelChain"][0], "mimo-v2.5-free");
        assert_eq!(parsed["modelChain"][1], "laguna-s-2.1-free");

        gsd_opencode_plugin_write(root.to_string_lossy().into_owned(), vec![]).unwrap();
        let raw2 = fs::read_to_string(&sidecar_path).unwrap();
        let parsed2: Value = serde_json::from_str(&raw2).unwrap();
        assert_eq!(parsed2["modelChain"].as_array().unwrap().len(), 0);

        fs::remove_dir_all(root).unwrap();
    }
}
