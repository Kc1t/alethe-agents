use std::path::{Path, PathBuf};

use serde_json::{Map, Value};
use toml_edit::{
    value, Array, DocumentMut, InlineTable, Item, Table, TableLike, Value as TomlValue,
};

use crate::mcp_model::{
    EnvEntry, EnvMap, McpAgent, McpScope, McpServer, McpSourceKind, McpTimeouts, McpTransport,
};
use crate::provider_common::provider_home_dir;

/// One file an agent reads its servers from. Claude exposes two at project scope: the
/// `local` servers stored inside `~/.claude.json` under `projects.<cwd>` (what
/// `claude mcp add` writes by default) and the shareable `<repo>/.mcp.json`.
#[derive(Debug, Clone)]
pub struct McpSource {
    pub path: PathBuf,
    pub kind: McpSourceKind,
    pub project_key: Option<String>,
}

impl McpSource {
    fn file(path: PathBuf, kind: McpSourceKind) -> Self {
        McpSource {
            path,
            kind,
            project_key: None,
        }
    }
}

const CLAUDE_MANAGED: &[&str] = &[
    "type", "command", "args", "cwd", "env", "url", "headers", "disabled",
];
const OPENCODE_MANAGED: &[&str] = &[
    "type",
    "command",
    "cwd",
    "environment",
    "url",
    "headers",
    "enabled",
];

pub trait McpAdapter: Send + Sync {
    fn config_sources(&self, scope: McpScope, repo: Option<&Path>) -> Vec<McpSource>;
    fn parse(&self, raw: &str, source: &McpSource) -> Result<Vec<McpServer>, String>;
    fn upsert(&self, raw: &str, source: &McpSource, server: &McpServer) -> Result<String, String>;
    fn remove(&self, raw: &str, source: &McpSource, name: &str) -> Result<String, String>;
    fn set_enabled(
        &self,
        raw: &str,
        source: &McpSource,
        name: &str,
        on: bool,
    ) -> Result<String, String>;
}

static CLAUDE: ClaudeAdapter = ClaudeAdapter;
static CODEX: CodexAdapter = CodexAdapter;
static OPENCODE: OpenCodeAdapter = OpenCodeAdapter;
static ANTIGRAVITY: AntigravityAdapter = AntigravityAdapter;

pub fn adapter(agent: McpAgent) -> &'static dyn McpAdapter {
    match agent {
        McpAgent::Claude => &CLAUDE,
        McpAgent::Codex => &CODEX,
        McpAgent::Opencode => &OPENCODE,
        McpAgent::Antigravity => &ANTIGRAVITY,
    }
}

pub struct ClaudeAdapter;
pub struct CodexAdapter;
pub struct OpenCodeAdapter;
pub struct AntigravityAdapter;

impl McpAdapter for ClaudeAdapter {
    fn config_sources(&self, scope: McpScope, repo: Option<&Path>) -> Vec<McpSource> {
        let user_config = mcp_home(&[".claude.json"]);
        match scope {
            McpScope::Global => user_config
                .map(|path| vec![McpSource::file(path, McpSourceKind::User)])
                .unwrap_or_default(),
            McpScope::Project => {
                let Some(root) = repo else {
                    return Vec::new();
                };
                let mut sources = Vec::new();
                if let Some(path) = user_config {
                    sources.push(McpSource {
                        path,
                        kind: McpSourceKind::Local,
                        project_key: Some(claude_project_key(root)),
                    });
                }
                sources.push(McpSource::file(
                    root.join(".mcp.json"),
                    McpSourceKind::Project,
                ));
                sources
            }
        }
    }

    fn parse(&self, raw: &str, source: &McpSource) -> Result<Vec<McpServer>, String> {
        parse_json_servers(raw, "mcpServers", false, source)
    }

    fn upsert(&self, raw: &str, source: &McpSource, server: &McpServer) -> Result<String, String> {
        json_upsert(raw, "mcpServers", CLAUDE_MANAGED, false, source, server)
    }

    fn remove(&self, raw: &str, source: &McpSource, name: &str) -> Result<String, String> {
        json_remove(raw, "mcpServers", source, name)
    }

    fn set_enabled(
        &self,
        _raw: &str,
        _source: &McpSource,
        _name: &str,
        _on: bool,
    ) -> Result<String, String> {
        Err("unsupported_disable".to_string())
    }
}

impl McpAdapter for AntigravityAdapter {
    fn config_sources(&self, scope: McpScope, _repo: Option<&Path>) -> Vec<McpSource> {
        match scope {
            McpScope::Global => mcp_home(&[".gemini", "config", "mcp_config.json"])
                .map(|path| vec![McpSource::file(path, McpSourceKind::User)])
                .unwrap_or_default(),
            McpScope::Project => Vec::new(),
        }
    }

    fn parse(&self, raw: &str, source: &McpSource) -> Result<Vec<McpServer>, String> {
        parse_json_servers(raw, "mcpServers", false, source)
    }

    fn upsert(&self, raw: &str, source: &McpSource, server: &McpServer) -> Result<String, String> {
        json_upsert(raw, "mcpServers", CLAUDE_MANAGED, false, source, server)
    }

    fn remove(&self, raw: &str, source: &McpSource, name: &str) -> Result<String, String> {
        json_remove(raw, "mcpServers", source, name)
    }

    fn set_enabled(
        &self,
        _raw: &str,
        _source: &McpSource,
        _name: &str,
        _on: bool,
    ) -> Result<String, String> {
        Err("unsupported_disable".to_string())
    }
}

impl McpAdapter for OpenCodeAdapter {
    fn config_sources(&self, scope: McpScope, repo: Option<&Path>) -> Vec<McpSource> {
        let dir = match scope {
            McpScope::Global => opencode_config_dir(),
            McpScope::Project => repo.map(Path::to_path_buf),
        };
        let Some(dir) = dir else {
            return Vec::new();
        };
        let kind = match scope {
            McpScope::Global => McpSourceKind::User,
            McpScope::Project => McpSourceKind::Project,
        };
        let json = dir.join("opencode.json");
        if json.is_file() {
            return vec![McpSource::file(json, kind)];
        }
        let jsonc = dir.join("opencode.jsonc");
        if jsonc.is_file() {
            return vec![McpSource::file(jsonc, kind)];
        }
        vec![McpSource::file(json, kind)]
    }

    fn parse(&self, raw: &str, _source: &McpSource) -> Result<Vec<McpServer>, String> {
        parse_opencode(raw)
    }

    fn upsert(&self, raw: &str, source: &McpSource, server: &McpServer) -> Result<String, String> {
        json_upsert(raw, "mcp", OPENCODE_MANAGED, true, source, server)
    }

    fn remove(&self, raw: &str, source: &McpSource, name: &str) -> Result<String, String> {
        json_remove(raw, "mcp", source, name)
    }

    fn set_enabled(
        &self,
        raw: &str,
        _source: &McpSource,
        name: &str,
        on: bool,
    ) -> Result<String, String> {
        json_set_enabled(raw, "mcp", name, on)
    }
}

impl McpAdapter for CodexAdapter {
    fn config_sources(&self, scope: McpScope, repo: Option<&Path>) -> Vec<McpSource> {
        match scope {
            McpScope::Global => mcp_home(&[".codex", "config.toml"])
                .map(|path| vec![McpSource::file(path, McpSourceKind::User)])
                .unwrap_or_default(),
            McpScope::Project => repo
                .map(|root| {
                    vec![McpSource::file(
                        root.join(".codex").join("config.toml"),
                        McpSourceKind::Project,
                    )]
                })
                .unwrap_or_default(),
        }
    }

    fn parse(&self, raw: &str, _source: &McpSource) -> Result<Vec<McpServer>, String> {
        parse_codex(raw)
    }

    fn upsert(&self, raw: &str, _source: &McpSource, server: &McpServer) -> Result<String, String> {
        codex_upsert(raw, server)
    }

    fn remove(&self, raw: &str, _source: &McpSource, name: &str) -> Result<String, String> {
        codex_remove(raw, name)
    }

    fn set_enabled(
        &self,
        raw: &str,
        _source: &McpSource,
        name: &str,
        on: bool,
    ) -> Result<String, String> {
        codex_set_enabled(raw, name, on)
    }
}

/// `ALETHE_MCP_HOME` redirects every global config lookup to a scratch copy, so the
/// write paths can be exercised without touching the real agent configuration.
fn mcp_home(segments: &[&str]) -> Option<PathBuf> {
    if let Some(root) = std::env::var_os("ALETHE_MCP_HOME") {
        let base = PathBuf::from(root);
        if !base.as_os_str().is_empty() {
            return Some(segments.iter().fold(base, |acc, seg| acc.join(seg)));
        }
    }
    provider_home_dir(segments)
}

fn opencode_config_dir() -> Option<PathBuf> {
    if std::env::var_os("ALETHE_MCP_HOME").is_none() {
        if let Some(xdg) = std::env::var_os("XDG_CONFIG_HOME") {
            let base = PathBuf::from(xdg);
            if !base.as_os_str().is_empty() {
                return Some(base.join("opencode"));
            }
        }
    }
    mcp_home(&[".config", "opencode"])
}

/// Claude stores its `projects` keys with forward slashes, so a Windows path has to be
/// translated before it can be looked up.
fn claude_project_key(repo: &Path) -> String {
    repo.to_string_lossy().replace('\\', "/")
}

fn normalized_project_key(raw: &str) -> String {
    raw.replace('\\', "/")
        .trim_end_matches('/')
        .to_ascii_lowercase()
}

fn resolve_project_key(projects: &Map<String, Value>, wanted: &str) -> Option<String> {
    let needle = normalized_project_key(wanted);
    projects
        .keys()
        .find(|key| normalized_project_key(key) == needle)
        .cloned()
}

fn json_servers_map<'a>(
    value: &'a Value,
    root_key: &str,
    source: &McpSource,
) -> Option<&'a Map<String, Value>> {
    match (source.kind, source.project_key.as_deref()) {
        (McpSourceKind::Local, Some(wanted)) => {
            let projects = value.get("projects").and_then(Value::as_object)?;
            let key = resolve_project_key(projects, wanted)?;
            projects.get(&key)?.get(root_key).and_then(Value::as_object)
        }
        _ => value.get(root_key).and_then(Value::as_object),
    }
}

fn parse_json_servers(
    raw: &str,
    root_key: &str,
    interpolate: bool,
    source: &McpSource,
) -> Result<Vec<McpServer>, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }
    let value: Value = serde_json::from_str(trimmed).map_err(json_error)?;
    let Some(map) = json_servers_map(&value, root_key, source) else {
        return Ok(Vec::new());
    };
    let mut out: Vec<McpServer> = map
        .iter()
        .filter_map(|(name, entry)| {
            entry
                .as_object()
                .map(|obj| json_server(name, obj, interpolate))
        })
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

fn parse_opencode(raw: &str) -> Result<Vec<McpServer>, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }
    let value: Value = serde_json::from_str(trimmed).map_err(json_error)?;
    let Some(map) = value.get("mcp").and_then(Value::as_object) else {
        return Ok(Vec::new());
    };
    let mut out: Vec<McpServer> = map
        .iter()
        .filter_map(|(name, entry)| entry.as_object().map(|obj| opencode_server(name, obj)))
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

fn opencode_server(name: &str, obj: &Map<String, Value>) -> McpServer {
    let declared = obj.get("type").and_then(Value::as_str).unwrap_or("");
    let url = obj.get("url").and_then(Value::as_str);
    let headers = json_env(obj.get("headers"), true);
    let transport = match (declared, url) {
        ("remote", Some(url)) | (_, Some(url)) => McpTransport::Http {
            url: url.to_string(),
            headers,
        },
        _ => {
            let parts = json_string_array(obj.get("command"));
            let (command, args) = parts
                .split_first()
                .map(|(head, tail)| (head.clone(), tail.to_vec()))
                .unwrap_or_default();
            McpTransport::Stdio {
                command,
                args,
                cwd: obj.get("cwd").and_then(Value::as_str).map(str::to_string),
            }
        }
    };
    McpServer {
        name: name.to_string(),
        transport,
        env: json_env(obj.get("environment"), true),
        enabled: obj.get("enabled").and_then(Value::as_bool).unwrap_or(true),
        timeouts: McpTimeouts::default(),
        bearer_token_env_var: None,
    }
}

fn json_server(name: &str, obj: &Map<String, Value>, interpolate: bool) -> McpServer {
    let declared = obj.get("type").and_then(Value::as_str).unwrap_or("");
    let url = obj.get("url").and_then(Value::as_str);
    let headers = json_env(obj.get("headers"), interpolate);
    let transport = match (declared, url) {
        ("sse", Some(url)) => McpTransport::Sse {
            url: url.to_string(),
            headers,
        },
        (_, Some(url)) => McpTransport::Http {
            url: url.to_string(),
            headers,
        },
        _ => McpTransport::Stdio {
            command: obj
                .get("command")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            args: json_string_array(obj.get("args")),
            cwd: obj.get("cwd").and_then(Value::as_str).map(str::to_string),
        },
    };
    McpServer {
        name: name.to_string(),
        transport,
        env: json_env(obj.get("env"), interpolate),
        enabled: !obj
            .get("disabled")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        timeouts: McpTimeouts::default(),
        bearer_token_env_var: None,
    }
}

fn json_string_array(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn json_env(value: Option<&Value>, interpolate: bool) -> EnvMap {
    let Some(map) = value.and_then(Value::as_object) else {
        return EnvMap::new();
    };
    map.iter()
        .filter_map(|(key, raw)| {
            raw.as_str()
                .map(|text| (key.clone(), env_entry(text, interpolate)))
        })
        .collect()
}

/// OpenCode late-binds a host variable with `{env:NAME}`; everywhere else the value is literal.
fn env_entry(raw: &str, interpolate: bool) -> EnvEntry {
    if interpolate {
        if let Some(inner) = raw
            .strip_prefix("{env:")
            .and_then(|rest| rest.strip_suffix('}'))
        {
            let name = inner.trim();
            if !name.is_empty() {
                return EnvEntry::passthrough(name);
            }
        }
    }
    EnvEntry::literal(raw)
}

fn parse_codex(raw: &str) -> Result<Vec<McpServer>, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }
    let doc = raw
        .parse::<DocumentMut>()
        .map_err(|error| toml_error(raw, error.span()))?;
    let Some(table) = doc.get("mcp_servers").and_then(Item::as_table_like) else {
        return Ok(Vec::new());
    };
    let mut out: Vec<McpServer> = table
        .iter()
        .filter_map(|(name, item)| item.as_table_like().map(|entry| codex_server(name, entry)))
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

fn codex_server(name: &str, entry: &dyn TableLike) -> McpServer {
    let url = entry.get("url").and_then(Item::as_str);
    let transport = match url {
        Some(url) => McpTransport::Http {
            url: url.to_string(),
            headers: EnvMap::new(),
        },
        None => McpTransport::Stdio {
            command: entry
                .get("command")
                .and_then(Item::as_str)
                .unwrap_or_default()
                .to_string(),
            args: toml_string_array(entry.get("args")),
            cwd: entry.get("cwd").and_then(Item::as_str).map(str::to_string),
        },
    };

    let mut env = EnvMap::new();
    if let Some(table) = entry.get("env").and_then(Item::as_table_like) {
        for (key, item) in table.iter() {
            if let Some(text) = item.as_str() {
                env.insert(key.to_string(), EnvEntry::literal(text));
            }
        }
    }
    for var in toml_string_array(entry.get("env_vars")) {
        let slot = env.entry(var.clone()).or_default();
        slot.passthrough_from = Some(var);
    }

    McpServer {
        name: name.to_string(),
        transport,
        env,
        enabled: entry.get("enabled").and_then(Item::as_bool).unwrap_or(true),
        timeouts: McpTimeouts {
            startup_secs: toml_secs(entry.get("startup_timeout_sec")),
            tool_secs: toml_secs(entry.get("tool_timeout_sec")),
        },
        bearer_token_env_var: entry
            .get("bearer_token_env_var")
            .and_then(Item::as_str)
            .map(str::to_string),
    }
}

fn toml_string_array(item: Option<&Item>) -> Vec<String> {
    item.and_then(Item::as_array)
        .map(|array| {
            array
                .iter()
                .filter_map(|value| value.as_str())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn toml_secs(item: Option<&Item>) -> Option<u32> {
    let item = item?;
    if let Some(int) = item.as_integer() {
        return u32::try_from(int).ok();
    }
    let float = item.as_float()?;
    if float.is_finite() && float >= 0.0 {
        Some(float.round() as u32)
    } else {
        None
    }
}

/// Error strings are sent to the webview, so they carry a position and never a snippet
/// of the file — these configs hold live credentials.
fn json_error(error: serde_json::Error) -> String {
    format!(
        "unparsable:json line {} column {}",
        error.line(),
        error.column()
    )
}

fn toml_error(raw: &str, span: Option<std::ops::Range<usize>>) -> String {
    let line = span
        .map(|range| raw[..range.start.min(raw.len())].lines().count().max(1))
        .unwrap_or(0);
    format!("unparsable:toml line {line}")
}

fn json_root(raw: &str) -> Result<Value, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(Value::Object(Map::new()));
    }
    let value: Value = serde_json::from_str(trimmed).map_err(json_error)?;
    if value.is_object() {
        Ok(value)
    } else {
        Err("unparsable:json root is not an object".to_string())
    }
}

fn json_render(value: &Value) -> String {
    let mut out = serde_json::to_string_pretty(value).unwrap_or_default();
    out.push('\n');
    out
}

fn json_env_value(entry: &EnvEntry, interpolate: bool) -> Option<Value> {
    if let Some(from) = &entry.passthrough_from {
        if interpolate {
            return Some(Value::String(format!("{{env:{from}}}")));
        }
    }
    entry
        .literal
        .as_ref()
        .map(|text| Value::String(text.clone()))
}

fn json_env_object(env: &EnvMap, interpolate: bool) -> Option<Value> {
    let mut out = Map::new();
    for (key, entry) in env {
        if let Some(value) = json_env_value(entry, interpolate) {
            out.insert(key.clone(), value);
        }
    }
    if out.is_empty() {
        None
    } else {
        Some(Value::Object(out))
    }
}

fn servers_container_mut<'a>(
    root: &'a mut Value,
    root_key: &str,
    source: &McpSource,
    create: bool,
) -> Result<Option<&'a mut Map<String, Value>>, String> {
    let object = root
        .as_object_mut()
        .ok_or_else(|| "unparsable:json root is not an object".to_string())?;

    let holder = match (source.kind, source.project_key.as_deref()) {
        (McpSourceKind::Local, Some(wanted)) => {
            if !object
                .get("projects")
                .map(Value::is_object)
                .unwrap_or(false)
            {
                if !create {
                    return Ok(None);
                }
                object.insert("projects".to_string(), Value::Object(Map::new()));
            }
            let projects = object
                .get_mut("projects")
                .and_then(Value::as_object_mut)
                .ok_or_else(|| "unparsable:projects".to_string())?;
            let key = match resolve_project_key(projects, wanted) {
                Some(key) => key,
                None => {
                    if !create {
                        return Ok(None);
                    }
                    let key = wanted.replace('\\', "/");
                    projects.insert(key.clone(), Value::Object(Map::new()));
                    key
                }
            };
            projects
                .get_mut(&key)
                .and_then(Value::as_object_mut)
                .ok_or_else(|| "unparsable:project_entry".to_string())?
        }
        _ => object,
    };

    if !holder.get(root_key).map(Value::is_object).unwrap_or(false) {
        if !create {
            return Ok(None);
        }
        holder.insert(root_key.to_string(), Value::Object(Map::new()));
    }
    Ok(holder.get_mut(root_key).and_then(Value::as_object_mut))
}

/// Rewrites only the keys this adapter owns, so anything the user hand-added to the
/// entry survives the round-trip.
fn json_upsert(
    raw: &str,
    root_key: &str,
    managed: &[&str],
    opencode: bool,
    source: &McpSource,
    server: &McpServer,
) -> Result<String, String> {
    let mut root = json_root(raw)?;
    let servers = servers_container_mut(&mut root, root_key, source, true)?
        .ok_or_else(|| format!("unparsable:{root_key}"))?;

    let mut entry = servers
        .get(&server.name)
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    // shift_remove, not remove: with serde_json's preserve_order feature `remove` is
    // `swap_remove`, which would shuffle the user's hand-added keys on every write.
    for key in managed {
        entry.shift_remove(*key);
    }

    let env_key = if opencode { "environment" } else { "env" };
    if let Some(env) = json_env_object(&server.env, opencode) {
        entry.insert(env_key.to_string(), env);
    }

    match &server.transport {
        McpTransport::Stdio { command, args, cwd } => {
            if opencode {
                let mut parts = vec![Value::String(command.clone())];
                parts.extend(args.iter().map(|arg| Value::String(arg.clone())));
                entry.insert("type".to_string(), Value::String("local".to_string()));
                entry.insert("command".to_string(), Value::Array(parts));
            } else {
                entry.insert("type".to_string(), Value::String("stdio".to_string()));
                entry.insert("command".to_string(), Value::String(command.clone()));
                if !args.is_empty() {
                    entry.insert(
                        "args".to_string(),
                        Value::Array(args.iter().map(|arg| Value::String(arg.clone())).collect()),
                    );
                }
            }
            if let Some(cwd) = cwd {
                entry.insert("cwd".to_string(), Value::String(cwd.clone()));
            }
        }
        McpTransport::Http { url, headers } | McpTransport::Sse { url, headers } => {
            let kind = if opencode {
                "remote"
            } else if matches!(server.transport, McpTransport::Sse { .. }) {
                "sse"
            } else {
                "http"
            };
            entry.insert("type".to_string(), Value::String(kind.to_string()));
            entry.insert("url".to_string(), Value::String(url.clone()));
            if let Some(headers) = json_env_object(headers, opencode) {
                entry.insert("headers".to_string(), headers);
            }
        }
    }

    if opencode {
        entry.insert("enabled".to_string(), Value::Bool(server.enabled));
    } else if !server.enabled {
        entry.insert("disabled".to_string(), Value::Bool(true));
    }

    servers.insert(server.name.clone(), Value::Object(entry));
    Ok(json_render(&root))
}

fn json_remove(
    raw: &str,
    root_key: &str,
    source: &McpSource,
    name: &str,
) -> Result<String, String> {
    let mut root = json_root(raw)?;
    let Some(servers) = servers_container_mut(&mut root, root_key, source, false)? else {
        return Err("not_found".to_string());
    };
    if servers.shift_remove(name).is_none() {
        return Err("not_found".to_string());
    }
    Ok(json_render(&root))
}

fn json_set_enabled(raw: &str, root_key: &str, name: &str, on: bool) -> Result<String, String> {
    let mut root = json_root(raw)?;
    let Some(entry) = root
        .get_mut(root_key)
        .and_then(Value::as_object_mut)
        .and_then(|servers| servers.get_mut(name))
        .and_then(Value::as_object_mut)
    else {
        return Err("not_found".to_string());
    };
    entry.insert("enabled".to_string(), Value::Bool(on));
    Ok(json_render(&root))
}

fn parse_doc(raw: &str) -> Result<DocumentMut, String> {
    raw.parse::<DocumentMut>()
        .map_err(|error| toml_error(raw, error.span()))
}

fn codex_upsert(raw: &str, server: &McpServer) -> Result<String, String> {
    let mut doc = parse_doc(raw)?;
    // Only a table this call creates is made implicit. Forcing it on an existing explicit
    // `[mcp_servers]` header makes toml_edit stop emitting it, taking any comment above it.
    if doc.get("mcp_servers").is_none() {
        let mut parent = Table::new();
        parent.set_implicit(true);
        doc.insert("mcp_servers", Item::Table(parent));
    }
    let parent = doc
        .get_mut("mcp_servers")
        .and_then(Item::as_table_mut)
        .ok_or_else(|| "unparsable:mcp_servers".to_string())?;

    if parent.get(&server.name).and_then(Item::as_table).is_none() {
        parent.insert(&server.name, Item::Table(Table::new()));
    }
    let entry = parent
        .get_mut(&server.name)
        .and_then(Item::as_table_mut)
        .ok_or_else(|| "unparsable:server_entry".to_string())?;

    for key in [
        "command",
        "args",
        "cwd",
        "url",
        "bearer_token_env_var",
        "startup_timeout_sec",
        "tool_timeout_sec",
    ] {
        entry.remove(key);
    }

    match &server.transport {
        McpTransport::Stdio { command, args, cwd } => {
            entry["command"] = value(command.as_str());
            if !args.is_empty() {
                let mut array = Array::new();
                for arg in args {
                    array.push(arg.as_str());
                }
                entry["args"] = value(array);
            }
            if let Some(cwd) = cwd {
                entry["cwd"] = value(cwd.as_str());
            }
        }
        McpTransport::Http { url, .. } | McpTransport::Sse { url, .. } => {
            entry["url"] = value(url.as_str());
        }
    }

    if let Some(var) = &server.bearer_token_env_var {
        entry["bearer_token_env_var"] = value(var.as_str());
    }
    if let Some(secs) = server.timeouts.startup_secs {
        entry["startup_timeout_sec"] = value(i64::from(secs));
    }
    if let Some(secs) = server.timeouts.tool_secs {
        entry["tool_timeout_sec"] = value(i64::from(secs));
    }
    if server.enabled {
        entry.remove("enabled");
    } else {
        entry["enabled"] = value(false);
    }
    codex_set_env(entry, &server.env);

    Ok(doc.to_string())
}

/// Keeps whichever container the file already used for `env`, so a hand-written
/// `[mcp_servers.x.env]` section is not flattened into an inline table.
fn codex_set_env(entry: &mut Table, env: &EnvMap) {
    let literals: Vec<(&String, &String)> = env
        .iter()
        .filter_map(|(key, item)| item.literal.as_ref().map(|literal| (key, literal)))
        .collect();
    let passthrough: Vec<&String> = env
        .values()
        .filter_map(|item| item.passthrough_from.as_ref())
        .collect();

    if literals.is_empty() {
        entry.remove("env");
    } else if matches!(entry.get("env"), Some(Item::Table(_))) {
        let mut table = Table::new();
        for (key, literal) in &literals {
            table[key.as_str()] = value(literal.as_str());
        }
        entry["env"] = Item::Table(table);
    } else {
        let mut inline = InlineTable::new();
        for (key, literal) in &literals {
            inline.insert(key.as_str(), TomlValue::from(literal.as_str()));
        }
        entry["env"] = Item::Value(TomlValue::InlineTable(inline));
    }

    if passthrough.is_empty() {
        entry.remove("env_vars");
    } else {
        let mut array = Array::new();
        for name in passthrough {
            array.push(name.as_str());
        }
        entry["env_vars"] = value(array);
    }
}

fn codex_remove(raw: &str, name: &str) -> Result<String, String> {
    let mut doc = parse_doc(raw)?;
    let Some(parent) = doc.get_mut("mcp_servers").and_then(Item::as_table_mut) else {
        return Err("not_found".to_string());
    };
    if parent.remove(name).is_none() {
        return Err("not_found".to_string());
    }
    Ok(doc.to_string())
}

fn codex_set_enabled(raw: &str, name: &str, on: bool) -> Result<String, String> {
    let mut doc = parse_doc(raw)?;
    let Some(entry) = doc
        .get_mut("mcp_servers")
        .and_then(Item::as_table_mut)
        .and_then(|parent| parent.get_mut(name))
        .and_then(Item::as_table_like_mut)
    else {
        return Err("not_found".to_string());
    };
    entry.insert("enabled", value(on));
    Ok(doc.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const CODEX_FIXTURE: &str = r#"
model = "gpt-5.6-sol"

[projects."D:\\repo\\one"]
trust_level = "trusted"

[mcp_servers.discord]
command = "npx"
args = ["-y", "@quadslab.io/discord-mcp"]

[mcp_servers.discord.env]
DISCORD_GUILD_ID = "123"
DISCORD_TOKEN = "a-live-secret-token-value"

[mcp_servers.figma]
url = "https://mcp.figma.com/mcp"

[mcp_servers.swarm]
command = "node"
args = ["C:\\path\\server.js"]
env = { NODE_ENV = "production", QUADRANT = "1" }
env_vars = ["QUADRANT", "SESSION"]
startup_timeout_sec = 30
tool_timeout_sec = 120.0

[[hooks.PreToolUse]]
name = "gate"
"#;

    fn by_name<'a>(servers: &'a [McpServer], name: &str) -> &'a McpServer {
        servers
            .iter()
            .find(|s| s.name == name)
            .expect("server present")
    }

    fn user_src() -> McpSource {
        McpSource::file(PathBuf::from("x/config"), McpSourceKind::User)
    }

    #[test]
    fn codex_reads_every_table_shape() {
        let servers = parse_codex(CODEX_FIXTURE).expect("parses");
        assert_eq!(servers.len(), 3);

        let discord = by_name(&servers, "discord");
        assert!(
            matches!(&discord.transport, McpTransport::Stdio { command, .. } if command == "npx")
        );
        assert_eq!(
            discord
                .env
                .get("DISCORD_TOKEN")
                .and_then(|e| e.literal.as_deref()),
            Some("a-live-secret-token-value")
        );

        let figma = by_name(&servers, "figma");
        assert!(
            matches!(&figma.transport, McpTransport::Http { url, .. } if url.contains("figma"))
        );
    }

    #[test]
    fn codex_keeps_a_key_that_is_both_literal_and_passthrough() {
        let servers = parse_codex(CODEX_FIXTURE).expect("parses");
        let swarm = by_name(&servers, "swarm");

        let quadrant = swarm.env.get("QUADRANT").expect("present");
        assert_eq!(quadrant.literal.as_deref(), Some("1"));
        assert_eq!(quadrant.passthrough_from.as_deref(), Some("QUADRANT"));

        let session = swarm.env.get("SESSION").expect("present");
        assert_eq!(session.literal, None);
        assert_eq!(session.passthrough_from.as_deref(), Some("SESSION"));
    }

    #[test]
    fn codex_reads_both_integer_and_float_timeouts() {
        let servers = parse_codex(CODEX_FIXTURE).expect("parses");
        let swarm = by_name(&servers, "swarm");
        assert_eq!(swarm.timeouts.startup_secs, Some(30));
        assert_eq!(swarm.timeouts.tool_secs, Some(120));
    }

    #[test]
    fn codex_without_mcp_servers_is_empty_not_an_error() {
        assert!(parse_codex("model = \"x\"\n").expect("parses").is_empty());
        assert!(parse_codex("").expect("parses").is_empty());
    }

    #[test]
    fn codex_parse_error_carries_no_file_content() {
        let error = parse_codex("[mcp_servers.broken\ntoken = \"secret-value\"").unwrap_err();
        assert!(error.starts_with("unparsable:toml"));
        assert!(!error.contains("secret-value"));
    }

    #[test]
    fn claude_reads_stdio_and_http_entries() {
        let raw = r#"{
          "numStartups": 12,
          "mcpServers": {
            "higgsfield": { "type": "http", "url": "https://mcp.higgsfield.ai/mcp" },
            "swarm": { "type": "stdio", "command": "node", "args": ["a.js"], "env": { "K": "V" } }
          }
        }"#;
        let servers = ClaudeAdapter.parse(raw, &user_src()).expect("parses");
        assert_eq!(servers.len(), 2);
        let swarm = by_name(&servers, "swarm");
        assert_eq!(
            swarm.env.get("K").and_then(|e| e.literal.as_deref()),
            Some("V")
        );
        assert!(swarm.enabled);
        let higgs = by_name(&servers, "higgsfield");
        assert!(matches!(higgs.transport, McpTransport::Http { .. }));
    }

    #[test]
    fn claude_does_not_treat_env_interpolation_as_passthrough() {
        let raw = r#"{"mcpServers":{"a":{"command":"node","env":{"K":"{env:K}"}}}}"#;
        let servers = ClaudeAdapter.parse(raw, &user_src()).expect("parses");
        let entry = servers[0].env.get("K").expect("present");
        assert_eq!(entry.literal.as_deref(), Some("{env:K}"));
        assert_eq!(entry.passthrough_from, None);
    }

    #[test]
    fn claude_honours_an_explicit_disabled_flag() {
        let raw = r#"{"mcpServers":{"a":{"command":"node","disabled":true}}}"#;
        assert!(!ClaudeAdapter.parse(raw, &user_src()).expect("parses")[0].enabled);
    }

    #[test]
    fn opencode_splits_the_command_array_and_reads_passthrough() {
        let raw = r#"{
          "$schema": "https://opencode.ai/config.json",
          "mcp": {
            "swarm": {
              "type": "local",
              "command": ["node", "C:/x/server.js"],
              "enabled": false,
              "environment": { "QUADRANT": "{env:QUADRANT}", "MODE": "prod" }
            }
          }
        }"#;
        let servers = OpenCodeAdapter.parse(raw, &user_src()).expect("parses");
        let swarm = &servers[0];
        match &swarm.transport {
            McpTransport::Stdio { command, args, .. } => {
                assert_eq!(command, "node");
                assert_eq!(args, &vec!["C:/x/server.js".to_string()]);
            }
            other => panic!("expected stdio, got {other:?}"),
        }
        assert!(!swarm.enabled);
        assert_eq!(
            swarm
                .env
                .get("QUADRANT")
                .and_then(|e| e.passthrough_from.as_deref()),
            Some("QUADRANT")
        );
        assert_eq!(
            swarm.env.get("MODE").and_then(|e| e.literal.as_deref()),
            Some("prod")
        );
    }

    #[test]
    fn opencode_config_without_mcp_is_empty() {
        assert!(OpenCodeAdapter
            .parse(r#"{"model":"a/b"}"#, &user_src())
            .expect("parses")
            .is_empty());
    }

    #[test]
    fn antigravity_shares_the_claude_shape() {
        let raw = r#"{"mcpServers":{"swarm":{"type":"stdio","command":"node","args":["a.js"]}}}"#;
        assert_eq!(
            AntigravityAdapter
                .parse(raw, &user_src())
                .expect("parses")
                .len(),
            1
        );
    }

    #[test]
    fn antigravity_has_no_project_scope() {
        let repo = PathBuf::from("D:/repo");
        assert!(AntigravityAdapter
            .config_sources(McpScope::Project, Some(&repo))
            .is_empty());
    }

    fn probe(name: &str) -> McpServer {
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
    fn codex_remove_takes_the_env_subtable_with_it() {
        let next = codex_remove(CODEX_FIXTURE, "discord").expect("removes");
        assert!(!next.contains("[mcp_servers.discord]"));
        assert!(!next.contains("[mcp_servers.discord.env]"));
        assert!(!next.contains("a-live-secret-token-value"));
        assert!(next.contains("[mcp_servers.figma]"));
        assert!(next.contains("[[hooks.PreToolUse]]"));
        assert!(next.contains("[projects.\"D:\\\\repo\\\\one\"]"));
        assert!(parse_codex(&next).is_ok());
    }

    #[test]
    fn codex_upsert_leaves_every_other_table_untouched() {
        let next = codex_upsert(CODEX_FIXTURE, &probe("alethe-probe")).expect("writes");
        let before = parse_codex(CODEX_FIXTURE).expect("parses");
        let after = parse_codex(&next).expect("parses");

        assert_eq!(after.len(), before.len() + 1);
        for server in &before {
            let kept = after
                .iter()
                .find(|item| item.name == server.name)
                .expect("kept");
            assert_eq!(&kept.transport, &server.transport);
            assert_eq!(&kept.env, &server.env);
        }
        assert!(next.contains("[[hooks.PreToolUse]]"));
        assert!(next.contains("model = \"gpt-5.6-sol\""));
    }

    #[test]
    fn codex_upsert_round_trips_timeouts_and_passthrough() {
        let mut server = probe("alethe-probe");
        server.timeouts = McpTimeouts {
            startup_secs: Some(12),
            tool_secs: Some(90),
        };
        server
            .env
            .insert("MODE".to_string(), EnvEntry::literal("prod"));
        server
            .env
            .insert("FOO".to_string(), EnvEntry::passthrough("FOO"));

        let next = codex_upsert(CODEX_FIXTURE, &server).expect("writes");
        let parsed = parse_codex(&next).expect("parses");
        let written = by_name(&parsed, "alethe-probe");

        assert_eq!(written.timeouts, server.timeouts);
        assert_eq!(
            written.env.get("MODE").and_then(|e| e.literal.as_deref()),
            Some("prod")
        );
        assert_eq!(
            written
                .env
                .get("FOO")
                .and_then(|e| e.passthrough_from.as_deref()),
            Some("FOO")
        );
    }

    #[test]
    fn codex_upsert_keeps_a_hand_written_env_section_as_a_section() {
        let mut server = probe("discord");
        server.transport = McpTransport::Stdio {
            command: "npx".to_string(),
            args: vec!["-y".to_string(), "@quadslab.io/discord-mcp".to_string()],
            cwd: None,
        };
        server
            .env
            .insert("DISCORD_GUILD_ID".to_string(), EnvEntry::literal("456"));

        let next = codex_upsert(CODEX_FIXTURE, &server).expect("writes");
        assert!(next.contains("[mcp_servers.discord.env]"));
        assert!(!next.contains("a-live-secret-token-value"));
    }

    #[test]
    fn codex_set_enabled_flips_only_that_server() {
        let next = codex_set_enabled(CODEX_FIXTURE, "figma", false).expect("writes");
        let parsed = parse_codex(&next).expect("parses");
        assert!(!by_name(&parsed, "figma").enabled);
        assert!(by_name(&parsed, "discord").enabled);
    }

    #[test]
    fn codex_mutations_report_not_found_for_an_unknown_server() {
        assert_eq!(
            codex_remove(CODEX_FIXTURE, "ghost").unwrap_err(),
            "not_found"
        );
        assert_eq!(
            codex_set_enabled(CODEX_FIXTURE, "ghost", false).unwrap_err(),
            "not_found"
        );
    }

    const CLAUDE_FIXTURE: &str = r#"{
  "numStartups": 1871,
  "installMethod": "global",
  "mcpServers": {
    "figma": { "type": "http", "url": "https://mcp.figma.com/mcp" }
  },
  "projects": { "D:\\repo": { "allowedTools": [] } }
}"#;

    #[test]
    fn claude_upsert_keeps_top_level_key_order_and_unrelated_keys() {
        let next = ClaudeAdapter
            .upsert(CLAUDE_FIXTURE, &user_src(), &probe("alethe-probe"))
            .expect("writes");
        let numstartups = next.find("numStartups").expect("present");
        let install = next.find("installMethod").expect("present");
        let projects = next.find("\"projects\"").expect("present");
        assert!(numstartups < install && install < projects);

        let parsed = ClaudeAdapter.parse(&next, &user_src()).expect("parses");
        assert_eq!(parsed.len(), 2);
        assert!(by_name(&parsed, "figma").transport.is_remote());
    }

    #[test]
    fn claude_upsert_preserves_unknown_keys_on_the_entry() {
        let raw = r#"{"mcpServers":{"a":{"command":"old","trustLevel":"always"}}}"#;
        let next = ClaudeAdapter
            .upsert(raw, &user_src(), &probe("a"))
            .expect("writes");
        assert!(next.contains("trustLevel"));
        assert!(!next.contains("\"old\""));
    }

    #[test]
    fn removing_one_server_does_not_move_its_siblings() {
        let raw = r#"{"mcpServers":{"a":{"command":"x"},"b":{"command":"x"},"c":{"command":"x"},"d":{"command":"x"}}}"#;
        let next = ClaudeAdapter
            .remove(raw, &user_src(), "b")
            .expect("removes");
        let order: Vec<usize> = ["\"a\"", "\"c\"", "\"d\""]
            .iter()
            .map(|needle| next.find(needle).expect("present"))
            .collect();
        assert!(order[0] < order[1] && order[1] < order[2], "got {next}");
    }

    #[test]
    fn upsert_keeps_the_relative_order_of_hand_added_keys() {
        let raw = r#"{"mcpServers":{"a":{"command":"old","first":1,"second":2,"third":3}}}"#;
        let next = ClaudeAdapter
            .upsert(raw, &user_src(), &probe("a"))
            .expect("writes");
        let first = next.find("\"first\"").expect("present");
        let second = next.find("\"second\"").expect("present");
        let third = next.find("\"third\"").expect("present");
        assert!(first < second && second < third, "got {next}");
    }

    #[test]
    fn codex_upsert_keeps_an_explicit_mcp_servers_header_and_its_comment() {
        let raw = "# my servers\n[mcp_servers]\n\n[mcp_servers.figma]\nurl = \"https://x\"\n";
        let next = codex_upsert(raw, &probe("alethe-probe")).expect("writes");
        assert!(next.contains("# my servers"), "got {next}");
        assert!(next.contains("[mcp_servers]"), "got {next}");
        assert_eq!(parse_codex(&next).expect("parses").len(), 2);
    }

    #[test]
    fn a_passthrough_header_blocks_a_copy_to_an_agent_that_cannot_late_bind() {
        let server = McpServer {
            name: "gh".to_string(),
            transport: McpTransport::Http {
                url: "https://api.githubcopilot.com/mcp".to_string(),
                headers: EnvMap::from([(
                    "Authorization".to_string(),
                    EnvEntry::passthrough("GH_TOKEN"),
                )]),
            },
            env: EnvMap::new(),
            enabled: true,
            timeouts: McpTimeouts::default(),
            bearer_token_env_var: None,
        };

        let blocked = crate::mcp_model::unsupported_fields(McpAgent::Claude, &server);
        assert_eq!(blocked.len(), 1);
        assert_eq!(blocked[0].field, "headers.Authorization");
        assert!(crate::mcp_model::unsupported_fields(McpAgent::Opencode, &server).is_empty());
    }

    #[test]
    fn claude_cannot_disable_a_server() {
        assert_eq!(
            ClaudeAdapter
                .set_enabled(CLAUDE_FIXTURE, &user_src(), "figma", false)
                .unwrap_err(),
            "unsupported_disable"
        );
    }

    #[test]
    fn claude_upsert_creates_the_root_key_in_an_empty_file() {
        let next = ClaudeAdapter
            .upsert("", &user_src(), &probe("a"))
            .expect("writes");
        assert_eq!(
            ClaudeAdapter
                .parse(&next, &user_src())
                .expect("parses")
                .len(),
            1
        );
    }

    #[test]
    fn claude_remove_reports_not_found() {
        assert_eq!(
            ClaudeAdapter
                .remove(CLAUDE_FIXTURE, &user_src(), "ghost")
                .unwrap_err(),
            "not_found"
        );
        let next = ClaudeAdapter
            .remove(CLAUDE_FIXTURE, &user_src(), "figma")
            .expect("removes");
        assert!(ClaudeAdapter
            .parse(&next, &user_src())
            .expect("parses")
            .is_empty());
        assert!(next.contains("numStartups"));
    }

    const OPENCODE_FIXTURE: &str = r#"{
  "$schema": "https://opencode.ai/config.json",
  "model": "provider/model",
  "mcp": {
    "swarm": { "type": "local", "command": ["node", "a.js"], "enabled": true }
  }
}"#;

    #[test]
    fn opencode_upsert_writes_one_command_array_and_interpolated_env() {
        let mut server = probe("alethe-probe");
        server
            .env
            .insert("FOO".to_string(), EnvEntry::passthrough("FOO"));
        let next = OpenCodeAdapter
            .upsert(OPENCODE_FIXTURE, &user_src(), &server)
            .expect("writes");

        assert!(next.contains("\"$schema\""));
        assert!(next.contains("\"model\""));
        assert!(next.contains("{env:FOO}"));

        let parsed = OpenCodeAdapter.parse(&next, &user_src()).expect("parses");
        let written = by_name(&parsed, "alethe-probe");
        match &written.transport {
            McpTransport::Stdio { command, args, .. } => {
                assert_eq!(command, "node");
                assert_eq!(args, &vec!["-e".to_string(), "0".to_string()]);
            }
            other => panic!("expected stdio, got {other:?}"),
        }
        assert_eq!(
            written
                .env
                .get("FOO")
                .and_then(|e| e.passthrough_from.as_deref()),
            Some("FOO")
        );
    }

    #[test]
    fn opencode_remove_keeps_every_sibling_key() {
        let next = OpenCodeAdapter
            .remove(OPENCODE_FIXTURE, &user_src(), "swarm")
            .expect("removes");
        assert!(next.contains("\"$schema\""));
        assert!(next.contains("\"model\""));
        assert!(OpenCodeAdapter
            .parse(&next, &user_src())
            .expect("parses")
            .is_empty());
    }

    #[test]
    fn opencode_set_enabled_writes_the_flag() {
        let next = OpenCodeAdapter
            .set_enabled(OPENCODE_FIXTURE, &user_src(), "swarm", false)
            .expect("writes");
        assert!(!OpenCodeAdapter.parse(&next, &user_src()).expect("parses")[0].enabled);
    }

    #[test]
    fn antigravity_writes_the_claude_shape() {
        let raw = r#"{"mcpServers":{}}"#;
        let next = AntigravityAdapter
            .upsert(raw, &user_src(), &probe("a"))
            .expect("writes");
        assert_eq!(
            AntigravityAdapter
                .parse(&next, &user_src())
                .expect("parses")
                .len(),
            1
        );
    }

    #[test]
    fn project_paths_follow_each_agent_convention() {
        let repo = PathBuf::from("D:/repo");

        let claude = ClaudeAdapter.config_sources(McpScope::Project, Some(&repo));
        assert_eq!(claude.len(), 2);
        assert_eq!(claude[0].kind, McpSourceKind::Local);
        assert_eq!(
            claude[0].project_key.as_deref(),
            Some(claude_project_key(&repo).as_str())
        );
        assert!(claude[1].path.ends_with(".mcp.json"));

        let codex = CodexAdapter.config_sources(McpScope::Project, Some(&repo));
        assert_eq!(codex.len(), 1);
        assert!(codex[0].path.ends_with("config.toml"));
    }

    #[test]
    fn a_claude_project_key_uses_forward_slashes() {
        assert_eq!(
            claude_project_key(Path::new(r"D:\kauam\repo")),
            "D:/kauam/repo"
        );
    }
}
