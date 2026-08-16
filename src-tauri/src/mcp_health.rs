use std::process::Command;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

use crate::mcp_model::McpAgent;

const PROBE_TIMEOUT: Duration = Duration::from_secs(45);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum McpHealthStatus {
    Connected,
    Failed,
    NeedsAuth,
    Disabled,
    Unknown,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpHealth {
    pub name: String,
    pub status: McpHealthStatus,
}

/// `claude mcp list` renders one line per server, health-checked, as
/// `name: <target> - <marker> <label>`. Only the marker is read; the target half can carry
/// a token in a query string and never leaves the backend.
fn parse_claude(stdout: &str) -> Vec<McpHealth> {
    stdout
        .lines()
        .filter_map(|line| {
            let (name, rest) = line.split_once(':')?;
            let name = name.trim();
            if name.is_empty() || !rest.contains(" - ") {
                return None;
            }
            let tail = rest.rsplit_once(" - ")?.1.to_ascii_lowercase();
            let status = if tail.contains("connected") {
                McpHealthStatus::Connected
            } else if tail.contains("authentication") || tail.contains("auth") {
                McpHealthStatus::NeedsAuth
            } else if tail.contains("failed") || tail.contains("error") {
                McpHealthStatus::Failed
            } else {
                McpHealthStatus::Unknown
            };
            Some(McpHealth {
                name: name.to_string(),
                status,
            })
        })
        .collect()
}

/// `codex mcp list --json` reports configuration, not a live probe: it can only say that a
/// server is disabled or unauthenticated.
fn parse_codex(stdout: &str) -> Vec<McpHealth> {
    let Ok(value) = serde_json::from_str::<Value>(stdout) else {
        return Vec::new();
    };
    value
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let name = item.get("name").and_then(Value::as_str)?;
                    let enabled = item.get("enabled").and_then(Value::as_bool).unwrap_or(true);
                    let auth = item
                        .get("auth_status")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_ascii_lowercase();
                    let status = if !enabled {
                        McpHealthStatus::Disabled
                    } else if auth.contains("unauthenticated") || auth.contains("needs") {
                        McpHealthStatus::NeedsAuth
                    } else {
                        McpHealthStatus::Unknown
                    };
                    Some(McpHealth {
                        name: name.to_string(),
                        status,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// `opencode mcp list` draws a box; each server line is `●  ✓ <name> <state>`.
fn parse_opencode(stdout: &str) -> Vec<McpHealth> {
    stdout
        .lines()
        .filter_map(|line| {
            let trimmed = line.trim_start_matches(['┌', '│', '└', '●', '─', ' ']);
            let (marker, rest) = trimmed.split_once(' ')?;
            let status = match marker {
                "✓" => McpHealthStatus::Connected,
                "✗" | "✕" | "×" => McpHealthStatus::Failed,
                _ => return None,
            };
            let name = rest.split_whitespace().next()?;
            if name.is_empty() {
                return None;
            }
            let tail = rest.to_ascii_lowercase();
            let status = if tail.contains("auth") {
                McpHealthStatus::NeedsAuth
            } else {
                status
            };
            Some(McpHealth {
                name: name.to_string(),
                status,
            })
        })
        .collect()
}

fn cli_for(agent: McpAgent) -> Option<(&'static str, Vec<&'static str>)> {
    match agent {
        McpAgent::Claude => Some(("claude", vec!["mcp", "list"])),
        McpAgent::Codex => Some(("codex", vec!["mcp", "list", "--json"])),
        McpAgent::Opencode => Some(("opencode", vec!["mcp", "list"])),
        // `agy` has no mcp subcommand at all.
        McpAgent::Antigravity => None,
    }
}

fn probe(agent: McpAgent) -> Result<Vec<McpHealth>, String> {
    let Some((binary, args)) = cli_for(agent) else {
        return Err("unsupported_agent".to_string());
    };
    let launcher = crate::cli_resolver::find_windows_cli_launcher(binary)
        .ok_or_else(|| "cli_not_found".to_string())?;

    let mut command = Command::new(launcher);
    command.args(&args);
    command.env("PATH", crate::cli_resolver::rebuilt_path());
    crate::git_control::hide_console(&mut command);

    let output = command.output().map_err(|_| "cli_failed".to_string())?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();

    Ok(match agent {
        McpAgent::Claude => parse_claude(&stdout),
        McpAgent::Codex => parse_codex(&stdout),
        McpAgent::Opencode => parse_opencode(&stdout),
        McpAgent::Antigravity => Vec::new(),
    })
}

/// Opt-in and one agent at a time: `claude mcp list` opens a connection to every server it
/// knows about, which takes seconds.
#[tauri::command]
pub async fn mcp_health_check(agent: String) -> Result<Vec<McpHealth>, String> {
    let agent = McpAgent::parse(&agent).ok_or_else(|| "unknown_agent".to_string())?;
    let task = tokio::task::spawn_blocking(move || probe(agent));
    match tokio::time::timeout(PROBE_TIMEOUT, task).await {
        Ok(joined) => joined.map_err(|error| format!("mcp_health_check:{error}"))?,
        Err(_) => Err("cli_timeout".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_output_is_read_line_by_line() {
        let stdout = "Checking MCP server health…\n\n\
            claude.ai Gmail: https://gmailmcp.googleapis.com/mcp/v1 - ✔ Connected\n\
            higgsfield: https://mcp.higgsfield.ai/mcp (HTTP) - ! Needs authentication\n\
            codeagentswarm-tasks: node C:\\x\\server.js - ✔ Connected\n\
            broken: node y.js - ✗ Failed to connect\n";
        let health = parse_claude(stdout);
        assert_eq!(health.len(), 4);
        assert_eq!(health[0].name, "claude.ai Gmail");
        assert_eq!(health[0].status, McpHealthStatus::Connected);
        assert_eq!(health[1].status, McpHealthStatus::NeedsAuth);
        assert_eq!(health[3].status, McpHealthStatus::Failed);
    }

    #[test]
    fn claude_header_lines_are_ignored() {
        assert!(parse_claude("Checking MCP server health…\n\n").is_empty());
    }

    #[test]
    fn codex_json_reports_configuration_state() {
        let stdout = r#"[
          {"name":"a","enabled":true,"auth_status":"unsupported"},
          {"name":"b","enabled":false,"disabled_reason":"x","auth_status":"unsupported"},
          {"name":"c","enabled":true,"auth_status":"unauthenticated"}
        ]"#;
        let health = parse_codex(stdout);
        assert_eq!(health.len(), 3);
        assert_eq!(health[0].status, McpHealthStatus::Unknown);
        assert_eq!(health[1].status, McpHealthStatus::Disabled);
        assert_eq!(health[2].status, McpHealthStatus::NeedsAuth);
    }

    #[test]
    fn codex_non_json_output_is_empty_not_a_panic() {
        assert!(parse_codex("not json at all").is_empty());
    }

    #[test]
    fn opencode_box_drawing_is_stripped() {
        let stdout = "┌  MCP Servers\n│\n\
            ●  ✓ codeagentswarm-tasks connected\n\
            │      node C:/x/server.js\n│\n\
            ●  ✗ broken failed\n\
            └  2 server(s)\n";
        let health = parse_opencode(stdout);
        assert_eq!(health.len(), 2);
        assert_eq!(health[0].name, "codeagentswarm-tasks");
        assert_eq!(health[0].status, McpHealthStatus::Connected);
        assert_eq!(health[1].name, "broken");
        assert_eq!(health[1].status, McpHealthStatus::Failed);
    }

    #[test]
    fn antigravity_has_no_probe() {
        assert!(cli_for(McpAgent::Antigravity).is_none());
    }

    #[test]
    fn health_payloads_carry_no_command_or_url() {
        let stdout = "a: node C:\\secret\\path.js --token=abc123 - ✔ Connected\n";
        let serialized = serde_json::to_string(&parse_claude(stdout)).expect("serializes");
        assert!(!serialized.contains("abc123"));
        assert!(!serialized.contains("secret"));
    }
}
