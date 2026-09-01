use portable_pty::CommandBuilder;
use std::collections::HashMap;
use std::env;
use std::fs;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::SystemTime;

#[cfg(windows)]
use winreg::{enums::*, RegKey};

static REBUILT_PATH: OnceLock<String> = OnceLock::new();

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
    builder.env("TERM", "xterm-256color");
    builder.env("COLORTERM", "truecolor");

    // terminal vai renderizar. Confirmado com um teste isolado rodando o

    // — nem DECRQSS/XTGETTCAP, embora responda OSC 10/11/DSR/DA

    // causa conhecida de "artefatos estranhos contendo '66'" em terminais

    if trimmed == Some("opencode") {
        builder.env("OPENTUI_FORCE_EXPLICIT_WIDTH", "false");
    }
    scrub_editor_environment(&mut builder);
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

fn resolve_cli_launcher(command: &str) -> Option<PathBuf> {
    #[cfg(not(windows))]
    {
        if let Ok(path) = which::which(command) {
            return Some(path);
        }
        let mut dirs = Vec::<PathBuf>::new();
        if let Some(home) = env::var_os("HOME").map(PathBuf::from) {
            dirs.push(home.join(".local").join("bin"));
            dirs.push(home.join(".cargo").join("bin"));
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

        // exclusivamente `agy`. Nunca use o desktop como fallback para o CLI.
        let candidates_to_try = match command {
            "antigravity" | "agy" => vec!["agy"],
            other => vec![other],
        };

        for cmd_name in candidates_to_try {
            for dir in &dirs {
                for extension in ["cmd", "exe", "bat", "ps1"] {
                    let candidate = dir.join(format!("{cmd_name}.{extension}"));
                    if candidate.is_file() {
                        return Some(candidate);
                    }
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

/// Version the agent's CLI reports, or `None` when it is missing or answers nothing usable.
#[tauri::command]
pub async fn agent_cli_version(agent: String) -> Option<String> {
    tokio::task::spawn_blocking(move || {
        let bin = find_windows_cli_launcher(&agent)?;
        for flag in VERSION_FLAGS {
            let mut command = std::process::Command::new(&bin);
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
    })
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
        which::which("code").ok()
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
    REBUILT_PATH.get_or_init(build_rebuilt_path).clone()
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

#[derive(serde::Serialize, serde::Deserialize, Debug, Clone)]
pub struct ModelOption {
    pub id: String,
    pub label: String,
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

fn discover_provider_models_inner(provider: String) -> Result<Vec<ModelOption>, String> {
    let mut models = Vec::new();
    let provider_lower = provider.to_lowercase();

    let cmd_name = match provider_lower.as_str() {
        "antigravity" | "agy" => "agy",
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
                        models.push(ModelOption {
                            label: format!("{id} (Antigravity agy)"),
                            id,
                        });
                    }
                }
            }
            if models.is_empty() {
                models.push(ModelOption {
                    id: "gemini-2.5-pro".into(),
                    label: "Gemini 2.5 Pro (Google DeepMind)".into(),
                });
                models.push(ModelOption {
                    id: "gemini-2.5-flash".into(),
                    label: "Gemini 2.5 Flash (Google DeepMind)".into(),
                });
                models.push(ModelOption {
                    id: "claude-3.7-sonnet".into(),
                    label: "Claude 3.7 Sonnet (Anthropic)".into(),
                });
                models.push(ModelOption {
                    id: "deepseek-r1".into(),
                    label: "DeepSeek R1 (Reasoning)".into(),
                });
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
                        models.push(ModelOption {
                            label: format!("{id} (OpenCode CLI)"),
                            id,
                        });
                    }
                }
            }
        }
        "claude" => {
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
                        models.push(ModelOption {
                            label: format!("{id} (Claude CLI)"),
                            id,
                        });
                    }
                }
            }
            if models.is_empty() {
                models.push(ModelOption {
                    id: "claude-3-7-sonnet".into(),
                    label: "Claude 3.7 Sonnet (Anthropic)".into(),
                });
                models.push(ModelOption {
                    id: "claude-3-5-sonnet".into(),
                    label: "Claude 3.5 Sonnet (Anthropic)".into(),
                });
                models.push(ModelOption {
                    id: "claude-3-5-haiku".into(),
                    label: "Claude 3.5 Haiku (Anthropic)".into(),
                });
                models.push(ModelOption {
                    id: "claude-3-opus".into(),
                    label: "Claude 3 Opus (Anthropic)".into(),
                });
            }
        }
        "codex" => {
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
                        models.push(ModelOption {
                            label: format!("{id} (Codex CLI)"),
                            id,
                        });
                    }
                }
            }
            if models.is_empty() {
                models.push(ModelOption {
                    id: "gpt-4o".into(),
                    label: "GPT-4o (OpenAI)".into(),
                });
                models.push(ModelOption {
                    id: "o3-mini".into(),
                    label: "o3-mini (Raciocínio OpenAI)".into(),
                });
                models.push(ModelOption {
                    id: "o1".into(),
                    label: "o1 (OpenAI)".into(),
                });
                models.push(ModelOption {
                    id: "gpt-4o-mini".into(),
                    label: "GPT-4o mini (OpenAI)".into(),
                });
            }
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
                        models.push(ModelOption {
                            label: format!("{id} (Mimo CLI)"),
                            id,
                        });
                    }
                }
            }
            if models.is_empty() {
                models.push(ModelOption {
                    id: "mimo-v1-pro".into(),
                    label: "Mimo V1 Pro (Xiaomi AI)".into(),
                });
                models.push(ModelOption {
                    id: "mimo-v1-flash".into(),
                    label: "Mimo V1 Flash (Xiaomi AI)".into(),
                });
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
                        models.push(ModelOption {
                            label: format!("{id} (Freebuff CLI)"),
                            id,
                        });
                    }
                }
            }
            if models.is_empty() {
                models.push(ModelOption {
                    id: "freebuff-auto".into(),
                    label: "Freebuff Auto-Router".into(),
                });
                models.push(ModelOption {
                    id: "freebuff-fast".into(),
                    label: "Freebuff Fast".into(),
                });
            }
        }
        _ => {}
    }

    Ok(models)
}

/// `discover_provider_models_inner` roda `std::process::Command::output()`

/// `find_cli_launcher` acima.
#[tauri::command]
pub async fn discover_provider_models(provider: String) -> Result<Vec<ModelOption>, String> {
    tokio::task::spawn_blocking(move || discover_provider_models_inner(provider))
        .await
        .map_err(|error| format!("discover_provider_models: falha na task bloqueante: {error}"))?
}

#[cfg(test)]
mod tests {
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
