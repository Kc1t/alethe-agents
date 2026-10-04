use std::path::{Path, PathBuf};
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

/// A directory only this user can enter, for files that carry the listener token or that another
/// program runs. Linux's `/tmp` is shared, so a predictable name there can be claimed by another
/// account first, and a config that points at it would then run their file; `$XDG_RUNTIME_DIR` is
/// the per-user, owner-only directory meant for this. Windows and macOS temp folders are already
/// per user.
pub fn private_runtime_dir() -> std::io::Result<PathBuf> {
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        use std::os::unix::fs::PermissionsExt;
        let base = std::env::var_os("XDG_RUNTIME_DIR")
            .map(PathBuf::from)
            .filter(|dir| dir.is_absolute() && dir.is_dir())
            .or_else(|| dirs_next::cache_dir().map(|dir| dir.join("alethe")))
            .ok_or_else(|| std::io::Error::other("no private directory available"))?;
        let dir = base.join("alethe-runtime");
        std::fs::create_dir_all(&dir)?;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;
        Ok(dir)
    }
    #[cfg(any(windows, target_os = "macos"))]
    {
        Ok(std::env::temp_dir())
    }
}

/// Writes a file only its owner can read. Hook settings, MCP configs and bridge scripts carry the
/// listener token, and on Linux and macOS the temp directory is shared by every local user.
pub fn write_private_file(path: &Path, contents: impl AsRef<[u8]>) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)?;
        // `mode` only applies on creation: a file an older version left behind keeps its own until
        // it is set here, and it is already empty by then.
        file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
        file.write_all(contents.as_ref())
    }
    #[cfg(not(unix))]
    {
        std::fs::write(path, contents)
    }
}

#[cfg(all(test, unix))]
mod private_file_tests {
    use std::os::unix::fs::PermissionsExt;

    use super::write_private_file;

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn the_private_directory_is_owner_only_and_not_the_shared_temp_dir() {
        let dir = super::private_runtime_dir().expect("a private directory");
        let mode = std::fs::metadata(&dir)
            .expect("metadata")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o700, "{}", dir.display());
        assert!(!dir.starts_with("/tmp"), "{}", dir.display());
    }

    #[test]
    fn a_new_file_and_one_left_world_readable_both_end_up_owner_only() {
        let dir = std::env::temp_dir().join(format!("alethe-private-{}", nanoid::nanoid!(8)));
        std::fs::create_dir_all(&dir).expect("dir");
        let fresh = dir.join("fresh.json");
        let stale = dir.join("stale.json");
        std::fs::write(&stale, "old").expect("seed");
        std::fs::set_permissions(&stale, std::fs::Permissions::from_mode(0o644)).expect("chmod");

        write_private_file(&fresh, "secret").expect("write fresh");
        write_private_file(&stale, "secret").expect("write stale");

        for path in [&fresh, &stale] {
            let mode = std::fs::metadata(path)
                .expect("metadata")
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600, "{}", path.display());
            assert_eq!(std::fs::read_to_string(path).expect("read"), "secret");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
