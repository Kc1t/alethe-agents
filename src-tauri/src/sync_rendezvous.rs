//! Provider-neutral rendezvous client and Cloudflare-compatible WebSocket adapter (Phase 10B).
//! Cloudflare deployment APIs never enter this module: the client consumes only Alethe's
//! versioned HTTPS/WebSocket protocol and authenticates with the existing device identity.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use ed25519_dalek::Signer;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;
use tokio::sync::{mpsc, watch};
use tokio_tungstenite::tungstenite::Message;

use crate::sync_activation::{ActivationError, LiveConnectionStatus, ServiceMode};

const EVENT_QUEUE_LIMIT: usize = 256;
const OUTGOING_QUEUE_LIMIT: usize = 128;
const MAX_FRAME_BYTES: usize = 24 * 1024;
const MAX_CIPHERTEXT_BYTES: usize = 16 * 1024;
const MAX_ENVELOPE_TTL_MS: u64 = 7 * 24 * 60 * 60 * 1_000;
const MAX_CANDIDATE_TTL_MS: u64 = 5 * 60 * 1_000;
const PROTOCOL_VERSION: u32 = 1;
const MANAGED_ENDPOINT: Option<&str> = option_env!("ALETHE_RENDEZVOUS_ENDPOINT");

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RendezvousStatus {
    pub state: LiveConnectionStatusView,
    pub queued_events: usize,
    pub endpoint_configured: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LiveConnectionStatusView {
    NoAttemptYet,
    Connecting,
    Online,
    RetryingAfterTransientFailure,
    DirectSessionOnly,
    ProviderFailure,
}

impl From<LiveConnectionStatus> for LiveConnectionStatusView {
    fn from(value: LiveConnectionStatus) -> Self {
        match value {
            LiveConnectionStatus::NoAttemptYet => Self::NoAttemptYet,
            LiveConnectionStatus::Connecting => Self::Connecting,
            LiveConnectionStatus::Online => Self::Online,
            LiveConnectionStatus::RetryingAfterTransientFailure => {
                Self::RetryingAfterTransientFailure
            }
            LiveConnectionStatus::DirectSessionOnly => Self::DirectSessionOnly,
            LiveConnectionStatus::ProviderFailure => Self::ProviderFailure,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RendezvousEvent {
    pub event_type: String,
    pub message_id: Option<String>,
    pub envelope_kind: Option<String>,
    pub sender_device_id: Option<String>,
    pub ciphertext: Option<String>,
    pub expires_at_ms: Option<u64>,
    pub devices: Option<Vec<Value>>,
}

enum Outgoing {
    Json(Value),
}

#[derive(Default)]
pub struct RendezvousRuntime {
    status: RwLock<LiveConnectionStatus>,
    outgoing: Mutex<Option<mpsc::Sender<Outgoing>>>,
    stop: Mutex<Option<watch::Sender<bool>>>,
    events: Mutex<VecDeque<RendezvousEvent>>,
}

impl Default for LiveConnectionStatus {
    fn default() -> Self {
        Self::NoAttemptYet
    }
}

impl RendezvousRuntime {
    fn set_status(&self, status: LiveConnectionStatus) {
        if let Ok(mut current) = self.status.write() {
            *current = status;
        }
    }

    pub(crate) fn status(&self) -> LiveConnectionStatus {
        self.status
            .read()
            .map(|value| *value)
            .unwrap_or(LiveConnectionStatus::ProviderFailure)
    }

    fn push_event(&self, event: RendezvousEvent) {
        if let Ok(mut events) = self.events.lock() {
            if events.len() == EVENT_QUEUE_LIMIT {
                events.pop_front();
            }
            events.push_back(event);
        }
    }

    fn stop(&self) {
        if let Ok(mut sender) = self.stop.lock() {
            if let Some(sender) = sender.take() {
                let _ = sender.send(true);
            }
        }
        if let Ok(mut outgoing) = self.outgoing.lock() {
            outgoing.take();
        }
        self.set_status(LiveConnectionStatus::NoAttemptYet);
    }
}

fn validated_endpoint(endpoint: &str) -> Result<String, String> {
    let parsed =
        url::Url::parse(endpoint).map_err(|_| "activation_invalid_endpoint".to_string())?;
    let secure = parsed.scheme() == "https" || parsed.scheme() == "wss";
    let local_debug = cfg!(debug_assertions)
        && matches!(parsed.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))
        && matches!(parsed.scheme(), "http" | "ws");
    if !secure && !local_debug {
        return Err("activation_tls_required".to_string());
    }
    if parsed.username() != ""
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err("activation_invalid_endpoint".to_string());
    }
    Ok(endpoint.trim_end_matches('/').to_string())
}

fn endpoint_for_settings(
    settings: &crate::sync_activation::ServiceSettings,
) -> Result<String, String> {
    match settings.mode {
        ServiceMode::LocalOnly => Err("activation_disabled".to_string()),
        ServiceMode::AletheManaged => MANAGED_ENDPOINT
            .ok_or_else(|| "activation_managed_endpoint_unconfigured".to_string())
            .and_then(validated_endpoint),
        ServiceMode::AdvancedCustom => settings
            .validated_endpoint
            .as_deref()
            .ok_or_else(|| "activation_invalid_endpoint".to_string())
            .and_then(validated_endpoint),
    }
}

fn websocket_url(endpoint: &str, account_route: &str) -> Result<String, String> {
    let mut url =
        url::Url::parse(endpoint).map_err(|_| "activation_invalid_endpoint".to_string())?;
    url.set_scheme(match url.scheme() {
        "https" => "wss",
        "http" => "ws",
        "wss" => "wss",
        "ws" => "ws",
        _ => return Err("activation_invalid_endpoint".to_string()),
    })
    .map_err(|_| "activation_invalid_endpoint".to_string())?;
    url.set_path("/v1/connect");
    url.query_pairs_mut()
        .append_pair("accountRoute", account_route);
    Ok(url.to_string())
}

fn auth_message(account_route: &str, device_id: &str, generation: u64, challenge: &str) -> Vec<u8> {
    format!(
        "alethe-rendezvous-auth-v1\n{account_route}\n{device_id}\n{generation}\n{challenge}\n{PROTOCOL_VERSION}"
    )
    .into_bytes()
}

async fn connect_once(
    runtime: Arc<RendezvousRuntime>,
    endpoint: &str,
    data_root: &std::path::Path,
    outgoing_rx: &mut mpsc::Receiver<Outgoing>,
    stop_rx: &mut watch::Receiver<bool>,
) -> Result<(), String> {
    let document = crate::sync_security::load_at(data_root)?;
    let account = document
        .account
        .ok_or_else(|| "activation_identity_required".to_string())?;
    let local_device_id = document
        .local_device_id
        .ok_or_else(|| "local_device_unknown".to_string())?;
    let device = document
        .devices
        .into_iter()
        .find(|candidate| {
            candidate.device_id == local_device_id
                && candidate.trust == crate::sync_security::DeviceTrust::Trusted
        })
        .ok_or_else(|| "device_not_trusted".to_string())?;
    let agreement_public_key = device
        .agreement_public_key
        .ok_or_else(|| "device_key_binding_missing".to_string())?;
    let agreement_bound_at_ms = device
        .agreement_key_bound_at_ms
        .ok_or_else(|| "device_key_binding_missing".to_string())?;
    let agreement_binding_signature = device
        .agreement_key_binding_signature
        .ok_or_else(|| "device_key_binding_missing".to_string())?;
    let account_route = crate::sync_protocol::account_route_id(&account.account_id);
    let signing_key = crate::sync_security::load_device_signing_key(&device.device_id)?;
    let (socket, _) = tokio_tungstenite::connect_async(websocket_url(endpoint, &account_route)?)
        .await
        .map_err(|_| "rendezvous_unavailable".to_string())?;
    let (mut writer, mut reader) = socket.split();
    let challenge_message = tokio::time::timeout(Duration::from_secs(15), reader.next())
        .await
        .map_err(|_| "rendezvous_challenge_timeout".to_string())?
        .ok_or_else(|| "rendezvous_closed".to_string())?
        .map_err(|_| "rendezvous_protocol_error".to_string())?;
    let challenge_text = challenge_message
        .into_text()
        .map_err(|_| "rendezvous_protocol_error".to_string())?;
    if challenge_text.len() > MAX_FRAME_BYTES {
        return Err("rendezvous_frame_too_large".to_string());
    }
    let challenge_value: Value = serde_json::from_str(&challenge_text)
        .map_err(|_| "rendezvous_protocol_error".to_string())?;
    if challenge_value.get("type").and_then(Value::as_str) != Some("challenge")
        || challenge_value
            .get("protocolVersion")
            .and_then(Value::as_u64)
            != Some(PROTOCOL_VERSION as u64)
    {
        return Err("activation_protocol_incompatible".to_string());
    }
    let challenge = challenge_value
        .get("challenge")
        .and_then(Value::as_str)
        .filter(|value| value.len() <= 96)
        .ok_or_else(|| "rendezvous_protocol_error".to_string())?;
    let key_generation = 1_u64;
    let signature = signing_key.sign(&auth_message(
        &account_route,
        &device.device_id,
        key_generation,
        challenge,
    ));
    let auth = json!({
        "type": "auth",
        "protocolVersion": PROTOCOL_VERSION,
        "accountRoute": account_route,
        "deviceId": device.device_id,
        "publicKey": device.public_key,
        "agreementPublicKey": agreement_public_key,
        "agreementBoundAtMs": agreement_bound_at_ms,
        "agreementBindingSignature": agreement_binding_signature,
        "keyGeneration": key_generation,
        "challenge": challenge,
        "signature": URL_SAFE_NO_PAD.encode(signature.to_bytes()),
    });
    writer
        .send(Message::Text(auth.to_string().into()))
        .await
        .map_err(|_| "rendezvous_unavailable".to_string())?;
    let authenticated = tokio::time::timeout(Duration::from_secs(15), reader.next())
        .await
        .map_err(|_| "rendezvous_auth_timeout".to_string())?
        .ok_or_else(|| "rendezvous_closed".to_string())?
        .map_err(|_| "rendezvous_protocol_error".to_string())?;
    let authenticated_text = authenticated
        .into_text()
        .map_err(|_| "rendezvous_protocol_error".to_string())?;
    let authenticated_value: Value = serde_json::from_str(&authenticated_text)
        .map_err(|_| "rendezvous_protocol_error".to_string())?;
    if authenticated_value.get("type").and_then(Value::as_str) != Some("authenticated") {
        return Err("rendezvous_authentication_failed".to_string());
    }
    runtime.set_status(LiveConnectionStatus::Online);
    writer
        .send(Message::Text(
            json!({ "type": "presence", "generation": 1_u64,
        "expiresAtMs": crate::provider_common::now_ms() + 120_000 })
            .to_string()
            .into(),
        ))
        .await
        .map_err(|_| "rendezvous_unavailable".to_string())?;

    loop {
        tokio::select! {
            changed = stop_rx.changed() => {
                if changed.is_err() || *stop_rx.borrow() {
                    let _ = writer.send(Message::Close(None)).await;
                    return Ok(());
                }
            }
            outgoing = outgoing_rx.recv() => {
                let Some(Outgoing::Json(value)) = outgoing else { return Ok(()); };
                let text = value.to_string();
                if text.len() > MAX_FRAME_BYTES { continue; }
                writer.send(Message::Text(text.into())).await.map_err(|_| "rendezvous_unavailable".to_string())?;
            }
            incoming = reader.next() => {
                let Some(incoming) = incoming else { return Err("rendezvous_closed".to_string()); };
                let message = incoming.map_err(|_| "rendezvous_unavailable".to_string())?;
                if message.is_close() { return Err("rendezvous_closed".to_string()); }
                if let Message::Text(text) = message {
                    if text.len() > MAX_FRAME_BYTES { return Err("rendezvous_frame_too_large".to_string()); }
                    if let Ok(value) = serde_json::from_str::<Value>(&text) {
                        let event_type = value.get("type").and_then(Value::as_str).unwrap_or("unknown").to_string();
                        if matches!(event_type.as_str(), "delivery" | "devices" | "error") {
                            if event_type == "delivery" {
                                if let Some(subject) = value.get("id").and_then(Value::as_str) {
                                    let kind = match value.get("kind").and_then(Value::as_str) {
                                        Some("invitation") => crate::sync_access::AccessKind::RemoteInvitation,
                                        Some("candidate") => crate::sync_access::AccessKind::ConnectionCandidate,
                                        Some("revocation") => crate::sync_access::AccessKind::Revocation,
                                        Some("chat_message") => crate::sync_access::AccessKind::ChatMention,
                                        Some("invite_suggestion") => crate::sync_access::AccessKind::CollaboratorSuggestion,
                                        _ => crate::sync_access::AccessKind::ProviderAttention,
                                    };
                                    let category = if kind == crate::sync_access::AccessKind::Revocation {
                                        crate::sync_access::AccessCategory::Security
                                    } else {
                                        crate::sync_access::AccessCategory::Collaboration
                                    };
                                    let _ = crate::sync_access::record_at(
                                        data_root, category, kind, subject, crate::provider_common::now_ms(),
                                    );
                                }
                            }
                            runtime.push_event(RendezvousEvent {
                                event_type,
                                message_id: value.get("id").and_then(Value::as_str).map(str::to_string),
                                envelope_kind: value.get("kind").and_then(Value::as_str).map(str::to_string),
                                sender_device_id: value.get("senderDeviceId").and_then(Value::as_str).map(str::to_string),
                                ciphertext: value.get("ciphertext").and_then(Value::as_str).map(str::to_string),
                                expires_at_ms: value.get("expiresAtMs").and_then(Value::as_u64),
                                devices: value.get("devices").and_then(Value::as_array).cloned(),
                            });
                        }
                    }
                }
            }
        }
    }
}

async fn run_connection(
    runtime: Arc<RendezvousRuntime>,
    endpoint: String,
    data_root: std::path::PathBuf,
    mut outgoing_rx: mpsc::Receiver<Outgoing>,
    mut stop_rx: watch::Receiver<bool>,
) {
    let mut attempt = 0_u32;
    loop {
        if *stop_rx.borrow() {
            break;
        }
        runtime.set_status(if attempt == 0 {
            LiveConnectionStatus::Connecting
        } else {
            LiveConnectionStatus::RetryingAfterTransientFailure
        });
        match connect_once(
            runtime.clone(),
            &endpoint,
            &data_root,
            &mut outgoing_rx,
            &mut stop_rx,
        )
        .await
        {
            Ok(()) if *stop_rx.borrow() => break,
            Ok(()) | Err(_) => {
                attempt = attempt.saturating_add(1);
                let seconds = 1_u64 << attempt.min(5);
                tokio::select! {
                    _ = tokio::time::sleep(Duration::from_secs(seconds)) => {}
                    _ = stop_rx.changed() => { if *stop_rx.borrow() { break; } }
                }
            }
        }
    }
    runtime.set_status(LiveConnectionStatus::NoAttemptYet);
}

#[tauri::command]
pub async fn sync_rendezvous_connect(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, Arc<RendezvousRuntime>>,
) -> Result<RendezvousStatus, String> {
    let data_root = crate::profiles::resolve_tauri_data_root(&app)?;
    start_at(data_root, runtime.inner().clone()).await
}

pub async fn start_at(
    data_root: std::path::PathBuf,
    runtime: Arc<RendezvousRuntime>,
) -> Result<RendezvousStatus, String> {
    let settings =
        crate::sync_activation::load_settings_at(&data_root, crate::provider_common::now_ms())
            .map_err(|error| error.to_string())?;
    if !settings.enabled {
        return Err("activation_disabled".to_string());
    }
    let endpoint = endpoint_for_settings(&settings)?;
    runtime.stop();
    let (outgoing_tx, outgoing_rx) = mpsc::channel(OUTGOING_QUEUE_LIMIT);
    let (stop_tx, stop_rx) = watch::channel(false);
    *runtime
        .outgoing
        .lock()
        .map_err(|_| "rendezvous_state_unavailable".to_string())? = Some(outgoing_tx);
    *runtime
        .stop
        .lock()
        .map_err(|_| "rendezvous_state_unavailable".to_string())? = Some(stop_tx);
    runtime.set_status(LiveConnectionStatus::Connecting);
    tauri::async_runtime::spawn(run_connection(
        runtime.clone(),
        endpoint,
        data_root,
        outgoing_rx,
        stop_rx,
    ));
    Ok(status_snapshot(&runtime, true))
}

pub(crate) fn status_snapshot(
    runtime: &RendezvousRuntime,
    endpoint_configured: bool,
) -> RendezvousStatus {
    RendezvousStatus {
        state: runtime.status().into(),
        queued_events: runtime
            .events
            .lock()
            .map(|events| events.len())
            .unwrap_or(0),
        endpoint_configured,
    }
}

#[tauri::command]
pub fn sync_rendezvous_status(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, Arc<RendezvousRuntime>>,
) -> Result<RendezvousStatus, String> {
    let data_root = crate::profiles::resolve_tauri_data_root(&app)?;
    let settings =
        crate::sync_activation::load_settings_at(&data_root, crate::provider_common::now_ms())
            .map_err(|error| error.to_string())?;
    Ok(status_snapshot(
        &runtime,
        endpoint_for_settings(&settings).is_ok(),
    ))
}

#[tauri::command]
pub fn sync_rendezvous_disconnect(runtime: tauri::State<'_, Arc<RendezvousRuntime>>) {
    runtime.stop();
}

pub(crate) fn disconnect_at(runtime: &RendezvousRuntime) {
    runtime.stop();
}

#[tauri::command]
pub async fn sync_rendezvous_send(
    runtime: tauri::State<'_, Arc<RendezvousRuntime>>,
    frame: Value,
) -> Result<(), String> {
    send_at(&runtime, frame).await
}

pub(crate) async fn send_at(runtime: &RendezvousRuntime, frame: Value) -> Result<(), String> {
    let frame = sanitize_outgoing_frame(frame, crate::provider_common::now_ms())?;
    let text = frame.to_string();
    if text.len() > MAX_FRAME_BYTES {
        return Err("rendezvous_frame_too_large".to_string());
    }
    let sender = runtime
        .outgoing
        .lock()
        .map_err(|_| "rendezvous_state_unavailable".to_string())?
        .clone()
        .ok_or_else(|| "rendezvous_offline".to_string())?;
    sender
        .try_send(Outgoing::Json(frame))
        .map_err(|_| "rendezvous_backpressure".to_string())
}

fn is_opaque_id(value: &str) -> bool {
    (8..=96).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn is_account_route(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

fn exact_keys(object: &serde_json::Map<String, Value>, allowed: &[&str]) -> bool {
    object.keys().all(|key| allowed.contains(&key.as_str()))
}

fn required_string<'a>(
    object: &'a serde_json::Map<String, Value>,
    key: &str,
) -> Result<&'a str, String> {
    object
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| "rendezvous_invalid_frame".to_string())
}

fn sanitize_outgoing_frame(frame: Value, now_ms: u64) -> Result<Value, String> {
    let object = frame
        .as_object()
        .ok_or_else(|| "rendezvous_invalid_frame".to_string())?;
    match required_string(object, "type")? {
        "enqueue" => {
            let allowed = [
                "type",
                "id",
                "kind",
                "recipientAccountRoute",
                "recipientDeviceId",
                "expiresAtMs",
                "authorizationGeneration",
                "ciphertext",
            ];
            if !exact_keys(object, &allowed) {
                return Err("rendezvous_unknown_field".to_string());
            }
            let id = required_string(object, "id")?;
            let kind = required_string(object, "kind")?;
            let recipient_account_route = required_string(object, "recipientAccountRoute")?;
            let recipient_device_id = object.get("recipientDeviceId").map(|value| {
                value
                    .as_str()
                    .filter(|device_id| is_opaque_id(device_id))
                    .ok_or_else(|| "rendezvous_invalid_frame".to_string())
            });
            let recipient_device_id = recipient_device_id.transpose()?;
            let expires_at_ms = object
                .get("expiresAtMs")
                .and_then(Value::as_u64)
                .ok_or_else(|| "rendezvous_invalid_frame".to_string())?;
            let authorization_generation = object
                .get("authorizationGeneration")
                .and_then(Value::as_u64)
                .ok_or_else(|| "rendezvous_invalid_frame".to_string())?;
            let ciphertext = required_string(object, "ciphertext")?;
            let max_ttl = if kind == "candidate" {
                MAX_CANDIDATE_TTL_MS
            } else {
                MAX_ENVELOPE_TTL_MS
            };
            if !is_opaque_id(id)
                || !matches!(
                    kind,
                    "invitation" | "candidate" | "revocation" | "chat_message" | "invite_suggestion" | "chat_contact_ack"
                )
                || !is_account_route(recipient_account_route)
                || expires_at_ms <= now_ms
                || expires_at_ms - now_ms > max_ttl
                || ciphertext.is_empty()
                || !ciphertext
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
                || URL_SAFE_NO_PAD
                    .decode(ciphertext)
                    .map(|decoded| decoded.len() > MAX_CIPHERTEXT_BYTES)
                    .unwrap_or(true)
            {
                return Err("rendezvous_invalid_frame".to_string());
            }
            let mut sanitized = json!({
                "type": "enqueue",
                "id": id,
                "kind": kind,
                "recipientAccountRoute": recipient_account_route,
                "expiresAtMs": expires_at_ms,
                "authorizationGeneration": authorization_generation,
                "ciphertext": ciphertext,
            });
            if let Some(device_id) = recipient_device_id {
                sanitized["recipientDeviceId"] = json!(device_id);
            }
            Ok(sanitized)
        }
        "ack" => {
            if !exact_keys(object, &["type", "id"]) {
                return Err("rendezvous_unknown_field".to_string());
            }
            let id = required_string(object, "id")?;
            if !is_opaque_id(id) {
                return Err("rendezvous_invalid_frame".to_string());
            }
            Ok(json!({ "type": "ack", "id": id }))
        }
        "pull" | "discover" => {
            if !exact_keys(object, &["type"]) {
                return Err("rendezvous_unknown_field".to_string());
            }
            Ok(json!({ "type": required_string(object, "type")? }))
        }
        _ => Err("rendezvous_invalid_frame".to_string()),
    }
}

#[tauri::command]
pub fn sync_rendezvous_drain_events(
    runtime: tauri::State<'_, Arc<RendezvousRuntime>>,
) -> Vec<RendezvousEvent> {
    drain_events_at(&runtime)
}

pub(crate) fn drain_events_at(runtime: &RendezvousRuntime) -> Vec<RendezvousEvent> {
    runtime
        .events
        .lock()
        .map(|mut events| events.drain(..).collect())
        .unwrap_or_default()
}

pub struct HttpEndpointValidator {
    protocol_min: u32,
    protocol_max: u32,
}

impl crate::sync_activation::EndpointValidator for HttpEndpointValidator {
    fn validate(&self, _endpoint: &str) -> Result<(u32, u32), ActivationError> {
        Ok((self.protocol_min, self.protocol_max))
    }
}

#[tauri::command]
pub async fn sync_rendezvous_validate_endpoint(
    app: tauri::AppHandle,
    endpoint: String,
) -> Result<(), String> {
    let data_root = crate::profiles::resolve_tauri_data_root(&app)?;
    validate_endpoint_network_at(&data_root, endpoint).await
}

pub(crate) async fn validate_endpoint_network_at(
    data_root: &std::path::Path,
    endpoint: String,
) -> Result<(), String> {
    let endpoint = validated_endpoint(&endpoint)?;
    let response = reqwest::Client::new()
        .get(format!("{endpoint}/v1/info"))
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|_| "rendezvous_unavailable".to_string())?;
    if !response.status().is_success() {
        return Err("rendezvous_unavailable".to_string());
    }
    let value: Value = response
        .json()
        .await
        .map_err(|_| "rendezvous_protocol_error".to_string())?;
    let min = value
        .get("protocolMin")
        .and_then(Value::as_u64)
        .ok_or_else(|| "rendezvous_protocol_error".to_string())? as u32;
    let max = value
        .get("protocolMax")
        .and_then(Value::as_u64)
        .ok_or_else(|| "rendezvous_protocol_error".to_string())? as u32;
    if min > PROTOCOL_VERSION || max < PROTOCOL_VERSION {
        return Err("activation_protocol_incompatible".to_string());
    }
    crate::sync_activation::validate_endpoint_at(
        data_root,
        &endpoint,
        &HttpEndpointValidator {
            protocol_min: min,
            protocol_max: max,
        },
        crate::provider_common::now_ms(),
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoints_require_tls_except_explicit_debug_loopback() {
        assert!(validated_endpoint("https://rendezvous.example.test").is_ok());
        assert!(validated_endpoint("https://user:risk@example.test").is_err());
        assert!(validated_endpoint("https://example.test?token=secret").is_err());
        if cfg!(debug_assertions) {
            assert!(validated_endpoint("http://127.0.0.1:8787").is_ok());
        }
        assert!(validated_endpoint("http://public.example.test").is_err());
    }

    #[test]
    fn authentication_binding_matches_the_service_contract() {
        assert_eq!(
            auth_message(
                &"a".repeat(64),
                "device_opaque_123",
                1,
                "challenge_opaque_123"
            ),
            format!(
                "alethe-rendezvous-auth-v1\n{}\ndevice_opaque_123\n1\nchallenge_opaque_123\n1",
                "a".repeat(64)
            )
            .into_bytes()
        );
    }

    #[test]
    fn runtime_event_queue_is_bounded() {
        let runtime = RendezvousRuntime::default();
        for index in 0..(EVENT_QUEUE_LIMIT + 10) {
            runtime.push_event(RendezvousEvent {
                event_type: "delivery".to_string(),
                message_id: Some(format!("message_{index}")),
                envelope_kind: None,
                sender_device_id: None,
                ciphertext: None,
                expires_at_ms: None,
                devices: None,
            });
        }
        assert_eq!(runtime.events.lock().unwrap().len(), EVENT_QUEUE_LIMIT);
        assert_eq!(
            runtime
                .events
                .lock()
                .unwrap()
                .front()
                .unwrap()
                .message_id
                .as_deref(),
            Some("message_10")
        );
    }

    #[tokio::test]
    async fn outgoing_frames_are_allowlisted_before_the_provider_can_receive_them() {
        let runtime = RendezvousRuntime::default();
        let (sender, mut receiver) = mpsc::channel(OUTGOING_QUEUE_LIMIT);
        *runtime.outgoing.lock().unwrap() = Some(sender);

        let forbidden = json!({ "type": "discover", "oauthToken": "must-never-leave" });
        assert_eq!(
            send_at(&runtime, forbidden).await.unwrap_err(),
            "rendezvous_unknown_field"
        );
        assert!(receiver.try_recv().is_err());

        send_at(&runtime, json!({ "type": "discover" }))
            .await
            .unwrap();
        let Outgoing::Json(sent) = receiver.try_recv().unwrap();
        assert_eq!(sent, json!({ "type": "discover" }));
    }
}
