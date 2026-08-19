use std::collections::BTreeMap;
use std::fmt;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum McpScope {
    Global,
    Project,
}

/// One agent+scope can be served by more than one file. Claude in particular keeps the
/// servers added by `claude mcp add` (its default `local` scope) inside `~/.claude.json`
/// under `projects.<cwd>`, not in the repo's `.mcp.json`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum McpSourceKind {
    User,
    Local,
    Project,
}

impl McpSourceKind {
    pub fn as_str(self) -> &'static str {
        match self {
            McpSourceKind::User => "user",
            McpSourceKind::Local => "local",
            McpSourceKind::Project => "project",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "user" => Some(McpSourceKind::User),
            "local" => Some(McpSourceKind::Local),
            "project" => Some(McpSourceKind::Project),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpSourceState {
    pub kind: McpSourceKind,
    pub path: String,
    pub exists: bool,
    pub writable: bool,
    pub parse_error: Option<String>,
    pub mtime_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum McpAgent {
    Claude,
    Codex,
    Opencode,
    Antigravity,
}

pub const ALL_MCP_AGENTS: [McpAgent; 4] = [
    McpAgent::Claude,
    McpAgent::Codex,
    McpAgent::Opencode,
    McpAgent::Antigravity,
];

impl McpAgent {
    pub fn as_str(self) -> &'static str {
        match self {
            McpAgent::Claude => "claude",
            McpAgent::Codex => "codex",
            McpAgent::Opencode => "opencode",
            McpAgent::Antigravity => "antigravity",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "claude" => Some(McpAgent::Claude),
            "codex" => Some(McpAgent::Codex),
            "opencode" => Some(McpAgent::Opencode),
            "antigravity" | "agy" => Some(McpAgent::Antigravity),
            _ => None,
        }
    }
}

impl fmt::Display for McpAgent {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// One environment entry. Codex allows the same key to carry a static value *and*
/// appear in its `env_vars` passthrough allowlist, so both sides are independent.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct EnvEntry {
    pub literal: Option<String>,
    pub passthrough_from: Option<String>,
}

impl EnvEntry {
    pub fn literal(value: impl Into<String>) -> Self {
        EnvEntry {
            literal: Some(value.into()),
            passthrough_from: None,
        }
    }

    pub fn passthrough(from: impl Into<String>) -> Self {
        EnvEntry {
            literal: None,
            passthrough_from: Some(from.into()),
        }
    }

    pub fn view(&self) -> McpEnvEntryView {
        McpEnvEntryView {
            literal: self.literal.as_ref().map(|value| McpLiteralView {
                preview: mask_secret(value),
                empty: value.is_empty(),
            }),
            passthrough_from: self.passthrough_from.clone(),
        }
    }
}

/// Reveals the tail only when the value is long enough that four characters cannot
/// meaningfully narrow it down.
pub fn mask_secret(value: &str) -> String {
    let chars: Vec<char> = value.chars().collect();
    if chars.is_empty() {
        return String::new();
    }
    if chars.len() < 12 {
        return "•".repeat(chars.len().min(8));
    }
    let tail: String = chars[chars.len() - 4..].iter().collect();
    format!("{}{tail}", "•".repeat(8))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpLiteralView {
    pub preview: String,
    pub empty: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpEnvEntryView {
    pub literal: Option<McpLiteralView>,
    pub passthrough_from: Option<String>,
}

pub type EnvMap = BTreeMap<String, EnvEntry>;

fn view_map(source: &EnvMap) -> BTreeMap<String, McpEnvEntryView> {
    source
        .iter()
        .map(|(key, value)| (key.clone(), value.view()))
        .collect()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum McpTransport {
    Stdio {
        command: String,
        args: Vec<String>,
        cwd: Option<String>,
    },
    Http {
        url: String,
        headers: EnvMap,
    },
    Sse {
        url: String,
        headers: EnvMap,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum McpTransportView {
    Stdio {
        command: String,
        args: Vec<String>,
        cwd: Option<String>,
    },
    Http {
        url: String,
        headers: BTreeMap<String, McpEnvEntryView>,
    },
    Sse {
        url: String,
        headers: BTreeMap<String, McpEnvEntryView>,
    },
}

impl McpTransport {
    pub fn view(&self) -> McpTransportView {
        match self {
            McpTransport::Stdio { command, args, cwd } => McpTransportView::Stdio {
                command: command.clone(),
                args: args.clone(),
                cwd: cwd.clone(),
            },
            McpTransport::Http { url, headers } => McpTransportView::Http {
                url: url.clone(),
                headers: view_map(headers),
            },
            McpTransport::Sse { url, headers } => McpTransportView::Sse {
                url: url.clone(),
                headers: view_map(headers),
            },
        }
    }

    pub fn is_remote(&self) -> bool {
        !matches!(self, McpTransport::Stdio { .. })
    }

    pub fn headers(&self) -> Option<&EnvMap> {
        match self {
            McpTransport::Http { headers, .. } | McpTransport::Sse { headers, .. } => Some(headers),
            McpTransport::Stdio { .. } => None,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpTimeouts {
    pub startup_secs: Option<u32>,
    pub tool_secs: Option<u32>,
}

impl McpTimeouts {
    pub fn is_empty(&self) -> bool {
        self.startup_secs.is_none() && self.tool_secs.is_none()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpServer {
    pub name: String,
    pub transport: McpTransport,
    pub env: EnvMap,
    pub enabled: bool,
    pub timeouts: McpTimeouts,
    pub bearer_token_env_var: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerView {
    pub name: String,
    pub transport: McpTransportView,
    pub env: BTreeMap<String, McpEnvEntryView>,
    pub enabled: bool,
    pub timeouts: McpTimeouts,
    pub bearer_token_env_var: Option<String>,
}

impl McpServer {
    pub fn view(&self) -> McpServerView {
        McpServerView {
            name: self.name.clone(),
            transport: self.transport.view(),
            env: view_map(&self.env),
            enabled: self.enabled,
            timeouts: self.timeouts,
            bearer_token_env_var: self.bearer_token_env_var.clone(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct McpServerRecord {
    pub server: McpServer,
    pub agent: McpAgent,
    pub scope: McpScope,
    pub source_kind: McpSourceKind,
    pub source_path: String,
    pub managed_by_import: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerRecordView {
    pub server: McpServerView,
    pub agent: McpAgent,
    pub scope: McpScope,
    pub source_kind: McpSourceKind,
    pub source_path: String,
    pub managed_by_import: Option<String>,
}

impl McpServerRecord {
    pub fn view(&self) -> McpServerRecordView {
        McpServerRecordView {
            server: self.server.view(),
            agent: self.agent,
            scope: self.scope,
            source_kind: self.source_kind,
            source_path: self.source_path.clone(),
            managed_by_import: self.managed_by_import.clone(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpAgentSnapshot {
    pub agent: McpAgent,
    pub scope: McpScope,
    pub sources: Vec<McpSourceState>,
    pub servers: Vec<McpServerRecordView>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpCapability {
    pub agent: McpAgent,
    pub project_scope: bool,
    pub enabled_flag: bool,
    pub env_passthrough: bool,
    pub timeouts: bool,
    pub headers: bool,
    pub remote: bool,
}

pub fn capability(agent: McpAgent) -> McpCapability {
    match agent {
        McpAgent::Claude => McpCapability {
            agent,
            project_scope: true,
            enabled_flag: false,
            env_passthrough: false,
            timeouts: false,
            headers: true,
            remote: true,
        },
        McpAgent::Codex => McpCapability {
            agent,
            project_scope: true,
            enabled_flag: true,
            env_passthrough: true,
            timeouts: true,
            headers: false,
            remote: true,
        },
        McpAgent::Opencode => McpCapability {
            agent,
            project_scope: true,
            enabled_flag: true,
            env_passthrough: true,
            timeouts: false,
            headers: true,
            remote: true,
        },
        McpAgent::Antigravity => McpCapability {
            agent,
            project_scope: false,
            enabled_flag: false,
            env_passthrough: false,
            timeouts: false,
            headers: true,
            remote: true,
        },
    }
}

/// A field the source server carries that the target agent cannot express.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnsupportedField {
    pub agent: McpAgent,
    pub field: String,
    pub detail: String,
}

pub fn unsupported_fields(agent: McpAgent, server: &McpServer) -> Vec<UnsupportedField> {
    let caps = capability(agent);
    let mut out = Vec::new();

    if !caps.env_passthrough {
        let headers = server.transport.headers();
        let entries = server
            .env
            .iter()
            .map(|(key, entry)| (format!("env.{key}"), entry))
            .chain(
                headers
                    .into_iter()
                    .flatten()
                    .map(|(key, entry)| (format!("headers.{key}"), entry)),
            );
        for (field, entry) in entries {
            if let Some(from) = &entry.passthrough_from {
                out.push(UnsupportedField {
                    agent,
                    field,
                    detail: from.clone(),
                });
            }
        }
    }
    if !caps.timeouts && !server.timeouts.is_empty() {
        out.push(UnsupportedField {
            agent,
            field: "timeouts".to_string(),
            detail: String::new(),
        });
    }
    if !caps.remote && server.transport.is_remote() {
        out.push(UnsupportedField {
            agent,
            field: "transport".to_string(),
            detail: String::new(),
        });
    }
    if !caps.headers && server.transport.headers().is_some_and(|h| !h.is_empty()) {
        out.push(UnsupportedField {
            agent,
            field: "headers".to_string(),
            detail: String::new(),
        });
    }
    if server.bearer_token_env_var.is_some() && agent != McpAgent::Codex {
        out.push(UnsupportedField {
            agent,
            field: "bearerTokenEnvVar".to_string(),
            detail: String::new(),
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stdio_server(name: &str) -> McpServer {
        McpServer {
            name: name.to_string(),
            transport: McpTransport::Stdio {
                command: "node".to_string(),
                args: vec!["server.js".to_string()],
                cwd: None,
            },
            env: EnvMap::new(),
            enabled: true,
            timeouts: McpTimeouts::default(),
            bearer_token_env_var: None,
        }
    }

    #[test]
    fn agent_parse_accepts_the_antigravity_binary_name() {
        assert_eq!(McpAgent::parse("agy"), Some(McpAgent::Antigravity));
        assert_eq!(McpAgent::parse("Antigravity"), Some(McpAgent::Antigravity));
        assert_eq!(McpAgent::parse("shell"), None);
    }

    #[test]
    fn mask_secret_hides_short_values_entirely() {
        assert_eq!(mask_secret(""), "");
        assert_eq!(mask_secret("abc"), "•••");
        assert_eq!(mask_secret("short-11ch"), "••••••••");
    }

    #[test]
    fn mask_secret_keeps_only_the_tail_of_long_values() {
        let masked = mask_secret("sk-proj-abcdefghijklmnop");
        assert!(masked.ends_with("mnop"));
        assert!(!masked.contains("abcdefghijkl"));
    }

    #[test]
    fn an_entry_can_be_literal_and_passthrough_at_once() {
        let entry = EnvEntry {
            literal: Some("1".to_string()),
            passthrough_from: Some("QUADRANT".to_string()),
        };
        let view = entry.view();
        assert!(view.literal.is_some());
        assert_eq!(view.passthrough_from.as_deref(), Some("QUADRANT"));
    }

    #[test]
    fn passthrough_env_is_unsupported_on_claude_but_fine_on_codex() {
        let mut server = stdio_server("probe");
        server
            .env
            .insert("TOKEN".to_string(), EnvEntry::passthrough("TOKEN"));

        let blocked = unsupported_fields(McpAgent::Claude, &server);
        assert_eq!(blocked.len(), 1);
        assert_eq!(blocked[0].field, "env.TOKEN");

        assert!(unsupported_fields(McpAgent::Codex, &server).is_empty());
    }

    #[test]
    fn timeouts_only_survive_on_codex() {
        let mut server = stdio_server("probe");
        server.timeouts = McpTimeouts {
            startup_secs: Some(30),
            tool_secs: None,
        };
        assert!(unsupported_fields(McpAgent::Codex, &server).is_empty());
        assert_eq!(unsupported_fields(McpAgent::Opencode, &server).len(), 1);
    }

    #[test]
    fn literal_env_never_leaks_through_the_view() {
        let mut server = stdio_server("probe");
        server.env.insert(
            "DISCORD_TOKEN".to_string(),
            EnvEntry::literal("super-secret-token-value"),
        );
        let serialized = serde_json::to_string(&server.view()).expect("serializes");
        assert!(!serialized.contains("super-secret-token"));
    }
}
