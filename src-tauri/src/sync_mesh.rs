use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::time::{timeout, Duration};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderTreeNode {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size_bytes: u64,
    pub children: Vec<FolderTreeNode>,
    pub is_heavy: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupArchiveEntry {
    pub filename: String,
    pub path: String,
    pub created_at: u64,
    pub size_bytes: u64,
    pub sha256: String,
}

/// Scans project folders for the explicit selection UI.
pub fn scan_project_folder_tree_core(
    root: &Path,
    current: &Path,
    max_depth: usize,
) -> Vec<FolderTreeNode> {
    if max_depth == 0 || !current.is_dir() {
        return Vec::new();
    }

    let mut nodes = Vec::new();
    let Ok(entries) = fs::read_dir(current) else {
        return nodes;
    };

    let heavy_names: HashSet<&str> = [
        "node_modules",
        "target",
        "dist",
        "build",
        ".next",
        "venv",
        ".venv",
        "__pycache__",
        ".git",
    ]
    .into_iter()
    .collect();

    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        let Ok(meta) = entry.metadata() else { continue };
        let is_dir = meta.is_dir();
        let is_heavy = heavy_names.contains(name.as_str()) || name.starts_with(".env");

        let rel_path = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/");

        let mut children = Vec::new();
        // Heavy generated directories are represented but never traversed.
        if is_dir && !is_heavy && max_depth > 1 {
            children = scan_project_folder_tree_core(root, &path, max_depth - 1);
        }

        nodes.push(FolderTreeNode {
            name,
            path: rel_path,
            is_dir,
            size_bytes: if is_dir { 0 } else { meta.len() },
            children,
            is_heavy,
        });
    }

    nodes.sort_by(|a, b| {
        if a.is_dir == b.is_dir {
            a.name.cmp(&b.name)
        } else if a.is_dir {
            std::cmp::Ordering::Less
        } else {
            std::cmp::Ordering::Greater
        }
    });

    nodes
}

/// Applies the hidden-file attribute on Windows.
pub fn ensure_hidden_folder_windows(path: &Path) -> Result<(), String> {
    if !path.exists() {
        fs::create_dir_all(path).map_err(|e| format!("Failed to create folder: {e}"))?;
    }

    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        let wide: Vec<u16> = path
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        unsafe {
            const FILE_ATTRIBUTE_HIDDEN: u32 = 0x00000002;
            windows_sys::Win32::Storage::FileSystem::SetFileAttributesW(
                wide.as_ptr(),
                FILE_ATTRIBUTE_HIDDEN,
            );
        }
    }

    Ok(())
}

/// Creates an isolated project subfolder and local metadata directories.
pub fn init_project_sync_root(base_dir: &Path, project_name: &str) -> Result<PathBuf, String> {
    let sanitized_name =
        project_name.replace(|c: char| !c.is_alphanumeric() && c != '-' && c != '_', "_");
    let project_root = base_dir.join(&sanitized_name);

    if !project_root.is_dir() {
        fs::create_dir_all(&project_root)
            .map_err(|e| format!("Failed to create the isolated project directory: {e}"))?;
    }

    let alethe_dir = project_root.join(".alethe");
    ensure_hidden_folder_windows(&alethe_dir)?;

    let plans_dir = alethe_dir.join("plans");
    let versions_dir = alethe_dir.join("versions");
    let archive_dir = alethe_dir.join("backups").join("archive");

    fs::create_dir_all(plans_dir).map_err(|e| e.to_string())?;
    fs::create_dir_all(versions_dir).map_err(|e| e.to_string())?;
    fs::create_dir_all(archive_dir).map_err(|e| e.to_string())?;

    let sync_meta_file = alethe_dir.join("sync.json");
    if !sync_meta_file.exists() {
        let meta = serde_json::json!({
            "projectName": project_name,
            "createdAt": SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs(),
            "p2pEnabled": false,
            "syncCapability": "unavailable",
            "version": 1
        });
        let _ = fs::write(
            &sync_meta_file,
            serde_json::to_string_pretty(&meta).unwrap_or_default(),
        );
    }

    Ok(project_root)
}

/// Creates a local metadata checkpoint, not a project-content or WORM backup.
pub fn create_project_archive_backup(
    project_root: &Path,
    project_name: &str,
) -> Result<BackupArchiveEntry, String> {
    let alethe_dir = project_root.join(".alethe");
    let archive_dir = alethe_dir.join("backups").join("archive");
    fs::create_dir_all(&archive_dir)
        .map_err(|e| format!("Failed to create checkpoint folder: {e}"))?;

    let now_secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let sanitized_name =
        project_name.replace(|c: char| !c.is_alphanumeric() && c != '-' && c != '_', "_");
    let filename = format!("checkpoint_{sanitized_name}_{now_secs}.bin");
    let backup_path = archive_dir.join(&filename);

    // The legacy checkpoint contains metadata only; it never captures project content.
    let mut payload = Vec::new();
    payload.extend_from_slice(b"ALETHE_METADATA_CHECKPOINT_V1\n");
    payload.extend_from_slice(format!("PROJECT:{project_name}\nTIMESTAMP:{now_secs}\n").as_bytes());

    let mut file =
        File::create(&backup_path).map_err(|e| format!("Failed to create checkpoint: {e}"))?;
    file.write_all(&payload)
        .map_err(|e| format!("Failed to write checkpoint: {e}"))?;
    file.flush().map_err(|e| e.to_string())?;

    let size_bytes = payload.len() as u64;
    let sha256 = Sha256::digest(&payload)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();

    Ok(BackupArchiveEntry {
        filename,
        path: backup_path.to_string_lossy().into_owned(),
        created_at: now_secs,
        size_bytes,
        sha256,
    })
}

/// Manually deletes archived backups after confirming the exact project name.
pub fn purge_project_backup_vault(
    project_root: &Path,
    expected_project_name: &str,
    confirmation_name: &str,
) -> Result<usize, String> {
    if expected_project_name.trim() != confirmation_name.trim() {
        return Err("security_confirmation_name_mismatch".to_string());
    }

    let archive_dir = project_root.join(".alethe").join("backups").join("archive");
    if !archive_dir.is_dir() {
        return Ok(0);
    }

    let mut count = 0;
    if let Ok(entries) = fs::read_dir(&archive_dir) {
        for entry in entries.flatten() {
            if let Ok(meta) = entry.metadata() {
                if meta.is_file() {
                    let _ = fs::remove_file(entry.path());
                    count += 1;
                }
            }
        }
    }

    Ok(count)
}

#[tauri::command]
pub fn scan_project_folder_tree(project_path: String) -> Result<Vec<FolderTreeNode>, String> {
    let root = Path::new(&project_path);
    if !root.is_dir() {
        return Err("project_path_not_found".to_string());
    }
    Ok(scan_project_folder_tree_core(root, root, 4))
}

#[tauri::command]
pub fn setup_project_mesh_isolation(
    base_dir: String,
    project_name: String,
) -> Result<String, String> {
    let base = Path::new(&base_dir);
    let root = init_project_sync_root(base, &project_name)?;
    Ok(root.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn trigger_project_archive_backup(
    project_path: String,
    project_name: String,
) -> Result<BackupArchiveEntry, String> {
    let root = Path::new(&project_path);
    create_project_archive_backup(root, &project_name)
}

#[tauri::command]
pub fn purge_project_backups_secured(
    project_path: String,
    project_name: String,
    confirmation_name: String,
) -> Result<usize, String> {
    let root = Path::new(&project_path);
    purge_project_backup_vault(root, &project_name, &confirmation_name)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleSyncUser {
    pub email: String,
    pub name: String,
    pub picture: Option<String>,
    pub connected: bool,
    pub configured: bool,
    pub last_sync_ms: Option<u64>,
}

const GOOGLE_AUTHORIZE_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL: &str = "https://openidconnect.googleapis.com/v1/userinfo";
const GOOGLE_TOKEN_SERVICE: &str = "com.kc1t.alethe.google-oauth";
const GOOGLE_CONFIG_FILE: &str = "google-oauth.json";

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoogleOAuthConfig {
    client_id: String,
}

fn google_config_path(data_root: &Path) -> PathBuf {
    data_root.join("sync-security").join(GOOGLE_CONFIG_FILE)
}

fn valid_google_client_id(value: &str) -> bool {
    value.len() <= 512
        && value.ends_with(".apps.googleusercontent.com")
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

fn google_client_id(data_root: &Path) -> Option<String> {
    if let Ok(value) = std::env::var("ALETHE_GOOGLE_CLIENT_ID") {
        let value = value.trim();
        if valid_google_client_id(value) {
            return Some(value.to_string());
        }
    }
    let bytes = fs::read(google_config_path(data_root)).ok()?;
    let config: GoogleOAuthConfig = serde_json::from_slice(&bytes).ok()?;
    valid_google_client_id(&config.client_id).then_some(config.client_id)
}

#[tauri::command]
pub fn configure_google_sync(app: tauri::AppHandle, client_id: String) -> Result<bool, String> {
    let data_root = crate::profiles::resolve_tauri_data_root(&app)?;
    persist_google_config_at(&data_root, &client_id)?;
    Ok(true)
}

fn persist_google_config_at(data_root: &Path, client_id: &str) -> Result<(), String> {
    let client_id = client_id.trim();
    if !valid_google_client_id(client_id) {
        return Err("google_oauth_client_invalid".to_string());
    }
    let path = google_config_path(data_root);
    let parent = path
        .parent()
        .ok_or_else(|| "google_oauth_configuration_failed".to_string())?;
    fs::create_dir_all(parent).map_err(|_| "google_oauth_configuration_failed".to_string())?;
    let temporary = path.with_extension("json.tmp");
    let payload = serde_json::to_vec_pretty(&GoogleOAuthConfig {
        client_id: client_id.to_string(),
    })
    .map_err(|_| "google_oauth_configuration_failed".to_string())?;
    fs::write(&temporary, payload).map_err(|_| "google_oauth_configuration_failed".to_string())?;
    fs::rename(temporary, path).map_err(|_| "google_oauth_configuration_failed".to_string())?;
    Ok(())
}

#[derive(Debug, Deserialize)]
struct GoogleTokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: u64,
    scope: Option<String>,
    token_type: String,
}

#[derive(Debug, Deserialize)]
struct GoogleUserInfo {
    sub: String,
    name: String,
    email: Option<String>,
    email_verified: Option<bool>,
    picture: Option<String>,
}

fn random_base64_url(bytes: usize) -> String {
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use base64::Engine;
    use rand_core::RngCore;
    let mut value = vec![0_u8; bytes];
    rand_core::OsRng.fill_bytes(&mut value);
    URL_SAFE_NO_PAD.encode(value)
}

fn pkce_challenge(verifier: &str) -> String {
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use base64::Engine;
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

fn google_authorization_url(
    client_id: &str,
    redirect_uri: &str,
    state: &str,
    nonce: &str,
    challenge: &str,
) -> Result<String, String> {
    let mut url = url::Url::parse(GOOGLE_AUTHORIZE_URL)
        .map_err(|_| "google_oauth_configuration_invalid".to_string())?;
    url.query_pairs_mut()
        .append_pair("client_id", client_id)
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("response_type", "code")
        .append_pair("scope", "openid email profile")
        .append_pair("state", state)
        .append_pair("nonce", nonce)
        .append_pair("code_challenge", challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("access_type", "offline")
        .append_pair("prompt", "consent");
    Ok(url.into())
}

fn parse_oauth_callback(target: &str, expected_state: &str) -> Result<String, String> {
    let url = url::Url::parse(&format!("http://127.0.0.1{target}"))
        .map_err(|_| "google_oauth_callback_invalid".to_string())?;
    if url.path() != "/oauth/callback" {
        return Err("google_oauth_callback_invalid".to_string());
    }
    if url.query_pairs().any(|(key, _)| key == "error") {
        return Err("google_oauth_denied".to_string());
    }
    let states: Vec<_> = url
        .query_pairs()
        .filter(|(key, _)| key == "state")
        .map(|(_, value)| value.into_owned())
        .collect();
    let codes: Vec<_> = url
        .query_pairs()
        .filter(|(key, _)| key == "code")
        .map(|(_, value)| value.into_owned())
        .collect();
    if states.as_slice() != [expected_state] || codes.len() != 1 || codes[0].is_empty() {
        return Err("google_oauth_callback_invalid".to_string());
    }
    Ok(codes[0].clone())
}

fn email_hint(email: Option<&str>) -> Option<String> {
    let email = email?;
    let (local, domain) = email.split_once('@')?;
    let first = local.chars().next()?;
    Some(format!("{first}***@{domain}"))
}

fn store_google_tokens(account_id: &str, tokens: &GoogleTokenResponse) -> Result<(), String> {
    let entry = keyring::Entry::new(GOOGLE_TOKEN_SERVICE, account_id)
        .map_err(|_| "credential_store_unavailable".to_string())?;
    let payload = serde_json::json!({
        "accessToken": tokens.access_token,
        "refreshToken": tokens.refresh_token,
        "expiresIn": tokens.expires_in,
        "scope": tokens.scope,
        "tokenType": tokens.token_type,
    });
    entry
        .set_password(&payload.to_string())
        .map_err(|_| "credential_store_write_failed".to_string())
}

#[tauri::command]
pub async fn start_google_sync_auth(app: tauri::AppHandle) -> Result<GoogleSyncUser, String> {
    let current = get_google_sync_status(app.clone())?;
    if current.connected {
        return Ok(current);
    }
    let data_root = crate::profiles::resolve_tauri_data_root(&app)?;
    let client_id = google_client_id(&data_root)
        .ok_or_else(|| "google_oauth_client_not_configured".to_string())?;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|_| "google_oauth_loopback_unavailable".to_string())?;
    let port = listener
        .local_addr()
        .map_err(|_| "google_oauth_loopback_unavailable".to_string())?
        .port();
    let redirect_uri = format!("http://127.0.0.1:{port}/oauth/callback");
    let state = random_base64_url(32);
    let nonce = random_base64_url(32);
    let verifier = random_base64_url(64);
    let authorize_url = google_authorization_url(
        &client_id,
        &redirect_uri,
        &state,
        &nonce,
        &pkce_challenge(&verifier),
    )?;
    crate::diagnostics::open_in_browser(authorize_url)?;

    let (mut stream, _) = timeout(Duration::from_secs(180), listener.accept())
        .await
        .map_err(|_| "google_oauth_timeout".to_string())?
        .map_err(|_| "google_oauth_callback_failed".to_string())?;
    let mut request = vec![0_u8; 8_192];
    let read = timeout(Duration::from_secs(5), stream.read(&mut request))
        .await
        .map_err(|_| "google_oauth_callback_failed".to_string())?
        .map_err(|_| "google_oauth_callback_failed".to_string())?;
    let first_line = std::str::from_utf8(&request[..read])
        .ok()
        .and_then(|value| value.lines().next())
        .ok_or_else(|| "google_oauth_callback_invalid".to_string())?;
    let mut parts = first_line.split_whitespace();
    if parts.next() != Some("GET") {
        return Err("google_oauth_callback_invalid".to_string());
    }
    let code = parse_oauth_callback(
        parts
            .next()
            .ok_or_else(|| "google_oauth_callback_invalid".to_string())?,
        &state,
    );
    let body = "<!doctype html><title>Alethe</title><script>window.close()</script><p>Alethe</p>";
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes()).await;
    let code = code?;

    let client = reqwest::Client::new();
    let tokens = client
        .post(GOOGLE_TOKEN_URL)
        .form(&[
            ("client_id", client_id.as_str()),
            ("code", code.as_str()),
            ("code_verifier", verifier.as_str()),
            ("grant_type", "authorization_code"),
            ("redirect_uri", redirect_uri.as_str()),
        ])
        .send()
        .await
        .map_err(|_| "google_oauth_exchange_failed".to_string())?;
    if !tokens.status().is_success() {
        return Err("google_oauth_exchange_failed".to_string());
    }
    let tokens: GoogleTokenResponse = tokens
        .json()
        .await
        .map_err(|_| "google_oauth_exchange_failed".to_string())?;
    if !tokens.token_type.eq_ignore_ascii_case("bearer") || tokens.access_token.is_empty() {
        return Err("google_oauth_exchange_failed".to_string());
    }
    let user = client
        .get(GOOGLE_USERINFO_URL)
        .bearer_auth(&tokens.access_token)
        .send()
        .await
        .map_err(|_| "google_userinfo_failed".to_string())?;
    if !user.status().is_success() {
        return Err("google_userinfo_failed".to_string());
    }
    let user: GoogleUserInfo = user
        .json()
        .await
        .map_err(|_| "google_userinfo_failed".to_string())?;
    if user.sub.is_empty() || user.name.is_empty() || user.email_verified != Some(true) {
        return Err("google_identity_unverified".to_string());
    }
    store_google_tokens(&user.sub, &tokens)?;
    let device_name = std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "Alethe device".to_string());
    let now_ms = crate::provider_common::now_ms();
    if let Err(error) = crate::sync_security::complete_verified_identity(
        &data_root,
        &crate::sync_security::PlatformDeviceSecretStore,
        crate::sync_security::VerifiedAccount {
            account_id: user.sub.clone(),
            provider: "google".to_string(),
            display_name: user.name.clone(),
            email_hint: email_hint(user.email.as_deref()),
            connected_at_ms: now_ms,
        },
        &device_name,
        now_ms,
    ) {
        if let Ok(entry) = keyring::Entry::new(GOOGLE_TOKEN_SERVICE, &user.sub) {
            let _ = entry.delete_credential();
        }
        return Err(error);
    }
    Ok(GoogleSyncUser {
        email: email_hint(user.email.as_deref()).unwrap_or_default(),
        name: user.name,
        picture: user.picture,
        connected: true,
        configured: true,
        last_sync_ms: None,
    })
}

#[tauri::command]
pub fn get_google_sync_status(app: tauri::AppHandle) -> Result<GoogleSyncUser, String> {
    let root = crate::profiles::resolve_tauri_data_root(&app)?;
    let snapshot = crate::sync_security::snapshot_at(&root)?;
    let Some(account) = snapshot.account else {
        return Ok(GoogleSyncUser {
            email: String::new(),
            name: String::new(),
            picture: None,
            connected: false,
            configured: google_client_id(&root).is_some(),
            last_sync_ms: None,
        });
    };
    Ok(GoogleSyncUser {
        email: account.email_hint.unwrap_or_default(),
        name: account.display_name,
        picture: None,
        connected: true,
        configured: true,
        last_sync_ms: None,
    })
}

#[tauri::command]
pub fn disconnect_google_sync(app: tauri::AppHandle) -> Result<bool, String> {
    // Remove plaintext state written by prototype builds. It is never trusted as identity.
    if let Ok(data_dir) = crate::paths::profile_data_dir(&app) {
        let auth_file = data_dir.join("google_auth.json");
        let _ = fs::remove_file(&auth_file);
    }
    let root = crate::profiles::resolve_tauri_data_root(&app)?;
    let snapshot = crate::sync_security::snapshot_at(&root)?;
    if let Some(account) = snapshot.account {
        let entry = keyring::Entry::new(GOOGLE_TOKEN_SERVICE, &account.account_id)
            .map_err(|_| "credential_store_unavailable".to_string())?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(_) => return Err("credential_store_delete_failed".to_string()),
        }
    }
    crate::sync_security::disconnect_identity_at(
        &root,
        &crate::sync_security::PlatformDeviceSecretStore,
    )?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn oauth_authorization_uses_pkce_loopback_and_minimal_scopes() {
        let url = google_authorization_url(
            "client.apps.googleusercontent.com",
            "http://127.0.0.1:49152/oauth/callback",
            "state-a",
            "nonce-a",
            "challenge-a",
        )
        .unwrap();
        let url = url::Url::parse(&url).unwrap();
        let query: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(query.get("response_type").map(String::as_str), Some("code"));
        assert_eq!(
            query.get("scope").map(String::as_str),
            Some("openid email profile")
        );
        assert_eq!(
            query.get("code_challenge_method").map(String::as_str),
            Some("S256")
        );
        assert_eq!(query.get("state").map(String::as_str), Some("state-a"));
    }

    #[test]
    fn oauth_callback_rejects_wrong_state_errors_duplicates_and_routes() {
        assert_eq!(
            parse_oauth_callback("/oauth/callback?code=ok&state=expected", "expected"),
            Ok("ok".to_string())
        );
        for target in [
            "/oauth/callback?code=ok&state=wrong",
            "/oauth/callback?error=access_denied&state=expected",
            "/oauth/callback?code=a&code=b&state=expected",
            "/wrong?code=ok&state=expected",
        ] {
            assert!(parse_oauth_callback(target, "expected").is_err());
        }
    }

    #[test]
    fn identity_metadata_masks_email_addresses() {
        assert_eq!(
            email_hint(Some("person@example.com")),
            Some("p***@example.com".to_string())
        );
        assert_eq!(email_hint(Some("invalid")), None);
    }

    #[test]
    fn google_client_configuration_accepts_only_desktop_client_ids() {
        for invalid in [
            "",
            "client-secret",
            "https://example.apps.googleusercontent.com",
            "example.apps.googleusercontent.com/extra",
        ] {
            assert!(!valid_google_client_id(invalid));
        }
        assert!(valid_google_client_id(
            "123-example.apps.googleusercontent.com"
        ));

        let root = temp_test_dir("google-config");
        persist_google_config_at(&root, "123-example.apps.googleusercontent.com").unwrap();
        let stored: GoogleOAuthConfig =
            serde_json::from_slice(&fs::read(google_config_path(&root)).unwrap()).unwrap();
        assert_eq!(stored.client_id, "123-example.apps.googleusercontent.com");
        fs::remove_dir_all(root).unwrap();
    }

    fn temp_test_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("alethe-mesh-{name}-{}", nanoid::nanoid!(6)));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn test_init_project_sync_root_creates_subfolder_and_hidden_alethe() {
        let base = temp_test_dir("root_test");
        let project_name = "animego";

        let root = init_project_sync_root(&base, project_name).unwrap();
        assert_eq!(root, base.join("animego"));
        assert!(root.is_dir());

        let alethe = root.join(".alethe");
        assert!(alethe.is_dir());
        assert!(alethe.join("plans").is_dir());
        assert!(alethe.join("versions").is_dir());
        assert!(alethe.join("backups").join("archive").is_dir());
        assert!(alethe.join("sync.json").is_file());
        let metadata: serde_json::Value =
            serde_json::from_slice(&fs::read(alethe.join("sync.json")).unwrap()).unwrap();
        assert_eq!(metadata["p2pEnabled"], false);
        assert_eq!(metadata["syncCapability"], "unavailable");

        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn test_scan_folder_tree_identifies_heavy_folders() {
        let root = temp_test_dir("tree_test");
        fs::create_dir_all(root.join("src").join("components")).unwrap();
        fs::create_dir_all(root.join("node_modules").join("react")).unwrap();
        fs::write(root.join("src").join("main.rs"), "fn main() {}").unwrap();
        fs::write(root.join(".env.local"), "SECRET=123").unwrap();

        let nodes = scan_project_folder_tree_core(&root, &root, 3);
        let node_modules = nodes.iter().find(|n| n.name == "node_modules").unwrap();
        assert!(node_modules.is_heavy);
        assert!(node_modules.is_dir);

        let env_file = nodes.iter().find(|n| n.name == ".env.local").unwrap();
        assert!(env_file.is_heavy);

        let src = nodes.iter().find(|n| n.name == "src").unwrap();
        assert!(!src.is_heavy);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn test_create_and_purge_backup_vault_with_security_guard() {
        let root = temp_test_dir("backup_test");
        let project_name = "animego";

        let backup = create_project_archive_backup(&root, project_name).unwrap();
        assert!(Path::new(&backup.path).is_file());
        assert!(backup.filename.starts_with("checkpoint_animego_"));
        assert_eq!(backup.sha256.len(), 64);

        // An incorrect confirmation must not remove the checkpoint.
        let err = purge_project_backup_vault(&root, project_name, "wrong_name");
        assert!(err.is_err());
        assert!(Path::new(&backup.path).is_file());

        // The exact confirmation removes it.
        let deleted = purge_project_backup_vault(&root, project_name, project_name).unwrap();
        assert_eq!(deleted, 1);
        assert!(!Path::new(&backup.path).exists());

        let _ = fs::remove_dir_all(root);
    }
}
