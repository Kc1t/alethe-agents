use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager};

pub const OPEN_PATH_EVENT: &str = "alethe://open-path";

const OPEN_PATH_FLAG: &str = "--open-path";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CliAction {
    LaunchGui,
    PrintVersion,
    PrintHelp,
    Update,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CliUpdateReport {
    UpToDate {
        current_version: String,
    },
    Updated {
        from_version: String,
        to_version: String,
    },
    BlockedByRunningApp {
        available_version: String,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CliExit {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

pub fn parse_cli_action(args: &[String]) -> CliAction {
    let mut iter = args.iter().skip(1);
    let mut saw_positional = false;
    let mut is_update = false;
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--version" | "-V" => return CliAction::PrintVersion,
            "--help" | "-h" => return CliAction::PrintHelp,
            OPEN_PATH_FLAG => {
                iter.next();
                saw_positional = true;
            }
            _ if arg.starts_with(&format!("{OPEN_PATH_FLAG}=")) => {
                saw_positional = true;
            }
            "update" if !saw_positional => {
                is_update = true;
                saw_positional = true;
            }
            _ if !arg.starts_with('-') => {
                saw_positional = true;
            }
            _ => {}
        }
    }
    if is_update {
        CliAction::Update
    } else {
        CliAction::LaunchGui
    }
}

pub fn cli_action_output(action: CliAction) -> Option<String> {
    match action {
        CliAction::LaunchGui | CliAction::Update => None,
        CliAction::PrintVersion => Some(format!("alethe {}\n", env!("CARGO_PKG_VERSION"))),
        CliAction::PrintHelp => Some(format!(
            "alethe {}\n\nUsage:\n  alethe [path]\n  alethe --open-path <path>\n  alethe update\n  alethe --version\n  alethe --help\n",
            env!("CARGO_PKG_VERSION")
        )),
    }
}

pub fn cli_immediate_exit(action: CliAction) -> Option<CliExit> {
    cli_action_output(action).map(|stdout| CliExit {
        code: 0,
        stdout,
        stderr: String::new(),
    })
}

pub fn format_update_outcome(result: Result<CliUpdateReport, String>) -> CliExit {
    match result {
        Ok(CliUpdateReport::UpToDate { current_version }) => CliExit {
            code: 0,
            stdout: format!("alethe {current_version} is already up to date.\n"),
            stderr: String::new(),
        },
        Ok(CliUpdateReport::Updated {
            from_version,
            to_version,
        }) => CliExit {
            code: 0,
            stdout: format!("Updated alethe from {from_version} to {to_version}.\n"),
            stderr: String::new(),
        },
        Ok(CliUpdateReport::BlockedByRunningApp { available_version }) => CliExit {
            code: 1,
            stdout: String::new(),
            stderr: format!(
                "alethe {available_version} is available, but Alethe is open. Close it and run \
                 `alethe update` again, or update from inside the app.\n"
            ),
        },
        Err(err) => CliExit {
            code: 1,
            stdout: String::new(),
            stderr: format!("alethe update failed: {err}\n"),
        },
    }
}

pub fn attach_parent_console() {
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::System::Console::{AttachConsole, ATTACH_PARENT_PROCESS};
        let _ = AttachConsole(ATTACH_PARENT_PROCESS);
    }
}

pub fn write_cli_exit(exit: &CliExit) {
    use std::io::Write;
    if !exit.stdout.is_empty() {
        let stdout = std::io::stdout();
        let mut stdout = stdout.lock();
        let _ = stdout.write_all(exit.stdout.as_bytes());
        let _ = stdout.flush();
    }
    if !exit.stderr.is_empty() {
        let stderr = std::io::stderr();
        let mut stderr = stderr.lock();
        let _ = stderr.write_all(exit.stderr.as_bytes());
        let _ = stderr.flush();
    }
}

pub fn run_cli_update(mut context: tauri::Context<tauri::Wry>) -> CliExit {
    use tauri_plugin_updater::UpdaterExt;

    context.config_mut().app.windows.clear();
    let result = (|| -> Result<CliUpdateReport, String> {
        let app = tauri::Builder::default()
            .plugin(tauri_plugin_updater::Builder::new().build())
            .build(context)
            .map_err(|err| err.to_string())?;

        tauri::async_runtime::block_on(async {
            let updater = app
                .updater_builder()
                .build()
                .map_err(|err| err.to_string())?;
            let Some(update) = updater.check().await.map_err(|err| err.to_string())? else {
                return Ok(CliUpdateReport::UpToDate {
                    current_version: env!("CARGO_PKG_VERSION").to_string(),
                });
            };

            let from_version = update.current_version.clone();
            let to_version = update.version.clone();
            // The installer closes a running Alethe, and every terminal open in it.
            if another_instance_running() {
                return Ok(CliUpdateReport::BlockedByRunningApp {
                    available_version: to_version,
                });
            }
            let bytes = update
                .download(|_, _| {}, || {})
                .await
                .map_err(|err| err.to_string())?;

            // On Windows, `install` launches the installer and exits this process, so this is the
            // last message printed there; macOS and Linux go on to report the finished update.
            write_cli_exit(&CliExit {
                code: 0,
                stdout: format_install_start(&from_version, &to_version),
                stderr: String::new(),
            });

            let report = CliUpdateReport::Updated {
                from_version,
                to_version,
            };
            update
                .restart_after_install(false)
                .install(bytes)
                .map_err(|err| err.to_string())?;

            Ok(report)
        })
    })();

    format_update_outcome(result)
}

pub fn format_install_start(from_version: &str, to_version: &str) -> String {
    format!("Installing alethe {to_version} (currently {from_version})...\n")
}

fn another_instance_running() -> bool {
    let Ok(own_exe) = std::env::current_exe() else {
        return false;
    };
    let mut system = sysinfo::System::new();
    system.refresh_processes_specifics(
        sysinfo::ProcessesToUpdate::All,
        sysinfo::ProcessRefreshKind::new().with_exe(sysinfo::UpdateKind::OnlyIfNotSet),
    );
    is_other_instance(
        std::process::id(),
        &own_exe,
        system
            .processes()
            .iter()
            .map(|(pid, process)| (pid.as_u32(), process.exe())),
    )
}

fn is_other_instance<'a>(
    own_pid: u32,
    own_exe: &Path,
    processes: impl IntoIterator<Item = (u32, Option<&'a Path>)>,
) -> bool {
    let own_exe = strip_verbatim_prefix(own_exe.to_path_buf());
    processes.into_iter().any(|(pid, exe)| {
        pid != own_pid
            && exe.is_some_and(|exe| {
                let exe = strip_verbatim_prefix(exe.to_path_buf());
                if cfg!(windows) {
                    exe.to_string_lossy()
                        .eq_ignore_ascii_case(&own_exe.to_string_lossy())
                } else {
                    exe == own_exe
                }
            })
    })
}

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

pub(crate) fn strip_verbatim_prefix(path: PathBuf) -> PathBuf {
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
    eprintln!("[single-instance] handoff received from a second launch");
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

    #[test]
    fn parses_long_and_short_version_flags() {
        for flag in ["--version", "-V"] {
            assert_eq!(
                parse_cli_action(&args(&["alethe", flag])),
                CliAction::PrintVersion
            );
        }
    }

    #[test]
    fn parses_long_and_short_help_flags() {
        for flag in ["--help", "-h"] {
            assert_eq!(
                parse_cli_action(&args(&["alethe", flag])),
                CliAction::PrintHelp
            );
        }
    }

    #[test]
    fn print_flags_work_after_paths_and_other_flags() {
        assert_eq!(
            parse_cli_action(&args(&["alethe", "--open-path", "/tmp/x", "--help"])),
            CliAction::PrintHelp
        );
        assert_eq!(
            parse_cli_action(&args(&["alethe", "/tmp/x", "-V"])),
            CliAction::PrintVersion
        );
    }

    #[test]
    fn unknown_flags_still_launch_gui() {
        assert_eq!(
            parse_cli_action(&args(&["alethe", "--unknown"])),
            CliAction::LaunchGui
        );
    }

    #[test]
    fn paths_and_open_path_values_are_not_print_actions() {
        assert_eq!(
            parse_cli_action(&args(&["alethe", "--open-path", "--version"])),
            CliAction::LaunchGui
        );
        assert_eq!(
            parse_cli_action(&args(&["alethe", "/tmp/--help"])),
            CliAction::LaunchGui
        );
        assert_eq!(
            cli_action_output(CliAction::PrintVersion),
            Some(format!("alethe {}\n", env!("CARGO_PKG_VERSION")))
        );
        assert!(cli_action_output(CliAction::PrintHelp)
            .unwrap()
            .contains("alethe --help"));
        assert!(cli_action_output(CliAction::PrintHelp)
            .unwrap()
            .contains("alethe update"));
        assert_eq!(cli_action_output(CliAction::LaunchGui), None);
        assert_eq!(cli_action_output(CliAction::Update), None);
    }

    #[test]
    fn parses_update_subcommand_and_preserves_help_version_precedence() {
        assert_eq!(
            parse_cli_action(&args(&["alethe", "update"])),
            CliAction::Update
        );
        assert_eq!(
            parse_cli_action(&args(&["alethe", "update", "--help"])),
            CliAction::PrintHelp
        );
        assert_eq!(
            parse_cli_action(&args(&["alethe", "update", "-V"])),
            CliAction::PrintVersion
        );
        assert_eq!(
            parse_cli_action(&args(&["alethe", "--open-path", "update"])),
            CliAction::LaunchGui
        );
        assert_eq!(
            parse_cli_action(&args(&["alethe", "--open-path=update"])),
            CliAction::LaunchGui
        );
        assert_eq!(
            parse_cli_action(&args(&["alethe", "/tmp/x", "update"])),
            CliAction::LaunchGui
        );
    }

    #[test]
    fn formats_update_outcomes_and_exit_behavior() {
        let up_to_date = format_update_outcome(Ok(CliUpdateReport::UpToDate {
            current_version: "1.7.0".to_string(),
        }));
        assert_eq!(up_to_date.code, 0);
        assert_eq!(up_to_date.stdout, "alethe 1.7.0 is already up to date.\n");
        assert!(up_to_date.stderr.is_empty());

        let updated = format_update_outcome(Ok(CliUpdateReport::Updated {
            from_version: "1.7.0".to_string(),
            to_version: "1.8.0".to_string(),
        }));
        assert_eq!(updated.code, 0);
        assert_eq!(updated.stdout, "Updated alethe from 1.7.0 to 1.8.0.\n");
        assert!(updated.stderr.is_empty());

        let blocked = format_update_outcome(Ok(CliUpdateReport::BlockedByRunningApp {
            available_version: "1.8.0".to_string(),
        }));
        assert_eq!(blocked.code, 1);
        assert!(blocked.stdout.is_empty());
        assert!(blocked
            .stderr
            .contains("alethe 1.8.0 is available, but Alethe is open."));

        assert_eq!(
            format_install_start("1.7.0", "1.8.0"),
            "Installing alethe 1.8.0 (currently 1.7.0)...\n"
        );

        let failed = format_update_outcome(Err("network unreachable".to_string()));
        assert_eq!(failed.code, 1);
        assert!(failed.stdout.is_empty());
        assert_eq!(failed.stderr, "alethe update failed: network unreachable\n");

        let version_exit = cli_immediate_exit(CliAction::PrintVersion).expect("version exit");
        assert_eq!(version_exit.code, 0);
        assert!(version_exit.stderr.is_empty());
        assert_eq!(cli_immediate_exit(CliAction::Update), None);
        assert_eq!(cli_immediate_exit(CliAction::LaunchGui), None);
    }

    #[test]
    fn another_process_of_the_same_executable_counts_as_a_running_app() {
        let own = Path::new("/opt/alethe/alethe");
        let other = Path::new("/usr/bin/other");
        assert!(is_other_instance(
            10,
            own,
            [(10, Some(own)), (11, Some(own))]
        ));
        assert!(!is_other_instance(
            10,
            own,
            [(10, Some(own)), (11, Some(other)), (12, None)]
        ));
    }

    #[cfg(windows)]
    #[test]
    fn running_app_match_ignores_case_and_verbatim_prefix_on_windows() {
        let own = Path::new(r"C:\Users\me\AppData\Local\Alethe\alethe.exe");
        let other = Path::new(r"\\?\C:\USERS\ME\AppData\Local\Alethe\ALETHE.EXE");
        assert!(is_other_instance(10, own, [(11, Some(other))]));
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
