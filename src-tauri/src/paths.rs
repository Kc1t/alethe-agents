use std::path::PathBuf;
use tauri::AppHandle;

const PROFILES_DIR_NAME: &str = "profiles";

/// Diretório de dados do perfil ativo.
pub fn profile_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let root = crate::profiles::resolve_tauri_data_root(app)?;
    let index = crate::profiles::ensure_profiles_index_at(&root)?;
    Ok(root.join(PROFILES_DIR_NAME).join(&index.active_profile_id))
}

pub fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    profile_data_dir(app)
}

pub fn scrollback_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(profile_data_dir(app)?.join("scrollback"))
}

pub fn scrollback_path(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    crate::pty::validate_pty_id(id)?;
    Ok(scrollback_dir(app)?.join(format!("{id}.bin")))
}

pub fn projects_file_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(profile_data_dir(app)?.join("projects.json"))
}

pub fn activity_stats_file_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(profile_data_dir(app)?.join("activity-stats.json"))
}

pub fn spawn_log_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(profile_data_dir(app)?.join("spawn.log"))
}
