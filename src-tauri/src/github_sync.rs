//

//
// Config (token + id do gist + timestamps + login) persiste em

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tauri::AppHandle;

use crate::paths::{activity_stats_file_path, app_data_dir, projects_file_path};
use crate::provider_common::now_ms;
use crate::secure_store::{OsSecretStore, SecretKind, SecretStore};

const GIST_DESCRIPTION: &str = "Alethe sync — projects & activity (managed by the app)";
const USER_AGENT: &str = "Alethe";
const GITHUB_API: &str = "https://api.github.com";

#[derive(Debug, Default, Serialize, Deserialize)]
struct SyncConfig {
    #[serde(default)]
    login: Option<String>,
    #[serde(default)]
    gist_id: Option<String>,
    #[serde(default)]
    last_push_ms: Option<u64>,
    #[serde(default)]
    last_pull_ms: Option<u64>,
}

#[derive(Default, Deserialize)]
struct StoredSyncConfig {
    #[serde(default)]
    token: String,
    #[serde(default)]
    login: Option<String>,
    #[serde(default)]
    gist_id: Option<String>,
    #[serde(default)]
    last_push_ms: Option<u64>,
    #[serde(default)]
    last_pull_ms: Option<u64>,
}

impl StoredSyncConfig {
    fn metadata(&self) -> SyncConfig {
        SyncConfig {
            login: self.login.clone(),
            gist_id: self.gist_id.clone(),
            last_push_ms: self.last_push_ms,
            last_pull_ms: self.last_pull_ms,
        }
    }
}

/// Snapshot enviado pro frontend. Nunca inclui o token.
#[derive(Serialize)]
pub struct GithubSyncStatus {
    pub connected: bool,
    pub login: Option<String>,
    pub gist_id: Option<String>,
    pub gist_url: Option<String>,
    pub last_push_ms: Option<u64>,
    pub last_pull_ms: Option<u64>,
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_dir(app)?.join("github_sync.json"))
}

fn active_profile_id(app: &AppHandle) -> Result<String, String> {
    Ok(crate::profiles::ensure_profiles_index(app)?.active_profile_id)
}

fn save_config_path(path: &Path, cfg: &SyncConfig) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let raw = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    let temp = path.with_extension(format!("json.{}.tmp", nanoid::nanoid!(10)));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temp).map_err(|e| e.to_string())?;
    if let Err(error) = file.write_all(raw.as_bytes()).and_then(|_| file.sync_all()) {
        let _ = fs::remove_file(&temp);
        return Err(error.to_string());
    }
    #[cfg(windows)]
    if path.exists() {
        fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    if let Err(error) = fs::rename(&temp, path) {
        let _ = fs::remove_file(&temp);
        return Err(error.to_string());
    }
    Ok(())
}

fn load_config_from(
    path: &Path,
    profile_id: &str,
    store: &impl SecretStore,
) -> Result<(SyncConfig, Option<String>), String> {
    let stored = match fs::read_to_string(path) {
        Ok(raw) => serde_json::from_str::<StoredSyncConfig>(&raw)
            .map_err(|error| format!("invalid_sync_config: {error}"))?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => StoredSyncConfig::default(),
        Err(error) => return Err(error.to_string()),
    };
    let cfg = stored.metadata();
    let mut token = store
        .get(profile_id, SecretKind::GithubSyncToken)
        .map_err(|error| error.to_string())?
        .filter(|value| !value.trim().is_empty());

    if !stored.token.trim().is_empty() {
        if token.is_none() {
            store
                .set(profile_id, SecretKind::GithubSyncToken, &stored.token)
                .map_err(|error| error.to_string())?;
            let verified = store
                .get(profile_id, SecretKind::GithubSyncToken)
                .map_err(|error| error.to_string())?;
            if verified.as_deref() != Some(stored.token.as_str()) {
                return Err("secure_store_verification_failed".to_string());
            }
            token = verified;
        }
        save_config_path(path, &cfg)?;
    }

    Ok((cfg, token.filter(|value| !value.trim().is_empty())))
}

fn load_config(app: &AppHandle) -> Result<(SyncConfig, Option<String>, String), String> {
    let profile_id = active_profile_id(app)?;
    let (cfg, token) = load_config_from(&config_path(app)?, &profile_id, &OsSecretStore)?;
    Ok((cfg, token, profile_id))
}

fn save_config(app: &AppHandle, cfg: &SyncConfig) -> Result<(), String> {
    save_config_path(&config_path(app)?, cfg)
}

fn restore_token(
    store: &impl SecretStore,
    profile_id: &str,
    previous: Option<&str>,
) -> Result<(), String> {
    match previous {
        Some(value) => store
            .set(profile_id, SecretKind::GithubSyncToken, value)
            .map_err(|error| error.to_string()),
        None => store
            .delete(profile_id, SecretKind::GithubSyncToken)
            .map_err(|error| error.to_string()),
    }
}

fn status_from(cfg: &SyncConfig, connected: bool) -> GithubSyncStatus {
    GithubSyncStatus {
        connected,
        login: cfg.login.clone(),
        gist_id: cfg.gist_id.clone(),
        gist_url: cfg
            .gist_id
            .as_ref()
            .map(|id| format!("https://gist.github.com/{id}")),
        last_push_ms: cfg.last_push_ms,
        last_pull_ms: cfg.last_pull_ms,
    }
}

fn collect_files(app: &AppHandle) -> Result<Vec<(String, String)>, String> {
    let mut files = Vec::new();
    let projects = projects_file_path(app)?;
    if projects.is_file() {
        let content = fs::read_to_string(&projects).map_err(|e| e.to_string())?;
        if !content.trim().is_empty() {
            files.push(("projects.json".to_string(), content));
        }
    }
    let activity = activity_stats_file_path(app)?;
    if activity.is_file() {
        let content = fs::read_to_string(&activity).map_err(|e| e.to_string())?;
        if !content.trim().is_empty() {
            files.push(("activity-stats.json".to_string(), content));
        }
    }
    Ok(files)
}

fn write_atomic(path: &Path, content: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, content).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

fn auth(req: reqwest::RequestBuilder, token: &str) -> reqwest::RequestBuilder {
    req.header("Authorization", format!("Bearer {token}"))
        .header("User-Agent", USER_AGENT)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
}

fn gist_payload(files: &[(String, String)]) -> Value {
    let mut files_json = Map::new();
    for (name, content) in files {
        files_json.insert(name.clone(), json!({ "content": content }));
    }
    json!({
        "description": GIST_DESCRIPTION,
        "public": false,
        "files": Value::Object(files_json),
    })
}

async fn create_gist(
    client: &reqwest::Client,
    token: &str,
    body: &Value,
) -> Result<String, String> {
    let resp = auth(client.post(format!("{GITHUB_API}/gists")), token)
        .json(body)
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("github returned {}", resp.status()));
    }
    let value: Value = resp.json().await.map_err(|e| format!("json parse: {e}"))?;
    value
        .get("id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "gist response missing id".to_string())
}

/// truncou o inline (arquivos > 1MB).
async fn gist_file_content(
    client: &reqwest::Client,
    token: &str,
    files: &Map<String, Value>,
    name: &str,
) -> Result<Option<String>, String> {
    let Some(file) = files.get(name) else {
        return Ok(None);
    };
    let truncated = file
        .get("truncated")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if !truncated {
        return Ok(file
            .get("content")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()));
    }
    let Some(raw_url) = file.get("raw_url").and_then(|v| v.as_str()) else {
        return Ok(None);
    };
    let resp = auth(client.get(raw_url), token)
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("github returned {}", resp.status()));
    }
    let text = resp.text().await.map_err(|e| e.to_string())?;
    Ok(Some(text))
}

#[tauri::command]
pub fn github_sync_status(app: AppHandle) -> Result<GithubSyncStatus, String> {
    let (cfg, token, _) = load_config(&app)?;
    Ok(status_from(&cfg, token.is_some()))
}

#[tauri::command]
pub async fn github_sync_set_token(
    app: AppHandle,
    token: String,
) -> Result<GithubSyncStatus, String> {
    let token = token.trim().to_string();
    if token.is_empty() {
        return Err("empty_token".to_string());
    }
    let client = reqwest::Client::new();
    let resp = auth(client.get(format!("{GITHUB_API}/user")), &token)
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;
    if resp.status().as_u16() == 401 {
        return Err("invalid_token".to_string());
    }
    if !resp.status().is_success() {
        return Err(format!("github returned {}", resp.status()));
    }
    let body: Value = resp.json().await.map_err(|e| format!("json parse: {e}"))?;
    let login = body
        .get("login")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let (mut cfg, previous_token, profile_id) = load_config(&app)?;
    let store = OsSecretStore;
    store
        .set(&profile_id, SecretKind::GithubSyncToken, &token)
        .map_err(|error| error.to_string())?;
    let verified = store
        .get(&profile_id, SecretKind::GithubSyncToken)
        .map_err(|error| error.to_string())?;
    if verified.as_deref() != Some(token.as_str()) {
        if restore_token(&store, &profile_id, previous_token.as_deref()).is_err() {
            return Err("secure_store_verification_and_rollback_failed".to_string());
        }
        return Err("secure_store_verification_failed".to_string());
    }
    cfg.login = login;
    if let Err(error) = save_config(&app, &cfg) {
        if restore_token(&store, &profile_id, previous_token.as_deref()).is_err() {
            return Err(format!("{error}; secure_store_rollback_failed"));
        }
        return Err(error);
    }
    Ok(status_from(&cfg, true))
}

#[tauri::command]
pub fn github_sync_logout(app: AppHandle) -> Result<GithubSyncStatus, String> {
    let (mut cfg, _, profile_id) = load_config(&app)?;
    OsSecretStore
        .delete(&profile_id, SecretKind::GithubSyncToken)
        .map_err(|error| error.to_string())?;
    cfg.login = None;
    save_config(&app, &cfg)?;
    Ok(status_from(&cfg, false))
}

/// guardado sumiu (404/422), recria.
#[tauri::command]
pub async fn github_sync_push(app: AppHandle) -> Result<GithubSyncStatus, String> {
    let (mut cfg, token, _) = load_config(&app)?;
    let token = token.ok_or_else(|| "not_connected".to_string())?;
    let files = collect_files(&app)?;
    if files.is_empty() {
        return Err("nothing_to_sync".to_string());
    }
    let body = gist_payload(&files);
    let client = reqwest::Client::new();

    let mut new_id: Option<String> = None;
    if let Some(id) = cfg.gist_id.clone() {
        let resp = auth(client.patch(format!("{GITHUB_API}/gists/{id}")), &token)
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("request failed: {e}"))?;
        let code = resp.status().as_u16();
        if !resp.status().is_success() {
            if code == 404 || code == 422 {
                new_id = Some(create_gist(&client, &token, &body).await?);
            } else {
                return Err(format!("github returned {}", resp.status()));
            }
        }
    } else {
        new_id = Some(create_gist(&client, &token, &body).await?);
    }

    if let Some(id) = new_id {
        cfg.gist_id = Some(id);
    }
    cfg.last_push_ms = Some(now_ms());
    save_config(&app, &cfg)?;
    Ok(status_from(&cfg, true))
}

#[tauri::command]
pub async fn github_sync_pull(app: AppHandle) -> Result<GithubSyncStatus, String> {
    let (mut cfg, token, _) = load_config(&app)?;
    let token = token.ok_or_else(|| "not_connected".to_string())?;
    let Some(id) = cfg.gist_id.clone() else {
        return Err("no_remote".to_string());
    };
    let client = reqwest::Client::new();
    let resp = auth(client.get(format!("{GITHUB_API}/gists/{id}")), &token)
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;
    if resp.status().as_u16() == 404 {
        return Err("no_remote".to_string());
    }
    if !resp.status().is_success() {
        return Err(format!("github returned {}", resp.status()));
    }
    let body: Value = resp.json().await.map_err(|e| format!("json parse: {e}"))?;
    let files = body
        .get("files")
        .and_then(|f| f.as_object())
        .ok_or_else(|| "malformed gist".to_string())?;

    if let Some(content) = gist_file_content(&client, &token, files, "projects.json").await? {
        write_atomic(&projects_file_path(&app)?, &content)?;
    } else {
        return Err("remote_missing_projects".to_string());
    }
    if let Some(content) = gist_file_content(&client, &token, files, "activity-stats.json").await? {
        write_atomic(&activity_stats_file_path(&app)?, &content)?;
    }

    cfg.last_pull_ms = Some(now_ms());
    save_config(&app, &cfg)?;
    Ok(status_from(&cfg, true))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secure_store::SecureStoreError;
    use std::collections::HashMap;
    use std::sync::Mutex;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[derive(Default)]
    struct FakeStore {
        values: Mutex<HashMap<String, String>>,
        fail_set: bool,
    }

    impl FakeStore {
        fn key(profile_id: &str, kind: SecretKind) -> String {
            let suffix = match kind {
                SecretKind::GithubSyncToken => "github",
            };
            format!("{profile_id}:{suffix}")
        }

        fn with_token(profile_id: &str, token: &str) -> Self {
            let mut values = HashMap::new();
            values.insert(
                Self::key(profile_id, SecretKind::GithubSyncToken),
                token.to_string(),
            );
            Self {
                values: Mutex::new(values),
                fail_set: false,
            }
        }
    }

    impl SecretStore for FakeStore {
        fn get(
            &self,
            profile_id: &str,
            kind: SecretKind,
        ) -> Result<Option<String>, SecureStoreError> {
            Ok(self
                .values
                .lock()
                .unwrap()
                .get(&Self::key(profile_id, kind))
                .cloned())
        }

        fn set(
            &self,
            profile_id: &str,
            kind: SecretKind,
            value: &str,
        ) -> Result<(), SecureStoreError> {
            if self.fail_set {
                return Err(SecureStoreError::Unavailable("locked".to_string()));
            }
            self.values
                .lock()
                .unwrap()
                .insert(Self::key(profile_id, kind), value.to_string());
            Ok(())
        }

        fn delete(&self, profile_id: &str, kind: SecretKind) -> Result<(), SecureStoreError> {
            self.values
                .lock()
                .unwrap()
                .remove(&Self::key(profile_id, kind));
            Ok(())
        }
    }

    fn temp_config(label: &str) -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "alethe-github-sync-{label}-{}-{suffix}",
            std::process::id()
        ));
        fs::create_dir_all(&directory).unwrap();
        directory.join("github_sync.json")
    }

    #[test]
    fn migrates_plaintext_token_only_after_keyring_verification() {
        let path = temp_config("migrate");
        let legacy_token = "legacy-secret-value";
        fs::write(
            &path,
            format!(
                r#"{{"token":"{legacy_token}","login":"octocat","gist_id":"gist-1","last_push_ms":7}}"#
            ),
        )
        .unwrap();
        let store = FakeStore::default();

        let (config, token) = load_config_from(&path, "profile-a", &store).unwrap();

        assert_eq!(token.as_deref(), Some(legacy_token));
        assert_eq!(config.login.as_deref(), Some("octocat"));
        assert_eq!(config.gist_id.as_deref(), Some("gist-1"));
        assert_eq!(config.last_push_ms, Some(7));
        let rewritten: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert!(rewritten.get("token").is_none());
        assert!(!fs::read_to_string(&path).unwrap().contains(legacy_token));

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }

        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn existing_keyring_token_wins_and_stale_plaintext_is_scrubbed() {
        let path = temp_config("existing");
        fs::write(
            &path,
            r#"{"token":"stale-plaintext","login":"octocat","gist_id":"gist-1"}"#,
        )
        .unwrap();
        let store = FakeStore::with_token("profile-a", "keyring-token");

        let (_, token) = load_config_from(&path, "profile-a", &store).unwrap();

        assert_eq!(token.as_deref(), Some("keyring-token"));
        let rewritten = fs::read_to_string(&path).unwrap();
        assert!(!rewritten.contains("stale-plaintext"));
        assert!(!rewritten.contains("keyring-token"));
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn empty_keyring_entry_does_not_replace_a_legacy_token() {
        let path = temp_config("empty-keyring");
        fs::write(&path, r#"{"token":"legacy-token"}"#).unwrap();
        let store = FakeStore::with_token("profile-a", "");

        let (_, token) = load_config_from(&path, "profile-a", &store).unwrap();

        assert_eq!(token.as_deref(), Some("legacy-token"));
        assert!(!fs::read_to_string(&path).unwrap().contains("legacy-token"));
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn failed_keyring_migration_preserves_the_legacy_file() {
        let path = temp_config("failure");
        let original = r#"{"token":"only-copy","login":"octocat"}"#;
        fs::write(&path, original).unwrap();
        let store = FakeStore {
            values: Mutex::new(HashMap::new()),
            fail_set: true,
        };

        let error = load_config_from(&path, "profile-a", &store).unwrap_err();

        assert!(error.starts_with("secure_store_unavailable:"));
        assert_eq!(fs::read_to_string(&path).unwrap(), original);
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn migration_is_profile_scoped_and_idempotent() {
        let path = temp_config("idempotent");
        fs::write(&path, r#"{"token":"profile-a-token"}"#).unwrap();
        let store = FakeStore::default();

        let (_, first) = load_config_from(&path, "profile-a", &store).unwrap();
        let (_, second) = load_config_from(&path, "profile-a", &store).unwrap();
        let (_, other) = load_config_from(&path, "profile-b", &store).unwrap();

        assert_eq!(first, second);
        assert_eq!(first.as_deref(), Some("profile-a-token"));
        assert!(other.is_none());
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }
}
