//! RFC-006 — Merge Analyzer + Conflict Classifier.
//!
//! Primeiro estágio do ciclo de merge seguro: **quem decide se existe conflito é
//! este módulo**, nunca o agente. O ensaio de merge acontece num worktree
//! temporário e descartável (`.alethe/merge-envs/analyze-<id>`), então o
//! working tree do usuário NUNCA é tocado.
//!
//! Fluxo (blueprint):
//! `Agent A/B done → Merge Analyzer → conflito? ─não→ Validation → Merge
//!                                        └sim→ Classifier → skill → Resolution Agent`
//!
//! O Classifier mapeia cada arquivo em conflito para uma classe (Rust, TS, UI,
//! Cargo, Package, JSON, Config, Asset, Planning, Graph, Other) e cada classe
//! carrega uma estratégia — é isso que o Conflict Resolution Agent (RFC-007)
//! recebe como contexto mínimo.

use serde::Serialize;
use std::path::{Path, PathBuf};

use crate::git_control::{checked_output, git_command, repository_root};
use crate::worktrees::git_arg;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ConflictClass {
    Rust,
    TypeScript,
    Ui,
    Cargo,
    Package,
    Json,
    Config,
    Asset,
    Planning,
    /// Sentinel de estado efêmero de máquina (ex.: `.gsd-child-session`) — um
    /// valor opaco (ID de sessão, flag de ocupado), não prosa mesclável.
    Sentinel,
    Graph,
    Other,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictFile {
    pub path: String,
    pub class: ConflictClass,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeAnalysis {
    pub clean: bool,
    pub source: String,
    pub target: String,
    pub conflicts: Vec<ConflictFile>,
    pub classes: Vec<ConflictClass>,
}

/// Classifica pelo caminho/extensão. Lockfiles e manifests têm classe própria
/// porque a estratégia de resolução é diferente de código (ex.: regenerar
/// lockfile em vez de editar na mão).
pub fn classify_path(path: &str) -> ConflictClass {
    let normalized = path.replace('\\', "/");
    let lower = normalized.to_lowercase();
    let file_name = lower.rsplit('/').next().unwrap_or(&lower).to_string();

    // Sentinels de estado efêmero de máquina do GSD Sync (ID de sessão, flag
    // de ocupado, mensagem de erro) — checado ANTES do fallback genérico de
    // `.planning/`: são valores opacos de uma linha só, sem "intenção" de
    // duas branches pra preservar. Confirmado ao vivo: tratar como
    // `Planning` ("preserve o histórico das duas branches") levava o agente
    // a colar os dois valores com marcador de conflito de verdade dentro do
    // arquivo — que depois era lido cru como se fosse um ID de sessão válido
    // (`--session <<<<<<< HEAD\nses_...\n=======\n...`), quebrando o spawn.
    if file_name == ".gsd-child-session"
        || file_name == ".gsd-child-busy"
        || file_name == ".gsd-child-error"
    {
        return ConflictClass::Sentinel;
    }
    if lower.starts_with(".planning/") || lower.contains("/.planning/") {
        return ConflictClass::Planning;
    }
    if lower.starts_with("graphify-out/") || lower.contains("/graphify-out/") {
        return ConflictClass::Graph;
    }
    match file_name.as_str() {
        "cargo.toml" | "cargo.lock" => return ConflictClass::Cargo,
        "package.json" | "package-lock.json" | "yarn.lock" | "pnpm-lock.yaml" => {
            return ConflictClass::Package
        }
        _ => {}
    }

    let ext = file_name.rsplit('.').next().unwrap_or_default().to_string();
    match ext.as_str() {
        "rs" => ConflictClass::Rust,
        "ts" | "tsx" | "js" | "jsx" | "mts" | "cts" => ConflictClass::TypeScript,
        "css" | "scss" | "less" => ConflictClass::Ui,
        "json" => ConflictClass::Json,
        "toml" | "yml" | "yaml" | "ini" | "conf" | "env" | "properties" => ConflictClass::Config,
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "ico" | "ttf" | "otf" | "woff"
        | "woff2" | "mp3" | "mp4" | "bin" => ConflictClass::Asset,
        _ => ConflictClass::Other,
    }
}

/// Estratégia (texto) por classe — vira parte do contexto mínimo do Resolution
/// Agent. Mantido aqui para o Classifier e o prompt nunca divergirem.
pub fn class_strategy(class: ConflictClass) -> &'static str {
    match class {
        ConflictClass::Rust => {
            "Código Rust: preserve as duas intenções; após resolver, o código deve compilar (cargo check)."
        }
        ConflictClass::TypeScript => {
            "Código TypeScript/JS: preserve as duas intenções; imports/exports duplicados são a causa comum; tsc deve passar."
        }
        ConflictClass::Ui => {
            "Estilos: una as regras das duas branches; nunca invente cores novas — use os tokens de tema existentes."
        }
        ConflictClass::Cargo => {
            "Cargo.toml/lock: una as dependências das duas branches; em conflito de Cargo.lock prefira regenerar (cargo update -p / cargo check) a editar na mão."
        }
        ConflictClass::Package => {
            "package.json/lockfile: una as dependências; em conflito de lockfile prefira regenerar (npm install) a editar na mão."
        }
        ConflictClass::Json => {
            "JSON: resultado precisa ser JSON válido; una as chaves das duas branches; atenção a vírgulas."
        }
        ConflictClass::Config => {
            "Configuração: una as entradas; em chaves duplicadas com valores diferentes, entenda a intenção de cada branch antes de escolher."
        }
        ConflictClass::Asset => {
            "Binário/asset: não há merge textual — escolha a versão correta (geralmente a mais nova) via git checkout --theirs/--ours."
        }
        ConflictClass::Planning => {
            "Planejamento (.planning/): preserve o histórico das duas branches; nunca descarte tarefas de nenhum lado."
        }
        ConflictClass::Sentinel => {
            "Estado efêmero de máquina do GSD Sync (ID de sessão, flag de ocupado/erro) — NÃO é conteúdo pra mesclar, é um valor opaco de uma linha só. NUNCA cole os dois valores nem deixe qualquer marcador de conflito (<<<<<<<, =======, >>>>>>>) no arquivo. Resolva apagando o arquivo por completo (ele é recriado sozinho no próximo ciclo do GSD Sync) — nunca escolha um valor 'no meio termo'."
        }
        ConflictClass::Graph => {
            "Grafo (graphify-out/): não resolva na mão — o grafo é gerado; escolha qualquer lado e regenere com o Graphify depois."
        }
        ConflictClass::Other => {
            "Preserve as duas intenções; se não tiver certeza, mantenha os dois trechos e sinalize no commit."
        }
    }
}

fn ensure_branch(root: &Path, branch: &str) -> Result<(), String> {
    let ok = git_command(
        root,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("refs/heads/{branch}"),
        ],
    )
    .map(|o| o.status.success())
    .unwrap_or(false);
    if ok {
        Ok(())
    } else {
        Err(format!("branch_not_found:{branch}"))
    }
}

pub(crate) fn merge_envs_dir(root: &Path) -> PathBuf {
    root.join(".alethe").join("merge-envs")
}

/// Lista os paths não-mergeados (`--diff-filter=U`) de um worktree em conflito.
pub(crate) fn unmerged_files(dir: &Path) -> Result<Vec<String>, String> {
    let output = checked_output(dir, &["diff", "--name-only", "--diff-filter=U", "-z"])?;
    Ok(String::from_utf8_lossy(&output.stdout)
        .split('\0')
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .collect())
}

/// Ensaio de merge `source → target` num worktree descartável. Nunca toca o
/// working tree do usuário. Publica `MergeClean`/`MergeConflict` no Event Bus.
#[tauri::command]
pub fn merge_analyze(
    repo: String,
    source: String,
    target: String,
    project_id: Option<String>,
) -> Result<MergeAnalysis, String> {
    let root = repository_root(&repo)?;
    ensure_branch(&root, &source)?;
    ensure_branch(&root, &target)?;

    let envs = merge_envs_dir(&root);
    std::fs::create_dir_all(&envs).map_err(|e| format!("mkdir_failed:{e}"))?;
    let env = envs.join(format!("analyze-{}", nanoid::nanoid!(8)));
    let env_arg = git_arg(&env);

    // Worktree detached no target: o ensaio acontece aqui dentro.
    checked_output(&root, &["worktree", "add", "--detach", &env_arg, &target])?;

    let merge = git_command(&env, &["merge", "--no-commit", "--no-ff", &source])?;
    let clean = merge.status.success();
    let conflicts = if clean {
        Vec::new()
    } else {
        unmerged_files(&env)?
            .into_iter()
            .map(|path| ConflictFile {
                class: classify_path(&path),
                path,
            })
            .collect::<Vec<_>>()
    };

    // Teardown do ensaio (abort é best-effort: merge limpo sem commit também
    // deixa estado staged que o worktree remove --force descarta).
    let _ = git_command(&env, &["merge", "--abort"]);
    let _ = git_command(&root, &["worktree", "remove", "--force", &env_arg]);

    let mut classes: Vec<ConflictClass> = conflicts.iter().map(|c| c.class).collect();
    classes.sort_by_key(|c| format!("{c:?}"));
    classes.dedup();

    crate::event_bus::publish_event_simple(
        if clean { "MergeClean" } else { "MergeConflict" },
        &format!("merge-{}", nanoid::nanoid!()),
        project_id,
        None,
        serde_json::json!({
            "source": source,
            "target": target,
            "conflict_count": conflicts.len(),
            "classes": classes.iter().map(|c| format!("{c:?}")).collect::<Vec<_>>(),
        }),
    );

    Ok(MergeAnalysis {
        clean,
        source,
        target,
        conflicts,
        classes,
    })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn classifies_by_extension_and_special_paths() {
        assert_eq!(classify_path("src-tauri/src/pty.rs"), ConflictClass::Rust);
        assert_eq!(classify_path("src/lib/tauri.ts"), ConflictClass::TypeScript);
        assert_eq!(classify_path("src/App.module.css"), ConflictClass::Ui);
        assert_eq!(classify_path("src-tauri/Cargo.lock"), ConflictClass::Cargo);
        assert_eq!(classify_path("package-lock.json"), ConflictClass::Package);
        assert_eq!(classify_path("tauri.conf.json"), ConflictClass::Json);
        assert_eq!(classify_path("config/settings.yml"), ConflictClass::Config);
        assert_eq!(classify_path("assets/logo.png"), ConflictClass::Asset);
        assert_eq!(
            classify_path(".planning/roadmap.md"),
            ConflictClass::Planning
        );
        assert_eq!(
            classify_path("graphify-out/graph.json"),
            ConflictClass::Graph
        );
        assert_eq!(classify_path("README.md"), ConflictClass::Other);
        // Separador Windows também classifica.
        assert_eq!(classify_path("src\\main.rs"), ConflictClass::Rust);
    }

    pub(crate) fn conflicting_repo() -> (PathBuf, String) {
        let root = std::env::temp_dir().join(format!("alethe-merge-{}", nanoid::nanoid!(8)));
        fs::create_dir_all(&root).unwrap();
        let run = |args: &[&str]| checked_output(&root, args).unwrap();
        run(&["init", "-b", "main"]);
        run(&["config", "user.name", "Alethe Test"]);
        run(&["config", "user.email", "alethe@example.invalid"]);
        fs::write(root.join("shared.ts"), "export const value = 'base'\n").unwrap();
        fs::write(root.join("other.rs"), "fn base() {}\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "-m", "base"]);
        // Branch A muda shared.ts
        run(&["checkout", "-b", "agent-a"]);
        fs::write(root.join("shared.ts"), "export const value = 'from-a'\n").unwrap();
        run(&["commit", "-am", "a"]);
        // Branch B muda o MESMO arquivo (conflito) e o other.rs (limpo)
        run(&["checkout", "main"]);
        run(&["checkout", "-b", "agent-b"]);
        fs::write(root.join("shared.ts"), "export const value = 'from-b'\n").unwrap();
        fs::write(root.join("other.rs"), "fn from_b() {}\n").unwrap();
        run(&["commit", "-am", "b"]);
        run(&["checkout", "main"]);
        let root_str = root.to_string_lossy().into_owned();
        (root, root_str)
    }

    #[test]
    fn detects_conflict_and_clean_merges() {
        let (root, root_str) = conflicting_repo();

        // agent-a → main: limpo (main não divergiu de shared.ts base... na
        // verdade main é o ancestral, então é sempre limpo).
        let clean = merge_analyze(root_str.clone(), "agent-a".into(), "main".into(), None).unwrap();
        assert!(clean.clean);
        assert!(clean.conflicts.is_empty());

        // agent-b → agent-a: ambos mudaram shared.ts → conflito TypeScript.
        let conflicted =
            merge_analyze(root_str.clone(), "agent-b".into(), "agent-a".into(), None).unwrap();
        assert!(!conflicted.clean);
        assert_eq!(conflicted.conflicts.len(), 1);
        assert_eq!(conflicted.conflicts[0].path, "shared.ts");
        assert_eq!(conflicted.conflicts[0].class, ConflictClass::TypeScript);
        assert_eq!(conflicted.classes, vec![ConflictClass::TypeScript]);

        // O ensaio não deixa worktree para trás.
        assert!(!merge_envs_dir(&root).join("analyze").exists());
        let leftovers = fs::read_dir(merge_envs_dir(&root))
            .map(|d| d.count())
            .unwrap_or(0);
        assert_eq!(leftovers, 0);

        // Branch inexistente falha limpo.
        assert!(merge_analyze(root_str, "nope".into(), "main".into(), None).is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
