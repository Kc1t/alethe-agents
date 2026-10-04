use portable_pty::CommandBuilder;
use std::collections::HashMap;
use std::env;
use std::fs;
use std::path::PathBuf;
use std::sync::{OnceLock, RwLock};
use std::time::SystemTime;

#[cfg(windows)]
use winreg::{enums::*, RegKey};

/// `None` until the first lookup, and reset to it by `invalidate_rebuilt_path` after an install.
static REBUILT_PATH: RwLock<Option<String>> = RwLock::new(None);

/// Rendering workarounds Alethe sets on its own process at startup. They are meant for its
/// WebView, not for the programs a terminal runs, so a PTY gets the session's own value back.
pub const WEBVIEW_ONLY_ENV: &[&str] = &["WEBKIT_DISABLE_DMABUF_RENDERER"];

static SESSION_ENV_BEFORE_WORKAROUNDS: OnceLock<Vec<(&'static str, Option<std::ffi::OsString>)>> =
    OnceLock::new();

/// Records what the session had for each WebView-only variable. Call before setting any of them.
pub fn remember_session_env_before_workarounds() {
    let _ = SESSION_ENV_BEFORE_WORKAROUNDS.get_or_init(|| {
        WEBVIEW_ONLY_ENV
            .iter()
            .map(|key| (*key, env::var_os(key)))
            .collect()
    });
}

fn restore_session_env(builder: &mut CommandBuilder) {
    if let Some(before) = SESSION_ENV_BEFORE_WORKAROUNDS.get() {
        restore_env(builder, before);
    }
}

fn restore_env(builder: &mut CommandBuilder, before: &[(&str, Option<std::ffi::OsString>)]) {
    for (key, value) in before {
        match value {
            Some(value) => builder.env(key, value),
            None => builder.env_remove(key),
        }
    }
}

pub fn default_shell() -> String {
    #[cfg(windows)]
    {
        if which::which("pwsh.exe").is_ok() {
            return "pwsh.exe".to_string();
        }
        "powershell.exe".to_string()
    }
    #[cfg(not(windows))]
    {
        std::env::var("SHELL")
            .ok()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| "/bin/bash".to_string())
    }
}

/// PATH with the launcher's own directory first, or None when it is already on PATH. An npm CLI is a
/// `#!/usr/bin/env node` script installed next to its `node`, so a CLI found outside PATH (an nvm,
/// fnm or volta version directory) dies with "env: node: not found" unless the process it starts
/// can see that directory too.
#[cfg(not(windows))]
pub fn path_with_launcher_dir(
    launcher: &std::path::Path,
    current: Option<&std::ffi::OsStr>,
) -> Option<std::ffi::OsString> {
    let dir = launcher.parent().filter(|dir| dir.is_absolute())?;
    let mut paths: Vec<PathBuf> = current
        .map(|value| env::split_paths(value).collect())
        .unwrap_or_default();
    if paths.iter().any(|path| path == dir) {
        return None;
    }
    paths.insert(0, dir.to_path_buf());
    env::join_paths(paths).ok()
}

pub fn command_builder_for_terminal(
    initial_command: Option<&str>,
    resolved_launcher: Option<&str>,
    extra_args: &[String],
) -> CommandBuilder {
    let trimmed = initial_command
        .map(str::trim)
        .filter(|value| !value.is_empty());

    let mut builder = match trimmed {
        Some(command) => {
            let arg = resolved_launcher
                .map(|s| s.to_string())
                .unwrap_or_else(|| command.to_string());
            let shell = default_shell();

            #[cfg(windows)]
            {
                let escaped = arg.replace('\'', "''");
                let extras_pwsh = extra_args
                    .iter()
                    .map(|a| format!(" '{}'", a.replace('\'', "''")))
                    .collect::<String>();
                let mut builder = CommandBuilder::new(&shell);
                builder.arg("-NoLogo");
                builder.arg("-NoProfile");
                builder.arg("-Command");
                builder.arg(format!("& '{escaped}'{extras_pwsh}; exit $LASTEXITCODE"));
                builder
            }
            #[cfg(not(windows))]
            {
                // POSIX shell: exec do launcher + args, com aspas simples escapadas.
                let esc = |s: &str| s.replace('\'', "'\\''");
                let mut line = format!("exec '{}'", esc(&arg));
                for a in extra_args {
                    line.push_str(&format!(" '{}'", esc(a)));
                }
                let mut builder = CommandBuilder::new(&shell);
                builder.arg("-lc");
                builder.arg(line);
                builder
            }
        }
        None => {
            let shell = default_shell();
            let mut builder = CommandBuilder::new(&shell);
            if shell.eq_ignore_ascii_case("pwsh.exe")
                || shell.eq_ignore_ascii_case("powershell.exe")
            {
                builder.arg("-NoLogo");
            }
            builder
        }
    };

    if cfg!(windows) {
        let existing = builder
            .get_env("Path")
            .or_else(|| builder.get_env("PATH"))
            .map(|value| value.to_string_lossy().to_string())
            .unwrap_or_default();
        let mut combined = existing;
        for extra in agent_search_dirs() {
            let extra = extra.to_string_lossy().to_string();
            if !combined
                .split(';')
                .any(|part| part.eq_ignore_ascii_case(&extra))
            {
                if !combined.is_empty() && !combined.ends_with(';') {
                    combined.push(';');
                }
                combined.push_str(&extra);
            }
        }
        builder.env("Path", combined);
    }
    #[cfg(not(windows))]
    if let Some(launcher) = resolved_launcher.filter(|_| trimmed.is_some()) {
        let current = builder
            .get_env("PATH")
            .map(ToOwned::to_owned)
            .or_else(|| env::var_os("PATH"));
        if let Some(path) =
            path_with_launcher_dir(std::path::Path::new(launcher), current.as_deref())
        {
            builder.env("PATH", path);
        }
    }
    builder.env("TERM", "xterm-256color");
    builder.env("COLORTERM", "truecolor");

    // terminal vai renderizar. Confirmado com um teste isolado rodando o

    // — nem DECRQSS/XTGETTCAP, embora responda OSC 10/11/DSR/DA

    // causa conhecida de "artefatos estranhos contendo '66'" em terminais

    if trimmed == Some("opencode") {
        builder.env("OPENTUI_FORCE_EXPLICIT_WIDTH", "false");
    }
    scrub_editor_environment(&mut builder);
    restore_session_env(&mut builder);
    builder.env_remove("EDITOR");
    builder.env_remove("VISUAL");
    builder.env_remove("CLAUDECODE");
    builder.env_remove("CLAUDE_CODE_ENTRYPOINT");
    builder.env_remove("CLAUDECODE_PARENT_PID");
    builder
}

///

#[tauri::command]
pub async fn find_cli_launcher(agent: String) -> Option<String> {
    tokio::task::spawn_blocking(move || {
        find_windows_cli_launcher(&agent).map(|p| p.to_string_lossy().to_string())
    })
    .await
    .unwrap_or(None)
}

static LAUNCHER_CACHE: OnceLock<std::sync::Mutex<HashMap<String, PathBuf>>> = OnceLock::new();

/// Resolving a launcher walks every PATH entry and every agent directory looking for four
/// extensions, and it runs on every terminal boot. Only hits are cached, and a hit is dropped as
/// soon as its file is gone — so installing an agent is picked up at once and uninstalling it is
/// noticed on the next lookup, without the cache ever answering for something that is not there.
pub fn find_windows_cli_launcher(command: &str) -> Option<PathBuf> {
    let cache = LAUNCHER_CACHE.get_or_init(|| std::sync::Mutex::new(HashMap::new()));

    if let Ok(map) = cache.lock() {
        if let Some(path) = map.get(command) {
            if path.is_file() {
                return Some(path.clone());
            }
        }
    }

    let resolved = resolve_cli_launcher(command)?;
    if let Ok(mut map) = cache.lock() {
        map.insert(command.to_string(), resolved.clone());
    }
    Some(resolved)
}

/// Binary name for an agent whose CLI is not called after the vendor: Antigravity ships `agy`, and
/// Cursor ships `cursor-agent` (its bare `agent` alias collides with other vendors' CLIs). Callers
/// normally pass the binary name already, so this only has to catch the ones that pass an agent id.
fn canonical_cli_name(command: &str) -> &str {
    match command {
        "antigravity" => "agy",
        "cursor" => "cursor-agent",
        other => other,
    }
}

fn resolve_cli_launcher(command: &str) -> Option<PathBuf> {
    let command = canonical_cli_name(command);

    #[cfg(not(windows))]
    {
        if let Ok(path) = which::which(command) {
            return Some(path);
        }
        let mut dirs = Vec::<PathBuf>::new();
        if let Some(home) = env::var_os("HOME").map(PathBuf::from) {
            dirs.push(home.join(".local").join("bin"));
            dirs.push(home.join(".cargo").join("bin"));
            // Official Grok Build installer links into ~/.grok/bin.
            dirs.push(home.join(".grok").join("bin"));
        }
        // App .app lançado via Finder/DMG não roda como login shell: herda o
        // PATH mínimo do Launch Services (sem .zshrc/.zprofile), então CLIs
        // instaladas via `brew install` ficam invisíveis pro `which` acima
        // mesmo estando no disco. Cobrir os prefixos padrão do Homebrew
        // (Apple Silicon e Intel) como fallback fixo.
        dirs.extend(homebrew_dirs());
        // Linux user-scoped installers (nvm, bun, npm --prefix, pnpm, volta) —
        // invisible under the minimal PATH a desktop menu inherits.
        #[cfg(target_os = "linux")]
        dirs.extend(linux_user_bin_dirs());
        for dir in dirs {
            let candidate = dir.join(command);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
        return None;
    }

    #[cfg(windows)]
    {
        let mut dirs = Vec::<PathBuf>::new();
        dirs.extend(split_windows_path_expanded(&rebuilt_path()));
        dirs.extend(agent_search_dirs());

        for dir in &dirs {
            for extension in ["cmd", "exe", "bat", "ps1"] {
                let candidate = dir.join(format!("{command}.{extension}"));
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
        None
    }
}

#[derive(serde::Serialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct InstallToolchain {
    pub node: Option<String>,
    pub npm: bool,
    pub winget: bool,
    pub scoop: bool,
    pub choco: bool,
    pub bun: bool,
    pub pnpm: bool,
}

fn node_version() -> Option<String> {
    let node = find_windows_cli_launcher("node")?;
    let output = std::process::Command::new(node)
        .arg("--version")
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!version.is_empty()).then_some(version)
}

/// Extracts the first dotted version out of `--version` output. Agents are not consistent here:
/// some print a bare `1.2.3`, others `codex-cli 1.2.3 (abc1234)` or a banner line first.
fn parse_version(raw: &str) -> Option<String> {
    raw.split(|c: char| !(c.is_ascii_digit() || c == '.'))
        .find(|token| token.contains('.') && token.starts_with(|c: char| c.is_ascii_digit()))
        .map(|token| token.trim_end_matches('.').to_string())
}

/// Flags tried in order. The agents disagree on this, and none of them documents it, so the probe
/// asks rather than assumes. Output is read from stdout and stderr because some print to stderr.
const VERSION_FLAGS: [&str; 3] = ["--version", "-v", "version"];

/// Version a CLI at a known path reports, or `None` when it answers nothing usable.
pub(crate) fn cli_version_at(bin: &std::path::Path) -> Option<String> {
    for flag in VERSION_FLAGS {
        let mut command = std::process::Command::new(bin);
        command.arg(flag);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        let Ok(output) = command.output() else {
            continue;
        };
        let stdout = String::from_utf8_lossy(&output.stdout);
        if let Some(version) = parse_version(&stdout) {
            return Some(version);
        }
        let stderr = String::from_utf8_lossy(&output.stderr);
        if let Some(version) = parse_version(&stderr) {
            return Some(version);
        }
    }
    None
}

/// Version the agent's CLI reports, or `None` when it is missing or answers nothing usable.
#[tauri::command]
pub async fn agent_cli_version(agent: String) -> Option<String> {
    tokio::task::spawn_blocking(move || cli_version_at(&find_windows_cli_launcher(&agent)?))
        .await
        .unwrap_or(None)
}

/// Reports which installers are usable on this machine so the UI can offer the
/// agent install methods that will actually work here.
#[tauri::command]
pub async fn probe_install_toolchain() -> InstallToolchain {
    tokio::task::spawn_blocking(|| {
        let has = |name: &str| find_windows_cli_launcher(name).is_some();
        InstallToolchain {
            node: node_version(),
            npm: has("npm"),
            winget: has("winget"),
            scoop: has("scoop"),
            choco: has("choco"),
            bun: has("bun"),
            pnpm: has("pnpm"),
        }
    })
    .await
    .unwrap_or_default()
}

/// Default Homebrew prefixes on macOS (Apple Silicon uses `/opt/homebrew`, Intel
/// uses `/usr/local`). Fixed fallback — it does not rely on the login shell having
/// run `brew shellenv` in the session of the process that launched the app.
#[cfg(not(windows))]
fn homebrew_dirs() -> Vec<PathBuf> {
    vec![
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/opt/homebrew/sbin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/usr/local/sbin"),
    ]
}

/// Standard user bin dirs for Linux package managers. Desktop menus launch the
/// app with a minimal PATH, so agents installed via `npm --prefix`, bun, pnpm,
/// volta or nvm are invisible to `which`; these are the default install roots
/// for each tool (mirrors `agent_search_dirs` on Windows and the fixed Homebrew
/// fallback on macOS).
#[cfg(target_os = "linux")]
fn linux_user_bin_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::<PathBuf>::new();
    if let Some(home) = env::var_os("HOME").map(PathBuf::from) {
        dirs.push(home.join(".npm-global").join("bin"));
        dirs.push(home.join(".bun").join("bin"));
        dirs.push(home.join(".volta").join("bin"));
        dirs.push(home.join(".local").join("share").join("pnpm"));
    }
    if let Some(pnpm_home) = env::var_os("PNPM_HOME").map(PathBuf::from) {
        dirs.push(pnpm_home);
    }
    // nvm installs one versioned bin dir per node release; pick every one
    // newest first (same pattern as `fnm_version_dirs`).
    let nvm_root = env::var_os("NVM_DIR")
        .map(PathBuf::from)
        .or_else(|| env::var_os("HOME").map(|h| PathBuf::from(h).join(".nvm")));
    if let Some(root) = nvm_root {
        let versions_dir = root.join("versions").join("node");
        if let Ok(entries) = fs::read_dir(&versions_dir) {
            let mut versions: Vec<(PathBuf, SystemTime)> = entries
                .filter_map(|entry| entry.ok())
                .filter_map(|entry| {
                    let path = entry.path();
                    let name = path.file_name()?.to_str()?.to_string();
                    if !name.starts_with('v') {
                        return None;
                    }
                    let bin = path.join("bin");
                    if !bin.is_dir() {
                        return None;
                    }
                    let modified = entry.metadata().and_then(|m| m.modified()).ok()?;
                    Some((bin, modified))
                })
                .collect();
            versions.sort_by(|a, b| b.1.cmp(&a.1));
            for (bin, _) in versions {
                dirs.push(bin);
            }
        }
    }
    dirs
}

/// Looks for the VS Code launcher (`code`) in common locations plus PATH.
/// Returns the first one that exists.
pub fn find_vscode_launcher() -> Option<PathBuf> {
    #[cfg(not(windows))]
    {
        // VS Code under any of its names, then VSCodium, then the launchers Flatpak and snap
        // install outside PATH, which a GUI session often does not include.
        for name in ["code", "code-insiders", "codium"] {
            if let Ok(path) = which::which(name) {
                return Some(path);
            }
        }
        let mut candidates = vec![
            PathBuf::from("/snap/bin/code"),
            PathBuf::from("/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"),
        ];
        let mut flatpak_roots = vec![PathBuf::from("/var/lib/flatpak/exports/bin")];
        if let Some(home) = env::var_os("HOME").map(PathBuf::from) {
            flatpak_roots.push(home.join(".local/share/flatpak/exports/bin"));
        }
        for root in flatpak_roots {
            for id in ["com.visualstudio.code", "com.vscodium.codium"] {
                candidates.push(root.join(id));
            }
        }
        candidates.into_iter().find(|path| path.is_file())
    }

    #[cfg(windows)]
    {
        let root_candidates = ["Code.exe", "Code - Insiders.exe"];
        let path_candidates = [
            "code.exe",
            "code-insiders.exe",
            "code.cmd",
            "code-insiders.cmd",
        ];
        let mut dirs: Vec<PathBuf> = Vec::new();
        if let Some(local) = env::var_os("LOCALAPPDATA").map(PathBuf::from) {
            dirs.push(local.join("Programs").join("Microsoft VS Code").join("bin"));
            dirs.push(
                local
                    .join("Programs")
                    .join("Microsoft VS Code Insiders")
                    .join("bin"),
            );
        }
        if let Some(pf) = env::var_os("ProgramFiles").map(PathBuf::from) {
            dirs.push(pf.join("Microsoft VS Code").join("bin"));
            dirs.push(pf.join("Microsoft VS Code Insiders").join("bin"));
        }
        if let Some(pf86) = env::var_os("ProgramFiles(x86)").map(PathBuf::from) {
            dirs.push(pf86.join("Microsoft VS Code").join("bin"));
        }

        for app_dir in dirs.iter().filter_map(|dir| dir.parent()) {
            for name in root_candidates {
                let candidate = app_dir.join(name);
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }

        dirs.splice(0..0, split_windows_path_expanded(&rebuilt_path()));
        for dir in dirs {
            for name in path_candidates {
                let candidate = dir.join(name);
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
        None
    }
}

pub fn agent_search_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::<PathBuf>::new();
    if let Some(profile) = env::var_os("USERPROFILE").map(PathBuf::from) {
        dirs.push(profile.join("AppData").join("Roaming").join("npm"));
        dirs.push(profile.join(".local").join("bin"));
        dirs.push(profile.join(".cargo").join("bin"));
        dirs.push(profile.join(".grok").join("bin"));
        dirs.push(profile.join(".bun").join("bin"));
        dirs.push(profile.join("scoop").join("shims"));
        dirs.push(
            profile
                .join("AppData")
                .join("Local")
                .join("agy")
                .join("bin"),
        );
        dirs.push(
            profile
                .join("AppData")
                .join("Local")
                .join("antigravity")
                .join("bin"),
        );
        // Cursor's installer drops its shims at the root of this folder, not in a `bin` subdir,
        // and only puts it on PATH for shells started afterwards.
        dirs.push(profile.join("AppData").join("Local").join("cursor-agent"));
    }
    if let Some(app_data) = env::var_os("APPDATA").map(PathBuf::from) {
        dirs.push(app_data.join("npm"));
    }
    dirs.extend(volta_bin_dirs());
    dirs.extend(pnpm_bin_dirs());
    dirs.extend(fnm_version_dirs());
    if let Some(global) = env::var_os("SCOOP_GLOBAL").map(PathBuf::from) {
        dirs.push(global.join("shims"));
    } else {
        dirs.push(PathBuf::from(r"C:\ProgramData\scoop\shims"));
    }
    dirs.push(PathBuf::from(r"C:\ProgramData\chocolatey\bin"));
    dirs.extend(nvm_windows_version_dirs());
    dirs.push(PathBuf::from(r"C:\nvm4w\nodejs"));
    dirs.push(PathBuf::from(r"C:\Program Files\nodejs"));
    dirs.push(PathBuf::from(r"C:\Program Files (x86)\nodejs"));
    dirs
}

pub fn volta_bin_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(volta_home) = env::var_os("VOLTA_HOME").map(PathBuf::from) {
        dirs.push(volta_home.join("bin"));
    }
    if let Some(local) = env::var_os("LOCALAPPDATA").map(PathBuf::from) {
        dirs.push(local.join("Volta").join("bin"));
    }
    dirs
}

pub fn pnpm_bin_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(pnpm_home) = env::var_os("PNPM_HOME").map(PathBuf::from) {
        dirs.push(pnpm_home);
    }
    if let Some(local) = env::var_os("LOCALAPPDATA").map(PathBuf::from) {
        dirs.push(local.join("pnpm"));
    }
    dirs
}

pub fn fnm_version_dirs() -> Vec<PathBuf> {
    let fnm_root = env::var_os("FNM_DIR")
        .map(PathBuf::from)
        .or_else(|| env::var_os("LOCALAPPDATA").map(|p| PathBuf::from(p).join("fnm")));
    let Some(root) = fnm_root else {
        return Vec::new();
    };
    let versions_dir = root.join("node-versions");
    let Ok(entries) = fs::read_dir(&versions_dir) else {
        return Vec::new();
    };
    let mut versions: Vec<(PathBuf, SystemTime)> = entries
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            let path = entry.path();
            let name = path.file_name()?.to_str()?.to_string();
            if !name.starts_with('v') {
                return None;
            }
            let install = path.join("installation");
            if !install.is_dir() {
                return None;
            }
            let modified = entry.metadata().and_then(|m| m.modified()).ok()?;
            Some((install, modified))
        })
        .collect();
    versions.sort_by(|a, b| b.1.cmp(&a.1));
    versions.into_iter().map(|(path, _)| path).collect()
}

pub fn nvm_windows_version_dirs() -> Vec<PathBuf> {
    let Some(nvm_home) = env::var_os("NVM_HOME").map(PathBuf::from) else {
        return Vec::new();
    };
    let Ok(entries) = fs::read_dir(&nvm_home) else {
        return Vec::new();
    };
    let mut versions: Vec<(PathBuf, SystemTime)> = entries
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            let path = entry.path();
            let name = path.file_name()?.to_str()?.to_string();
            if !name.starts_with('v') {
                return None;
            }
            let modified = entry.metadata().and_then(|m| m.modified()).ok()?;
            if !path.is_dir() {
                return None;
            }
            Some((path, modified))
        })
        .collect();
    versions.sort_by(|a, b| b.1.cmp(&a.1));
    versions.into_iter().map(|(path, _)| path).collect()
}

fn scrub_editor_environment(builder: &mut CommandBuilder) {
    for key in [
        "TERM_PROGRAM",
        "TERM_PROGRAM_VERSION",
        "VSCODE_CWD",
        "VSCODE_IPC_HOOK",
        "VSCODE_IPC_HOOK_CLI",
        "VSCODE_GIT_ASKPASS_NODE",
        "VSCODE_GIT_ASKPASS_EXTRA_ARGS",
        "VSCODE_GIT_ASKPASS_MAIN",
        "VSCODE_GIT_IPC_HANDLE",
        "GIT_ASKPASS",
        "ELECTRON_RUN_AS_NODE",
    ] {
        builder.env_remove(key);
    }
}

pub fn rebuilt_path() -> String {
    if let Ok(cached) = REBUILT_PATH.read() {
        if let Some(value) = cached.as_ref() {
            return value.clone();
        }
    }
    let built = build_rebuilt_path();
    if let Ok(mut cached) = REBUILT_PATH.write() {
        *cached = Some(built.clone());
    }
    built
}

/// Drops the cached PATH so the next lookup reads what an installer just wrote to the registry.
/// Windows only hands a new environment to processes started after the change, and this one is
/// long-lived: without this, a CLI installed from inside Alethe stays invisible until a restart.
pub fn invalidate_rebuilt_path() {
    if let Ok(mut cached) = REBUILT_PATH.write() {
        *cached = None;
    }
}

/// Re-reads the machine's environment, then reports the launcher for `command` — what an install
/// screen calls to find out whether the CLI it was installing has actually landed.
#[tauri::command]
pub async fn refresh_cli_launcher(command: String) -> Option<String> {
    tokio::task::spawn_blocking(move || {
        invalidate_rebuilt_path();
        find_windows_cli_launcher(&command).map(|path| path.to_string_lossy().to_string())
    })
    .await
    .unwrap_or(None)
}

pub(crate) fn build_rebuilt_path() -> String {
    if !cfg!(windows) {
        let mut paths: Vec<PathBuf> = env::var_os("PATH")
            .map(|value| env::split_paths(&value).collect())
            .unwrap_or_default();
        #[cfg(not(windows))]
        paths.extend(homebrew_dirs());
        return dedupe_paths(paths)
            .into_iter()
            .map(|path| path.to_string_lossy().to_string())
            .collect::<Vec<_>>()
            .join(":");
    }

    let mut paths = Vec::<PathBuf>::new();

    #[cfg(windows)]
    {
        let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
        if let Ok(env_key) =
            hklm.open_subkey("SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment")
        {
            if let Ok(path) = env_key.get_value::<String, _>("Path") {
                paths.extend(split_windows_path_expanded(&path));
            }
        }

        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        if let Ok(env_key) = hkcu.open_subkey("Environment") {
            if let Ok(path) = env_key.get_value::<String, _>("Path") {
                paths.extend(split_windows_path_expanded(&path));
            }
        }
    }

    if let Some(current_path) = env::var_os("PATH") {
        paths.extend(env::split_paths(&current_path));
    }

    if let Some(user_profile) = env::var_os("USERPROFILE").map(PathBuf::from) {
        paths.push(user_profile.join("AppData").join("Roaming").join("npm"));
        paths.push(user_profile.join(".local").join("bin"));
        paths.push(user_profile.join(".cargo").join("bin"));
        paths.push(user_profile.join(".bun").join("bin"));
    }

    if let Some(app_data) = env::var_os("APPDATA").map(PathBuf::from) {
        paths.push(app_data.join("npm"));
    }

    paths.push(PathBuf::from(r"C:\nvm4w\nodejs"));
    paths.push(PathBuf::from(r"C:\Program Files\nodejs"));
    paths.push(PathBuf::from(r"C:\Program Files (x86)\nodejs"));

    dedupe_paths(paths)
        .into_iter()
        .map(|path| path.to_string_lossy().to_string())
        .collect::<Vec<_>>()
        .join(";")
}

#[allow(dead_code)]
fn split_windows_path_expanded(path: &str) -> Vec<PathBuf> {
    path.split(';')
        .filter_map(|item| {
            let item = expand_windows_env_vars(item.trim());
            if item.is_empty() {
                None
            } else {
                Some(PathBuf::from(item))
            }
        })
        .collect()
}

#[allow(dead_code)]
fn expand_windows_env_vars(input: &str) -> String {
    let mut output = input.to_string();
    for (key, value) in env::vars() {
        output = output.replace(&format!("%{key}%"), &value);
        output = output.replace(&format!("%{}%", key.to_ascii_uppercase()), &value);
    }
    output
}

fn dedupe_paths(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut result = Vec::<PathBuf>::new();

    for path in paths {
        let path_string = path.to_string_lossy().to_string();
        if path_string.trim().is_empty() {
            continue;
        }
        if result.iter().any(|existing| {
            existing
                .to_string_lossy()
                .eq_ignore_ascii_case(&path_string)
        }) {
            continue;
        }
        result.push(path);
    }

    result
}

#[derive(serde::Serialize, serde::Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct ModelOption {
    pub id: String,
    pub label: String,
    /// The reasoning efforts this model takes, when its CLI says; None when it does not.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub efforts: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_effort: Option<String>,
    /// The model the CLI runs when none is chosen.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub is_default: bool,
}

impl ModelOption {
    fn named(id: impl Into<String>, label: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            ..Self::default()
        }
    }
}

/// An effort list as a CLI reports it, kept to values that are safe to pass back on argv.
fn effort_list(value: &serde_json::Value, key: Option<&str>) -> Option<Vec<String>> {
    let levels: Vec<String> = value
        .as_array()?
        .iter()
        .filter_map(|entry| match key {
            Some(key) => entry[key].as_str(),
            None => entry.as_str(),
        })
        .filter(|level| {
            !level.is_empty() && level.len() <= 16 && level.chars().all(|c| c.is_ascii_lowercase())
        })
        .map(ToOwned::to_owned)
        .collect();
    (!levels.is_empty()).then_some(levels)
}

fn is_valid_model_id(id: &str) -> bool {
    let id_lower = id.to_lowercase();
    if id.is_empty()
        || id.starts_with('-')
        || id.starts_with('#')
        || id_lower.starts_with("usage")
        || id_lower.starts_with("could")
        || id_lower.starts_with("error")
        || id_lower.starts_with("failed")
        || id_lower.starts_with("let")
        || id_lower.starts_with("flags")
        || id_lower.starts_with("available")
        || id.contains(' ')
        || id.len() < 3
    {
        return false;
    }
    true
}

/// Models from a Codex app-server `model/list` reply, hidden ones left out, each with the
/// reasoning efforts it advertises.
fn parse_codex_model_list(reply: &serde_json::Value) -> Vec<ModelOption> {
    reply["result"]["data"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter(|item| item["hidden"].as_bool() != Some(true))
                .filter_map(|item| {
                    let id = item["model"].as_str().or_else(|| item["id"].as_str())?;
                    if !is_valid_model_id(id) {
                        return None;
                    }
                    let label = item["displayName"].as_str().unwrap_or(id);
                    Some(ModelOption {
                        id: id.to_string(),
                        label: label.to_string(),
                        efforts: effort_list(
                            &item["supportedReasoningEfforts"],
                            Some("reasoningEffort"),
                        ),
                        default_effort: item["defaultReasoningEffort"]
                            .as_str()
                            .map(ToOwned::to_owned),
                        is_default: item["isDefault"].as_bool() == Some(true),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The aliases Claude Code always accepts, used when the CLI cannot be asked. Each points at the
/// latest model of its family.
fn claude_alias_models() -> Vec<ModelOption> {
    [
        ("opus", "Opus"),
        ("sonnet", "Sonnet"),
        ("haiku", "Haiku"),
        ("fable", "Fable"),
    ]
    .into_iter()
    .map(|(id, label)| ModelOption::named(id, label))
    .collect()
}

/// Models from a Claude Code `initialize` control response: what the signed-in account can use,
/// with the effort levels each one takes. `default` is kept, marked as the default, so the
/// effort choices can follow it when no model is chosen; it is not offered as a model to pick.
fn parse_claude_initialize_models(reply: &serde_json::Value) -> Vec<ModelOption> {
    reply["response"]["response"]["models"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let id = item["value"].as_str()?;
                    if !is_valid_model_id(id) {
                        return None;
                    }
                    let label = item["displayName"].as_str().unwrap_or(id);
                    let efforts = if item["supportsEffort"].as_bool() == Some(false) {
                        Some(Vec::new())
                    } else {
                        effort_list(&item["supportedEffortLevels"], None)
                    };
                    Some(ModelOption {
                        id: id.to_string(),
                        label: label.to_string(),
                        efforts,
                        default_effort: None,
                        is_default: id == "default",
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Asks Claude Code for its models through the stream-json `initialize` handshake, the way the
/// Agent SDK does: nothing reaches a model and no session is written. Bounded like the Codex
/// lookup; an empty list means the caller falls back to the aliases.
fn claude_initialize_models(bin_path: &str) -> Vec<ModelOption> {
    use std::io::{BufRead, BufReader, Write};
    use std::process::{Command, Stdio};

    let mut command = Command::new(bin_path);
    command
        .args([
            "-p",
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--verbose",
            "--strict-mcp-config",
        ])
        .current_dir(std::env::temp_dir())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    crate::git_control::hide_console(&mut command);
    let Ok(mut child) = command.spawn() else {
        return Vec::new();
    };
    let (Some(mut stdin), Some(stdout)) = (child.stdin.take(), child.stdout.take()) else {
        let _ = child.kill();
        let _ = child.wait();
        return Vec::new();
    };
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Ok(message) = serde_json::from_str::<serde_json::Value>(&line) {
                if message["type"] == "control_response" {
                    let _ = sender.send(message);
                    return;
                }
            }
        }
    });
    let request = serde_json::json!({
        "type": "control_request",
        "request_id": "alethe-models",
        "request": { "subtype": "initialize" }
    });
    let _ = writeln!(stdin, "{request}");
    let reply = receiver
        .recv_timeout(std::time::Duration::from_secs(10))
        .ok();
    drop(stdin);
    let _ = child.kill();
    let _ = child.wait();
    reply
        .map(|reply| parse_claude_initialize_models(&reply))
        .unwrap_or_default()
}

/// Asks a Codex app-server for its model list and stops it. Bounded: a server that never answers
/// is killed after a few seconds and the list comes back empty.
fn codex_app_server_models(bin_path: &str) -> Vec<ModelOption> {
    use std::io::{BufRead, BufReader, Write};
    use std::process::{Command, Stdio};

    let mut command = Command::new(bin_path);
    command
        .args(["app-server", "--stdio"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    crate::git_control::hide_console(&mut command);
    let Ok(mut child) = command.spawn() else {
        return Vec::new();
    };
    let (Some(mut stdin), Some(stdout)) = (child.stdin.take(), child.stdout.take()) else {
        let _ = child.kill();
        let _ = child.wait();
        return Vec::new();
    };
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Ok(message) = serde_json::from_str::<serde_json::Value>(&line) {
                if message["id"] == 2 {
                    let _ = sender.send(message);
                    return;
                }
            }
        }
    });
    let requests = [
        serde_json::json!({ "id": 1, "method": "initialize", "params": { "clientInfo": { "name": "alethe", "title": "Alethe", "version": "1" } } }),
        serde_json::json!({ "method": "initialized" }),
        serde_json::json!({ "id": 2, "method": "model/list", "params": {} }),
    ];
    for request in requests {
        if writeln!(stdin, "{request}").is_err() {
            break;
        }
    }
    let reply = receiver
        .recv_timeout(std::time::Duration::from_secs(10))
        .ok();
    let _ = child.kill();
    let _ = child.wait();
    reply
        .map(|reply| parse_codex_model_list(&reply))
        .unwrap_or_default()
}

fn discover_provider_models_inner(provider: String) -> Result<Vec<ModelOption>, String> {
    let mut models = Vec::new();
    let provider_lower = provider.to_lowercase();

    let cmd_name = match provider_lower.as_str() {
        "antigravity" | "agy" => "agy",
        "kiro" => "kiro-cli",
        "cursor" | "cursor-agent" => "cursor-agent",
        other => other,
    };

    let bin_path = find_windows_cli_launcher(cmd_name)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| cmd_name.to_string());

    match provider_lower.as_str() {
        "antigravity" | "agy" => {
            if let Ok(output) = std::process::Command::new(&bin_path).arg("models").output() {
                let stdout = String::from_utf8_lossy(&output.stdout);
                for line in stdout.lines() {
                    let trimmed = line.trim();
                    let id = trimmed
                        .split_whitespace()
                        .next()
                        .unwrap_or(trimmed)
                        .to_string();
                    if is_valid_model_id(&id) {
                        models.push(ModelOption::named(
                            id.clone(),
                            format!("{id} (Antigravity agy)"),
                        ));
                    }
                }
            }
            if models.is_empty() {
                models.push(ModelOption::named(
                    "gemini-2.5-pro",
                    "Gemini 2.5 Pro (Google DeepMind)",
                ));
                models.push(ModelOption::named(
                    "gemini-2.5-flash",
                    "Gemini 2.5 Flash (Google DeepMind)",
                ));
                models.push(ModelOption::named(
                    "claude-3.7-sonnet",
                    "Claude 3.7 Sonnet (Anthropic)",
                ));
                models.push(ModelOption::named("deepseek-r1", "DeepSeek R1 (Reasoning)"));
            }
        }
        // `cursor-agent models` lists what the signed-in account can actually reach, which is the
        // only reliable source: Cursor's line-up changes per plan and over time.
        "cursor" | "cursor-agent" => {
            if let Ok(output) = std::process::Command::new(&bin_path).arg("models").output() {
                let stdout = String::from_utf8_lossy(&output.stdout);
                for line in stdout.lines() {
                    let trimmed = line.trim();
                    let id = trimmed
                        .split_whitespace()
                        .next()
                        .unwrap_or(trimmed)
                        .to_string();
                    if is_valid_model_id(&id) {
                        models.push(ModelOption::named(id.clone(), format!("{id} (Cursor)")));
                    }
                }
            }
        }
        "opencode" => {
            if let Ok(output) = std::process::Command::new(&bin_path).arg("models").output() {
                let stdout = String::from_utf8_lossy(&output.stdout);
                for line in stdout.lines() {
                    let trimmed = line.trim();
                    let id = trimmed
                        .split_whitespace()
                        .next()
                        .unwrap_or(trimmed)
                        .to_string();
                    if is_valid_model_id(&id) {
                        models.push(ModelOption::named(
                            id.clone(),
                            format!("{id} (OpenCode CLI)"),
                        ));
                    }
                }
            }
        }
        // Claude Code has no command that lists models (`claude models` would be taken as a
        // prompt), but its stream-json handshake reports them. The aliases are the fallback: each
        // always points at the latest model of its family.
        "claude" => {
            models = claude_initialize_models(&bin_path);
            if models.is_empty() {
                models = claude_alias_models();
            }
        }
        // Codex has no `models` command either, but its app-server lists what the signed-in account
        // can use, without starting a session or sending anything to a model.
        "codex" => {
            models = codex_app_server_models(&bin_path);
        }
        "mimo" => {
            if let Ok(output) = std::process::Command::new(&bin_path).arg("models").output() {
                let stdout = String::from_utf8_lossy(&output.stdout);
                for line in stdout.lines() {
                    let trimmed = line.trim();
                    let id = trimmed
                        .split_whitespace()
                        .next()
                        .unwrap_or(trimmed)
                        .to_string();
                    if is_valid_model_id(&id) {
                        models.push(ModelOption::named(id.clone(), format!("{id} (Mimo CLI)")));
                    }
                }
            }
            if models.is_empty() {
                models.push(ModelOption::named("mimo-v1-pro", "Mimo V1 Pro (Xiaomi AI)"));
                models.push(ModelOption::named(
                    "mimo-v1-flash",
                    "Mimo V1 Flash (Xiaomi AI)",
                ));
            }
        }
        "freebuff" => {
            if let Ok(output) = std::process::Command::new(&bin_path).arg("models").output() {
                let stdout = String::from_utf8_lossy(&output.stdout);
                for line in stdout.lines() {
                    let trimmed = line.trim();
                    let id = trimmed
                        .split_whitespace()
                        .next()
                        .unwrap_or(trimmed)
                        .to_string();
                    if is_valid_model_id(&id) {
                        models.push(ModelOption::named(
                            id.clone(),
                            format!("{id} (Freebuff CLI)"),
                        ));
                    }
                }
            }
            if models.is_empty() {
                models.push(ModelOption::named("freebuff-auto", "Freebuff Auto-Router"));
                models.push(ModelOption::named("freebuff-fast", "Freebuff Fast"));
            }
        }
        "grok" => {
            if let Ok(output) = std::process::Command::new(&bin_path).arg("models").output() {
                let stdout = String::from_utf8_lossy(&output.stdout);
                for line in stdout.lines() {
                    let trimmed = line.trim();
                    let id = trimmed
                        .split_whitespace()
                        .next()
                        .unwrap_or(trimmed)
                        .to_string();
                    if is_valid_model_id(&id) {
                        models.push(ModelOption::named(id.clone(), format!("{id} (Grok Build)")));
                    }
                }
            }
        }
        "codewhale" => {
            if let Ok(output) = std::process::Command::new(&bin_path).arg("models").output() {
                let stdout = String::from_utf8_lossy(&output.stdout);
                for line in stdout.lines() {
                    let trimmed = line.trim();
                    let id = trimmed
                        .split_whitespace()
                        .next()
                        .unwrap_or(trimmed)
                        .to_string();
                    if is_valid_model_id(&id) {
                        models.push(ModelOption::named(id.clone(), format!("{id} (Codewhale)")));
                    }
                }
            }
        }
        "kiro" => {
            if let Ok(output) = std::process::Command::new(&bin_path).arg("models").output() {
                let stdout = String::from_utf8_lossy(&output.stdout);
                for line in stdout.lines() {
                    let trimmed = line.trim();
                    let id = trimmed
                        .split_whitespace()
                        .next()
                        .unwrap_or(trimmed)
                        .to_string();
                    if is_valid_model_id(&id) {
                        models.push(ModelOption::named(id.clone(), format!("{id} (Kiro CLI)")));
                    }
                }
            }
            if models.is_empty() {
                models.push(ModelOption::named(
                    "claude-sonnet-4.5",
                    "Claude Sonnet 4.5 (Anthropic via Kiro)",
                ));
                models.push(ModelOption::named(
                    "claude-haiku-4.5",
                    "Claude Haiku 4.5 (Anthropic via Kiro)",
                ));
            }
        }
        _ => {}
    }

    Ok(models)
}

/// `discover_provider_models_inner` runs CLIs and waits on them, so it goes to the blocking pool
/// rather than the main thread.
#[tauri::command]
pub async fn discover_provider_models(provider: String) -> Result<Vec<ModelOption>, String> {
    tokio::task::spawn_blocking(move || discover_provider_models_inner(provider))
        .await
        .map_err(|error| format!("discover_provider_models: the blocking task failed: {error}"))?
}

#[cfg(test)]
mod tests {
    #[test]
    fn codex_models_come_from_the_app_server_reply_without_hidden_ones() {
        let reply = serde_json::json!({
            "id": 2,
            "result": { "data": [
                { "id": "gpt-5.6-sol", "model": "gpt-5.6-sol", "displayName": "GPT-5.6-Sol", "hidden": false },
                { "id": "internal", "model": "internal-preview", "displayName": "Internal", "hidden": true },
                { "id": "gpt-5.5", "model": "gpt-5.5" }
            ] }
        });
        let models = super::parse_codex_model_list(&reply);
        let ids: Vec<&str> = models.iter().map(|model| model.id.as_str()).collect();
        assert_eq!(ids, ["gpt-5.6-sol", "gpt-5.5"]);
        assert_eq!(models[0].label, "GPT-5.6-Sol");
        assert_eq!(models[1].label, "gpt-5.5");
        assert!(super::parse_codex_model_list(&serde_json::json!({ "error": {} })).is_empty());
    }

    /// Runs the real Codex CLI: `cargo test --lib codex_app_server_lists -- --ignored`.
    #[test]
    #[ignore = "needs an installed, signed-in Codex CLI"]
    fn codex_app_server_lists_models_when_installed() {
        let bin = super::find_windows_cli_launcher("codex").expect("codex installed");
        let models = super::codex_app_server_models(&bin.to_string_lossy());
        assert!(!models.is_empty(), "no models from the app-server");
    }

    #[test]
    fn codex_models_carry_the_efforts_each_one_advertises() {
        let reply = serde_json::json!({
            "id": 2,
            "result": { "data": [
                {
                    "model": "gpt-5.6-sol",
                    "displayName": "GPT-5.6-Sol",
                    "isDefault": true,
                    "defaultReasoningEffort": "low",
                    "supportedReasoningEfforts": [
                        { "reasoningEffort": "low" },
                        { "reasoningEffort": "ultra" },
                        { "reasoningEffort": "bad value; rm" }
                    ]
                },
                { "model": "gpt-5.5" }
            ] }
        });
        let models = super::parse_codex_model_list(&reply);
        assert_eq!(
            models[0].efforts.as_deref(),
            Some(&["low".to_string(), "ultra".to_string()][..])
        );
        assert_eq!(models[0].default_effort.as_deref(), Some("low"));
        assert!(models[0].is_default);
        assert_eq!(models[1].efforts, None);
        assert!(!models[1].is_default);
    }

    #[test]
    fn claude_models_come_from_the_initialize_handshake() {
        let reply = serde_json::json!({
            "type": "control_response",
            "response": { "subtype": "success", "request_id": "x", "response": { "models": [
                { "value": "default", "displayName": "Default (recommended)", "supportsEffort": true, "supportedEffortLevels": ["low", "max"] },
                { "value": "haiku", "displayName": "Haiku 4.5", "supportsEffort": false },
                { "value": "claude-opus-4-6", "displayName": "Opus 4.6", "supportsEffort": true, "supportedEffortLevels": ["low", "medium", "high", "max"] }
            ] } }
        });
        let models = super::parse_claude_initialize_models(&reply);
        let ids: Vec<&str> = models.iter().map(|model| model.id.as_str()).collect();
        assert_eq!(ids, ["default", "haiku", "claude-opus-4-6"]);
        assert!(models[0].is_default);
        assert_eq!(
            models[1].efforts.as_deref(),
            Some(&[][..]),
            "no effort for haiku"
        );
        assert_eq!(models[2].label, "Opus 4.6");
        assert!(super::parse_claude_initialize_models(&serde_json::json!({})).is_empty());
    }

    #[test]
    fn claude_falls_back_to_its_aliases() {
        let ids: Vec<String> = super::claude_alias_models()
            .into_iter()
            .map(|model| model.id)
            .collect();
        assert_eq!(ids, ["opus", "sonnet", "haiku", "fable"]);
    }

    /// Runs the real Claude CLI: `cargo test --lib claude_initialize_lists -- --ignored`.
    #[test]
    #[ignore = "needs an installed Claude Code CLI"]
    fn claude_initialize_lists_models_when_installed() {
        let bin = super::find_windows_cli_launcher("claude").expect("claude installed");
        let models = super::claude_initialize_models(&bin.to_string_lossy());
        assert!(models.iter().any(|model| model.is_default), "{models:?}");
    }

    #[cfg(not(windows))]
    #[test]
    fn a_cli_found_outside_path_brings_its_own_directory_along() {
        let launcher = std::path::Path::new("/home/me/.nvm/versions/node/v24.15.0/bin/claude");
        let path = super::path_with_launcher_dir(launcher, Some("/usr/bin:/bin".as_ref()))
            .expect("a new PATH");
        assert_eq!(
            path,
            "/home/me/.nvm/versions/node/v24.15.0/bin:/usr/bin:/bin"
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn a_cli_already_on_path_leaves_it_alone() {
        let launcher = std::path::Path::new("/usr/bin/claude");
        assert_eq!(
            super::path_with_launcher_dir(launcher, Some("/usr/bin:/bin".as_ref())),
            None
        );
        assert_eq!(
            super::path_with_launcher_dir(std::path::Path::new("claude"), None),
            None
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn an_agent_terminal_can_find_node_next_to_its_cli() {
        let builder = super::command_builder_for_terminal(
            Some("claude"),
            Some("/opt/alethe-test/node/bin/claude"),
            &[],
        );
        let path = builder
            .get_env("PATH")
            .expect("PATH")
            .to_string_lossy()
            .into_owned();
        assert!(path.starts_with("/opt/alethe-test/node/bin:"), "{path}");
    }

    #[test]
    fn a_terminal_gets_the_sessions_own_value_of_a_webview_workaround() {
        let mut builder = portable_pty::CommandBuilder::new("sh");
        builder.env("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        super::restore_env(&mut builder, &[("WEBKIT_DISABLE_DMABUF_RENDERER", None)]);
        assert_eq!(builder.get_env("WEBKIT_DISABLE_DMABUF_RENDERER"), None);

        builder.env("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        super::restore_env(
            &mut builder,
            &[("WEBKIT_DISABLE_DMABUF_RENDERER", Some("0".into()))],
        );
        assert_eq!(
            builder.get_env("WEBKIT_DISABLE_DMABUF_RENDERER"),
            Some(std::ffi::OsStr::new("0"))
        );
    }

    use super::*;
    use std::path::PathBuf;

    #[test]
    fn accepts_model_ids_and_rejects_cli_prose() {
        for id in ["claude-sonnet-4-5", "gpt-5", "o3-mini", "model-error-free"] {
            assert!(is_valid_model_id(id), "expected valid model id: {id}");
        }

        for id in [
            "",
            "ab",
            "--help",
            "# comment",
            "gpt 5",
            "usage: claude [options]",
            "Usage: claude [options]",
            "could not find model",
            "ERROR: invalid model",
            "failed to list models",
            "let me explain",
            "flags: --json",
            "available models:",
        ] {
            assert!(!is_valid_model_id(id), "expected invalid model id: {id}");
        }
    }

    #[test]
    fn dedupe_paths_drops_empty_values_and_keeps_first_spelling() {
        let paths = dedupe_paths(vec![
            PathBuf::from("  "),
            PathBuf::from(r"C:\Bin"),
            PathBuf::from(r"c:\bin"),
            PathBuf::from(r"D:\Tools"),
            PathBuf::from(""),
        ]);

        assert_eq!(
            paths,
            vec![PathBuf::from(r"C:\Bin"), PathBuf::from(r"D:\Tools")]
        );
    }

    #[cfg(windows)]
    #[test]
    fn expands_windows_environment_variables_case_insensitively() {
        std::env::set_var("alethe_test_path", r"C:\Tools");

        assert_eq!(
            expand_windows_env_vars(r"%ALETHE_TEST_PATH%\bin;%alethe_test_path%"),
            r"C:\Tools\bin;C:\Tools"
        );
        assert_eq!(expand_windows_env_vars(r"%NOPE%"), r"%NOPE%");

        std::env::remove_var("alethe_test_path");
    }

    #[cfg(windows)]
    #[test]
    fn splits_expanded_windows_paths_and_drops_empty_segments() {
        assert_eq!(
            split_windows_path_expanded(r"a;; b ;"),
            vec![PathBuf::from("a"), PathBuf::from("b")]
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn resolves_cli_launcher_on_unix() {
        assert!(find_windows_cli_launcher("sh").is_some());
        assert!(find_windows_cli_launcher("non_existent_binary_xyz_123").is_none());
    }

    /// With the Linux user-bin-dirs fallback, an agent installed via
    /// `npm --prefix ~/.npm-global` is found even under a minimal desktop-menu
    /// PATH.
    #[cfg(target_os = "linux")]
    #[test]
    fn linux_user_bin_dirs_finds_npm_global_agents() {
        let home = std::env::temp_dir().join("alethe-audit-home");
        let npm_global = home.join(".npm-global").join("bin");
        std::fs::create_dir_all(&npm_global).expect("create npm-global dir");
        std::fs::write(npm_global.join("fake-agent-audit"), "#!/bin/sh\necho hi\n")
            .expect("write fake agent");
        let original_home = std::env::var_os("HOME");
        let original_path = std::env::var_os("PATH");
        std::env::set_var("HOME", &home);
        std::env::set_var(
            "PATH",
            "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        );
        let found = find_windows_cli_launcher("fake-agent-audit");
        assert!(
            found.is_some(),
            "linux_user_bin_dirs should find npm-global installs: {found:?}"
        );
        if let Some(h) = original_home {
            std::env::set_var("HOME", h);
        } else {
            std::env::remove_var("HOME");
        }
        if let Some(p) = original_path {
            std::env::set_var("PATH", p);
        } else {
            std::env::remove_var("PATH");
        }
        let _ = std::fs::remove_dir_all(&home);
    }
}
