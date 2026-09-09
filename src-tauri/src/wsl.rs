//! A terminal is a WSL terminal iff its cwd is a WSL UNC path
//! (`\\wsl.localhost\<distro>\...` or the legacy `\\wsl$\<distro>\...`), so nothing about
//! WSL is persisted: the distro is parsed straight out of the path.

use portable_pty::CommandBuilder;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WslPath {
    pub distro: String,
    pub linux_path: String,
}

/// A value memoized for `ttl`. A poisoned mutex degrades to a miss, never a panic.
struct TtlCache<K, V> {
    ttl: Duration,
    entries: OnceLock<Mutex<HashMap<K, (Instant, V)>>>,
}

impl<K, V> TtlCache<K, V> {
    const fn new(ttl: Duration) -> Self {
        Self {
            ttl,
            entries: OnceLock::new(),
        }
    }
}

impl<K: Eq + std::hash::Hash, V: Clone> TtlCache<K, V> {
    fn entries(&self) -> &Mutex<HashMap<K, (Instant, V)>> {
        self.entries.get_or_init(|| Mutex::new(HashMap::new()))
    }

    fn get(&self, key: &K) -> Option<V> {
        let guard = self.entries().lock().ok()?;
        let (stamp, value) = guard.get(key)?;
        (stamp.elapsed() < self.ttl).then(|| value.clone())
    }

    fn insert(&self, key: K, value: V) {
        if let Ok(mut guard) = self.entries().lock() {
            guard.insert(key, (Instant::now(), value));
        }
    }

    fn clear(&self) {
        if let Ok(mut guard) = self.entries().lock() {
            guard.clear();
        }
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.entries().lock().map(|guard| guard.len()).unwrap_or(0)
    }
}

/// The `wsl` feature preference, pushed from the frontend. Off means a WSL cwd behaves exactly
/// as it did before the integration existed.
static WSL_INTEGRATION_ENABLED: AtomicBool = AtomicBool::new(true);

pub fn integration_enabled() -> bool {
    WSL_INTEGRATION_ENABLED.load(Ordering::Relaxed)
}

pub fn set_integration_enabled(enabled: bool) {
    if WSL_INTEGRATION_ENABLED.swap(enabled, Ordering::Relaxed) == enabled {
        return;
    }
    // Every probe below memoizes; a value cached under the previous state must never be served
    // under the new one.
    clear_probe_caches();
}

fn clear_probe_caches() {
    DISTRO_CACHE.clear();
    CLI_CACHE.clear();
    HOME_CACHE.clear();
    #[cfg(windows)]
    LOGIN_SHELL_CACHE.clear();
}

#[cfg(test)]
pub(crate) static TOGGLE_LOCK: Mutex<()> = Mutex::new(());

/// The single gate every WSL decision point goes through: `None` while the integration is off.
pub fn wsl_target(cwd: &str) -> Option<WslPath> {
    if !integration_enabled() {
        return None;
    }
    parse_wsl_unc(cwd)
}

pub fn parse_wsl_unc(path: &str) -> Option<WslPath> {
    let normalized = path.trim().replace('\\', "/");
    let rest = normalized.strip_prefix("//")?;

    let mut segments = rest.split('/').filter(|segment| !segment.is_empty());
    let host = segments.next()?;
    if !host.eq_ignore_ascii_case("wsl.localhost") && !host.eq_ignore_ascii_case("wsl$") {
        return None;
    }

    let distro = segments.next()?;
    let tail: Vec<&str> = segments.collect();
    let linux_path = if tail.is_empty() {
        "/".to_string()
    } else {
        format!("/{}", tail.join("/"))
    };

    Some(WslPath {
        distro: distro.to_string(),
        linux_path,
    })
}

/// Older WSL builds ignore `WSL_UTF8` and still answer in UTF-16LE.
fn looks_utf16le(stdout: &[u8]) -> bool {
    let odd_bytes = stdout.len() / 2;
    let nuls = stdout
        .iter()
        .skip(1)
        .step_by(2)
        .filter(|b| **b == 0)
        .count();
    odd_bytes > 0 && nuls * 2 > odd_bytes
}

pub fn parse_distro_list(stdout: &[u8]) -> Vec<String> {
    let text = if looks_utf16le(stdout) {
        let units: Vec<u16> = stdout
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect();
        String::from_utf16_lossy(&units)
    } else {
        String::from_utf8_lossy(stdout).into_owned()
    };
    text.lines()
        .map(|line| line.trim_matches(|c: char| c == '\0' || c.is_whitespace()))
        .filter(|line| !line.is_empty())
        // A distro name never contains whitespace, so a diagnostic sentence is not one.
        .filter(|line| !line.chars().any(char::is_whitespace))
        .filter(|line| !line.to_ascii_lowercase().starts_with("docker-desktop"))
        .map(|line| line.to_string())
        .collect()
}

const DISTRO_CACHE_TTL: Duration = Duration::from_secs(30);
static DISTRO_CACHE: TtlCache<(), Vec<String>> = TtlCache::new(DISTRO_CACHE_TTL);

pub fn installed_distros() -> Vec<String> {
    if !integration_enabled() {
        return Vec::new();
    }

    if let Some(distros) = DISTRO_CACHE.get(&()) {
        return distros;
    }

    let distros = query_installed_distros();
    DISTRO_CACHE.insert((), distros.clone());
    distros
}

#[cfg(not(windows))]
fn query_installed_distros() -> Vec<String> {
    Vec::new()
}

#[cfg(windows)]
fn query_installed_distros() -> Vec<String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let Ok(output) = std::process::Command::new("wsl.exe")
        .args(["-l", "-q"])
        .env("WSL_UTF8", "1")
        .creation_flags(CREATE_NO_WINDOW)
        .output()
    else {
        return Vec::new();
    };

    if !output.status.success() {
        return Vec::new();
    }

    parse_distro_list(&output.stdout)
}

pub const PROBE_MARKER: &str = "__alethe_probe__";

pub fn probe_value(probe_output: &str) -> Option<String> {
    let mut lines = probe_output
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty());
    if let Some(value) = lines
        .clone()
        .filter_map(|line| line.strip_prefix(PROBE_MARKER))
        .next_back()
    {
        let value = value.trim();
        return (!value.is_empty()).then(|| value.to_string());
    }
    lines.next_back().map(str::to_string)
}

/// UNC root of a distro's filesystem.
pub fn distro_root_unc(distro: &str) -> String {
    format!(r"\\wsl.localhost\{distro}")
}

/// UNC path of `$HOME` inside `distro`, built from the raw probe stdout.
pub fn home_unc(distro: &str, probe_output: &str) -> Option<String> {
    let distro = distro.trim();
    if distro.is_empty() {
        return None;
    }

    let home = probe_value(probe_output).filter(|line| line.starts_with('/'))?;

    let tail = home.trim_matches('/').replace('/', "\\");
    let root = distro_root_unc(distro);
    if tail.is_empty() {
        Some(root)
    } else {
        Some(format!(r"{root}\{tail}"))
    }
}

const CLI_CACHE_TTL: Duration = Duration::from_secs(300);
static CLI_CACHE: TtlCache<(String, String), Option<String>> = TtlCache::new(CLI_CACHE_TTL);

/// The command name arrives as `$1`, never interpolated into the script.
const PROBE: &str = r#"
# Without this zsh aborts the whole script on the unmatched nvm glob below, before `command -v`
# ever runs. `setopt` is not a builtin in sh or bash, where the failure is discarded instead.
setopt no_nomatch 2>/dev/null || true
[ -r /etc/profile ] && . /etc/profile >/dev/null 2>&1
[ -r "$HOME/.profile" ] && . "$HOME/.profile" >/dev/null 2>&1
for d in "$HOME/.local/bin" "$HOME/.bun/bin" "$HOME/.cargo/bin" "$HOME/.local/share/pnpm" "$HOME/.volta/bin" "$HOME/.opencode/bin" "$HOME/.npm-global/bin" "$HOME/.local/share/mise/shims" "$HOME/.asdf/shims" "$HOME"/.nvm/versions/node/*/bin; do
  [ -d "$d" ] && PATH="$d:$PATH"
done
export PATH
resolved=$(command -v -- "$1") || exit 1
printf '%s%s\n' "$0" "$resolved"
"#;

pub fn probe_command_args(shell: &str, interactive: bool, command: &str) -> Vec<String> {
    let shell = shell.trim();
    let (program, flags) = if interactive && shell.starts_with('/') {
        (shell, "-lic")
    } else if interactive {
        ("/bin/sh", "-lic")
    } else {
        ("/bin/sh", "-lc")
    };

    vec![
        "-e".to_string(),
        program.to_string(),
        flags.to_string(),
        PROBE.to_string(),
        PROBE_MARKER.to_string(),
        command.to_string(),
    ]
}

const EXEC_RESOLVED: &str = r#"exec "$0" "$@""#;

pub fn resolved_command_args(shell: &str, resolved: &str, extra_args: &[String]) -> Vec<String> {
    let (program, flags) = posix_login_shell(shell);

    let mut args = vec![
        "-e".to_string(),
        program,
        flags.to_string(),
        EXEC_RESOLVED.to_string(),
        resolved.to_string(),
    ];
    args.extend(extra_args.iter().cloned());
    args
}

const POSIX_SHELLS: [&str; 9] = [
    "sh", "bash", "dash", "ash", "zsh", "ksh", "ksh93", "mksh", "yash",
];

pub(crate) fn posix_login_shell(shell: &str) -> (String, &'static str) {
    let shell = shell.trim();
    let name = shell.rsplit('/').next().unwrap_or_default();
    if shell.starts_with('/') && POSIX_SHELLS.contains(&name) {
        (shell.to_string(), "-lic")
    } else {
        ("/bin/sh".to_string(), "-lc")
    }
}

/// Field 7 of a `getent passwd` line: the account's login shell.
pub fn parse_login_shell(getent_output: &str) -> Option<String> {
    let line = probe_value(getent_output)?;
    let fields: Vec<&str> = line.split(':').collect();
    let shell = fields.get(6)?.trim();
    if shell.starts_with('/') {
        Some(shell.to_string())
    } else {
        None
    }
}

/// Interop puts the Windows PATH on the guest PATH, so `command -v` can answer with a Windows
/// binary under `/mnt/<drive>`, which cannot run inside the distro.
fn is_windows_drive_mount(path: &str) -> bool {
    let Some(rest) = path.strip_prefix("/mnt/") else {
        return false;
    };
    let drive = rest.split('/').next().unwrap_or_default();
    drive.len() == 1 && drive.starts_with(|c: char| c.is_ascii_alphabetic())
}

pub fn probe_resolved_path(probe_output: &str) -> Option<String> {
    probe_value(probe_output)
        .filter(|line| line.starts_with('/'))
        .filter(|line| !is_windows_drive_mount(line))
}

fn is_valid_command_name(command: &str) -> bool {
    !command.is_empty()
        && command
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
}

pub fn find_cli_in_distro(distro: &str, command: &str) -> Option<String> {
    resolve_cli_in_distro(distro, command, false)
}

pub fn resolve_cli_in_distro(distro: &str, command: &str, refresh: bool) -> Option<String> {
    if !integration_enabled() {
        return None;
    }
    if distro.trim().is_empty() || !is_valid_command_name(command) {
        return None;
    }

    let key = (distro.to_string(), command.to_string());
    if !refresh {
        if let Some(resolved) = CLI_CACHE.get(&key) {
            return resolved;
        }
    }

    let resolved = probe_cli_in_distro(distro, command);
    CLI_CACHE.insert(key, resolved.clone());
    resolved
}

#[cfg(not(windows))]
fn probe_cli_in_distro(_distro: &str, _command: &str) -> Option<String> {
    None
}

#[cfg(windows)]
const PROBE_TIMEOUT: Duration = Duration::from_secs(6);

#[cfg(windows)]
pub(crate) struct WslOutput {
    pub success: bool,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

#[cfg(windows)]
pub(crate) fn wsl_output(distro: &str, args: &[String], timeout: Duration) -> Option<WslOutput> {
    use std::io::Read;
    use std::os::windows::process::CommandExt;
    use std::process::Stdio;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let mut child = std::process::Command::new("wsl.exe")
        .arg("-d")
        .arg(distro)
        .args(args)
        .env("WSL_UTF8", "1")
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .ok()?;

    let mut child_stdout = child.stdout.take()?;
    let mut child_stderr = child.stderr.take()?;
    let (out_sender, out_receiver) = std::sync::mpsc::channel();
    let (err_sender, err_receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut buffer = Vec::new();
        let _ = child_stdout.read_to_end(&mut buffer);
        let _ = out_sender.send(buffer);
    });
    std::thread::spawn(move || {
        let mut buffer = Vec::new();
        let _ = child_stderr.read_to_end(&mut buffer);
        let _ = err_sender.send(buffer);
    });

    let deadline = Instant::now() + timeout;
    let Ok(stdout) = out_receiver.recv_timeout(timeout) else {
        let _ = child.kill();
        let _ = child.wait();
        return None;
    };
    let remaining = deadline.saturating_duration_since(Instant::now());
    let stderr = err_receiver.recv_timeout(remaining).unwrap_or_default();
    let success = wait_until(&mut child, deadline)?;

    Some(WslOutput {
        success,
        stdout,
        stderr,
    })
}

/// `None` when the child outlived the deadline, in which case it is killed and reaped.
#[cfg(windows)]
fn wait_until(child: &mut std::process::Child, deadline: Instant) -> Option<bool> {
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Some(status.success()),
            Ok(None) => {}
            Err(_) => return None,
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return None;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[cfg(windows)]
fn wsl_stdout(distro: &str, args: &[String], timeout: Duration) -> Option<Vec<u8>> {
    wsl_output(distro, args, timeout).map(|output| output.stdout)
}

#[cfg(not(windows))]
pub(crate) fn distro_login_shell(_distro: &str) -> String {
    "/bin/sh".to_string()
}

#[cfg(windows)]
static LOGIN_SHELL_CACHE: TtlCache<String, String> = TtlCache::new(CLI_CACHE_TTL);

#[cfg(windows)]
pub(crate) fn distro_login_shell(distro: &str) -> String {
    let key = distro.to_string();
    if let Some(shell) = LOGIN_SHELL_CACHE.get(&key) {
        return shell;
    }

    let args = [
        "-e".to_string(),
        "/bin/sh".to_string(),
        "-lc".to_string(),
        r#"printf '%s%s\n' "$0" "$(getent passwd "$(id -un)")""#.to_string(),
        PROBE_MARKER.to_string(),
    ];
    let shell = wsl_stdout(distro, &args, PROBE_TIMEOUT)
        .and_then(|stdout| parse_login_shell(&String::from_utf8_lossy(&stdout)))
        .unwrap_or_else(|| "/bin/sh".to_string());

    LOGIN_SHELL_CACHE.insert(key, shell.clone());
    shell
}

#[cfg(windows)]
fn probe_cli_in_distro(distro: &str, command: &str) -> Option<String> {
    let shell = distro_login_shell(distro);
    for interactive in [true, false] {
        let args = probe_command_args(&shell, interactive, command);
        let Some(output) = wsl_output(distro, &args, PROBE_TIMEOUT) else {
            continue;
        };
        if !output.success {
            continue;
        }
        // `WSL_UTF8=1` keeps wsl.exe's own error text UTF-8 too, so this read never sees UTF-16LE.
        let resolved = probe_resolved_path(&String::from_utf8_lossy(&output.stdout));
        if resolved.is_some() {
            return resolved;
        }
    }
    None
}

static HOME_CACHE: TtlCache<String, Option<String>> = TtlCache::new(CLI_CACHE_TTL);

/// UNC path of the distro's home directory. Cached for 5 minutes, negatives included.
pub fn distro_home_unc(distro: &str) -> Option<String> {
    if !integration_enabled() {
        return None;
    }
    if distro.trim().is_empty() {
        return None;
    }

    let key = distro.to_string();
    if let Some(resolved) = HOME_CACHE.get(&key) {
        return resolved;
    }

    let resolved = probe_home(distro).and_then(|output| home_unc(distro, &output));
    HOME_CACHE.insert(key, resolved.clone());
    resolved
}

#[cfg(not(windows))]
fn probe_home(_distro: &str) -> Option<String> {
    None
}

#[cfg(windows)]
fn probe_home(distro: &str) -> Option<String> {
    // The marker travels as `$0`, so nothing is interpolated into the script.
    let args = [
        "-e",
        "/bin/sh",
        "-lc",
        r#"printf '%s%s\n' "$0" "$HOME""#,
        PROBE_MARKER,
    ]
    .map(str::to_string);
    let stdout = wsl_stdout(distro, &args, PROBE_TIMEOUT)?;
    Some(String::from_utf8_lossy(&stdout).to_string())
}

pub fn command_builder_for_wsl(
    target: &WslPath,
    initial_command: Option<&str>,
    extra_args: &[String],
    env: Option<&HashMap<String, String>>,
) -> CommandBuilder {
    let mut builder = CommandBuilder::new("wsl.exe");
    builder.arg("-d");
    builder.arg(&target.distro);

    let trimmed = initial_command
        .map(str::trim)
        .filter(|value| !value.is_empty());

    if let Some(command) = trimmed {
        match find_cli_in_distro(&target.distro, command) {
            Some(resolved) => {
                let shell = distro_login_shell(&target.distro);
                for arg in resolved_command_args(&shell, &resolved, extra_args) {
                    builder.arg(arg);
                }
            }
            None => {
                let mut line = format!("exec {}", shell_quote(command));
                for arg in extra_args {
                    line.push(' ');
                    line.push_str(&shell_quote(arg));
                }
                builder.arg("-e");
                builder.arg("/bin/sh");
                builder.arg("-lc");
                builder.arg(line);
            }
        }
    }

    builder.env("TERM", "xterm-256color");
    builder.env("COLORTERM", "truecolor");
    // Without it `wsl.exe` writes its own messages and errors as UTF-16LE.
    builder.env("WSL_UTF8", "1");
    if let Some(extra_env) = env {
        for (key, value) in extra_env {
            builder.env(key, value);
        }
    }

    let mut wslenv = Vec::<String>::new();
    if let Ok(existing) = std::env::var("WSLENV") {
        for entry in existing.split(':') {
            push_wslenv(&mut wslenv, entry, false);
        }
    }
    push_wslenv(&mut wslenv, "TERM", true);
    push_wslenv(&mut wslenv, "COLORTERM", true);
    if let Some(extra_env) = env {
        for key in extra_env.keys() {
            push_wslenv(&mut wslenv, key, true);
        }
    }
    builder.env("WSLENV", wslenv.join(":"));

    builder
}

const NEVER_CROSS: [&str; 5] = ["PATH", "HOME", "TMP", "TEMP", "WSLENV"];

fn push_wslenv(list: &mut Vec<String>, entry: &str, own: bool) {
    let entry = entry.trim();
    let name = entry.split('/').next().unwrap_or_default();
    if name.is_empty()
        || NEVER_CROSS
            .iter()
            .any(|blocked| name.eq_ignore_ascii_case(blocked))
    {
        return;
    }
    match list
        .iter()
        .position(|existing| existing.split('/').next().unwrap_or_default() == name)
    {
        Some(index) if own => list[index] = entry.to_string(),
        Some(_) => {}
        None => list.push(entry.to_string()),
    }
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', r"'\''"))
}

#[tauri::command]
pub fn set_wsl_integration_enabled(enabled: bool) {
    set_integration_enabled(enabled);
}

#[tauri::command]
pub async fn list_wsl_distros() -> Vec<String> {
    tokio::task::spawn_blocking(installed_distros)
        .await
        .unwrap_or_default()
}

#[tauri::command]
pub async fn find_wsl_cli(
    distro: String,
    command: String,
    refresh: Option<bool>,
) -> Option<String> {
    tokio::task::spawn_blocking(move || {
        resolve_cli_in_distro(&distro, &command, refresh.unwrap_or(false))
    })
    .await
    .unwrap_or(None)
}

#[tauri::command]
pub async fn wsl_distro_home(distro: String) -> Option<String> {
    tokio::task::spawn_blocking(move || distro_home_unc(&distro))
        .await
        .unwrap_or(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_both_hosts_case_insensitively_and_both_slash_directions() {
        assert_eq!(
            parse_wsl_unc(r"\\wsl.localhost\Ubuntu\home\dev\projects"),
            Some(WslPath {
                distro: "Ubuntu".into(),
                linux_path: "/home/dev/projects".into(),
            })
        );
        assert_eq!(
            parse_wsl_unc(r"\\wsl$\Debian\etc"),
            Some(WslPath {
                distro: "Debian".into(),
                linux_path: "/etc".into(),
            })
        );
        assert_eq!(
            parse_wsl_unc(r"\\WSL.LOCALHOST\Ubuntu-22.04\srv"),
            Some(WslPath {
                distro: "Ubuntu-22.04".into(),
                linux_path: "/srv".into(),
            })
        );
        assert_eq!(
            parse_wsl_unc("//wsl.localhost/Ubuntu/home/x"),
            Some(WslPath {
                distro: "Ubuntu".into(),
                linux_path: "/home/x".into(),
            })
        );
    }

    #[test]
    fn maps_a_distro_only_path_to_root_and_tolerates_duplicated_separators() {
        assert_eq!(
            parse_wsl_unc(r"\\wsl.localhost\Ubuntu"),
            Some(WslPath {
                distro: "Ubuntu".into(),
                linux_path: "/".into(),
            })
        );
        assert_eq!(
            parse_wsl_unc("\\\\wsl.localhost\\Ubuntu\\"),
            Some(WslPath {
                distro: "Ubuntu".into(),
                linux_path: "/".into(),
            })
        );
        assert_eq!(
            parse_wsl_unc("\\\\wsl.localhost\\Ubuntu\\\\home\\\\dev\\"),
            Some(WslPath {
                distro: "Ubuntu".into(),
                linux_path: "/home/dev".into(),
            })
        );
    }

    #[test]
    fn rejects_anything_that_is_not_a_wsl_unc_path() {
        assert_eq!(parse_wsl_unc(r"\\server\share"), None);
        assert_eq!(parse_wsl_unc(r"C:\Users\x"), None);
        assert_eq!(parse_wsl_unc("/home/dev"), None);
        assert_eq!(parse_wsl_unc(""), None);
        assert_eq!(parse_wsl_unc("   "), None);
        assert_eq!(parse_wsl_unc(r"\\wsl.localhost"), None);
        assert_eq!(parse_wsl_unc("\\\\wsl$\\"), None);
    }

    #[test]
    fn builds_the_home_unc_path_from_the_probe_output() {
        assert_eq!(
            home_unc("Ubuntu", "/home/dev\n"),
            Some(r"\\wsl.localhost\Ubuntu\home\dev".to_string())
        );
        assert_eq!(
            home_unc("Ubuntu", "\n   \n  /root  \n/home/dev\n"),
            Some(r"\\wsl.localhost\Ubuntu\home\dev".to_string())
        );
        assert_eq!(
            home_unc("Ubuntu", "/"),
            Some(r"\\wsl.localhost\Ubuntu".to_string())
        );
    }

    #[test]
    fn reads_the_home_past_a_login_profile_banner() {
        assert_eq!(
            home_unc(
                "Ubuntu",
                "Welcome to Ubuntu 22.04\n__alethe_probe__/home/dev\n"
            ),
            Some(r"\\wsl.localhost\Ubuntu\home\dev".to_string())
        );
        assert_eq!(
            home_unc("Ubuntu", "Welcome to Ubuntu 22.04\n/home/dev\n"),
            Some(r"\\wsl.localhost\Ubuntu\home\dev".to_string())
        );
    }

    #[test]
    fn reads_the_login_shell_past_a_login_profile_banner() {
        assert_eq!(
            parse_login_shell(
                "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/games\n__alethe_probe__dev:x:1000:1000::/home/dev:/usr/bin/zsh\n"
            ),
            Some("/usr/bin/zsh".to_string())
        );
    }

    #[test]
    fn rejects_a_probe_output_that_is_not_an_absolute_home() {
        assert_eq!(home_unc("Ubuntu", ""), None);
        assert_eq!(home_unc("Ubuntu", "   \n\n"), None);
        assert_eq!(home_unc("Ubuntu", "home/dev"), None);
        assert_eq!(home_unc("Ubuntu", "sh: 1: HOME: not found"), None);
        assert_eq!(home_unc("", "/home/dev"), None);
        assert_eq!(home_unc("   ", "/home/dev"), None);
    }

    fn utf16le(text: &str) -> Vec<u8> {
        text.encode_utf16().flat_map(u16::to_le_bytes).collect()
    }

    #[test]
    fn decodes_the_distro_listing_and_drops_docker_utility_distros() {
        let stdout = utf16le("Ubuntu\r\ndocker-desktop\r\ndocker-desktop-data\r\nDebian\r\n");
        assert_eq!(parse_distro_list(&stdout), vec!["Ubuntu", "Debian"]);
    }

    #[test]
    fn drops_a_diagnostic_line_that_cannot_be_a_distro_name() {
        let stdout = b"There are no installed distributions.\r\n";
        assert_eq!(parse_distro_list(stdout), Vec::<String>::new());
        let mixed = b"Ubuntu\r\nWindows Subsystem for Linux has no installed distributions.\r\nUbuntu-22.04\r\n";
        assert_eq!(parse_distro_list(mixed), vec!["Ubuntu", "Ubuntu-22.04"]);
    }

    #[test]
    fn decodes_a_utf8_distro_listing_the_same_way() {
        let stdout = b"Ubuntu\r\ndocker-desktop\r\nDebian\r\n";
        assert_eq!(parse_distro_list(stdout), vec!["Ubuntu", "Debian"]);
    }

    #[test]
    fn reads_the_login_shell_from_the_getent_passwd_line() {
        assert_eq!(
            parse_login_shell("dev:x:1000:1000::/home/dev:/usr/bin/zsh\n"),
            Some("/usr/bin/zsh".to_string())
        );
        assert_eq!(
            parse_login_shell("dev:x:1000:1000:Dev User,,,:/home/dev:/bin/bash"),
            Some("/bin/bash".to_string())
        );
    }

    #[test]
    fn rejects_a_getent_line_without_a_usable_shell_field() {
        assert_eq!(parse_login_shell(""), None);
        assert_eq!(parse_login_shell("   \n\n"), None);
        assert_eq!(parse_login_shell("dev:x:1000:1000::/home/dev:"), None);
        assert_eq!(parse_login_shell("dev:x:1000:1000::/home/dev"), None);
        assert_eq!(
            parse_login_shell("dev:x:1000:1000::/home/dev:usr/bin/zsh"),
            None
        );
    }

    #[test]
    fn the_interactive_probe_runs_the_discovered_login_shell_with_lic() {
        let args = probe_command_args("/usr/bin/zsh", true, "opencode");
        assert_eq!(args[0], "-e");
        assert_eq!(args[1], "/usr/bin/zsh");
        assert_eq!(args[2], "-lic");
        assert_eq!(args.last().map(String::as_str), Some("opencode"));
    }

    #[test]
    fn the_fallback_probe_runs_bin_sh_with_lc() {
        let args = probe_command_args("/usr/bin/zsh", false, "opencode");
        assert_eq!(args[0], "-e");
        assert_eq!(args[1], "/bin/sh");
        assert_eq!(args[2], "-lc");
        assert_eq!(args.last().map(String::as_str), Some("opencode"));
    }

    #[test]
    fn an_unusable_login_shell_falls_back_to_bin_sh() {
        assert_eq!(probe_command_args("", true, "opencode")[1], "/bin/sh");
        assert_eq!(probe_command_args("   ", true, "opencode")[1], "/bin/sh");
    }

    #[test]
    fn the_probe_script_prepends_the_rc_file_manager_directories() {
        let script = probe_command_args("/bin/sh", false, "opencode")[3].clone();
        for dir in [
            "$HOME/.opencode/bin",
            "$HOME/.npm-global/bin",
            "$HOME/.local/share/mise/shims",
            "$HOME/.asdf/shims",
            "$HOME/.local/bin",
        ] {
            assert!(script.contains(dir), "{dir} must be on the probe PATH");
        }
    }

    #[cfg(unix)]
    fn run_probe(shell: &str, home: &std::path::Path, command: &str) -> Option<String> {
        if !std::path::Path::new(shell).exists() {
            return None;
        }
        let args = probe_command_args("/bin/sh", false, command);
        let output = std::process::Command::new(shell)
            .arg("-c")
            .args(&args[3..])
            .env("HOME", home)
            .env("PATH", home.join("elsewhere").display().to_string())
            .output()
            .expect("the probe shell must run");
        Some(String::from_utf8_lossy(&output.stdout).to_string())
    }

    #[cfg(unix)]
    fn stub_cli(home: &std::path::Path, dir: &str) -> String {
        use std::os::unix::fs::PermissionsExt;

        let dir = home.join(dir);
        std::fs::create_dir_all(&dir).expect("the stub directory must be creatable");
        let file = dir.join("acmecli");
        std::fs::write(&file, "#!/bin/sh\n").expect("the stub CLI must be writable");
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o755))
            .expect("the stub CLI must be executable");
        file.display().to_string()
    }

    #[cfg(unix)]
    fn probe_home_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("alethe-probe-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("the probe home must be creatable");
        dir
    }

    #[cfg(unix)]
    const PROBE_SHELLS: [&str; 3] = ["/bin/sh", "/bin/bash", "/usr/bin/zsh"];

    #[cfg(unix)]
    #[test]
    fn the_probe_reaches_command_v_with_no_version_manager_directory_present() {
        let home = probe_home_dir("bare");
        // Reachable through PATH alone: none of the directories the script prepends exists.
        let expected = stub_cli(&home, "elsewhere");
        let mut ran = 0;
        for shell in PROBE_SHELLS {
            let Some(stdout) = run_probe(shell, &home, "acmecli") else {
                continue;
            };
            ran += 1;
            assert_eq!(
                probe_resolved_path(&stdout),
                Some(expected.clone()),
                "{shell} must still print the marker line, got {stdout:?}"
            );
        }
        assert!(ran > 0, "no probe shell was available to run this test");
    }

    #[cfg(unix)]
    #[test]
    fn the_probe_finds_a_cli_under_a_manager_directory_that_does_exist() {
        let home = probe_home_dir("managers");
        stub_cli(&home, ".local/bin");
        let expected = stub_cli(&home, ".nvm/versions/node/v22.0.0/bin");

        let mut ran = 0;
        for shell in PROBE_SHELLS {
            let Some(stdout) = run_probe(shell, &home, "acmecli") else {
                continue;
            };
            ran += 1;
            // `.local/bin` is prepended before the nvm entry, so the nvm one wins.
            assert_eq!(
                probe_resolved_path(&stdout),
                Some(expected.clone()),
                "{shell} must prepend the manager directories"
            );
        }
        assert!(ran > 0, "no probe shell was available to run this test");
    }

    #[test]
    fn a_resolved_cli_launches_through_the_login_shell_with_argv_kept_apart() {
        let extras = vec!["--resume".to_string(), "it's me".to_string()];
        let args = resolved_command_args("/usr/bin/zsh", "/home/dev/.local/bin/codex", &extras);
        assert_eq!(
            args,
            vec![
                "-e",
                "/usr/bin/zsh",
                "-lic",
                r#"exec "$0" "$@""#,
                "/home/dev/.local/bin/codex",
                "--resume",
                "it's me",
            ]
        );
    }

    #[test]
    fn an_unusable_login_shell_falls_back_to_bin_sh_for_the_resolved_cli() {
        assert_eq!(
            resolved_command_args("", "/usr/bin/claude", &[])[1],
            "/bin/sh"
        );
        assert_eq!(
            resolved_command_args("usr/bin/zsh", "/usr/bin/claude", &[])[1],
            "/bin/sh"
        );
    }

    #[test]
    fn the_cli_probe_reads_the_resolved_path_past_rc_file_chatter() {
        assert_eq!(
            probe_resolved_path(
                "direnv: loading ~/.envrc\n/home/dev\n__alethe_probe__/home/dev/.local/bin/opencode\n"
            ),
            Some("/home/dev/.local/bin/opencode".to_string())
        );
        // A shell builtin or an alias is not a binary this launcher can exec.
        assert_eq!(probe_resolved_path("__alethe_probe__opencode\n"), None);
        assert_eq!(probe_resolved_path("mise: no such command\n"), None);
    }

    #[test]
    fn the_cli_probe_rejects_a_windows_install_reached_through_a_drive_mount() {
        // Interop puts the Windows PATH on the guest PATH, so `command -v` can answer with the
        // Windows npm-global install, which ships the win32 binary and dies inside the distro.
        assert_eq!(
            probe_resolved_path("__alethe_probe__/mnt/c/Users/dev/AppData/Roaming/npm/codex\n"),
            None
        );
        assert_eq!(
            probe_resolved_path("__alethe_probe__/mnt/D/tools/codex\n"),
            None
        );
    }

    #[test]
    fn the_cli_probe_still_resolves_a_guest_install() {
        assert_eq!(
            probe_resolved_path(
                "direnv: loading ~/.envrc\n__alethe_probe__/home/dev/.local/share/pi-node/node-v22/bin/codex\n"
            ),
            Some("/home/dev/.local/share/pi-node/node-v22/bin/codex".to_string())
        );
        assert_eq!(
            probe_resolved_path("/home/dev/.local/share/pi-node/node-v22/bin/codex\n"),
            Some("/home/dev/.local/share/pi-node/node-v22/bin/codex".to_string())
        );
    }

    #[test]
    fn the_cli_probe_keeps_an_ordinary_multi_character_mount() {
        assert_eq!(
            probe_resolved_path("__alethe_probe__/mnt/data/tools/codex\n"),
            Some("/mnt/data/tools/codex".to_string())
        );
        assert_eq!(
            probe_resolved_path("__alethe_probe__/mnt/nas/bin/codex\n"),
            Some("/mnt/nas/bin/codex".to_string())
        );
    }

    #[test]
    fn a_non_posix_login_shell_is_replaced_by_bin_sh_for_the_resolved_cli() {
        // `exec "$0" "$@"` is POSIX shell syntax fish and tcsh do not have.
        for shell in [
            "/usr/bin/fish",
            "/usr/bin/tcsh",
            "/usr/bin/csh",
            "/usr/bin/elvish",
        ] {
            let args = resolved_command_args(shell, "/usr/bin/opencode", &[]);
            assert_eq!(args[1], "/bin/sh", "{shell} cannot run the launch script");
            assert_eq!(args[2], "-lc");
        }
        // A POSIX login shell is kept: its rc files are where the binary was resolved.
        for shell in ["/bin/bash", "/usr/bin/zsh", "/bin/dash", "/bin/ksh"] {
            let args = resolved_command_args(shell, "/usr/bin/opencode", &[]);
            assert_eq!(args[1], shell);
            assert_eq!(args[2], "-lic");
        }
    }

    fn ubuntu() -> WslPath {
        WslPath {
            distro: "Ubuntu".into(),
            linux_path: "/home/dev".into(),
        }
    }

    fn argv(builder: &CommandBuilder) -> Vec<String> {
        builder
            .get_argv()
            .iter()
            .map(|arg| arg.to_string_lossy().to_string())
            .collect()
    }

    #[test]
    fn a_shell_terminal_launches_the_plain_distro_login_shell() {
        let builder = command_builder_for_wsl(&ubuntu(), None, &[], None);
        assert_eq!(argv(&builder), vec!["wsl.exe", "-d", "Ubuntu"]);
    }

    #[test]
    fn an_unresolved_command_falls_back_to_the_distro_shell_with_quoted_args() {
        let extras = vec!["--resume".to_string(), "it's me".to_string()];
        let builder = command_builder_for_wsl(&ubuntu(), Some("claude"), &extras, None);
        assert_eq!(
            argv(&builder),
            vec![
                "wsl.exe",
                "-d",
                "Ubuntu",
                "-e",
                "/bin/sh",
                "-lc",
                r"exec 'claude' '--resume' 'it'\''s me'",
            ]
        );
    }

    /// The tests below mutate the process-wide `WSLENV`, so they must not run concurrently.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    fn wslenv_of(builder: &CommandBuilder) -> String {
        builder
            .get_env("WSLENV")
            .map(|raw| raw.to_string_lossy().to_string())
            .unwrap_or_default()
    }

    #[test]
    fn never_names_path_shaped_variables_in_wslenv() {
        let _guard = ENV_LOCK.lock().unwrap();
        std::env::set_var("WSLENV", "");
        let mut env = HashMap::new();
        for key in ["PATH", "HOME", "TMP", "TEMP"] {
            env.insert(key.to_string(), format!("C:\\windows\\{key}"));
        }
        env.insert("ANTHROPIC_API_KEY".to_string(), "sk-test".to_string());

        let builder = command_builder_for_wsl(&ubuntu(), None, &[], Some(&env));
        let wslenv = wslenv_of(&builder);
        let names: Vec<&str> = wslenv.split(':').collect();

        assert!(names.contains(&"COLORTERM"));
        assert!(names.contains(&"ANTHROPIC_API_KEY"));
        for excluded in ["PATH", "HOME", "TMP", "TEMP", "WSLENV"] {
            assert!(!names.contains(&excluded), "{excluded} must not cross");
        }
        assert_eq!(
            builder
                .get_env("PATH")
                .map(|raw| raw.to_string_lossy().to_string()),
            Some(r"C:\windows\PATH".to_string())
        );
    }

    #[test]
    fn filters_path_shaped_names_inherited_from_the_process_wslenv() {
        let _guard = ENV_LOCK.lock().unwrap();
        std::env::set_var("WSLENV", "KEEP:PATH:HOME");

        let builder = command_builder_for_wsl(&ubuntu(), None, &[], None);
        let wslenv = wslenv_of(&builder);
        let names: Vec<&str> = wslenv.split(':').collect();

        assert!(names.contains(&"KEEP"));
        assert!(!names.contains(&"PATH"));
        assert!(!names.contains(&"HOME"));
    }

    #[test]
    fn filters_and_dedupes_wslenv_entries_that_carry_translation_flags() {
        let _guard = ENV_LOCK.lock().unwrap();
        std::env::set_var("WSLENV", "PATH/l:HOME/p:TERM/u:KEEP/w");

        let builder = command_builder_for_wsl(&ubuntu(), None, &[], None);
        let wslenv = wslenv_of(&builder);
        let names: Vec<&str> = wslenv.split(':').collect();

        for blocked in ["PATH/l", "HOME/p", "PATH", "HOME"] {
            assert!(!names.contains(&blocked), "{blocked} must not cross");
        }
        assert!(names.contains(&"KEEP/w"));
        // The inherited `TERM/u` would keep our own TERM from crossing, and naming TERM twice is
        // not a valid WSLENV either.
        assert!(names.contains(&"TERM"));
        assert_eq!(
            names.iter().filter(|name| name.starts_with("TERM")).count(),
            1
        );
    }

    #[test]
    fn asks_wsl_exe_for_utf8_messages_in_the_terminal_environment() {
        let builder = command_builder_for_wsl(&ubuntu(), None, &[], None);
        assert_eq!(
            builder
                .get_env("WSL_UTF8")
                .map(|raw| raw.to_string_lossy().to_string()),
            Some("1".to_string())
        );
    }

    #[test]
    fn exports_the_terminal_env_across_the_boundary_through_wslenv() {
        let _guard = ENV_LOCK.lock().unwrap();
        std::env::set_var("WSLENV", "EXISTING::EXISTING");
        let mut env = HashMap::new();
        env.insert("ALETHE_PANE".to_string(), "42".to_string());

        let builder = command_builder_for_wsl(&ubuntu(), None, &[], Some(&env));
        let value = |key: &str| {
            builder
                .get_env(key)
                .map(|raw| raw.to_string_lossy().to_string())
        };

        assert_eq!(value("TERM"), Some("xterm-256color".to_string()));
        assert_eq!(value("COLORTERM"), Some("truecolor".to_string()));
        assert_eq!(value("ALETHE_PANE"), Some("42".to_string()));
        assert_eq!(
            value("WSLENV"),
            Some("EXISTING:TERM:COLORTERM:ALETHE_PANE".to_string())
        );
    }

    #[test]
    fn a_ttl_cache_serves_a_fresh_entry_and_forgets_an_expired_one() {
        let fresh: TtlCache<String, u32> = TtlCache::new(Duration::from_secs(60));
        fresh.insert("Ubuntu".to_string(), 7);
        assert_eq!(fresh.get(&"Ubuntu".to_string()), Some(7));
        assert_eq!(fresh.get(&"Debian".to_string()), None);

        let stale: TtlCache<String, u32> = TtlCache::new(Duration::from_millis(1));
        stale.insert("Ubuntu".to_string(), 7);
        std::thread::sleep(Duration::from_millis(10));
        assert_eq!(stale.get(&"Ubuntu".to_string()), None);
    }

    #[test]
    fn a_ttl_cache_remembers_a_negative_answer() {
        let cache: TtlCache<String, Option<String>> = TtlCache::new(Duration::from_secs(60));
        cache.insert("Ubuntu".to_string(), None);
        assert_eq!(cache.get(&"Ubuntu".to_string()), Some(None));
        assert_eq!(cache.len(), 1);
    }

    #[test]
    fn clearing_a_ttl_cache_drops_every_entry() {
        let cache: TtlCache<String, u32> = TtlCache::new(Duration::from_secs(60));
        cache.insert("Ubuntu".to_string(), 1);
        cache.insert("Debian".to_string(), 2);
        assert_eq!(cache.len(), 2);

        cache.clear();
        assert_eq!(cache.len(), 0);
        assert_eq!(cache.get(&"Ubuntu".to_string()), None);
    }

    #[test]
    fn the_gate_hides_a_wsl_target_while_the_integration_is_disabled() {
        let _guard = TOGGLE_LOCK.lock().unwrap();
        let wsl_cwd = r"\\wsl.localhost\Ubuntu\home\dev\projects";
        let windows_cwd = r"C:\Users\dev\projects";
        let parsed = WslPath {
            distro: "Ubuntu".into(),
            linux_path: "/home/dev/projects".into(),
        };

        assert!(integration_enabled());
        assert_eq!(wsl_target(wsl_cwd), Some(parsed.clone()));
        assert_eq!(wsl_target(windows_cwd), None);

        set_integration_enabled(false);
        assert!(!integration_enabled());
        assert_eq!(wsl_target(wsl_cwd), None);
        assert_eq!(wsl_target(windows_cwd), None);

        set_integration_enabled(true);
        assert_eq!(wsl_target(wsl_cwd), Some(parsed));
    }

    fn seed_the_probe_caches() {
        DISTRO_CACHE.insert((), vec!["Ubuntu".to_string()]);
        CLI_CACHE.insert(
            ("Ubuntu".to_string(), "claude".to_string()),
            Some("/home/dev/.local/bin/claude".to_string()),
        );
        HOME_CACHE.insert(
            "Ubuntu".to_string(),
            Some(r"\\wsl.localhost\Ubuntu\home\dev".to_string()),
        );
    }

    fn probe_caches_are_empty() -> bool {
        DISTRO_CACHE.len() == 0 && CLI_CACHE.len() == 0 && HOME_CACHE.len() == 0
    }

    #[test]
    fn flipping_the_toggle_discards_every_memoized_probe_result() {
        let _guard = TOGGLE_LOCK.lock().unwrap();

        seed_the_probe_caches();
        set_integration_enabled(false);
        assert!(
            probe_caches_are_empty(),
            "turning it off must drop the caches"
        );

        seed_the_probe_caches();
        set_integration_enabled(true);
        assert!(
            probe_caches_are_empty(),
            "turning it back on must not serve what was cached while it was off"
        );
    }

    #[test]
    fn the_distro_listing_is_empty_while_the_integration_is_disabled() {
        let _guard = TOGGLE_LOCK.lock().unwrap();
        set_integration_enabled(false);
        seed_the_probe_caches();

        assert_eq!(installed_distros(), Vec::<String>::new());
        // The seeded entry survives, proving the disabled path neither read nor rewrote it.
        assert_eq!(DISTRO_CACHE.get(&()), Some(vec!["Ubuntu".to_string()]));

        set_integration_enabled(true);
    }

    #[test]
    fn the_guest_probes_report_nothing_while_the_integration_is_disabled() {
        let _guard = TOGGLE_LOCK.lock().unwrap();
        set_integration_enabled(false);
        seed_the_probe_caches();

        assert_eq!(resolve_cli_in_distro("Ubuntu", "claude", false), None);
        assert_eq!(find_cli_in_distro("Ubuntu", "claude"), None);
        assert_eq!(distro_home_unc("Ubuntu"), None);
        // The seeded entries survive: the disabled path neither read nor rewrote them.
        assert_eq!(CLI_CACHE.len(), 1);
        assert_eq!(HOME_CACHE.len(), 1);

        set_integration_enabled(true);
    }
}
