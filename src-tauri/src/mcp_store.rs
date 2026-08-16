use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::mcp_agents::{adapter, McpSource};
use crate::mcp_model::{
    capability, EnvEntry, EnvMap, McpAgent, McpAgentSnapshot, McpCapability, McpScope, McpServer,
    McpServerRecord, McpSourceKind, McpSourceState, McpTimeouts, McpTransport, ALL_MCP_AGENTS,
};
use crate::provider_common::file_modified_ms;

type CacheKey = (McpAgent, McpSourceKind, PathBuf, Option<String>);

struct CacheEntry {
    mtime_ms: u64,
    len: u64,
    servers: Vec<McpServer>,
}

static SCAN_CACHE: OnceLock<Mutex<HashMap<CacheKey, CacheEntry>>> = OnceLock::new();

fn cache() -> &'static Mutex<HashMap<CacheKey, CacheEntry>> {
    SCAN_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cache_key(agent: McpAgent, source: &McpSource) -> CacheKey {
    (
        agent,
        source.kind,
        source.path.clone(),
        source.project_key.clone(),
    )
}

fn invalidate(agent: McpAgent, source: &McpSource) {
    if let Ok(mut guard) = cache().lock() {
        guard.remove(&cache_key(agent, source));
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpConfigPath {
    pub agent: McpAgent,
    pub scope: McpScope,
    pub kind: McpSourceKind,
    pub path: String,
    pub exists: bool,
}

fn requested_agents(agents: Option<Vec<String>>) -> Vec<McpAgent> {
    match agents {
        Some(list) => {
            let picked: Vec<McpAgent> =
                list.iter().filter_map(|raw| McpAgent::parse(raw)).collect();
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
        Err(_) => path.parent().map(|parent| parent.is_dir()).unwrap_or(false),
    }
}

/// Antigravity records plugin-contributed configuration in an import manifest but does
/// not name the servers it added, so a contributed server is matched by name prefix.
fn antigravity_imports() -> Vec<String> {
    let Some(path) = adapter(McpAgent::Antigravity)
        .config_sources(McpScope::Global, None)
        .first()
        .and_then(|source| {
            source
                .path
                .parent()
                .map(|dir| dir.join("import_manifest.json"))
        })
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

fn read_servers(
    agent: McpAgent,
    source: &McpSource,
    mtime_ms: u64,
    len: u64,
) -> Result<Vec<McpServer>, String> {
    let key = cache_key(agent, source);
    if let Ok(guard) = cache().lock() {
        if let Some(entry) = guard.get(&key) {
            if entry.mtime_ms == mtime_ms && entry.len == len {
                return Ok(entry.servers.clone());
            }
        }
    }
    let raw = fs::read_to_string(&source.path).map_err(|_| "unreadable".to_string())?;
    let servers = adapter(agent).parse(&raw, source)?;
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
    let mut snapshot = McpAgentSnapshot {
        agent,
        scope,
        sources: Vec::new(),
        servers: Vec::new(),
    };

    for source in adapter(agent).config_sources(scope, repo) {
        let display_path = source.path.to_string_lossy().to_string();
        let Ok(metadata) = fs::metadata(&source.path) else {
            snapshot.sources.push(McpSourceState {
                kind: source.kind,
                path: display_path,
                exists: false,
                writable: is_writable(&source.path),
                parse_error: None,
                mtime_ms: 0,
            });
            continue;
        };

        let mtime_ms = file_modified_ms(&metadata) as u64;
        let mut state = McpSourceState {
            kind: source.kind,
            path: display_path.clone(),
            exists: true,
            writable: !metadata.permissions().readonly(),
            parse_error: None,
            mtime_ms,
        };

        match read_servers(agent, &source, mtime_ms, metadata.len()) {
            Ok(servers) => {
                for server in servers {
                    let managed_by_import = if agent == McpAgent::Antigravity {
                        import_owner(imports, &server.name)
                    } else {
                        None
                    };
                    snapshot.servers.push(
                        McpServerRecord {
                            server,
                            agent,
                            scope,
                            source_kind: source.kind,
                            source_path: display_path.clone(),
                            managed_by_import,
                        }
                        .view(),
                    );
                }
            }
            Err(error) => {
                state.parse_error = Some(error);
                state.writable = false;
            }
        }
        snapshot.sources.push(state);
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
        .flat_map(|agent| {
            adapter(*agent)
                .config_sources(scope, repo_ref)
                .into_iter()
                .map(move |source| McpConfigPath {
                    agent: *agent,
                    scope,
                    kind: source.kind,
                    exists: source.path.is_file(),
                    path: source.path.to_string_lossy().to_string(),
                })
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
    ALL_MCP_AGENTS
        .iter()
        .map(|agent| capability(*agent))
        .collect()
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
    pub kind: McpSourceKind,
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

    fn creates(&self) -> bool {
        matches!(self, Mutation::Upsert(_))
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

fn backup(dir: &Path, agent: McpAgent, kind: McpSourceKind, path: &Path) -> Option<String> {
    fs::create_dir_all(dir).ok()?;
    let extension = path
        .extension()
        .map(|ext| ext.to_string_lossy().to_string())
        .unwrap_or_else(|| "bak".to_string());
    let prefix = format!("{}-{}-", agent.as_str(), kind.as_str());
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
    // A fresh temp file is created with the default mode, which would widen a config the
    // user deliberately locked down to 0600.
    #[cfg(unix)]
    if let Ok(metadata) = fs::metadata(path) {
        let _ = fs::set_permissions(&tmp, metadata.permissions());
    }
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

/// Picks which file the mutation lands in. An existing server is edited where it already
/// lives; a new one goes to the agent's first source, which for Claude at project scope is
/// the `local` entry inside `~/.claude.json` — the same place `claude mcp add` writes.
fn pick_source(
    agent: McpAgent,
    scope: McpScope,
    repo: Option<&Path>,
    name: &str,
    wanted: Option<McpSourceKind>,
    creating: bool,
) -> Result<McpSource, String> {
    let sources = adapter(agent).config_sources(scope, repo);
    if sources.is_empty() {
        return Err("unsupported_scope".to_string());
    }
    if let Some(kind) = wanted {
        return sources
            .into_iter()
            .find(|source| source.kind == kind)
            .ok_or_else(|| "unsupported_scope".to_string());
    }
    for source in &sources {
        let Ok(raw) = fs::read_to_string(&source.path) else {
            continue;
        };
        let Ok(servers) = adapter(agent).parse(&raw, source) else {
            continue;
        };
        if servers.iter().any(|server| server.name == name) {
            return Ok(source.clone());
        }
    }
    if creating {
        Ok(sources.into_iter().next().expect("sources is not empty"))
    } else {
        Err("not_found".to_string())
    }
}

/// The whole dangerous part: parse, guard, generate, re-validate, back up, write atomically.
/// Takes an explicit source so it can be exercised against a scratch file.
fn apply_to_source(
    agent: McpAgent,
    source: &McpSource,
    mutation: Mutation,
    backups: Option<&Path>,
) -> Result<McpWriteReport, String> {
    let path = source.path.as_path();
    if path.extension().map(|ext| ext == "jsonc").unwrap_or(false) {
        return Err("jsonc_unsupported".to_string());
    }

    let exists = path.is_file();
    let raw = if exists {
        fs::read_to_string(path).map_err(|_| "unreadable".to_string())?
    } else {
        if !mutation.creates() {
            return Err("not_found".to_string());
        }
        String::new()
    };

    let before = adapter(agent).parse(&raw, source)?;
    let target = mutation.target().to_string();
    let expected_others = other_names(&before, &target);

    if let Mutation::Upsert(server) = &mutation {
        let blocked = crate::mcp_model::unsupported_fields(agent, server);
        if !blocked.is_empty() {
            let fields: Vec<String> = blocked.into_iter().map(|item| item.field).collect();
            return Err(format!("unsupported_fields:{}", fields.join(",")));
        }
    }

    let next = match &mutation {
        Mutation::Upsert(server) => adapter(agent).upsert(&raw, source, server)?,
        Mutation::Remove(name) => adapter(agent).remove(&raw, source, name)?,
        Mutation::SetEnabled(name, on) => adapter(agent).set_enabled(&raw, source, name, *on)?,
    };

    let after = adapter(agent)
        .parse(&next, source)
        .map_err(|_| "self_check_failed".to_string())?;
    if other_names(&after, &target) != expected_others {
        return Err("self_check_failed".to_string());
    }

    let backup_path = match (exists, backups) {
        (true, Some(dir)) => backup(dir, agent, source.kind, path),
        _ => None,
    };
    atomic_write(path, &next)?;
    invalidate(agent, source);

    Ok(McpWriteReport {
        path: path.to_string_lossy().to_string(),
        kind: source.kind,
        backup_path,
        changed: vec![target],
        warnings: Vec::new(),
    })
}

fn mutate(
    app: &tauri::AppHandle,
    agent: McpAgent,
    scope: McpScope,
    repo: Option<String>,
    source_kind: Option<McpSourceKind>,
    mutation: Mutation,
) -> Result<McpWriteReport, String> {
    let repo = repo_path(repo);
    let target = mutation.target().to_string();
    let source = pick_source(
        agent,
        scope,
        repo.as_deref(),
        &target,
        source_kind,
        mutation.creates(),
    )?;

    let mut warnings = Vec::new();
    if agent == McpAgent::Antigravity {
        if let Some(owner) = import_owner(&antigravity_imports(), &target) {
            warnings.push(format!("managed_by_import:{owner}"));
        }
    }

    let mut report = apply_to_source(agent, &source, mutation, backup_dir(app).as_deref())?;
    report.warnings = warnings;
    Ok(report)
}

fn parse_source_kind(raw: Option<String>) -> Result<Option<McpSourceKind>, String> {
    match raw {
        None => Ok(None),
        Some(value) => McpSourceKind::parse(&value)
            .map(Some)
            .ok_or_else(|| "unsupported_scope".to_string()),
    }
}

#[tauri::command]
pub async fn mcp_upsert(
    app: tauri::AppHandle,
    agent: String,
    scope: McpScope,
    repo: Option<String>,
    server: McpServerInput,
    source_kind: Option<String>,
) -> Result<McpWriteReport, String> {
    let agent = McpAgent::parse(&agent).ok_or_else(|| "unknown_agent".to_string())?;
    let kind = parse_source_kind(source_kind)?;
    let server = to_server(server)?;
    tokio::task::spawn_blocking(move || {
        mutate(
            &app,
            agent,
            scope,
            repo,
            kind,
            Mutation::Upsert(Box::new(server)),
        )
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
    source_kind: Option<String>,
) -> Result<McpWriteReport, String> {
    let agent = McpAgent::parse(&agent).ok_or_else(|| "unknown_agent".to_string())?;
    let kind = parse_source_kind(source_kind)?;
    tokio::task::spawn_blocking(move || {
        mutate(&app, agent, scope, repo, kind, Mutation::Remove(name))
    })
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
    source_kind: Option<String>,
) -> Result<McpWriteReport, String> {
    let agent = McpAgent::parse(&agent).ok_or_else(|| "unknown_agent".to_string())?;
    let kind = parse_source_kind(source_kind)?;
    tokio::task::spawn_blocking(move || {
        mutate(
            &app,
            agent,
            scope,
            repo,
            kind,
            Mutation::SetEnabled(name, enabled),
        )
    })
    .await
    .map_err(|error| format!("mcp_set_enabled:{error}"))?
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpSyncOutcome {
    pub agent: McpAgent,
    pub status: &'static str,
    pub unsupported: Vec<crate::mcp_model::UnsupportedField>,
    pub error: Option<String>,
    pub path: Option<String>,
}

fn read_server(
    agent: McpAgent,
    scope: McpScope,
    repo: Option<&Path>,
    name: &str,
) -> Result<McpServer, String> {
    let sources = adapter(agent).config_sources(scope, repo);
    if sources.is_empty() {
        return Err("unsupported_scope".to_string());
    }
    for source in &sources {
        let Ok(raw) = fs::read_to_string(&source.path) else {
            continue;
        };
        let Ok(servers) = adapter(agent).parse(&raw, source) else {
            continue;
        };
        if let Some(server) = servers.into_iter().find(|server| server.name == name) {
            return Ok(server);
        }
    }
    Err("not_found".to_string())
}

/// Copies one server between agents entirely inside the backend, so a stored secret is
/// never round-tripped through the webview to be written somewhere else.
fn sync_inner(
    app: &tauri::AppHandle,
    from: McpAgent,
    targets: Vec<McpAgent>,
    scope: McpScope,
    repo: Option<String>,
    name: String,
    overwrite: bool,
) -> Result<Vec<McpSyncOutcome>, String> {
    let repo = repo_path(repo);
    let source = read_server(from, scope, repo.as_deref(), &name)?;
    let backups = backup_dir(app);

    let outcomes = targets
        .into_iter()
        .filter(|agent| *agent != from)
        .map(|agent| {
            let unsupported = crate::mcp_model::unsupported_fields(agent, &source);
            if !unsupported.is_empty() {
                return McpSyncOutcome {
                    agent,
                    status: "blocked",
                    unsupported,
                    error: None,
                    path: None,
                };
            }
            if !overwrite && read_server(agent, scope, repo.as_deref(), &name).is_ok() {
                return McpSyncOutcome {
                    agent,
                    status: "skipped",
                    unsupported: Vec::new(),
                    error: None,
                    path: None,
                };
            }
            let target = match pick_source(agent, scope, repo.as_deref(), &name, None, true) {
                Ok(target) => target,
                Err(error) => {
                    return McpSyncOutcome {
                        agent,
                        status: "failed",
                        unsupported: Vec::new(),
                        error: Some(error),
                        path: None,
                    }
                }
            };
            match apply_to_source(
                agent,
                &target,
                Mutation::Upsert(Box::new(source.clone())),
                backups.as_deref(),
            ) {
                Ok(report) => McpSyncOutcome {
                    agent,
                    status: "written",
                    unsupported: Vec::new(),
                    error: None,
                    path: Some(report.path),
                },
                Err(error) => McpSyncOutcome {
                    agent,
                    status: "failed",
                    unsupported: Vec::new(),
                    error: Some(error),
                    path: None,
                },
            }
        })
        .collect();

    Ok(outcomes)
}

#[tauri::command]
pub async fn mcp_sync(
    app: tauri::AppHandle,
    from: String,
    to: Vec<String>,
    scope: McpScope,
    repo: Option<String>,
    name: String,
    overwrite: Option<bool>,
) -> Result<Vec<McpSyncOutcome>, String> {
    let from = McpAgent::parse(&from).ok_or_else(|| "unknown_agent".to_string())?;
    let targets: Vec<McpAgent> = to.iter().filter_map(|raw| McpAgent::parse(raw)).collect();
    if targets.is_empty() {
        return Err("unknown_agent".to_string());
    }
    tokio::task::spawn_blocking(move || {
        sync_inner(
            &app,
            from,
            targets,
            scope,
            repo,
            name,
            overwrite.unwrap_or(false),
        )
    })
    .await
    .map_err(|error| format!("mcp_sync:{error}"))?
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
    let server = read_server(agent, scope, repo.as_deref(), &name)?;
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

    /// The real `~/.claude.json` shape: `claude mcp add` writes to `projects.<cwd>.mcpServers`,
    /// not to the top-level `mcpServers`.
    const CLAUDE_REAL_SHAPE: &str = r#"{
  "numStartups": 1871,
  "mcpServers": {
    "higgsfield": { "type": "http", "url": "https://mcp.higgsfield.ai/mcp" }
  },
  "projects": {
    "D:/kauam/Documents/Github/Verzel/Retaguarda/Ret-Campanhas": {
      "allowedTools": [],
      "mcpServers": {
        "azure-devops": {
          "type": "stdio",
          "command": "npx",
          "args": ["-y", "@azure-devops/mcp", "GrupoAvenida"],
          "env": {}
        }
      },
      "hasTrustDialogAccepted": true
    }
  }
}"#;

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

    fn file_source(path: PathBuf, kind: McpSourceKind) -> McpSource {
        McpSource {
            path,
            kind,
            project_key: None,
        }
    }

    fn local_source(path: PathBuf, key: &str) -> McpSource {
        McpSource {
            path,
            kind: McpSourceKind::Local,
            project_key: Some(key.to_string()),
        }
    }

    #[test]
    fn claude_local_scope_reads_servers_from_the_projects_map() {
        let dir = scratch("claude-local-read");
        let config = dir.join(".claude.json");
        fs::write(&config, CLAUDE_REAL_SHAPE).expect("fixture");

        let source = local_source(
            config,
            r"D:\kauam\Documents\Github\Verzel\Retaguarda\Ret-Campanhas",
        );
        let servers = adapter(McpAgent::Claude)
            .parse(CLAUDE_REAL_SHAPE, &source)
            .expect("parses");

        assert_eq!(servers.len(), 1);
        assert_eq!(servers[0].name, "azure-devops");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn claude_global_scope_ignores_the_projects_map() {
        let source = file_source(PathBuf::from("x/.claude.json"), McpSourceKind::User);
        let servers = adapter(McpAgent::Claude)
            .parse(CLAUDE_REAL_SHAPE, &source)
            .expect("parses");
        assert_eq!(servers.len(), 1);
        assert_eq!(servers[0].name, "higgsfield");
    }

    #[test]
    fn claude_local_lookup_is_slash_and_case_insensitive() {
        let source = local_source(
            PathBuf::from("x/.claude.json"),
            r"d:\KAUAM\Documents\Github\Verzel\Retaguarda\Ret-Campanhas\",
        );
        let servers = adapter(McpAgent::Claude)
            .parse(CLAUDE_REAL_SHAPE, &source)
            .expect("parses");
        assert_eq!(servers.len(), 1);
    }

    #[test]
    fn claude_local_write_lands_in_the_matching_project_entry() {
        let dir = scratch("claude-local-write");
        let config = dir.join(".claude.json");
        fs::write(&config, CLAUDE_REAL_SHAPE).expect("fixture");
        let source = local_source(
            config.clone(),
            r"D:\kauam\Documents\Github\Verzel\Retaguarda\Ret-Campanhas",
        );

        apply_to_source(
            McpAgent::Claude,
            &source,
            Mutation::Upsert(Box::new(probe_server("alethe-probe"))),
            None,
        )
        .expect("writes");

        let written = fs::read_to_string(&config).expect("written");
        assert!(written.contains("azure-devops"));
        assert!(written.contains("alethe-probe"));
        assert!(written.contains("hasTrustDialogAccepted"));
        assert!(written.contains("numStartups"));

        let global = file_source(config.clone(), McpSourceKind::User);
        let global_servers = adapter(McpAgent::Claude)
            .parse(&written, &global)
            .expect("parses");
        assert_eq!(global_servers.len(), 1);
        assert_eq!(global_servers[0].name, "higgsfield");

        let local_servers = adapter(McpAgent::Claude)
            .parse(&written, &source)
            .expect("parses");
        assert_eq!(local_servers.len(), 2);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn claude_local_write_creates_the_project_entry_when_absent() {
        let dir = scratch("claude-local-new");
        let config = dir.join(".claude.json");
        fs::write(&config, "{\"numStartups\": 3}").expect("fixture");
        let source = local_source(config.clone(), r"D:\some\new\repo");

        apply_to_source(
            McpAgent::Claude,
            &source,
            Mutation::Upsert(Box::new(probe_server("alethe-probe"))),
            None,
        )
        .expect("writes");

        let written = fs::read_to_string(&config).expect("written");
        assert!(written.contains("\"D:/some/new/repo\""));
        assert!(written.contains("numStartups"));
        assert_eq!(
            adapter(McpAgent::Claude)
                .parse(&written, &source)
                .expect("parses")
                .len(),
            1
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn claude_project_scope_exposes_both_the_local_and_the_shared_file() {
        let repo = PathBuf::from("D:/repo");
        let sources = adapter(McpAgent::Claude).config_sources(McpScope::Project, Some(&repo));
        assert_eq!(sources.len(), 2);
        assert_eq!(sources[0].kind, McpSourceKind::Local);
        assert!(sources[0].path.ends_with(".claude.json"));
        assert_eq!(sources[1].kind, McpSourceKind::Project);
        assert!(sources[1].path.ends_with(".mcp.json"));
    }

    #[test]
    fn writing_backs_up_and_leaves_the_rest_of_the_file_alone() {
        let dir = scratch("codex-write");
        let config = dir.join("config.toml");
        let backups = dir.join("backups");
        fs::write(&config, CODEX_REAL_SHAPE).expect("fixture");

        let report = apply_to_source(
            McpAgent::Codex,
            &file_source(config.clone(), McpSourceKind::User),
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
        assert!(written.contains("alethe-probe"));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn removing_drops_the_server_and_its_subtable_only() {
        let dir = scratch("codex-remove");
        let config = dir.join("config.toml");
        fs::write(&config, CODEX_REAL_SHAPE).expect("fixture");

        apply_to_source(
            McpAgent::Codex,
            &file_source(config.clone(), McpSourceKind::User),
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

        apply_to_source(
            McpAgent::Claude,
            &file_source(config.clone(), McpSourceKind::Project),
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

        let error = apply_to_source(
            McpAgent::Claude,
            &file_source(config.clone(), McpSourceKind::Project),
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

        let error = apply_to_source(
            McpAgent::Opencode,
            &file_source(config.clone(), McpSourceKind::User),
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

        let error = apply_to_source(
            McpAgent::Opencode,
            &file_source(config.clone(), McpSourceKind::User),
            Mutation::Upsert(Box::new(probe_server("alethe-probe"))),
            None,
        )
        .unwrap_err();

        assert_eq!(error, "jsonc_unsupported");
        assert!(fs::read_to_string(&config)
            .expect("unchanged")
            .contains("// keep me"));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn mutating_a_missing_file_reports_not_found() {
        let dir = scratch("absent");
        let config = dir.join("config.toml");
        let error = apply_to_source(
            McpAgent::Codex,
            &file_source(config, McpSourceKind::User),
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
            fs::write(backups.join(format!("codex-user-{index:04}.toml")), "x").expect("write");
        }
        prune_backups(&backups, "codex-user-");
        let kept = fs::read_dir(&backups).expect("read").count();
        assert_eq!(kept, MAX_BACKUPS);
        let _ = fs::remove_dir_all(&dir);
    }

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
        assert_eq!(
            requested_agents(Some(vec!["codex".into()])),
            vec![McpAgent::Codex]
        );
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
    fn scanning_global_scope_returns_one_snapshot_per_agent_without_panicking() {
        let snapshots = scan_inner(McpScope::Global, None, None);
        assert_eq!(snapshots.len(), ALL_MCP_AGENTS.len());
        for snapshot in &snapshots {
            assert_eq!(snapshot.scope, McpScope::Global);
        }
    }

    #[test]
    fn a_missing_config_is_not_an_error() {
        let snapshot = scan_agent(
            McpAgent::Codex,
            McpScope::Project,
            Some(Path::new("D:/definitely/not/a/repo")),
            &[],
        );
        assert_eq!(snapshot.sources.len(), 1);
        assert!(!snapshot.sources[0].exists);
        assert!(snapshot.sources[0].parse_error.is_none());
        assert!(snapshot.servers.is_empty());
    }

    #[test]
    fn antigravity_reports_no_project_config() {
        let snapshot = scan_agent(
            McpAgent::Antigravity,
            McpScope::Project,
            Some(Path::new("D:/repo")),
            &[],
        );
        assert!(snapshot.sources.is_empty());
        assert!(snapshot.servers.is_empty());
    }
}
