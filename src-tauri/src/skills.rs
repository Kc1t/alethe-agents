use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;

use crate::provider_common::provider_home_dir;

const SKILL_FILE: &str = "SKILL.md";
const CODEX_SYSTEM_MARKER: &str = ".codex-system-skills.marker";
const MAX_TREE_DEPTH: usize = 4;
const MAX_TREE_CHILDREN: usize = 100;

/// Name of the cross-agent store the other roots link into. Not an agent: nothing reads it
/// directly, so a skill only reaches an agent through a link pointing here.
pub const SHARED_AGENT: &str = "shared";

/// `shared` is the cross-agent store the other roots link into, not an agent of its own.
const ROOTS: [(&str, &[&str]); 5] = [
    ("claude", &[".claude", "skills"]),
    ("codex", &[".codex", "skills"]),
    ("opencode", &[".config", "opencode", "skill"]),
    ("antigravity", &[".gemini", "skills"]),
    ("shared", &[".agents", "skills"]),
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillSummary {
    pub name: String,
    pub agent: String,
    pub path: String,
    pub resolved_path: String,
    pub description: String,
    pub linked: bool,
    pub shared: bool,
    pub bundled: bool,
    pub entry_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillAgentSnapshot {
    pub agent: String,
    pub root: Option<String>,
    pub exists: bool,
    pub skills: Vec<SkillSummary>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillNode {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub children: Vec<SkillNode>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillLockInfo {
    pub source: Option<String>,
    pub source_url: Option<String>,
    pub installed_at: Option<String>,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillDetail {
    pub summary: SkillSummary,
    pub frontmatter: BTreeMap<String, String>,
    pub frontmatter_raw: String,
    pub body: String,
    pub tree: Vec<SkillNode>,
    pub lock: Option<SkillLockInfo>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillRemoveReport {
    pub path: String,
    pub removed_link_only: bool,
    pub shared_copy_path: Option<String>,
}

fn skills_home(segments: &[&str]) -> Option<PathBuf> {
    if let Some(root) = std::env::var_os("ALETHE_MCP_HOME") {
        let base = PathBuf::from(root);
        if !base.as_os_str().is_empty() {
            return Some(segments.iter().fold(base, |acc, seg| acc.join(seg)));
        }
    }
    provider_home_dir(segments)
}

fn root_for(agent: &str) -> Option<PathBuf> {
    ROOTS
        .iter()
        .find(|(name, _)| *name == agent)
        .and_then(|(_, segments)| skills_home(segments))
}

/// Strips the Windows verbatim prefix so the path is what the user would type.
fn display_path(path: &Path) -> String {
    let text = path.to_string_lossy().to_string();
    text.strip_prefix(r"\\?\")
        .map(str::to_string)
        .unwrap_or(text)
}

fn shared_root() -> Option<PathBuf> {
    skills_home(&[".agents", "skills"])
}

fn resolve(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn is_link(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|metadata| metadata.file_type().is_symlink())
        .unwrap_or(false)
}

fn entry_count(dir: &Path) -> usize {
    fs::read_dir(dir)
        .map(|entries| entries.count())
        .unwrap_or(0)
}

fn split_frontmatter(raw: &str) -> (String, String) {
    let normalized = raw.replace("\r\n", "\n");
    let Some(rest) = normalized.strip_prefix("---\n") else {
        return (String::new(), normalized);
    };
    match rest.split_once("\n---") {
        Some((front, body)) => (
            front.to_string(),
            body.trim_start_matches('\n').trim_start().to_string(),
        ),
        None => (String::new(), normalized),
    }
}

fn unquote(value: &str) -> String {
    let trimmed = value.trim();
    for quote in ['"', '\''] {
        if trimmed.len() >= 2 && trimmed.starts_with(quote) && trimmed.ends_with(quote) {
            return trimmed[1..trimmed.len() - 1].to_string();
        }
    }
    trimmed.to_string()
}

/// Handles the shapes actually present in installed skills: plain scalars, quoted
/// scalars, folded/literal blocks and nested maps kept as their raw text.
fn parse_frontmatter(front: &str) -> BTreeMap<String, String> {
    let lines: Vec<&str> = front.lines().collect();
    let mut out = BTreeMap::new();
    let mut index = 0;

    while index < lines.len() {
        let line = lines[index];
        index += 1;
        if line.trim().is_empty() || line.starts_with([' ', '\t', '#', '-']) {
            continue;
        }
        let Some((key, rest)) = line.split_once(':') else {
            continue;
        };
        let key = key.trim().to_string();
        let rest = rest.trim();

        let mut block: Vec<String> = Vec::new();
        if rest.is_empty() || rest.starts_with('>') || rest.starts_with('|') {
            while index < lines.len() {
                let next = lines[index];
                if next.trim().is_empty() {
                    index += 1;
                    continue;
                }
                if !next.starts_with([' ', '\t']) {
                    break;
                }
                block.push(next.trim().to_string());
                index += 1;
            }
        }

        let value = if block.is_empty() {
            unquote(rest)
        } else if rest.starts_with('|') {
            block.join("\n")
        } else {
            block.join(" ")
        };
        out.insert(key, value);
    }
    out
}

fn read_skill_file(dir: &Path) -> Option<String> {
    fs::read_to_string(dir.join(SKILL_FILE)).ok()
}

fn has_bundled_marker(dir: &Path, root: &Path) -> bool {
    let mut cursor = Some(dir);
    while let Some(current) = cursor {
        if current.join(CODEX_SYSTEM_MARKER).is_file() {
            return true;
        }
        if current == root {
            break;
        }
        cursor = current.parent();
    }
    false
}

fn summarize(agent: &str, root: &Path, dir: &Path, bundled: bool) -> Option<SkillSummary> {
    let raw = read_skill_file(dir)?;
    let (front, _) = split_frontmatter(&raw);
    let fields = parse_frontmatter(&front);
    let resolved = resolve(dir);
    let shared = shared_root()
        .map(|shared| resolved.starts_with(resolve(&shared)))
        .unwrap_or(false);

    Some(SkillSummary {
        name: dir
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_default(),
        agent: agent.to_string(),
        path: display_path(dir),
        resolved_path: display_path(&resolved),
        description: fields.get("description").cloned().unwrap_or_default(),
        linked: is_link(dir),
        shared: shared && agent != "shared",
        bundled: bundled || has_bundled_marker(dir, root),
        entry_count: entry_count(dir),
    })
}

fn collect_root(agent: &str, root: &Path) -> Vec<SkillSummary> {
    let Ok(entries) = fs::read_dir(root) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if name == ".system" {
            if let Ok(bundled) = fs::read_dir(&path) {
                for nested in bundled.flatten() {
                    let nested_path = nested.path();
                    if nested_path.is_dir() {
                        if let Some(summary) = summarize(agent, root, &nested_path, true) {
                            out.push(summary);
                        }
                    }
                }
            }
            continue;
        }
        if name.starts_with('.') {
            continue;
        }
        if let Some(summary) = summarize(agent, root, &path, false) {
            out.push(summary);
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

fn scan_inner() -> Vec<SkillAgentSnapshot> {
    ROOTS
        .iter()
        .map(|(agent, segments)| {
            let root = skills_home(segments);
            let exists = root.as_ref().map(|path| path.is_dir()).unwrap_or(false);
            let skills = match (&root, exists) {
                (Some(path), true) => collect_root(agent, path),
                _ => Vec::new(),
            };
            SkillAgentSnapshot {
                agent: agent.to_string(),
                root: root.as_deref().map(display_path),
                exists,
                skills,
            }
        })
        .collect()
}

fn build_tree(dir: &Path, depth: usize) -> Vec<SkillNode> {
    if depth >= MAX_TREE_DEPTH {
        return Vec::new();
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut items: Vec<PathBuf> = entries.flatten().map(|entry| entry.path()).collect();
    items.sort_by_key(|path| {
        (
            !path.is_dir(),
            path.file_name()
                .map(|name| name.to_string_lossy().to_lowercase())
                .unwrap_or_default(),
        )
    });

    let truncated = items.len() > MAX_TREE_CHILDREN;
    items
        .into_iter()
        .take(MAX_TREE_CHILDREN)
        .map(|path| {
            let is_dir = path.is_dir();
            SkillNode {
                name: path
                    .file_name()
                    .map(|name| name.to_string_lossy().to_string())
                    .unwrap_or_default(),
                path: display_path(&path),
                is_dir,
                size: fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0),
                children: if is_dir {
                    build_tree(&path, depth + 1)
                } else {
                    Vec::new()
                },
                truncated: false,
            }
        })
        .map(|mut node| {
            node.truncated = truncated;
            node
        })
        .collect()
}

fn lock_info(name: &str) -> Option<SkillLockInfo> {
    let path = skills_home(&[".agents", ".skill-lock.json"])?;
    let raw = fs::read_to_string(path).ok()?;
    let value: Value = serde_json::from_str(&raw).ok()?;
    let entry = value.get("skills")?.get(name)?;
    let text = |key: &str| entry.get(key).and_then(Value::as_str).map(str::to_string);
    Some(SkillLockInfo {
        source: text("source"),
        source_url: text("sourceUrl"),
        installed_at: text("installedAt"),
        updated_at: text("updatedAt"),
    })
}

fn validate_name(name: &str) -> Result<(), String> {
    if name.trim().is_empty() || name == "." || name == ".." || name.contains(['/', '\\', ':']) {
        return Err("invalid_name".to_string());
    }
    Ok(())
}

/// Resolves `<root>/<name>` and proves it did not escape the root, so a crafted name
/// can never point the reader or the uninstaller somewhere else.
fn locate(agent: &str, name: &str) -> Result<(PathBuf, PathBuf), String> {
    validate_name(name)?;
    let root = root_for(agent).ok_or_else(|| "unknown_agent".to_string())?;
    let direct = root.join(name);
    let system = root.join(".system").join(name);
    let target = if direct.is_dir() {
        direct
    } else if system.is_dir() {
        system
    } else {
        return Err("not_found".to_string());
    };

    let resolved_root = resolve(&root);
    let parent = target
        .parent()
        .map(resolve)
        .ok_or_else(|| "outside_root".to_string())?;
    if !parent.starts_with(&resolved_root) {
        return Err("outside_root".to_string());
    }
    Ok((root, target))
}

fn detail_inner(agent: String, name: String) -> Result<SkillDetail, String> {
    let (root, path) = locate(&agent, &name)?;
    let summary = summarize(&agent, &root, &path, false).ok_or_else(|| "not_found".to_string())?;
    let raw = read_skill_file(&path).ok_or_else(|| "not_found".to_string())?;
    let (front, body) = split_frontmatter(&raw);

    Ok(SkillDetail {
        lock: lock_info(&summary.name),
        frontmatter: parse_frontmatter(&front),
        frontmatter_raw: front,
        body,
        tree: build_tree(&path, 0),
        summary,
    })
}

fn uninstall_inner(agent: String, name: String) -> Result<SkillRemoveReport, String> {
    let (root, path) = locate(&agent, &name)?;
    let summary = summarize(&agent, &root, &path, false).ok_or_else(|| "not_found".to_string())?;
    if summary.bundled {
        return Err("bundled_skill".to_string());
    }

    if summary.linked {
        // A directory link (symlink or Windows junction) is unlinked, never followed —
        // the shared copy other agents point at has to survive.
        fs::remove_dir(&path)
            .or_else(|_| fs::remove_file(&path))
            .map_err(|error| format!("remove_failed:{error}"))?;
        return Ok(SkillRemoveReport {
            path: summary.path,
            removed_link_only: true,
            shared_copy_path: Some(summary.resolved_path),
        });
    }

    fs::remove_dir_all(&path).map_err(|error| format!("remove_failed:{error}"))?;
    Ok(SkillRemoveReport {
        path: summary.path,
        removed_link_only: false,
        shared_copy_path: None,
    })
}

#[tauri::command]
pub async fn skills_scan() -> Result<Vec<SkillAgentSnapshot>, String> {
    tokio::task::spawn_blocking(scan_inner)
        .await
        .map_err(|error| format!("skills_scan:{error}"))
}

#[tauri::command]
pub async fn skills_detail(agent: String, name: String) -> Result<SkillDetail, String> {
    tokio::task::spawn_blocking(move || detail_inner(agent, name))
        .await
        .map_err(|error| format!("skills_detail:{error}"))?
}

#[tauri::command]
pub async fn skills_uninstall(agent: String, name: String) -> Result<SkillRemoveReport, String> {
    tokio::task::spawn_blocking(move || uninstall_inner(agent, name))
        .await
        .map_err(|error| format!("skills_uninstall:{error}"))?
}


/// Result of copying one skill into one target agent.
///
/// Mirrors `McpSyncOutcome` on purpose: the copy is per target and never all-or-nothing, so one
/// agent that cannot take the skill does not stop the others, and the caller is told *why* rather
/// than being handed a bare failure.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillSyncOutcome {
    pub agent: String,
    /// `ok` | `skipped` | `blocked` | `failed`
    pub status: &'static str,
    /// Set for `blocked` and `failed`: what stopped this target specifically.
    pub reason: Option<String>,
    pub path: Option<String>,
}

fn copy_tree(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let source = entry.path();
        let target = to.join(entry.file_name());
        // Follows links rather than reproducing them: a copy that points back at the source agent's
        // store would break the moment that skill is uninstalled there, and the whole point of
        // copying is to give the target a store of its own.
        if resolve(&source).is_dir() {
            copy_tree(&resolve(&source), &target)?;
        } else {
            fs::copy(resolve(&source), &target)?;
        }
    }
    Ok(())
}

/// Creates a directory link at `link` pointing at `target`.
///
/// On Windows a directory symlink needs either administrator rights or developer mode, while a
/// junction needs neither — so the symlink is tried first for its portable semantics and a junction
/// is the fallback. It deliberately never falls back to copying: a copy would report success while
/// quietly producing the very thing the shared store exists to avoid, a second file free to drift.
fn link_dir(target: &Path, link: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        if std::os::windows::fs::symlink_dir(target, link).is_ok() {
            return Ok(());
        }
        let mut command = std::process::Command::new("cmd");
        command.args(["/c", "mklink", "/J"]);
        command.arg(link);
        command.arg(target);
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        let output = command
            .output()
            .map_err(|error| format!("link_failed:{error}"))?;
        if output.status.success() {
            return Ok(());
        }
        return Err(format!(
            "link_unsupported:{}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    #[cfg(not(windows))]
    {
        std::os::unix::fs::symlink(target, link).map_err(|error| format!("link_failed:{error}"))
    }
}

/// Moves a skill into the shared store and leaves a link behind in the agent it came from.
///
/// This is what the shared store is for: one real copy, every agent pointing at it. Copying the
/// files in without relinking the source would leave two independent directories free to drift,
/// which is the situation the store exists to prevent.
fn promote_to_shared(source: &Path, shared_root: &Path, name: &str) -> Result<PathBuf, String> {
    let destination = shared_root.join(name);
    if !destination.exists() {
        fs::create_dir_all(shared_root).map_err(|error| format!("mkdir_failed:{error}"))?;
        copy_tree(&resolve(source), &destination).map_err(|error| error.to_string())?;
    }
    // The source is replaced only once the shared copy is safely in place, so a failure here can
    // never leave the skill existing nowhere.
    if is_link(source) {
        fs::remove_dir(source)
            .or_else(|_| fs::remove_file(source))
            .map_err(|error| format!("unlink_failed:{error}"))?;
    } else if source.exists() {
        fs::remove_dir_all(source).map_err(|error| format!("remove_failed:{error}"))?;
    }
    link_dir(&destination, source)?;
    Ok(destination)
}

/// Copies a skill from one agent's store into others, making it available there.
///
/// For a skill, being in the agent's store *is* being installed — there is no registration step —
/// so a successful copy takes effect the next time that agent starts. That is the same property
/// MCP sync relies on, which is why both can promise "copy and it works".
///
/// The source is read through its resolved path, so copying a skill that is itself a link into the
/// shared store copies the real contents rather than a dangling link.
///
/// `resolve_root` is injected rather than read from the environment so the rule can be tested
/// against temporary directories without a process-wide variable that parallel tests would race on.
fn sync_at(
    resolve_root: impl Fn(&str) -> Option<PathBuf>,
    from: &str,
    targets: Vec<String>,
    name: &str,
    overwrite: bool,
) -> Result<Vec<SkillSyncOutcome>, String> {
    // The name reaches this from the frontend, and every use below joins it onto a root. Without
    // this check `../../` would walk the copy — and the delete that precedes an overwrite — clean
    // out of the skills store. `locate` guards the read and uninstall paths the same way.
    validate_name(name)?;
    let source_root = resolve_root(from).ok_or_else(|| "unknown_agent".to_string())?;
    let source = find_skill_dir(&source_root, name).ok_or_else(|| "skill_not_found".to_string())?;
    let resolved_source = resolve(&source);

    Ok(targets
        .into_iter()
        .filter(|agent| agent != from)
        .map(|agent| {
            let Some(root) = resolve_root(&agent) else {
                return SkillSyncOutcome {
                    agent,
                    status: "blocked",
                    reason: Some("unknown_agent".to_string()),
                    path: None,
                };
            };
            let destination = root.join(name);

            // The shared store is not an agent, so "copying" into it means something different:
            // the skill is moved there and the agent it came from is left pointing at it. A plain
            // copy would put a file in a folder no agent reads, which is worse than doing nothing
            // because it reports success.
            if agent == SHARED_AGENT {
                return match promote_to_shared(&source, &root, name) {
                    Ok(path) => SkillSyncOutcome {
                        agent,
                        status: "ok",
                        reason: None,
                        path: Some(display_path(&path)),
                    },
                    Err(reason) => SkillSyncOutcome {
                        agent,
                        status: "failed",
                        reason: Some(reason),
                        path: None,
                    },
                };
            }

            // Coming FROM the shared store, the agent gets a link rather than a duplicate — that is
            // the whole point of the skill living there.
            if from == SHARED_AGENT && !destination.exists() {
                // The agent may never have had a skills folder; linking into a directory that does
                // not exist fails with a path error that says nothing about the real cause.
                if let Err(error) = fs::create_dir_all(&root) {
                    return SkillSyncOutcome {
                        agent,
                        status: "failed",
                        reason: Some(format!("mkdir_failed:{error}")),
                        path: None,
                    };
                }
                return match link_dir(&resolved_source, &destination) {
                    Ok(()) => SkillSyncOutcome {
                        agent,
                        status: "ok",
                        reason: None,
                        path: Some(display_path(&destination)),
                    },
                    Err(reason) => SkillSyncOutcome {
                        agent,
                        status: "failed",
                        reason: Some(reason),
                        path: None,
                    },
                };
            }

            if destination.exists() && !overwrite {
                // Never clobbered silently: the target may hold a different skill under the same
                // name, and overwriting it would be indistinguishable from a successful copy.
                return SkillSyncOutcome {
                    agent,
                    status: "skipped",
                    reason: None,
                    path: Some(display_path(&destination)),
                };
            }
            if destination.exists() {
                if let Err(error) = fs::remove_dir_all(&destination) {
                    return SkillSyncOutcome {
                        agent,
                        status: "failed",
                        reason: Some(error.to_string()),
                        path: None,
                    };
                }
            }
            match copy_tree(&resolved_source, &destination) {
                Ok(()) => SkillSyncOutcome {
                    agent,
                    status: "ok",
                    reason: None,
                    path: Some(display_path(&destination)),
                },
                Err(error) => SkillSyncOutcome {
                    agent,
                    status: "failed",
                    reason: Some(error.to_string()),
                    path: None,
                },
            }
        })
        .collect())
}

/// Locates a skill directory by name, including the bundled ones kept under `.system`.
fn find_skill_dir(root: &Path, name: &str) -> Option<PathBuf> {
    let direct = root.join(name);
    if read_skill_file(&direct).is_some() {
        return Some(direct);
    }
    let bundled = root.join(".system").join(name);
    read_skill_file(&bundled).map(|_| bundled)
}

#[tauri::command]
pub async fn skills_sync(
    from: String,
    to: Vec<String>,
    name: String,
    overwrite: Option<bool>,
) -> Result<Vec<SkillSyncOutcome>, String> {
    tokio::task::spawn_blocking(move || {
        sync_at(root_for, &from, to, &name, overwrite.unwrap_or(false))
    })
        .await
        .map_err(|error| format!("skills_sync: blocking task failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frontmatter_reads_plain_quoted_and_folded_values() {
        let front = "name: motion\ndescription: \"Creates motion graphics\"\nlicense: MIT";
        let fields = parse_frontmatter(front);
        assert_eq!(fields.get("name").map(String::as_str), Some("motion"));
        assert_eq!(
            fields.get("description").map(String::as_str),
            Some("Creates motion graphics")
        );
        assert_eq!(fields.get("license").map(String::as_str), Some("MIT"));
    }

    #[test]
    fn frontmatter_joins_a_folded_block() {
        let front =
            "name: pptx\ndescription: >-\n  Use this skill any time\n  a .pptx file is involved.\n";
        let fields = parse_frontmatter(front);
        assert_eq!(
            fields.get("description").map(String::as_str),
            Some("Use this skill any time a .pptx file is involved.")
        );
    }

    #[test]
    fn frontmatter_keeps_a_nested_map_as_its_indented_text() {
        let front = "name: imagegen\nmetadata:\n  short-description: Generates images\n";
        let fields = parse_frontmatter(front);
        assert_eq!(
            fields.get("metadata").map(String::as_str),
            Some("short-description: Generates images")
        );
    }

    #[test]
    fn split_frontmatter_separates_body_and_tolerates_its_absence() {
        let (front, body) = split_frontmatter("---\nname: a\n---\n\n# Title\ntext\n");
        assert_eq!(front, "name: a");
        assert!(body.starts_with("# Title"));

        let (front, body) = split_frontmatter("# Just a body\n");
        assert!(front.is_empty());
        assert_eq!(body, "# Just a body\n");
    }

    #[test]
    fn a_crafted_name_cannot_escape_the_root() {
        assert_eq!(validate_name("../../etc").unwrap_err(), "invalid_name");
        assert_eq!(validate_name("a/b").unwrap_err(), "invalid_name");
        assert_eq!(validate_name("..").unwrap_err(), "invalid_name");
        assert_eq!(validate_name("   ").unwrap_err(), "invalid_name");
        assert!(validate_name("promo-film").is_ok());
    }

    fn temp_roots(label: &str) -> (PathBuf, impl Fn(&str) -> Option<PathBuf> + Clone) {
        let suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let base = std::env::temp_dir().join(format!("alethe-skills-{label}-{suffix}"));
        fs::create_dir_all(&base).unwrap();
        let roots = base.clone();
        // Only the agents ROOTS knows about resolve, so an unknown name is reported rather than
        // silently given a directory of its own.
        let resolver = move |agent: &str| -> Option<PathBuf> {
            ROOTS
                .iter()
                .find(|(name, _)| *name == agent)
                .map(|(name, _)| roots.join(name))
        };
        (base, resolver)
    }

    #[test]
    fn promoting_to_the_shared_store_leaves_the_source_pointing_at_it() {
        // The bug this fixes: a plain copy into the shared store put a directory in a folder no
        // agent reads, reported success, and changed nothing for any agent. Promoting has to move
        // the skill AND relink the source, or the store has no effect at all.
        let (base, resolve_root) = temp_roots("promote");
        let source = base.join("codex").join("graphify");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("SKILL.md"), "---
description: d
---
body").unwrap();

        let outcomes =
            sync_at(resolve_root, "codex", vec!["shared".to_string()], "graphify", false).unwrap();

        assert_eq!(outcomes[0].status, "ok", "{:?}", outcomes[0].reason);
        let shared = base.join("shared").join("graphify");
        assert!(shared.join("SKILL.md").is_file(), "shared store holds the real copy");
        // The agent still resolves the skill, but through the shared copy rather than its own.
        assert!(source.join("SKILL.md").is_file(), "source still resolves");
        assert!(is_link(&source), "source became a link into the shared store");
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn copying_out_of_the_shared_store_links_instead_of_duplicating() {
        // A duplicate would drift from the shared copy on the next edit, which is exactly what the
        // store exists to prevent.
        let (base, resolve_root) = temp_roots("link-out");
        let shared = base.join("shared").join("graphify");
        fs::create_dir_all(&shared).unwrap();
        fs::write(shared.join("SKILL.md"), "---
description: d
---
").unwrap();

        let outcomes =
            sync_at(resolve_root, "shared", vec!["claude".to_string()], "graphify", false).unwrap();

        assert_eq!(outcomes[0].status, "ok", "{:?}", outcomes[0].reason);
        let linked = base.join("claude").join("graphify");
        assert!(linked.join("SKILL.md").is_file());
        assert!(is_link(&linked), "the agent points at the shared copy");

        // Editing through the shared store is visible to the agent — the single-source property.
        fs::write(shared.join("SKILL.md"), "edited").unwrap();
        assert_eq!(fs::read_to_string(linked.join("SKILL.md")).unwrap(), "edited");
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn a_crafted_name_cannot_escape_the_root_when_copying() {
        // The copy path joins the name onto both roots and deletes the destination before an
        // overwrite, so an unchecked `../../` here would be destructive, not just a bad read.
        let (base, resolve_root) = temp_roots("copy-traversal");

        let error = sync_at(
            resolve_root,
            "codex",
            vec!["claude".to_string()],
            "../../escape",
            true,
        )
        .unwrap_err();

        assert_eq!(error, "invalid_name");
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn copying_a_skill_makes_it_present_in_the_target_store() {
        // For a skill, being in the agent's store IS being installed — no registration step — which
        // is what lets the copy promise "and it works".
        let (base, resolve_root) = temp_roots("copy-ok");
        let source = base.join("codex").join("graphify");
        fs::create_dir_all(source.join("scripts")).unwrap();
        fs::write(source.join("SKILL.md"), "---
description: d
---
body").unwrap();
        fs::write(source.join("scripts").join("run.py"), "print(1)").unwrap();

        let outcomes =
            sync_at(resolve_root, "codex", vec!["claude".to_string()], "graphify", false).unwrap();

        assert_eq!(outcomes.len(), 1);
        assert_eq!(outcomes[0].status, "ok");
        let copied = base.join("claude").join("graphify");
        assert!(copied.join("SKILL.md").is_file());
        // The whole tree travels, not just the manifest: a skill whose scripts were left behind is
        // present and broken, which is worse than absent.
        assert!(copied.join("scripts").join("run.py").is_file());
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn an_existing_skill_at_the_target_is_skipped_not_overwritten() {
        // The target may hold a different skill under the same name; replacing it silently would be
        // indistinguishable from a successful copy.
        let (base, resolve_root) = temp_roots("copy-skip");
        let source = base.join("codex").join("dup");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("SKILL.md"), "---
description: new
---
").unwrap();
        let existing = base.join("claude").join("dup");
        fs::create_dir_all(&existing).unwrap();
        fs::write(existing.join("SKILL.md"), "keep me").unwrap();

        let outcomes =
            sync_at(resolve_root, "codex", vec!["claude".to_string()], "dup", false).unwrap();

        assert_eq!(outcomes[0].status, "skipped");
        assert_eq!(fs::read_to_string(existing.join("SKILL.md")).unwrap(), "keep me");
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn overwrite_replaces_the_target_instead_of_merging_into_it() {
        // Copying over a skill must not leave files from the old one behind: a stale script the new
        // skill never mentions would still be there for the agent to find.
        let (base, resolve_root) = temp_roots("copy-overwrite");
        let source = base.join("codex").join("dup");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("SKILL.md"), "---
description: new
---
").unwrap();
        let existing = base.join("claude").join("dup");
        fs::create_dir_all(&existing).unwrap();
        fs::write(existing.join("SKILL.md"), "old").unwrap();
        fs::write(existing.join("leftover.py"), "stale").unwrap();

        let outcomes =
            sync_at(resolve_root, "codex", vec!["claude".to_string()], "dup", true).unwrap();

        assert_eq!(outcomes[0].status, "ok");
        assert!(fs::read_to_string(existing.join("SKILL.md")).unwrap().contains("new"));
        assert!(!existing.join("leftover.py").exists());
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn one_bad_target_does_not_stop_the_others() {
        // Per-target outcomes, like MCP sync: an agent that cannot take the skill is reported and
        // the rest still receive it.
        let (base, resolve_root) = temp_roots("copy-partial");
        let source = base.join("codex").join("s");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("SKILL.md"), "---
description: d
---
").unwrap();

        let outcomes = sync_at(
            resolve_root,
            "codex",
            vec!["claude".to_string(), "nope".to_string()],
            "s",
            false,
        )
        .unwrap();

        let claude = outcomes.iter().find(|o| o.agent == "claude").unwrap();
        let unknown = outcomes.iter().find(|o| o.agent == "nope").unwrap();
        assert_eq!(claude.status, "ok");
        assert_eq!(unknown.status, "blocked");
        assert_eq!(unknown.reason.as_deref(), Some("unknown_agent"));
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn copying_to_the_source_agent_is_not_attempted() {
        let (base, resolve_root) = temp_roots("copy-self");
        let source = base.join("codex").join("s");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("SKILL.md"), "---
description: d
---
").unwrap();

        let outcomes =
            sync_at(resolve_root, "codex", vec!["codex".to_string()], "s", false).unwrap();

        assert!(outcomes.is_empty());
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn a_bundled_skill_can_be_copied_out_of_the_system_folder() {
        // The native ones live under `.system`; without looking there, copying a bundled skill
        // would report "not found" for a skill the panel is showing right now.
        let (base, resolve_root) = temp_roots("copy-bundled");
        let source = base.join("codex").join(".system").join("skill-installer");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("SKILL.md"), "---
description: d
---
").unwrap();

        let outcomes = sync_at(
            resolve_root,
            "codex",
            vec!["claude".to_string()],
            "skill-installer",
            false,
        )
        .unwrap();

        assert_eq!(outcomes[0].status, "ok");
        assert!(base
            .join("claude")
            .join("skill-installer")
            .join("SKILL.md")
            .is_file());
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn display_path_drops_the_windows_verbatim_prefix() {
        assert_eq!(
            display_path(Path::new(r"\\?\C:\Users\x\.agents\skills\brand")),
            r"C:\Users\x\.agents\skills\brand"
        );
    }

    #[test]
    fn scanning_returns_one_snapshot_per_root_without_panicking() {
        let snapshots = scan_inner();
        assert_eq!(snapshots.len(), ROOTS.len());
        for snapshot in &snapshots {
            if !snapshot.exists {
                assert!(snapshot.skills.is_empty());
            }
            for skill in &snapshot.skills {
                assert!(!skill.name.is_empty());
                assert_eq!(skill.agent, snapshot.agent);
            }
        }
    }

    #[test]
    fn every_root_resolves_to_a_path() {
        for (agent, _) in ROOTS {
            assert!(root_for(agent).is_some(), "{agent} has no root");
        }
        assert!(root_for("nonsense").is_none());
    }
}
