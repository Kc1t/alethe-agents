use serde::{Deserialize, Serialize};
use std::process::Command;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhAuthor {
    login: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhPullRequest {
    number: u64,
    title: String,
    body: Option<String>,
    url: String,
    base_ref_name: String,
    head_ref_name: String,
    head_ref_oid: String,
    merge_state_status: String,
    is_draft: bool,
    author: GhAuthor,
    review_decision: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestSummary {
    pub number: u64,
    pub title: String,
    pub body: String,
    pub url: String,
    pub base_branch: String,
    pub head_branch: String,
    pub head_sha: String,
    pub merge_state: String,
    pub is_draft: bool,
    pub author: String,
    pub review_decision: Option<String>,
}

impl From<GhPullRequest> for PullRequestSummary {
    fn from(value: GhPullRequest) -> Self {
        Self {
            number: value.number,
            title: value.title,
            body: value.body.unwrap_or_default(),
            url: value.url,
            base_branch: value.base_ref_name,
            head_branch: value.head_ref_name,
            head_sha: value.head_ref_oid,
            merge_state: value.merge_state_status,
            is_draft: value.is_draft,
            author: value.author.login,
            review_decision: value.review_decision,
        }
    }
}

fn gh_command(repo: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new("gh")
        .current_dir(repo)
        .args(args)
        .output()
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                "gh_not_found: install the GitHub CLI and run gh auth login".to_string()
            } else {
                format!("gh_exec_failed:{error}")
            }
        })?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "github_command_failed".to_string()
        } else {
            format!("github_command_failed:{stderr}")
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Same as `gh_command`, but for subcommands that don't resolve a repo from cwd
/// (e.g. `gh search prs`, which queries the GitHub search API directly against
/// the authenticated account) — no `current_dir` needed.
fn gh_command_global(args: &[&str]) -> Result<String, String> {
    let output = Command::new("gh").args(args).output().map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            "gh_not_found: install the GitHub CLI and run gh auth login".to_string()
        } else {
            format!("gh_exec_failed:{error}")
        }
    })?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "github_command_failed".to_string()
        } else {
            format!("github_command_failed:{stderr}")
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhRepositoryRef {
    name_with_owner: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhSearchPullRequest {
    number: u64,
    title: String,
    url: String,
    repository: GhRepositoryRef,
    author: GhAuthor,
    is_draft: bool,
    updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MyPullRequestSummary {
    pub number: u64,
    pub title: String,
    pub url: String,
    pub repo: String,
    pub author: String,
    pub is_draft: bool,
    pub updated_at: String,
}

impl From<GhSearchPullRequest> for MyPullRequestSummary {
    fn from(value: GhSearchPullRequest) -> Self {
        Self {
            number: value.number,
            title: value.title,
            url: value.url,
            repo: value.repository.name_with_owner,
            author: value.author.login,
            is_draft: value.is_draft,
            updated_at: value.updated_at,
        }
    }
}

/// PRs the authenticated `gh` user is involved in (author, assignee, mentioned,
/// commented, or review-requested) across every repo they can see — not limited
/// to repos registered as Alethe projects.
#[tauri::command]
pub fn github_pr_list_mine() -> Result<Vec<MyPullRequestSummary>, String> {
    let raw = gh_command_global(&[
        "search",
        "prs",
        "--involves=@me",
        "--state",
        "open",
        "--json",
        "number,title,url,repository,author,isDraft,updatedAt",
    ])?;
    let prs: Vec<GhSearchPullRequest> =
        serde_json::from_str(&raw).map_err(|error| format!("github_pr_parse_failed:{error}"))?;
    Ok(prs.into_iter().map(Into::into).collect())
}

fn pr_json_fields() -> &'static str {
    "number,title,body,url,baseRefName,headRefName,headRefOid,mergeStateStatus,isDraft,author,reviewDecision"
}

#[tauri::command]
pub fn github_pr_find(
    repo: String,
    head_branch: String,
) -> Result<Vec<PullRequestSummary>, String> {
    let raw = gh_command(
        &repo,
        &[
            "pr",
            "list",
            "--head",
            &head_branch,
            "--state",
            "open",
            "--limit",
            "10",
            "--json",
            pr_json_fields(),
        ],
    )?;
    let prs: Vec<GhPullRequest> =
        serde_json::from_str(&raw).map_err(|error| format!("github_pr_parse_failed:{error}"))?;
    Ok(prs.into_iter().map(Into::into).collect())
}

#[tauri::command]
pub fn github_pr_merge(
    repo: String,
    number: u64,
    method: String,
    expected_head_sha: Option<String>,
) -> Result<String, String> {
    let flag = match method.as_str() {
        "merge" => "--merge",
        "rebase" => "--rebase",
        _ => "--squash",
    };
    let number_arg = number.to_string();
    let mut args = vec![
        "pr",
        "merge",
        number_arg.as_str(),
        flag,
        "--delete-branch=false",
    ];
    let sha_arg = expected_head_sha.filter(|sha| !sha.trim().is_empty());
    if let Some(sha) = sha_arg.as_deref() {
        args.extend(["--match-head-commit", sha]);
    }
    gh_command(&repo, &args)
}
