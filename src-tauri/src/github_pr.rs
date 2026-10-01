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

fn gh_output(command: &mut Command) -> Result<String, String> {
    crate::git_control::hide_console(command);
    let output = command.output().map_err(|error| {
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

fn gh_command(repo: &str, args: &[&str]) -> Result<String, String> {
    let mut command = Command::new("gh");
    command.current_dir(repo).args(args);
    gh_output(&mut command)
}

/// Same as `gh_command`, but for subcommands that don't resolve a repo from cwd
/// (e.g. `gh search prs`, which queries the GitHub search API directly against
/// the authenticated account) — no `current_dir` needed.
fn gh_command_global(args: &[&str]) -> Result<String, String> {
    let mut command = Command::new("gh");
    command.args(args);
    gh_output(&mut command)
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhRepoPullRequest {
    number: u64,
    title: String,
    url: String,
    author: GhAuthor,
    is_draft: bool,
    updated_at: String,
}

/// `gh pr list` does not offer a `repository` field, so the name comes from the
/// pull request URL instead of a second `gh` call.
fn repo_from_pr_url(url: &str) -> String {
    let path = url.split_once("://").map_or(url, |(_, rest)| rest);
    let mut segments = path.split('/').skip(1);
    match (segments.next(), segments.next()) {
        (Some(owner), Some(name)) if !owner.is_empty() && !name.is_empty() => {
            format!("{owner}/{name}")
        }
        _ => String::new(),
    }
}

impl From<GhRepoPullRequest> for MyPullRequestSummary {
    fn from(value: GhRepoPullRequest) -> Self {
        Self {
            number: value.number,
            title: value.title,
            repo: repo_from_pr_url(&value.url),
            url: value.url,
            author: value.author.login,
            is_draft: value.is_draft,
            updated_at: value.updated_at,
        }
    }
}

/// Open PRs of the selected project's repository. Without a repo — no project
/// open, or one that is not a checkout — it falls back to every open PR the
/// authenticated `gh` user is involved in, across every repo they can see.
#[tauri::command]
pub fn github_pr_list_mine(repo: Option<String>) -> Result<Vec<MyPullRequestSummary>, String> {
    let scoped = repo.unwrap_or_default();
    let scoped = scoped.trim();
    if !scoped.is_empty() {
        let raw = gh_command(
            scoped,
            &[
                "pr",
                "list",
                "--state",
                "open",
                "--limit",
                "50",
                "--json",
                "number,title,url,author,isDraft,updatedAt",
            ],
        )?;
        let prs: Vec<GhRepoPullRequest> = serde_json::from_str(&raw)
            .map_err(|error| format!("github_pr_parse_failed:{error}"))?;
        return Ok(prs.into_iter().map(Into::into).collect());
    }

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_owner_and_name_from_a_pull_request_url() {
        assert_eq!(
            repo_from_pr_url("https://github.com/Kc1t/alethe-agents/pull/42"),
            "Kc1t/alethe-agents"
        );
    }

    #[test]
    fn answers_empty_for_a_url_without_a_repository_path() {
        assert_eq!(repo_from_pr_url("https://github.com/"), "");
        assert_eq!(repo_from_pr_url(""), "");
    }
}
