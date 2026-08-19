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

/// janelas de console abrindo e fechando sozinhas. No-op fora do Windows.
#[cfg(windows)]
pub(crate) fn hide_console(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
pub(crate) fn hide_console(_command: &mut Command) {}

const INDEX_LOCK_RETRY_DELAYS_MS: [u64; 3] = [200, 400, 800];

fn git_admin_dir(dir: &Path) -> Option<PathBuf> {
    let dot_git = dir.join(".git");
    if dot_git.is_dir() {
        return Some(dot_git);
    }
    if dot_git.is_file() {
        let content = std::fs::read_to_string(&dot_git).ok()?;
        let gitdir = content
            .lines()
            .find_map(|line| line.trim().strip_prefix("gitdir:"))?;
        return Some(PathBuf::from(gitdir.trim()));
    }
    None
}

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

pub(crate) fn admin_locked_error(reason: &str) -> String {
    format!("admin_locked:{reason}")
}

///

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
    } else if let Some(rest) = trimmed
        .strip_prefix("~/")
        .or_else(|| trimmed.strip_prefix("~\\"))
    {
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
    let looks_unix_root =
        trimmed.starts_with('/') && !trimmed.starts_with("//") && !trimmed.starts_with("/mnt/");
    if looks_unix_root {
        let relative = trimmed.trim_start_matches('/').replace('/', "\\");
        let username = dirs_next::home_dir().and_then(|home| {
            home.file_name()
                .map(|name| name.to_string_lossy().into_owned())
        });
        for drive in drive_roots() {
            push_if_dir(&mut candidates, drive.join(&relative));
            if let Some(name) = username.as_deref() {
                push_if_dir(&mut candidates, drive.join(name).join(&relative));
                push_if_dir(
                    &mut candidates,
                    drive.join("Users").join(name).join(&relative),
                );
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

pub(crate) fn main_repository_root(path: &str) -> Result<PathBuf, String> {
    let cwd = resolve_input_directory(path)?;
    let output = git_command(
        &cwd,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
    )?;
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
    let requested =
        resolve_input_directory(path).map_err(|_| "not_a_git_repository".to_string())?;
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

fn seed_gitignore_if_missing(dir: &Path) {
    let path = dir.join(".gitignore");
    if path.exists() {
        return;
    }
    let _ = std::fs::write(&path, GITIGNORE_SEED);
}

/// worktree add`/`git clone --local` (isolamento por agente) exigem um HEAD

fn git_init_inner(path: String) -> Result<String, String> {
    if let Ok(root) = repository_root(&path) {
        return Ok(root.to_string_lossy().into_owned());
    }
    let dir = resolve_input_directory(&path)?;
    checked_output(&dir, &["init", "-b", "main"])?;
    seed_gitignore_if_missing(&dir);
    checked_output(&dir, &["add", "-A"])?;
    let identity = [
        "-c",
        "user.name=Alethe",
        "-c",
        "user.email=alethe@localhost",
    ];
    let mut commit_args: Vec<&str> = identity.to_vec();
    commit_args.extend(["commit", "-m", "Commit inicial (Alethe)"]);

    if checked_output(&dir, &commit_args).is_err() {
        let mut empty_args: Vec<&str> = identity.to_vec();
        empty_args.extend(["commit", "--allow-empty", "-m", "Commit inicial (Alethe)"]);
        checked_output(&dir, &empty_args)?;
    }
    repository_root(&path).map(|root| root.to_string_lossy().into_owned())
}

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
pub async fn git_discard(
    repo_root: String,
    paths: Vec<String>,
    untracked: bool,
) -> Result<(), String> {
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
            Ok(format!("{} {}", stdout.trim(), stderr.trim())
                .trim()
                .to_string())
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            Err(format!("git_command_failed:{stderr}"))
        }
    })
}

fn git_push_inner(repo_root: String) -> Result<String, String> {
    let root = validated_root(&repo_root)?;
    match remote_command(&root, &["push"]) {
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

/// `opencode.json` (MCP do Graphify + plugin GSD, escritos automaticamente a

/// `.opencode/alethe-gsd-config.json`, `.planning/goal.md` etc. como se

/// Alethe escrevendo essa infraestrutura na worktree.
fn is_alethe_infra_path(path: &str) -> bool {
    path.starts_with(".planning/") || path.starts_with(".opencode/") || path == "opencode.json"
}

/// --porcelain`, working-tree aware — cobre staged/unstaged/untracked).

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
            i += 1;
        }

        // "working tree" (y); untracked ("??") vira "A" (adicionado).
        let status = if x == '?' && y == '?' {
            'A'
        } else if y != ' ' {
            y
        } else {
            x
        };
        entries.push(DiffSummaryEntry {
            path,
            status: status.to_string(),
        });
    }
    entries
}

/// com dado de verdade em vez de texto fixo. Three-dot (`target...source`,

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

/// Reconhece `alethe/agent-<id>` e `alethe/merge-<id>` (com ou sem prefixo de
/// decoração como `HEAD -> `/`tag: `/`origin/`) — as branches efêmeras que o
/// próprio Alethe cria e apaga nos fluxos de worktree/merge, nunca branches
/// de verdade do ponto de vista do usuário.
fn is_ephemeral_ref(raw: &str) -> bool {
    let name = raw
        .strip_prefix("HEAD -> ")
        .or_else(|| raw.strip_prefix("tag: "))
        .unwrap_or(raw);
    let name = name.strip_prefix("origin/").unwrap_or(name);
    name.starts_with("alethe/agent-") || name.starts_with("alethe/merge-")
}

fn git_log_graph_inner(repo: String, max_count: u32) -> Result<Vec<GitCommitEntry>, String> {
    let root = repository_root(&repo)?;
    let format_arg = format!(
        "--format=%H{sep}%P{sep}%an{sep}%ae{sep}%at{sep}%s{sep}%D",
        sep = LOG_GRAPH_FIELD_SEP
    );
    // `--branches --tags` (não `--all`): mostra as branches/tags reais do
    // usuário no gráfico — sem isso, o log cai pra só o histórico de HEAD e
    // qualquer outra branch simplesmente some da interface. Os `--exclude`
    // tiram só as branches EFÊMERAS que o próprio Alethe cria e descarta
    // pros fluxos de worktree/merge (`alethe/agent-<id>`, `alethe/merge-<id>`
    // — ver worktrees.rs/conflict_resolution.rs), que não são branches de
    // verdade do ponto de vista do usuário e só poluíam o grafo com raias
    // isoladas sem nenhuma linha conectando.
    //
    // `--topo-order`: SEM isso, `git log` ordena por DATA de commit, não
    // topologicamente — um commit pode aparecer na lista antes do próprio
    // pai sempre que houver qualquer discrepância de timestamp entre eles
    // (comum aqui: agentes de IA rodando em horários diferentes, rebase,
    // relógio de máquina divergente). O algoritmo de raias do frontend
    // (`buildGraphRows`, GitGraphList.tsx) assume que um commit SEMPRE
    // aparece antes de qualquer um dos seus pais na lista — quando isso
    // quebra, a raia daquele branch não encontra o pai ainda "pendente" e a
    // linha simplesmente para, parecendo um coto isolado que "volta pra
    // main" sem nunca ter se conectado de verdade. `--topo-order` garante
    // essa invariante (filhos sempre antes dos pais), do mesmo jeito que
    // GitLens/gitk fazem.
    let mut args = vec![
        "log",
        "--topo-order",
        "--exclude=refs/heads/alethe/agent-*",
        "--exclude=refs/heads/alethe/merge-*",
        "--branches",
        "--tags",
        &format_arg,
    ];
    let max_count_str;
    if max_count > 0 {
        max_count_str = format!("--max-count={max_count}");
        args.push(&max_count_str);
    }
    let output = checked_output(&root, &args)?;
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
            // `--exclude` só afeta quais commits o `log` PERCORRE, não a
            // decoração (`%D`) de um commit que ainda é alcançável por outra
            // ref incluída — se uma branch efêmera do Alethe aponta pro
            // MESMO commit que já está em `main` (comum depois de um merge
            // --ff-only, onde nenhum commit novo é criado), o nome dela
            // continua aparecendo como badge mesmo excluída da travessia.
            // Filtra de novo aqui, na decoração em si.
            let refs = if refs_raw.is_empty() {
                Vec::new()
            } else {
                refs_raw
                    .split(", ")
                    .map(|s| s.trim().to_string())
                    .filter(|r| !is_ephemeral_ref(r))
                    .collect()
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

// --- Ações por commit do gráfico (menu de contexto) ---

/// Só aceita hash hexadecimal — recusa qualquer coisa que pareça uma flag
/// (`-...`) ou ref arbitrária, já que este valor sempre deveria vir de um
/// `hash` que NÓS geramos via `git log` (git_log_graph), nunca digitado
/// livremente pelo usuário. Defesa em profundidade contra injeção de
/// argumento nos comandos abaixo (alguns são destrutivos: reset --hard).
fn validate_commit_hash(hash: &str) -> Result<(), String> {
    if hash.is_empty() || hash.len() > 40 || !hash.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("invalid_commit_hash".to_string());
    }
    Ok(())
}

/// Recusa nome de branch vazio, que pareça uma flag, ou com espaço/controle
/// — mesma defesa em profundidade do hash acima.
fn validate_branch_name(name: &str) -> Result<(), String> {
    if name.is_empty()
        || name.starts_with('-')
        || name.chars().any(|c| c.is_whitespace() || c.is_control())
    {
        return Err("invalid_branch_name".to_string());
    }
    Ok(())
}

/// Parseia a saída de `--name-status -z` (git diff/diff-tree) em
/// `GitFileChange` — mesmo formato usado por `git_status`/`git_diff_summary`,
/// extraído aqui pra ser reaproveitado pelas 3 funções novas abaixo
/// (arquivos de um commit, incoming, outgoing) sem duplicar o parsing.
fn parse_name_status_z(raw: &[u8]) -> Vec<GitFileChange> {
    let text = String::from_utf8_lossy(raw);
    let fields: Vec<&str> = text.split('\0').filter(|s| !s.is_empty()).collect();
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
        let mut original_path = None;
        if status.starts_with('R') || status.starts_with('C') {
            if i >= fields.len() {
                break;
            }
            original_path = Some(path.clone());
            path = fields[i].to_string();
            i += 1;
        }
        entries.push(GitFileChange {
            path,
            original_path,
            status,
        });
    }
    entries
}

fn git_show_commit_files_inner(
    repo_root: String,
    hash: String,
) -> Result<Vec<GitFileChange>, String> {
    let root = repository_root(&repo_root)?;
    validate_commit_hash(&hash)?;
    // `--root` cobre o commit raiz (sem pai), que `diff-tree` sozinho ignora.
    let output = checked_output(
        &root,
        &[
            "diff-tree",
            "--no-commit-id",
            "--name-status",
            "-r",
            "--root",
            "-z",
            &hash,
        ],
    )?;
    Ok(parse_name_status_z(&output.stdout))
}

#[tauri::command]
pub async fn git_show_commit_files(
    repo: String,
    hash: String,
) -> Result<Vec<GitFileChange>, String> {
    tokio::task::spawn_blocking(move || git_show_commit_files_inner(repo, hash))
        .await
        .map_err(|error| format!("git_show_commit_files: falha na task bloqueante: {error}"))?
}

/// Mensagem COMPLETA do commit (`%B` — subject + corpo), pra tela de detalhe
/// do gráfico de commits (`git_log_graph` só devolve `%s`, uma linha só).
fn git_show_commit_message_inner(repo_root: String, hash: String) -> Result<String, String> {
    let root = repository_root(&repo_root)?;
    validate_commit_hash(&hash)?;
    let output = checked_output(&root, &["show", "-s", "--format=%B", &hash])?;
    Ok(String::from_utf8_lossy(&output.stdout)
        .trim_end()
        .to_string())
}

#[tauri::command]
pub async fn git_show_commit_message(repo: String, hash: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || git_show_commit_message_inner(repo, hash))
        .await
        .map_err(|error| format!("git_show_commit_message: falha na task bloqueante: {error}"))?
}

fn git_create_branch_from_commit_inner(
    repo_root: String,
    hash: String,
    branch_name: String,
) -> Result<(), String> {
    let root = validated_root(&repo_root)?;
    validate_commit_hash(&hash)?;
    validate_branch_name(&branch_name)?;
    checked_output(&root, &["branch", &branch_name, &hash])?;
    Ok(())
}

#[tauri::command]
pub async fn git_create_branch_from_commit(
    repo: String,
    hash: String,
    branch_name: String,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        git_create_branch_from_commit_inner(repo, hash, branch_name)
    })
    .await
    .map_err(|error| format!("git_create_branch_from_commit: falha na task bloqueante: {error}"))?
}

fn git_cherry_pick_commit_inner(repo_root: String, hash: String) -> Result<String, String> {
    let root = validated_root(&repo_root)?;
    validate_commit_hash(&hash)?;
    let output = checked_output(&root, &["cherry-pick", &hash])?;
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[tauri::command]
pub async fn git_cherry_pick_commit(repo: String, hash: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || git_cherry_pick_commit_inner(repo, hash))
        .await
        .map_err(|error| format!("git_cherry_pick_commit: falha na task bloqueante: {error}"))?
}

fn git_revert_commit_inner(repo_root: String, hash: String) -> Result<String, String> {
    let root = validated_root(&repo_root)?;
    validate_commit_hash(&hash)?;
    let output = checked_output(&root, &["revert", "--no-edit", &hash])?;
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[tauri::command]
pub async fn git_revert_commit(repo: String, hash: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || git_revert_commit_inner(repo, hash))
        .await
        .map_err(|error| format!("git_revert_commit: falha na task bloqueante: {error}"))?
}

fn git_reset_to_commit_inner(repo_root: String, hash: String, mode: String) -> Result<(), String> {
    let root = validated_root(&repo_root)?;
    validate_commit_hash(&hash)?;
    let flag = match mode.as_str() {
        "soft" => "--soft",
        "mixed" => "--mixed",
        "hard" => "--hard",
        _ => return Err("invalid_reset_mode".to_string()),
    };
    checked_output(&root, &["reset", flag, &hash])?;
    Ok(())
}

/// `mode`: "soft" (mantém staged), "mixed" (mantém no working tree, unstage)
/// ou "hard" (descarta tudo — destrutivo, a UI confirma antes de chamar).
#[tauri::command]
pub async fn git_reset_to_commit(repo: String, hash: String, mode: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || git_reset_to_commit_inner(repo, hash, mode))
        .await
        .map_err(|error| format!("git_reset_to_commit: falha na task bloqueante: {error}"))?
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IncomingOutgoing {
    /// Arquivos que mudam no working tree ao trazer `@{upstream}` (pull).
    pub incoming: Vec<GitFileChange>,
    /// Arquivos que mudam no remoto ao mandar HEAD pra lá (push).
    pub outgoing: Vec<GitFileChange>,
    /// `false` quando o branch atual não tem upstream configurado — nesse
    /// caso `incoming`/`outgoing` vêm vazios (não é erro, é normal pra um
    /// branch local que nunca foi publicado).
    pub has_upstream: bool,
}

fn git_incoming_outgoing_inner(repo_root: String) -> Result<IncomingOutgoing, String> {
    let root = repository_root(&repo_root)?;
    let has_upstream = git_command(
        &root,
        &[
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            "@{upstream}",
        ],
    )
    .map(|output| output.status.success())
    .unwrap_or(false);
    if !has_upstream {
        return Ok(IncomingOutgoing {
            incoming: Vec::new(),
            outgoing: Vec::new(),
            has_upstream: false,
        });
    }
    let incoming_output = checked_output(
        &root,
        &["diff", "--name-status", "-z", "HEAD", "@{upstream}"],
    )?;
    let outgoing_output = checked_output(
        &root,
        &["diff", "--name-status", "-z", "@{upstream}", "HEAD"],
    )?;
    Ok(IncomingOutgoing {
        incoming: parse_name_status_z(&incoming_output.stdout),
        outgoing: parse_name_status_z(&outgoing_output.stdout),
        has_upstream: true,
    })
}

#[tauri::command]
pub async fn git_incoming_outgoing(repo: String) -> Result<IncomingOutgoing, String> {
    tokio::task::spawn_blocking(move || git_incoming_outgoing_inner(repo))
        .await
        .map_err(|error| format!("git_incoming_outgoing: falha na task bloqueante: {error}"))?
}

fn git_pull_inner(repo_root: String) -> Result<String, String> {
    let root = validated_root(&repo_root)?;

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
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
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
            &[
                "worktree",
                "add",
                "-b",
                "agent-branch",
                worktree.to_str().unwrap(),
                "HEAD",
            ],
        )
        .unwrap();

        let from_main = main_repository_root(&root.to_string_lossy()).unwrap();
        let from_worktree = main_repository_root(&worktree.to_string_lossy()).unwrap();
        assert_eq!(
            from_main, from_worktree,
            "deve resolver a mesma raiz principal a partir de qualquer worktree"
        );
        // `repository_root` (--show-toplevel), em contraste, devolveria a

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

        let status = git_status(root_string).unwrap();
        assert!(
            status.staged.is_empty() && status.changes.is_empty() && status.untracked.is_empty()
        );
        let log = checked_output(&root, &["log", "--oneline"]).unwrap();
        assert_eq!(String::from_utf8_lossy(&log.stdout).lines().count(), 1);

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn git_init_excludes_heavy_dirs_from_the_first_commit() {
        let root = temp_dir("init-gitignore");
        fs::write(root.join("src.txt"), "real code\n").unwrap();
        fs::create_dir_all(root.join("node_modules").join("some-dep")).unwrap();
        fs::write(
            root.join("node_modules").join("some-dep").join("index.js"),
            "// dep\n",
        )
        .unwrap();
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
        assert!(
            find("new-name.txt").is_some(),
            "rename deveria aparecer com o nome novo: {entries:?}"
        );
        assert!(
            find("old-name.txt").is_none(),
            "rename não deveria duplicar o nome antigo: {entries:?}"
        );

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn git_diff_summary_includes_uncommitted_worktree_changes() {
        let root = temp_dir("diff-summary-uncommitted");
        checked_output(&root, &["init", "-b", "main"]).unwrap();
        checked_output(&root, &["config", "user.name", "Alethe Test"]).unwrap();
        checked_output(&root, &["config", "user.email", "alethe@example.invalid"]).unwrap();
        fs::write(root.join("base.txt"), "base\n").unwrap();
        checked_output(&root, &["add", "-A"]).unwrap();
        checked_output(&root, &["commit", "-m", "base"]).unwrap();
        checked_output(&root, &["checkout", "-b", "feature"]).unwrap();

        let root_string = root.to_string_lossy().into_owned();
        let without_worktree = git_diff_summary(
            root_string.clone(),
            "feature".to_string(),
            "main".to_string(),
            None,
        )
        .unwrap();
        assert!(
            without_worktree.is_empty(),
            "sem worktree_path, diff de commits deve ficar vazio"
        );

        fs::write(root.join("novo.txt"), "").unwrap();

        fs::create_dir_all(root.join(".planning")).unwrap();
        fs::write(root.join(".planning").join("goal.md"), "").unwrap();
        fs::create_dir_all(root.join(".opencode").join("plugins")).unwrap();
        fs::write(
            root.join(".opencode")
                .join("plugins")
                .join("alethe-gsd-state.ts"),
            "",
        )
        .unwrap();
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
        let root = temp_dir("adminlock");
        checked_output(&root, &["init"]).unwrap();
        fs::write(root.join(".git").join("locked"), "Aguardando homologacao\n").unwrap();

        let start = std::time::Instant::now();
        let error = checked_output(&root, &["status"]).unwrap_err();

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

        let lock_file_clone = lock_file.clone();
        std::thread::spawn(move || {
            sleep(Duration::from_millis(250));
            let _ = fs::remove_file(&lock_file_clone);
        });

        let result = checked_output(&root, &["status"]);
        assert!(
            result.is_ok(),
            "esperava sucesso após o lock transitório sumir: {result:?}"
        );

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
        assert!(
            diff.contains("+line2"),
            "staged diff must contain the added line"
        );

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
