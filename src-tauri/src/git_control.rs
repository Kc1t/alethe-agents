use serde::Serialize;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Output};
use std::thread::sleep;
use std::time::Duration;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileChange {
    path: String,
    original_path: Option<String>,
    status: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRepositoryStatus {
    repo_root: String,
    branch: String,
    detached: bool,
    ahead: u32,
    behind: u32,
    staged: Vec<GitFileChange>,
    changes: Vec<GitFileChange>,
    untracked: Vec<GitFileChange>,
    conflicts: Vec<GitFileChange>,
}

/// Aplica CREATE_NO_WINDOW no Windows pra que `git.exe` NÃO abra uma janela de
/// console a cada chamada. O GitControl faz polling de status a cada 3s (+ no
/// focus), então sem isso o usuário vê um festival de "terminais" piscando —
/// janelas de console abrindo e fechando sozinhas. No-op fora do Windows.
#[cfg(windows)]
pub(crate) fn hide_console(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
pub(crate) fn hide_console(_command: &mut Command) {}

/// Delays de backoff incremental pro retry de `index.lock` transitório.
const INDEX_LOCK_RETRY_DELAYS_MS: [u64; 3] = [200, 400, 800];

/// Resolve o "diretório administrativo" do git para o checkout em `dir`:
/// - Repo/clone normal (`.git` é DIRETÓRIO) ⇒ o próprio `.git` (nunca carrega o
///   marcador `locked` de worktree secundária — lock check aqui sempre reporta
///   "não travado").
/// - Worktree (`.git` é ARQUIVO, contém `gitdir: <path>`) ⇒ o `<path>` apontado,
///   que é `<repo-principal>/.git/worktrees/<id>` — é lá que vivem `locked` e
///   `index.lock` desse worktree específico.
fn git_admin_dir(dir: &Path) -> Option<PathBuf> {
    let dot_git = dir.join(".git");
    if dot_git.is_dir() {
        return Some(dot_git);
    }
    if dot_git.is_file() {
        let content = std::fs::read_to_string(&dot_git).ok()?;
        let gitdir = content.lines().find_map(|line| line.trim().strip_prefix("gitdir:"))?;
        return Some(PathBuf::from(gitdir.trim()));
    }
    None
}

/// Lê o motivo do lock ADMINISTRATIVO (`git worktree lock`), se o checkout em
/// `dir` estiver travado dessa forma. `None` = não travado administrativamente
/// (pode ainda ter um `index.lock` transitório — ver `index_lock_present`).
fn admin_lock_reason(dir: &Path) -> Option<String> {
    let locked_file = git_admin_dir(dir)?.join("locked");
    if !locked_file.is_file() {
        return None;
    }
    let reason = std::fs::read_to_string(&locked_file).unwrap_or_default();
    let trimmed = reason.trim();
    Some(if trimmed.is_empty() {
        "sem motivo especificado".to_string()
    } else {
        trimmed.to_string()
    })
}

fn index_lock_present(dir: &Path) -> bool {
    git_admin_dir(dir)
        .map(|admin_dir| admin_dir.join("index.lock").is_file())
        .unwrap_or(false)
}

/// Prefixo de erro estruturado pra lock administrativo — o front (`mergeStore`,
/// `projectsStore`) distingue isso de `git_command_failed:` pra não incrementar
/// `retryCount` nem tratar como corrupção (`TerminalError`) por engano.
pub(crate) fn admin_locked_error(reason: &str) -> String {
    format!("admin_locked:{reason}")
}

/// Camada de consciência de locks em cima de uma chamada git que já interpreta
/// código de saída (`Result<T, String>`). Precedência ABSOLUTA: lock
/// administrativo nunca tenta de novo — falha imediato com o motivo. Só
/// `index.lock` (transitório) aciona o retry com backoff 200/400/800ms.
///
/// `lock_target` é o checkout cujo estado de lock importa — nem sempre é o
/// mesmo diretório onde o comando roda (ex.: remover um worktree a partir da
/// raiz do repo principal, mas quem pode estar travado é o worktree-alvo).
pub(crate) fn with_lock_awareness<T>(
    lock_target: &Path,
    mut run: impl FnMut() -> Result<T, String>,
) -> Result<T, String> {
    if let Some(reason) = admin_lock_reason(lock_target) {
        return Err(admin_locked_error(&reason));
    }
    let mut attempt = 0;
    loop {
        match run() {
            Ok(value) => return Ok(value),
            Err(error) => {
                // Corrida rara: o lock administrativo pode ter aparecido entre a
                // checagem inicial e esta falha — reavalia antes de decidir retry.
                if let Some(reason) = admin_lock_reason(lock_target) {
                    return Err(admin_locked_error(&reason));
                }
                if attempt >= INDEX_LOCK_RETRY_DELAYS_MS.len() || !index_lock_present(lock_target) {
                    return Err(error);
                }
                sleep(Duration::from_millis(INDEX_LOCK_RETRY_DELAYS_MS[attempt]));
                attempt += 1;
            }
        }
    }
}

pub(crate) fn git_command(cwd: &Path, args: &[&str]) -> Result<Output, String> {
    let mut command = Command::new("git");
    command.current_dir(cwd).args(args);
    hide_console(&mut command);
    command.output().map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            "git_not_found".to_string()
        } else {
            format!("git_exec_failed:{error}")
        }
    })
}

fn push_if_dir(candidates: &mut Vec<PathBuf>, path: PathBuf) {
    if path.is_dir() && !candidates.iter().any(|candidate| candidate == &path) {
        candidates.push(path);
    }
}

fn drive_roots() -> Vec<PathBuf> {
    ('A'..='Z')
        .map(|letter| PathBuf::from(format!("{letter}:\\")))
        .filter(|path| path.is_dir())
        .collect()
}

fn resolve_input_directory(path: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("directory_not_found".to_string());
    }

    let expanded = if trimmed == "~" {
        dirs_next::home_dir().unwrap_or_else(|| PathBuf::from(trimmed))
    } else if let Some(rest) = trimmed.strip_prefix("~/").or_else(|| trimmed.strip_prefix("~\\")) {
        dirs_next::home_dir()
            .unwrap_or_else(|| PathBuf::from("~"))
            .join(rest.replace('/', "\\"))
    } else {
        PathBuf::from(trimmed)
    };

    if expanded.is_dir() {
        return expanded
            .canonicalize()
            .map_err(|_| "directory_not_found".to_string());
    }

    let mut candidates = Vec::new();
    let looks_unix_root = trimmed.starts_with('/') && !trimmed.starts_with("//") && !trimmed.starts_with("/mnt/");
    if looks_unix_root {
        let relative = trimmed.trim_start_matches('/').replace('/', "\\");
        let username = dirs_next::home_dir()
            .and_then(|home| home.file_name().map(|name| name.to_string_lossy().into_owned()));
        for drive in drive_roots() {
            push_if_dir(&mut candidates, drive.join(&relative));
            if let Some(name) = username.as_deref() {
                push_if_dir(&mut candidates, drive.join(name).join(&relative));
                push_if_dir(&mut candidates, drive.join("Users").join(name).join(&relative));
            }
        }
    }

    candidates
        .into_iter()
        .next()
        .and_then(|candidate| candidate.canonicalize().ok())
        .ok_or_else(|| "directory_not_found".to_string())
}

pub(crate) fn checked_output(cwd: &Path, args: &[&str]) -> Result<Output, String> {
    with_lock_awareness(cwd, || {
        let output = git_command(cwd, args)?;
        if output.status.success() {
            return Ok(output);
        }
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if stderr.is_empty() {
            "git_command_failed".to_string()
        } else {
            format!("git_command_failed:{stderr}")
        })
    })
}

pub(crate) fn repository_root(path: &str) -> Result<PathBuf, String> {
    let cwd = resolve_input_directory(path)?;
    let output = git_command(&cwd, &["rev-parse", "--show-toplevel"])?;
    if !output.status.success() {
        return Err("not_a_git_repository".to_string());
    }
    let root = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if root.is_empty() {
        return Err("not_a_git_repository".to_string());
    }
    PathBuf::from(root)
        .canonicalize()
        .map_err(|_| "not_a_git_repository".to_string())
}

/// Como `repository_root`, mas resolve pro checkout PRINCIPAL compartilhado,
/// não pro toplevel do checkout específico em `path`. Necessário porque
/// `path` pode ser uma worktree já isolada: worktrees vinculadas não têm seu
/// próprio `.git` real (é um arquivo apontando pro repo principal), mas
/// `--show-toplevel` chamado nelas devolve a PRÓPRIA worktree, não o repo
/// principal — usar isso como base pra criar uma worktree nova resultaria
/// numa worktree aninhada dentro da outra. `--git-common-dir` sempre aponta
/// pro `.git` do checkout principal, mesmo chamado de dentro de uma worktree
/// vinculada; o pai desse diretório é a raiz principal real.
pub(crate) fn main_repository_root(path: &str) -> Result<PathBuf, String> {
    let cwd = resolve_input_directory(path)?;
    let output = git_command(&cwd, &["rev-parse", "--path-format=absolute", "--git-common-dir"])?;
    if !output.status.success() {
        return Err("not_a_git_repository".to_string());
    }
    let common_dir = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if common_dir.is_empty() {
        return Err("not_a_git_repository".to_string());
    }
    let common_dir = PathBuf::from(common_dir)
        .canonicalize()
        .map_err(|_| "not_a_git_repository".to_string())?;
    common_dir
        .parent()
        .map(|p| p.to_path_buf())
        .ok_or_else(|| "not_a_git_repository".to_string())
}

fn validated_root(path: &str) -> Result<PathBuf, String> {
    let requested = resolve_input_directory(path).map_err(|_| "not_a_git_repository".to_string())?;
    let actual = repository_root(path)?;
    if requested != actual {
        return Err("invalid_repository_root".to_string());
    }
    Ok(actual)
}

fn validate_paths(paths: &[String]) -> Result<(), String> {
    if paths.is_empty() {
        return Err("no_paths".to_string());
    }
    for path in paths {
        let parsed = Path::new(path);
        let bytes = path.as_bytes();
        let has_windows_drive_root = bytes.len() >= 3
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && matches!(bytes[2], b'/' | b'\\');
        let is_cross_platform_rooted =
            matches!(bytes.first(), Some(b'/' | b'\\')) || has_windows_drive_root;
        let has_cross_platform_parent = path.split(['/', '\\']).any(|component| component == "..");
        if parsed.is_absolute()
            || is_cross_platform_rooted
            || has_cross_platform_parent
            || path.trim().is_empty()
            || parsed.components().any(|part| {
                matches!(
                    part,
                    Component::ParentDir | Component::RootDir | Component::Prefix(_)
                )
            })
        {
            return Err("invalid_git_path".to_string());
        }
    }
    Ok(())
}

fn run_path_command(root: &Path, args: &[&str], paths: &[String]) -> Result<(), String> {
    validate_paths(paths)?;
    with_lock_awareness(root, || {
        let mut command = Command::new("git");
        command.current_dir(root).args(args).arg("--");
        for path in paths {
            command.arg(path);
        }
        hide_console(&mut command);
        let output = command.output().map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                "git_not_found".to_string()
            } else {
                format!("git_exec_failed:{error}")
            }
        })?;
        if output.status.success() {
            Ok(())
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            Err(format!("git_command_failed:{stderr}"))
        }
    })
}

fn change(path: String, original_path: Option<String>, status: char) -> GitFileChange {
    GitFileChange {
        path,
        original_path,
        status: status.to_string(),
    }
}

fn is_conflict(x: char, y: char) -> bool {
    matches!(
        (x, y),
        ('D', 'D') | ('A', 'U') | ('U', 'D') | ('U', 'A') | ('D', 'U') | ('A', 'A') | ('U', 'U')
    )
}

fn parse_porcelain(
    output: &[u8],
) -> (
    Vec<GitFileChange>,
    Vec<GitFileChange>,
    Vec<GitFileChange>,
    Vec<GitFileChange>,
) {
    let fields = output.split(|byte| *byte == 0).collect::<Vec<_>>();
    let mut staged = Vec::new();
    let mut changes = Vec::new();
    let mut untracked = Vec::new();
    let mut conflicts = Vec::new();
    let mut index = 0;

    while index < fields.len() {
        let field = fields[index];
        index += 1;
        if field.len() < 3 {
            continue;
        }
        let x = field[0] as char;
        let y = field[1] as char;
        let path = String::from_utf8_lossy(&field[3..]).into_owned();
        let renamed = matches!(x, 'R' | 'C') || matches!(y, 'R' | 'C');
        let original_path = if renamed && index < fields.len() {
            let value = String::from_utf8_lossy(fields[index]).into_owned();
            index += 1;
            Some(value)
        } else {
            None
        };

        if x == '?' && y == '?' {
            untracked.push(change(path, None, '?'));
        } else if is_conflict(x, y) {
            conflicts.push(change(path, original_path, 'U'));
        } else {
            if x != ' ' {
                staged.push(change(path.clone(), original_path.clone(), x));
            }
            if y != ' ' {
                changes.push(change(path, original_path, y));
            }
        }
    }
    (staged, changes, untracked, conflicts)
}

fn branch_info(root: &Path) -> Result<(String, bool, u32, u32), String> {
    let symbolic = git_command(root, &["symbolic-ref", "--short", "-q", "HEAD"])?;
    let (branch, detached) = if symbolic.status.success() {
        (
            String::from_utf8_lossy(&symbolic.stdout).trim().to_string(),
            false,
        )
    } else {
        let short = checked_output(root, &["rev-parse", "--short", "HEAD"])
            .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
            .unwrap_or_else(|_| "HEAD".to_string());
        (short, true)
    };

    let divergence = git_command(
        root,
        &["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
    )?;
    let (ahead, behind) = if divergence.status.success() {
        let values = String::from_utf8_lossy(&divergence.stdout)
            .split_whitespace()
            .filter_map(|value| value.parse::<u32>().ok())
            .collect::<Vec<_>>();
        (
            values.first().copied().unwrap_or(0),
            values.get(1).copied().unwrap_or(0),
        )
    } else {
        (0, 0)
    };
    Ok((branch, detached, ahead, behind))
}

/// Diretórios/arquivos pesados ou gerados que nunca deveriam entrar no
/// primeiro commit de um `git init` automático — mesma lista de propósito
/// (embora não o mesmo array em memória) de `contract_check::SKIP_DIRS`.
/// Sem isso, `git add -A` num projeto real (ex.: um app com
/// `node_modules` de dependências) trava a UI por minutos escaneando e
/// hasheando dezenas de milhares de arquivos que ninguém quer versionados —
/// foi exatamente o que aconteceu testando num monorepo com >20k arquivos só
/// em `node_modules`. `.alethe/` entra porque é onde as PRÓPRIAS worktrees de
/// agente vão morar a partir de agora (não faz sentido commitar um checkout
/// git dentro de outro).
const GITIGNORE_SEED: &str = "\
node_modules/
target/
dist/
build/
.next/
.venv/
venv/
__pycache__/
.alethe/
.env
.env.local
";

/// Só escreve o `.gitignore` semente se a pasta ainda não tiver um — nunca
/// sobrescreve um `.gitignore` que o usuário já mantém.
fn seed_gitignore_if_missing(dir: &Path) {
    let path = dir.join(".gitignore");
    if path.exists() {
        return;
    }
    let _ = std::fs::write(&path, GITIGNORE_SEED);
}

/// Inicializa um repositório Git na pasta, com um commit inicial — `git
/// worktree add`/`git clone --local` (isolamento por agente) exigem um HEAD
/// válido pra funcionar, então só rodar `git init` não basta. Usado pela
/// oferta "Inicializar Git" quando o modal de projeto detecta que a pasta
/// ainda não é um repositório. Identidade do commit é fixa via `-c` (não
/// depende de `user.name`/`user.email` global do usuário estarem configurados).
/// Idempotente: se já for um repo, só devolve a raiz existente sem tocar em nada.
fn git_init_inner(path: String) -> Result<String, String> {
    if let Ok(root) = repository_root(&path) {
        return Ok(root.to_string_lossy().into_owned());
    }
    let dir = resolve_input_directory(&path)?;
    checked_output(&dir, &["init", "-b", "main"])?;
    seed_gitignore_if_missing(&dir);
    checked_output(&dir, &["add", "-A"])?;
    let identity = ["-c", "user.name=Alethe", "-c", "user.email=alethe@localhost"];
    let mut commit_args: Vec<&str> = identity.to_vec();
    commit_args.extend(["commit", "-m", "Commit inicial (Alethe)"]);
    // Pasta vazia (nada pra adicionar) faz o commit normal falhar por "nothing
    // to commit" — cai pro --allow-empty só nesse caso, só pra garantir HEAD.
    if checked_output(&dir, &commit_args).is_err() {
        let mut empty_args: Vec<&str> = identity.to_vec();
        empty_args.extend(["commit", "--allow-empty", "-m", "Commit inicial (Alethe)"]);
        checked_output(&dir, &empty_args)?;
    }
    repository_root(&path).map(|root| root.to_string_lossy().into_owned())
}

/// `async` + `spawn_blocking` pra todos os comandos deste módulo abaixo:
/// cada um faz shell-out bloqueante de `git` direto no corpo, e como `fn`
/// síncrona isso travaria a thread de despacho de IPC do Tauri — mesmo bug
/// já corrigido em `cli_resolver.rs`/`graphify.rs`. `git_status` em
/// particular é chamado a cada 3s pelo polling do `GitControl.tsx`.
#[tauri::command]
pub fn git_diff(repo_root: String, path: String, staged: bool) -> Result<String, String> {
    let mut args = vec!["diff"];
    if staged {
        args.push("--staged");
    }
    args.push("--");
    args.push(&path);

    let output = checked_output(Path::new(&repo_root), &args)?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    if stdout.contains("Binary files ") && stdout.contains(" differ") {
        return Err("Binary file cannot be displayed as text".to_string());
    }

    Ok(stdout)
}

#[tauri::command]
pub async fn git_init(path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || git_init_inner(path))
        .await
        .map_err(|error| format!("git_init: falha na task bloqueante: {error}"))?
}

fn git_status_inner(path: String) -> Result<GitRepositoryStatus, String> {
    let root = repository_root(&path)?;
    let status = checked_output(
        &root,
        &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    )?;
    let (staged, changes, untracked, conflicts) = parse_porcelain(&status.stdout);
    let (branch, detached, ahead, behind) = branch_info(&root)?;
    Ok(GitRepositoryStatus {
        repo_root: root.to_string_lossy().into_owned(),
        branch,
        detached,
        ahead,
        behind,
        staged,
        changes,
        untracked,
        conflicts,
    })
}

#[tauri::command]
pub async fn git_status(path: String) -> Result<GitRepositoryStatus, String> {
    tokio::task::spawn_blocking(move || git_status_inner(path))
        .await
        .map_err(|error| format!("git_status: falha na task bloqueante: {error}"))?
}

fn git_stage_inner(repo_root: String, paths: Vec<String>) -> Result<(), String> {
    let root = validated_root(&repo_root)?;
    run_path_command(&root, &["add"], &paths)
}

#[tauri::command]
pub async fn git_stage(repo_root: String, paths: Vec<String>) -> Result<(), String> {
    tokio::task::spawn_blocking(move || git_stage_inner(repo_root, paths))
        .await
        .map_err(|error| format!("git_stage: falha na task bloqueante: {error}"))?
}

fn git_unstage_inner(repo_root: String, paths: Vec<String>) -> Result<(), String> {
    let root = validated_root(&repo_root)?;
    let has_head = git_command(&root, &["rev-parse", "--verify", "HEAD"])
        .map(|output| output.status.success())
        .unwrap_or(false);
    if has_head {
        run_path_command(&root, &["restore", "--staged"], &paths)
            .or_else(|_| run_path_command(&root, &["reset", "HEAD"], &paths))
    } else {
        run_path_command(&root, &["rm", "-r", "--cached"], &paths)
    }
}

#[tauri::command]
pub async fn git_unstage(repo_root: String, paths: Vec<String>) -> Result<(), String> {
    tokio::task::spawn_blocking(move || git_unstage_inner(repo_root, paths))
        .await
        .map_err(|error| format!("git_unstage: falha na task bloqueante: {error}"))?
}

fn git_discard_inner(repo_root: String, paths: Vec<String>, untracked: bool) -> Result<(), String> {
    let root = validated_root(&repo_root)?;
    if untracked {
        run_path_command(&root, &["clean", "-fd"], &paths)
    } else {
        run_path_command(&root, &["restore", "--worktree"], &paths)
    }
}

#[tauri::command]
pub async fn git_discard(repo_root: String, paths: Vec<String>, untracked: bool) -> Result<(), String> {
    tokio::task::spawn_blocking(move || git_discard_inner(repo_root, paths, untracked))
        .await
        .map_err(|error| format!("git_discard: falha na task bloqueante: {error}"))?
}

fn git_commit_inner(repo_root: String, message: String) -> Result<String, String> {
    let root = validated_root(&repo_root)?;
    let trimmed = message.trim();
    if trimmed.is_empty() {
        return Err("empty_commit_message".to_string());
    }
    let output = checked_output(&root, &["commit", "-m", trimmed])?;
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[tauri::command]
pub async fn git_commit(repo_root: String, message: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || git_commit_inner(repo_root, message))
        .await
        .map_err(|error| format!("git_commit: falha na task bloqueante: {error}"))?
}

/// Comando git que fala com o remoto (push/pull). `GIT_TERMINAL_PROMPT=0` faz o
/// git FALHAR rápido em vez de TRAVAR esperando credenciais num prompt que não
/// existe (sem TTY no PTY oculto) — usa o credential helper / SSH agent já
/// configurados na máquina. stdout+stderr são combinados porque o git escreve o
/// progresso de rede no stderr mesmo em sucesso.
fn remote_command(root: &Path, args: &[&str]) -> Result<String, String> {
    with_lock_awareness(root, || {
        let mut command = Command::new("git");
        command
            .current_dir(root)
            .args(args)
            .env("GIT_TERMINAL_PROMPT", "0");
        hide_console(&mut command);
        let output = command.output().map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                "git_not_found".to_string()
            } else {
                format!("git_exec_failed:{error}")
            }
        })?;
        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);
            Ok(format!("{} {}", stdout.trim(), stderr.trim()).trim().to_string())
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            Err(format!("git_command_failed:{stderr}"))
        }
    })
}

fn git_push_inner(repo_root: String) -> Result<String, String> {
    let root = validated_root(&repo_root)?;
    match remote_command(&root, &["push"]) {
        // Branch sem upstream: publica em origin/<branch> (equivalente ao
        // "Publish Branch" do VSCode). Falha se o remoto não se chamar 'origin'.
        Err(error) if error.contains("no upstream") || error.contains("has no upstream") => {
            remote_command(&root, &["push", "--set-upstream", "origin", "HEAD"])
        }
        other => other,
    }
}

#[tauri::command]
pub async fn git_push(repo_root: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || git_push_inner(repo_root))
        .await
        .map_err(|error| format!("git_push: falha na task bloqueante: {error}"))?
}

/// Lista os branches locais (nome curto). Usado pelo ciclo de merge (RFC-006)
/// para escolher source/target.
fn git_list_branches_inner(repo_root: String) -> Result<Vec<String>, String> {
    let root = repository_root(&repo_root)?;
    let output = checked_output(&root, &["branch", "--format=%(refname:short)"])?;
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(|line| line.trim().to_string())
        .filter(|line| !line.is_empty())
        .collect())
}

#[tauri::command]
pub async fn git_list_branches(repo_root: String) -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(move || git_list_branches_inner(repo_root))
        .await
        .map_err(|error| format!("git_list_branches: falha na task bloqueante: {error}"))?
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffSummaryEntry {
    pub path: String,
    /// Primeira letra do `--name-status` do git: A(dded)/M(odified)/D(eleted)/R(enamed)/...
    pub status: String,
}

/// Um path é infraestrutura do próprio Alethe, não trabalho real do usuário,
/// se estiver em `.planning/` (estado do plugin GSD Sync) ou `.opencode/`/
/// `opencode.json` (MCP do Graphify + plugin GSD, escritos automaticamente a
/// cada spawn). Mesma exclusão já aplicada em `getChangedFiles` do plugin
/// GSD (`alethe-gsd-state.ts`) — sem ela, o Briefing de Testes listava
/// `.opencode/alethe-gsd-config.json`, `.planning/goal.md` etc. como se
/// fossem "alterações" feitas pelo agente, quando na verdade é o próprio
/// Alethe escrevendo essa infraestrutura na worktree.
fn is_alethe_infra_path(path: &str) -> bool {
    path.starts_with(".planning/") || path.starts_with(".opencode/") || path == "opencode.json"
}

/// Lê o que ainda não foi commitado na PRÓPRIA worktree (`git status
/// --porcelain`, working-tree aware — cobre staged/unstaged/untracked).
/// Complementa o diff por range de commits abaixo: sem isso, um arquivo
/// criado/editado na worktree e nunca commitado não aparece em nenhum commit
/// de `source`, então some do resumo de alterações mesmo sendo trabalho real
/// (foi exatamente o que o Gate de Verificação da Central de Merges reportava
/// como "não há alterações de código" com um arquivo de verdade na worktree).
fn uncommitted_entries(worktree_path: &Path) -> Vec<DiffSummaryEntry> {
    if !worktree_path.is_dir() {
        return Vec::new();
    }
    let Ok(output) = checked_output(
        worktree_path,
        &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    ) else {
        return Vec::new();
    };
    let fields: Vec<&[u8]> = output.stdout.split(|b| *b == 0).collect();
    let mut entries = Vec::new();
    let mut i = 0;
    while i < fields.len() {
        let field = fields[i];
        i += 1;
        if field.len() < 3 {
            continue;
        }
        let x = field[0] as char;
        let y = field[1] as char;
        let path = String::from_utf8_lossy(&field[3..]).into_owned();
        let renamed = matches!(x, 'R' | 'C') || matches!(y, 'R' | 'C');
        if renamed && i < fields.len() {
            i += 1; // pula o nome antigo — só o path atual importa aqui
        }
        // Reduz XY porcelain a uma letra representativa: prioriza o lado
        // "working tree" (y); untracked ("??") vira "A" (adicionado).
        let status = if x == '?' && y == '?' {
            'A'
        } else if y != ' ' {
            y
        } else {
            x
        };
        entries.push(DiffSummaryEntry { path, status: status.to_string() });
    }
    entries
}

/// Resumo real (arquivos alterados, não-conflito) do que `source` mudou em
/// relação a `target` — alimenta o "Briefing de Testes" da Central de Merges
/// com dado de verdade em vez de texto fixo. Three-dot (`target...source`,
/// mesmo espírito do `git diff` que o Revisor de Branch já roda no prompt),
/// **unido** com o estado não commitado da worktree (`uncommitted_entries`
/// acima) — só o range de commits ignora trabalho real ainda não commitado.
fn git_diff_summary_inner(
    repo_root: String,
    source: String,
    target: String,
    worktree_path: Option<String>,
) -> Result<Vec<DiffSummaryEntry>, String> {
    let root = repository_root(&repo_root)?;
    let range = format!("{target}...{source}");
    let output = checked_output(&root, &["diff", "--name-status", "-z", &range])?;
    let raw = String::from_utf8_lossy(&output.stdout);
    // Saída "-z": campos separados por NUL. Cada entrada normal é
    // "status\0path\0"; renomeações ("R100\0old\0new\0") têm um campo extra
    // (o nome novo) que também vira `path` — o nome antigo é descartado.
    let fields: Vec<&str> = raw.split('\0').filter(|s| !s.is_empty()).collect();
    let mut entries = Vec::new();
    let mut i = 0;
    while i < fields.len() {
        let status = fields[i].chars().next().unwrap_or('M').to_string();
        i += 1;
        if i >= fields.len() {
            break;
        }
        let mut path = fields[i].to_string();
        i += 1;
        if status.starts_with('R') || status.starts_with('C') {
            if i >= fields.len() {
                break;
            }
            path = fields[i].to_string();
            i += 1;
        }
        entries.push(DiffSummaryEntry { path, status });
    }

    if let Some(worktree) = worktree_path {
        let mut seen: std::collections::HashSet<String> =
            entries.iter().map(|e| e.path.clone()).collect();
        for entry in uncommitted_entries(Path::new(&worktree)) {
            if seen.insert(entry.path.clone()) {
                entries.push(entry);
            }
        }
    }

    entries.retain(|entry| !is_alethe_infra_path(&entry.path));

    Ok(entries)
}

#[tauri::command]
pub async fn git_diff_summary(
    repo_root: String,
    source: String,
    target: String,
    worktree_path: Option<String>,
) -> Result<Vec<DiffSummaryEntry>, String> {
    tokio::task::spawn_blocking(move || {
        git_diff_summary_inner(repo_root, source, target, worktree_path)
    })
    .await
    .map_err(|error| format!("git_diff_summary: falha na task bloqueante: {error}"))?
}

/// Um commit do histórico, pro gráfico de commits do painel de Controle de
/// versão — o cálculo de raia/coluna (lane) é sempre client-side (o próprio
/// `git log` não devolve coordenadas de gráfico prontas; VSCode/gitk fazem o
/// mesmo cálculo no cliente a partir de hash→pais), então aqui só devolvemos
/// os dados crus.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitEntry {
    pub hash: String,
    pub parents: Vec<String>,
    pub author_name: String,
    pub author_email: String,
    /// Segundos desde epoch (`%at`, o mesmo formato de `git log`).
    pub timestamp: i64,
    pub subject: String,
    /// Branches/tags apontando pra este commit (`%D`), vazio quando nenhuma.
    pub refs: Vec<String>,
}

/// Separador de campo improvável de aparecer em nome/e-mail/assunto de
/// commit — mesmo problema do `-z` do `git diff --name-status` acima, só que
/// aqui `-z` trocaria também o separador ENTRE commits, e `%s` (assunto) já é
/// garantidamente uma linha só pela própria convenção do git, então um
/// separador de campo simples (não-NUL) com quebra de linha normal entre
/// commits já resolve sem ambiguidade.
const LOG_GRAPH_FIELD_SEP: char = '\u{1f}';

fn git_log_graph_inner(repo: String, max_count: u32) -> Result<Vec<GitCommitEntry>, String> {
    let root = repository_root(&repo)?;
    let max_count_arg = format!("--max-count={max_count}");
    let format_arg = format!(
        "--format=%H{sep}%P{sep}%an{sep}%ae{sep}%at{sep}%s{sep}%D",
        sep = LOG_GRAPH_FIELD_SEP
    );
    let output = checked_output(&root, &["log", "--all", &max_count_arg, &format_arg])?;
    let stdout = String::from_utf8_lossy(&output.stdout);

    let entries = stdout
        .lines()
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| {
            let mut fields = line.split(LOG_GRAPH_FIELD_SEP);
            let hash = fields.next()?.to_string();
            let parents = fields
                .next()?
                .split_whitespace()
                .map(|s| s.to_string())
                .collect();
            let author_name = fields.next()?.to_string();
            let author_email = fields.next()?.to_string();
            let timestamp = fields.next()?.trim().parse().ok()?;
            let subject = fields.next()?.to_string();
            let refs_raw = fields.next().unwrap_or("").trim();
            let refs = if refs_raw.is_empty() {
                Vec::new()
            } else {
                refs_raw.split(", ").map(|s| s.trim().to_string()).collect()
            };
            Some(GitCommitEntry {
                hash,
                parents,
                author_name,
                author_email,
                timestamp,
                subject,
                refs,
            })
        })
        .collect();

    Ok(entries)
}

#[tauri::command]
pub async fn git_log_graph(repo: String, max_count: u32) -> Result<Vec<GitCommitEntry>, String> {
    tokio::task::spawn_blocking(move || git_log_graph_inner(repo, max_count))
        .await
        .map_err(|error| format!("git_log_graph: falha na task bloqueante: {error}"))?
}

fn git_pull_inner(repo_root: String) -> Result<String, String> {
    let root = validated_root(&repo_root)?;
    // --ff-only evita merge commit/conflito surpresa: se a branch divergiu, erra
    // limpo em vez de criar um merge automático.
    remote_command(&root, &["pull", "--ff-only"])
}

#[tauri::command]
pub async fn git_pull(repo_root: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || git_pull_inner(repo_root))
        .await
        .map_err(|error| format!("git_pull: falha na task bloqueante: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    // Testes chamam a lógica direto, fora de um runtime async — usam as
    // versões `_inner` (síncronas) por trás dos wrappers `async fn` que os
    // comandos IPC expõem, mesmo padrão de `worktrees.rs`/`graphify.rs`.
    use super::git_commit_inner as git_commit;
    use super::git_diff_summary_inner as git_diff_summary;
    use super::git_discard_inner as git_discard;
    use super::git_init_inner as git_init;
    use super::git_stage_inner as git_stage;
    use super::git_status_inner as git_status;
    use super::git_unstage_inner as git_unstage;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn parses_staged_unstaged_untracked_conflict_and_rename() {
        let input = b"M  staged.txt\0 M changed file.txt\0?? new.txt\0UU conflict.txt\0R  renamed.txt\0old.txt\0";
        let (staged, changes, untracked, conflicts) = parse_porcelain(input);
        assert_eq!(staged.len(), 2);
        assert_eq!(staged[1].path, "renamed.txt");
        assert_eq!(staged[1].original_path.as_deref(), Some("old.txt"));
        assert_eq!(changes[0].path, "changed file.txt");
        assert_eq!(untracked[0].path, "new.txt");
        assert_eq!(conflicts[0].path, "conflict.txt");
    }

    #[test]
    fn keeps_both_sides_of_partially_staged_file() {
        let (staged, changes, _, _) = parse_porcelain(b"MM both.txt\0");
        assert_eq!(staged[0].path, "both.txt");
        assert_eq!(changes[0].path, "both.txt");
    }

    #[test]
    fn main_repository_root_resolves_same_root_from_a_linked_worktree() {
        let suffix = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let root = std::env::temp_dir().join(format!("alethe-main-repo-root-{suffix}"));
        fs::create_dir_all(&root).unwrap();
        checked_output(&root, &["init", "-b", "main"]).unwrap();
        checked_output(&root, &["config", "user.name", "Alethe Test"]).unwrap();
        checked_output(&root, &["config", "user.email", "alethe@example.invalid"]).unwrap();
        fs::write(root.join("a.txt"), "a\n").unwrap();
        checked_output(&root, &["add", "-A"]).unwrap();
        checked_output(&root, &["commit", "-m", "base"]).unwrap();

        let worktree = root.join("wt");
        checked_output(
            &root,
            &["worktree", "add", "-b", "agent-branch", worktree.to_str().unwrap(), "HEAD"],
        )
        .unwrap();

        let from_main = main_repository_root(&root.to_string_lossy()).unwrap();
        let from_worktree = main_repository_root(&worktree.to_string_lossy()).unwrap();
        assert_eq!(from_main, from_worktree, "deve resolver a mesma raiz principal a partir de qualquer worktree");
        // `repository_root` (--show-toplevel), em contraste, devolveria a
        // PRÓPRIA worktree quando chamado de dentro dela — diferente da main.
        let toplevel_from_worktree = repository_root(&worktree.to_string_lossy()).unwrap();
        assert_ne!(from_worktree, toplevel_from_worktree);

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn rejects_paths_outside_repository() {
        assert!(validate_paths(&["../secret".to_string()]).is_err());
        assert!(validate_paths(&["..\\secret".to_string()]).is_err());
        // Caminho absoluto Unix — rejeitado em qualquer plataforma.
        assert!(validate_paths(&["/etc/secret".to_string()]).is_err());
        // O prefixo de drive do Windows só é reconhecido como `Component::Prefix`
        // no próprio Windows; em Unix `C:\secret` é um nome relativo válido.
        #[cfg(windows)]
        assert!(validate_paths(&["C:\\secret".to_string()]).is_err());
        assert!(validate_paths(&["/secret".to_string()]).is_err());
        assert!(validate_paths(&["\\\\server\\share".to_string()]).is_err());
        assert!(validate_paths(&["src/main.rs".to_string()]).is_ok());
        assert!(validate_paths(&["src\\main.rs".to_string()]).is_ok());
    }

    #[test]
    fn performs_stage_unstage_discard_and_commit() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("alethe-git-control-{suffix}"));
        fs::create_dir_all(&root).unwrap();
        let root_string = root.to_string_lossy().into_owned();
        let run = |args: &[&str]| checked_output(&root, args).unwrap();
        run(&["init"]);
        run(&["config", "user.name", "Alethe Test"]);
        run(&["config", "user.email", "alethe@example.invalid"]);

        fs::write(root.join("tracked.txt"), "one\n").unwrap();
        git_stage(root_string.clone(), vec!["tracked.txt".to_string()]).unwrap();
        assert_eq!(git_status(root_string.clone()).unwrap().staged.len(), 1);
        git_unstage(root_string.clone(), vec!["tracked.txt".to_string()]).unwrap();
        assert_eq!(git_status(root_string.clone()).unwrap().untracked.len(), 1);

        git_stage(root_string.clone(), vec!["tracked.txt".to_string()]).unwrap();
        git_commit(root_string.clone(), "initial".to_string()).unwrap();
        fs::write(root.join("tracked.txt"), "two\n").unwrap();
        assert_eq!(git_status(root_string.clone()).unwrap().changes.len(), 1);
        git_discard(root_string.clone(), vec!["tracked.txt".to_string()], false).unwrap();
        assert_eq!(
            fs::read_to_string(root.join("tracked.txt")).unwrap().trim(),
            "one"
        );

        fs::write(root.join("untracked.txt"), "remove me\n").unwrap();
        git_discard(root_string, vec!["untracked.txt".to_string()], true).unwrap();
        assert!(!root.join("untracked.txt").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn git_init_adopts_existing_files_into_a_first_commit() {
        let root = temp_dir("init-adopt");
        fs::write(root.join("existing.txt"), "already here\n").unwrap();
        let root_string = root.to_string_lossy().into_owned();

        let reported_root = git_init(root_string.clone()).unwrap();
        assert_eq!(PathBuf::from(&reported_root), root.canonicalize().unwrap());

        // O worktree/clone que consome isso precisa de um HEAD com os arquivos
        // já commitados — não um repo vazio.
        let status = git_status(root_string).unwrap();
        assert!(status.staged.is_empty() && status.changes.is_empty() && status.untracked.is_empty());
        let log = checked_output(&root, &["log", "--oneline"]).unwrap();
        assert_eq!(String::from_utf8_lossy(&log.stdout).lines().count(), 1);

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn git_init_excludes_heavy_dirs_from_the_first_commit() {
        let root = temp_dir("init-gitignore");
        fs::write(root.join("src.txt"), "real code\n").unwrap();
        fs::create_dir_all(root.join("node_modules").join("some-dep")).unwrap();
        fs::write(root.join("node_modules").join("some-dep").join("index.js"), "// dep\n").unwrap();
        let root_string = root.to_string_lossy().into_owned();

        git_init(root_string.clone()).unwrap();

        assert!(root.join(".gitignore").is_file());
        let tracked = checked_output(&root, &["ls-tree", "-r", "--name-only", "HEAD"]).unwrap();
        let tracked_names = String::from_utf8_lossy(&tracked.stdout);
        assert!(tracked_names.contains("src.txt"));
        assert!(!tracked_names.contains("node_modules"));

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn git_init_is_idempotent_on_an_existing_repo() {
        let root = temp_dir("init-idempotent");
        checked_output(&root, &["init"]).unwrap();
        checked_output(&root, &["config", "user.name", "Alethe Test"]).unwrap();
        checked_output(&root, &["config", "user.email", "alethe@example.invalid"]).unwrap();
        fs::write(root.join("a.txt"), "a\n").unwrap();
        checked_output(&root, &["add", "-A"]).unwrap();
        checked_output(&root, &["commit", "-m", "first"]).unwrap();

        let root_string = root.to_string_lossy().into_owned();
        git_init(root_string.clone()).unwrap();

        // Não deve ter criado um segundo commit nem tocado no repo existente.
        let log = checked_output(&root, &["log", "--oneline"]).unwrap();
        assert_eq!(String::from_utf8_lossy(&log.stdout).lines().count(), 1);

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn git_diff_summary_lists_added_modified_and_renamed_files_between_branches() {
        let root = temp_dir("diff-summary");
        checked_output(&root, &["init", "-b", "main"]).unwrap();
        checked_output(&root, &["config", "user.name", "Alethe Test"]).unwrap();
        checked_output(&root, &["config", "user.email", "alethe@example.invalid"]).unwrap();
        fs::write(root.join("kept.txt"), "same on both\n").unwrap();
        fs::write(root.join("old-name.txt"), "will be renamed\n").unwrap();
        checked_output(&root, &["add", "-A"]).unwrap();
        checked_output(&root, &["commit", "-m", "base"]).unwrap();

        checked_output(&root, &["checkout", "-b", "feature"]).unwrap();
        fs::write(root.join("kept.txt"), "changed on feature\n").unwrap();
        fs::write(root.join("new.txt"), "brand new\n").unwrap();
        checked_output(&root, &["add", "-A"]).unwrap();
        checked_output(&root, &["mv", "old-name.txt", "new-name.txt"]).unwrap();
        checked_output(&root, &["commit", "-m", "feature work"]).unwrap();

        let root_string = root.to_string_lossy().into_owned();
        let entries =
            git_diff_summary(root_string, "feature".to_string(), "main".to_string(), None).unwrap();

        let find = |path: &str| entries.iter().find(|e| e.path == path);
        assert!(find("kept.txt").is_some_and(|e| e.status == "M"));
        assert!(find("new.txt").is_some_and(|e| e.status == "A"));
        assert!(find("new-name.txt").is_some(), "rename deveria aparecer com o nome novo: {entries:?}");
        assert!(find("old-name.txt").is_none(), "rename não deveria duplicar o nome antigo: {entries:?}");

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn git_diff_summary_includes_uncommitted_worktree_changes() {
        // Reproduz o bug: um arquivo criado na worktree e NUNCA commitado não
        // aparece em nenhum commit de "feature", então o diff por range de
        // commits sozinho devolve lista vazia mesmo com trabalho real feito —
        // exatamente o "não há alterações de código" que o Gate de
        // Verificação da Central de Merges reportava incorretamente.
        let root = temp_dir("diff-summary-uncommitted");
        checked_output(&root, &["init", "-b", "main"]).unwrap();
        checked_output(&root, &["config", "user.name", "Alethe Test"]).unwrap();
        checked_output(&root, &["config", "user.email", "alethe@example.invalid"]).unwrap();
        fs::write(root.join("base.txt"), "base\n").unwrap();
        checked_output(&root, &["add", "-A"]).unwrap();
        checked_output(&root, &["commit", "-m", "base"]).unwrap();
        checked_output(&root, &["checkout", "-b", "feature"]).unwrap();

        // Sem worktree_path: comportamento antigo, cego a não commitado.
        let root_string = root.to_string_lossy().into_owned();
        let without_worktree = git_diff_summary(
            root_string.clone(),
            "feature".to_string(),
            "main".to_string(),
            None,
        )
        .unwrap();
        assert!(without_worktree.is_empty(), "sem worktree_path, diff de commits deve ficar vazio");

        fs::write(root.join("novo.txt"), "").unwrap();
        // Infraestrutura escrita automaticamente pelo próprio Alethe (plugin
        // GSD, MCP do Graphify) — nunca deve aparecer como "alteração" do
        // agente, mesmo estando não commitada como qualquer outro arquivo.
        fs::create_dir_all(root.join(".planning")).unwrap();
        fs::write(root.join(".planning").join("goal.md"), "").unwrap();
        fs::create_dir_all(root.join(".opencode").join("plugins")).unwrap();
        fs::write(root.join(".opencode").join("plugins").join("alethe-gsd-state.ts"), "").unwrap();
        fs::write(root.join("opencode.json"), "{}").unwrap();

        let with_worktree = git_diff_summary(
            root_string,
            "feature".to_string(),
            "main".to_string(),
            Some(root.to_string_lossy().into_owned()),
        )
        .unwrap();
        assert!(
            with_worktree.iter().any(|e| e.path == "novo.txt"),
            "com worktree_path, arquivo não commitado deve aparecer: {with_worktree:?}"
        );
        assert!(
            with_worktree.iter().all(|e| !e.path.starts_with(".planning/") && !e.path.starts_with(".opencode/") && e.path != "opencode.json"),
            "infraestrutura do Alethe (.planning/, .opencode/, opencode.json) nunca deve aparecer: {with_worktree:?}"
        );

        fs::remove_dir_all(root).unwrap();
    }

    fn temp_dir(label: &str) -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("alethe-git-control-{label}-{suffix}"));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn admin_lock_takes_precedence_and_is_never_retried() {
        // Repo comum (não-worktree): `.git` é diretório — o `locked` físico fica
        // direto dentro dele, simulando o mesmo layout que `.git/worktrees/<id>/`
        // teria para um worktree secundário.
        let root = temp_dir("adminlock");
        checked_output(&root, &["init"]).unwrap();
        fs::write(root.join(".git").join("locked"), "Aguardando homologacao\n").unwrap();

        let start = std::time::Instant::now();
        let error = checked_output(&root, &["status"]).unwrap_err();
        // Sem retry: falha imediata, bem abaixo do menor delay de backoff (200ms).
        assert!(start.elapsed() < Duration::from_millis(150));
        assert_eq!(error, "admin_locked:Aguardando homologacao");

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn transient_index_lock_is_retried_and_recovers() {
        let root = temp_dir("indexlock");
        checked_output(&root, &["init"]).unwrap();
        let lock_file = root.join(".git").join("index.lock");
        fs::write(&lock_file, b"").unwrap();

        // Simula outro processo git segurando o index.lock brevemente — some
        // antes do teto de 3 tentativas (200+400+800ms).
        let lock_file_clone = lock_file.clone();
        std::thread::spawn(move || {
            sleep(Duration::from_millis(250));
            let _ = fs::remove_file(&lock_file_clone);
        });

        // git recusa operações com index.lock presente — a chamada real falha até
        // o arquivo sumir; o retry do with_lock_awareness é o que faz isso
        // eventualmente ter sucesso sem o chamador precisar saber disso.
        let result = checked_output(&root, &["status"]);
        assert!(result.is_ok(), "esperava sucesso após o lock transitório sumir: {result:?}");

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn git_diff_returns_unstaged_changes() {
        let root = temp_dir("diff-unstaged");
        let root_string = root.to_string_lossy().into_owned();
        checked_output(&root, &["init"]).unwrap();
        checked_output(&root, &["config", "user.name", "Alethe Test"]).unwrap();
        checked_output(&root, &["config", "user.email", "alethe@example.invalid"]).unwrap();
        fs::write(root.join("file.txt"), "line1\n").unwrap();
        checked_output(&root, &["add", "file.txt"]).unwrap();
        checked_output(&root, &["commit", "-m", "initial"]).unwrap();
        fs::write(root.join("file.txt"), "line1\nline2\n").unwrap();

        let diff = git_diff(root_string.clone(), "file.txt".to_string(), false).unwrap();
        assert!(diff.contains("+line2"), "diff must contain the added line");

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn git_diff_returns_staged_changes() {
        let root = temp_dir("diff-staged");
        let root_string = root.to_string_lossy().into_owned();
        checked_output(&root, &["init"]).unwrap();
        checked_output(&root, &["config", "user.name", "Alethe Test"]).unwrap();
        checked_output(&root, &["config", "user.email", "alethe@example.invalid"]).unwrap();
        fs::write(root.join("file.txt"), "line1\n").unwrap();
        checked_output(&root, &["add", "file.txt"]).unwrap();
        checked_output(&root, &["commit", "-m", "initial"]).unwrap();
        fs::write(root.join("file.txt"), "line1\nline2\n").unwrap();
        checked_output(&root, &["add", "file.txt"]).unwrap();

        let diff = git_diff(root_string.clone(), "file.txt".to_string(), true).unwrap();
        assert!(diff.contains("+line2"), "staged diff must contain the added line");

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn git_diff_rejects_binary_file() {
        let root = temp_dir("diff-binary");
        let root_string = root.to_string_lossy().into_owned();
        checked_output(&root, &["init"]).unwrap();
        checked_output(&root, &["config", "user.name", "Alethe Test"]).unwrap();
        checked_output(&root, &["config", "user.email", "alethe@example.invalid"]).unwrap();
        fs::write(root.join("bin.dat"), &0u8.to_le_bytes()).unwrap();
        checked_output(&root, &["add", "bin.dat"]).unwrap();
        checked_output(&root, &["commit", "-m", "initial"]).unwrap();
        // Modify binary content
        fs::write(root.join("bin.dat"), &[0u8, 1, 2, 3]).unwrap();
        checked_output(&root, &["add", "bin.dat"]).unwrap();

        let result = git_diff(root_string.clone(), "bin.dat".to_string(), true);
        assert!(result.is_err(), "binary file should return an error");
        assert!(
            result.unwrap_err().contains("Binary file"),
            "error must mention binary file"
        );

        fs::remove_dir_all(root).unwrap();
    }
}
