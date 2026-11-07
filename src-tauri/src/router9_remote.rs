//! Key for a remote 9router gateway: kept in the OS keychain and never returned to the webview.

use tauri::AppHandle;

use crate::secure_store::{OsSecretStore, SecretKind, SecretStore};

const MAX_KEY_BYTES: usize = 512;
/// The only env vars a terminal may receive the key in.
const KEY_ENV_NAMES: [&str; 3] = ["ANTHROPIC_AUTH_TOKEN", "ALETHE_ROUTER9_KEY", "OPENAI_API_KEY"];

fn active_profile_id(app: &AppHandle) -> Result<String, String> {
    Ok(crate::profiles::ensure_profiles_index(app)?.active_profile_id)
}

fn validate_key(key: &str) -> Result<(), String> {
    if key.len() > MAX_KEY_BYTES || key.chars().any(char::is_control) {
        return Err("router9_invalid_key".into());
    }
    Ok(())
}

fn validate_key_env_names(names: &[String], agent_launch: bool) -> Result<(), String> {
    // Only an agent CLI uses the key; a plain or scripted shell would just be a way to print it.
    if !agent_launch {
        return Err("router9_key_env_needs_agent".into());
    }
    match names.iter().find(|name| !KEY_ENV_NAMES.contains(&name.as_str())) {
        Some(name) => Err(format!("router9_key_env_refused: {name}")),
        None => Ok(()),
    }
}

#[tauri::command]
pub fn router9_remote_key_status(app: AppHandle) -> Result<bool, String> {
    let profile_id = active_profile_id(&app)?;
    OsSecretStore
        .get(&profile_id, SecretKind::Router9RemoteKey)
        .map(|key| key.is_some())
        .map_err(|error| error.to_string())
}

/// Saves the key, or removes it when `key` is blank.
#[tauri::command]
pub fn router9_set_remote_key(app: AppHandle, key: String) -> Result<(), String> {
    let profile_id = active_profile_id(&app)?;
    let key = key.trim();
    validate_key(key)?;
    let result = if key.is_empty() {
        OsSecretStore.delete(&profile_id, SecretKind::Router9RemoteKey)
    } else {
        OsSecretStore.set(&profile_id, SecretKind::Router9RemoteKey, key)
    };
    result.map_err(|error| error.to_string())
}

/// Env pairs carrying the key for one PTY. A missing key fails the launch instead of letting the
/// agent fall back to the person's own account.
pub fn key_env(
    app: &AppHandle,
    names: Option<&[String]>,
    agent_launch: bool,
) -> Result<Vec<(String, String)>, String> {
    let Some(names) = names.filter(|names| !names.is_empty()) else {
        return Ok(Vec::new());
    };
    validate_key_env_names(names, agent_launch)?;
    let profile_id = active_profile_id(app)?;
    let key = OsSecretStore
        .get(&profile_id, SecretKind::Router9RemoteKey)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "router9_key_missing".to_string())?;
    Ok(names.iter().map(|name| (name.clone(), key.clone())).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_the_known_key_env_names() {
        let ok = vec!["ANTHROPIC_AUTH_TOKEN".to_string(), "ALETHE_ROUTER9_KEY".to_string()];
        assert!(validate_key_env_names(&ok, true).is_ok());
        let bad = vec!["PATH".to_string()];
        assert_eq!(
            validate_key_env_names(&bad, true).unwrap_err(),
            "router9_key_env_refused: PATH"
        );
    }

    #[test]
    fn gives_the_key_only_to_agent_launches() {
        let names = vec!["ANTHROPIC_AUTH_TOKEN".to_string()];
        assert_eq!(
            validate_key_env_names(&names, false).unwrap_err(),
            "router9_key_env_needs_agent"
        );
    }

    #[test]
    fn refuses_keys_that_could_break_an_env_value() {
        assert!(validate_key("or_abc123").is_ok());
        assert!(validate_key("or_abc\nPATH=x").is_err());
        assert!(validate_key(&"k".repeat(MAX_KEY_BYTES + 1)).is_err());
    }
}
