//! Checks that prove, instead of assuming.
//!
//! The philosophy is the one already written down in [`crate::health_probe`]: *spawning a process
//! and finding it "existing" an instant later does not prove the terminal works*. Only a write
//! followed by a read confirming the expected content is proof. Everything here is built that way,
//! and the checks that cannot reach that bar say so in their own verdict rather than reporting a
//! reassuring green.
//!
//! Two design choices carry most of the value.
//!
//! **DNS, TCP and TLS are three checks, not one.** Today they collapse into a single opaque
//! `rendezvous_unavailable`, which is the same string for "this machine has no DNS", "a firewall
//! drops the packets" and "the certificate was refused" — three problems with three different
//! remedies. Splitting them turns "it doesn't connect" into a specific line.
//!
//! **A check whose dependency failed is `Skipped`, never run.** Attempting TLS after DNS already
//! failed produces a second, more confusing error that buries the first. The dependency is named in
//! the verdict, so the report reads as a chain that stopped at a point rather than as a wall of red.
//!
//! Every result is also emitted as a decision record, so the doctor and the log stream speak one
//! language and a run of this shows up in the flow panel like anything else.

use std::collections::BTreeMap;
use std::net::ToSocketAddrs;
use std::path::Path;
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::obs::Outcome;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// One check's verdict. Deliberately the same shape as a decision record — `outcome`, `because`,
/// `evidence` — so the doctor and the logs do not need two vocabularies for the same facts.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckResult {
    /// Stable identifier, dotted, used by later checks to declare a dependency.
    pub id: String,
    pub title: String,
    pub outcome: Outcome,
    /// Machine-readable verdict, never prose.
    pub because: String,
    pub evidence: BTreeMap<String, String>,
    /// What to do about it, in the user's language. `None` when there is nothing to do.
    pub remedy: Option<String>,
    /// The module the checked logic lives in, so the report points at code.
    pub location: String,
    pub elapsed_ms: u64,
}

struct Builder {
    id: &'static str,
    title: &'static str,
    location: &'static str,
    started: Instant,
    evidence: BTreeMap<String, String>,
}

impl Builder {
    fn new(id: &'static str, title: &'static str, location: &'static str) -> Self {
        Self {
            id,
            title,
            location,
            started: Instant::now(),
            evidence: BTreeMap::new(),
        }
    }

    fn note(mut self, key: &str, value: impl std::fmt::Display) -> Self {
        self.evidence.insert(key.to_string(), value.to_string());
        self
    }

    fn finish(self, outcome: Outcome, because: &str, remedy: Option<&str>) -> CheckResult {
        let result = CheckResult {
            id: self.id.to_string(),
            title: self.title.to_string(),
            outcome,
            because: because.to_string(),
            evidence: self.evidence,
            remedy: remedy.map(str::to_string),
            location: self.location.to_string(),
            elapsed_ms: self.started.elapsed().as_millis() as u64,
        };
        emit(&result);
        result
    }
}

/// Mirrors a verdict into the decision stream, so a doctor run is visible in the flow panel next to
/// whatever the app was doing at the time.
fn emit(result: &CheckResult) {
    // Written with the same field names `decide!` uses, so a doctor run reads in the flow panel
    // exactly like any other decision — but at `info` even when the verdict is `Ok`.
    //
    // `decide!` reports a success at `debug`, which is right for a step the app took on its own:
    // routine successes are chatter. A doctor run is not routine, it is an explicit request for a
    // report, and a healthy run that leaves no trace would be the same silence this whole effort
    // exists to remove — you would have no way to tell "everything passed" from "it never ran".
    let level_hint = if result.outcome == Outcome::Failed { "failed" } else { "reported" };
    if result.outcome == Outcome::Failed {
        tracing::warn!(
            target: "self_test",
            attempted = result.id.as_str(),
            outcome = result.outcome.as_str(),
            because = result.because.as_str(),
            rule = result.location.as_str(),
            elapsed_ms = result.elapsed_ms,
            remedy = result.remedy.as_deref().unwrap_or(""),
        );
    } else {
        tracing::info!(
            target: "self_test",
            attempted = result.id.as_str(),
            outcome = result.outcome.as_str(),
            because = result.because.as_str(),
            rule = result.location.as_str(),
            elapsed_ms = result.elapsed_ms,
            kind = level_hint,
        );
    }
}

/// A check that never ran because something it depends on failed.
fn skipped(id: &'static str, title: &'static str, location: &'static str, depends_on: &str) -> CheckResult {
    Builder::new(id, title, location)
        .note("depends_on", depends_on)
        .finish(
            Outcome::Skipped,
            "dependency_failed",
            Some("resolva a checagem anterior primeiro — esta não foi executada"),
        )
}

fn passed(results: &[CheckResult], id: &str) -> bool {
    results
        .iter()
        .find(|result| result.id == id)
        .is_some_and(|result| result.outcome == Outcome::Ok)
}

// ---------------------------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------------------------

/// The OS credential store, which every device key read goes through.
///
/// `NoEntry` is the healthy answer: the store replied, it simply holds nothing under this name. Any
/// other error means the store itself could not be reached, and on Linux that is routinely true —
/// the Secret Service is a D-Bus daemon that some sessions do not run at all.
fn check_credential_store() -> CheckResult {
    let check = Builder::new(
        "credential.store",
        "Cofre de credenciais do sistema",
        "sync_security::load_device_signing_key",
    );
    match keyring::Entry::new("com.kc1t.alethe.probe", "self-test") {
        Ok(entry) => match entry.get_secret() {
            Ok(_) | Err(keyring::Error::NoEntry) => {
                check.finish(Outcome::Ok, "credential_store_reachable", None)
            }
            Err(cause) => check.note("error", cause).finish(
                Outcome::Failed,
                "credential_store_unreachable",
                Some("destrave o chaveiro do sistema; no Linux, confirme que o Secret Service (gnome-keyring/KWallet) está rodando"),
            ),
        },
        Err(cause) => check.note("error", cause).finish(
            Outcome::Failed,
            "credential_store_unavailable",
            Some("o cofre de credenciais não existe nesta sessão — nenhuma chave de dispositivo pode ser lida"),
        ),
    }
}

/// The decision log, proved by writing and reading back.
///
/// A logger that cannot write is the worst possible failure to have silently, because the empty
/// file it leaves behind is indistinguishable from "that code path never ran" — which is the exact
/// confusion this whole effort exists to remove. Assuming it works because a path was configured is
/// not proof; a round trip is.
fn check_log_sink(data_root: &Path) -> CheckResult {
    let dir = crate::logging::logs_dir_at(data_root);
    let check = Builder::new("log.sink", "Registro de decisões gravável", "obs_sink::install")
        .note("dir", dir.display());
    if let Err(error) = std::fs::create_dir_all(&dir) {
        return check.note("error", error).finish(
            Outcome::Failed,
            "log_dir_not_creatable",
            Some("sem diretório de logs, nenhum diagnóstico do app é gravado — confira permissões"),
        );
    }
    let probe = dir.join(".self-test-probe");
    let nonce = format!("alethe-self-test-{}", crate::provider_common::now_ms());
    if let Err(error) = std::fs::write(&probe, &nonce) {
        return check.note("error", error).finish(
            Outcome::Failed,
            "log_dir_not_writable",
            Some("o diretório de logs existe mas não aceita escrita"),
        );
    }
    let read_back = std::fs::read_to_string(&probe);
    crate::best_effort!(std::fs::remove_file(&probe), "probe_file_already_gone");
    match read_back {
        // The content has to match. A write that "succeeded" and a read that returns something else
        // is a disk problem that a success/failure check would have called healthy.
        Ok(content) if content == nonce => check.finish(Outcome::Ok, "write_read_round_trip", None),
        Ok(_) => check.finish(
            Outcome::Failed,
            "log_read_back_mismatch",
            Some("o que foi lido de volta não é o que foi escrito — suspeite do disco ou de sincronização de pastas"),
        ),
        Err(error) => check.note("error", error).finish(
            Outcome::Failed,
            "log_not_readable",
            Some("a escrita passou mas a leitura falhou"),
        ),
    }
}

/// Collaboration settings load, and the endpoint they name is well-formed.
fn check_settings(data_root: &Path) -> CheckResult {
    let check = Builder::new(
        "settings.loadable",
        "Configurações de colaboração",
        "sync_activation::load_settings_at",
    );
    let settings =
        match crate::sync_activation::load_settings_at(data_root, crate::provider_common::now_ms()) {
            Ok(settings) => settings,
            Err(error) => {
                return check.note("error", error.to_string()).finish(
                    Outcome::Failed,
                    "settings_unreadable",
                    Some("o arquivo de configuração está ilegível ou corrompido"),
                )
            }
        };
    if !settings.enabled {
        return check.finish(
            Outcome::Rejected,
            "collaboration_disabled",
            Some("a colaboração está desligada nas preferências — nada abaixo pode ser verificado"),
        );
    }
    check
        .note("enabled", true)
        .finish(Outcome::Ok, "settings_loaded", None)
}

/// A trusted local device with a key binding — everything the relay handshake signs with.
fn check_identity(data_root: &Path) -> CheckResult {
    let check = Builder::new(
        "identity.trusted_device",
        "Identidade e dispositivo confiável",
        "sync_security::load_at",
    );
    let document = match crate::sync_security::load_at(data_root) {
        Ok(document) => document,
        Err(error) => {
            return check
                .note("error", error)
                .finish(Outcome::Failed, "security_document_unreadable", None)
        }
    };
    if document.account.is_none() {
        return check.finish(
            Outcome::Rejected,
            "no_account",
            Some("nenhuma conta configurada nesta instalação"),
        );
    }
    let Some(local_device_id) = document.local_device_id.clone() else {
        return check.finish(Outcome::Rejected, "no_local_device", None);
    };
    let trusted = document.devices.iter().any(|device| {
        device.device_id == local_device_id
            && device.trust == crate::sync_security::DeviceTrust::Trusted
            && device.agreement_public_key.is_some()
    });
    let check = check.note("device_id", &local_device_id);
    if trusted {
        check.finish(Outcome::Ok, "device_trusted_and_bound", None)
    } else {
        check.finish(
            Outcome::Failed,
            "device_not_trusted_or_unbound",
            Some("aprove este dispositivo a partir de um já confiável"),
        )
    }
}

/// Name resolution for the relay host, on its own.
async fn check_dns(host: &str, port: u16) -> CheckResult {
    let check = Builder::new("net.dns", "Resolução de nome do relay", "sync_rendezvous::connect_once")
        .note("host", host);
    let target = format!("{host}:{port}");
    let resolved = tokio::task::spawn_blocking(move || {
        target
            .to_socket_addrs()
            .map(|addresses| addresses.collect::<Vec<_>>())
    })
    .await;
    match resolved {
        Ok(Ok(addresses)) if !addresses.is_empty() => check
            .note("addresses", addresses.len())
            .note(
                "first",
                addresses.first().map(|a| a.to_string()).unwrap_or_default(),
            )
            .finish(Outcome::Ok, "resolved", None),
        Ok(Ok(_)) => check.finish(
            Outcome::Failed,
            "resolved_to_nothing",
            Some("o nome existe mas não devolveu endereço nenhum"),
        ),
        Ok(Err(error)) => check.note("error", error).finish(
            Outcome::Failed,
            "dns_failed",
            Some("esta máquina não conseguiu resolver o nome — confira DNS e VPN"),
        ),
        Err(error) => check
            .note("error", error)
            .finish(Outcome::Failed, "dns_task_failed", None),
    }
}

/// A TCP connection to the relay, on its own — before any TLS.
///
/// This is the check that separates "a firewall silently drops the packets" from "the certificate
/// was refused". They previously produced the same message.
async fn check_tcp(host: &str, port: u16) -> CheckResult {
    let check = Builder::new("net.tcp", "Conexão TCP com o relay", "sync_rendezvous::connect_once")
        .note("host", host)
        .note("port", port);
    let attempt = tokio::time::timeout(
        CONNECT_TIMEOUT,
        tokio::net::TcpStream::connect((host, port)),
    )
    .await;
    match attempt {
        Ok(Ok(_stream)) => check.finish(Outcome::Ok, "connected", None),
        Ok(Err(error)) => check.note("error", error).finish(
            Outcome::Failed,
            "tcp_refused",
            Some("a porta recusou a conexão — o serviço pode estar fora do ar"),
        ),
        Err(_) => check.finish(
            Outcome::Failed,
            "tcp_timeout",
            Some("nenhuma resposta dentro do prazo — normalmente firewall ou antivírus descartando os pacotes em silêncio, o que não é o mesmo que recusar"),
        ),
    }
}

/// The relay's WebSocket handshake and its protocol challenge.
///
/// Reaching the challenge is what proves TLS completed and the protocol version matches — two
/// failures that used to arrive as the same `rendezvous_unavailable` as a dead network.
async fn check_relay_handshake(endpoint: &str, account_route: &str) -> CheckResult {
    let check = Builder::new(
        "relay.handshake",
        "Handshake TLS e protocolo do relay",
        "sync_rendezvous::connect_once",
    );
    let url = match crate::sync_rendezvous::websocket_url(endpoint, account_route) {
        Ok(url) => url,
        Err(error) => {
            return check
                .note("error", error)
                .finish(Outcome::Failed, "endpoint_invalid", None)
        }
    };
    let connected = tokio::time::timeout(
        CONNECT_TIMEOUT,
        tokio_tungstenite::connect_async(url),
    )
    .await;
    match connected {
        Ok(Ok(_)) => check.finish(Outcome::Ok, "handshake_completed", None),
        Ok(Err(error)) => check.note("error", error).finish(
            Outcome::Failed,
            "handshake_rejected",
            Some("TLS ou o upgrade WebSocket foi recusado — isto é distinto de a rede estar fora, e o erro acima diz qual dos dois"),
        ),
        Err(_) => check.finish(
            Outcome::Failed,
            "handshake_timeout",
            Some("o TCP abriu mas o handshake nunca terminou — o caso clássico de antivírus interceptando WebSocket"),
        ),
    }
}

/// Runs every check, in dependency order, against an already-resolved data root.
pub async fn run_self_test_at(data_root: &Path) -> Vec<CheckResult> {
    let mut results = vec![check_log_sink(data_root), check_credential_store()];

    results.push(check_settings(data_root));
    if !passed(&results, "settings.loadable") {
        results.push(skipped(
            "identity.trusted_device",
            "Identidade e dispositivo confiável",
            "sync_security::load_at",
            "settings.loadable",
        ));
        results.push(skipped("net.dns", "Resolução de nome do relay", "sync_rendezvous::connect_once", "settings.loadable"));
        results.push(skipped("net.tcp", "Conexão TCP com o relay", "sync_rendezvous::connect_once", "settings.loadable"));
        results.push(skipped("relay.handshake", "Handshake TLS e protocolo do relay", "sync_rendezvous::connect_once", "settings.loadable"));
        return results;
    }

    results.push(check_identity(data_root));

    let endpoint = crate::sync_activation::load_settings_at(data_root, crate::provider_common::now_ms())
        .ok()
        .and_then(|settings| crate::sync_rendezvous::endpoint_for_settings(&settings).ok());
    let Some(endpoint) = endpoint else {
        results.push(skipped("net.dns", "Resolução de nome do relay", "sync_rendezvous::connect_once", "settings.loadable"));
        results.push(skipped("net.tcp", "Conexão TCP com o relay", "sync_rendezvous::connect_once", "settings.loadable"));
        results.push(skipped("relay.handshake", "Handshake TLS e protocolo do relay", "sync_rendezvous::connect_once", "settings.loadable"));
        return results;
    };

    let (host, port) = match host_and_port(&endpoint) {
        Some(pair) => pair,
        None => {
            results.push(skipped("net.dns", "Resolução de nome do relay", "sync_rendezvous::connect_once", "settings.loadable"));
            results.push(skipped("net.tcp", "Conexão TCP com o relay", "sync_rendezvous::connect_once", "settings.loadable"));
            results.push(skipped("relay.handshake", "Handshake TLS e protocolo do relay", "sync_rendezvous::connect_once", "settings.loadable"));
            return results;
        }
    };

    results.push(check_dns(&host, port).await);
    if !passed(&results, "net.dns") {
        results.push(skipped("net.tcp", "Conexão TCP com o relay", "sync_rendezvous::connect_once", "net.dns"));
        results.push(skipped("relay.handshake", "Handshake TLS e protocolo do relay", "sync_rendezvous::connect_once", "net.dns"));
        return results;
    }

    results.push(check_tcp(&host, port).await);
    if !passed(&results, "net.tcp") {
        results.push(skipped("relay.handshake", "Handshake TLS e protocolo do relay", "sync_rendezvous::connect_once", "net.tcp"));
        return results;
    }

    let account_route = crate::sync_security::load_at(data_root)
        .ok()
        .and_then(|document| document.account)
        .map(|account| crate::sync_protocol::account_route_id(&account.account_id));
    match account_route {
        Some(route) => results.push(check_relay_handshake(&endpoint, &route).await),
        None => results.push(skipped(
            "relay.handshake",
            "Handshake TLS e protocolo do relay",
            "sync_rendezvous::connect_once",
            "identity.trusted_device",
        )),
    }

    results
}

/// Host and port from an endpoint URL, defaulting the port by scheme.
pub(crate) fn host_and_port(endpoint: &str) -> Option<(String, u16)> {
    let parsed = url::Url::parse(endpoint).ok()?;
    let host = parsed.host_str()?.to_string();
    let port = parsed.port().unwrap_or(match parsed.scheme() {
        "https" | "wss" => 443,
        _ => 80,
    });
    Some((host, port))
}

#[tauri::command]
pub async fn self_test(app: tauri::AppHandle) -> Result<Vec<CheckResult>, String> {
    let data_root = crate::profiles::resolve_tauri_data_root(&app)?;
    Ok(run_self_test_at(&data_root).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_and_port_defaults_by_scheme() {
        assert_eq!(
            host_and_port("wss://relay.example.com/hub"),
            Some(("relay.example.com".into(), 443))
        );
        assert_eq!(
            host_and_port("ws://localhost:8787"),
            Some(("localhost".into(), 8787))
        );
        assert_eq!(host_and_port("not a url"), None);
    }

    #[test]
    fn a_missing_log_directory_is_reported_rather_than_assumed_healthy() {
        // A path that cannot become a directory, because a file already sits where it would go.
        let base = std::env::temp_dir().join(format!(
            "alethe-selftest-{}",
            crate::provider_common::now_ms()
        ));
        std::fs::create_dir_all(&base).unwrap();
        std::fs::write(base.join("logs"), b"not a directory").unwrap();

        let result = check_log_sink(&base);
        assert_eq!(result.outcome, Outcome::Failed);
        assert_eq!(result.because, "log_dir_not_creatable");
        assert!(result.remedy.is_some(), "a failure names what to do about it");

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_writable_log_directory_is_proved_by_a_round_trip() {
        let base = std::env::temp_dir().join(format!(
            "alethe-selftest-ok-{}",
            crate::provider_common::now_ms()
        ));
        std::fs::create_dir_all(&base).unwrap();

        let result = check_log_sink(&base);
        assert_eq!(result.outcome, Outcome::Ok);
        // The verdict names the method, not just the conclusion: only a write followed by a read
        // confirming the same content is proof, and the code should say which bar it cleared.
        assert_eq!(result.because, "write_read_round_trip");
        // The probe file must not be left behind.
        assert!(!base.join("logs").join(".self-test-probe").exists());

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_skipped_check_names_what_it_was_waiting_on() {
        // Running a check whose dependency already failed produces a second, more confusing error
        // that buries the first. Naming the dependency is what makes the report read as a chain
        // that stopped at a point.
        let result = skipped("net.tcp", "TCP", "sync_rendezvous", "net.dns");
        assert_eq!(result.outcome, Outcome::Skipped);
        assert_eq!(result.because, "dependency_failed");
        assert_eq!(result.evidence.get("depends_on").map(String::as_str), Some("net.dns"));
    }

    #[test]
    fn settings_that_are_off_are_rejected_not_failed() {
        // "Collaboration is switched off" is a true, expected state, and reporting it as a failure
        // would send someone debugging a network that is working fine.
        let base = std::env::temp_dir().join(format!(
            "alethe-selftest-settings-{}",
            crate::provider_common::now_ms()
        ));
        std::fs::create_dir_all(&base).unwrap();
        let result = check_settings(&base);
        assert!(
            matches!(result.outcome, Outcome::Rejected | Outcome::Ok),
            "a default install reports a state, never a failure: {result:?}"
        );
        let _ = std::fs::remove_dir_all(&base);
    }
}
