use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager};

pub const OPEN_PATH_EVENT: &str = "alethe://open-path";

const OPEN_PATH_FLAG: &str = "--open-path";

#[derive(Default)]
pub struct PendingOpen(Mutex<Option<String>>);

/// Unknown flags must be skipped rather than treated as the target: macOS injects
/// `-psn_0_1234` when launching a bundled app from Finder.
fn extract_path_arg(args: &[String]) -> Option<String> {
    let mut iter = args.iter().skip(1);
    while let Some(arg) = iter.next() {
        if arg == OPEN_PATH_FLAG {
            return iter.next().map(|value| value.to_string());
        }
        if let Some(value) = arg.strip_prefix(&format!("{OPEN_PATH_FLAG}=")) {
            return Some(value.to_string());
        }
        if arg.starts_with('-') {
            continue;
        }
        return Some(arg.to_string());
    }
    None
}

fn strip_verbatim_prefix(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy();

    if let Some(stripped) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{stripped}"));
    }
    match text.strip_prefix(r"\\?\") {
        Some(stripped) => PathBuf::from(stripped),
        None => path,
    }
}

fn normalize_dir(candidate: &Path) -> Option<PathBuf> {
    let resolved = candidate
        .canonicalize()
        .map(strip_verbatim_prefix)
        .unwrap_or_else(|_| candidate.to_path_buf());

    if resolved.is_dir() {
        return Some(resolved);
    }
    if resolved.is_file() {
        return resolved.parent().map(|parent| parent.to_path_buf());
    }
    None
}

pub fn resolve_target_dir(args: &[String], cwd: &Path) -> Option<PathBuf> {
    let raw = extract_path_arg(args)?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }

    let candidate = PathBuf::from(trimmed);
    let candidate = if candidate.is_absolute() {
        candidate
    } else {
        cwd.join(candidate)
    };

    normalize_dir(&candidate)
}

pub fn capture_cold_start(app: &AppHandle) {
    let args: Vec<String> = std::env::args().collect();
    let Ok(cwd) = std::env::current_dir() else {
        return;
    };
    let Some(target) = resolve_target_dir(&args, &cwd) else {
        return;
    };
    if let Ok(mut pending) = app.state::<PendingOpen>().0.lock() {
        *pending = Some(target.to_string_lossy().to_string());
    }
}

pub fn handle_second_instance(app: &AppHandle, argv: Vec<String>, cwd: String) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.set_focus();
    }

    let Some(target) = resolve_target_dir(&argv, Path::new(&cwd)) else {
        return;
    };
    let _ = app.emit(OPEN_PATH_EVENT, target.to_string_lossy().to_string());
}

#[tauri::command]
pub fn cli_take_pending_open(state: tauri::State<'_, PendingOpen>) -> Option<String> {
    state.0.lock().ok().and_then(|mut pending| pending.take())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|item| item.to_string()).collect()
    }

    fn temp_root() -> PathBuf {
        strip_verbatim_prefix(std::env::temp_dir().canonicalize().expect("temp dir"))
    }

    #[test]
    fn ignores_argv0_and_reads_flag() {
        assert_eq!(
            extract_path_arg(&args(&["alethe", "--open-path", "/tmp/x"])),
            Some("/tmp/x".to_string())
        );
    }

    #[test]
    fn reads_inline_flag_form() {
        assert_eq!(
            extract_path_arg(&args(&["alethe", "--open-path=/tmp/x"])),
            Some("/tmp/x".to_string())
        );
    }

    #[test]
    fn reads_bare_positional() {
        assert_eq!(
            extract_path_arg(&args(&["alethe", "/tmp/x"])),
            Some("/tmp/x".to_string())
        );
    }

    #[test]
    fn skips_unknown_flags_like_macos_psn() {
        assert_eq!(extract_path_arg(&args(&["alethe", "-psn_0_1234"])), None);
        assert_eq!(
            extract_path_arg(&args(&["alethe", "-psn_0_1234", "/tmp/x"])),
            Some("/tmp/x".to_string())
        );
    }

    #[test]
    fn no_args_means_no_target() {
        assert_eq!(extract_path_arg(&args(&["alethe"])), None);
        assert_eq!(resolve_target_dir(&args(&["alethe"]), Path::new("/")), None);
    }

    #[test]
    fn dot_resolves_against_caller_cwd() {
        let cwd = temp_root();
        let resolved = resolve_target_dir(&args(&["alethe", "."]), &cwd).expect("resolved");
        assert_eq!(resolved, cwd);
    }

    #[test]
    fn relative_path_resolves_against_caller_cwd() {
        let base = temp_root();
        let nested = base.join("alethe-cli-test-rel");
        std::fs::create_dir_all(&nested).expect("create dir");

        let resolved =
            resolve_target_dir(&args(&["alethe", "alethe-cli-test-rel"]), &base).expect("resolved");
        assert_eq!(resolved, nested);

        let _ = std::fs::remove_dir_all(&nested);
    }

    #[test]
    fn file_target_falls_back_to_its_directory() {
        let base = temp_root();
        let dir = base.join("alethe-cli-test-file");
        std::fs::create_dir_all(&dir).expect("create dir");
        let file = dir.join("README.md");
        std::fs::write(&file, b"x").expect("write file");

        let resolved =
            resolve_target_dir(&args(&["alethe", &file.to_string_lossy()]), Path::new("/"))
                .expect("resolved");
        assert_eq!(resolved, dir);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_path_resolves_to_none() {
        let target = std::env::temp_dir().join("alethe-cli-test-inexistente-xyz");
        let _ = std::fs::remove_dir_all(&target);
        assert_eq!(
            resolve_target_dir(
                &args(&["alethe", &target.to_string_lossy()]),
                Path::new("/")
            ),
            None
        );
    }

    #[test]
    fn strips_windows_verbatim_prefix() {
        assert_eq!(
            strip_verbatim_prefix(PathBuf::from(r"\\?\C:\dev\app")),
            PathBuf::from(r"C:\dev\app")
        );
        assert_eq!(
            strip_verbatim_prefix(PathBuf::from("/home/u/app")),
            PathBuf::from("/home/u/app")
        );
    }

    #[test]
    fn restores_unc_network_paths() {
        assert_eq!(
            strip_verbatim_prefix(PathBuf::from(r"\\?\UNC\servidor\share\app")),
            PathBuf::from(r"\\servidor\share\app")
        );
    }
}
