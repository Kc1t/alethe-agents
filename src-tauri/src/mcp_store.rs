use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::mcp_agents::adapter;
use crate::mcp_model::{
    capability, EnvEntry, EnvMap, McpAgent, McpAgentSnapshot, McpCapability, McpScope, McpServer,
    McpServerRecord, McpTimeouts, McpTransport, ALL_MCP_AGENTS,
};
use crate::provider_common::file_modified_ms;

type CacheKey = (McpAgent, McpScope, PathBuf);

struct CacheEntry {
    mtime_ms: u64,
    len: u64,
    servers: Vec<McpServer>,
}

static SCAN_CACHE: OnceLock<Mutex<HashMap<CacheKey, CacheEntry>>> = OnceLock::new();

fn cache() -> &'static Mutex<HashMap<CacheKey, CacheEntry>> {
    SCAN_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(crate) fn invalidate(agent: McpAgent, scope: McpScope, path: &Path) {
    if let Ok(mut guard) = cache().lock() {
        guard.remove(&(agent, scope, path.to_path_buf()));
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpConfigPath {
    pub agent: McpAgent,
    pub scope: McpScope,
    pub path: Option<String>,
    pub exists: bool,
    pub supported: bool,
}

fn requested_agents(agents: Option<Vec<String>>) -> Vec<McpAgent> {
    match agents {
        Some(list) => {
            let picked: Vec<McpAgent> = list.iter().filter_map(|raw| McpAgent::parse(raw)).collect();
            if picked.is_empty() {
                ALL_MCP_AGENTS.to_vec()
            } else {
                picked
            }
        }
        None => ALL_MCP_AGENTS.to_vec(),
    }
}

fn repo_path(repo: Option<String>) -> Option<PathBuf> {
    let raw = repo?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(PathBuf::from(trimmed))
    }
}

fn is_writable(path: &Path) -> bool {
    match fs::metadata(path) {
        Ok(metadata) => !metadata.permissions().readonly(),
        Err(_) => path
            .parent()
            .map(|parent| parent.is_dir())
            .unwrap_or(false),
    }
}

/// Antigravity records plugin-contributed configuration in an import manifest but does
/// not name the servers it added, so a contributed server is matched by name prefix.
fn antigravity_imports() -> Vec<String> {
    let Some(path) = crate::mcp_agents::adapter(McpAgent::Antigravity)
        .config_path(McpScope::Global, None)
        .and_then(|config| config.parent().map(|dir| dir.join("import_manifest.json")))
    else {
        return Vec::new();
    };
    let Ok(raw) = fs::read_to_string(&path) else {
        return Vec::new();
    };
    let Ok(value) = serde_json::from_str::<Value>(&raw) else {
        return Vec::new();
    };
    value
        .get("imports")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.get("name").and_then(Value::as_str))
                .filter(|name| !name.trim().is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn import_owner(imports: &[String], server_name: &str) -> Option<String> {
    let needle = server_name.to_ascii_lowercase();
    imports
        .iter()
        .find(|import| needle.starts_with(&import.to_ascii_lowercase()))
        .cloned()
}

fn empty_snapshot(agent: McpAgent, scope: McpScope, path: Option<PathBuf>) -> McpAgentSnapshot {
    McpAgentSnapshot {
        agent,
        scope,
        source_path: path.map(|p| p.to_string_lossy().to_string()),
        exists: false,
        writable: false,
        parse_error: None,
        mtime_ms: 0,
        servers: Vec::new(),
    }
}

fn read_servers(
    agent: McpAgent,
    scope: McpScope,
    path: &Path,
    mtime_ms: u64,
    len: u64,
) -> Result<Vec<McpServer>, String> {
    let key: CacheKey = (agent, scope, path.to_path_buf());
    if let Ok(guard) = cache().lock() {
        if let Some(entry) = guard.get(&key) {
            if entry.mtime_ms == mtime_ms && entry.len == len {
                return Ok(entry.servers.clone());
            }
        }
    }
    let raw = fs::read_to_string(path).map_err(|_| "unreadable".to_string())?;
    let servers = adapter(agent).parse(&raw)?;
    if let Ok(mut guard) = cache().lock() {
        guard.insert(
            key,
            CacheEntry {
                mtime_ms,
                len,
                servers: servers.clone(),
            },
        );
    }
    Ok(servers)
}

fn scan_agent(
    agent: McpAgent,
    scope: McpScope,
    repo: Option<&Path>,
    imports: &[String],
) -> McpAgentSnapshot {
    let Some(path) = adapter(agent).config_path(scope, repo) else {
        return empty_snapshot(agent, scope, None);
    };
    let Ok(metadata) = fs::metadata(&path) else {
        let mut snapshot = empty_snapshot(agent, scope, Some(path.clone()));
        snapshot.writable = is_writable(&path);
        return snapshot;
    };

    let mtime_ms = file_modified_ms(&metadata) as u64;
    let len = metadata.len();
    let source_path = path.to_string_lossy().to_string();
    let mut snapshot = McpAgentSnapshot {
        agent,
        scope,
        source_path: Some(source_path.clone()),
        exists: true,
        writable: !metadata.permissions().readonly(),
        parse_error: None,
        mtime_ms,
        servers: Vec::new(),
    };

    match read_servers(agent, scope, &path, mtime_ms, len) {
        Ok(servers) => {
            snapshot.servers = servers
                .into_iter()
                .map(|server| {
                    let managed_by_import = if agent == McpAgent::Antigravity {
                        import_owner(imports, &server.name)
                    } else {
                        None
                    };
                    McpServerRecord {
                        server,
                        agent,
                        scope,
                        source_path: source_path.clone(),
                        managed_by_import,
                    }
                    .view()
                })
                .collect();
        }
        Err(error) => {
            snapshot.parse_error = Some(error);
            snapshot.writable = false;
        }
    }
    snapshot
}

fn scan_inner(
    scope: McpScope,
    repo: Option<String>,
    agents: Option<Vec<String>>,
) -> Vec<McpAgentSnapshot> {
    let repo = repo_path(repo);
    let repo_ref = repo.as_deref();
    let picked = requested_agents(agents);
    let imports = if picked.contains(&McpAgent::Antigravity) {
        antigravity_imports()
    } else {
        Vec::new()
    };
    picked
        .into_iter()
        .map(|agent| scan_agent(agent, scope, repo_ref, &imports))
        .collect()
}

fn config_paths_inner(scope: McpScope, repo: Option<String>) -> Vec<McpConfigPath> {
    let repo = repo_path(repo);
    let repo_ref = repo.as_deref();
    ALL_MCP_AGENTS
        .iter()
        .map(|agent| {
            let path = adapter(*agent).config_path(scope, repo_ref);
            McpConfigPath {
                agent: *agent,
                scope,
                exists: path.as_ref().map(|p| p.is_file()).unwrap_or(false),
                supported: path.is_some(),
                path: path.map(|p| p.to_string_lossy().to_string()),
            }
        })
        .collect()
}

#[tauri::command]
pub async fn mcp_scan(
    scope: McpScope,
    repo: Option<String>,
    agents: Option<Vec<String>>,
) -> Result<Vec<McpAgentSnapshot>, String> {
    tokio::task::spawn_blocking(move || scan_inner(scope, repo, agents))
        .await
        .map_err(|error| format!("mcp_scan:{error}"))
}

#[tauri::command]
pub async fn mcp_config_paths(
    scope: McpScope,
    repo: Option<String>,
) -> Result<Vec<McpConfigPath>, String> {
    tokio::task::spawn_blocking(move || config_paths_inner(scope, repo))
        .await
        .map_err(|error| format!("mcp_config_paths:{error}"))
}

#[tauri::command]
pub fn mcp_capabilities() -> Vec<McpCapability> {
    ALL_MCP_AGENTS.iter().map(|agent| capability(*agent)).collect()
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpEnvInput {
    pub key: String,
    #[serde(default)]
    pub value: Option<String>,
    #[serde(default)]
    pub passthrough_from: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum McpTransportInput {
    Stdio {
        command: String,
        #[serde(default)]
        args: Vec<String>,
        #[serde(default)]
        cwd: Option<String>,
    },
    Http {
        url: String,
        #[serde(default)]
        headers: Vec<McpEnvInput>,
    },
    Sse {
        url: String,
        #[serde(default)]
        headers: Vec<McpEnvInput>,
    },
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerInput {
    pub name: String,
    pub transport: McpTransportInput,
    #[serde(default)]
    pub env: Vec<McpEnvInput>,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub timeouts: McpTimeouts,
    #[serde(default)]
    pub bearer_token_env_var: Option<String>,
}

fn env_map(inputs: &[McpEnvInput]) -> EnvMap {
    inputs
        .iter()
        .filter(|input| !input.key.trim().is_empty())
        .map(|input| {
            (
                input.key.trim().to_string(),
                EnvEntry {
                    literal: input.value.clone(),
                    passthrough_from: input.passthrough_from.clone(),
                },
            )
        })
        .collect()
}

fn to_server(input: McpServerInput) -> Result<McpServer, String> {
    let name = input.name.trim().to_string();
    if name.is_empty() || name.contains(['/', '\\', '"', '\n']) {
        return Err("invalid_name".to_string());
    }
    let transport = match input.transport {
        McpTransportInput::Stdio { command, args, cwd } => {
            if command.trim().is_empty() {
                return Err("invalid_command".to_string());
            }
            McpTransport::Stdio {
                command: command.trim().to_string(),
                args,
                cwd,
            }
        }
        McpTransportInput::Http { url, headers } => {
            if url.trim().is_empty() {
                return Err("invalid_url".to_string());
            }
            McpTransport::Http {
                url: url.trim().to_string(),
                headers: env_map(&headers),
            }
        }
        McpTransportInput::Sse { url, headers } => {
            if url.trim().is_empty() {
                return Err("invalid_url".to_string());
            }
            McpTransport::Sse {
                url: url.trim().to_string(),
                headers: env_map(&headers),
            }
        }
    };
    Ok(McpServer {
        name,
        transport,
        env: env_map(&input.env),
        enabled: input.enabled,
        timeouts: input.timeouts,
        bearer_token_env_var: input.bearer_token_env_var,
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpWriteReport {
    pub path: String,
    pub backup_path: Option<String>,
    pub changed: Vec<String>,
    pub warnings: Vec<String>,
}

enum Mutation {
    Upsert(Box<McpServer>),
    Remove(String),
    SetEnabled(String, bool),
}

impl Mutation {
    fn target(&self) -> &str {
        match self {
            Mutation::Upsert(server) => &server.name,
            Mutation::Remove(name) | Mutation::SetEnabled(name, _) => name,
        }
    }
}

const MAX_BACKUPS: usize = 10;

fn backup_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    Some(
        crate::paths::profile_data_dir(app)
            .ok()?
            .join("mcp")
            .join("backups"),
    )
}

fn backup(dir: &Path, agent: McpAgent, scope: McpScope, path: &Path) -> Option<String> {
    fs::create_dir_all(dir).ok()?;
    let extension = path
        .extension()
        .map(|ext| ext.to_string_lossy().to_string())
        .unwrap_or_else(|| "bak".to_string());
    let prefix = format!("{}-{}-", agent.as_str(), scope.as_str());
    let target = dir.join(format!(
        "{prefix}{}.{extension}",
        crate::provider_common::now_ms()
    ));
    fs::copy(path, &target).ok()?;
    prune_backups(dir, &prefix);
    Some(target.to_string_lossy().to_string())
}

fn prune_backups(dir: &Path, prefix: &str) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut matching: Vec<PathBuf> = entries
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .map(|name| name.to_string_lossy().starts_with(prefix))
                .unwrap_or(false)
        })
        .collect();
    if matching.len() <= MAX_BACKUPS {
        return;
    }
    matching.sort();
    for stale in &matching[..matching.len() - MAX_BACKUPS] {
        let _ = fs::remove_file(stale);
    }
}

fn atomic_write(path: &Path, contents: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("mkdir_failed:{error}"))?;
    }
    let mut tmp = path.as_os_str().to_os_string();
    tmp.push(".alethe-tmp");
    let tmp = PathBuf::from(tmp);
    fs::write(&tmp, contents).map_err(|error| format!("write_failed:{error}"))?;
    fs::rename(&tmp, path).map_err(|error| {
        let _ = fs::remove_file(&tmp);
        format!("write_failed:{error}")
    })
}

fn other_names(servers: &[McpServer], target: &str) -> Vec<String> {
    let mut names: Vec<String> = servers
        .iter()
        .map(|server| server.name.clone())
        .filter(|name| name != target)
        .collect();
    names.sort();
    names
}

fn mutate(
    app: &tauri::AppHandle,
    agent: McpAgent,
    scope: McpScope,
    repo: Option<String>,
    mutation: Mutation,
) -> Result<McpWriteReport, String> {
    let repo = repo_path(repo);
    let Some(path) = adapter(agent).config_path(scope, repo.as_deref()) else {
        return Err("unsupported_scope".to_string());
    };
    apply_to_file(agent, scope, &path, mutation, backup_dir(app).as_deref())
}

/// The whole dangerous part: parse, guard, generate, re-validate, back up, write atomically.
/// Takes an explicit path so it can be exercised against a scratch file.
fn apply_to_file(
    agent: McpAgent,
    scope: McpScope,
    path: &Path,
    mutation: Mutation,
    backups: Option<&Path>,
) -> Result<McpWriteReport, String> {
    if path.extension().map(|ext| ext == "jsonc").unwrap_or(false) {
        return Err("jsonc_unsupported".to_string());
    }

    let exists = path.is_file();
    let raw = if exists {
        fs::read_to_string(path).map_err(|_| "unreadable".to_string())?
    } else {
        if matches!(mutation, Mutation::Remove(_) | Mutation::SetEnabled(_, _)) {
            return Err("not_found".to_string());
        }
        String::new()
    };

    let before = adapter(agent).parse(&raw)?;
    let target = mutation.target().to_string();
    let expected_others = other_names(&before, &target);

    let mut warnings = Vec::new();
    if agent == McpAgent::Antigravity {
        if let Some(owner) = import_owner(&antigravity_imports(), &target) {
            warnings.push(format!("managed_by_import:{owner}"));
        }
    }
    if let Mutation::Upsert(server) = &mutation {
        let blocked = crate::mcp_model::unsupported_fields(agent, server);
        if !blocked.is_empty() {
            let fields: Vec<String> = blocked.into_iter().map(|item| item.field).collect();
            return Err(format!("unsupported_fields:{}", fields.join(",")));
        }
    }

    let next = match &mutation {
        Mutation::Upsert(server) => adapter(agent).upsert(&raw, server)?,
        Mutation::Remove(name) => adapter(agent).remove(&raw, name)?,
        Mutation::SetEnabled(name, on) => adapter(agent).set_enabled(&raw, name, *on)?,
    };

    let after = adapter(agent)
        .parse(&next)
        .map_err(|_| "self_check_failed".to_string())?;
    if other_names(&after, &target) != expected_others {
        return Err("self_check_failed".to_string());
    }

    let backup_path = match (exists, backups) {
        (true, Some(dir)) => backup(dir, agent, scope, path),
        _ => None,
    };
    atomic_write(path, &next)?;
    invalidate(agent, scope, path);

    Ok(McpWriteReport {
        path: path.to_string_lossy().to_string(),
        backup_path,
        changed: vec![target],
        warnings,
    })
}

#[tauri::command]
pub async fn mcp_upsert(
    app: tauri::AppHandle,
    agent: String,
    scope: McpScope,
    repo: Option<String>,
    server: McpServerInput,
) -> Result<McpWriteReport, String> {
    let agent = McpAgent::parse(&agent).ok_or_else(|| "unknown_agent".to_string())?;
    let server = to_server(server)?;
    tokio::task::spawn_blocking(move || {
        mutate(&app, agent, scope, repo, Mutation::Upsert(Box::new(server)))
    })
    .await
    .map_err(|error| format!("mcp_upsert:{error}"))?
}

#[tauri::command]
pub async fn mcp_remove(
    app: tauri::AppHandle,
    agent: String,
    scope: McpScope,
    repo: Option<String>,
    name: String,
) -> Result<McpWriteReport, String> {
    let agent = McpAgent::parse(&agent).ok_or_else(|| "unknown_agent".to_string())?;
    tokio::task::spawn_blocking(move || mutate(&app, agent, scope, repo, Mutation::Remove(name)))
        .await
        .map_err(|error| format!("mcp_remove:{error}"))?
}

#[tauri::command]
pub async fn mcp_set_enabled(
    app: tauri::AppHandle,
    agent: String,
    scope: McpScope,
    repo: Option<String>,
    name: String,
    enabled: bool,
) -> Result<McpWriteReport, String> {
    let agent = McpAgent::parse(&agent).ok_or_else(|| "unknown_agent".to_string())?;
    tokio::task::spawn_blocking(move || {
        mutate(&app, agent, scope, repo, Mutation::SetEnabled(name, enabled))
    })
    .await
    .map_err(|error| format!("mcp_set_enabled:{error}"))?
}

fn reveal_inner(
    agent: McpAgent,
    scope: McpScope,
    repo: Option<String>,
    name: String,
    key: String,
    header: bool,
) -> Result<String, String> {
    let repo = repo_path(repo);
    let Some(path) = adapter(agent).config_path(scope, repo.as_deref()) else {
        return Err("unsupported_scope".to_string());
    };
    let raw = fs::read_to_string(&path).map_err(|_| "unreadable".to_string())?;
    let servers = adapter(agent).parse(&raw)?;
    let server = servers
        .into_iter()
        .find(|item| item.name == name)
        .ok_or_else(|| "not_found".to_string())?;
    let source = if header {
        server
            .transport
            .headers()
            .cloned()
            .ok_or_else(|| "not_found".to_string())?
    } else {
        server.env
    };
    source
        .get(&key)
        .and_then(|entry| entry.literal.clone())
        .ok_or_else(|| "not_found".to_string())
}

/// The only path by which a stored value reaches the webview, one key per click.
#[tauri::command]
pub async fn mcp_reveal_env(
    agent: String,
    scope: McpScope,
    repo: Option<String>,
    name: String,
    key: String,
    header: Option<bool>,
) -> Result<String, String> {
    let agent = McpAgent::parse(&agent).ok_or_else(|| "unknown_agent".to_string())?;
    tokio::task::spawn_blocking(move || {
        reveal_inner(agent, scope, repo, name, key, header.unwrap_or(false))
    })
    .await
    .map_err(|error| format!("mcp_reveal_env:{error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn import_owner_matches_a_prefixed_server_name() {
        let imports = vec!["codeagentswarm".to_string()];
        assert_eq!(
            import_owner(&imports, "codeagentswarm-tasks"),
            Some("codeagentswarm".to_string())
        );
        assert_eq!(import_owner(&imports, "figma"), None);
    }

    #[test]
    fn requested_agents_falls_back_to_every_agent() {
        assert_eq!(requested_agents(None).len(), 4);
        assert_eq!(requested_agents(Some(vec!["nonsense".into()])).len(), 4);
        assert_eq!(requested_agents(Some(vec!["codex".into()])), vec![McpAgent::Codex]);
        assert_eq!(
            requested_agents(Some(vec!["agy".into()])),
            vec![McpAgent::Antigravity]
        );
    }

    #[test]
    fn repo_path_ignores_blank_input() {
        assert!(repo_path(None).is_none());
        assert!(repo_path(Some("   ".to_string())).is_none());
        assert!(repo_path(Some("D:/repo".to_string())).is_some());
    }

    #[test]
    fn a_missing_config_is_not_an_error() {
        let snapshot = scan_agent(
            McpAgent::Codex,
            McpScope::Project,
            Some(Path::new("D:/definitely/not/a/repo")),
            &[],
        );
        assert!(!snapshot.exists);
        assert!(snapshot.parse_error.is_none());
        assert!(snapshot.servers.is_empty());
    }

    const CODEX_REAL_SHAPE: &str = r#"# hand written
model = "gpt-5.6-sol"

[projects."D:\\repo\\one"]
trust_level = "trusted"

[mcp_servers.discord]
command = "npx"
args = ["-y", "@quadslab.io/discord-mcp"]

[mcp_servers.discord.env]
DISCORD_TOKEN = "a-live-secret-token-value"

[[hooks.PreToolUse]]
name = "gate"
"#;

    fn scratch(name: &str) -> PathBuf {
        static COUNTER: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let index = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "alethe-mcp-test-{}-{index}-{name}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("scratch dir");
        dir
    }

    fn probe_server(name: &str) -> McpServer {
        McpServer {
            name: name.to_string(),
            transport: McpTransport::Stdio {
                command: "node".to_string(),
                args: vec!["-e".to_string(), "0".to_string()],
                cwd: None,
            },
            env: EnvMap::new(),
            enabled: true,
            timeouts: McpTimeouts::default(),
            bearer_token_env_var: None,
        }
    }

    #[test]
    fn writing_backs_up_and_leaves_the_rest_of_the_file_alone() {
        let dir = scratch("codex-write");
        let config = dir.join("config.toml");
        let backups = dir.join("backups");
        fs::write(&config, CODEX_REAL_SHAPE).expect("fixture");

        let report = apply_to_file(
            McpAgent::Codex,
            McpScope::Global,
            &config,
            Mutation::Upsert(Box::new(probe_server("alethe-probe"))),
            Some(&backups),
        )
        .expect("writes");

        assert_eq!(report.changed, vec!["alethe-probe".to_string()]);
        let backup_path = report.backup_path.expect("backed up");
        assert_eq!(
            fs::read_to_string(&backup_path).expect("backup readable"),
            CODEX_REAL_SHAPE
        );

        let written = fs::read_to_string(&config).expect("written");
        assert!(written.contains("# hand written"));
        assert!(written.contains("[projects.\"D:\\\\repo\\\\one\"]"));
        assert!(written.contains("[[hooks.PreToolUse]]"));
        assert!(written.contains("[mcp_servers.discord.env]"));
        assert!(written.contains("a-live-secret-token-value"));
        assert!(written.contains("alethe-probe"));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn removing_drops_the_server_and_its_subtable_only() {
        let dir = scratch("codex-remove");
        let config = dir.join("config.toml");
        fs::write(&config, CODEX_REAL_SHAPE).expect("fixture");

        apply_to_file(
            McpAgent::Codex,
            McpScope::Global,
            &config,
            Mutation::Remove("discord".to_string()),
            None,
        )
        .expect("removes");

        let written = fs::read_to_string(&config).expect("written");
        assert!(!written.contains("a-live-secret-token-value"));
        assert!(!written.contains("[mcp_servers.discord"));
        assert!(written.contains("[[hooks.PreToolUse]]"));
        assert!(written.contains("trust_level"));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_upsert_creates_a_missing_project_config() {
        let dir = scratch("claude-create");
        let config = dir.join(".mcp.json");

        apply_to_file(
            McpAgent::Claude,
            McpScope::Project,
            &config,
            Mutation::Upsert(Box::new(probe_server("alethe-probe"))),
            None,
        )
        .expect("writes");

        let written = fs::read_to_string(&config).expect("written");
        assert!(written.contains("\"mcpServers\""));
        assert!(written.contains("alethe-probe"));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_field_the_agent_cannot_express_blocks_the_write() {
        let dir = scratch("claude-block");
        let config = dir.join(".mcp.json");
        fs::write(&config, "{}").expect("fixture");

        let mut server = probe_server("alethe-probe");
        server
            .env
            .insert("TOKEN".to_string(), EnvEntry::passthrough("TOKEN"));

        let error = apply_to_file(
            McpAgent::Claude,
            McpScope::Project,
            &config,
            Mutation::Upsert(Box::new(server)),
            None,
        )
        .unwrap_err();

        assert_eq!(error, "unsupported_fields:env.TOKEN");
        assert_eq!(fs::read_to_string(&config).expect("unchanged"), "{}");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_unparsable_config_is_never_written_to() {
        let dir = scratch("broken");
        let config = dir.join("opencode.json");
        fs::write(&config, "{\"mcp\":{}}}}").expect("fixture");

        let error = apply_to_file(
            McpAgent::Opencode,
            McpScope::Global,
            &config,
            Mutation::Upsert(Box::new(probe_server("alethe-probe"))),
            None,
        )
        .unwrap_err();

        assert!(error.starts_with("unparsable"));
        assert_eq!(
            fs::read_to_string(&config).expect("unchanged"),
            "{\"mcp\":{}}}}"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn jsonc_is_refused_rather_than_stripped() {
        let dir = scratch("jsonc");
        let config = dir.join("opencode.jsonc");
        fs::write(&config, "// keep me\n{\"mcp\":{}}").expect("fixture");

        let error = apply_to_file(
            McpAgent::Opencode,
            McpScope::Global,
            &config,
            Mutation::Upsert(Box::new(probe_server("alethe-probe"))),
            None,
        )
        .unwrap_err();

        assert_eq!(error, "jsonc_unsupported");
        assert!(fs::read_to_string(&config).expect("unchanged").contains("// keep me"));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn mutating_a_missing_file_reports_not_found() {
        let dir = scratch("absent");
        let config = dir.join("config.toml");
        let error = apply_to_file(
            McpAgent::Codex,
            McpScope::Global,
            &config,
            Mutation::Remove("ghost".to_string()),
            None,
        )
        .unwrap_err();
        assert_eq!(error, "not_found");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn backups_are_capped() {
        let dir = scratch("prune");
        let backups = dir.join("backups");
        fs::create_dir_all(&backups).expect("dir");
        for index in 0..(MAX_BACKUPS + 4) {
            fs::write(backups.join(format!("codex-global-{index:04}.toml")), "x").expect("write");
        }
        prune_backups(&backups, "codex-global-");
        let kept = fs::read_dir(&backups).expect("read").count();
        assert_eq!(kept, MAX_BACKUPS);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn antigravity_reports_no_project_config() {
        let snapshot = scan_agent(
            McpAgent::Antigravity,
            McpScope::Project,
            Some(Path::new("D:/repo")),
            &[],
        );
        assert!(snapshot.source_path.is_none());
        assert!(!snapshot.exists);
    }
}
