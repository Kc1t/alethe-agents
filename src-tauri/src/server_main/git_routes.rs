// Rotas HTTP pro domínio git/worktree/merge do `alethe-server` — cada
// handler é um wrapper fino chamando DIRETO a mesma função `pub async fn`
// que o app desktop usa via `#[tauri::command]` (git_control.rs/
// worktrees.rs/conflict_resolution.rs/merge_analyzer.rs/project_detector.rs/
// contract_check.rs/health_probe.rs) — nenhuma dessas funções depende de
// `tauri::AppHandle`/`State`/`Window`, então dá pra reaproveitar 100% da
// lógica sem duplicar nada, ao contrário de PTY/perfis (que dependem do
// runtime do Tauri pra emitir evento/resolver diretório de dados).

use crate::conflict_resolution;
use crate::contract_check;
use crate::git_control;
use crate::health_probe;
use crate::merge_analyzer;
use crate::project_detector;
use crate::worktrees::{self, WorktreeMode};
use axum::extract::Query;
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use std::collections::HashMap;

use super::AppError;

fn q(params: &HashMap<String, String>, key: &str) -> Result<String, AppError> {
    params
        .get(key)
        .cloned()
        .ok_or_else(|| AppError::bad_request(format!("missing_query_param:{key}")))
}

pub fn router() -> Router {
    Router::new()
        .route("/api/git/status", get(git_status))
        .route("/api/git/init", post(git_init))
        .route("/api/git/stage", post(git_stage))
        .route("/api/git/diff", post(git_diff))
        .route("/api/git/unstage", post(git_unstage))
        .route("/api/git/discard", post(git_discard))
        .route("/api/git/commit", post(git_commit))
        .route("/api/git/push", post(git_push))
        .route("/api/git/pull", post(git_pull))
        .route("/api/git/branches", get(git_branches))
        .route("/api/git/clone", post(git_clone))
        .route("/api/git/diff_summary", post(git_diff_summary))
        .route("/api/git/log_graph", get(git_log_graph))
        .route("/api/git/commit_files", get(git_commit_files))
        .route("/api/git/commit_message", get(git_commit_message))
        .route("/api/git/create_branch", post(git_create_branch))
        .route("/api/git/cherry_pick", post(git_cherry_pick))
        .route("/api/git/revert", post(git_revert))
        .route("/api/git/reset", post(git_reset))
        .route("/api/git/incoming_outgoing", get(git_incoming_outgoing))
        .route("/api/git/detect_stack", get(git_detect_stack))
        .route("/api/git/contract_check", get(git_contract_check))
        .route("/api/git/health_probe", post(git_health_probe))
        .route("/api/worktree/provision", post(worktree_provision))
        .route("/api/worktree/list", get(worktree_list))
        .route("/api/worktree/remove", post(worktree_remove))
        .route("/api/worktree/cleanup", post(worktree_cleanup))
        .route("/api/worktree/fetch_branch", post(worktree_fetch_branch))
        .route(
            "/api/worktree/commit_pending",
            post(worktree_commit_pending),
        )
        .route(
            "/api/worktree/pending_changes",
            get(worktree_pending_changes),
        )
        .route(
            "/api/worktree/commit_worktree",
            post(worktree_commit_worktree),
        )
        .route("/api/worktree/lock", post(worktree_lock))
        .route("/api/worktree/unlock", post(worktree_unlock))
        .route("/api/merge/analyze", post(merge_analyze))
        .route("/api/merge/prepare", post(merge_prepare))
        .route("/api/merge/validate", post(merge_validate))
        .route("/api/merge/finalize", post(merge_finalize))
        .route("/api/merge/abort", post(merge_abort))
        .route("/api/merge/preflight_abort", post(merge_preflight_abort))
        .route("/api/merge/rebase", post(merge_rebase))
        .route("/api/merge/force_cleanup", post(merge_force_cleanup))
}

// --- git.rs ---

async fn git_status(Query(p): Query<HashMap<String, String>>) -> impl IntoResponse {
    let path = match q(&p, "path") {
        Ok(v) => v,
        Err(e) => return e.into_response(),
    };
    match git_control::git_status(path).await {
        Ok(v) => Json(v).into_response(),
        Err(e) => AppError::from(e).into_response(),
    }
}

#[derive(Deserialize)]
struct PathBody {
    path: String,
}
async fn git_init(Json(b): Json<PathBody>) -> impl IntoResponse {
    respond(git_control::git_init(b.path).await)
}

#[derive(Deserialize)]
struct RepoPathsBody {
    #[serde(rename = "repoRoot")]
    repo_root: String,
    paths: Vec<String>,
}
async fn git_stage(Json(b): Json<RepoPathsBody>) -> impl IntoResponse {
    respond(git_control::git_stage(b.repo_root, b.paths).await)
}
async fn git_unstage(Json(b): Json<RepoPathsBody>) -> impl IntoResponse {
    respond(git_control::git_unstage(b.repo_root, b.paths).await)
}

#[derive(Deserialize)]
struct GitDiffBody {
    #[serde(rename = "repoRoot")]
    repo_root: String,
    path: String,
    staged: bool,
}
async fn git_diff(Json(b): Json<GitDiffBody>) -> impl IntoResponse {
    respond(git_control::git_diff(b.repo_root, b.path, b.staged))
}

#[derive(Deserialize)]
struct GitDiscardBody {
    #[serde(rename = "repoRoot")]
    repo_root: String,
    paths: Vec<String>,
    untracked: bool,
}
async fn git_discard(Json(b): Json<GitDiscardBody>) -> impl IntoResponse {
    respond(git_control::git_discard(b.repo_root, b.paths, b.untracked).await)
}

#[derive(Deserialize)]
struct GitCommitBody {
    #[serde(rename = "repoRoot")]
    repo_root: String,
    message: String,
}
async fn git_commit(Json(b): Json<GitCommitBody>) -> impl IntoResponse {
    respond(git_control::git_commit(b.repo_root, b.message).await)
}

#[derive(Deserialize)]
struct RepoRootBody {
    #[serde(rename = "repoRoot")]
    repo_root: String,
}
async fn git_push(Json(b): Json<RepoRootBody>) -> impl IntoResponse {
    respond(git_control::git_push(b.repo_root).await)
}
async fn git_pull(Json(b): Json<RepoRootBody>) -> impl IntoResponse {
    respond(git_control::git_pull(b.repo_root).await)
}

async fn git_branches(Query(p): Query<HashMap<String, String>>) -> impl IntoResponse {
    let repo_root = match q(&p, "repoRoot") {
        Ok(v) => v,
        Err(e) => return e.into_response(),
    };
    match git_control::git_list_branches(repo_root).await {
        Ok(v) => Json(v).into_response(),
        Err(e) => AppError::from(e).into_response(),
    }
}

#[derive(Deserialize)]
struct CloneBody {
    url: String,
    #[serde(rename = "targetDir")]
    target_dir: String,
}
async fn git_clone(Json(b): Json<CloneBody>) -> impl IntoResponse {
    respond(crate::projects::clone_github_repo(b.url, b.target_dir).await)
}

#[derive(Deserialize)]
struct DiffSummaryBody {
    #[serde(rename = "repoRoot")]
    repo_root: String,
    source: String,
    target: String,
    #[serde(rename = "worktreePath")]
    worktree_path: Option<String>,
}
async fn git_diff_summary(Json(b): Json<DiffSummaryBody>) -> impl IntoResponse {
    respond(git_control::git_diff_summary(b.repo_root, b.source, b.target, b.worktree_path).await)
}

#[derive(Deserialize)]
struct LogGraphQuery {
    repo: String,
    #[serde(rename = "maxCount")]
    max_count: u32,
}
async fn git_log_graph(Query(p): Query<LogGraphQuery>) -> impl IntoResponse {
    respond(git_control::git_log_graph(p.repo, p.max_count).await)
}

async fn git_commit_files(Query(p): Query<HashMap<String, String>>) -> impl IntoResponse {
    let repo = match q(&p, "repo") {
        Ok(v) => v,
        Err(e) => return e.into_response(),
    };
    let hash = match q(&p, "hash") {
        Ok(v) => v,
        Err(e) => return e.into_response(),
    };
    match git_control::git_show_commit_files(repo, hash).await {
        Ok(v) => Json(v).into_response(),
        Err(e) => AppError::from(e).into_response(),
    }
}

async fn git_commit_message(Query(p): Query<HashMap<String, String>>) -> impl IntoResponse {
    let repo = match q(&p, "repo") {
        Ok(v) => v,
        Err(e) => return e.into_response(),
    };
    let hash = match q(&p, "hash") {
        Ok(v) => v,
        Err(e) => return e.into_response(),
    };
    match git_control::git_show_commit_message(repo, hash).await {
        Ok(v) => Json(v).into_response(),
        Err(e) => AppError::from(e).into_response(),
    }
}

#[derive(Deserialize)]
struct CreateBranchBody {
    repo: String,
    hash: String,
    #[serde(rename = "branchName")]
    branch_name: String,
}
async fn git_create_branch(Json(b): Json<CreateBranchBody>) -> impl IntoResponse {
    respond(git_control::git_create_branch_from_commit(b.repo, b.hash, b.branch_name).await)
}

#[derive(Deserialize)]
struct RepoHashBody {
    repo: String,
    hash: String,
}
async fn git_cherry_pick(Json(b): Json<RepoHashBody>) -> impl IntoResponse {
    respond(git_control::git_cherry_pick_commit(b.repo, b.hash).await)
}
async fn git_revert(Json(b): Json<RepoHashBody>) -> impl IntoResponse {
    respond(git_control::git_revert_commit(b.repo, b.hash).await)
}

#[derive(Deserialize)]
struct ResetBody {
    repo: String,
    hash: String,
    mode: String,
}
async fn git_reset(Json(b): Json<ResetBody>) -> impl IntoResponse {
    respond(git_control::git_reset_to_commit(b.repo, b.hash, b.mode).await)
}

async fn git_incoming_outgoing(Query(p): Query<HashMap<String, String>>) -> impl IntoResponse {
    let repo = match q(&p, "repo") {
        Ok(v) => v,
        Err(e) => return e.into_response(),
    };
    match git_control::git_incoming_outgoing(repo).await {
        Ok(v) => Json(v).into_response(),
        Err(e) => AppError::from(e).into_response(),
    }
}

async fn git_detect_stack(Query(p): Query<HashMap<String, String>>) -> impl IntoResponse {
    let repo = match q(&p, "repo") {
        Ok(v) => v,
        Err(e) => return e.into_response(),
    };
    match project_detector::detect_project_stack(repo) {
        Ok(v) => Json(v).into_response(),
        Err(e) => AppError::from(e).into_response(),
    }
}

async fn git_contract_check(Query(p): Query<HashMap<String, String>>) -> impl IntoResponse {
    let env_path = match q(&p, "envPath") {
        Ok(v) => v,
        Err(e) => return e.into_response(),
    };
    match contract_check::contract_check(env_path) {
        Ok(v) => Json(v).into_response(),
        Err(e) => AppError::from(e).into_response(),
    }
}

#[derive(Deserialize)]
struct HealthProbeBody {
    #[serde(rename = "envPath")]
    env_path: String,
    #[serde(rename = "startCommand")]
    start_command: String,
    path: String,
    #[serde(rename = "timeoutMs")]
    timeout_ms: u64,
}
async fn git_health_probe(Json(b): Json<HealthProbeBody>) -> impl IntoResponse {
    respond(health_probe::health_probe(b.env_path, b.start_command, b.path, b.timeout_ms).await)
}

// --- worktrees.rs ---

#[derive(Deserialize)]
struct WorktreeProvisionBody {
    repo: String,
    #[serde(rename = "agentId")]
    agent_id: String,
    mode: WorktreeMode,
}
async fn worktree_provision(Json(b): Json<WorktreeProvisionBody>) -> impl IntoResponse {
    respond(worktrees::worktree_provision(b.repo, b.agent_id, b.mode).await)
}

async fn worktree_list(Query(p): Query<HashMap<String, String>>) -> impl IntoResponse {
    let repo = match q(&p, "repo") {
        Ok(v) => v,
        Err(e) => return e.into_response(),
    };
    match worktrees::worktree_list(repo).await {
        Ok(v) => Json(v).into_response(),
        Err(e) => AppError::from(e).into_response(),
    }
}

#[derive(Deserialize)]
struct WorktreeRemoveBody {
    repo: String,
    #[serde(rename = "agentId")]
    agent_id: String,
    force: bool,
}
async fn worktree_remove(Json(b): Json<WorktreeRemoveBody>) -> impl IntoResponse {
    respond(worktrees::worktree_remove(b.repo, b.agent_id, b.force).await)
}

async fn worktree_cleanup(Json(b): Json<RepoBody>) -> impl IntoResponse {
    respond(worktrees::worktree_cleanup(b.repo).await)
}

#[derive(Deserialize)]
struct RepoBody {
    repo: String,
}

#[derive(Deserialize)]
struct RepoAgentBody {
    repo: String,
    #[serde(rename = "agentId")]
    agent_id: String,
}
async fn worktree_fetch_branch(Json(b): Json<RepoAgentBody>) -> impl IntoResponse {
    respond(worktrees::worktree_fetch_branch(b.repo, b.agent_id).await)
}
async fn worktree_commit_pending(Json(b): Json<RepoAgentBody>) -> impl IntoResponse {
    respond(worktrees::worktree_commit_pending(b.repo, b.agent_id).await)
}
async fn worktree_unlock(Json(b): Json<RepoAgentBody>) -> impl IntoResponse {
    respond(worktrees::worktree_unlock(b.repo, b.agent_id).await)
}

async fn worktree_pending_changes(Query(p): Query<HashMap<String, String>>) -> impl IntoResponse {
    let repo = match q(&p, "repo") {
        Ok(v) => v,
        Err(e) => return e.into_response(),
    };
    let agent_id = match q(&p, "agentId") {
        Ok(v) => v,
        Err(e) => return e.into_response(),
    };
    match worktrees::worktree_pending_changes(repo, agent_id).await {
        Ok(v) => Json(v).into_response(),
        Err(e) => AppError::from(e).into_response(),
    }
}

#[derive(Deserialize)]
struct WorktreeCommitWorktreeBody {
    repo: String,
    #[serde(rename = "agentId")]
    agent_id: String,
    message: String,
}
async fn worktree_commit_worktree(Json(b): Json<WorktreeCommitWorktreeBody>) -> impl IntoResponse {
    respond(worktrees::worktree_commit_worktree(b.repo, b.agent_id, b.message).await)
}

#[derive(Deserialize)]
struct WorktreeLockBody {
    repo: String,
    #[serde(rename = "agentId")]
    agent_id: String,
    reason: Option<String>,
}
async fn worktree_lock(Json(b): Json<WorktreeLockBody>) -> impl IntoResponse {
    respond(worktrees::worktree_lock(b.repo, b.agent_id, b.reason).await)
}

// --- conflict_resolution.rs / merge_analyzer.rs ---

#[derive(Deserialize)]
struct MergeAnalyzeBody {
    repo: String,
    source: String,
    target: String,
    #[serde(rename = "projectId")]
    project_id: Option<String>,
}
async fn merge_analyze(Json(b): Json<MergeAnalyzeBody>) -> impl IntoResponse {
    respond(merge_analyzer::merge_analyze(
        b.repo,
        b.source,
        b.target,
        b.project_id,
    ))
}
async fn merge_prepare(Json(b): Json<MergeAnalyzeBody>) -> impl IntoResponse {
    respond(conflict_resolution::merge_prepare(b.repo, b.source, b.target, b.project_id).await)
}

#[derive(Deserialize)]
struct MergeValidateBody {
    repo: String,
    #[serde(rename = "envId")]
    env_id: String,
    #[serde(rename = "validationCommands")]
    validation_commands: Vec<String>,
}
async fn merge_validate(Json(b): Json<MergeValidateBody>) -> impl IntoResponse {
    respond(conflict_resolution::merge_validate(b.repo, b.env_id, b.validation_commands).await)
}

#[derive(Deserialize)]
struct MergeFinalizeBody {
    repo: String,
    #[serde(rename = "envId")]
    env_id: String,
    #[serde(rename = "validationCommands")]
    validation_commands: Vec<String>,
    #[serde(rename = "healthCheckCommand")]
    health_check_command: Option<String>,
    #[serde(rename = "healthCheckPath")]
    health_check_path: Option<String>,
}
async fn merge_finalize(Json(b): Json<MergeFinalizeBody>) -> impl IntoResponse {
    respond(
        conflict_resolution::merge_finalize(
            b.repo,
            b.env_id,
            b.validation_commands,
            b.health_check_command,
            b.health_check_path,
        )
        .await,
    )
}

#[derive(Deserialize)]
struct RepoEnvBody {
    repo: String,
    #[serde(rename = "envId")]
    env_id: String,
}
async fn merge_abort(Json(b): Json<RepoEnvBody>) -> impl IntoResponse {
    respond(conflict_resolution::merge_abort(b.repo, b.env_id).await)
}
async fn merge_preflight_abort(Json(b): Json<RepoEnvBody>) -> impl IntoResponse {
    respond(conflict_resolution::merge_preflight_abort(b.repo, b.env_id).await)
}
async fn merge_rebase(Json(b): Json<RepoEnvBody>) -> impl IntoResponse {
    respond(conflict_resolution::merge_rebase_onto_target(b.repo, b.env_id).await)
}
async fn merge_force_cleanup(Json(b): Json<RepoEnvBody>) -> impl IntoResponse {
    respond(conflict_resolution::merge_force_cleanup(b.repo, b.env_id).await)
}

/// Convert the command-layer `Result<T, String>` into an HTTP response.
/// Successful values become JSON and failures use the shared `AppError` mapping.
fn respond<T: serde::Serialize>(result: Result<T, String>) -> axum::response::Response {
    match result {
        Ok(v) => Json(v).into_response(),
        Err(e) => AppError::from(e).into_response(),
    }
}
