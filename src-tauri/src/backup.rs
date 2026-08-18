use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use tauri::AppHandle;
use zip::write::FileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use crate::paths::{activity_stats_file_path, app_data_dir};
use crate::profiles::profile_data_dir_for_id;

/// Empacota `projects.json` + `scrollback/` num zip salvo em `target_path`.

///
/// `async` + `spawn_blocking`: I/O de disco real (zip de todo o scrollback),

#[tauri::command]
pub async fn export_backup(app: AppHandle, target_path: String) -> Result<(), String> {
    let dir = app_data_dir(&app)?;
    tokio::task::spawn_blocking(move || export_backup_from_dir(dir, target_path))
        .await
        .map_err(|error| format!("export_backup: falha na task bloqueante: {error}"))?
}

#[tauri::command]
pub async fn export_profile_backup(
    app: AppHandle,
    profile_id: String,
    target_path: String,
) -> Result<(), String> {
    let dir = profile_data_dir_for_id(&app, &profile_id)?;
    tokio::task::spawn_blocking(move || export_backup_from_dir(dir, target_path))
        .await
        .map_err(|error| format!("export_profile_backup: falha na task bloqueante: {error}"))?
}

fn export_backup_from_dir(dir: PathBuf, target_path: String) -> Result<(), String> {
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

    // preferences, tokens, scrollback, and any future file) is left behind.
    // Only debug logs and temporary atomic-save artifacts are skipped.
    add_dir_to_zip(&mut zip, &source_root, &source_root, opts)?;

    zip.finish().map_err(|e| e.to_string())?;
    Ok(())
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

fn is_excluded_from_backup(root: &Path, path: &Path) -> bool {
    if is_runtime_backup_path(root, path) || is_profile_root_file(root, path, "spotify_tokens.json")
    {
        return true;
    }
    matches!(
        path.extension().and_then(|ext| ext.to_str()),
        Some("tmp") | Some("log")
    )
}

fn add_dir_to_zip<W: Write + io::Seek>(
    zip: &mut ZipWriter<W>,
    root: &Path,
    dir: &Path,
    opts: FileOptions,
) -> Result<(), String> {
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let file_type = entry.file_type().map_err(|e| e.to_string())?;
        if is_excluded_from_backup(root, &path) {
            continue;
        }
        if file_type.is_dir() {
            add_dir_to_zip(zip, root, &path, opts)?;
            continue;
        }
        if !file_type.is_file() {
            continue;
        }
        let rel = path.strip_prefix(root).map_err(|e| e.to_string())?;
        let name = rel.to_string_lossy().replace('\\', "/");
        zip.start_file(name, opts).map_err(|e| e.to_string())?;
        let bytes = fs::read(&path).map_err(|e| e.to_string())?;
        let bytes = if is_profile_root_file(root, &path, "projects.json") {
            let content =
                String::from_utf8(bytes).map_err(|_| "backup_projects_not_utf8".to_string())?;
            crate::spotify::sanitize_client_secret_content(&content)?.into_bytes()
        } else {
            bytes
        };
        zip.write_all(&bytes).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Replace local state with the contents of `source_path`. Remove existing
/// scrollback first so deleted PTY data is not retained.

///

#[tauri::command]
pub async fn import_backup(app: AppHandle, source_path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || import_backup_inner(app, source_path))
        .await
        .map_err(|error| format!("import_backup: falha na task bloqueante: {error}"))?
}

fn import_backup_inner(app: AppHandle, source_path: String) -> Result<(), String> {
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

    // Remove state that must not survive when it is absent from the backup.
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

        // Ignore legacy WebView caches and reject paths that could escape the profile directory.
        if is_runtime_archive_entry(&entry_name)
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

    let profile_id = crate::profiles::ensure_profiles_index(&app)?.active_profile_id;
    crate::spotify::migrate_profile_plaintext_files(
        &dir,
        &profile_id,
        &crate::secure_store::OsSecretStore,
    )?;

    Ok(())
}

fn read_remaining<R: Read>(r: &mut R) -> io::Result<u64> {
    io::copy(r, &mut io::sink())
}

#[cfg(test)]
mod tests {
    use super::{export_backup_from_dir, is_runtime_archive_entry, is_runtime_backup_path};
    use std::fs;
    use std::io::Read;
    use std::path::Path;

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
    fn exported_backup_excludes_spotify_plaintext() {
        let root = std::env::temp_dir().join(format!(
            "alethe-spotify-backup-{}-{}",
            std::process::id(),
            nanoid::nanoid!(8)
        ));
        let profile = root.join("profile");
        let archive_path = root.join("profile.zip");
        fs::create_dir_all(&profile).expect("profile");
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

        export_backup_from_dir(profile, archive_path.to_string_lossy().into_owned())
            .expect("export");
        let file = fs::File::open(&archive_path).expect("archive");
        let mut archive = zip::ZipArchive::new(file).expect("zip");
        assert!(archive.by_name("spotify_tokens.json").is_err());
        let mut projects = String::new();
        archive
            .by_name("projects.json")
            .expect("projects entry")
            .read_to_string(&mut projects)
            .expect("read projects");
        assert!(projects.contains("public-id"));
        assert!(!projects.contains("backup-client-secret"));
        assert!(!projects.contains("spotifyClientSecret"));

        fs::remove_dir_all(root).expect("cleanup");
    }
}
