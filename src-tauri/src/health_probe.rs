//! Bloco 2.3 do plano da Central de Merges — probe de saúde ao vivo.
//!
//! Sobe o comando de start do backend do projeto do usuário num ambiente
//! efêmero (mesmo `env_path` de `merge_prepare`), numa porta isolada obtida
//! via bind de teste (nunca colide com o dev server real do usuário), e faz
//! poll de um endpoint de saúde até responder ou estourar o timeout. A árvore
//! de processo é morta INCONDICIONALMENTE ao final — sucesso, falha ou
//! timeout — nunca deixa um servidor de teste vivo em background. Camada de
//! AVISO (Camada 4 do Escudo): o resultado nunca bloqueia o merge sozinho,
//! só informa quem decide (Camada 5 — o usuário).

use serde::Serialize;
use std::net::TcpListener;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::io::AsyncReadExt;
use tokio::process::Command;

use crate::pty::kill_process_tree;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthProbeResult {
    pub started: bool,
    pub responded: bool,
    pub status_code: Option<u16>,
    pub elapsed_ms: u64,
    pub output_tail: String,
}

const MAX_OUTPUT_TAIL: usize = 4000;

fn free_port() -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    drop(listener);
    Ok(port)
}

fn append_capped(buffer: &Mutex<String>, chunk: &str) {
    let mut guard = buffer.lock().unwrap_or_else(|poison| poison.into_inner());
    guard.push_str(chunk);
    if guard.len() > MAX_OUTPUT_TAIL {
        let excess = guard.len() - MAX_OUTPUT_TAIL;
        guard.drain(0..excess);
    }
}

async fn pump_output(mut reader: impl tokio::io::AsyncRead + Unpin, buffer: Arc<Mutex<String>>) {
    let mut chunk = [0u8; 1024];
    loop {
        match reader.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(n) => append_capped(&buffer, &String::from_utf8_lossy(&chunk[..n])),
        }
    }
}

#[tauri::command]
pub async fn health_probe(
    env_path: String,
    start_command: String,
    path: String,
    timeout_ms: u64,
) -> Result<HealthProbeResult, String> {
    let started_at = Instant::now();
    if !std::path::Path::new(&env_path).is_dir() {
        return Err("env_not_found".to_string());
    }
    let port = free_port()?;

    let mut command = if cfg!(windows) {
        let mut c = Command::new("cmd");
        c.args(["/C", &start_command]);
        c
    } else {
        let mut c = Command::new("sh");
        c.args(["-c", &start_command]);
        c
    };
    command
        .current_dir(&env_path)
        .env("PORT", port.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = command.spawn().map_err(|e| format!("spawn_failed:{e}"))?;
    let pid = child.id();
    let output_buffer = Arc::new(Mutex::new(String::new()));

    if let Some(stdout) = child.stdout.take() {
        tokio::spawn(pump_output(stdout, Arc::clone(&output_buffer)));
    }
    if let Some(stderr) = child.stderr.take() {
        tokio::spawn(pump_output(stderr, Arc::clone(&output_buffer)));
    }

    let url = {
        let normalized = if path.starts_with('/') {
            path.clone()
        } else {
            format!("/{path}")
        };
        format!("http://127.0.0.1:{port}{normalized}")
    };
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(3))
        .build()
        .map_err(|e| e.to_string())?;

    let deadline = started_at + Duration::from_millis(timeout_ms.max(1000));
    let mut responded = false;
    let mut status_code = None;
    while Instant::now() < deadline {
        match client.get(&url).send().await {
            Ok(response) => {
                responded = true;
                status_code = Some(response.status().as_u16());
                break;
            }
            Err(_) => {
                if let Ok(Some(_)) = child.try_wait() {
                    break; // processo já morreu — parar de tentar, resto do tempo seria desperdiçado
                }
                tokio::time::sleep(Duration::from_millis(400)).await;
            }
        }
    }

    // Kill incondicional da árvore inteira — nunca deixa o servidor de teste
    // vivo em background, não importa como o loop acima terminou.
    if let Some(pid) = pid {
        kill_process_tree(pid);
    }
    let _ = child.start_kill();
    let _ = child.wait().await;

    let elapsed_ms = started_at.elapsed().as_millis() as u64;
    let output_tail = output_buffer
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .clone();

    Ok(HealthProbeResult {
        started: true,
        responded,
        status_code,
        elapsed_ms,
        output_tail,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn errors_on_missing_env_path() {
        let result = health_probe(
            "D:/definitely-not-a-real-path-xyz".to_string(),
            "echo hi".to_string(),
            "/health".to_string(),
            1000,
        )
        .await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn kills_process_and_reports_no_response_on_timeout() {
        let dir = std::env::temp_dir().join(format!("alethe-healthprobe-{}", nanoid::nanoid!(6)));
        std::fs::create_dir_all(&dir).unwrap();
        // Comando que nunca abre porta nenhuma — probe deve estourar o timeout
        // curto e voltar com responded:false, sem travar o teste.
        let sleep_cmd = if cfg!(windows) {
            "ping -n 30 127.0.0.1 >NUL"
        } else {
            "sleep 30"
        };
        let result = health_probe(
            dir.to_string_lossy().into_owned(),
            sleep_cmd.to_string(),
            "/health".to_string(),
            1200,
        )
        .await
        .unwrap();
        assert!(!result.responded);
        assert!(result.status_code.is_none());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
