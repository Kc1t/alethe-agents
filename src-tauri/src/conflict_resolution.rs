//! RFC-007 — Conflict Resolution (ambiente efêmero de merge).
//!
//! Segundo estágio do ciclo de merge seguro. O Merge Analyzer (RFC-006) decidiu
//! que existe integração a fazer; este módulo provisiona um **ambiente efêmero**
//! (worktree `alethe/merge-<id>`) com o merge real aplicado — incluindo os
//! marcadores de conflito — e o **contexto mínimo** (`ALETHE_CONFLICT.md`) para
//! o Conflict Resolution Agent trabalhar:
//!
//! - o agente é efêmero e provider-agnóstico: o FRONT spawna o CLI configurado
//!   (Claude/Codex/OpenCode) com `cwd = env.path`; ele nasce, resolve, morre;
//! - o agente NUNCA decide se há conflito (isso é do Analyzer) e NUNCA
//!   implementa features (o prompt trava o escopo);
//! - `merge_finalize` é o gate: confere que não sobrou marcador, roda a
//!   Validation Pipeline (RFC-008, `validation.rs`) e só então commita e integra
//!   no branch alvo via `--ff-only` — o worktree do usuário só avança limpo;
//! - `merge_abort` destrói o ambiente sem deixar rastro.
//!
//! Metadados do ciclo ficam FORA do worktree (`merge-envs/<id>.json`) para não
//! contaminarem o commit de merge; o prompt fica dentro (o agente precisa ler),
//! mas é removido antes do commit.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use crate::git_control::{checked_output, git_command, repository_root};
use crate::merge_analyzer::{class_strategy, classify_path, merge_envs_dir, unmerged_files, ConflictFile};
use crate::worktrees::git_arg;

const PROMPT_FILE: &str = "ALETHE_CONFLICT.md";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MergeMeta {
    id: String,
    source: String,
    target: String,
    project_id: Option<String>,
    conflict_paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictEnv {
    pub id: String,
    pub path: String,
    pub branch: String,
    pub clean: bool,
    pub conflicts: Vec<ConflictFile>,
    pub prompt_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MergeOutcome {
    pub merged: bool,
    pub stage: String,
    pub output: String,
    /// Camada 3 do Escudo (aviso, nunca bloqueia): endpoints chamados pelo
    /// frontend sem rota de backend correspondente encontrada no ambiente
    /// efêmero. Best-effort — falha silenciosa não impede o merge.
    #[serde(default)]
    pub contract_warnings: Vec<crate::contract_check::ContractWarning>,
}

fn validate_env_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("invalid_env_id".to_string());
    }
    Ok(())
}

fn env_dir(root: &Path, id: &str) -> PathBuf {
    merge_envs_dir(root).join(id)
}

fn meta_path(root: &Path, id: &str) -> PathBuf {
    merge_envs_dir(root).join(format!("{id}.json"))
}

fn read_meta(root: &Path, id: &str) -> Result<MergeMeta, String> {
    let raw = std::fs::read_to_string(meta_path(root, id))
        .map_err(|_| "merge_env_not_found".to_string())?;
    serde_json::from_str(&raw).map_err(|e| format!("invalid_merge_meta:{e}"))
}

fn emit(event_type: &str, meta: &MergeMeta, data: serde_json::Value) {
    crate::event_bus::publish_event_simple(
        event_type,
        &format!("merge-{}", meta.id),
        meta.project_id.clone(),
        None,
        data,
    );
}

fn build_prompt(meta: &MergeMeta, conflicts: &[ConflictFile]) -> String {
    let mut lines = vec![
        "# Resolução de conflito de merge (Alethe)".to_string(),
        String::new(),
        format!("Merge de `{}` para `{}`. Este diretório é um ambiente EFÊMERO só para esta integração.", meta.source, meta.target),
        String::new(),
        "## Regras (escopo travado)".to_string(),
        "- Resolva SOMENTE os conflitos listados abaixo. Nada além disso.".to_string(),
        "- NUNCA implemente funcionalidades, mude requisitos ou arquitetura.".to_string(),
        "- Preserve a intenção das DUAS branches; confirme que nada se perdeu.".to_string(),
        "- Ao terminar, apenas salve os arquivos resolvidos (sem commit — o Alethe commita após validar).".to_string(),
        String::new(),
        "## Arquivos em conflito".to_string(),
    ];
    for conflict in conflicts {
        lines.push(format!(
            "- `{}` — {:?}: {}",
            conflict.path,
            conflict.class,
            class_strategy(conflict.class)
        ));
    }
    lines.push(String::new());
    lines.push("Use `git diff` neste diretório para ver os marcadores (`<<<<<<<`/`>>>>>>>`).".to_string());
    lines.join("\n")
}

/// Provisiona o ambiente efêmero com o merge aplicado (com marcadores, se houver
/// conflito). Publica `MergeRequested` (+ `MergeConflict` quando aplicável).
///
/// Comandos deste arquivo rodam `git`/IO de verdade — igual ao `spawn_pty` do
/// `pty.rs` e aos comandos de `worktrees.rs` (ambos já corrigidos), isso nunca
/// pode rodar direto na thread de despacho do Tauri. Lógica de cada comando
/// fica numa função `_inner` síncrona comum (testável direto), e o
/// `#[tauri::command]` exposto é só um wrapper fino em `spawn_blocking`.
#[tauri::command]
pub async fn merge_prepare(
    repo: String,
    source: String,
    target: String,
    project_id: Option<String>,
) -> Result<ConflictEnv, String> {
    tokio::task::spawn_blocking(move || merge_prepare_inner(repo, source, target, project_id))
        .await
        .map_err(|error| format!("merge_prepare: falha na task bloqueante: {error}"))?
}

pub(crate) fn merge_prepare_inner(
    repo: String,
    source: String,
    target: String,
    project_id: Option<String>,
) -> Result<ConflictEnv, String> {
    let root = repository_root(&repo)?;
    let id = nanoid::nanoid!(10).replace(['_', '-'], "x");
    let envs = merge_envs_dir(&root);
    std::fs::create_dir_all(&envs).map_err(|e| format!("mkdir_failed:{e}"))?;
    let env = env_dir(&root, &id);
    let env_arg = git_arg(&env);
    let branch = format!("alethe/merge-{id}");

    checked_output(&root, &["worktree", "add", "-b", &branch, &env_arg, &target])?;
    let merge = git_command(&env, &["merge", "--no-commit", "--no-ff", &source])?;
    let clean = merge.status.success();
    let conflicts: Vec<ConflictFile> = if clean {
        Vec::new()
    } else {
        unmerged_files(&env)?
            .into_iter()
            .map(|path| ConflictFile {
                class: classify_path(&path),
                path,
            })
            .collect()
    };

    let meta = MergeMeta {
        id: id.clone(),
        source,
        target,
        project_id,
        conflict_paths: conflicts.iter().map(|c| c.path.clone()).collect(),
    };
    let meta_body = serde_json::to_string_pretty(&meta).map_err(|e| e.to_string())?;
    std::fs::write(meta_path(&root, &id), meta_body).map_err(|e| format!("write_failed:{e}"))?;

    let prompt_path = if clean {
        None
    } else {
        let path = env.join(PROMPT_FILE);
        std::fs::write(&path, build_prompt(&meta, &conflicts))
            .map_err(|e| format!("write_failed:{e}"))?;
        Some(git_arg(&path))
    };

    emit(
        "MergeRequested",
        &meta,
        serde_json::json!({ "source": meta.source, "target": meta.target, "clean": clean }),
    );
    if !clean {
        emit(
            "MergeConflict",
            &meta,
            serde_json::json!({ "conflict_count": conflicts.len(), "env": env.to_string_lossy() }),
        );
    }

    Ok(ConflictEnv {
        id,
        // `env` vem de um `root` já canonicalizado (prefixo `\\?\` no Windows) —
        // sem stripar aqui, o frontend usa esse `path` como cwd pra spawnar o
        // agente de resolução de conflito, e nem todo CLI tolera esse prefixo
        // como diretório de trabalho (mesma causa-raiz corrigida em
        // `worktrees::worktree_provision`/`worktree_list`).
        path: git_arg(&env),
        branch,
        clean,
        conflicts,
        prompt_path,
    })
}

/// Varre os arquivos que estavam em conflito atrás de marcadores esquecidos.
fn leftover_markers(env: &Path, paths: &[String]) -> Vec<String> {
    let mut leftovers = Vec::new();
    for rel in paths {
        let file = env.join(rel);
        let Ok(content) = std::fs::read_to_string(&file) else {
            continue; // binário/removido — o estágio de unmerged já cobre
        };
        if content
            .lines()
            .any(|line| line.starts_with("<<<<<<<") || line.starts_with(">>>>>>>"))
        {
            leftovers.push(rel.clone());
        }
    }
    leftovers
}

/// Gate final: sem marcadores → Validation Pipeline → commit → `--ff-only` no
/// branch alvo → teardown. Se qualquer etapa falhar, o ambiente é PRESERVADO
/// para inspeção/retry e o motivo volta em `MergeOutcome`.
#[tauri::command]
pub async fn merge_finalize(
    repo: String,
    env_id: String,
    validation_commands: Vec<String>,
) -> Result<MergeOutcome, String> {
    tokio::task::spawn_blocking(move || merge_finalize_inner(repo, env_id, validation_commands))
        .await
        .map_err(|error| format!("merge_finalize: falha na task bloqueante: {error}"))?
}

/// Checa marcadores/unmerged, estagia (`add -A`) e roda a Validation Pipeline
/// — SEM commitar nem integrar. Compartilhado por `merge_validate` (pára
/// aqui, gate manual) e `merge_finalize` (continua pro commit só depois que
/// isto retorna `Ok(None)`).
///
/// `Ok(Some(outcome))` = bloqueado (marcadores, unmerged ou validação falhou)
/// — `outcome.merged` sempre `false`. `Ok(None)` = validado e staged, pronto
/// pra commitar.
fn validate_and_stage(
    env: &Path,
    meta: &MergeMeta,
    validation_commands: Vec<String>,
) -> Result<Option<MergeOutcome>, String> {
    // Conflitos ainda não resolvidos (não-staged) contam como pendência.
    let pending = unmerged_files(env)?;
    let markers = leftover_markers(env, &meta.conflict_paths);
    if !markers.is_empty() {
        return Ok(Some(MergeOutcome {
            merged: false,
            stage: "conflict_markers".to_string(),
            output: format!("Marcadores de conflito restantes em: {}", markers.join(", ")),
            ..Default::default()
        }));
    }

    // Remove o prompt ANTES do `add -A` — não pode entrar no commit. Removê-lo
    // DEPOIS de estagiado não adianta nada: `git add -A` já capturou o
    // conteúdo dele no índice, e apagar do disco em seguida não desfaz esse
    // stage sozinho (precisaria de outro `add -A`/`rm` pra refletir a
    // remoção) — confirmado ao vivo: `ALETHE_CONFLICT.md` vazou pro commit
    // final por causa exatamente dessa ordem errada, numa versão anterior
    // deste mesmo código nesta sessão. Também não pode remover mais cedo que
    // isso, incondicionalmente (como era antes de existir esse gate) —
    // apagava o arquivo no primeiro poll periódico (a cada 7s, ver
    // `beginResolvingWatch` no frontend) mesmo com o agente ainda
    // digitando/confirmando o prompt inicial.
    let _ = std::fs::remove_file(env.join(PROMPT_FILE));

    checked_output(env, &["add", "-A"])?;
    if !pending.is_empty() {
        // add -A acabou de stagear; se ainda assim restar unmerged, algo está errado.
        let still = unmerged_files(env)?;
        if !still.is_empty() {
            return Ok(Some(MergeOutcome {
                merged: false,
                stage: "unmerged".to_string(),
                output: format!("Arquivos não resolvidos: {}", still.join(", ")),
                ..Default::default()
            }));
        }
    }

    // RFC-008 — Validation Pipeline no ambiente de merge, antes de integrar.
    let validation =
        crate::validation::run_validation(env.to_string_lossy().into_owned(), validation_commands)?;
    if !validation.success {
        emit(
            "MergeValidationFailed",
            meta,
            serde_json::json!({ "stage": validation.stage }),
        );
        return Ok(Some(MergeOutcome {
            merged: false,
            stage: format!("validation:{}", validation.stage),
            output: validation.output,
            ..Default::default()
        }));
    }
    emit("MergeValidated", meta, serde_json::json!({}));
    Ok(None)
}

/// Só valida (marcadores + Validation Pipeline), sem commitar nem integrar —
/// gate manual: o usuário confirma que a resolução está boa ANTES de
/// `merge_finalize` tocar em `git commit`/`git merge`. Pedido explícito do
/// usuário: o gatilho automático de 3 camadas (ver `beginResolvingWatch` no
/// frontend) integrava sozinho assim que o agente sinalizava "terminei", sem
/// nenhum humano confirmar se a resolução fazia sentido — confirmado ao vivo
/// como imprudente (agente juntou conteúdo incompatível num arquivo só, sem
/// perguntar, e foi commitado/integrado automaticamente).
#[tauri::command]
pub async fn merge_validate(
    repo: String,
    env_id: String,
    validation_commands: Vec<String>,
) -> Result<MergeOutcome, String> {
    tokio::task::spawn_blocking(move || merge_validate_inner(repo, env_id, validation_commands))
        .await
        .map_err(|error| format!("merge_validate: falha na task bloqueante: {error}"))?
}

pub(crate) fn merge_validate_inner(
    repo: String,
    env_id: String,
    validation_commands: Vec<String>,
) -> Result<MergeOutcome, String> {
    let root = repository_root(&repo)?;
    validate_env_id(&env_id)?;
    let env = env_dir(&root, &env_id);
    if !env.is_dir() {
        return Err("merge_env_not_found".to_string());
    }
    let meta = read_meta(&root, &env_id)?;
    match validate_and_stage(&env, &meta, validation_commands)? {
        Some(outcome) => Ok(outcome),
        None => Ok(MergeOutcome {
            merged: false,
            stage: "validated".to_string(),
            output: "Validação passou — pronto para integrar.".to_string(),
            ..Default::default()
        }),
    }
}

pub(crate) fn merge_finalize_inner(
    repo: String,
    env_id: String,
    validation_commands: Vec<String>,
) -> Result<MergeOutcome, String> {
    let root = repository_root(&repo)?;
    validate_env_id(&env_id)?;
    let env = env_dir(&root, &env_id);
    if !env.is_dir() {
        return Err("merge_env_not_found".to_string());
    }
    let meta = read_meta(&root, &env_id)?;

    // Revalida na hora do commit (idempotente e barato o bastante) — cobre o
    // caso do usuário ter clicado em "Integrar" sem passar por "Validar"
    // antes, ou de algo ter mudado no ambiente entre os dois cliques.
    if let Some(outcome) = validate_and_stage(&env, &meta, validation_commands)? {
        return Ok(outcome);
    }

    // Camada 3 do Escudo — Verificador de Contrato de API (heurístico, best-effort).
    // Nunca falha o merge: erro na checagem só vira lista vazia de avisos.
    let contract_warnings = crate::contract_check::contract_check(env.to_string_lossy().into_owned())
        .unwrap_or_default();

    let message = format!("merge(alethe): {} -> {}", meta.source, meta.target);
    // Depois de um merge_rebase_onto_target bem-sucedido, a reconciliação já
    // commitou tudo — não sobra nada staged aqui, e isso é esperado (HEAD já é
    // o commit correto). `diff --cached --quiet`: exit 0 = nada staged (git
    // imprime "nothing to commit" no STDOUT, que checked_output nem captura —
    // checar staged de antemão é mais robusto que tentar casar essa mensagem).
    let has_staged_changes = git_command(&env, &["diff", "--cached", "--quiet"])
        .map(|output| !output.status.success())
        .unwrap_or(true);
    if has_staged_changes {
        checked_output(&env, &["commit", "-m", &message])?;
    }

    // Integração: o branch alvo precisa estar checked out no repo do usuário e o
    // avanço precisa ser fast-forward — nunca reescrevemos nada do usuário.
    let head = checked_output(&root, &["symbolic-ref", "--short", "HEAD"])
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();
    if head != meta.target {
        return Ok(MergeOutcome {
            merged: false,
            stage: "target_not_checked_out".to_string(),
            output: format!(
                "O branch alvo '{}' não está checked out no repositório (atual: '{}'). Faça checkout e finalize de novo.",
                meta.target, head
            ),
            ..Default::default()
        });
    }
    let branch = format!("alethe/merge-{env_id}");
    if let Err(error) = checked_output(&root, &["merge", "--ff-only", &branch]) {
        // Distingue "o alvo avançou desde o merge_prepare" (recuperável via
        // merge_rebase_onto_target) de um erro genérico/duro — git usa essa
        // mensagem (variações de caixa) especificamente pra ff-only recusado
        // por divergência, não por corrupção ou I/O.
        let lower = error.to_lowercase();
        let stage = if lower.contains("not possible to fast-forward") || lower.contains("non-fast-forward") {
            "branch_diverged"
        } else {
            "integration"
        };
        return Ok(MergeOutcome {
            merged: false,
            stage: stage.to_string(),
            output: error,
            ..Default::default()
        });
    }

    // Teardown: worktree + branch temporário + metadados.
    let env_arg = git_arg(&env);
    let _ = git_command(&root, &["worktree", "remove", "--force", &env_arg]);
    let _ = git_command(&root, &["branch", "-d", &branch]);
    let _ = std::fs::remove_file(meta_path(&root, &env_id));

    emit(
        "MergeMerged",
        &meta,
        serde_json::json!({ "source": meta.source, "target": meta.target }),
    );

    // Grafo é conhecimento versionado: snapshot automático pós-integração
    // (best-effort — sem grafo no repo, só ignora). Amarra RFC-004 ↔ RFC-006.
    let _ = crate::graphify::graphify_snapshot_inner(
        root.to_string_lossy().into_owned(),
        meta.project_id.clone(),
    );

    Ok(MergeOutcome {
        merged: true,
        stage: "merged".to_string(),
        output: message,
        contract_warnings,
    })
}

/// `git merge --abort`/`git rebase --abort` no worktree efêmero são no-ops
/// esperados quando nada está em progresso — só propaga erros que indiquem
/// algo realmente errado (incluindo lock administrativo, via `checked_output`
/// já lock-aware).
fn safe_abort(env: &Path, args: &[&str]) -> Result<(), String> {
    match checked_output(env, args) {
        Ok(_) => Ok(()),
        Err(error) => {
            let lower = error.to_lowercase();
            if lower.contains("no merge") || lower.contains("no rebase") {
                Ok(())
            } else {
                Err(error)
            }
        }
    }
}

/// Abort preventivo chamado pelo "Retry Manual" do front antes de reprocessar
/// um merge em `Failed`: limpa qualquer merge/rebase inacabado no worktree
/// EFÊMERO (nunca o do usuário). Erro que não seja lock administrativo aqui
/// indica corrupção real do ambiente — o front trata como `TerminalError`.
#[tauri::command]
pub async fn merge_preflight_abort(repo: String, env_id: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || merge_preflight_abort_inner(repo, env_id))
        .await
        .map_err(|error| format!("merge_preflight_abort: falha na task bloqueante: {error}"))?
}

pub(crate) fn merge_preflight_abort_inner(repo: String, env_id: String) -> Result<(), String> {
    let root = repository_root(&repo)?;
    validate_env_id(&env_id)?;
    let env = env_dir(&root, &env_id);
    if !env.is_dir() {
        return Err("merge_env_not_found".to_string());
    }
    safe_abort(&env, &["merge", "--abort"])?;
    safe_abort(&env, &["rebase", "--abort"])?;
    Ok(())
}

/// Chamado quando `merge_finalize` reporta `stage == "branch_diverged"`: o
/// branch alvo avançou desde o `merge_prepare`. Traz a ponta atual do alvo pro
/// worktree EFÊMERO (fetch local, sem tocar o worktree do usuário) e reconcilia
/// via `git merge` (não rebase) — a branch efêmera já tem um commit de merge
/// formado (feito em `merge_finalize`), e fazer REBASE de um commit de merge é
/// um patch-replay que pode gerar conflitos espúrios mesmo quando um merge de
/// árvore normal aplicaria limpo. Resultado prático é equivalente ao que o
/// usuário chamaria de "RebaseAttempt": a ponta nova do alvo passa a ser
/// ancestral da branch efêmera, o que já é suficiente pro `--ff-only` da
/// reintegração funcionar.
///
/// - Reconciliação limpa → `stage: "rebase_ok"`, pronto pro front chamar
///   `merge_finalize` de novo.
/// - Conflitos → reescreve `ALETHE_CONFLICT.md`/metadados com os novos
///   arquivos em conflito e devolve `stage: "rebase_conflict"` — mesma
///   superfície de "resolver" de antes, front volta a `resolving`.
/// - Falha dura (não-conflito) → aborta e devolve `stage: "rebase_failed"`.
#[tauri::command]
pub async fn merge_rebase_onto_target(repo: String, env_id: String) -> Result<MergeOutcome, String> {
    tokio::task::spawn_blocking(move || merge_rebase_onto_target_inner(repo, env_id))
        .await
        .map_err(|error| format!("merge_rebase_onto_target: falha na task bloqueante: {error}"))?
}

pub(crate) fn merge_rebase_onto_target_inner(repo: String, env_id: String) -> Result<MergeOutcome, String> {
    let root = repository_root(&repo)?;
    validate_env_id(&env_id)?;
    let env = env_dir(&root, &env_id);
    if !env.is_dir() {
        return Err("merge_env_not_found".to_string());
    }
    let meta = read_meta(&root, &env_id)?;

    let root_arg = git_arg(&root);
    checked_output(&env, &["fetch", &root_arg, &meta.target])?;

    let reconcile = git_command(&env, &["merge", "--no-edit", "FETCH_HEAD"])?;
    if reconcile.status.success() {
        return Ok(MergeOutcome {
            merged: false,
            stage: "rebase_ok".to_string(),
            output: "Reconciliado com o alvo atualizado — pronto para reintegrar.".to_string(),
            ..Default::default()
        });
    }

    let unresolved = unmerged_files(&env).unwrap_or_default();
    if !unresolved.is_empty() {
        // Conflitos: mesma superfície de resolução de antes — regrava o prompt
        // e os metadados com os novos arquivos em conflito.
        let conflicts: Vec<ConflictFile> = unresolved
            .into_iter()
            .map(|path| ConflictFile {
                class: classify_path(&path),
                path,
            })
            .collect();
        let prompt_path = env.join(PROMPT_FILE);
        let _ = std::fs::write(&prompt_path, build_prompt(&meta, &conflicts));
        let updated_meta = MergeMeta {
            conflict_paths: conflicts.iter().map(|c| c.path.clone()).collect(),
            ..meta
        };
        if let Ok(body) = serde_json::to_string_pretty(&updated_meta) {
            let _ = std::fs::write(meta_path(&root, &env_id), body);
        }
        let paths = conflicts.iter().map(|c| c.path.as_str()).collect::<Vec<_>>().join(", ");
        return Ok(MergeOutcome {
            merged: false,
            stage: "rebase_conflict".to_string(),
            output: format!("Conflitos ao reconciliar com o alvo atualizado: {paths}"),
            ..Default::default()
        });
    }

    // Falha dura (não-conflito): aborta pra não deixar o ambiente efêmero num
    // merge pendurado, e propaga a mensagem real do git.
    let stderr = String::from_utf8_lossy(&reconcile.stderr).trim().to_string();
    let _ = git_command(&env, &["merge", "--abort"]);
    Ok(MergeOutcome {
        merged: false,
        stage: "rebase_failed".to_string(),
        output: if stderr.is_empty() { "rebase_failed".to_string() } else { stderr },
        ..Default::default()
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForceCleanupResult {
    pub deleted: bool,
    pub pruned: bool,
}

/// Limpeza bruta de um ambiente de merge irrecuperável (`TerminalError`, quando
/// o abort preventivo já falhou por corrupção real). Deleção física direta do
/// diretório (double-checked pra nunca sair de `.alethe/merge-envs/`) seguida
/// de `git worktree prune` best-effort. O front decide `pruneOnly` vs
/// `requiresRawDeletion` com base em `deleted`/`pruned`.
#[tauri::command]
pub async fn merge_force_cleanup(repo: String, env_id: String) -> Result<ForceCleanupResult, String> {
    tokio::task::spawn_blocking(move || merge_force_cleanup_inner(repo, env_id))
        .await
        .map_err(|error| format!("merge_force_cleanup: falha na task bloqueante: {error}"))?
}

pub(crate) fn merge_force_cleanup_inner(repo: String, env_id: String) -> Result<ForceCleanupResult, String> {
    let root = repository_root(&repo)?;
    validate_env_id(&env_id)?;
    let envs_base = merge_envs_dir(&root);
    let env = env_dir(&root, &env_id);

    let deleted = if !env.exists() {
        true
    } else {
        let canon_base = envs_base
            .canonicalize()
            .map_err(|_| "invalid_merge_env_path".to_string())?;
        let canon_env = env
            .canonicalize()
            .map_err(|_| "invalid_merge_env_path".to_string())?;
        if !canon_env.starts_with(&canon_base) {
            return Err("invalid_merge_env_path".to_string());
        }
        std::fs::remove_dir_all(&canon_env).is_ok()
    };

    let pruned = checked_output(&root, &["worktree", "prune"]).is_ok();
    let _ = std::fs::remove_file(meta_path(&root, &env_id));

    Ok(ForceCleanupResult { deleted, pruned })
}

/// Destrói o ambiente efêmero sem integrar nada.
#[tauri::command]
pub async fn merge_abort(repo: String, env_id: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || merge_abort_inner(repo, env_id))
        .await
        .map_err(|error| format!("merge_abort: falha na task bloqueante: {error}"))?
}

pub(crate) fn merge_abort_inner(repo: String, env_id: String) -> Result<(), String> {
    let root = repository_root(&repo)?;
    validate_env_id(&env_id)?;
    let env = env_dir(&root, &env_id);
    let meta = read_meta(&root, &env_id).ok();

    let env_arg = git_arg(&env);
    let _ = git_command(&root, &["worktree", "remove", "--force", &env_arg]);
    let _ = git_command(&root, &["branch", "-D", &format!("alethe/merge-{env_id}")]);
    let _ = std::fs::remove_file(meta_path(&root, &env_id));

    if let Some(meta) = meta {
        emit("MergeAborted", &meta, serde_json::json!({}));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::merge_analyzer::tests::conflicting_repo;
    use std::fs;

    // Testes chamam a lógica síncrona direto, sem precisar de runtime async —
    // os `#[tauri::command]` async acima são só wrappers finos em
    // `spawn_blocking`. Shadowing explícito vence o `use super::*` acima sem
    // conflito (regra padrão de resolução de nomes do Rust).
    use super::merge_abort_inner as merge_abort;
    use super::merge_finalize_inner as merge_finalize;
    use super::merge_force_cleanup_inner as merge_force_cleanup;
    use super::merge_prepare_inner as merge_prepare;
    use super::merge_preflight_abort_inner as merge_preflight_abort;
    use super::merge_rebase_onto_target_inner as merge_rebase_onto_target;

    #[test]
    fn full_cycle_conflict_resolution_validation_and_ff() {
        let (root, root_str) = conflicting_repo();
        // Alvo da integração: agent-a precisa estar checked out no repo.
        checked_output(&root, &["checkout", "agent-a"]).unwrap();

        let env = merge_prepare(root_str.clone(), "agent-b".into(), "agent-a".into(), None).unwrap();
        assert!(!env.clean);
        assert_eq!(env.conflicts.len(), 1);
        let env_path = PathBuf::from(&env.path);
        // Prompt de contexto mínimo existe e trava o escopo.
        let prompt = fs::read_to_string(env.prompt_path.as_ref().unwrap()).unwrap();
        assert!(prompt.contains("shared.ts"));
        assert!(prompt.contains("NUNCA implemente"));
        // O arquivo tem marcadores reais de conflito.
        let conflicted = fs::read_to_string(env_path.join("shared.ts")).unwrap();
        assert!(conflicted.contains("<<<<<<<"));

        // Finalize ANTES de resolver → barra nos marcadores, ambiente preservado.
        let blocked = merge_finalize(root_str.clone(), env.id.clone(), vec![]).unwrap();
        assert!(!blocked.merged);
        assert_eq!(blocked.stage, "conflict_markers");
        assert!(env_path.is_dir());

        // "Agente" resolve preservando as duas intenções.
        fs::write(
            env_path.join("shared.ts"),
            "export const value = 'from-a+from-b'\n",
        )
        .unwrap();

        // Validação que falha → merge barrado, ambiente preservado.
        let failed = merge_finalize(root_str.clone(), env.id.clone(), vec!["exit 1".into()]).unwrap();
        assert!(!failed.merged);
        assert!(failed.stage.starts_with("validation:"));
        assert!(env_path.is_dir());

        // Validação que passa → commit + ff no agent-a + teardown.
        let ok = merge_finalize(root_str.clone(), env.id.clone(), vec!["echo ok".into()]).unwrap();
        assert!(ok.merged, "esperava merge, veio: {} / {}", ok.stage, ok.output);
        assert!(!env_path.exists());
        let merged = fs::read_to_string(root.join("shared.ts")).unwrap();
        assert!(merged.contains("from-a+from-b"));
        // other.rs veio da branch B junto no merge.
        let other = fs::read_to_string(root.join("other.rs")).unwrap();
        assert!(other.contains("from_b"));
        // ALETHE_CONFLICT.md (o prompt efêmero) nunca pode vazar pro commit
        // final — regressão real: `git add -A` estagiava o arquivo ANTES dele
        // ser removido do disco, então apagar depois não desfazia o stage e
        // ele entrava no commit mesmo assim (corrigido: remoção agora vem
        // antes do `add -A`).
        assert!(!root.join("ALETHE_CONFLICT.md").exists());
        // Branch temporário removido.
        let branches = checked_output(&root, &["branch", "--list", "alethe/merge-*"]).unwrap();
        assert!(String::from_utf8_lossy(&branches.stdout).trim().is_empty());

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn clean_merge_skips_agent_and_integrates() {
        let (root, root_str) = conflicting_repo();
        // main é ancestral de agent-a → merge limpo direto.
        let env = merge_prepare(root_str.clone(), "agent-a".into(), "main".into(), None).unwrap();
        assert!(env.clean);
        assert!(env.prompt_path.is_none());
        let ok = merge_finalize(root_str.clone(), env.id, vec!["echo ok".into()]).unwrap();
        assert!(ok.merged, "esperava merge, veio: {} / {}", ok.stage, ok.output);
        let value = fs::read_to_string(root.join("shared.ts")).unwrap();
        assert!(value.contains("from-a"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn preflight_abort_is_a_safe_noop_when_nothing_in_progress() {
        let (root, root_str) = conflicting_repo();
        let env = merge_prepare(root_str.clone(), "agent-b".into(), "agent-a".into(), None).unwrap();
        // Nada em progresso — não deve falhar mesmo sem merge/rebase pendente.
        merge_preflight_abort(root_str.clone(), env.id.clone()).unwrap();
        merge_abort(root_str, env.id).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rebase_onto_target_recovers_from_concurrent_commit_on_target() {
        let (root, root_str) = conflicting_repo();
        checked_output(&root, &["checkout", "agent-a"]).unwrap();

        // Conflito normal entre agent-b e agent-a, como no ciclo completo.
        let env = merge_prepare(root_str.clone(), "agent-b".into(), "agent-a".into(), None).unwrap();
        assert!(!env.clean);
        let env_path = PathBuf::from(&env.path);

        // "Agente" resolve preservando as duas intenções.
        fs::write(
            env_path.join("shared.ts"),
            "export const value = 'from-a+from-b'\n",
        )
        .unwrap();

        // Commit CONCORRENTE em agent-a (o alvo) — simula outra integração que
        // avançou a branch enquanto o merge estava em andamento. Precisa estar
        // em um arquivo diferente pra não gerar conflito de rebase também.
        fs::write(root.join("concurrent.txt"), "commit concorrente\n").unwrap();
        checked_output(&root, &["add", "concurrent.txt"]).unwrap();
        checked_output(&root, &["commit", "-m", "commit concorrente"]).unwrap();

        // Finalize agora falha por divergência, não por marcador/validação.
        let diverged = merge_finalize(root_str.clone(), env.id.clone(), vec!["echo ok".into()]).unwrap();
        assert!(!diverged.merged);
        assert_eq!(diverged.stage, "branch_diverged");
        assert!(env_path.is_dir(), "ambiente deve ser preservado pra retry");

        // Abort preventivo (Retry Manual) — nada em progresso ainda, no-op ok.
        merge_preflight_abort(root_str.clone(), env.id.clone()).unwrap();

        // Rebase sobre a nova ponta do alvo — sem conflito (arquivo diferente).
        let rebased = merge_rebase_onto_target(root_str.clone(), env.id.clone()).unwrap();
        assert_eq!(rebased.stage, "rebase_ok", "saída: {}", rebased.output);

        // Reintegra — agora o ff-only deve funcionar.
        let ok = merge_finalize(root_str.clone(), env.id.clone(), vec!["echo ok".into()]).unwrap();
        assert!(ok.merged, "esperava merge, veio: {} / {}", ok.stage, ok.output);

        // Asserção crítica: o commit concorrente está presente no alvo final.
        assert!(root.join("concurrent.txt").is_file());
        let merged = fs::read_to_string(root.join("shared.ts")).unwrap();
        assert!(merged.contains("from-a+from-b"));

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn force_cleanup_deletes_and_prunes_then_is_idempotent() {
        let (root, root_str) = conflicting_repo();
        let env = merge_prepare(root_str.clone(), "agent-b".into(), "agent-a".into(), None).unwrap();
        let env_path = PathBuf::from(&env.path);
        assert!(env_path.is_dir());

        let result = merge_force_cleanup(root_str.clone(), env.id.clone()).unwrap();
        assert!(result.deleted);
        assert!(result.pruned);
        assert!(!env_path.exists());

        // Rodar de novo (pasta já sumiu) continua reportando sucesso — é
        // exatamente o cenário `pruneOnly` que o front cataloga como órfão.
        let again = merge_force_cleanup(root_str.clone(), env.id).unwrap();
        assert!(again.deleted);

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn abort_destroys_environment() {
        let (root, root_str) = conflicting_repo();
        let env = merge_prepare(root_str.clone(), "agent-b".into(), "agent-a".into(), None).unwrap();
        let env_path = PathBuf::from(&env.path);
        assert!(env_path.is_dir());
        merge_abort(root_str.clone(), env.id.clone()).unwrap();
        assert!(!env_path.exists());
        // Id forjado é rejeitado.
        assert!(merge_abort(root_str, "../evil".into()).is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
