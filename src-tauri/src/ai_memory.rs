//!

//!

//!   via `--mcp-config <path>` no `buildAgentLaunch`.

//!

use std::net::{TcpStream, ToSocketAddrs};
use std::process::Command;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

use crate::git_control::{hide_console, repository_root};

const DEFAULT_COMMAND: &str = "ai-memory";

/// health-check de "running".
const DEFAULT_ENDPOINT: &str = "127.0.0.1:49374";

const MCP_KEY: &str = "ai-memory";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiMemoryStatus {
    installed: bool,
    /// Servidor respondendo no endpoint loopback.
    running: bool,
    command: String,
    endpoint: String,
    version: Option<String>,
}

fn short_hash(input: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    input.hash(&mut hasher);
    format!("{:x}", hasher.finish())
}

/// interface oficial for pinada (stdio via `ai-memory mcp` vs. transporte
/// HTTP/SSE no endpoint loopback). Por ora usa o bridge stdio, coerente com o

/// o root como argumento.
fn mcp_server_spec(command: &str) -> Value {
    serde_json::json!({
        "command": command,
        "args": [ "mcp" ]
    })
}

/// causa do health-check.
#[tauri::command]
pub fn ai_memory_detect(command: Option<String>) -> Result<AiMemoryStatus, String> {
    let cmd = command.unwrap_or_else(|| DEFAULT_COMMAND.to_string());

    let mut probe = Command::new(&cmd);
    probe.arg("--version");
    hide_console(&mut probe);
    let (installed, version) = match probe.output() {
        Ok(output) if output.status.success() => {
            let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
            (true, (!version.is_empty()).then_some(version))
        }
        _ => (false, None),
    };

    let running = endpoint_alive(DEFAULT_ENDPOINT);

    Ok(AiMemoryStatus {
        installed,
        running,
        command: cmd,
        endpoint: DEFAULT_ENDPOINT.to_string(),
        version,
    })
}

fn endpoint_alive(endpoint: &str) -> bool {
    let Ok(mut addrs) = endpoint.to_socket_addrs() else {
        return false;
    };
    addrs.any(|addr| TcpStream::connect_timeout(&addr, Duration::from_millis(250)).is_ok())
}

#[tauri::command]
pub fn ai_memory_mcp_config_path(repo: String, command: Option<String>) -> Result<String, String> {
    let root = repository_root(&repo)?;
    let cmd = command.unwrap_or_else(|| DEFAULT_COMMAND.to_string());
    let config = serde_json::json!({

        "mcpServers": { (MCP_KEY): mcp_server_spec(&cmd) }
    });
    let file_name = format!(
        "alethe-ai-memory-mcp-{}.json",
        short_hash(&root.to_string_lossy())
    );
    let path = std::env::temp_dir().join(file_name);
    let body = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    std::fs::write(&path, body).map_err(|e| format!("write_failed:{e}"))?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn ai_memory_opencode_config_write(
    repo: String,
    command: Option<String>,
) -> Result<(), String> {
    let root = repository_root(&repo)?;
    let cmd = command.unwrap_or_else(|| DEFAULT_COMMAND.to_string());
    let path = root.join("opencode.json");

    let mut config: serde_json::Map<String, Value> = if path.is_file() {
        let raw = std::fs::read_to_string(&path).map_err(|e| format!("read_failed:{e}"))?;
        match serde_json::from_str::<Value>(&raw) {
            Ok(Value::Object(map)) => map,

            _ => return Ok(()),
        }
    } else {
        let mut map = serde_json::Map::new();
        map.insert(
            "$schema".to_string(),
            Value::String("https://opencode.ai/config.json".to_string()),
        );
        map
    };

    let mcp = config
        .entry("mcp".to_string())
        .or_insert_with(|| Value::Object(serde_json::Map::new()));
    if let Value::Object(mcp_map) = mcp {
        mcp_map.insert(
            MCP_KEY.to_string(),
            serde_json::json!({
                "type": "local",
                "command": [cmd, "mcp"],
                "enabled": true,
            }),
        );
    }

    let body = serde_json::to_string_pretty(&Value::Object(config)).map_err(|e| e.to_string())?;
    std::fs::write(&path, body).map_err(|e| format!("write_failed:{e}"))
}

#[tauri::command]
pub fn ai_memory_codex_config_write(repo: String, command: Option<String>) -> Result<(), String> {
    let root = repository_root(&repo)?;
    let cmd = command.unwrap_or_else(|| DEFAULT_COMMAND.to_string());
    let codex_dir = root.join(".codex");
    std::fs::create_dir_all(&codex_dir).map_err(|e| format!("mkdir_failed:{e}"))?;
    let path = codex_dir.join("config.toml");

    let existing = if path.is_file() {
        std::fs::read_to_string(&path).map_err(|e| format!("read_failed:{e}"))?
    } else {
        String::new()
    };

    let header = format!("[mcp_servers.\"{MCP_KEY}\"]");
    let mut kept_lines: Vec<&str> = Vec::new();
    let mut skipping = false;
    for line in existing.lines() {
        let trimmed = line.trim();
        if trimmed == header {
            skipping = true;
            continue;
        }
        if skipping && trimmed.starts_with('[') {
            skipping = false;
        }
        if !skipping {
            kept_lines.push(line);
        }
    }
    let mut body = kept_lines.join("\n");
    if !body.is_empty() && !body.ends_with('\n') {
        body.push('\n');
    }

    let toml_escape = |s: &str| s.replace('\\', "\\\\").replace('"', "\\\"");
    let cmd_toml = toml_escape(&cmd);
    body.push_str(&format!(
        "\n{header}\ncommand = \"{cmd_toml}\"\nargs = [\"mcp\"]\n",
    ));

    std::fs::write(&path, body).map_err(|e| format!("write_failed:{e}"))
}
