//! Abertura do Alethe pelo terminal — `alethe`, `alethe .`, `alethe <path>`.
//!
//! O fluxo tem dois caminhos, porque o app é single-instance:
//!
//! - **Cold start** (Alethe fechado): o diretório resolvido de `argv` fica
//!   guardado em [`PendingOpen`]. O frontend consome uma única vez no boot via
//!   `cli_take_pending_open` — não dá pra emitir evento aqui, a webview ainda
//!   não existe.
//! - **App já aberto**: o callback do `tauri-plugin-single-instance` recebe o
//!   `argv`/`cwd` da segunda instância (que morre em seguida) e emite
//!   [`OPEN_PATH_EVENT`] pra webview viva.
//!
//! A resolução só acontece quando há um caminho **explícito** no `argv`. Isso é
//! deliberado: abrir por ícone (Finder/Explorer/menu) não passa caminho nenhum,
//! e cair no `cwd` nesse caso criaria projeto de `/` ou `C:\Windows\system32`. O
//! shim gerado em `cli_shim.rs` é quem transforma `alethe` sem argumento no
//! `--open-path <pwd>` que chega aqui.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager};

/// Evento que carrega o diretório pedido pelo terminal até o frontend.
pub const OPEN_PATH_EVENT: &str = "alethe://open-path";

/// Flag que o shim sempre passa. Aceitamos também `--open-path=<dir>` e um
/// posicional solto (pra quem chama o binário na mão, sem shim).
const OPEN_PATH_FLAG: &str = "--open-path";

/// Diretório pedido no cold start, antes de existir webview pra receber evento.
/// Consumido uma única vez (`take`) — reabrir a janela não repete a ação.
#[derive(Default)]
pub struct PendingOpen(Mutex<Option<String>>);

/// Extrai o caminho cru do `argv`, ignorando `argv[0]` e qualquer outra flag.
///
/// Ignorar flags desconhecidas importa de verdade: o macOS injeta `-psn_0_1234`
/// quando o app sobe pelo LaunchServices, e `tauri dev` passa flags próprias.
/// Sem esse filtro, `-psn_0_1234` viraria "caminho" e a resolução falharia.
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

/// Remove o prefixo verbatim (`\\?\`) que o `canonicalize` do Windows devolve.
///
/// O frontend compara esse caminho com o `defaultCwd` salvo dos projetos, e
/// `\\?\C:\dev\app` nunca casaria com `C:\dev\app` — o projeto existente seria
/// duplicado a cada `alethe .`.
fn strip_verbatim_prefix(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy();
    // Pasta em rede vira `\\?\UNC\servidor\share`; tirar só o `\\?\` deixaria
    // `UNC\servidor\share`, que não aponta pra lugar nenhum. O prefixo certo
    // de volta é `\\`.
    if let Some(stripped) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{stripped}"));
    }
    match text.strip_prefix(r"\\?\") {
        Some(stripped) => PathBuf::from(stripped),
        None => path,
    }
}

/// Canonicaliza e garante que o alvo é um diretório existente.
///
/// Apontar pra um arquivo (`alethe README.md`) abre a pasta que o contém, que é
/// o que o usuário quis dizer — projeto no Alethe é sempre um diretório.
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

/// `argv` + `cwd` → diretório a abrir. `None` quando não há caminho explícito
/// (abertura por ícone) ou quando o caminho passado não existe.
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
        // `.`, `..` e relativos resolvem contra o cwd de QUEM chamou — no caso
        // da segunda instância, o cwd vem do plugin, não do processo atual.
        cwd.join(candidate)
    };

    normalize_dir(&candidate)
}

/// Lê o `argv` do próprio processo no boot e guarda o alvo pro frontend puxar.
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

/// Callback da segunda instância: foca a janela viva e manda o diretório pra ela.
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

/// Consome (uma vez) o diretório pedido no cold start.
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

    /// Regressão: o macOS injeta `-psn_0_1234` na abertura via LaunchServices.
    #[test]
    fn skips_unknown_flags_like_macos_psn() {
        assert_eq!(extract_path_arg(&args(&["alethe", "-psn_0_1234"])), None);
        assert_eq!(
            extract_path_arg(&args(&["alethe", "-psn_0_1234", "/tmp/x"])),
            Some("/tmp/x".to_string())
        );
    }

    /// Abertura por ícone não passa caminho — não pode virar "abrir o cwd".
    #[test]
    fn no_args_means_no_target() {
        assert_eq!(extract_path_arg(&args(&["alethe"])), None);
        assert_eq!(resolve_target_dir(&args(&["alethe"]), Path::new("/")), None);
    }

    #[test]
    fn dot_resolves_against_caller_cwd() {
        let cwd = strip_verbatim_prefix(std::env::temp_dir().canonicalize().expect("temp dir"));
        let resolved = resolve_target_dir(&args(&["alethe", "."]), &cwd).expect("resolvido");
        assert_eq!(resolved, cwd);
    }

    #[test]
    fn relative_path_resolves_against_caller_cwd() {
        let base = strip_verbatim_prefix(std::env::temp_dir().canonicalize().expect("temp dir"));
        let nested = base.join("alethe-cli-test-rel");
        std::fs::create_dir_all(&nested).expect("criar dir");

        let resolved = resolve_target_dir(&args(&["alethe", "alethe-cli-test-rel"]), &base)
            .expect("resolvido");
        assert_eq!(resolved, nested);

        let _ = std::fs::remove_dir_all(&nested);
    }

    #[test]
    fn file_target_falls_back_to_its_directory() {
        let base = strip_verbatim_prefix(std::env::temp_dir().canonicalize().expect("temp dir"));
        let dir = base.join("alethe-cli-test-file");
        std::fs::create_dir_all(&dir).expect("criar dir");
        let file = dir.join("README.md");
        std::fs::write(&file, b"x").expect("escrever arquivo");

        let resolved =
            resolve_target_dir(&args(&["alethe", &file.to_string_lossy()]), Path::new("/"))
                .expect("resolvido");
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

    /// Pasta em rede: `\\?\UNC\srv\share` tem que voltar pra `\\srv\share`.
    #[test]
    fn restores_unc_network_paths() {
        assert_eq!(
            strip_verbatim_prefix(PathBuf::from(r"\\?\UNC\servidor\share\app")),
            PathBuf::from(r"\\servidor\share\app")
        );
    }
}
