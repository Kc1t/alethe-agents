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

pub fn orchestrator_store_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(profile_data_dir(app)?.join("orchestrator-jobs.json"))
}

pub fn scrollback_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(profile_data_dir(app)?.join("scrollback"))
}

/// A PTY id is free-form (`agent-install:claude:1789565062303`), and Windows reads `name:stream` as
/// an NTFS alternate data stream: written raw, a scrollback lands in a hidden stream of a zero-byte
/// file instead of the file itself, and nothing reports an error. Every character a path cannot
/// carry is folded to `_`.
fn scrollback_file_name(id: &str) -> String {
    let safe: String = id
        .chars()
        .map(|c| match c {
            ':' | '/' | '\\' | '<' | '>' | '"' | '|' | '?' | '*' => '_',
            c if (c as u32) < 0x20 => '_',
            c => c,
        })
        .collect();
    format!("{safe}.bin")
}

pub fn scrollback_path(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    Ok(scrollback_dir(app)?.join(scrollback_file_name(id)))
}

#[cfg(test)]
mod tests {
    use super::scrollback_file_name;

    #[test]
    fn an_id_with_a_colon_does_not_become_an_alternate_data_stream() {
        assert_eq!(
            scrollback_file_name("router9-install:1789565062303"),
            "router9-install_1789565062303.bin"
        );
    }

    #[test]
    fn an_ordinary_id_is_left_alone() {
        assert_eq!(scrollback_file_name("orchestrator-shell-01"), "orchestrator-shell-01.bin");
        assert_eq!(scrollback_file_name("PlNsE55eLe796edeEnjpg"), "PlNsE55eLe796edeEnjpg.bin");
    }
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
