use portable_pty::CommandBuilder;
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
    // O framework de TUI do OpenCode (`opentui`) manda uma query OSC 66 pra
    // cada glifo antes de desenhar, tentando confirmar a largura exata que o
    // terminal vai renderizar. Confirmado com um teste isolado rodando o
    // xterm.js real: ele nunca responde OSC 66 (não implementa esse handler
    // — nem DECRQSS/XTGETTCAP, embora responda OSC 10/11/DSR/DA
    // normalmente). A própria documentação do opentui descreve isso como
    // causa conhecida de "artefatos estranhos contendo '66'" em terminais
    // sem esse suporte (ex.: GNOME Terminal) — bate com os blocos cinza
    // soltos e a área principal em branco vistos no Alethe. `false` faz o
    // opentui nem mandar a query (evita os artefatos) e assumir largura 1
    // por padrão, sem esperar uma resposta que o xterm.js nunca vai dar.
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

/// Tauri command — versão pública pro frontend pré-checar se um agent está
/// resolvível antes de tentar spawnar. Retorna o path absoluto se achou.
///
/// `async` + `spawn_blocking`: a varredura faz várias checagens de
/// filesystem (potencialmente lentas em disco de rede/antivírus) e, se
/// rodasse como `fn` síncrona, travaria a thread de despacho de IPC do
/// Tauri — mesmo bug já corrigido em `graphify.rs`/`opencode_gsd_plugin.rs`.
#[tauri::command]
pub async fn find_cli_launcher(agent: String) -> Option<String> {
    tokio::task::spawn_blocking(move || {
        find_windows_cli_launcher(&agent).map(|p| p.to_string_lossy().to_string())
    })
    .await
    .unwrap_or(None)
}

pub fn find_windows_cli_launcher(command: &str) -> Option<PathBuf> {
    #[cfg(not(windows))]
    {
        return which::which(command).ok();
    }

    #[cfg(windows)]
    {
        let mut dirs = Vec::<PathBuf>::new();
        dirs.extend(split_windows_path_expanded(&rebuilt_path()));
        dirs.extend(agent_search_dirs());

        // `antigravity` é o desktop Electron; o agente de terminal oficial é
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

/// Procura o launcher do VS Code (code) em localizações comuns + PATH.
/// Retorna o primeiro que existir.
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
        dirs.push(profile.join("AppData").join("Local").join("agy").join("bin"));
        dirs.push(profile.join("AppData").join("Local").join("antigravity").join("bin"));
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
        return env::var("PATH").unwrap_or_default();
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
            if let Ok(output) = std::process::Command::new(&bin_path)
                .arg("models")
                .output()
            {
                let stdout = String::from_utf8_lossy(&output.stdout);
                for line in stdout.lines() {
                    let trimmed = line.trim();
                    let id = trimmed.split_whitespace().next().unwrap_or(trimmed).to_string();
                    if is_valid_model_id(&id) {
                        models.push(ModelOption {
                            label: format!("{id} (Antigravity agy)"),
                            id,
                        });
                    }
                }
            }
            if models.is_empty() {
                models.push(ModelOption { id: "gemini-2.5-pro".into(), label: "Gemini 2.5 Pro (Google DeepMind)".into() });
                models.push(ModelOption { id: "gemini-2.5-flash".into(), label: "Gemini 2.5 Flash (Google DeepMind)".into() });
                models.push(ModelOption { id: "claude-3.7-sonnet".into(), label: "Claude 3.7 Sonnet (Anthropic)".into() });
                models.push(ModelOption { id: "deepseek-r1".into(), label: "DeepSeek R1 (Reasoning)".into() });
            }
        }
        "opencode" => {
            if let Ok(output) = std::process::Command::new(&bin_path)
                .arg("models")
                .output()
            {
                let stdout = String::from_utf8_lossy(&output.stdout);
                for line in stdout.lines() {
                    let trimmed = line.trim();
                    let id = trimmed.split_whitespace().next().unwrap_or(trimmed).to_string();
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
            if let Ok(output) = std::process::Command::new(&bin_path)
                .arg("models")
                .output()
            {
                let stdout = String::from_utf8_lossy(&output.stdout);
                for line in stdout.lines() {
                    let trimmed = line.trim();
                    let id = trimmed.split_whitespace().next().unwrap_or(trimmed).to_string();
                    if is_valid_model_id(&id) {
                        models.push(ModelOption {
                            label: format!("{id} (Claude CLI)"),
                            id,
                        });
                    }
                }
            }
            if models.is_empty() {
                models.push(ModelOption { id: "claude-3-7-sonnet".into(), label: "Claude 3.7 Sonnet (Anthropic)".into() });
                models.push(ModelOption { id: "claude-3-5-sonnet".into(), label: "Claude 3.5 Sonnet (Anthropic)".into() });
                models.push(ModelOption { id: "claude-3-5-haiku".into(), label: "Claude 3.5 Haiku (Anthropic)".into() });
                models.push(ModelOption { id: "claude-3-opus".into(), label: "Claude 3 Opus (Anthropic)".into() });
            }
        }
        "codex" => {
            if let Ok(output) = std::process::Command::new(&bin_path)
                .arg("models")
                .output()
            {
                let stdout = String::from_utf8_lossy(&output.stdout);
                for line in stdout.lines() {
                    let trimmed = line.trim();
                    let id = trimmed.split_whitespace().next().unwrap_or(trimmed).to_string();
                    if is_valid_model_id(&id) {
                        models.push(ModelOption {
                            label: format!("{id} (Codex CLI)"),
                            id,
                        });
                    }
                }
            }
            if models.is_empty() {
                models.push(ModelOption { id: "gpt-4o".into(), label: "GPT-4o (OpenAI)".into() });
                models.push(ModelOption { id: "o3-mini".into(), label: "o3-mini (Raciocínio OpenAI)".into() });
                models.push(ModelOption { id: "o1".into(), label: "o1 (OpenAI)".into() });
                models.push(ModelOption { id: "gpt-4o-mini".into(), label: "GPT-4o mini (OpenAI)".into() });
            }
        }
        "mimo" => {
            if let Ok(output) = std::process::Command::new(&bin_path)
                .arg("models")
                .output()
            {
                let stdout = String::from_utf8_lossy(&output.stdout);
                for line in stdout.lines() {
                    let trimmed = line.trim();
                    let id = trimmed.split_whitespace().next().unwrap_or(trimmed).to_string();
                    if is_valid_model_id(&id) {
                        models.push(ModelOption {
                            label: format!("{id} (Mimo CLI)"),
                            id,
                        });
                    }
                }
            }
            if models.is_empty() {
                models.push(ModelOption { id: "mimo-v1-pro".into(), label: "Mimo V1 Pro (Xiaomi AI)".into() });
                models.push(ModelOption { id: "mimo-v1-flash".into(), label: "Mimo V1 Flash (Xiaomi AI)".into() });
            }
        }
        "freebuff" => {
            if let Ok(output) = std::process::Command::new(&bin_path)
                .arg("models")
                .output()
            {
                let stdout = String::from_utf8_lossy(&output.stdout);
                for line in stdout.lines() {
                    let trimmed = line.trim();
                    let id = trimmed.split_whitespace().next().unwrap_or(trimmed).to_string();
                    if is_valid_model_id(&id) {
                        models.push(ModelOption {
                            label: format!("{id} (Freebuff CLI)"),
                            id,
                        });
                    }
                }
            }
            if models.is_empty() {
                models.push(ModelOption { id: "freebuff-auto".into(), label: "Freebuff Auto-Router".into() });
                models.push(ModelOption { id: "freebuff-fast".into(), label: "Freebuff Fast".into() });
            }
        }
        _ => {}
    }

    Ok(models)
}

/// `discover_provider_models_inner` roda `std::process::Command::output()`
/// (subprocesso bloqueante) — precisa de `spawn_blocking` pra não travar a
/// thread de despacho de IPC do Tauri, mesmo motivo do fix em
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

        assert_eq!(paths, vec![PathBuf::from(r"C:\Bin"), PathBuf::from(r"D:\Tools")]);
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
}
