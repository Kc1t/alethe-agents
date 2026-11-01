use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::AppHandle;
use zip::write::FileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use crate::paths::{activity_stats_file_path, app_data_dir};
use crate::profiles::profile_data_dir_for_id;

const MANIFEST_NAME: &str = "alethe-backup.json";
const MANIFEST_FORMAT: u32 = 1;
const IMAGE_FIELDS: &[&str] = &["iconUrl", "profileImageUrl"];
const MAX_EMBEDDED_IMAGE_BYTES: usize = 4 * 1024 * 1024;
const IMAGE_TIMEOUT: Duration = Duration::from_secs(15);
const IMAGE_USER_AGENT: &str = "Mozilla/5.0 (compatible; Alethe backup)";

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupExtras {
    #[serde(default)]
    local_storage: BTreeMap<String, String>,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupReport {
    skipped: Vec<String>,
    embedded_images: usize,
    image_links_kept: Vec<String>,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    local_storage: BTreeMap<String, String>,
    profile_name: Option<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupManifest {
    format: u32,
    app_version: String,
    created_at_ms: u64,
    #[serde(default)]
    profile_name: Option<String>,
    #[serde(default)]
    local_storage: BTreeMap<String, String>,
    #[serde(default)]
    skipped: Vec<String>,
}

#[derive(Debug, Default)]
struct EmbeddedImages {
    by_url: HashMap<String, String>,
    failed: Vec<String>,
}

#[derive(Debug, Default)]
struct ExportContext {
    app_version: String,
    created_at_ms: u64,
    profile_name: Option<String>,
    local_storage: BTreeMap<String, String>,
    images: EmbeddedImages,
}

#[tauri::command]
pub async fn export_backup(
    app: AppHandle,
    target_path: String,
    extras: Option<BackupExtras>,
) -> Result<BackupReport, String> {
    let dir = app_data_dir(&app)?;
    let index = crate::profiles::ensure_profiles_index(&app)?;
    let profile_name = profile_name_of(&index, &index.active_profile_id);
    export_profile_dir(&app, dir, target_path, profile_name, extras.unwrap_or_default()).await
}

#[tauri::command]
pub async fn export_profile_backup(
    app: AppHandle,
    profile_id: String,
    target_path: String,
    extras: Option<BackupExtras>,
) -> Result<BackupReport, String> {
    let dir = profile_data_dir_for_id(&app, &profile_id)?;
    let index = crate::profiles::ensure_profiles_index(&app)?;
    let profile_name = profile_name_of(&index, &profile_id);
    export_profile_dir(&app, dir, target_path, profile_name, extras.unwrap_or_default()).await
}

fn profile_name_of(index: &crate::profiles::ProfilesIndex, profile_id: &str) -> Option<String> {
    index
        .profiles
        .iter()
        .find(|profile| profile.id == profile_id)
        .map(|profile| profile.name.clone())
}

async fn export_profile_dir(
    app: &AppHandle,
    dir: PathBuf,
    target_path: String,
    profile_name: Option<String>,
    extras: BackupExtras,
) -> Result<BackupReport, String> {
    let urls = fs::read_to_string(dir.join("projects.json"))
        .ok()
        .and_then(|content| serde_json::from_str::<Value>(&content).ok())
        .map(|value| remote_image_urls(&value))
        .unwrap_or_default();
    let context = ExportContext {
        app_version: app.package_info().version.to_string(),
        created_at_ms: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|elapsed| elapsed.as_millis() as u64)
            .unwrap_or_default(),
        profile_name,
        local_storage: extras.local_storage,
        images: download_images(urls).await,
    };
    tokio::task::spawn_blocking(move || export_backup_from_dir(dir, target_path, context))
        .await
        .map_err(|error| format!("export_backup: blocking task failed: {error}"))?
}

fn remote_image_urls(value: &Value) -> BTreeSet<String> {
    let mut urls = BTreeSet::new();
    collect_remote_image_urls(value, &mut urls);
    urls
}

fn collect_remote_image_urls(value: &Value, urls: &mut BTreeSet<String>) {
    match value {
        Value::Object(map) => {
            for (key, child) in map {
                match child {
                    Value::String(url) if IMAGE_FIELDS.contains(&key.as_str()) && is_remote(url) => {
                        urls.insert(url.clone());
                    }
                    _ => collect_remote_image_urls(child, urls),
                }
            }
        }
        Value::Array(items) => items.iter().for_each(|item| collect_remote_image_urls(item, urls)),
        _ => {}
    }
}

fn is_remote(url: &str) -> bool {
    url.starts_with("https://") || url.starts_with("http://")
}

async fn download_images(urls: BTreeSet<String>) -> EmbeddedImages {
    let mut images = EmbeddedImages::default();
    if urls.is_empty() {
        return images;
    }
    let Ok(client) = reqwest::Client::builder()
        .timeout(IMAGE_TIMEOUT)
        .user_agent(IMAGE_USER_AGENT)
        .build()
    else {
        images.failed = urls.into_iter().collect();
        return images;
    };
    for url in urls {
        match fetch_image(&client, &url).await {
            Some(data_url) => {
                images.by_url.insert(url, data_url);
            }
            None => images.failed.push(url),
        }
    }
    images
}

async fn fetch_image(client: &reqwest::Client, url: &str) -> Option<String> {
    let response = client.get(url).send().await.ok()?;
    if !response.status().is_success() {
        return None;
    }
    let mime = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .map(|value| value.trim().to_ascii_lowercase())?;
    if !mime.starts_with("image/")
        || response
            .content_length()
            .is_some_and(|length| length as usize > MAX_EMBEDDED_IMAGE_BYTES)
    {
        return None;
    }
    let bytes = response.bytes().await.ok()?;
    if bytes.is_empty() || bytes.len() > MAX_EMBEDDED_IMAGE_BYTES {
        return None;
    }
    let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Some(format!("data:{mime};base64,{encoded}"))
}

fn embed_images(value: &mut Value, images: &HashMap<String, String>) -> usize {
    match value {
        Value::Object(map) => map
            .iter_mut()
            .map(|(key, child)| match child {
                Value::String(url) if IMAGE_FIELDS.contains(&key.as_str()) => {
                    match images.get(url.as_str()) {
                        Some(data_url) => {
                            *url = data_url.clone();
                            1
                        }
                        None => 0,
                    }
                }
                _ => embed_images(child, images),
            })
            .sum(),
        Value::Array(items) => items.iter_mut().map(|item| embed_images(item, images)).sum(),
        _ => 0,
    }
}

fn prepare_projects_for_backup(
    content: &str,
    images: &HashMap<String, String>,
) -> Result<(String, usize), String> {
    let sanitized = crate::spotify::sanitize_client_secret_content(content)?;
    if images.is_empty() {
        return Ok((sanitized, 0));
    }
    let mut value: Value =
        serde_json::from_str(&sanitized).map_err(|_| "invalid_projects_file".to_string())?;
    let embedded = embed_images(&mut value, images);
    if embedded == 0 {
        return Ok((sanitized, 0));
    }
    let content =
        serde_json::to_string_pretty(&value).map_err(|_| "invalid_projects_file".to_string())?;
    Ok((content, embedded))
}

fn export_backup_from_dir(
    dir: PathBuf,
    target_path: String,
    context: ExportContext,
) -> Result<BackupReport, String> {
    let target = PathBuf::from(target_path);
    let source_root = dir.canonicalize().map_err(|e| e.to_string())?;
    let target_parent = target
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if target_parent.starts_with(&source_root) {
        return Err("backup_inside_profile".to_string());
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let file = fs::File::create(&target).map_err(|e| e.to_string())?;
    let mut zip = ZipWriter::new(file);
    let opts = FileOptions::default().compression_method(CompressionMethod::Deflated);
    let mut report = BackupReport {
        image_links_kept: context.images.failed.clone(),
        ..BackupReport::default()
    };

    add_dir_to_zip(
        &mut zip,
        &source_root,
        &source_root,
        opts,
        &context.images.by_url,
        &mut report,
    )?;

    let manifest = BackupManifest {
        format: MANIFEST_FORMAT,
        app_version: context.app_version,
        created_at_ms: context.created_at_ms,
        profile_name: context.profile_name,
        local_storage: context.local_storage,
        skipped: report.skipped.clone(),
    };
    let manifest = serde_json::to_vec_pretty(&manifest).map_err(|e| e.to_string())?;
    zip.start_file(MANIFEST_NAME, opts).map_err(|e| e.to_string())?;
    zip.write_all(&manifest).map_err(|e| e.to_string())?;

    zip.finish().map_err(|e| e.to_string())?;
    Ok(report)
}

fn is_runtime_backup_path(root: &Path, path: &Path) -> bool {
    path.strip_prefix(root)
        .ok()
        .and_then(|relative| relative.components().next())
        .and_then(|component| component.as_os_str().to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case("EBWebView"))
}

fn is_runtime_archive_entry(name: &str) -> bool {
    name.split(['/', '\\'])
        .next()
        .is_some_and(|component| component.eq_ignore_ascii_case("EBWebView"))
}

fn is_profile_root_file(root: &Path, path: &Path, name: &str) -> bool {
    path.strip_prefix(root)
        .ok()
        .filter(|relative| relative.components().count() == 1)
        .and_then(|relative| relative.file_name())
        .and_then(|file_name| file_name.to_str())
        .is_some_and(|file_name| file_name.eq_ignore_ascii_case(name))
}

const DEVICE_BOUND_ROOTS: &[&str] = &[
    "browser-session",
    "speech-models",
    "tools",
    "cloud_sync.json",
    "sync-state.json",
];

fn is_device_bound(components: &[String]) -> bool {
    match components {
        [first, ..] if DEVICE_BOUND_ROOTS.iter().any(|root| first.eq_ignore_ascii_case(root)) => true,
        [first, second, ..] => first.eq_ignore_ascii_case("mcp") && second.eq_ignore_ascii_case("backups"),
        _ => false,
    }
}

fn is_device_bound_path(root: &Path, path: &Path) -> bool {
    path.strip_prefix(root).is_ok_and(|relative| {
        let components: Vec<String> = relative
            .components()
            .map(|component| component.as_os_str().to_string_lossy().into_owned())
            .collect();
        is_device_bound(&components)
    })
}

fn is_device_bound_entry(name: &str) -> bool {
    let components: Vec<String> = name
        .split(['/', '\\'])
        .filter(|component| !component.is_empty())
        .map(str::to_string)
        .collect();
    is_device_bound(&components)
}

fn is_manifest_entry(name: &str) -> bool {
    name.trim_start_matches(['/', '\\']).eq_ignore_ascii_case(MANIFEST_NAME)
}

fn is_excluded_from_backup(root: &Path, path: &Path) -> bool {
    if is_runtime_backup_path(root, path)
        || is_profile_root_file(root, path, "spotify_tokens.json")
        || is_profile_root_file(root, path, MANIFEST_NAME)
        || is_device_bound_path(root, path)
    {
        return true;
    }
    matches!(
        path.extension().and_then(|ext| ext.to_str()),
        Some("tmp") | Some("log")
    )
}

fn archive_name(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn add_dir_to_zip<W: Write + io::Seek>(
    zip: &mut ZipWriter<W>,
    root: &Path,
    dir: &Path,
    opts: FileOptions,
    images: &HashMap<String, String>,
    report: &mut BackupReport,
) -> Result<(), String> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if dir != root => {
            report.skipped.push(format!("{}/ ({error})", archive_name(root, dir)));
            return Ok(());
        }
        Err(error) => return Err(error.to_string()),
    };
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if is_excluded_from_backup(root, &path) {
            continue;
        }
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(error) => {
                report.skipped.push(format!("{} ({error})", archive_name(root, &path)));
                continue;
            }
        };
        if file_type.is_dir() {
            add_dir_to_zip(zip, root, &path, opts, images, report)?;
            continue;
        }
        if !file_type.is_file() {
            continue;
        }
        let name = archive_name(root, &path);
        let is_projects = is_profile_root_file(root, &path, "projects.json");
        // Windows refuses to read a file another process holds open without sharing it.
        let bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(error) if !is_projects => {
                report.skipped.push(format!("{name} ({error})"));
                continue;
            }
            Err(error) => return Err(error.to_string()),
        };
        let bytes = if is_projects {
            let content =
                String::from_utf8(bytes).map_err(|_| "backup_projects_not_utf8".to_string())?;
            let (content, embedded) = prepare_projects_for_backup(&content, images)?;
            report.embedded_images += embedded;
            content.into_bytes()
        } else {
            bytes
        };
        zip.start_file(name, opts).map_err(|e| e.to_string())?;
        zip.write_all(&bytes).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn read_manifest<R: Read + io::Seek>(archive: &mut ZipArchive<R>) -> Option<BackupManifest> {
    let mut entry = archive.by_name(MANIFEST_NAME).ok()?;
    let mut content = String::new();
    entry.read_to_string(&mut content).ok()?;
    serde_json::from_str(&content).ok()
}

/// Replaces the active profile's state with the archive, then hands back what lives outside it.
#[tauri::command]
pub async fn import_backup(app: AppHandle, source_path: String) -> Result<ImportReport, String> {
    tokio::task::spawn_blocking(move || import_backup_inner(app, source_path))
        .await
        .map_err(|error| format!("import_backup: blocking task failed: {error}"))?
}

fn import_backup_inner(app: AppHandle, source_path: String) -> Result<ImportReport, String> {
    let dir = app_data_dir(&app)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let file = fs::File::open(&source_path).map_err(|e| e.to_string())?;
    let mut archive = ZipArchive::new(file).map_err(|e| e.to_string())?;
    if !archive
        .file_names()
        .any(|name| name.replace('\\', "/") == "projects.json")
    {
        return Err("backup_missing_projects".to_string());
    }
    let manifest = read_manifest(&mut archive);

    // State that the backup does not carry must not survive the import.
    let scrollback = dir.join("scrollback");
    if scrollback.exists() {
        fs::remove_dir_all(&scrollback).map_err(|e| e.to_string())?;
    }
    let activity_stats = activity_stats_file_path(&app)?;
    if activity_stats.exists() {
        fs::remove_file(activity_stats).map_err(|e| e.to_string())?;
    }

    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let entry_name = entry.name().to_string();

        // Legacy WebView caches stay out, and no path may escape the profile directory.
        if is_runtime_archive_entry(&entry_name)
            || is_device_bound_entry(&entry_name)
            || is_manifest_entry(&entry_name)
            || Path::new(&entry_name).is_absolute()
            || entry_name.contains("..")
        {
            continue;
        }

        let dest = dir.join(&entry_name);
        if entry.is_dir() {
            fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut out = fs::File::create(&dest).map_err(|e| e.to_string())?;
        io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
        let _ = read_remaining(&mut entry);
    }

    crate::cloud_sync::reset_sync_state(&dir)?;

    let profile_id = crate::profiles::ensure_profiles_index(&app)?.active_profile_id;
    crate::spotify::migrate_profile_plaintext_files(
        &dir,
        &profile_id,
        &crate::secure_store::OsSecretStore,
    )?;

    let mut report = ImportReport::default();
    if let Some(manifest) = manifest {
        report.local_storage = manifest.local_storage;
        if let Some(name) = manifest.profile_name.filter(|name| !name.trim().is_empty()) {
            // A name another profile already uses keeps the current one.
            if crate::profiles::rename_profile_state(&app, &profile_id, name.clone()).is_ok() {
                report.profile_name = Some(name);
            }
        }
    }
    Ok(report)
}

fn read_remaining<R: Read>(r: &mut R) -> io::Result<u64> {
    io::copy(r, &mut io::sink())
}

#[cfg(test)]
mod tests {
    use super::{
        export_backup_from_dir, is_device_bound_entry, is_device_bound_path, is_manifest_entry,
        is_runtime_archive_entry, is_runtime_backup_path, prepare_projects_for_backup,
        read_manifest, remote_image_urls, EmbeddedImages, ExportContext, MANIFEST_NAME,
    };
    use std::collections::{BTreeMap, HashMap};
    use std::fs;
    use std::io::Read;
    use std::path::{Path, PathBuf};

    fn scratch(label: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "alethe-{label}-{}-{}",
            std::process::id(),
            nanoid::nanoid!(8)
        ));
        fs::create_dir_all(root.join("profile")).expect("profile");
        root
    }

    fn read_entry(archive: &mut zip::ZipArchive<fs::File>, name: &str) -> String {
        let mut content = String::new();
        archive
            .by_name(name)
            .expect("entry")
            .read_to_string(&mut content)
            .expect("read entry");
        content
    }

    #[test]
    fn excludes_webview_runtime_data_from_backups() {
        let root = Path::new("profile");
        assert!(is_runtime_backup_path(
            root,
            Path::new("profile/EBWebView/Default/LOCK")
        ));
        assert!(is_runtime_archive_entry("EBWebView/Default/LOCK"));
        assert!(is_runtime_archive_entry("ebwebview\\Default\\LOCK"));
        assert!(!is_runtime_archive_entry("scrollback/session.bin"));
    }

    #[test]
    fn device_bound_and_secret_bearing_data_stays_out_of_backups() {
        let root = Path::new("profile");
        for excluded in [
            "profile/browser-session/Default/Cookies",
            "profile/mcp/backups/claude-user-1.json",
            "profile/speech-models/parakeet/model.onnx",
            "profile/tools/ai-memory/ai-memory.exe",
            "profile/cloud_sync.json",
            "profile/sync-state.json",
        ] {
            assert!(is_device_bound_path(root, Path::new(excluded)), "{excluded}");
        }
        for kept in [
            "profile/projects.json",
            "profile/mcp/registry-cache.json",
            "profile/ai-memory-data/wiki/index.md",
            "profile/scrollback/a.bin",
        ] {
            assert!(!is_device_bound_path(root, Path::new(kept)), "{kept}");
        }
        assert!(is_device_bound_entry("cloud_sync.json"));
        assert!(is_device_bound_entry("MCP\\Backups\\codex-user-2.toml"));
        assert!(!is_device_bound_entry("projects.json"));
        assert!(is_manifest_entry("alethe-backup.json"));
        assert!(!is_manifest_entry("plugins/alethe-backup.json"));
    }

    #[test]
    fn exported_backup_excludes_spotify_plaintext() {
        let root = scratch("spotify-backup");
        let profile = root.join("profile");
        let archive_path = root.join("profile.zip");
        fs::write(
            profile.join("projects.json"),
            r#"{"preferences":{"spotifyClientId":"public-id","spotifyClientSecret":"backup-client-secret"}}"#,
        )
        .expect("projects");
        fs::write(
            profile.join("spotify_tokens.json"),
            r#"{"access_token":"backup-access","refresh_token":"backup-refresh","expires_at":1}"#,
        )
        .expect("tokens");

        export_backup_from_dir(
            profile,
            archive_path.to_string_lossy().into_owned(),
            ExportContext::default(),
        )
        .expect("export");
        let file = fs::File::open(&archive_path).expect("archive");
        let mut archive = zip::ZipArchive::new(file).expect("zip");
        assert!(archive.by_name("spotify_tokens.json").is_err());
        let projects = read_entry(&mut archive, "projects.json");
        assert!(projects.contains("public-id"));
        assert!(!projects.contains("backup-client-secret"));
        assert!(!projects.contains("spotifyClientSecret"));

        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn finds_only_linked_logos_and_profile_photos() {
        let projects = serde_json::json!({
            "preferences": { "profileImageUrl": "https://img.example/me.jpg", "homepage": "https://kc1t.com" },
            "projects": [
                { "name": "A", "iconUrl": "https://img.example/a.png" },
                { "name": "B", "iconUrl": "data:image/png;base64,AAAA" },
                { "name": "C" }
            ],
            "workspace": { "tabs": [{ "iconUrl": "http://img.example/a.png" }] }
        });
        let urls: Vec<String> = remote_image_urls(&projects).into_iter().collect();
        assert_eq!(
            urls,
            [
                "http://img.example/a.png",
                "https://img.example/a.png",
                "https://img.example/me.jpg"
            ]
        );
    }

    #[test]
    fn linked_images_are_embedded_and_the_secret_still_dropped() {
        let content = r#"{"preferences":{"profileImageUrl":"https://img.example/me.jpg","spotifyClientSecret":"s"},"projects":[{"name":"A","iconUrl":"https://img.example/a.png"},{"name":"B","iconUrl":"https://gone.example/b.png"}]}"#;
        let images = HashMap::from([
            ("https://img.example/me.jpg".to_string(), "data:image/jpeg;base64,ME".to_string()),
            ("https://img.example/a.png".to_string(), "data:image/png;base64,AA".to_string()),
        ]);
        let (prepared, embedded) = prepare_projects_for_backup(content, &images).expect("prepare");
        assert_eq!(embedded, 2);
        let value: serde_json::Value = serde_json::from_str(&prepared).expect("json");
        assert_eq!(value["preferences"]["profileImageUrl"], "data:image/jpeg;base64,ME");
        assert_eq!(value["projects"][0]["iconUrl"], "data:image/png;base64,AA");
        assert_eq!(value["projects"][1]["iconUrl"], "https://gone.example/b.png");
        assert!(value["preferences"].get("spotifyClientSecret").is_none());
        let keys: Vec<&String> = value["preferences"].as_object().expect("prefs").keys().collect();
        assert_eq!(keys, ["profileImageUrl"]);
    }

    #[test]
    fn the_manifest_carries_the_profile_and_its_local_state() {
        let root = scratch("backup-manifest");
        let profile = root.join("profile");
        let archive_path = root.join("profile.zip");
        fs::write(
            profile.join("projects.json"),
            r#"{"preferences":{"uiTheme":"nord","profileImageUrl":"https://img.example/me.jpg"}}"#,
        )
        .expect("projects");
        fs::write(profile.join(MANIFEST_NAME), "stale").expect("stale manifest");
        let context = ExportContext {
            app_version: "1.7.0".to_string(),
            created_at_ms: 42,
            profile_name: Some("Kc1t".to_string()),
            local_storage: BTreeMap::from([(
                "promptHistory:pty-1".to_string(),
                "[\"npm test\"]".to_string(),
            )]),
            images: EmbeddedImages {
                by_url: HashMap::from([(
                    "https://img.example/me.jpg".to_string(),
                    "data:image/jpeg;base64,ME".to_string(),
                )]),
                failed: vec!["https://gone.example/b.png".to_string()],
            },
        };

        let report = export_backup_from_dir(
            profile,
            archive_path.to_string_lossy().into_owned(),
            context,
        )
        .expect("export");
        assert_eq!(report.embedded_images, 1);
        assert_eq!(report.image_links_kept, ["https://gone.example/b.png"]);

        let file = fs::File::open(&archive_path).expect("archive");
        let mut archive = zip::ZipArchive::new(file).expect("zip");
        assert_eq!(
            archive.file_names().filter(|name| *name == MANIFEST_NAME).count(),
            1
        );
        let manifest = read_manifest(&mut archive).expect("manifest");
        assert_eq!(manifest.format, 1);
        assert_eq!(manifest.app_version, "1.7.0");
        assert_eq!(manifest.profile_name.as_deref(), Some("Kc1t"));
        assert_eq!(manifest.local_storage["promptHistory:pty-1"], "[\"npm test\"]");
        let projects = read_entry(&mut archive, "projects.json");
        assert!(projects.contains("data:image/jpeg;base64,ME"));
        assert!(projects.contains("\"uiTheme\": \"nord\""));

        fs::remove_dir_all(root).expect("cleanup");
    }

    #[cfg(windows)]
    #[test]
    fn a_file_another_process_holds_is_skipped_instead_of_failing_the_export() {
        use std::os::windows::fs::OpenOptionsExt;

        let root = scratch("backup-locked");
        let profile = root.join("profile");
        let archive_path = root.join("profile.zip");
        fs::write(profile.join("projects.json"), r#"{"preferences":{}}"#).expect("projects");
        fs::create_dir_all(profile.join("plugin-data")).expect("plugin dir");
        fs::write(profile.join("plugin-data").join("state.db"), "locked").expect("locked file");
        fs::write(profile.join("plugin-data").join("notes.json"), "{}").expect("readable file");
        let held = fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(profile.join("plugin-data").join("state.db"))
            .expect("hold");

        let report = export_backup_from_dir(
            profile,
            archive_path.to_string_lossy().into_owned(),
            ExportContext::default(),
        )
        .expect("export");
        drop(held);

        assert_eq!(report.skipped.len(), 1);
        assert!(report.skipped[0].starts_with("plugin-data/state.db ("));
        let file = fs::File::open(&archive_path).expect("archive");
        let mut archive = zip::ZipArchive::new(file).expect("zip");
        assert!(archive.by_name("plugin-data/notes.json").is_ok());
        assert!(archive.by_name("plugin-data/state.db").is_err());
        let manifest = read_manifest(&mut archive).expect("manifest");
        assert_eq!(manifest.skipped, report.skipped);

        fs::remove_dir_all(root).expect("cleanup");
    }
}
