use std::path::PathBuf;
use tauri::{AppHandle, Manager};

const PROFILES_DIR_NAME: &str = "profiles";

fn root_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map_err(|error| error.to_string())
}

///

pub fn profile_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let root = root_data_dir(app)?;
    let index = crate::profiles::ensure_profiles_index(app)?;
    Ok(root.join(PROFILES_DIR_NAME).join(&index.active_profile_id))
}

pub fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    profile_data_dir(app)
}

pub fn scrollback_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(profile_data_dir(app)?.join("scrollback"))
}

pub fn scrollback_path(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
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
