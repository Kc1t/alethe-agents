use serde_json::Value;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use tauri::AppHandle;
use tokio::sync::Mutex as AsyncMutex;

use crate::paths::projects_file_path;
use crate::provider_common::now_ms;

static SAVE_MUTEX: OnceLock<AsyncMutex<()>> = OnceLock::new();

static LAST_WRITE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

const STALE_WRITE_THRESHOLD_MS: i64 = 2000;

/// How many earlier versions of the workspace are kept beside it.
const BACKUP_GENERATIONS: usize = 3;

/// The workspaces already backed up in this run, so each is copied once and not on every save.
static BACKED_UP: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();

fn backup_path(path: &Path, generation: usize) -> PathBuf {
    path.with_extension(format!("backup-{generation}.json"))
}

/// Whether a saved workspace holds anything a person would miss: at least one project.
fn worth_keeping(content: &str) -> bool {
    serde_json::from_str::<Value>(content)
        .ok()
        .and_then(|value| {
            value
                .get("projects")
                .and_then(Value::as_array)
                .map(|projects| !projects.is_empty())
        })
        .unwrap_or(false)
}

/// Whether the person behind a saved workspace has finished setting Alethe up.
fn set_up(content: &str) -> bool {
    serde_json::from_str::<Value>(content)
        .ok()
        .and_then(|value| value.get("preferences")?.get("onboardingDone")?.as_bool())
        .unwrap_or(false)
}

/// Keeps the workspace on disk as a backup before it is replaced. It happens on the first save of
/// a run, and again whenever a save would lose something only the person can put back: a workspace
/// with projects replaced by one with none, or a finished setup replaced by one that is not -
/// which is what a failed load followed by a save looks like. A workspace with nothing in it is
/// never backed up, so it cannot push the copies worth having out of the rotation.
fn keep_backup(path: &Path, incoming: &str, first_save: bool) {
    let Ok(existing) = fs::read_to_string(path) else {
        return;
    };
    if !worth_keeping(&existing) {
        return;
    }
    let emptying = !worth_keeping(incoming);
    let resetting = set_up(&existing) && !set_up(incoming);
    if !first_save && !emptying && !resetting {
        return;
    }
    // The newest backup already is this workspace: rotating would only lose an older one.
    if fs::read_to_string(backup_path(path, 1)).is_ok_and(|backup| backup == existing) {
        return;
    }
    for generation in (1..BACKUP_GENERATIONS).rev() {
        let _ = fs::rename(
            backup_path(path, generation),
            backup_path(path, generation + 1),
        );
    }
    let _ = fs::copy(path, backup_path(path, 1));
}

fn save_mutex() -> &'static AsyncMutex<()> {
    SAVE_MUTEX.get_or_init(|| AsyncMutex::new(()))
}

fn external_todo_path(content: &str) -> Option<PathBuf> {
    let parsed: Value = serde_json::from_str(content).ok()?;
    let directory = parsed
        .get("preferences")?
        .get("todoStoragePath")?
        .as_str()?
        .trim();
    if directory.is_empty() {
        return None;
    }
    Some(PathBuf::from(directory).join("todos.jsonc"))
}

fn merge_external_todos(content: String) -> String {
    let Some(path) = external_todo_path(&content) else {
        return content;
    };
    let Ok(external) = fs::read_to_string(path) else {
        return content;
    };
    let Ok(external_json) = serde_json::from_str::<Value>(&external) else {
        return content;
    };
    let Some(todos) = external_json.get("todos").filter(|value| value.is_array()) else {
        return content;
    };
    let Ok(mut parsed) = serde_json::from_str::<Value>(&content) else {
        return content;
    };
    parsed["todos"] = todos.clone();
    serde_json::to_string(&parsed).unwrap_or(content)
}

fn save_external_todos(content: &str) -> Result<(), String> {
    let Some(path) = external_todo_path(content) else {
        return Ok(());
    };
    let Some(parent) = path.parent() else {
        return Ok(());
    };
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let parsed: Value = serde_json::from_str(content).map_err(|error| error.to_string())?;
    let external = serde_json::json!({
        "version": 1,
        "todos": parsed.get("todos").cloned().unwrap_or_else(|| Value::Array(Vec::new())),
    });
    let temporary = path.with_extension("jsonc.tmp");
    fs::write(
        &temporary,
        serde_json::to_string_pretty(&external).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    fs::rename(&temporary, &path).map_err(|error| error.to_string())
}

/// One earlier version of the workspace, as the person needs it described to pick one.
#[derive(serde::Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceBackup {
    generation: usize,
    modified_ms: u64,
    projects: usize,
    terminals: usize,
}

fn describe_backup(path: &Path, generation: usize) -> Option<WorkspaceBackup> {
    let file = backup_path(path, generation);
    let value: Value = serde_json::from_str(&fs::read_to_string(&file).ok()?).ok()?;
    let projects = value.get("projects")?.as_array()?;
    if projects.is_empty() {
        return None;
    }
    let terminals = projects
        .iter()
        .map(|project| {
            project
                .get("terminals")
                .and_then(Value::as_array)
                .map_or(0, Vec::len)
        })
        .sum();
    let modified_ms = fs::metadata(&file)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |since| since.as_millis() as u64);
    Some(WorkspaceBackup {
        generation,
        modified_ms,
        projects: projects.len(),
        terminals,
    })
}

fn list_backups(path: &Path) -> Vec<WorkspaceBackup> {
    (1..=BACKUP_GENERATIONS)
        .filter_map(|generation| describe_backup(path, generation))
        .collect()
}

/// Puts an earlier version back as the workspace. The one it replaces is kept as a backup first,
/// so restoring can itself be undone.
fn restore_backup(path: &Path, generation: usize) -> Result<(), String> {
    if !(1..=BACKUP_GENERATIONS).contains(&generation) {
        return Err(format!("there is no backup {generation}"));
    }
    let content = fs::read_to_string(backup_path(path, generation))
        .map_err(|error| format!("backup {generation} could not be read: {error}"))?;
    if !worth_keeping(&content) {
        return Err(format!("backup {generation} holds no projects"));
    }
    // Read before the rotation below moves it to another generation.
    keep_backup(path, &content, true);
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, &content).map_err(|error| error.to_string())?;
    fs::rename(&tmp, path).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn list_workspace_backups(app: AppHandle) -> Result<Vec<WorkspaceBackup>, String> {
    Ok(list_backups(&projects_file_path(&app)?))
}

#[tauri::command]
pub async fn restore_workspace_backup(app: AppHandle, generation: usize) -> Result<(), String> {
    let _guard = save_mutex().lock().await;
    let path = projects_file_path(&app)?;
    tokio::task::spawn_blocking(move || restore_backup(&path, generation))
        .await
        .map_err(|error| format!("restore_workspace_backup: {error}"))?
}

#[tauri::command]
pub fn load_projects(app: AppHandle) -> Result<Option<String>, String> {
    let path = projects_file_path(&app)?;
    if !path.exists() {
        return Ok(None);
    }
    fs::read_to_string(&path)
        .map(|content| Some(merge_external_todos(content)))
        .map_err(|error| error.to_string())
}

///

#[tauri::command]
pub async fn save_projects(app: AppHandle, content: String, sequence: u64) -> Result<(), String> {
    let _guard = save_mutex().lock().await;

    let rust_now = now_ms();
    let last = LAST_WRITE_SEQUENCE.load(Ordering::SeqCst);

    if sequence <= last {
        let delay_ms = rust_now as i64 - sequence as i64;
        if delay_ms > STALE_WRITE_THRESHOLD_MS {
            return Ok(());
        }

        eprintln!(
            "[projects] aviso: sequence {sequence} <= last {last}, mas dentro do limiar \
             de {STALE_WRITE_THRESHOLD_MS}ms (possível recuo de relógio) — gravando mesmo assim."
        );
    }

    let path = projects_file_path(&app)?;
    // I/O em spawn_blocking: escrever/renomear em disco lento (rede, AV scan)

    tokio::task::spawn_blocking(move || -> Result<(), String> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let first_save = BACKED_UP
            .get_or_init(|| Mutex::new(HashSet::new()))
            .lock()
            .map(|mut seen| seen.insert(path.clone()))
            .unwrap_or(false);
        keep_backup(&path, &content, first_save);
        let tmp = path.with_extension("json.tmp");
        fs::write(&tmp, &content).map_err(|error| error.to_string())?;
        fs::rename(&tmp, &path).map_err(|error| error.to_string())?;
        save_external_todos(&content)?;
        Ok(())
    })
    .await
    .map_err(|error| format!("save_projects: falha na task bloqueante: {error}"))??;

    LAST_WRITE_SEQUENCE.store(sequence, Ordering::SeqCst);
    Ok(())
}

fn repo_folder_name(normalized_url: &str) -> String {
    let name = normalized_url
        .trim_end_matches('/')
        .rsplit(['/', ':'])
        .next()
        .unwrap_or("repo")
        .trim_end_matches(".git");
    let sanitized: String = name
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' || c == '.' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if sanitized.is_empty() {
        "repo".to_string()
    } else {
        sanitized
    }
}

fn resolve_clone_target(requested: &str, normalized_url: &str) -> Result<String, String> {
    let folder = repo_folder_name(normalized_url);
    let trimmed = requested.trim();
    let base = if trimmed.is_empty() {
        dirs_next::home_dir()
            .ok_or_else(|| "Não foi possível localizar a pasta do usuário".to_string())?
            .join("Alethe")
    } else {
        std::path::PathBuf::from(trimmed)
    };
    let target = if base.file_name().and_then(|n| n.to_str()) == Some(folder.as_str()) {
        base
    } else {
        base.join(&folder)
    };
    Ok(target.to_string_lossy().to_string())
}

fn normalize_github_url(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.starts_with("http://")
        || trimmed.starts_with("https://")
        || trimmed.starts_with("git@")
    {
        trimmed.to_string()
    } else if trimmed.starts_with("github.com/") {
        format!("https://{trimmed}")
    } else if trimmed.contains('/') && !trimmed.contains(' ') {
        format!("https://github.com/{trimmed}")
    } else {
        trimmed.to_string()
    }
}

#[tauri::command]
pub async fn clone_github_repo(url: String, target_dir: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let normalized = normalize_github_url(&url);
        let target_dir = resolve_clone_target(&target_dir, &normalized)?;
        let target_path = std::path::PathBuf::from(&target_dir);

        if let Some(parent) = target_path.parent() {
            let _ = fs::create_dir_all(parent);
        }

        // Executa `git clone`
        let mut cmd = std::process::Command::new("git");
        cmd.args(["clone", "--depth", "1", &normalized, &target_dir]);
        crate::git_control::hide_console(&mut cmd);

        let output = cmd
            .output()
            .map_err(|e| format!("Falha ao executar git clone: {e}"))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!(
                "Erro ao clonar repositório ({normalized}): {stderr}"
            ));
        }

        // Gera os arquivos de briefing de contexto para os agentes de IA
        let _ = generate_repo_context_files(&target_dir);

        let _ = crate::graphify::graphify_opencode_config_write_inner(target_dir.clone(), None);

        Ok(target_dir)
    })
    .await
    .map_err(|e| format!("Erro de concorrência na task de clone: {e}"))?
}

fn generate_repo_context_files(project_dir: &str) -> Result<(), String> {
    let path = std::path::PathBuf::from(project_dir);
    if !path.exists() {
        return Ok(());
    }

    let readme_content = ["README.md", "README.txt", "readme.md", "README"]
        .iter()
        .find_map(|f| fs::read_to_string(path.join(f)).ok())
        .unwrap_or_else(|| "Nenhum README encontrado.".to_string());

    let mut tech_stack = Vec::new();
    if path.join("package.json").exists() {
        tech_stack.push("Node.js / JavaScript / TypeScript");
    }
    if path.join("Cargo.toml").exists() {
        tech_stack.push("Rust");
    }
    if path.join("pyproject.toml").exists() || path.join("requirements.txt").exists() {
        tech_stack.push("Python");
    }
    if path.join("go.mod").exists() {
        tech_stack.push("Go");
    }

    let stack_str = if tech_stack.is_empty() {
        "Não especificada".to_string()
    } else {
        tech_stack.join(", ")
    };

    // Truncar README para os primeiros 1500 caracteres
    let truncated_readme = if readme_content.len() > 1500 {
        // Cut on a character boundary: slicing through an accented letter or an emoji panics.
        let mut end = 1500;
        while !readme_content.is_char_boundary(end) {
            end -= 1;
        }
        format!("{}...", &readme_content[..end])
    } else {
        readme_content
    };

    let context_markdown = format!(
        "# Contexto Inicial do Projeto (Alethe AI Briefing)\n\n\
        > Este repositório foi clonado via Alethe. O briefing abaixo descreve a aplicação para orientar sua assistência.\n\n\
        ## Tecnologias Detectadas\n- {stack_str}\n\n\
        ## Resumo do Repositório (README)\n```markdown\n{truncated_readme}\n```\n\n\
        ## Instrução Importante para o Agente\n\
        Ao iniciar a conversa com o usuário neste repositório, faça um resumo executivo direto de 2 a 3 frases explicando o propósito deste projeto.\n"
    );

    let _ = fs::write(path.join("AGENTS.md"), &context_markdown);
    let _ = fs::write(path.join("CLAUDE.md"), &context_markdown);

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn workspace(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "alethe-projects-{name}-{}-{}",
            std::process::id(),
            now_ms()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir.join("projects.json")
    }

    fn document(projects: usize) -> String {
        let projects: Vec<Value> = (0..projects)
            .map(|index| serde_json::json!({ "id": format!("p{index}") }))
            .collect();
        serde_json::json!({ "version": 9, "projects": projects }).to_string()
    }

    fn backup(path: &Path, generation: usize) -> Option<String> {
        fs::read_to_string(backup_path(path, generation)).ok()
    }

    #[test]
    fn the_first_save_of_a_run_keeps_the_workspace_it_replaces() {
        let path = workspace("first-save");
        fs::write(&path, document(2)).unwrap();

        keep_backup(&path, &document(3), true);

        assert_eq!(backup(&path, 1), Some(document(2)));
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn later_saves_of_the_same_run_do_not_rotate_the_backups() {
        let path = workspace("later-save");
        fs::write(&path, document(2)).unwrap();
        keep_backup(&path, &document(3), true);
        fs::write(&path, document(3)).unwrap();

        keep_backup(&path, &document(4), false);

        assert_eq!(backup(&path, 1), Some(document(2)));
        assert_eq!(backup(&path, 2), None);
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn a_save_that_would_empty_the_workspace_backs_it_up_first() {
        let path = workspace("emptying");
        fs::write(&path, document(2)).unwrap();
        keep_backup(&path, &document(3), true);
        fs::write(&path, document(3)).unwrap();

        // What a failed load followed by a save sends: a workspace with no projects.
        keep_backup(&path, &document(0), false);

        assert_eq!(backup(&path, 1), Some(document(3)));
        assert_eq!(backup(&path, 2), Some(document(2)));
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn a_save_that_would_undo_the_setup_backs_the_workspace_up_first() {
        let path = workspace("resetting");
        let with_setup = |done: bool| {
            serde_json::json!({
                "projects": [{ "id": "p1" }],
                "preferences": { "onboardingDone": done, "displayName": "someone" }
            })
            .to_string()
        };
        fs::write(&path, with_setup(true)).unwrap();

        // Not the first save of the run, and the projects are all still there.
        keep_backup(&path, &with_setup(false), false);

        assert_eq!(backup(&path, 1), Some(with_setup(true)));
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn an_empty_workspace_never_pushes_a_real_one_out_of_the_backups() {
        let path = workspace("empty-stays-out");
        fs::write(&path, document(3)).unwrap();
        keep_backup(&path, &document(0), true);
        fs::write(&path, document(0)).unwrap();

        // Every later run starts from the emptied file; none of them may touch the backups.
        for _ in 0..5 {
            keep_backup(&path, &document(0), true);
        }

        assert_eq!(backup(&path, 1), Some(document(3)));
        assert_eq!(backup(&path, 2), None);
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn only_the_three_most_recent_backups_are_kept() {
        let path = workspace("rotation");
        for projects in 1..=5 {
            fs::write(&path, document(projects)).unwrap();
            keep_backup(&path, &document(projects + 1), true);
        }

        assert_eq!(backup(&path, 1), Some(document(5)));
        assert_eq!(backup(&path, 2), Some(document(4)));
        assert_eq!(backup(&path, 3), Some(document(3)));
        assert_eq!(backup(&path, 4), None);
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn backups_are_listed_with_what_they_hold_and_empty_ones_are_left_out() {
        let path = workspace("list");
        let with_terminals = serde_json::json!({
            "projects": [{ "id": "p1", "terminals": [{}, {}] }, { "id": "p2", "terminals": [{}] }]
        });
        fs::write(backup_path(&path, 1), with_terminals.to_string()).unwrap();
        fs::write(backup_path(&path, 2), document(0)).unwrap();
        fs::write(backup_path(&path, 3), "not json").unwrap();

        let listed = list_backups(&path);

        assert_eq!(listed.len(), 1);
        assert_eq!(
            (
                listed[0].generation,
                listed[0].projects,
                listed[0].terminals
            ),
            (1, 2, 3)
        );
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn restoring_a_backup_keeps_the_workspace_it_replaces() {
        let path = workspace("restore");
        fs::write(&path, document(1)).unwrap();
        fs::write(backup_path(&path, 1), document(4)).unwrap();
        fs::write(backup_path(&path, 2), document(3)).unwrap();

        restore_backup(&path, 2).unwrap();

        assert_eq!(fs::read_to_string(&path).unwrap(), document(3));
        // What was there before the restore is the newest backup now, so it can be taken back.
        assert_eq!(backup(&path, 1), Some(document(1)));
        assert_eq!(backup(&path, 2), Some(document(4)));
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn a_backup_that_is_missing_or_empty_is_never_restored() {
        let path = workspace("restore-refused");
        fs::write(&path, document(2)).unwrap();
        fs::write(backup_path(&path, 1), document(0)).unwrap();

        assert!(restore_backup(&path, 1).is_err());
        assert!(restore_backup(&path, 2).is_err());
        assert!(restore_backup(&path, 9).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), document(2));
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn a_readme_is_cut_on_a_character_boundary() {
        let dir = workspace("readme");
        let dir = dir.parent().unwrap().to_path_buf();
        // Three bytes a character, so byte 1500 lands inside one.
        fs::write(dir.join("README.md"), "€".repeat(700)).unwrap();

        generate_repo_context_files(&dir.to_string_lossy()).unwrap();

        let briefing = fs::read_to_string(dir.join("AGENTS.md")).unwrap();
        assert!(briefing.contains("€€€..."));
        let _ = fs::remove_dir_all(&dir);
    }
}
