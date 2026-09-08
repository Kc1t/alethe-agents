//! The configuration directory Alethe owns for the agents it launches.
//!
//! An agent started from Alethe used to read the user's own configuration — for OpenCode, whatever
//! sits in `~/.config/opencode/`. That made the environment inside Alethe a function of the
//! machine it happened to run on: a server the user added for unrelated work appeared here too, a
//! setting changed for something else changed this, and anything Alethe wanted to provide had to be
//! written into the user's file or into their repository.
//!
//! Instead, Alethe keeps a configuration directory of its own and points the agent at it. The
//! agent then sees exactly what Alethe put there and nothing else.
//!
//! **Only configuration moves.** OpenCode keeps sessions, credentials and snapshots in its *data*
//! directory (`~/.local/share/opencode/`), which is governed by a different variable and is left
//! alone — verified against a real installation: the session list and a 1.6 MB session export come
//! back byte-identical with the redirect in place. Conversation history survives, resuming a
//! session by id still works, and the user does not have to log in again.
//!
//! The trade is deliberate and visible: settings the user keeps in their own OpenCode config —
//! custom agents, shell choice, plugins — do not exist inside Alethe. That is the point of a clean
//! environment, not an oversight, and it is why this directory is editable from the MCP manager
//! rather than being a black box.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// Directory handed to the agent as its configuration root. The layout beneath it is the agent's
/// convention, not ours: OpenCode looks for `<root>/opencode/opencode.json`.
const AGENT_CONFIG_DIR_NAME: &str = "agent-config";

/// Resolved once at startup so code with no access to the app handle — the MCP manager, which is
/// reached through commands that never carried a data root — can still find this directory. Without
/// it the manager would edit the user's own config while the agent read Alethe's, and the settings
/// screen would silently have no effect on the running agent.
static AGENT_CONFIG_ROOT: OnceLock<PathBuf> = OnceLock::new();

pub fn agent_config_root_at(data_root: &Path) -> PathBuf {
    data_root.join(AGENT_CONFIG_DIR_NAME)
}

/// The OpenCode configuration file inside Alethe's root, following OpenCode's own layout.
pub fn opencode_config_path_at(data_root: &Path) -> PathBuf {
    agent_config_root_at(data_root)
        .join("opencode")
        .join("opencode.json")
}

/// Creates the directory and, on first use, an empty configuration.
///
/// The seed is deliberately bare: a schema reference and an empty server map. Copying the user's
/// settings across would defeat the purpose (their config would be back, just duplicated and free
/// to drift), and inventing settings they never chose would be worse. An existing file is never
/// rewritten — everything in it after the first run was put there by the user or by Alethe's own
/// MCP manager.
pub fn ensure_agent_config_at(data_root: &Path) -> Result<PathBuf, String> {
    let root = agent_config_root_at(data_root);
    let config = opencode_config_path_at(data_root);
    if let Some(parent) = config.parent() {
        std::fs::create_dir_all(parent).map_err(|error| format!("mkdir_failed:{error}"))?;
    }
    if !config.exists() {
        let seed = serde_json::json!({
            "$schema": "https://opencode.ai/config.json",
            "mcp": {},
        });
        let body = serde_json::to_string_pretty(&seed).map_err(|error| error.to_string())?;
        std::fs::write(&config, body).map_err(|error| format!("write_failed:{error}"))?;
    }
    Ok(root)
}

/// Registers the root for lookups that have no data root of their own. Idempotent; the first
/// registration wins, matching `OnceLock`.
pub fn register_agent_config_root(root: PathBuf) {
    let _ = AGENT_CONFIG_ROOT.set(root);
}

pub fn registered_agent_config_root() -> Option<&'static PathBuf> {
    AGENT_CONFIG_ROOT.get()
}

/// Directory to hand the agent as its configuration root, creating it if needed.
///
/// The frontend passes this to the process as `XDG_CONFIG_HOME` when it launches OpenCode. It is
/// resolved per call rather than cached on the frontend so that switching profiles — which changes
/// the data root — takes effect on the next spawn instead of the next restart.
#[tauri::command]
pub fn agent_config_root(app: tauri::AppHandle) -> Result<String, String> {
    let data_root = crate::paths::app_data_dir(&app)?;
    let root = ensure_agent_config_at(&data_root)?;
    Ok(root.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(label: &str) -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("alethe-agent-config-{label}-{suffix}"));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn seeds_an_empty_config_on_first_use() {
        let data_root = temp_dir("seed");
        let root = ensure_agent_config_at(&data_root).unwrap();

        assert_eq!(root, data_root.join("agent-config"));
        // The path layout is OpenCode's convention: it looks for `opencode/opencode.json` beneath
        // whatever configuration root it is given, so getting this wrong means it silently finds
        // nothing.
        let config = data_root.join("agent-config").join("opencode").join("opencode.json");
        assert!(config.is_file());

        let parsed: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&config).unwrap()).unwrap();
        assert!(parsed["mcp"].as_object().unwrap().is_empty());

        std::fs::remove_dir_all(&data_root).unwrap();
    }

    #[test]
    fn never_overwrites_a_configuration_that_already_exists() {
        // Everything in the file after the first run was put there by the user or by the MCP
        // manager. Re-seeding on each launch would silently discard it.
        let data_root = temp_dir("preserve");
        ensure_agent_config_at(&data_root).unwrap();
        let config = opencode_config_path_at(&data_root);
        std::fs::write(&config, r#"{"mcp":{"kept":{"type":"local"}}}"#).unwrap();

        ensure_agent_config_at(&data_root).unwrap();

        let parsed: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&config).unwrap()).unwrap();
        assert!(parsed["mcp"]["kept"].is_object());

        std::fs::remove_dir_all(&data_root).unwrap();
    }
}
