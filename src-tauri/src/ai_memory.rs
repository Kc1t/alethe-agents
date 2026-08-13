//! Integração com o **ai-memory** (https://github.com/akitaonrails/ai-memory) —
//! memória de longo prazo compartilhada entre agentes de código.
//!
//! O ai-memory é uma ferramenta EXTERNA (o Alethe apenas detecta e injeta, não
//! reimplementa): um binário Rust que sobe um servidor local (MCP + HTTP) e
//! roteia por-projeto automaticamente pela cwd do agente / marcador
//! `.ai-memory.toml`. Aqui tratamos apenas da **injeção do MCP** por sessão,
//! espelhando o padrão do Graphify (ver `graphify.rs`):
//!
//! - **Claude Code:** gera um arquivo de config MCP temporário e o front injeta
//!   via `--mcp-config <path>` no `buildAgentLaunch`.
//! - **OpenCode / Codex:** não têm flag equivalente — leem MCP de um arquivo de
//!   config ambiente no diretório do projeto (`opencode.json` / `.codex/config.toml`),
//!   então a injeção é mesclar esse arquivo antes do spawn.
//!
//! Diferente do Graphify, o bridge NÃO recebe o root do projeto como argumento:
//! o ai-memory infere o projeto a partir da cwd do agente. O comando/args/transporte
//! exatos do MCP ainda dependem de pinar a interface oficial — por isso ficam
//! concentrados em `mcp_server_spec`, ponto único a ajustar.

use std::net::{TcpStream, ToSocketAddrs};
use std::process::Command;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

use crate::git_control::{hide_console, repository_root};

/// Nome padrão do binário do ai-memory. Configurável a partir do front.
const DEFAULT_COMMAND: &str = "ai-memory";
/// Endpoint padrão (loopback) do servidor do ai-memory — usado só para o
/// health-check de "running".
const DEFAULT_ENDPOINT: &str = "127.0.0.1:49374";
/// Chave usada nos arquivos de config MCP dos agentes.
const MCP_KEY: &str = "ai-memory";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiMemoryStatus {
    /// Binário encontrado no PATH (`<cmd> --version` respondeu).
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

/// Especificação do servidor MCP do ai-memory. Ponto único a ajustar quando a
/// interface oficial for pinada (stdio via `ai-memory mcp` vs. transporte
/// HTTP/SSE no endpoint loopback). Por ora usa o bridge stdio, coerente com o
/// padrão do Graphify; o ai-memory infere o projeto pela cwd, então não passamos
/// o root como argumento.
fn mcp_server_spec(command: &str) -> Value {
    serde_json::json!({
        "command": command,
        "args": [ "mcp" ]
    })
}

/// Detecta se o ai-memory está instalado (`<cmd> --version`) e se o servidor
/// está de pé (conexão TCP no endpoint loopback). Best-effort: nunca falha por
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

/// Health-check leve: tenta abrir uma conexão TCP no endpoint com timeout curto.
fn endpoint_alive(endpoint: &str) -> bool {
    let Ok(mut addrs) = endpoint.to_socket_addrs() else {
        return false;
    };
    addrs.any(|addr| TcpStream::connect_timeout(&addr, Duration::from_millis(250)).is_ok())
}

/// Escreve (idempotente por projeto) o config MCP que registra o servidor do
/// ai-memory e retorna o path. O front injeta via `--mcp-config <path>` no launch
/// do Claude, sem tocar no `.claude/` do repo do usuário.
#[tauri::command]
pub fn ai_memory_mcp_config_path(repo: String, command: Option<String>) -> Result<String, String> {
    let root = repository_root(&repo)?;
    let cmd = command.unwrap_or_else(|| DEFAULT_COMMAND.to_string());
    let config = serde_json::json!({
        // Chave dinâmica no json! precisa vir parentizada.
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

/// Mescla (sem sobrescrever outras chaves) a entrada `mcp.ai-memory` em
/// `<repo>/opencode.json`. Best-effort: chamado no spawn, nunca deve bloquear.
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
            // Arquivo existe mas não é JSON de objeto limpo (JSONC/corrompido) —
            // não arrisca sobrescrever config do usuário às cegas.
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

/// Mescla (sem sobrescrever outras chaves) a tabela `[mcp_servers.ai-memory]`
/// em `<repo>/.codex/config.toml`. Remove só o bloco pré-existente com essa
/// chave (delimitado até a próxima linha `[...]` ou EOF) e acrescenta o bloco
/// atualizado no fim, preservando o resto do arquivo (comentários/formatação).
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

    // A chave TOML tem hífen, então precisa vir entre aspas: [mcp_servers."ai-memory"].
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
    // Escapa para string básica TOML: contrabarra e aspas (nessa ordem). Sem isso,
    // um path do Windows (C:\Users\..\ai-memory.exe) vira escape TOML inválido e
    // corrompe TODO o config.toml do usuário.
    let toml_escape = |s: &str| s.replace('\\', "\\\\").replace('"', "\\\"");
    let cmd_toml = toml_escape(&cmd);
    body.push_str(&format!(
        "\n{header}\ncommand = \"{cmd_toml}\"\nargs = [\"mcp\"]\n",
    ));

    std::fs::write(&path, body).map_err(|e| format!("write_failed:{e}"))
}
