//!
//! Equivalente ao "Install 'code' command in PATH" do VS Code: escreve um shim

//! `--open-path <dir>` (ver `cli_launch.rs`).
//!

//!

//!
//! | Plataforma      | Caminho                              | PATH                          |
//! |-----------------|--------------------------------------|-------------------------------|

//! | Windows         | `%LOCALAPPDATA%\Alethe\bin\alethe.cmd` | registrado em `HKCU\Environment` |
//!

use std::path::{Path, PathBuf};

use serde::Serialize;

#[cfg(windows)]
const SHIM_FILE_NAME: &str = "alethe.cmd";
#[cfg(not(windows))]
const SHIM_FILE_NAME: &str = "alethe";

#[derive(Serialize, Default)]
pub struct CliShimStatus {
    pub supported: bool,
    pub installed: bool,

    pub stale: bool,

    pub path: Option<String>,
    pub bin_dir: Option<String>,

    pub on_path: bool,
}

fn shim_bin_dir() -> Result<PathBuf, String> {
    #[cfg(windows)]
    {
        let base = dirs_next::data_local_dir()
            .ok_or_else(|| "não foi possível resolver LOCALAPPDATA".to_string())?;
        Ok(base.join("Alethe").join("bin"))
    }
    #[cfg(not(windows))]
    {
        let home =
            dirs_next::home_dir().ok_or_else(|| "não foi possível resolver o HOME".to_string())?;
        Ok(home.join(".local").join("bin"))
    }
}

fn shim_path() -> Result<PathBuf, String> {
    Ok(shim_bin_dir()?.join(SHIM_FILE_NAME))
}

fn current_binary() -> Result<PathBuf, String> {
    std::env::current_exe().map_err(|error| error.to_string())
}

#[cfg(target_os = "macos")]
fn app_bundle(binary: &Path) -> Option<PathBuf> {
    binary
        .ancestors()
        .find(|ancestor| ancestor.extension().and_then(|ext| ext.to_str()) == Some("app"))
        .map(|bundle| bundle.to_path_buf())
}

fn dir_on_path(dir: &Path) -> bool {
    if let Some(path_var) = std::env::var_os("PATH") {
        if std::env::split_paths(&path_var).any(|entry| entry == dir) {
            return true;
        }
    }

    #[cfg(windows)]
    {
        return windows_path::user_path_contains(dir);
    }

    #[cfg(not(windows))]
    false
}

#[cfg(not(windows))]
fn sh_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', r"'\''"))
}

#[cfg(not(windows))]
fn unix_shim_script(target_marker: &str, launch: &str, print_flags: &str) -> String {
    format!(
        r#"#!/bin/sh
# alethe — open a directory in Alethe from the terminal.
#
# Generated automatically by Alethe (Preferences > Integrations > Terminal
# command). Do not edit by hand: reinstall from there, especially after moving
# or reinstalling the app.
#
# alethe            -> open the current directory
# alethe .          -> same
# alethe ~/project  -> open the given directory
# alethe update     -> check for and install updates
#
# ALETHE_TARGET_BIN: {target_marker}

set -e

for arg in "$@"; do
  case "$arg" in
    --version|-V|--help|-h)
      exec {print_flags} "$@"
      ;;
  esac
done

case "${{1:-}}" in
  update|--version|-V|--help|-h)
    exec {print_flags} "$@"
    ;;
esac

target=${{1:-.}}

if [ ! -d "$target" ]; then
  echo "alethe: directory not found: $target" >&2
  exit 1
fi

# Absolute path: the app compares against saved project cwds.
target=$(cd "$target" && pwd)

{launch}
"#
    )
}

fn render_shim(binary: &Path) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        if let Some(bundle) = app_bundle(binary) {
            let quoted = sh_single_quote(&bundle.to_string_lossy());
            let quoted_binary = sh_single_quote(&binary.to_string_lossy());
            return Ok(unix_shim_script(
                &bundle.to_string_lossy(),
                &format!("exec open -na {quoted} --args --open-path \"$target\""),
                &quoted_binary,
            ));
        }
        let quoted = sh_single_quote(&binary.to_string_lossy());
        return Ok(unix_shim_script(
            &binary.to_string_lossy(),
            &format!(
                "nohup {quoted} --open-path \"$target\" >/dev/null 2>&1 &\n\
                 exit 0"
            ),
            &quoted,
        ));
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let quoted = sh_single_quote(&binary.to_string_lossy());
        return Ok(unix_shim_script(
            &binary.to_string_lossy(),
            &format!(
                "nohup {quoted} --open-path \"$target\" >/dev/null 2>&1 &\n\
                 exit 0"
            ),
            &quoted,
        ));
    }

    #[cfg(windows)]
    {
        let binary = binary.to_string_lossy().to_string();
        return Ok(format!(
            r#"@echo off
rem alethe - open a directory in Alethe from the terminal.
rem
rem Generated automatically by Alethe (Preferences > Integrations > Terminal
rem command). Do not edit by hand: reinstall from there, especially after moving
rem or reinstalling the app.
rem
rem ALETHE_TARGET_BIN: {binary}

setlocal
if "%~1"=="update" goto print_flags
if "%~1"=="--version" goto print_flags
if "%~1"=="-V" goto print_flags
if "%~1"=="--help" goto print_flags
if "%~1"=="-h" goto print_flags
for %%A in (%*) do (
  if "%%~A"=="--version" goto print_flags
  if "%%~A"=="-V" goto print_flags
  if "%%~A"=="--help" goto print_flags
  if "%%~A"=="-h" goto print_flags
)
set "target=%~1"
if "%target%"=="" set "target=%CD%"

rem Absolute path: the app compares against saved project cwds.
for %%I in ("%target%") do set "target=%%~fI"

if not exist "%target%\" (
  echo alethe: directory not found: %target% 1>&2
  exit /b 1
)

start "" "{binary}" --open-path "%target%"
goto :eof

:print_flags
"{binary}" %*
exit /b %errorlevel%
"#
        ));
    }

    #[cfg(not(any(unix, windows)))]
    {
        let _ = binary;
        Err("plataforma sem suporte a comando de terminal".to_string())
    }
}

fn shim_targets_binary(contents: &str, binary: &Path) -> bool {
    let Some(line) = contents
        .lines()
        .find_map(|line| line.split_once("ALETHE_TARGET_BIN:"))
        .map(|(_, rest)| rest.trim())
    else {
        return false;
    };
    #[cfg(target_os = "macos")]
    if let Some(bundle) = app_bundle(binary) {
        return line == bundle.to_string_lossy();
    }
    line == binary.to_string_lossy()
}

fn shim_is_stale(contents: &str, binary: &Path) -> bool {
    !shim_targets_binary(contents, binary)
        || render_shim(binary).is_ok_and(|fresh| fresh != contents)
}

fn build_status() -> Result<CliShimStatus, String> {
    let bin_dir = shim_bin_dir()?;
    let path = shim_path()?;
    let binary = current_binary()?;

    let contents = std::fs::read_to_string(&path).ok();
    let installed = contents.is_some();
    let stale = contents
        .map(|contents| shim_is_stale(&contents, &binary))
        .unwrap_or(false);

    Ok(CliShimStatus {
        supported: cfg!(any(unix, windows)),
        installed,
        stale,
        path: Some(path.to_string_lossy().to_string()),
        bin_dir: Some(bin_dir.to_string_lossy().to_string()),
        on_path: dir_on_path(&bin_dir),
    })
}

#[tauri::command]
pub fn cli_shim_status() -> Result<CliShimStatus, String> {
    build_status()
}

#[tauri::command]
pub fn cli_shim_install() -> Result<CliShimStatus, String> {
    let bin_dir = shim_bin_dir()?;
    let path = shim_path()?;
    let binary = current_binary()?;

    std::fs::create_dir_all(&bin_dir).map_err(|error| error.to_string())?;
    std::fs::write(&path, render_shim(&binary)?).map_err(|error| error.to_string())?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
            .map_err(|error| error.to_string())?;
    }

    #[cfg(windows)]
    {
        windows_path::add_to_user_path(&bin_dir)?;
        windows_path::add_to_process_path(&bin_dir);
    }

    build_status()
}

#[tauri::command]
pub fn cli_shim_uninstall() -> Result<CliShimStatus, String> {
    let path = shim_path()?;
    match std::fs::remove_file(&path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.to_string()),
    }

    #[cfg(windows)]
    windows_path::remove_from_user_path(&shim_bin_dir()?)?;

    build_status()
}

///

/// `REG_EXPAND_SZ` (comum, com entradas tipo `%USERPROFILE%\bin`) e a gente

#[cfg(windows)]
mod windows_path {
    use std::path::Path;

    use winreg::enums::{RegType, HKEY_CURRENT_USER, KEY_READ, KEY_WRITE};
    use winreg::types::FromRegValue;
    use winreg::{RegKey, RegValue};

    fn open_environment() -> Result<RegKey, String> {
        RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey_with_flags("Environment", KEY_READ | KEY_WRITE)
            .map_err(|error| error.to_string())
    }

    fn read_path(key: &RegKey) -> (String, RegType) {
        match key.get_raw_value("Path") {
            Ok(value) => {
                let vtype = value.vtype.clone();
                let text = String::from_reg_value(&value).unwrap_or_default();
                (text, vtype)
            }
            Err(_) => (String::new(), RegType::REG_EXPAND_SZ),
        }
    }

    fn write_path(key: &RegKey, value: &str, vtype: RegType) -> Result<(), String> {
        let mut bytes: Vec<u8> = value
            .encode_utf16()
            .flat_map(|unit| unit.to_ne_bytes())
            .collect();
        // Terminador UTF-16 — o registro guarda string larga com NUL final.
        bytes.extend_from_slice(&[0, 0]);
        key.set_raw_value("Path", &RegValue { bytes, vtype })
            .map_err(|error| error.to_string())
    }

    fn entries(path: &str) -> Vec<&str> {
        path.split(';')
            .filter(|entry| !entry.trim().is_empty())
            .collect()
    }

    pub fn user_path_contains(dir: &Path) -> bool {
        let Ok(key) = open_environment() else {
            return false;
        };
        let (current, _) = read_path(&key);
        let target = dir.to_string_lossy().to_string();
        entries(&current).iter().any(|entry| {
            entry
                .trim_end_matches('\\')
                .eq_ignore_ascii_case(target.trim_end_matches('\\'))
        })
    }

    pub fn add_to_user_path(dir: &Path) -> Result<(), String> {
        let key = open_environment()?;
        let (current, vtype) = read_path(&key);
        let target = dir.to_string_lossy().to_string();

        if entries(&current).iter().any(|entry| {
            entry
                .trim_end_matches('\\')
                .eq_ignore_ascii_case(target.trim_end_matches('\\'))
        }) {
            return Ok(());
        }

        let updated = if current.trim().is_empty() {
            target
        } else {
            format!("{};{}", current.trim_end_matches(';'), target)
        };
        write_path(&key, &updated, vtype)?;
        broadcast_environment_change();
        Ok(())
    }

    pub fn add_to_process_path(dir: &Path) {
        let Some(current) = std::env::var_os("PATH") else {
            std::env::set_var("PATH", dir);
            return;
        };
        if std::env::split_paths(&current).any(|entry| {
            entry
                .to_string_lossy()
                .trim_end_matches('\\')
                .eq_ignore_ascii_case(dir.to_string_lossy().trim_end_matches('\\'))
        }) {
            return;
        }
        let updated = format!("{};{}", current.to_string_lossy(), dir.to_string_lossy());
        std::env::set_var("PATH", updated);
    }

    pub fn remove_from_user_path(dir: &Path) -> Result<(), String> {
        let key = open_environment()?;
        let (current, vtype) = read_path(&key);
        let target = dir.to_string_lossy().to_string();
        let target = target.trim_end_matches('\\');

        let all = entries(&current);
        let kept: Vec<&str> = all
            .iter()
            .copied()
            .filter(|entry| !entry.trim_end_matches('\\').eq_ignore_ascii_case(target))
            .collect();

        if kept.len() == all.len() {
            return Ok(());
        }
        write_path(&key, &kept.join(";"), vtype)?;
        broadcast_environment_change();
        Ok(())
    }

    fn broadcast_environment_change() {
        use windows_sys::Win32::Foundation::{HWND, LPARAM, WPARAM};
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            SendMessageTimeoutW, HWND_BROADCAST, SMTO_ABORTIFHUNG, WM_SETTINGCHANGE,
        };

        let param: Vec<u16> = "Environment\0".encode_utf16().collect();
        unsafe {
            SendMessageTimeoutW(
                HWND_BROADCAST as HWND,
                WM_SETTINGCHANGE,
                0 as WPARAM,
                param.as_ptr() as LPARAM,
                SMTO_ABORTIFHUNG,
                5000,
                std::ptr::null_mut(),
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shim_mentions_target_binary() {
        let binary = PathBuf::from("/opt/alethe/alethe");
        let script = render_shim(&binary).expect("script");
        assert!(shim_targets_binary(&script, &binary));
    }

    #[test]
    fn stale_shim_is_detected() {
        let old = PathBuf::from("/opt/alethe-antigo/alethe");
        let script = render_shim(&old).expect("script");
        assert!(!shim_targets_binary(
            &script,
            Path::new("/opt/alethe-novo/alethe")
        ));
    }

    #[test]
    fn a_shim_written_by_an_older_release_counts_as_stale() {
        let binary = PathBuf::from("/opt/alethe/alethe");
        let current = render_shim(&binary).expect("script");
        assert!(!shim_is_stale(&current, &binary));
        let older = current.replacen("--version", "--ver", 1);
        assert!(shim_is_stale(&older, &binary));
    }

    #[test]
    fn shim_without_marker_counts_as_stale() {
        assert!(!shim_targets_binary(
            "#!/bin/sh\necho oi\n",
            Path::new("/opt/alethe/alethe")
        ));
    }

    #[cfg(not(windows))]
    #[test]
    fn shim_defaults_to_current_dir_and_is_a_posix_script() {
        let script = render_shim(Path::new("/opt/alethe/alethe")).expect("script");
        assert!(script.starts_with("#!/bin/sh"));

        assert!(script.contains("target=${1:-.}"));
        assert!(script.contains("--open-path"));
        assert!(script.contains("for arg in \"$@\"; do"));
        assert!(script.contains("update|--version|-V|--help|-h"));
        assert!(script.contains("exec '/opt/alethe/alethe' \"$@\""));
    }

    #[cfg(windows)]
    #[test]
    fn windows_shim_print_flags_run_in_foreground() {
        let script = render_shim(Path::new(r"C:\Alethe\alethe.exe")).expect("script");
        assert!(script.contains("if \"%~1\"==\"update\" goto print_flags"));
        assert!(script.contains("if \"%~1\"==\"--version\" goto print_flags"));
        assert!(script.contains("for %%A in (%*) do ("));
        assert!(script.contains(":print_flags"));
        assert!(script.contains("\"C:\\Alethe\\alethe.exe\" %*"));
        assert!(script.contains("exit /b %errorlevel%"));
    }

    #[cfg(not(windows))]
    #[test]
    fn generated_shim_is_valid_shell_syntax() {
        use std::io::Write;
        use std::process::Command;

        for binary in [
            "/opt/alethe/alethe",
            "/Applications/Alethe.app/Contents/MacOS/Alethe",
        ] {
            let script = render_shim(Path::new(binary)).expect("script");
            let file = std::env::temp_dir().join(format!(
                "alethe-shim-syntax-{}.sh",
                binary.replace(['/', '.'], "_")
            ));
            std::fs::File::create(&file)
                .and_then(|mut handle| handle.write_all(script.as_bytes()))
                .expect("escrever shim");

            let output = Command::new("sh")
                .arg("-n")
                .arg(&file)
                .output()
                .expect("rodar sh -n");
            let _ = std::fs::remove_file(&file);

            assert!(
                output.status.success(),
                "shim inválido para {binary}: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
    }

    #[cfg(not(windows))]
    #[test]
    fn single_quotes_in_path_are_escaped() {
        let script = render_shim(Path::new("/opt/alethe's app/alethe")).expect("script");

        assert!(script.contains(r"'\''"));
    }
}
