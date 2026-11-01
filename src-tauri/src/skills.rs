use std::collections::BTreeMap;
use std::fs;
use std::path::{Component, Path, PathBuf};

use serde::Serialize;
use serde_json::Value;

use crate::provider_common::provider_home_dir;

const SKILL_FILE: &str = "SKILL.md";
const CODEX_SYSTEM_MARKER: &str = ".codex-system-skills.marker";
const MAX_TREE_DEPTH: usize = 4;
const MAX_TREE_CHILDREN: usize = 100;
/// Written next to an Alethe-installed `SKILL.md` so ownership and version survive without
/// touching the skill's own frontmatter.
const ALETHE_SIDECAR: &str = ".alethe-skill.json";

struct BundledSkill {
    name: &'static str,
    version: u32,
    repository: &'static str,
    /// Earlier names; installing removes an Alethe-managed copy under any of them.
    legacy_names: &'static [&'static str],
    agents: &'static [&'static str],
    files: &'static [BundledSkillFile],
}

struct BundledSkillFile {
    path: &'static str,
    content: &'static str,
}

impl BundledSkill {
    fn entrypoint(&self) -> &'static str {
        self.files
            .iter()
            .find(|file| file.path == SKILL_FILE)
            .map(|file| file.content)
            .expect("a bundled skill must contain SKILL.md")
    }
}

/// Official skills; `npm run skill:sync` rewrites the version and the file list.
const BUNDLED_SKILLS: [BundledSkill; 1] = [BundledSkill {
    name: "alethe",
    version: 21,
    repository: "https://github.com/Kc1t/alethe-orchestrate-skill",
    legacy_names: &["alethe-orchestrate"],
    agents: &["claude", "codex"],
    files: &[
        // skill:sync files begin
        BundledSkillFile {
            path: SKILL_FILE,
            content: include_str!("../assets/skills/alethe/SKILL.md"),
        },
        BundledSkillFile {
            path: "assets/brands/antigravity-official.svg",
            content: include_str!("../assets/skills/alethe/assets/brands/antigravity-official.svg"),
        },
        BundledSkillFile {
            path: "assets/brands/claude-official.png.b64",
            content: include_str!("../assets/skills/alethe/assets/brands/claude-official.png.b64"),
        },
        BundledSkillFile {
            path: "assets/brands/kimi-official.png.b64",
            content: include_str!("../assets/skills/alethe/assets/brands/kimi-official.png.b64"),
        },
        BundledSkillFile {
            path: "assets/brands/openai-official-white.svg",
            content: include_str!("../assets/skills/alethe/assets/brands/openai-official-white.svg"),
        },
        BundledSkillFile {
            path: "assets/brands/router9-official.svg",
            content: include_str!("../assets/skills/alethe/assets/brands/router9-official.svg"),
        },
        BundledSkillFile {
            path: "assets/editor.html",
            content: include_str!("../assets/skills/alethe/assets/editor.html"),
        },
        BundledSkillFile {
            path: "assets/report.html",
            content: include_str!("../assets/skills/alethe/assets/report.html"),
        },
        BundledSkillFile {
            path: "playbooks.yaml",
            content: include_str!("../assets/skills/alethe/playbooks.yaml"),
        },
        BundledSkillFile {
            path: "prices.json",
            content: include_str!("../assets/skills/alethe/prices.json"),
        },
        BundledSkillFile {
            path: "references/briefs.md",
            content: include_str!("../assets/skills/alethe/references/briefs.md"),
        },
        BundledSkillFile {
            path: "references/diagram.md",
            content: include_str!("../assets/skills/alethe/references/diagram.md"),
        },
        BundledSkillFile {
            path: "references/manual.md",
            content: include_str!("../assets/skills/alethe/references/manual.md"),
        },
        BundledSkillFile {
            path: "references/onboarding.md",
            content: include_str!("../assets/skills/alethe/references/onboarding.md"),
        },
        BundledSkillFile {
            path: "references/operations.md",
            content: include_str!("../assets/skills/alethe/references/operations.md"),
        },
        BundledSkillFile {
            path: "references/playbooks.md",
            content: include_str!("../assets/skills/alethe/references/playbooks.md"),
        },
        BundledSkillFile {
            path: "references/providers.md",
            content: include_str!("../assets/skills/alethe/references/providers.md"),
        },
        BundledSkillFile {
            path: "references/routing.md",
            content: include_str!("../assets/skills/alethe/references/routing.md"),
        },
        BundledSkillFile {
            path: "schemas/plan.schema.json",
            content: include_str!("../assets/skills/alethe/schemas/plan.schema.json"),
        },
        BundledSkillFile {
            path: "scripts/diagram.py",
            content: include_str!("../assets/skills/alethe/scripts/diagram.py"),
        },
        BundledSkillFile {
            path: "scripts/orchestrate.py",
            content: include_str!("../assets/skills/alethe/scripts/orchestrate.py"),
        },
        // skill:sync files end
    ],
}];

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
    pub from_alethe: bool,
    pub entry_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BundledSkillAgent {
    pub agent: String,
    /// `available`, `installed`, `update` or `conflict`.
    pub state: String,
    pub path: Option<String>,
    /// Why installing or removing failed for this agent; the other agents still ran.
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BundledSkillEntry {
    pub name: String,
    pub description: String,
    pub version: u32,
    pub repository: String,
    pub body: String,
    pub agents: Vec<BundledSkillAgent>,
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

/// Claude Code reads repository skills from `.claude/skills`, Codex from `.agents/skills`.
fn project_root_for(project: &Path, agent: &str) -> Option<PathBuf> {
    match agent {
        "claude" => Some(project.join(".claude").join("skills")),
        "codex" => Some(project.join(".agents").join("skills")),
        _ => None,
    }
}

fn project_dir(raw: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(raw.trim());
    if raw.trim().is_empty() || !path.is_absolute() || !path.is_dir() {
        return Err("invalid_project".to_string());
    }
    Ok(path)
}

/// Runs `run` against the global skill folders, or against a project's when one is given.
fn with_roots<T>(
    project: Option<String>,
    run: impl FnOnce(&dyn Fn(&str) -> Option<PathBuf>) -> Result<T, String>,
) -> Result<T, String> {
    match project.filter(|raw| !raw.trim().is_empty()) {
        Some(raw) => {
            let project = project_dir(&raw)?;
            run(&|agent: &str| project_root_for(&project, agent))
        }
        None => run(&root_for),
    }
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
        from_alethe: sidecar_version(dir).is_some(),
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
    if summary.bundled || path.parent() == Some(root.join(".system").as_path()) {
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

fn sidecar_version(dir: &Path) -> Option<u32> {
    let raw = fs::read_to_string(dir.join(ALETHE_SIDECAR)).ok()?;
    let value: Value = serde_json::from_str(&raw).ok()?;
    value
        .get("version")
        .and_then(Value::as_u64)
        .and_then(|version| u32::try_from(version).ok())
}

fn sidecar_files(dir: &Path) -> Vec<String> {
    let Ok(raw) = fs::read_to_string(dir.join(ALETHE_SIDECAR)) else {
        return Vec::new();
    };
    let Ok(value) = serde_json::from_str::<Value>(&raw) else {
        return Vec::new();
    };
    value
        .get("files")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect()
}

/// Replaces the file in one step, so an interrupted update never leaves it half written.
fn write_managed(target: &Path, content: &str) -> Result<(), String> {
    let name = target
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_default();
    let temp = target.with_file_name(format!(".{name}.alethe-tmp"));
    fs::write(&temp, content).map_err(|error| format!("write_failed:{error}"))?;
    fs::rename(&temp, target).map_err(|error| {
        let _ = fs::remove_file(&temp);
        format!("write_failed:{error}")
    })
}

/// Deletes only the files an Alethe install wrote; user files, other folders and links stay.
fn remove_managed(dir: &Path) -> Result<(), String> {
    if is_link(dir) || sidecar_version(dir).is_none() {
        return Ok(());
    }
    let mut files = sidecar_files(dir);
    if files.is_empty() {
        files.push(SKILL_FILE.to_string());
    }
    for relative in files.iter().filter_map(|path| bundled_relative_path(path).ok()) {
        let target = managed_file_target(dir, &relative, false)?;
        if target.is_file() {
            fs::remove_file(&target).map_err(|error| format!("remove_failed:{error}"))?;
            remove_empty_managed_parents(target.parent(), dir);
        }
    }
    fs::remove_file(dir.join(ALETHE_SIDECAR)).map_err(|error| format!("remove_failed:{error}"))?;
    let _ = fs::remove_dir(dir);
    Ok(())
}

fn bundled_relative_path(raw: &str) -> Result<PathBuf, String> {
    let path = Path::new(raw);
    if raw.is_empty()
        || path.is_absolute()
        || !path
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
    {
        return Err(format!("invalid_bundled_path:{raw}"));
    }
    Ok(path.to_path_buf())
}

fn managed_file_target(
    root: &Path,
    relative: &Path,
    create_parents: bool,
) -> Result<PathBuf, String> {
    let mut parent = root.to_path_buf();
    if let Some(relative_parent) = relative.parent() {
        for component in relative_parent.components() {
            let Component::Normal(segment) = component else {
                return Err(format!("invalid_bundled_path:{}", relative.display()));
            };
            parent.push(segment);
            match fs::symlink_metadata(&parent) {
                Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
                    return Err(format!("managed_path_conflict:{}", parent.display()));
                }
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound && create_parents => {
                    fs::create_dir(&parent).map_err(|error| format!("mkdir_failed:{error}"))?;
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    return Ok(root.join(relative))
                }
                Err(error) => return Err(format!("managed_path_failed:{error}")),
            }
        }
    }
    let target = root.join(relative);
    if let Ok(metadata) = fs::symlink_metadata(&target) {
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(format!("managed_path_conflict:{}", target.display()));
        }
    }
    Ok(target)
}

fn remove_empty_managed_parents(mut parent: Option<&Path>, root: &Path) {
    while let Some(dir) = parent.filter(|dir| *dir != root && dir.starts_with(root)) {
        match fs::remove_dir(dir) {
            Ok(()) => parent = dir.parent(),
            Err(_) => break,
        }
    }
}

/// A folder Alethe did not create, or a link into another store, is a conflict: installing
/// must never overwrite a skill the user put there or write through a link.
fn bundled_state(dir: &Path, version: u32) -> &'static str {
    if fs::symlink_metadata(dir).is_err() {
        return "available";
    }
    if is_link(dir) {
        return "conflict";
    }
    // An empty folder is what an interrupted first install leaves behind.
    if fs::read_dir(dir)
        .map(|mut entries| entries.next().is_none())
        .unwrap_or(false)
    {
        return "available";
    }
    match sidecar_version(dir) {
        None => "conflict",
        Some(installed) if installed < version => "update",
        Some(_) => "installed",
    }
}

fn bundled_agent(
    skill: &BundledSkill,
    agent: &str,
    root_of: &dyn Fn(&str) -> Option<PathBuf>,
) -> BundledSkillAgent {
    let dir = root_of(agent).map(|root| root.join(skill.name));
    BundledSkillAgent {
        agent: agent.to_string(),
        state: dir
            .as_deref()
            .map(|dir| bundled_state(dir, skill.version))
            .unwrap_or("available")
            .to_string(),
        path: dir.as_deref().map(display_path),
        error: None,
    }
}

fn catalog_inner(root_of: &dyn Fn(&str) -> Option<PathBuf>) -> Vec<BundledSkillEntry> {
    BUNDLED_SKILLS
        .iter()
        .map(|skill| {
            let (front, body) = split_frontmatter(skill.entrypoint());
            BundledSkillEntry {
                name: skill.name.to_string(),
                description: parse_frontmatter(&front)
                    .get("description")
                    .cloned()
                    .unwrap_or_default(),
                version: skill.version,
                repository: skill.repository.to_string(),
                body,
                agents: skill
                    .agents
                    .iter()
                    .map(|agent| bundled_agent(skill, agent, root_of))
                    .collect(),
            }
        })
        .collect()
}

fn find_bundled<'a>(name: &str, agents: &[String]) -> Result<&'a BundledSkill, String> {
    let skill = BUNDLED_SKILLS
        .iter()
        .find(|skill| skill.name == name)
        .ok_or_else(|| "not_found".to_string())?;
    if let Some(unknown) = agents
        .iter()
        .find(|agent| !skill.agents.contains(&agent.as_str()))
    {
        return Err(format!("unknown_agent:{unknown}"));
    }
    Ok(skill)
}

fn install_into(skill: &BundledSkill, dir: &Path) -> Result<(), String> {
    let files = skill
        .files
        .iter()
        .map(|file| bundled_relative_path(file.path).map(|path| (file, path)))
        .collect::<Result<Vec<_>, _>>()?;
    let managed: Vec<&str> = skill.files.iter().map(|file| file.path).collect();
    let stale = sidecar_files(dir)
        .into_iter()
        .filter(|path| !managed.contains(&path.as_str()))
        .filter_map(|path| bundled_relative_path(&path).ok())
        .collect::<Vec<_>>();
    fs::create_dir_all(dir).map_err(|error| format!("mkdir_failed:{error}"))?;
    let targets = files
        .into_iter()
        .map(|(file, relative)| managed_file_target(dir, &relative, true).map(|target| (file, target)))
        .collect::<Result<Vec<_>, _>>()?;
    let stale_targets = stale
        .into_iter()
        .map(|relative| managed_file_target(dir, &relative, false))
        .collect::<Result<Vec<_>, _>>()?;
    for (file, target) in targets {
        write_managed(&target, file.content)?;
    }
    for target in stale_targets {
        if target.is_file() {
            fs::remove_file(&target).map_err(|error| format!("remove_failed:{error}"))?;
            remove_empty_managed_parents(target.parent(), dir);
        }
    }
    write_managed(
        &dir.join(ALETHE_SIDECAR),
        &serde_json::json!({ "version": skill.version, "files": managed }).to_string(),
    )
}

/// Conflicts, newer copies and per-agent failures are reported on that agent, not as an error.
fn install_bundled_inner(
    name: &str,
    agents: &[String],
    root_of: &dyn Fn(&str) -> Option<PathBuf>,
) -> Result<Vec<BundledSkillAgent>, String> {
    let skill = find_bundled(name, agents)?;
    let mut out = Vec::new();
    for agent in agents {
        let result = root_of(agent)
            .ok_or_else(|| "unknown_agent".to_string())
            .and_then(|root| {
                let dir = root.join(skill.name);
                if matches!(bundled_state(&dir, skill.version), "available" | "update") {
                    install_into(skill, &dir)?;
                }
                if bundled_state(&dir, skill.version) == "installed" {
                    for legacy in skill.legacy_names {
                        remove_managed(&root.join(legacy))?;
                    }
                }
                Ok(())
            });
        let mut entry = bundled_agent(skill, agent, root_of);
        entry.error = result.err();
        out.push(entry);
    }
    Ok(out)
}

/// A folder the user made is left untouched and reported as a conflict.
fn remove_bundled_inner(
    name: &str,
    agents: &[String],
    root_of: &dyn Fn(&str) -> Option<PathBuf>,
) -> Result<Vec<BundledSkillAgent>, String> {
    let skill = find_bundled(name, agents)?;
    let mut out = Vec::new();
    for agent in agents {
        let result = root_of(agent)
            .ok_or_else(|| "unknown_agent".to_string())
            .and_then(|root| remove_managed(&root.join(skill.name)));
        let mut entry = bundled_agent(skill, agent, root_of);
        entry.error = result.err();
        out.push(entry);
    }
    Ok(out)
}

#[tauri::command]
pub async fn skills_catalog(project_path: Option<String>) -> Result<Vec<BundledSkillEntry>, String> {
    tokio::task::spawn_blocking(move || with_roots(project_path, |roots| Ok(catalog_inner(roots))))
        .await
        .map_err(|error| format!("skills_catalog:{error}"))?
}

#[tauri::command]
pub async fn skills_install_bundled(
    name: String,
    agents: Vec<String>,
    project_path: Option<String>,
) -> Result<Vec<BundledSkillAgent>, String> {
    tokio::task::spawn_blocking(move || {
        with_roots(project_path, |roots| install_bundled_inner(&name, &agents, roots))
    })
    .await
    .map_err(|error| format!("skills_install_bundled:{error}"))?
}

#[tauri::command]
pub async fn skills_remove_bundled(
    name: String,
    agents: Vec<String>,
    project_path: Option<String>,
) -> Result<Vec<BundledSkillAgent>, String> {
    tokio::task::spawn_blocking(move || {
        with_roots(project_path, |roots| remove_bundled_inner(&name, &agents, roots))
    })
    .await
    .map_err(|error| format!("skills_remove_bundled:{error}"))?
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

    fn temp_home(label: &str) -> PathBuf {
        let suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let home = std::env::temp_dir().join(format!("alethe-skills-{label}-{suffix}"));
        fs::create_dir_all(&home).unwrap();
        home
    }

    fn both() -> Vec<String> {
        vec!["claude".to_string(), "codex".to_string()]
    }

    fn states(agents: &[BundledSkillAgent]) -> Vec<&str> {
        agents.iter().map(|agent| agent.state.as_str()).collect()
    }

    #[test]
    fn every_bundled_skill_is_a_valid_skill_file() {
        for skill in &BUNDLED_SKILLS {
            assert!(validate_name(skill.name).is_ok());
            let (front, body) = split_frontmatter(skill.entrypoint());
            let fields = parse_frontmatter(&front);
            assert_eq!(fields.get("name").map(String::as_str), Some(skill.name));
            assert!(!fields.get("description").unwrap().is_empty());
            assert_eq!(
                fields.get("metadata").map(String::as_str),
                Some(format!("version: \"{}\"", skill.version).as_str()),
                "run npm run skill:sync so the bundled version matches the skill"
            );
            assert!(!body.trim().is_empty());
            let mut paths = std::collections::BTreeSet::new();
            for file in skill.files {
                assert!(bundled_relative_path(file.path).is_ok(), "{}", file.path);
                assert!(paths.insert(file.path), "duplicate file {}", file.path);
                assert!(!file.content.trim().is_empty(), "empty file {}", file.path);
            }
            for agent in skill.agents {
                assert!(root_for(agent).is_some(), "{agent} has no root");
            }
        }
    }

    #[test]
    fn a_bundled_skill_installs_for_each_agent_and_reinstalls_cleanly() {
        let home = temp_home("install");
        let root_of = |agent: &str| Some(home.join(agent));
        let skill = &BUNDLED_SKILLS[0];

        assert_eq!(
            states(&catalog_inner(&root_of)[0].agents),
            ["available", "available"]
        );

        let report = install_bundled_inner(skill.name, &both(), &root_of).unwrap();
        assert_eq!(states(&report), ["installed", "installed"]);
        for agent in ["claude", "codex"] {
            let dir = home.join(agent).join(skill.name);
            for file in skill.files {
                assert_eq!(
                    fs::read_to_string(dir.join(file.path)).unwrap(),
                    file.content
                );
            }
            assert_eq!(sidecar_version(&dir), Some(skill.version));
            assert_eq!(sidecar_files(&dir).len(), skill.files.len());
            let summary = summarize(agent, &home.join(agent), &dir, false).unwrap();
            assert!(summary.from_alethe);
            assert!(!summary.bundled);
        }

        let again = install_bundled_inner(skill.name, &both(), &root_of).unwrap();
        assert_eq!(states(&again), ["installed", "installed"]);
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn an_older_install_updates_and_a_newer_one_is_left_alone() {
        let home = temp_home("versions");
        let root_of = |agent: &str| Some(home.join(agent));
        let skill = &BUNDLED_SKILLS[0];

        let old = home.join("claude").join(skill.name);
        fs::create_dir_all(old.join("references")).unwrap();
        fs::write(old.join(SKILL_FILE), "old body").unwrap();
        fs::write(old.join("references/obsolete.md"), "old managed file").unwrap();
        fs::write(old.join("personal-notes.md"), "user file").unwrap();
        fs::write(
            old.join(ALETHE_SIDECAR),
            r#"{"version":0,"files":["SKILL.md","references/obsolete.md"]}"#,
        )
        .unwrap();

        let future = home.join("codex").join(skill.name);
        fs::create_dir_all(&future).unwrap();
        fs::write(future.join(SKILL_FILE), "future body").unwrap();
        fs::write(future.join(ALETHE_SIDECAR), r#"{"version":999}"#).unwrap();

        assert_eq!(
            states(&catalog_inner(&root_of)[0].agents),
            ["update", "installed"]
        );
        install_bundled_inner(skill.name, &both(), &root_of).unwrap();

        assert_eq!(
            fs::read_to_string(old.join(SKILL_FILE)).unwrap(),
            skill.entrypoint()
        );
        assert!(!old.join("references/obsolete.md").exists());
        assert_eq!(
            fs::read_to_string(old.join("personal-notes.md")).unwrap(),
            "user file"
        );
        assert_eq!(
            fs::read_to_string(future.join(SKILL_FILE)).unwrap(),
            "future body"
        );
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn a_legacy_single_file_install_upgrades_to_the_full_package() {
        let home = temp_home("legacy-package");
        let root_of = |agent: &str| Some(home.join(agent));
        let skill = &BUNDLED_SKILLS[0];
        let installed = home.join("codex").join(skill.name);
        fs::create_dir_all(&installed).unwrap();
        fs::write(installed.join(SKILL_FILE), "version two").unwrap();
        fs::write(installed.join(ALETHE_SIDECAR), r#"{"version":2}"#).unwrap();

        let report = install_bundled_inner(skill.name, &["codex".to_string()], &root_of).unwrap();

        assert_eq!(states(&report), ["installed"]);
        for file in skill.files {
            assert_eq!(
                fs::read_to_string(installed.join(file.path)).unwrap(),
                file.content
            );
        }
        assert_eq!(sidecar_files(&installed).len(), skill.files.len());
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn a_skill_alethe_did_not_create_is_never_overwritten() {
        let home = temp_home("conflict");
        let root_of = |agent: &str| Some(home.join(agent));
        let skill = &BUNDLED_SKILLS[0];

        let theirs = home.join("claude").join(skill.name);
        fs::create_dir_all(&theirs).unwrap();
        fs::write(theirs.join(SKILL_FILE), "user skill").unwrap();

        let report = install_bundled_inner(skill.name, &both(), &root_of).unwrap();
        assert_eq!(states(&report), ["conflict", "installed"]);
        assert_eq!(
            fs::read_to_string(theirs.join(SKILL_FILE)).unwrap(),
            "user skill"
        );
        fs::remove_dir_all(home).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn an_update_never_writes_through_a_nested_link() {
        use std::os::unix::fs::symlink;

        let home = temp_home("nested-link");
        let outside = temp_home("nested-link-outside");
        let root_of = |agent: &str| Some(home.join(agent));
        let skill = &BUNDLED_SKILLS[0];
        let installed = home.join("claude").join(skill.name);
        fs::create_dir_all(&installed).unwrap();
        fs::write(installed.join(SKILL_FILE), "old body").unwrap();
        fs::write(installed.join(ALETHE_SIDECAR), r#"{"version":0}"#).unwrap();
        symlink(&outside, installed.join("references")).unwrap();

        let report = install_bundled_inner(skill.name, &["claude".to_string()], &root_of).unwrap();
        let error = report[0].error.clone().expect("the nested link must be refused");

        assert!(error.starts_with("managed_path_conflict:"), "{error}");
        assert_eq!(
            fs::read_to_string(installed.join(SKILL_FILE)).unwrap(),
            "old body"
        );
        assert!(fs::read_dir(&outside).unwrap().next().is_none());
        fs::remove_dir_all(home).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }

    #[test]
    fn installing_rejects_unknown_skills_and_agents() {
        let home = temp_home("reject");
        let root_of = |agent: &str| Some(home.join(agent));
        assert_eq!(
            install_bundled_inner("nope", &both(), &root_of).unwrap_err(),
            "not_found"
        );
        assert_eq!(
            install_bundled_inner(BUNDLED_SKILLS[0].name, &["opencode".to_string()], &root_of)
                .unwrap_err(),
            "unknown_agent:opencode"
        );
        assert!(fs::read_dir(&home).unwrap().next().is_none());
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn installing_replaces_an_alethe_copy_under_an_earlier_name() {
        let home = temp_home("legacy-name");
        let root_of = |agent: &str| Some(home.join(agent));
        let skill = &BUNDLED_SKILLS[0];
        let legacy = home.join("claude").join(skill.legacy_names[0]);
        fs::create_dir_all(legacy.join("references")).unwrap();
        fs::write(legacy.join(SKILL_FILE), "old").unwrap();
        fs::write(legacy.join("references/routing.md"), "old").unwrap();
        fs::write(
            legacy.join(ALETHE_SIDECAR),
            r#"{"version":12,"files":["SKILL.md","references/routing.md"]}"#,
        )
        .unwrap();
        let theirs = home.join("codex").join(skill.legacy_names[0]);
        fs::create_dir_all(&theirs).unwrap();
        fs::write(theirs.join(SKILL_FILE), "user copy").unwrap();

        let report = install_bundled_inner(skill.name, &both(), &root_of).unwrap();

        assert_eq!(states(&report), ["installed", "installed"]);
        assert!(report.iter().all(|agent| agent.error.is_none()));
        assert!(!legacy.exists());
        assert_eq!(fs::read_to_string(theirs.join(SKILL_FILE)).unwrap(), "user copy");
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn a_project_install_goes_where_each_agent_reads_repository_skills() {
        let project = temp_home("project");
        let skill = &BUNDLED_SKILLS[0];
        let raw = project.to_string_lossy().to_string();

        let report = with_roots(Some(raw.clone()), |roots| {
            install_bundled_inner(skill.name, &both(), roots)
        })
        .unwrap();

        assert_eq!(states(&report), ["installed", "installed"]);
        let claude = project.join(".claude").join("skills").join(skill.name);
        let codex = project.join(".agents").join("skills").join(skill.name);
        assert_eq!(fs::read_to_string(claude.join(SKILL_FILE)).unwrap(), skill.entrypoint());
        assert_eq!(sidecar_version(&codex), Some(skill.version));
        fs::write(codex.join("notes.md"), "mine").unwrap();

        let removed =
            with_roots(Some(raw), |roots| remove_bundled_inner(skill.name, &both(), roots)).unwrap();
        assert_eq!(states(&removed), ["available", "conflict"]);
        assert!(!claude.exists());
        assert_eq!(fs::read_to_string(codex.join("notes.md")).unwrap(), "mine");
        assert!(!codex.join(SKILL_FILE).exists());
        assert_eq!(
            with_roots(Some("relative/path".to_string()), |roots| Ok(catalog_inner(roots))).unwrap_err(),
            "invalid_project"
        );
        fs::remove_dir_all(project).unwrap();
    }

    #[test]
    fn an_empty_folder_left_by_a_failed_install_is_available() {
        let home = temp_home("empty");
        let root_of = |agent: &str| Some(home.join(agent));
        let skill = &BUNDLED_SKILLS[0];
        fs::create_dir_all(home.join("claude").join(skill.name)).unwrap();
        assert_eq!(states(&catalog_inner(&root_of)[0].agents), ["available", "available"]);
        let report = install_bundled_inner(skill.name, &["claude".to_string()], &root_of).unwrap();
        assert_eq!(states(&report), ["installed"]);
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn a_codex_system_skill_cannot_be_uninstalled() {
        let home = temp_home("system");
        let system = home.join(".codex").join("skills").join(".system").join("imagegen");
        fs::create_dir_all(&system).unwrap();
        fs::write(system.join(SKILL_FILE), "---\nname: imagegen\n---\nbody").unwrap();
        std::env::set_var("ALETHE_MCP_HOME", &home);
        let result = uninstall_inner("codex".to_string(), "imagegen".to_string());
        std::env::remove_var("ALETHE_MCP_HOME");
        assert_eq!(result.unwrap_err(), "bundled_skill");
        assert!(system.join(SKILL_FILE).exists());
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn every_root_resolves_to_a_path() {
        for (agent, _) in ROOTS {
            assert!(root_for(agent).is_some(), "{agent} has no root");
        }
        assert!(root_for("nonsense").is_none());
    }
}
