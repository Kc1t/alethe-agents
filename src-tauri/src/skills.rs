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
