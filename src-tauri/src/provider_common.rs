use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
/// Resolve `~/<segments>` a partir de `USERPROFILE` (Windows) ou `HOME` (Unix).
pub(crate) fn provider_home_dir(segments: &[&str]) -> Option<PathBuf> {
    let home = host_home_dir()?;
    Some(segments.iter().fold(home, |acc, seg| acc.join(seg)))
}

fn host_home_dir() -> Option<PathBuf> {
    env::var_os("USERPROFILE")
        .or_else(|| env::var_os("HOME"))
        .map(PathBuf::from)
}

pub(crate) struct ProviderScope {
    pub root: PathBuf,
    pub match_cwd: String,
    guest: bool,
}

impl ProviderScope {
    pub fn normalize(&self, cwd: &str) -> String {
        normalize_cwd_for(cwd, self.guest)
    }

    pub fn match_key(&self) -> String {
        self.normalize(&self.match_cwd)
    }

    pub fn is_guest(&self) -> bool {
        self.guest
    }

    pub fn separator(&self) -> char {
        if !self.guest && cfg!(windows) {
            '\\'
        } else {
            '/'
        }
    }
}

pub(crate) fn provider_scope(cwd: &str, segments: &[&str]) -> Option<ProviderScope> {
    let wsl = crate::wsl::wsl_target(cwd);
    let distro_home = wsl
        .as_ref()
        .and_then(|path| crate::wsl::distro_home_unc(&path.distro))
        .map(PathBuf::from);
    provider_scope_from(
        cwd,
        host_home_dir().as_deref(),
        distro_home.as_deref(),
        wsl.as_ref().map(|path| path.linux_path.as_str()),
        segments,
    )
}

pub(crate) fn provider_scope_from(
    cwd: &str,
    windows_home: Option<&Path>,
    distro_home: Option<&Path>,
    guest_cwd: Option<&str>,
    segments: &[&str],
) -> Option<ProviderScope> {
    let cwd = cwd.trim();
    if cwd.is_empty() {
        return None;
    }
    let (home, match_cwd, guest) = match guest_cwd {
        Some(path) => (distro_home?, path.to_string(), true),
        None => (windows_home?, cwd.to_string(), false),
    };
    Some(ProviderScope {
        root: segments
            .iter()
            .fold(home.to_path_buf(), |acc, seg| acc.join(seg)),
        match_cwd,
        guest,
    })
}

pub(crate) fn file_modified_ms(metadata: &fs::Metadata) -> u128 {
    metadata
        .modified()
        .ok()
        .and_then(|m| m.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub(crate) fn normalize_cwd(cwd: &str) -> String {
    normalize_cwd_for(cwd, false)
}

pub(crate) fn normalize_cwd_for(cwd: &str, guest: bool) -> String {
    let trimmed = cwd.trim().trim_end_matches(|c: char| c == '\\' || c == '/');
    if !guest && cfg!(windows) {
        trimmed.replace('/', "\\").to_ascii_lowercase()
    } else {
        trimmed.to_string()
    }
}

/// Serializes all read-modify-write cycles on `opencode.json`. Multiple writers
/// (Graphify, GSD plugin, AI Memory) race to insert their MCP entry into the
/// same file; without a lock the last writer clobbers the others.
pub(crate) fn opencode_json_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn now_ms_is_nonzero() {
        assert!(now_ms() > 0);
    }

    #[test]
    fn a_windows_cwd_scopes_to_the_windows_home_and_keeps_its_own_cwd_key() {
        let scope = provider_scope_from(
            r"C:\projects\app",
            Some(Path::new(r"C:\Users\dev")),
            None,
            None,
            &[".claude", "projects"],
        )
        .expect("a windows cwd with a windows home resolves");

        let expected_root = if cfg!(windows) {
            r"C:\Users\dev\.claude\projects"
        } else {
            r"C:\Users\dev/.claude/projects"
        };
        assert_eq!(scope.root, PathBuf::from(expected_root));
        assert_eq!(scope.match_cwd, r"C:\projects\app");
    }

    #[test]
    fn a_wsl_cwd_scopes_to_the_distro_home_and_keys_on_the_guest_path() {
        let scope = provider_scope_from(
            r"\\wsl.localhost\Ubuntu\home\dev\projects\app",
            Some(Path::new(r"C:\Users\dev")),
            Some(Path::new(r"\\wsl.localhost\Ubuntu\home\dev")),
            Some("/home/dev/projects/app"),
            &[".claude", "projects"],
        )
        .expect("a wsl cwd with a resolved distro home resolves");

        let expected_root = if cfg!(windows) {
            r"\\wsl.localhost\Ubuntu\home\dev\.claude\projects"
        } else {
            r"\\wsl.localhost\Ubuntu\home\dev/.claude/projects"
        };
        assert_eq!(scope.root, PathBuf::from(expected_root));
        assert_eq!(scope.match_cwd, "/home/dev/projects/app");
    }

    #[test]
    fn a_wsl_cwd_without_a_distro_home_never_falls_back_to_the_windows_home() {
        assert!(provider_scope_from(
            r"\\wsl.localhost\Ubuntu\home\dev\projects\app",
            Some(Path::new(r"C:\Users\dev")),
            None,
            Some("/home/dev/projects/app"),
            &[".claude", "projects"],
        )
        .is_none());
    }

    #[test]
    fn an_empty_cwd_or_a_missing_windows_home_has_no_scope() {
        assert!(provider_scope_from(
            "   ",
            Some(Path::new(r"C:\Users\dev")),
            None,
            None,
            &[".claude"]
        )
        .is_none());
        assert!(provider_scope_from(r"C:\projects\app", None, None, None, &[".claude"]).is_none());
    }

    #[test]
    fn the_scope_normalizes_its_key_the_way_its_own_host_demands() {
        let wsl = provider_scope_from(
            r"\\wsl.localhost\Ubuntu\home\Dev\App",
            Some(Path::new(r"C:\Users\dev")),
            Some(Path::new(r"\\wsl.localhost\Ubuntu\home\Dev")),
            Some("/home/Dev/App"),
            &[".codex", "sessions"],
        )
        .expect("a wsl cwd with a resolved distro home resolves");
        assert_eq!(wsl.normalize("/home/Dev/App/"), "/home/Dev/App");

        let windows = provider_scope_from(
            r"C:\projects\Acme",
            Some(Path::new(r"C:\Users\dev")),
            None,
            None,
            &[".codex", "sessions"],
        )
        .expect("a windows cwd with a windows home resolves");
        assert_eq!(
            windows.normalize(r"C:\projects\Acme\"),
            normalize_cwd(r"C:\projects\Acme")
        );
    }

    #[test]
    fn a_guest_cwd_key_keeps_its_case_and_forward_slashes() {
        assert_eq!(normalize_cwd_for("/home/Dev/App", true), "/home/Dev/App");
        assert_eq!(normalize_cwd_for("/home/Dev/App/", true), "/home/Dev/App");
        assert_eq!(
            normalize_cwd_for("C:/foo/Bar/", false),
            normalize_cwd("C:/foo/Bar")
        );
    }

    #[test]
    fn normalize_cwd_trims_trailing_separators() {
        assert_eq!(normalize_cwd("C:/foo/bar/"), normalize_cwd("C:/foo/bar"));
    }
}
