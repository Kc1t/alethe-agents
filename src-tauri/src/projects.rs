use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use tauri::AppHandle;
use tokio::sync::Mutex as AsyncMutex;

use crate::provider_common::now_ms;

static SAVE_MUTEX: OnceLock<AsyncMutex<()>> = OnceLock::new();

static LAST_WRITE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

const STALE_WRITE_THRESHOLD_MS: i64 = 2000;

pub const PROJECTS_REVISION_CONFLICT: &str = "projects_revision_conflict";

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ProjectsBootstrap {
    pub active_profile_id: String,
    pub profiles: Vec<crate::profiles::ProfileMeta>,
    pub content: Option<String>,
    pub revision: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct SaveProjectsResult {
    pub profile_id: String,
    pub revision: String,
}

fn save_mutex() -> &'static AsyncMutex<()> {
    SAVE_MUTEX.get_or_init(|| AsyncMutex::new(()))
}

fn projects_path_for_profile_at(
    root: &Path,
    index: &crate::profiles::ProfilesIndex,
    profile_id: &str,
) -> Result<PathBuf, String> {
    Ok(
        crate::profiles::profile_dir_for_id_in_index(root, index, profile_id)?
            .join("projects.json"),
    )
}

fn projects_revision(content: Option<&str>) -> String {
    let Some(content) = content else {
        return "missing".to_string();
    };

    // Stable FNV-1a fingerprint. This is a concurrency token, not a security hash.
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in content.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}-{:x}", content.len())
}

fn read_projects_content(path: &std::path::Path) -> Result<Option<String>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let content = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str::<Value>(&content)
        .map_err(|error| format!("projects file contains invalid JSON: {error}"))?;
    Ok(Some(merge_external_todos(content)))
}

#[cfg(windows)]
fn replace_file(source: &std::path::Path, destination: &std::path::Path) -> Result<(), String> {
    use std::iter::once;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let source_wide = source
        .as_os_str()
        .encode_wide()
        .chain(once(0))
        .collect::<Vec<_>>();
    let destination_wide = destination
        .as_os_str()
        .encode_wide()
        .chain(once(0))
        .collect::<Vec<_>>();
    let result = unsafe {
        MoveFileExW(
            source_wide.as_ptr(),
            destination_wide.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(std::io::Error::last_os_error().to_string())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn replace_file(source: &std::path::Path, destination: &std::path::Path) -> Result<(), String> {
    fs::rename(source, destination).map_err(|error| error.to_string())
}

fn write_atomic_text(path: &std::path::Path, content: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, content).map_err(|error| error.to_string())?;
    replace_file(&temporary, path)
}

fn write_projects_content(path: &std::path::Path, content: &str) -> Result<(), String> {
    serde_json::from_str::<Value>(content)
        .map_err(|error| format!("projects content contains invalid JSON: {error}"))?;
    write_atomic_text(path, content)?;
    save_external_todos(content)
}

fn preserve_conflicting_content(path: &std::path::Path, content: &str) -> Result<PathBuf, String> {
    let profile_dir = path
        .parent()
        .ok_or_else(|| "projects path has no profile directory".to_string())?;
    let conflict_path = profile_dir.join("conflicts").join(format!(
        "projects-{}-{}.json",
        now_ms(),
        nanoid::nanoid!(6)
    ));
    write_atomic_text(&conflict_path, content)?;
    Ok(conflict_path)
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

/// Hydrates `todos` from the external sidecar (if configured) and always
/// reparses + reserializes the result, even when no sidecar merge actually
/// happens. This keeps `read_projects_content`'s output in one canonical
/// byte form regardless of whether a sidecar is present — see
/// `canonical_projects_revision` for why that consistency matters for CAS.
fn merge_external_todos(content: String) -> String {
    let Ok(mut parsed) = serde_json::from_str::<Value>(&content) else {
        return content;
    };
    if let Some(path) = external_todo_path(&content) {
        if let Ok(external) = fs::read_to_string(path) {
            if let Ok(external_json) = serde_json::from_str::<Value>(&external) {
                if let Some(todos) = external_json.get("todos").filter(|value| value.is_array()) {
                    parsed["todos"] = todos.clone();
                }
            }
        }
    }
    serde_json::to_string(&parsed).unwrap_or(content)
}

/// Revision of `content` as it would read back after persisting: parsed and
/// reserialized the same way `merge_external_todos` canonicalizes a stored
/// document. Without this, a byte-for-byte identical retry of a payload
/// whose key order differs from serde_json's canonical form (any real
/// browser client, since `JSON.stringify` uses insertion order, not
/// alphabetical) would hash differently from the on-disk canonical form and
/// trip a false revision conflict even though nothing actually changed.
fn canonical_projects_revision(content: &str) -> String {
    let canonical = serde_json::from_str::<Value>(content)
        .ok()
        .and_then(|value| serde_json::to_string(&value).ok());
    projects_revision(Some(canonical.as_deref().unwrap_or(content)))
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
    replace_file(&temporary, &path)
}

/// Lê `projects.json` cru. Retorna None se o arquivo não existir (primeira
/// abertura). Erros de leitura/parse ficam no front pra decidir se reseta ou
/// mostra erro. Mantemos opaque (String) pra schema poder evoluir só no TS
/// durante o MVP, sem recompilar Rust.
pub fn load_projects_at(root: &Path) -> Result<Option<String>, String> {
    crate::profiles::with_profiles_index_at(root, |index| {
        let path = projects_path_for_profile_at(root, index, &index.active_profile_id)?;
        read_projects_content(&path)
    })
}

#[tauri::command]
pub fn load_projects(app: AppHandle) -> Result<Option<String>, String> {
    load_projects_at(&crate::profiles::resolve_tauri_data_root(&app)?)
}

pub fn load_projects_bootstrap_at(root: &Path) -> Result<ProjectsBootstrap, String> {
    crate::profiles::with_profiles_index_at(root, |index| {
        let state = crate::profiles::profiles_state_from(index);
        let active_profile_id = state.active_profile_id.clone();
        let path = projects_path_for_profile_at(root, index, &active_profile_id)?;
        let content = read_projects_content(&path)?;
        let revision = projects_revision(content.as_deref());
        Ok(ProjectsBootstrap {
            active_profile_id,
            profiles: state.profiles,
            content,
            revision,
        })
    })
}

#[tauri::command]
pub fn load_projects_bootstrap(app: AppHandle) -> Result<ProjectsBootstrap, String> {
    load_projects_bootstrap_at(&crate::profiles::resolve_tauri_data_root(&app)?)
}

pub async fn save_projects_for_profile_at(
    root: PathBuf,
    profile_id: String,
    content: String,
    expected_revision: String,
) -> Result<SaveProjectsResult, String> {
    let _guard = save_mutex().lock().await;

    tokio::task::spawn_blocking(move || {
        serde_json::from_str::<Value>(&content)
            .map_err(|error| format!("projects content contains invalid JSON: {error}"))?;
        crate::profiles::with_profiles_index_at(&root, |index| {
            let path = projects_path_for_profile_at(&root, index, &profile_id)?;
            let current = read_projects_content(&path)?;
            let current_revision = projects_revision(current.as_deref());
            let payload_revision = canonical_projects_revision(&content);
            if current_revision != expected_revision && current_revision != payload_revision {
                let backup = preserve_conflicting_content(&path, &content)?;
                eprintln!(
                    "[projects] Preserved a rejected write at {}",
                    backup.display()
                );
                return Err(format!("{PROJECTS_REVISION_CONFLICT}:backup_created"));
            }

            if current_revision == payload_revision {
                save_external_todos(&content)?;
            } else {
                write_projects_content(&path, &content)?;
            }
            let stored = read_projects_content(&path)?;
            Ok(SaveProjectsResult {
                profile_id,
                revision: projects_revision(stored.as_deref()),
            })
        })
    })
    .await
    .map_err(|error| format!("save_projects_for_profile task failed: {error}"))?
}

#[tauri::command]
pub async fn save_projects_for_profile(
    app: AppHandle,
    profile_id: String,
    content: String,
    expected_revision: String,
) -> Result<SaveProjectsResult, String> {
    save_projects_for_profile_at(
        crate::profiles::resolve_tauri_data_root(&app)?,
        profile_id,
        content,
        expected_revision,
    )
    .await
}

///

#[tauri::command]
pub async fn save_projects(app: AppHandle, content: String, sequence: u64) -> Result<(), String> {
    // Resolve the namespace before waiting on the I/O lock so a concurrent
    // profile switch cannot redirect this payload to another profile.
    let root = crate::profiles::resolve_tauri_data_root(&app)?;
    let profile_id = crate::profiles::with_profiles_index_at(&root, |index| {
        Ok(index.active_profile_id.clone())
    })?;
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

    // I/O em spawn_blocking: escrever/renomear em disco lento (rede, AV scan)

    tokio::task::spawn_blocking(move || -> Result<(), String> {
        crate::profiles::with_profiles_index_at(&root, |index| {
            let path = projects_path_for_profile_at(&root, index, &profile_id)?;
            write_projects_content(&path, &content)
        })
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
            crate::best_effort!(fs::create_dir_all(parent), "dir_already_exists_or_unwritable");
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
        crate::best_effort!(
            generate_repo_context_files(&target_dir),
            "context_files_optional_for_this_target"
        );

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
        format!("{}...", &readme_content[..1500])
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

    // These are the files the agent reads to know what the project is. Written or not, the app
    // behaves identically; the agent does not, and the symptom appears much later as an agent that
    // "does not follow the project rules".
    for name in ["AGENTS.md", "CLAUDE.md"] {
        if let Err(error) = fs::write(path.join(name), &context_markdown) {
            crate::decide!(
                target: "projects.context",
                attempted = "write_context_file",
                outcome = Failed,
                because = "context_write_failed",
                rule = "project.context_files_describe_the_repo",
                evidence = { file = %name, error = %error },
            );
        }
    }

    Ok(())
}

#[cfg(test)]
mod persistence_tests {
    use super::*;

    fn test_dir(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "alethe-projects-{label}-{}-{}-{}",
            std::process::id(),
            crate::provider_common::now_ms(),
            nanoid::nanoid!(6)
        ))
    }

    #[test]
    fn revision_is_stable_and_distinguishes_missing_content() {
        assert_eq!(projects_revision(None), "missing");
        assert_eq!(
            projects_revision(Some("alpha")),
            projects_revision(Some("alpha"))
        );
        assert_ne!(
            projects_revision(Some("alpha")),
            projects_revision(Some("beta"))
        );
        assert_ne!(projects_revision(None), projects_revision(Some("")));
    }

    #[test]
    fn atomic_writer_replaces_an_existing_document() {
        let root = test_dir("replace");
        let path = root.join("projects.json");

        write_projects_content(&path, r#"{"version":6,"projects":[]}"#).unwrap();
        write_projects_content(&path, r#"{"version":6,"projects":[{"id":"p1"}]}"#).unwrap();

        let stored = fs::read_to_string(&path).unwrap();
        assert!(stored.contains("\"p1\""));
        assert!(!path.with_extension("json.tmp").exists());

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejected_content_is_preserved_outside_the_active_document() {
        let root = test_dir("conflict");
        let path = root.join("projects.json");
        write_projects_content(&path, r#"{"version":6,"projects":[]}"#).unwrap();

        let backup =
            preserve_conflicting_content(&path, r#"{"version":6,"projects":[{"id":"local"}]}"#)
                .unwrap();

        assert!(backup.starts_with(root.join("conflicts")));
        assert!(fs::read_to_string(backup).unwrap().contains("\"local\""));
        assert!(!fs::read_to_string(path).unwrap().contains("\"local\""));

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn corrupt_projects_file_is_reported_without_being_replaced() {
        let root = test_dir("corrupt");
        crate::profiles::ensure_profiles_index_at(&root).unwrap();
        let path = root.join("profiles").join("default").join("projects.json");
        fs::write(&path, "{not-json").unwrap();

        assert!(load_projects_bootstrap_at(&root).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "{not-json");

        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn revision_save_is_idempotent_and_preserves_stale_payloads() {
        let root = test_dir("revision");
        crate::profiles::ensure_profiles_index_at(&root).unwrap();
        let first = r#"{"version":6,"projects":[{"id":"first"}]}"#.to_string();

        let saved = save_projects_for_profile_at(
            root.clone(),
            "default".to_string(),
            first.clone(),
            "missing".to_string(),
        )
        .await
        .unwrap();

        let retry = save_projects_for_profile_at(
            root.clone(),
            "default".to_string(),
            first.clone(),
            "missing".to_string(),
        )
        .await
        .unwrap();
        assert_eq!(retry.revision, saved.revision);

        let stale = save_projects_for_profile_at(
            root.clone(),
            "default".to_string(),
            r#"{"version":6,"projects":[{"id":"stale"}]}"#.to_string(),
            "missing".to_string(),
        )
        .await
        .unwrap_err();
        assert!(stale.starts_with(PROJECTS_REVISION_CONFLICT));

        let bootstrap = load_projects_bootstrap_at(&root).unwrap();
        assert!(bootstrap.content.unwrap().contains("\"first\""));
        let conflicts = root.join("profiles").join("default").join("conflicts");
        assert_eq!(fs::read_dir(conflicts).unwrap().count(), 1);

        fs::remove_dir_all(root).unwrap();
    }
}
