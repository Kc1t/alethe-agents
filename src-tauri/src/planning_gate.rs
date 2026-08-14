//! Gate de conclusão de planejamento GSD para a Central de Merges.
//!
//! Módulo deliberadamente independente de `planning.rs` (lado de
//! escrita/watcher do repo principal) — aqui a pergunta é "o PLANO INTEIRO
//! desta worktree está completo?", um conceito diferente de uma task
//! individual. `scheduler.rs` reaproveita `parse_roadmap_items` (abaixo) pra
//! derivar tasks agendáveis a partir do mesmo `task.md` real, em vez de um
//! formato próprio.
//!
//! Lê sob demanda (nunca via watcher): o GSD Watcher observa só o repo
//! principal do projeto, nunca cada worktree de agente individualmente, então
//! não há evento pra reagir aqui — o painel de merges faz poll leve.
//!
//! Estrutura de `.planning/` (ver `assets/opencode-plugins/alethe-gsd-state.ts`):
//! `status.md` e `task.md` são escritos deterministicamente pelo plugin a
//! cada `todowrite` (sem LLM); `plan.md` e `goal.md` só a IA escreve, via
//! skill. Cada arquivo tem exatamente um escritor — sem risco de um
//! sobrescrever o outro.

use serde::Serialize;
use std::path::Path;

/// Um passo do "Briefing de Testes", registrado pela sessão-filha via tool
/// dedicada (`gsd_record_step`, em `alethe-gsd-state.ts`) — nunca por parsing
/// de markdown solto. `category` já vem validada pelo schema zod do lado do
/// plugin (`setup`/`action`/`verify`), mas aqui é só `String` — se um humano
/// editar `procedure.json` na mão com outro valor, o frontend decide como
/// tratar (fallback visual), não é motivo pra falhar a leitura inteira.
#[derive(Debug, Clone, Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProcedureStep {
    pub description: String,
    pub category: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct PlanningStatus {
    pub has_planning: bool,
    pub reported_complete: bool,
    pub progress: Option<u8>,
    pub roadmap_pending_count: Option<usize>,
    pub roadmap_total_count: Option<usize>,
    /// Conteúdo cru de `plan.md` — escrito pelo skill do plugin OpenCode
    /// (`alethe-gsd-state.ts`) com o plano passo a passo, incluindo o
    /// procedimento de teste. Sem parsing de seções; o frontend decide como
    /// exibir (ex.: dividir em linhas pro checklist do Briefing de Testes).
    pub notes: Option<String>,
}

/// Parse de `status.md`: linhas `Status: <valor>` / `Progress: <pct>%`.
/// `status` é autoritativo quando presente; `progress` só decide quando
/// `status` está ausente — evita que um arquivo parcialmente atualizado
/// (`Status: In Progress` + `Progress: 100%` esquecido) seja lido como
/// completo por engano.
fn parse_status_md(content: &str) -> (Option<String>, Option<u8>) {
    let mut status = None;
    let mut progress = None;
    for line in content.lines() {
        let Some((key, val)) = line.split_once(':') else {
            continue;
        };
        let key = key.trim().to_lowercase();
        let val = val.trim().trim_matches('"').trim_matches('\'');
        match key.as_str() {
            "status" => status = Some(val.to_lowercase()),
            "progress" => progress = val.trim_end_matches('%').trim().parse::<u8>().ok(),
            _ => {}
        }
    }
    (status, progress)
}

fn is_complete_status(status: &str) -> bool {
    matches!(status, "completed" | "complete" | "done")
}

/// Um item de checklist markdown (`- [ ] texto`/`- [x] texto`), com o texto
/// preservado — usado pelo Scheduler pra derivar tasks agendáveis a partir do
/// `task.md` real (ver `scheduler.rs::load_gsd_tasks`), não só a contagem.
pub(crate) struct RoadmapItem {
    pub checked: bool,
    pub text: String,
}

/// Parse de checkboxes markdown (`- [ ]`/`- [x]`/`- [X]`, indentação
/// tolerada), na ordem em que aparecem no arquivo.
pub(crate) fn parse_roadmap_items(content: &str) -> Vec<RoadmapItem> {
    let mut items = Vec::new();
    for line in content.lines() {
        let trimmed = line
            .trim_start()
            .trim_start_matches('-')
            .trim_start_matches('*')
            .trim();
        if let Some(rest) = trimmed.strip_prefix('[') {
            if let Some(mark) = rest.chars().next() {
                if rest.as_bytes().get(1) == Some(&b']') {
                    let text = rest[2..].trim().to_string();
                    items.push(RoadmapItem {
                        checked: mark != ' ',
                        text,
                    });
                }
            }
        }
    }
    items
}

/// Conta checkboxes markdown — wrapper fino sobre `parse_roadmap_items`.
fn count_roadmap_checkboxes(content: &str) -> (usize, usize) {
    let items = parse_roadmap_items(content);
    let total = items.len();
    let pending = items.iter().filter(|item| !item.checked).count();
    (pending, total)
}

/// Núcleo puro/testável — recebe a raiz JÁ resolvida da worktree. Ausência de
/// `.planning/`/`status.md`/`task.md` é um estado válido (planejamento ainda
/// não formalizado), não uma falha — por isso devolve `PlanningStatus` direto,
/// sem `Result`.
pub(crate) fn compute_planning_status(worktree_root: &Path) -> PlanningStatus {
    let planning_dir = worktree_root.join(".planning");
    if !planning_dir.is_dir() {
        return PlanningStatus::default();
    }

    let status_content = std::fs::read_to_string(planning_dir.join("status.md")).ok();
    let task_content = std::fs::read_to_string(planning_dir.join("task.md")).ok();
    let plan_content = std::fs::read_to_string(planning_dir.join("plan.md")).ok();

    let (roadmap_pending_count, roadmap_total_count) = match &task_content {
        Some(content) if !content.trim().is_empty() => {
            let (pending, total) = count_roadmap_checkboxes(content);
            (Some(pending), Some(total))
        }
        _ => (None, None),
    };

    let notes = plan_content
        .map(|c| c.trim().to_string())
        .filter(|c| !c.is_empty());

    let Some(status_content) = status_content.filter(|c| !c.trim().is_empty()) else {
        // Sem status.md: fallback pro task.md — 0 pendentes entre pelo menos
        // uma checkbox conta como completo pra quem não quer manter status.md.
        let reported_complete =
            roadmap_total_count.unwrap_or(0) > 0 && roadmap_pending_count == Some(0);
        return PlanningStatus {
            has_planning: true,
            reported_complete,
            progress: None,
            roadmap_pending_count,
            roadmap_total_count,
            notes,
        };
    };

    let (status, progress) = parse_status_md(&status_content);
    let reported_complete = match status {
        Some(s) => is_complete_status(&s),
        None => progress == Some(100),
    };

    PlanningStatus {
        has_planning: true,
        reported_complete,
        progress,
        roadmap_pending_count,
        roadmap_total_count,
        notes,
    }
}

/// Lê o estado de planejamento da PRÓPRIA worktree do agente (não do repo
/// principal) — `repository_root` resolve a raiz real do checkout passado,
/// mesmo padrão de resolução já usado em `git_control.rs`.
#[tauri::command]
pub fn read_planning_status(repo_path: String) -> Result<PlanningStatus, String> {
    let root = crate::git_control::repository_root(&repo_path)?;
    Ok(compute_planning_status(&root))
}

/// Lê `.planning/.gsd-child-session` — sentinel escrito pelo plugin OpenCode
/// (`alethe-gsd-state.ts`) assim que cria/reaproveita a sessão-filha isolada
/// que documenta `goal.md`/`plan.md`. O painel de merges usa isso pra saber
/// que sessionId anexar numa pane "GSD Sync" (via `opencode --session <id>`).
/// `None` é um estado válido (sessão-filha ainda não existe) — sem `Result`.
#[tauri::command]
pub fn read_gsd_child_session(repo_path: String) -> Result<Option<String>, String> {
    let root = crate::git_control::repository_root(&repo_path)?;
    let content = std::fs::read_to_string(root.join(".planning").join(".gsd-child-session"))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    Ok(content)
}

/// Lê `.planning/.gsd-child-busy` — sentinel presente enquanto a sessão-filha
/// está processando um ciclo de sincronização. Usado pra decidir
/// `laneVisible` da pane "GSD Sync" (aparece enquanto ocupada, colapsa
/// quando some).
#[tauri::command]
pub fn read_gsd_child_busy(repo_path: String) -> Result<bool, String> {
    let root = crate::git_control::repository_root(&repo_path)?;
    Ok(root.join(".planning").join(".gsd-child-busy").is_file())
}

/// Lê (e CONSOME — apaga em seguida) `.planning/.gsd-child-error` — sentinel
/// escrito pelo plugin só quando TODA a cadeia de fallback de modelos falha.
/// Consumir na leitura evita mostrar o mesmo toast de erro em polls
/// seguintes; único consumidor é o poll da sidebar, então ler = "já avisei".
#[tauri::command]
pub fn read_gsd_child_error(repo_path: String) -> Result<Option<String>, String> {
    let root = crate::git_control::repository_root(&repo_path)?;
    let path = root.join(".planning").join(".gsd-child-error");
    let content = std::fs::read_to_string(&path)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    if content.is_some() {
        let _ = std::fs::remove_file(&path);
    }
    Ok(content)
}

/// Lê `.planning/procedure.json` — passos de teste estruturados registrados
/// pela sessão-filha via tool dedicada (`gsd_record_step`), em vez de texto
/// solto dentro de `plan.md`. Reescrito do zero a cada ciclo pelo plugin
/// (mesmo espírito de goal.md/plan.md), então já reflete só o procedimento
/// atual. Lista vazia é um estado válido (sem planejamento GSD, ciclo ainda
/// não rodou, ou arquivo malformado) — sem `Result` de erro pra isso.
#[tauri::command]
pub fn read_gsd_procedure(repo_path: String) -> Result<Vec<ProcedureStep>, String> {
    let root = crate::git_control::repository_root(&repo_path)?;
    let content = std::fs::read_to_string(root.join(".planning").join("procedure.json")).ok();
    let steps = content
        .and_then(|c| serde_json::from_str::<Vec<ProcedureStep>>(&c).ok())
        .unwrap_or_default();
    Ok(steps)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(label: &str) -> std::path::PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("alethe-planning-gate-{label}-{suffix}"));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn no_planning_dir_means_not_started() {
        let root = temp_dir("no-planning");
        let status = compute_planning_status(&root);
        assert!(!status.has_planning);
        assert!(!status.reported_complete);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn planning_dir_without_status_or_task_is_incomplete() {
        let root = temp_dir("empty-planning");
        fs::create_dir_all(root.join(".planning")).unwrap();
        let status = compute_planning_status(&root);
        assert!(status.has_planning);
        assert!(!status.reported_complete);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn status_md_complete_status_wins() {
        let root = temp_dir("status-complete");
        fs::create_dir_all(root.join(".planning")).unwrap();
        fs::write(
            root.join(".planning").join("status.md"),
            "Status: Completed\nProgress: 100%\n",
        )
        .unwrap();
        let status = compute_planning_status(&root);
        assert!(status.reported_complete);
        assert_eq!(status.progress, Some(100));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn status_md_status_overrides_conflicting_progress() {
        let root = temp_dir("status-conflict");
        fs::create_dir_all(root.join(".planning")).unwrap();
        fs::write(
            root.join(".planning").join("status.md"),
            "Status: In Progress\nProgress: 100%\n",
        )
        .unwrap();
        let status = compute_planning_status(&root);
        assert!(
            !status.reported_complete,
            "status desatualizado não pode vencer sobre progress esquecido em 100"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn task_fallback_when_status_md_missing() {
        let root = temp_dir("task-fallback");
        fs::create_dir_all(root.join(".planning")).unwrap();
        fs::write(
            root.join(".planning").join("task.md"),
            "- [x] task 1\n- [x] task 2\n",
        )
        .unwrap();
        let status = compute_planning_status(&root);
        assert!(status.reported_complete);
        assert_eq!(status.roadmap_pending_count, Some(0));
        assert_eq!(status.roadmap_total_count, Some(2));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn task_with_pending_items_is_reported_and_not_complete() {
        let root = temp_dir("task-pending");
        fs::create_dir_all(root.join(".planning")).unwrap();
        fs::write(
            root.join(".planning").join("task.md"),
            "- [x] done 1\n- [ ] pending 1\n- [x] done 2\n- [ ] pending 2\n- [x] done 3\n",
        )
        .unwrap();
        let status = compute_planning_status(&root);
        assert!(!status.reported_complete);
        assert_eq!(status.roadmap_pending_count, Some(2));
        assert_eq!(status.roadmap_total_count, Some(5));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn notes_extracted_from_plan_md() {
        let root = temp_dir("plan-notes");
        fs::create_dir_all(root.join(".planning")).unwrap();
        fs::write(
            root.join(".planning").join("plan.md"),
            "1. Criar o arquivo.\n2. Validar sua existência.\n",
        )
        .unwrap();
        let status = compute_planning_status(&root);
        let notes = status.notes.expect("notes deveria estar presente");
        assert!(notes.contains("Criar o arquivo"));
        assert!(notes.contains("Validar sua existência"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn notes_is_none_when_plan_md_missing_or_empty() {
        let root = temp_dir("plan-no-notes");
        fs::create_dir_all(root.join(".planning")).unwrap();
        fs::write(
            root.join(".planning").join("status.md"),
            "Status: Completed\n",
        )
        .unwrap();
        let status = compute_planning_status(&root);
        assert!(status.notes.is_none());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn read_planning_status_resolves_the_given_worktree_not_the_main_repo() {
        let root = temp_dir("worktree-resolve");
        crate::git_control::checked_output(&root, &["init", "-b", "main"]).unwrap();
        crate::git_control::checked_output(&root, &["config", "user.name", "Alethe Test"]).unwrap();
        crate::git_control::checked_output(
            &root,
            &["config", "user.email", "alethe@example.invalid"],
        )
        .unwrap();
        fs::write(root.join("a.txt"), "a\n").unwrap();
        crate::git_control::checked_output(&root, &["add", "-A"]).unwrap();
        crate::git_control::checked_output(&root, &["commit", "-m", "base"]).unwrap();

        let worktree = root.join("wt");
        crate::git_control::checked_output(
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

        // .planning/ completo só na worktree, não no repo principal.
        fs::create_dir_all(worktree.join(".planning")).unwrap();
        fs::write(
            worktree.join(".planning").join("status.md"),
            "Status: Completed\n",
        )
        .unwrap();

        let main_status = read_planning_status(root.to_string_lossy().into_owned()).unwrap();
        assert!(!main_status.has_planning);

        let worktree_status =
            read_planning_status(worktree.to_string_lossy().into_owned()).unwrap();
        assert!(worktree_status.reported_complete);

        fs::remove_dir_all(&root).unwrap();
    }

    /// `read_gsd_child_session`/`read_gsd_child_busy` passam por
    /// `repository_root` (igual `read_planning_status`) — precisam de um repo
    /// git de verdade, não só uma pasta solta.
    fn temp_git_repo(label: &str) -> std::path::PathBuf {
        let root = temp_dir(label);
        crate::git_control::checked_output(&root, &["init", "-b", "main"]).unwrap();
        crate::git_control::checked_output(&root, &["config", "user.name", "Alethe Test"]).unwrap();
        crate::git_control::checked_output(
            &root,
            &["config", "user.email", "alethe@example.invalid"],
        )
        .unwrap();
        fs::write(root.join("a.txt"), "a\n").unwrap();
        crate::git_control::checked_output(&root, &["add", "-A"]).unwrap();
        crate::git_control::checked_output(&root, &["commit", "-m", "base"]).unwrap();
        root
    }

    #[test]
    fn gsd_child_session_is_none_when_sentinel_missing() {
        let root = temp_git_repo("child-session-missing");
        fs::create_dir_all(root.join(".planning")).unwrap();
        assert_eq!(
            read_gsd_child_session(root.to_string_lossy().into_owned()).unwrap(),
            None
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn gsd_child_session_reads_trimmed_sentinel_content() {
        let root = temp_git_repo("child-session-present");
        fs::create_dir_all(root.join(".planning")).unwrap();
        fs::write(
            root.join(".planning").join(".gsd-child-session"),
            "ses_abc123\n",
        )
        .unwrap();
        assert_eq!(
            read_gsd_child_session(root.to_string_lossy().into_owned()).unwrap(),
            Some("ses_abc123".to_string())
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn gsd_child_busy_reflects_sentinel_presence() {
        let root = temp_git_repo("child-busy");
        fs::create_dir_all(root.join(".planning")).unwrap();
        assert!(!read_gsd_child_busy(root.to_string_lossy().into_owned()).unwrap());
        fs::write(root.join(".planning").join(".gsd-child-busy"), "1").unwrap();
        assert!(read_gsd_child_busy(root.to_string_lossy().into_owned()).unwrap());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn gsd_child_error_is_none_when_sentinel_missing() {
        let root = temp_git_repo("child-error-missing");
        fs::create_dir_all(root.join(".planning")).unwrap();
        assert_eq!(
            read_gsd_child_error(root.to_string_lossy().into_owned()).unwrap(),
            None
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn gsd_child_error_reads_and_consumes_sentinel() {
        let root = temp_git_repo("child-error-present");
        fs::create_dir_all(root.join(".planning")).unwrap();
        fs::write(
            root.join(".planning").join(".gsd-child-error"),
            "todos os modelos falharam\n",
        )
        .unwrap();
        assert_eq!(
            read_gsd_child_error(root.to_string_lossy().into_owned()).unwrap(),
            Some("todos os modelos falharam".to_string())
        );
        // consumido — segunda leitura já não acha mais nada.
        assert_eq!(
            read_gsd_child_error(root.to_string_lossy().into_owned()).unwrap(),
            None
        );
        fs::remove_dir_all(root).unwrap();
    }
}
