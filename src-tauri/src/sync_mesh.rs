use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::time::{timeout, Duration};

/// Small app icon embedded in the OAuth loopback landing page (`sync_mesh.rs`'s callback HTML) —
/// kept tiny deliberately (2.5 KB) since it is inlined as a base64 data URI in a Rust string
/// literal, unlike the larger marketing assets under `src/assets/`.
const ALETHE_ICON_BYTES: &[u8] = include_bytes!("../icons/32x32.png");

/// Home-screen mascot artwork, reused as an animated dot-flow backdrop on the same OAuth landing
/// page — the same asset the desktop app's `AsciiEffect` component renders on the Home view, but
/// driven here by a small self-contained canvas loop instead of importing that React component.
const ALETHE_FOX_BYTES: &[u8] = include_bytes!("../../src/assets/home-bg-right.png");

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderTreeNode {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size_bytes: u64,
    pub children: Vec<FolderTreeNode>,
    pub is_heavy: bool,
    #[serde(default)]
    pub is_essential: bool,
    #[serde(default)]
    pub category: String,
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

fn compute_folder_size(path: &Path, max_entries: usize) -> u64 {
    let mut total = 0u64;
    let mut count = 0;
    let mut stack = vec![path.to_path_buf()];
    while let Some(current) = stack.pop() {
        if let Ok(entries) = fs::read_dir(&current) {
            for entry in entries.flatten() {
                count += 1;
                if count > max_entries {
                    break;
                }
                if let Ok(meta) = entry.metadata() {
                    if meta.is_dir() {
                        stack.push(entry.path());
                    } else {
                        total = total.saturating_add(meta.len());
                    }
                }
            }
        }
    }
    total
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

    let heavy_dir_names: HashSet<&str> = [
        "node_modules",
        "target",
        "dist",
        "build",
        "out",
        "bin",
        "obj",
        ".next",
        ".nuxt",
        "venv",
        ".venv",
        "env",
        ".env",
        "__pycache__",
        ".git",
        ".turbo",
        ".gradle",
        "vendor",
        ".cache",
        "coverage",
    ]
    .into_iter()
    .collect();

    let heavy_file_extensions: HashSet<&str> = [
        ".exe", ".dll", ".so", ".dylib", ".zip", ".tar", ".gz", ".tgz", ".7z", ".rar",
        ".iso", ".bin", ".dmg", ".pkg", ".mp4", ".mkv", ".avi", ".mov", ".sqlite",
        ".sqlite3", ".db", ".apk", ".aab", ".ipa", ".jar", ".war", ".wasm", ".whl",
        ".pdb", ".cab", ".msi",
    ]
    .into_iter()
    .collect();

    let essential_file_names: HashSet<&str> = [
        "package.json",
        "package-lock.json",
        "pnpm-lock.yaml",
        "pnpm-workspace.yaml",
        "yarn.lock",
        "bun.lockb",
        "cargo.toml",
        "cargo.lock",
        "go.mod",
        "go.sum",
        "requirements.txt",
        "pyproject.toml",
        "poetry.lock",
        "pipfile",
        "pipfile.lock",
        "composer.json",
        "composer.lock",
        "pom.xml",
        "build.gradle",
        "build.gradle.kts",
        "settings.gradle",
        "settings.gradle.kts",
        "gemfile",
        "gemfile.lock",
        "cmakelists.txt",
        "makefile",
        "dockerfile",
        "docker-compose.yml",
        "docker-compose.yaml",
        "tsconfig.json",
        "vite.config.ts",
        "vite.config.js",
        "webpack.config.js",
        ".gitignore",
        ".gitattributes",
        ".editorconfig",
        ".env.example",
        ".env.template",
        ".env.sample",
        "readme.md",
        "license",
    ]
    .into_iter()
    .collect();

    let essential_extensions: HashSet<&str> = [
        ".ts", ".tsx", ".js", ".jsx", ".rs", ".go", ".py", ".c", ".cpp", ".h", ".hpp",
        ".java", ".kt", ".swift", ".cs", ".php", ".rb", ".proto", ".sql", ".prisma",
        ".graphql", ".gql", ".yaml", ".yml", ".toml", ".json", ".xml", ".html", ".css",
        ".scss", ".sass", ".less", ".md", ".svg",
    ]
    .into_iter()
    .collect();

    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        let Ok(meta) = entry.metadata() else { continue };
        let is_dir = meta.is_dir();
        let name_lower = name.to_lowercase();

        let is_heavy_dir = is_dir && heavy_dir_names.contains(name_lower.as_str());
        let is_heavy_ext = !is_dir && heavy_file_extensions.iter().any(|ext| name_lower.ends_with(ext));
        let is_env = name_lower.starts_with(".env");

        let rel_path = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/");

        let mut children = Vec::new();
        // Heavy generated directories are represented but never traversed deeply.
        if is_dir && !is_heavy_dir && max_depth > 1 {
            children = scan_project_folder_tree_core(root, &path, max_depth - 1);
        }

        let size_bytes = if is_dir {
            if !children.is_empty() {
                children.iter().map(|c| c.size_bytes).sum()
            } else {
                compute_folder_size(&path, 150)
            }
        } else {
            meta.len()
        };

        // Intelligent categorization:
        // 1. Essential files (lockfiles, manifests, source code, configs) MUST NEVER be classified as disposable heavy
        let is_essential = !is_heavy_dir
            && (essential_file_names.contains(name_lower.as_str())
                || (!is_dir && essential_extensions.iter().any(|ext| name_lower.ends_with(ext))));

        let category = if is_env && !name_lower.contains("example") && !name_lower.contains("sample") {
            "sensitive".to_string()
        } else if is_essential {
            "essential".to_string()
        } else if is_heavy_dir {
            "heavy_cache".to_string()
        } else if is_heavy_ext {
            "binary".to_string()
        } else if size_bytes >= 1_000_000 {
            "heavy_file".to_string()
        } else {
            "standard".to_string()
        };

        // Only mark as heavy if it's truly disposable cache/binary/sensitive AND NOT an essential build file
        let is_heavy = !is_essential
            && (is_heavy_dir
                || is_heavy_ext
                || is_env
                || (!is_dir && size_bytes >= 1_000_000)
                || (is_dir && size_bytes >= 5_000_000));

        nodes.push(FolderTreeNode {
            name,
            path: rel_path,
            is_dir,
            size_bytes,
            children,
            is_heavy,
            is_essential,
            category,
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
        // Without this file the project exists but its sync capability is unknown, and the
        // degraded behaviour shows up much later somewhere unrelated to project creation.
        if let Err(error) = fs::write(
            &sync_meta_file,
            serde_json::to_string_pretty(&meta).unwrap_or_default(),
        ) {
            crate::decide!(
                target: "sync.mesh",
                attempted = "write_sync_meta",
                outcome = Failed,
                because = "meta_write_failed",
                rule = "mesh.project.has_sync_meta",
                evidence = { error = %error },
            );
        }
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

/// Lists the checkpoints currently sitting in a project's archive vault, newest first — the vault
/// UI previously tracked "how many backups exist" as client-side local state that started at a
/// hardcoded `3` and only ever incremented, never reflecting what was actually on disk.
pub fn list_project_backup_vault(project_root: &Path) -> Result<Vec<BackupArchiveEntry>, String> {
    let archive_dir = project_root.join(".alethe").join("backups").join("archive");
    if !archive_dir.is_dir() {
        return Ok(Vec::new());
    }

    let mut entries = Vec::new();
    for entry in fs::read_dir(&archive_dir).map_err(|e| e.to_string())?.flatten() {
        let path = entry.path();
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        let Ok(payload) = fs::read(&path) else { continue };
        let sha256 = Sha256::digest(&payload)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        let created_at = meta
            .created()
            .or_else(|_| meta.modified())
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);

        entries.push(BackupArchiveEntry {
            filename: entry.file_name().to_string_lossy().into_owned(),
            path: path.to_string_lossy().into_owned(),
            created_at,
            size_bytes: meta.len(),
            sha256,
        });
    }

    entries.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(entries)
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
                    crate::best_effort!(fs::remove_file(entry.path()), "stale_entry_already_gone");
                    count += 1;
                }
            }
        }
    }

    Ok(count)
}

#[tauri::command]
pub async fn scan_project_folder_tree(project_path: String) -> Result<Vec<FolderTreeNode>, String> {
    tokio::task::spawn_blocking(move || {
        let root = Path::new(&project_path);
        if !root.is_dir() {
            return Err("project_path_not_found".to_string());
        }
        Ok(scan_project_folder_tree_core(root, root, 4))
    })
    .await
    .map_err(|e| format!("scan_folder_tree_task_failed: {e}"))?
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
pub fn list_project_backups(project_path: String) -> Result<Vec<BackupArchiveEntry>, String> {
    let root = Path::new(&project_path);
    list_project_backup_vault(root)
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
/// Credential-store account name for the Google OAuth client secret. Unlike a real per-user
/// secret, Google's own "Desktop app" credential type still issues (and its token endpoint still
/// validates) a client secret even though Google's docs describe it as "not treated as
/// confidential" for installed apps — it ships baked into every copy of the app. Alethe stores it
/// in the OS keyring anyway rather than plaintext, as the more conservative default.
const GOOGLE_CLIENT_SECRET_ACCOUNT: &str = "oauth-client-secret";

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

/// Google's "Desktop app" OAuth client type still issues a client secret and its token endpoint
/// still validates it, even though PKCE is also used — a real quirk of Google's implementation,
/// not a mistake in how the client is configured. `None` when unset, so the token exchange simply
/// omits the field (matching the original assumption before this was discovered).
fn google_client_secret() -> Option<String> {
    if let Ok(value) = std::env::var("ALETHE_GOOGLE_CLIENT_SECRET") {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    let entry = keyring::Entry::new(GOOGLE_TOKEN_SERVICE, GOOGLE_CLIENT_SECRET_ACCOUNT).ok()?;
    let secret = entry.get_password().ok()?;
    let trimmed = secret.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

#[tauri::command]
pub fn configure_google_sync(
    app: tauri::AppHandle,
    client_id: String,
    client_secret: Option<String>,
) -> Result<bool, String> {
    let data_root = crate::profiles::resolve_tauri_data_root(&app)?;
    persist_google_config_at(&data_root, &client_id)?;
    match client_secret.as_deref().map(str::trim) {
        Some(secret) if !secret.is_empty() => {
            let entry = keyring::Entry::new(GOOGLE_TOKEN_SERVICE, GOOGLE_CLIENT_SECRET_ACCOUNT)
                .map_err(|_| "credential_store_unavailable".to_string())?;
            entry
                .set_password(secret)
                .map_err(|_| "credential_store_write_failed".to_string())?;
        }
        _ => {
            // An empty/omitted secret explicitly clears any previously stored one, so switching
            // back to a client that does not need one does not silently keep sending a stale
            // secret for the new client_id.
            if let Ok(entry) = keyring::Entry::new(GOOGLE_TOKEN_SERVICE, GOOGLE_CLIENT_SECRET_ACCOUNT) {
                crate::best_effort!(entry.delete_credential(), "credential_already_absent");
            }
        }
    }
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
    id_token: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GoogleUserInfo {
    sub: String,
    name: String,
    email: Option<String>,
    email_verified: Option<bool>,
    picture: Option<String>,
}

const GOOGLE_JWKS_URL: &str = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISSUERS: &[&str] = &["https://accounts.google.com", "accounts.google.com"];
/// How far into the future an `iat` claim may reasonably sit to account for clock skew between
/// this machine and Google's token servers. Anything further out than this is rejected rather
/// than silently trusted.
const ID_TOKEN_MAX_ISSUED_AT_SKEW_SECS: i64 = 300;

#[derive(Debug, Deserialize)]
struct GoogleJwks {
    keys: Vec<GoogleJwk>,
}

#[derive(Debug, Deserialize)]
struct GoogleJwk {
    kid: String,
    n: String,
    e: String,
    #[serde(default)]
    alg: Option<String>,
}

#[derive(Debug, PartialEq, Deserialize)]
struct GoogleIdTokenClaims {
    // `iss`/`aud` are never read directly after decoding: jsonwebtoken's `Validation` checks
    // them against `validation.set_issuer`/`set_audience` during `decode`, which requires them
    // to be present on the deserialized claims type.
    #[allow(dead_code)]
    iss: String,
    #[allow(dead_code)]
    aud: String,
    sub: String,
    exp: i64,
    iat: i64,
    nonce: Option<String>,
    email: Option<String>,
    email_verified: Option<bool>,
}

async fn fetch_google_jwks() -> Result<GoogleJwks, String> {
    let response = reqwest::Client::new()
        .get(GOOGLE_JWKS_URL)
        .send()
        .await
        .map_err(|_| "google_jwks_fetch_failed".to_string())?;
    if !response.status().is_success() {
        return Err("google_jwks_fetch_failed".to_string());
    }
    response
        .json::<GoogleJwks>()
        .await
        .map_err(|_| "google_jwks_fetch_failed".to_string())
}

/// Verifies a Google ID token's RS256 signature against the supplied JWKS and validates issuer,
/// audience, expiry, issued-at skew, and nonce. Pure and network-free so it can be unit tested
/// with a locally generated RSA keypair standing in for Google's signing key.
fn verify_google_id_token(
    id_token: &str,
    jwks: &GoogleJwks,
    expected_client_id: &str,
    expected_nonce: &str,
    now_secs: i64,
) -> Result<GoogleIdTokenClaims, String> {
    use jsonwebtoken::{decode, decode_header, Algorithm, DecodingKey, Validation};

    let header = decode_header(id_token).map_err(|_| "google_id_token_invalid".to_string())?;
    let kid = header.kid.ok_or_else(|| "google_id_token_invalid".to_string())?;
    let jwk = jwks
        .keys
        .iter()
        .find(|key| key.kid == kid)
        .ok_or_else(|| "google_id_token_key_unknown".to_string())?;
    if jwk.alg.as_deref().is_some_and(|alg| alg != "RS256") {
        return Err("google_id_token_invalid".to_string());
    }
    let decoding_key = DecodingKey::from_rsa_components(&jwk.n, &jwk.e)
        .map_err(|_| "google_id_token_key_invalid".to_string())?;

    let mut validation = Validation::new(Algorithm::RS256);
    validation.set_audience(&[expected_client_id]);
    validation.set_issuer(GOOGLE_ISSUERS);
    validation.leeway = 0;
    // Expiry/issued-at are re-validated below against the caller-supplied `now_secs` rather than
    // jsonwebtoken's own wall-clock read, so the whole function stays deterministic and testable
    // the same way the rest of this codebase threads an explicit `now_ms` instead of reading
    // `SystemTime::now()` deep inside a library call.
    validation.validate_exp = false;

    let decoded = decode::<GoogleIdTokenClaims>(id_token, &decoding_key, &validation)
        .map_err(|_| "google_id_token_invalid".to_string())?;
    let claims = decoded.claims;

    if claims.exp < now_secs {
        return Err("google_id_token_expired".to_string());
    }
    if claims.iat > now_secs + ID_TOKEN_MAX_ISSUED_AT_SKEW_SECS {
        return Err("google_id_token_issued_in_future".to_string());
    }
    if claims.nonce.as_deref() != Some(expected_nonce) {
        return Err("google_id_token_nonce_mismatch".to_string());
    }
    if claims.email_verified != Some(true) {
        return Err("google_identity_unverified".to_string());
    }
    Ok(claims)
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

/// Best-effort human-readable name for this machine, used to label the device in the mesh.
///
/// `HOSTNAME` looks like the obvious Unix counterpart to Windows' `COMPUTERNAME`, but it is a
/// variable Bash maintains for itself and does not export — so reading it from a GUI-launched
/// process fails on Linux and macOS essentially always. Relying on it alone meant every non-Windows
/// device silently registered under the generic fallback name, with nothing logged and no way for
/// the user to tell their own machines apart in the device list. `/etc/hostname` is the value that
/// is actually readable here.
fn local_device_name() -> String {
    if let Ok(name) = std::env::var("COMPUTERNAME") {
        if !name.trim().is_empty() {
            return name.trim().to_string();
        }
    }
    #[cfg(unix)]
    if let Ok(contents) = std::fs::read_to_string("/etc/hostname") {
        let name = contents.trim();
        if !name.is_empty() {
            return name.to_string();
        }
    }
    if let Ok(name) = std::env::var("HOSTNAME") {
        if !name.trim().is_empty() {
            return name.trim().to_string();
        }
    }
    "Alethe device".to_string()
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
    // Every step below logs only its outcome (step name, HTTP status when relevant, error code) —
    // never a token, code, or client secret — to `spawn.log`, so a login that silently fails to
    // leave the app "connected" can actually be diagnosed instead of just disappearing.
    let log = |message: &str| {
        // The comment above promises these lines make a silent login failure diagnosable. Discarding
        // the write meant the promise could quietly not hold, on exactly the run being diagnosed.
        crate::best_effort!(
            crate::diagnostics::append_spawn_log(&app, &format!("[google_sync_auth] {message}")),
            "spawn_log_unavailable"
        );
    };
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
    // Branded loopback landing page, styled after the app's own home-screen greeting/terminal
    // aesthetic. Sent before the token exchange even starts, so it can only ever say "you're
    // being signed in" — not "success", since failure can still happen later in this same
    // function. `window.close()` is attempted but frequently a no-op (most browsers only allow a
    // script to close a tab it opened itself, not one opened by the OS default handler), so the
    // page always shows a manual "you can close this tab" instruction too rather than relying on
    // the auto-close silently working.
    let icon_data_uri = format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(ALETHE_ICON_BYTES)
    );
    let fox_data_uri = format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(ALETHE_FOX_BYTES)
    );
    let body = format!(
        r##"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Alethe</title>
<meta name="color-scheme" content="dark">
<style>
  :root {{ color-scheme: dark; }}
  * {{ box-sizing: border-box; }}
  html, body {{
    margin: 0;
    height: 100%;
    background: #101114;
    color: #f3f4f6;
    font-family: -apple-system, "Segoe UI", Inter, Roboto, sans-serif;
    overflow: hidden;
  }}
  #fox {{
    position: fixed;
    inset: 0;
    z-index: 0;
    opacity: 0.85;
    -webkit-mask-image: linear-gradient(to bottom, black 0%, black 70%, transparent 100%);
    mask-image: linear-gradient(to bottom, black 0%, black 70%, transparent 100%);
  }}
  .page {{
    position: relative;
    z-index: 1;
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 22px;
  }}
  .brand {{
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
  }}
  .brand img {{ width: 32px; height: 32px; border-radius: 8px; }}
  h1 {{ font-size: 17px; font-weight: 650; margin: 0; letter-spacing: -0.01em; }}
  .subtitle {{ font-size: 12px; color: #6b6b75; margin: 0; }}
  .window {{
    width: 340px;
    border-radius: 10px;
    background: rgba(26, 28, 31, 0.92);
    backdrop-filter: blur(6px);
    border: 1px solid #2a2d33;
    overflow: hidden;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.45);
  }}
  .titlebar {{
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 9px 12px;
    background: #17181b;
    border-bottom: 1px solid #2a2d33;
  }}
  .dot {{ width: 9px; height: 9px; border-radius: 50%; }}
  .dot.red {{ background: #ef4444; }}
  .dot.yellow {{ background: #f59e0b; }}
  .dot.green {{ background: #10b981; }}
  .titlebar span {{
    margin-left: 6px;
    font-size: 10.5px;
    color: #6b6b75;
    font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
  }}
  .terminal {{
    padding: 16px 14px;
    font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
    font-size: 12px;
    line-height: 1.7;
  }}
  .terminal .muted {{ color: #6b6b75; }}
  .terminal .ok {{ color: #10b981; }}
  .terminal .row {{ display: flex; align-items: center; gap: 8px; }}
  .spinner {{
    width: 11px;
    height: 11px;
    border-radius: 50%;
    border: 2px solid #2a2d33;
    border-top-color: #10b981;
    animation: spin 0.8s linear infinite;
  }}
  @keyframes spin {{ to {{ transform: rotate(360deg); }} }}
  .hint {{ font-size: 11.5px; color: #6b6b75; text-align: center; max-width: 300px; }}
</style>
</head>
<body>
  <canvas id="fox"></canvas>
  <div class="page">
    <div class="brand">
      <img src="{icon_data_uri}" alt="Alethe" />
      <h1>Alethe</h1>
      <p class="subtitle">Reveal the state of every agent, shell, and project.</p>
    </div>
    <div class="window">
      <div class="titlebar">
        <span class="dot red"></span>
        <span class="dot yellow"></span>
        <span class="dot green"></span>
        <span>alethe@auth:~</span>
      </div>
      <div class="terminal">
        <div class="muted">$ google sign-in --account</div>
        <div class="row ok"><span>✓</span><span>authorization received</span></div>
        <div class="row"><span class="spinner" aria-hidden="true"></span><span class="muted">finishing setup in the app…</span></div>
      </div>
    </div>
    <p class="hint">You can close this tab and go back to Alethe.</p>
  </div>
  <script>
    window.close();
    // Lightweight ASCII/dot flow rendering of the app's own fox artwork — the same motif as the
    // desktop app's home screen, reduced to a small self-contained canvas loop (no dependency on
    // the full AsciiEffect engine, which is a React/canvas component this static loopback page
    // cannot import) since this page is only ever seen for a couple of seconds during sign-in.
    (function () {{
      var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      var canvas = document.getElementById('fox');
      var ctx = canvas.getContext('2d');
      var image = new Image();
      var cell = 8;
      var cols = 0, rows = 0, luminance = null;
      var offscreen = document.createElement('canvas');
      var octx = offscreen.getContext('2d', {{ willReadFrequently: true }});

      function layout() {{
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
        if (!image.complete || !image.naturalWidth) return;
        cols = Math.ceil(canvas.width / cell);
        rows = Math.ceil(canvas.height / cell);
        offscreen.width = cols;
        offscreen.height = rows;
        var scale = Math.max(cols / image.naturalWidth, rows / image.naturalHeight);
        var drawW = image.naturalWidth * scale;
        var drawH = image.naturalHeight * scale;
        octx.clearRect(0, 0, cols, rows);
        octx.drawImage(image, (cols - drawW) / 2, 0, drawW, drawH);
        var data = octx.getImageData(0, 0, cols, rows).data;
        luminance = new Float32Array(cols * rows);
        for (var i = 0; i < cols * rows; i++) {{
          var r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2], a = data[i * 4 + 3];
          luminance[i] = a > 8 ? (0.299 * r + 0.587 * g + 0.114 * b) / 255 : 0;
        }}
      }}

      function frame(t) {{
        if (luminance) {{
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.fillStyle = '#8b8b95';
          for (var y = 0; y < rows; y++) {{
            for (var x = 0; x < cols; x++) {{
              var base = luminance[y * cols + x];
              if (base <= 0.03) continue;
              var wave = reduceMotion ? 0 : 0.14 * Math.sin(x * 0.35 + y * 0.5 + t * 0.0016);
              var value = Math.max(0, Math.min(1, base + wave));
              if (value <= 0.05) continue;
              var radius = (cell * 0.32) * value;
              ctx.globalAlpha = 0.55 + value * 0.45;
              ctx.beginPath();
              ctx.arc(x * cell + cell / 2, y * cell + cell / 2, radius, 0, Math.PI * 2);
              ctx.fill();
            }}
          }}
          ctx.globalAlpha = 1;
        }}
        if (!reduceMotion) requestAnimationFrame(frame);
      }}

      image.onload = function () {{
        layout();
        requestAnimationFrame(frame);
      }};
      window.addEventListener('resize', layout);
      image.src = "{fox_data_uri}";
    }})();
  </script>
</body>
</html>"##
    );
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    // The browser tab is waiting on this response. If it never arrives the tab hangs on a blank
    // page while the sign-in actually succeeded, which reads as "the login froze".
    if let Err(error) = stream.write_all(response.as_bytes()).await {
        crate::decide!(
            target: "sync.mesh",
            attempted = "oauth_callback_response",
            outcome = Failed,
            because = "callback_write_failed",
            rule = "mesh.oauth.closes_the_browser_tab",
            evidence = { error = %error },
        );
    }
    let code = code?;

    log("callback received, exchanging code for tokens");
    let client_secret = google_client_secret();
    if client_secret.is_some() {
        log("using a stored client secret for the token exchange (Google Desktop client quirk)");
    }
    let mut token_form = vec![
        ("client_id", client_id.as_str()),
        ("code", code.as_str()),
        ("code_verifier", verifier.as_str()),
        ("grant_type", "authorization_code"),
        ("redirect_uri", redirect_uri.as_str()),
    ];
    if let Some(secret) = client_secret.as_deref() {
        token_form.push(("client_secret", secret));
    }
    let client = reqwest::Client::new();
    let token_response = client
        .post(GOOGLE_TOKEN_URL)
        .form(&token_form)
        .send()
        .await
        .map_err(|error| {
            log(&format!("token exchange request failed to send: {error}"));
            "google_oauth_exchange_failed".to_string()
        })?;
    let token_status = token_response.status();
    if !token_status.is_success() {
        // Google's token-error body only ever contains an OAuth error code/description
        // (e.g. `{"error":"redirect_uri_mismatch"}`) — never a token or secret — so it is safe
        // to log verbatim and is the only way to tell "wrong client type" apart from "expired
        // code" apart from "redirect URI not allowed" instead of guessing from the status alone.
        let body = token_response.text().await.unwrap_or_default();
        log(&format!("token exchange rejected by Google: HTTP {token_status} body={body}"));
        return Err("google_oauth_exchange_failed".to_string());
    }
    let tokens: GoogleTokenResponse = token_response.json().await.map_err(|error| {
        log(&format!("token exchange response was not the expected JSON shape: {error}"));
        "google_oauth_exchange_failed".to_string()
    })?;
    if !tokens.token_type.eq_ignore_ascii_case("bearer") || tokens.access_token.is_empty() {
        log("token exchange succeeded but returned no usable bearer access token");
        return Err("google_oauth_exchange_failed".to_string());
    }
    log("tokens received, fetching profile");
    let user_response = client
        .get(GOOGLE_USERINFO_URL)
        .bearer_auth(&tokens.access_token)
        .send()
        .await
        .map_err(|error| {
            log(&format!("userinfo request failed to send: {error}"));
            "google_userinfo_failed".to_string()
        })?;
    let user_status = user_response.status();
    if !user_status.is_success() {
        log(&format!("userinfo request rejected by Google: HTTP {user_status}"));
        return Err("google_userinfo_failed".to_string());
    }
    let user: GoogleUserInfo = user_response.json().await.map_err(|error| {
        log(&format!("userinfo response was not the expected JSON shape: {error}"));
        "google_userinfo_failed".to_string()
    })?;
    if user.sub.is_empty() || user.name.is_empty() || user.email_verified != Some(true) {
        log("userinfo missing required fields or email not verified");
        return Err("google_identity_unverified".to_string());
    }

    // The UserInfo endpoint alone does not prove issuer/audience/nonce; the ID token is the
    // signed, verifiable identity assertion. Google always returns one for an `openid`-scoped
    // authorization_code exchange.
    let id_token = tokens.id_token.as_deref().ok_or_else(|| {
        log("token response had no id_token (unexpected for an openid-scoped exchange)");
        "google_id_token_missing".to_string()
    })?;
    log("profile received, verifying signed ID token");
    let jwks = fetch_google_jwks().await.map_err(|error| {
        log(&format!("failed to fetch Google's signing keys: {error}"));
        error
    })?;
    let now_secs = (crate::provider_common::now_ms() / 1000) as i64;
    let claims = verify_google_id_token(id_token, &jwks, &client_id, &nonce, now_secs).map_err(|error| {
        log(&format!("ID token verification failed: {error}"));
        error
    })?;
    if claims.sub != user.sub {
        log("ID token subject does not match userinfo subject");
        return Err("google_identity_unverified".to_string());
    }
    if claims.email.as_deref() != user.email.as_deref() {
        log("ID token email does not match userinfo email");
        return Err("google_identity_unverified".to_string());
    }

    log("identity verified, persisting device and account");
    store_google_tokens(&user.sub, &tokens)?;
    let device_name = local_device_name();
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
        log(&format!("complete_verified_identity failed, rolling back stored tokens: {error}"));
        if let Ok(entry) = keyring::Entry::new(GOOGLE_TOKEN_SERVICE, &user.sub) {
            crate::best_effort!(entry.delete_credential(), "credential_already_absent");
        }
        return Err(error);
    }
    log("sign-in complete, account is now connected");
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
        crate::best_effort!(fs::remove_file(&auth_file), "auth_file_already_absent");
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

    /// Guards the Linux/macOS path specifically: `HOSTNAME` is not exported to a GUI-launched
    /// process, so a name must still be resolved without it. Before the `/etc/hostname` fallback,
    /// every non-Windows device silently registered as the generic placeholder.
    #[cfg(unix)]
    #[test]
    fn device_name_resolves_on_unix_without_the_hostname_variable() {
        if !std::path::Path::new("/etc/hostname").exists() {
            return; // nothing to assert against on a host without it
        }
        let expected = std::fs::read_to_string("/etc/hostname").unwrap().trim().to_string();
        if expected.is_empty() || std::env::var("COMPUTERNAME").is_ok() {
            return;
        }
        assert_eq!(local_device_name(), expected);
        assert_ne!(local_device_name(), "Alethe device");
    }

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

        crate::best_effort!(fs::remove_dir_all(base), "test_dir_already_absent");
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

        crate::best_effort!(fs::remove_dir_all(root), "test_dir_already_absent");
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

        crate::best_effort!(fs::remove_dir_all(root), "test_dir_already_absent");
    }

    // Test-only RSA keypair standing in for Google's rotating JWKS signing key. Never used for
    // anything but signing/verifying fixture ID tokens in this test module.
    const TEST_RSA_PRIVATE_KEY_PEM: &str = include_str!("../tests/fixtures/test_rsa_private.pem");
    const TEST_RSA_N: &str = "rOQDhhgmin3WLxGu1YdEYENKbFkjNQ1N86K_eFmdskAyD-gX1vvjX1Qp8GelClMSvGJcOkifHcgOz9nYp0e3nyi98i4MV2znOQRBcZnff0e_WkaMVyb6Y-_dnTA62wNDSnN_6_A-Mtnh3O4kqUqbMghhYVCzvz7GNmU3gSxb_iq6r9FJb1g-7CKa1AmoEcq6c7QDNbp_ihXSQlkx2W_eoNqijbkvhDlBt5LXE75la1P-_8a_UDtCg613XqiRrp8_csyQLoaiS_VBEuBwHnHkvxYybC4hqUR3fNncul8S6X37DWe0Z010G3PXiwA9duLsUp1X6OPS-71CPkCZAfmDVw";
    const TEST_RSA_E: &str = "AQAB";

    #[derive(serde::Serialize, Clone)]
    struct TestClaims<'a> {
        iss: &'a str,
        aud: &'a str,
        sub: &'a str,
        exp: i64,
        iat: i64,
        nonce: &'a str,
        email: &'a str,
        email_verified: bool,
    }

    fn sign_test_id_token(claims: &TestClaims) -> String {
        use jsonwebtoken::{encode, EncodingKey, Header};
        let mut header = Header::new(jsonwebtoken::Algorithm::RS256);
        header.kid = Some("test-key".to_string());
        let key = EncodingKey::from_rsa_pem(TEST_RSA_PRIVATE_KEY_PEM.as_bytes()).unwrap();
        encode(&header, claims, &key).unwrap()
    }

    fn test_jwks() -> GoogleJwks {
        GoogleJwks {
            keys: vec![GoogleJwk {
                kid: "test-key".to_string(),
                n: TEST_RSA_N.to_string(),
                e: TEST_RSA_E.to_string(),
                alg: Some("RS256".to_string()),
            }],
        }
    }

    #[test]
    fn verify_google_id_token_accepts_a_valid_token() {
        let now = 1_000_000_i64;
        let token = sign_test_id_token(&TestClaims {
            iss: "https://accounts.google.com",
            aud: "client.apps.googleusercontent.com",
            sub: "sub-123",
            exp: now + 3_600,
            iat: now,
            nonce: "nonce-abc",
            email: "person@example.com",
            email_verified: true,
        });
        let claims = verify_google_id_token(
            &token,
            &test_jwks(),
            "client.apps.googleusercontent.com",
            "nonce-abc",
            now,
        )
        .unwrap();
        assert_eq!(claims.sub, "sub-123");
    }

    #[test]
    fn verify_google_id_token_rejects_wrong_audience_issuer_nonce_and_expiry() {
        let now = 1_000_000_i64;
        let base = TestClaims {
            iss: "https://accounts.google.com",
            aud: "client.apps.googleusercontent.com",
            sub: "sub-123",
            exp: now + 3_600,
            iat: now,
            nonce: "nonce-abc",
            email: "person@example.com",
            email_verified: true,
        };

        let wrong_audience = sign_test_id_token(&TestClaims {
            aud: "someone-elses-client.apps.googleusercontent.com",
            ..base.clone()
        });
        assert!(verify_google_id_token(
            &wrong_audience,
            &test_jwks(),
            "client.apps.googleusercontent.com",
            "nonce-abc",
            now
        )
        .is_err());

        let wrong_issuer = sign_test_id_token(&TestClaims {
            iss: "https://evil.example.com",
            ..base.clone()
        });
        assert!(verify_google_id_token(
            &wrong_issuer,
            &test_jwks(),
            "client.apps.googleusercontent.com",
            "nonce-abc",
            now
        )
        .is_err());

        let wrong_nonce = sign_test_id_token(&TestClaims {
            nonce: "different-nonce",
            ..base.clone()
        });
        assert_eq!(
            verify_google_id_token(
                &wrong_nonce,
                &test_jwks(),
                "client.apps.googleusercontent.com",
                "nonce-abc",
                now
            ),
            Err("google_id_token_nonce_mismatch".to_string())
        );

        let expired = sign_test_id_token(&TestClaims {
            exp: now - 10,
            ..base.clone()
        });
        assert!(verify_google_id_token(
            &expired,
            &test_jwks(),
            "client.apps.googleusercontent.com",
            "nonce-abc",
            now
        )
        .is_err());

        let unverified_email = sign_test_id_token(&TestClaims {
            email_verified: false,
            ..base.clone()
        });
        assert_eq!(
            verify_google_id_token(
                &unverified_email,
                &test_jwks(),
                "client.apps.googleusercontent.com",
                "nonce-abc",
                now
            ),
            Err("google_identity_unverified".to_string())
        );
    }

    #[test]
    fn verify_google_id_token_rejects_an_unknown_signing_key() {
        let now = 1_000_000_i64;
        let token = sign_test_id_token(&TestClaims {
            iss: "https://accounts.google.com",
            aud: "client.apps.googleusercontent.com",
            sub: "sub-123",
            exp: now + 3_600,
            iat: now,
            nonce: "nonce-abc",
            email: "person@example.com",
            email_verified: true,
        });
        let empty_jwks = GoogleJwks { keys: vec![] };
        assert_eq!(
            verify_google_id_token(
                &token,
                &empty_jwks,
                "client.apps.googleusercontent.com",
                "nonce-abc",
                now
            ),
            Err("google_id_token_key_unknown".to_string())
        );
    }
}
