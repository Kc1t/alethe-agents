use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use tauri::AppHandle;
use zip::write::FileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use crate::paths::{activity_stats_file_path, app_data_dir};
use crate::profiles::profile_data_dir_for_id;

/// Empacota `projects.json` + `scrollback/` num zip salvo em `target_path`.
/// Não inclui `spawn.log` (debug-only) nem `tmp` (artefatos do save atômico).
///
/// `async` + `spawn_blocking`: I/O de disco real (zip de todo o scrollback),
/// mesma classe de bloqueio já corrigida em `cli_resolver.rs` — sem isso
/// trava a thread de despacho de IPC do Tauri, sem indicador de progresso
/// pro usuário além do botão "parecer travado".
#[tauri::command]
pub async fn export_backup(app: AppHandle, target_path: String) -> Result<(), String> {
    let dir = app_data_dir(&app)?;
    tokio::task::spawn_blocking(move || export_backup_from_dir(dir, target_path))
        .await
        .map_err(|error| format!("export_backup: falha na task bloqueante: {error}"))?
}

/// Igual a `export_backup`, mas pra um perfil específico (não necessariamente o ativo).
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

pub fn export_backup_from_dir(dir: PathBuf, target_path: String) -> Result<(), String> {
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

    // Archive the whole profile so nothing the user owns (Todos, history,
    // preferences, tokens, scrollback, and any future file) is left behind.
    // Only debug logs and temporary atomic-save artifacts are skipped.
    add_dir_to_zip(&mut zip, &source_root, &source_root, opts)?;

    zip.finish().map_err(|e| e.to_string())?;
    Ok(())
}

fn is_excluded_from_backup(path: &Path) -> bool {
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
        if file_type.is_dir() {
            add_dir_to_zip(zip, root, &path, opts)?;
            continue;
        }
        if !file_type.is_file() || is_excluded_from_backup(&path) {
            continue;
        }
        let rel = path.strip_prefix(root).map_err(|e| e.to_string())?;
        let name = rel.to_string_lossy().replace('\\', "/");
        zip.start_file(name, opts).map_err(|e| e.to_string())?;
        let bytes = fs::read(&path).map_err(|e| e.to_string())?;
        zip.write_all(&bytes).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Replace local state with the contents of `source_path`. Remove existing
/// scrollback first so deleted PTY data is not retained.
/// preserva apenas o projects.json novo.
///
/// `async` + `spawn_blocking`: mesmo motivo de `export_backup`.
#[tauri::command]
pub async fn import_backup(app: AppHandle, source_path: String) -> Result<(), String> {
    let dir = app_data_dir(&app)?;
    let activity_stats = activity_stats_file_path(&app)?;
    tokio::task::spawn_blocking(move || import_backup_from_dir(dir, activity_stats, source_path))
        .await
        .map_err(|error| format!("import_backup: falha na task bloqueante: {error}"))?
}

/// Núcleo sem `AppHandle` — reaproveitado pelo `alethe-server`
/// (`server_main/backup_routes.rs`), que resolve os mesmos caminhos à mão
/// (mesmo padrão de `profile_routes.rs`).
pub fn import_backup_from_dir(
    dir: PathBuf,
    activity_stats: PathBuf,
    source_path: String,
) -> Result<(), String> {
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    // Limpa scrollback prévio
    let scrollback = dir.join("scrollback");
    if scrollback.exists() {
        let _ = fs::remove_dir_all(&scrollback);
    }
    if activity_stats.exists() {
        fs::remove_file(activity_stats).map_err(|e| e.to_string())?;
    }

    let file = fs::File::open(&source_path).map_err(|e| e.to_string())?;
    let mut archive = ZipArchive::new(file).map_err(|e| e.to_string())?;

    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let entry_name = entry.name().to_string();

        // Sanitização: rejeita absolute paths e ".." pra evitar zip-slip
        if Path::new(&entry_name).is_absolute() || entry_name.contains("..") {
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
        let _ = read_remaining(&mut entry); // garante consumir o resto do entry
    }

    Ok(())
}

fn read_remaining<R: Read>(r: &mut R) -> io::Result<u64> {
    io::copy(r, &mut io::sink())
}
