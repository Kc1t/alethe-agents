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
    /// `None` = o projeto testado não é um core do Alethe (não tem API de
    /// PTY, nada a verificar aqui — a maioria dos projetos de usuário). Só
    /// quando `/api/health` confirma `service: "alethe-core"` é que tentamos
    /// de verdade abrir um terminal contra a instância recém-subida — `Some`
    /// carrega se esse terminal realmente veio à tona.
    pub terminal_verified: Option<bool>,
}

/// Só roda quando `/api/health` confirma que o que subiu é um core do
/// Alethe — abre um PTY de verdade contra a instância recém-provisionada e
/// confirma um round-trip real de entrada/saída (escreve um comando com um
/// marcador único, lê de volta o scrollback até o marcador aparecer).
///
/// Spawnar um processo e achá-lo "existente" um instante depois NÃO prova
/// que o terminal funciona — o shell pode ter travado no primeiro prompt,
/// crashado silenciosamente, ou nunca aceitado entrada nenhuma (era
/// exatamente esse tipo de sinal raso, "respondeu rápido = passou", que
/// motivou toda essa revisão da Central de Merges). Só um `write` seguido
/// de um `read` confirmando o conteúdo esperado de volta é prova de verdade.
/// O PTY spawnado aqui é filho do processo que `health_probe` já mata
/// incondicionalmente ao final — não precisa de limpeza própria.
async fn verify_alethe_terminal(client: &reqwest::Client, base_url: &str) -> Option<bool> {
    let health = client
        .get(format!("{base_url}/api/health"))
        .send()
        .await
        .ok()?;
    let body: serde_json::Value = health.json().await.ok()?;
    if body.get("service").and_then(|v| v.as_str()) != Some("alethe-core") {
        return None;
    }

    let session = client
        .get(format!("{base_url}/api/session"))
        .send()
        .await
        .ok()?;
    let session_body: serde_json::Value = session.json().await.ok()?;
    let token = session_body.get("token").and_then(|v| v.as_str())?.to_string();

    let spawn_body = serde_json::json!({
        "cols": 80,
        "rows": 24,
        "command": if cfg!(windows) { "cmd" } else { "sh" },
        "profileId": "default",
    });
    let spawn_res = client
        .post(format!("{base_url}/api/pty/spawn"))
        .bearer_auth(&token)
        .json(&spawn_body)
        .send()
        .await
        .ok()?;
    if !spawn_res.status().is_success() {
        return Some(false);
    }
    let spawn_json: serde_json::Value = spawn_res.json().await.ok()?;
    let pty_id = spawn_json.get("id").and_then(|v| v.as_str())?.to_string();

    // Dá um instante pro shell terminar de inicializar (imprimir o prompt)
    // antes de mandar entrada — sem isso, o comando pode chegar cedo demais
    // e se perder.
    tokio::time::sleep(Duration::from_millis(800)).await;

    let marker = format!("ALETHE_HEALTH_PROBE_{}", nanoid::nanoid!(8));
    let echo_line = if cfg!(windows) {
        format!("echo {marker}\r\n")
    } else {
        format!("echo {marker}\n")
    };
    let write_res = client
        .post(format!("{base_url}/api/pty/write"))
        .bearer_auth(&token)
        .json(&serde_json::json!({ "id": pty_id, "data": echo_line, "profileId": "default" }))
        .send()
        .await
        .ok()?;
    if !write_res.status().is_success() {
        return Some(false);
    }

    // Faz polling do scrollback em vez de checar num único instante — um
    // shell frio (primeiro boot de um interpretador pesado) pode levar mais
    // de 1s pra processar e ecoar o comando de volta.
    let round_trip_deadline = Instant::now() + Duration::from_secs(6);
    let mut echoed_back = false;
    while Instant::now() < round_trip_deadline {
        tokio::time::sleep(Duration::from_millis(400)).await;
        let Ok(snapshot_res) = client
            .get(format!(
                "{base_url}/api/pty/snapshot/{pty_id}?maxBytes=65536&profileId=default"
            ))
            .bearer_auth(&token)
            .send()
            .await
        else {
            continue;
        };
        let Ok(snapshot) = snapshot_res.json::<serde_json::Value>().await else {
            continue;
        };
        let content = snapshot.get("content").and_then(|v| v.as_str()).unwrap_or("");
        if content.contains(&marker) {
            echoed_back = true;
            break;
        }
    }
    if !echoed_back {
        return Some(false);
    }

    // Confirma que o terminal ainda está de pé depois do round-trip — não
    // só que existiu por um instante logo após o spawn.
    let exists_res = client
        .get(format!(
            "{base_url}/api/pty/exists/{pty_id}?profileId=default"
        ))
        .bearer_auth(&token)
        .send()
        .await
        .ok()?;
    let still_alive = exists_res.json::<bool>().await.unwrap_or(false);
    Some(still_alive)
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

    let terminal_verified = if responded {
        verify_alethe_terminal(&client, &format!("http://127.0.0.1:{port}")).await
    } else {
        None
    };

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
        terminal_verified,
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
        // Nunca tenta abrir terminal contra um processo que nem respondeu —
        // `terminal_verified` só é `Some` depois de um `responded: true`
        // confirmado como alethe-core.
        assert!(result.terminal_verified.is_none());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
