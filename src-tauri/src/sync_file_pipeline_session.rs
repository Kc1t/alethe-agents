//! Drives `sync_file_pipeline.rs`'s `FileSyncFrame` protocol as an event-driven state machine
//! instead of the blocking `Read + Write` loop `sync_file_pipeline.rs`'s own
//! `send_full_manifest`/`receive_full_manifest` use — because the *live* P2P session
//! (`sync_p2p_bridge::P2pSessionRegistry`) is not a blocking duplex stream a caller can hold
//! exclusively: it is a queue the frontend polls (`p2p_drain_frames`) on an interval, already
//! doing exactly that for chat. Reusing the same queue for file sync means multiplexing: every
//! frame sent through it now carries a one-byte channel tag (`P2P_CHANNEL_CHAT`/
//! `P2P_CHANNEL_FILE_SYNC`) so the frontend's single drain loop can route each frame to the right
//! consumer instead of two competing readers draining the same queue.
//!
//! This module owns the tag byte and the receive-side reassembly/staging state per peer; the
//! frontend only needs to know "tag 1 goes to chat, tag 2 comes here" — see `p2pChannel.ts`.
//!
//! **Known limitation, deliberately not solved here**: `chunk_bytes` on the sender side holds the
//! *entire* project's chunk bytes in memory for the duration of one offer. Fine for the manual,
//! one-shot "sync now" flow this module exists to make testable; a continuously-running background
//! sync (reading chunks from disk on demand as they're requested, instead of pre-loading
//! everything) is follow-up work once this path is proven to work at all end-to-end.

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde::Serialize;

use crate::sync_file_pipeline::{decode_frame, encode_frame, reassemble_from_subframes, split_chunk_into_subframes, FileSyncFrame, PipelineError};
use crate::sync_manifest::ProjectManifest;
use crate::sync_p2p_bridge::P2pSessionRegistry;
use crate::sync_staging;

/// Tag prefixing an existing chat `MessageRecord` transport frame — see `p2pChannel.ts`. Value
/// choice (not 0) leaves room for a future "unknown/legacy, no tag" heuristic if ever needed, and
/// matches the frontend constant exactly; the two must never drift independently.
pub const P2P_CHANNEL_CHAT: u8 = 1;
pub const P2P_CHANNEL_FILE_SYNC: u8 = 2;

fn tag_frame(tag: u8, payload: &[u8]) -> Vec<u8> {
    let mut tagged = Vec::with_capacity(payload.len() + 1);
    tagged.push(tag);
    tagged.extend_from_slice(payload);
    tagged
}

struct SenderState {
    chunk_bytes: HashMap<String, Vec<u8>>,
}

struct ReceiverState {
    subscription_id: String,
    data_root: PathBuf,
    remaining_chunk_ids: VecDeque<String>,
    current_chunk_id: Option<String>,
    current_subframes: Vec<FileSyncFrame>,
}

/// One instance shared across the whole app (Tauri-managed state) — at most one active offer and
/// one active receive per peer at a time, same one-active-transfer assumption
/// `sync_staging::begin_staging_at` already makes per subscription.
#[derive(Default)]
pub struct FileSyncSessionRegistry {
    senders: Mutex<HashMap<String, SenderState>>,
    receivers: Mutex<HashMap<String, ReceiverState>>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum FileSyncEvent {
    StagingStarted { subscription_id: String },
    ChunkReceived { chunk_id: String, remaining: usize },
    SyncCompleted { destination: String },
    PeerFinishedReceiving,
    /// Nothing user-visible happened this step (e.g. a sender just answered a `ChunkRequest`, or
    /// one of several subframes for a chunk still in flight arrived) — a normal, frequent result,
    /// not an error.
    None,
}

/// Where a receiving device stages an incoming project by default: under this device's own data
/// directory, one subfolder per project id, reusing `sync_mesh::init_project_sync_root` for the
/// same `.alethe/`-creation and name-sanitization behavior every other synced project already
/// gets — never inside the sender's own filesystem layout (the manifest's `destination` field is
/// the sender's hint for its own use, not authoritative for where the receiver puts things).
fn default_receive_destination(data_root: &Path, project_id: &str) -> Result<PathBuf, PipelineError> {
    let base_dir = data_root.join("synced-projects");
    crate::sync_mesh::init_project_sync_root(&base_dir, project_id).map_err(|_| PipelineError::Decode)
}

/// Begins offering `manifest` to `remote_account_route`: stores the chunk bytes for later
/// `ChunkRequest`s and returns the tagged `ManifestOffer` frame ready to send.
pub fn begin_offer(
    registry: &FileSyncSessionRegistry,
    remote_account_route: &str,
    manifest: &ProjectManifest,
    chunk_bytes: HashMap<String, Vec<u8>>,
) -> Result<Vec<u8>, PipelineError> {
    registry.senders.lock().unwrap().insert(remote_account_route.to_string(), SenderState { chunk_bytes });
    let frame = FileSyncFrame::ManifestOffer { manifest: manifest.clone(), destination: String::new() };
    Ok(tag_frame(P2P_CHANNEL_FILE_SYNC, &encode_frame(&frame)?))
}

/// Processes one inbound (already tag-stripped) file-sync frame from `remote_account_route`,
/// returning what happened plus zero or more tagged frames the caller must send back (via
/// `P2pSessionRegistry::send`) to keep the exchange moving.
pub fn ingest_inbound_frame(
    registry: &FileSyncSessionRegistry,
    data_root: &Path,
    remote_account_route: &str,
    frame_bytes: &[u8],
    now_ms: u64,
) -> Result<(FileSyncEvent, Vec<Vec<u8>>), PipelineError> {
    match decode_frame(frame_bytes)? {
        FileSyncFrame::ManifestOffer { manifest, .. } => {
            let subscription_id = format!("filesync-{}", manifest.project_id);
            let destination = default_receive_destination(data_root, &manifest.project_id)?;
            let journal = sync_staging::begin_staging_at(
                data_root,
                &subscription_id,
                manifest.clone(),
                destination.to_str().ok_or(PipelineError::Decode)?,
                now_ms,
            )
            .map_err(PipelineError::Staging)?;

            let mut seen: HashSet<String> = journal.received_chunk_ids.iter().cloned().collect();
            let mut remaining: VecDeque<String> = VecDeque::new();
            for entry in &manifest.entries {
                for chunk in &entry.chunks {
                    if seen.insert(chunk.chunk_id.clone()) {
                        remaining.push_back(chunk.chunk_id.clone());
                    }
                }
            }
            // Re-add already-received chunks were excluded above only from `remaining`, not
            // double counted — `seen` starts pre-populated with them precisely so they're skipped.

            let next_request = remaining.pop_front();
            registry.receivers.lock().unwrap().insert(
                remote_account_route.to_string(),
                ReceiverState {
                    subscription_id: subscription_id.clone(),
                    data_root: data_root.to_path_buf(),
                    remaining_chunk_ids: remaining,
                    current_chunk_id: next_request.clone(),
                    current_subframes: Vec::new(),
                },
            );

            match next_request {
                Some(chunk_id) => {
                    let outbound = tag_frame(
                        P2P_CHANNEL_FILE_SYNC,
                        &encode_frame(&FileSyncFrame::ChunkRequest { chunk_id })?,
                    );
                    Ok((FileSyncEvent::StagingStarted { subscription_id }, vec![outbound]))
                }
                None => {
                    // Every referenced chunk was already staged from a prior attempt — nothing to
                    // request, go straight to verify + publish.
                    sync_staging::verify_staged_at(data_root, &subscription_id, now_ms).map_err(PipelineError::Staging)?;
                    let published =
                        sync_staging::publish_atomically_at(data_root, &subscription_id, now_ms).map_err(PipelineError::Staging)?;
                    registry.receivers.lock().unwrap().remove(remote_account_route);
                    let outbound = tag_frame(P2P_CHANNEL_FILE_SYNC, &encode_frame(&FileSyncFrame::SyncComplete)?);
                    Ok((FileSyncEvent::SyncCompleted { destination: published.destination }, vec![outbound]))
                }
            }
        }
        FileSyncFrame::ChunkRequest { chunk_id } => {
            let senders = registry.senders.lock().unwrap();
            let sender = senders.get(remote_account_route).ok_or(PipelineError::UnknownChunk)?;
            let bytes = sender.chunk_bytes.get(&chunk_id).ok_or(PipelineError::UnknownChunk)?;
            let outbound = split_chunk_into_subframes(&chunk_id, bytes)
                .iter()
                .map(|subframe| encode_frame(subframe).map(|bytes| tag_frame(P2P_CHANNEL_FILE_SYNC, &bytes)))
                .collect::<Result<Vec<_>, _>>()?;
            Ok((FileSyncEvent::None, outbound))
        }
        FileSyncFrame::ChunkData { chunk_id, offset, total_len, bytes_b64 } => {
            let piece_len = BASE64.decode(&bytes_b64).map_err(|_| PipelineError::Decode)?.len();
            let is_last = (offset as usize + piece_len) as u32 >= total_len;
            let subframe = FileSyncFrame::ChunkData { chunk_id: chunk_id.clone(), offset, total_len, bytes_b64 };

            let ready = {
                let mut receivers = registry.receivers.lock().unwrap();
                let state = receivers.get_mut(remote_account_route).ok_or(PipelineError::UnexpectedFrame)?;
                if state.current_chunk_id.as_deref() != Some(chunk_id.as_str()) {
                    return Err(PipelineError::UnexpectedFrame);
                }
                state.current_subframes.push(subframe);
                is_last.then(|| {
                    (state.subscription_id.clone(), state.data_root.clone(), std::mem::take(&mut state.current_subframes))
                })
            };
            let Some((subscription_id, data_root, subframes)) = ready else {
                return Ok((FileSyncEvent::None, Vec::new()));
            };

            let bytes = reassemble_from_subframes(&chunk_id, &subframes)?;
            sync_staging::receive_chunk_at(&data_root, &subscription_id, &chunk_id, &bytes, now_ms).map_err(PipelineError::Staging)?;

            let (next_request, remaining_count) = {
                let mut receivers = registry.receivers.lock().unwrap();
                let state = receivers.get_mut(remote_account_route).ok_or(PipelineError::UnexpectedFrame)?;
                let next = state.remaining_chunk_ids.pop_front();
                state.current_chunk_id = next.clone();
                (next, state.remaining_chunk_ids.len())
            };

            if let Some(next_id) = next_request {
                let outbound = tag_frame(P2P_CHANNEL_FILE_SYNC, &encode_frame(&FileSyncFrame::ChunkRequest { chunk_id: next_id })?);
                Ok((FileSyncEvent::ChunkReceived { chunk_id, remaining: remaining_count }, vec![outbound]))
            } else {
                sync_staging::verify_staged_at(&data_root, &subscription_id, now_ms).map_err(PipelineError::Staging)?;
                let published =
                    sync_staging::publish_atomically_at(&data_root, &subscription_id, now_ms).map_err(PipelineError::Staging)?;
                registry.receivers.lock().unwrap().remove(remote_account_route);
                let outbound = tag_frame(P2P_CHANNEL_FILE_SYNC, &encode_frame(&FileSyncFrame::SyncComplete)?);
                Ok((FileSyncEvent::SyncCompleted { destination: published.destination }, vec![outbound]))
            }
        }
        FileSyncFrame::SyncComplete => {
            registry.senders.lock().unwrap().remove(remote_account_route);
            Ok((FileSyncEvent::PeerFinishedReceiving, Vec::new()))
        }
    }
}

// -------------------------------------------------------------------------------------------
// Tauri commands
// -------------------------------------------------------------------------------------------

/// Sends one tagged pipeline frame, preferring the direct P2P path and falling back to the relay.
///
/// The `?` these two call sites used to have on `P2pSessionRegistry::send` is what made sharing a
/// project impossible behind a symmetric NAT: no direct session meant `p2p_session_not_found`, and
/// the transfer ended there. Chat has always fallen back to the relay in that situation; this gives
/// project transfer the same second path.
///
/// The relay is slower and it is not a secret which one was used — the returned [`SentVia`] says
/// so, and both outcomes are recorded, because "it went out" and "it went out the slow way" are
/// different facts about the same send.
async fn send_preferring_p2p(
    rendezvous: &crate::sync_rendezvous::RendezvousRuntime,
    p2p_registry: &P2pSessionRegistry,
    remote_account_route: &str,
    recipient_agreement_public_key: &[u8],
    frame: Vec<u8>,
) -> Result<crate::sync_file_pipeline_relay::SentVia, String> {
    use crate::sync_file_pipeline_relay::SentVia;

    let direct = p2p_registry.send(remote_account_route, frame.clone());
    if direct.is_ok() {
        crate::decide!(
            target: "sync.file_pipeline",
            attempted = "send_frame",
            outcome = Ok,
            because = "direct_session_available",
            rule = "file_pipeline.send.prefer_p2p",
            evidence = { bytes = frame.len() },
        );
        return Ok(SentVia::Direct);
    }
    let reason = direct.unwrap_err();

    if recipient_agreement_public_key.is_empty() {
        // Nothing to seal to. Reported rather than swallowed: without it the transfer cannot use
        // the relay, and the caller needs to know that is why, not just that it failed.
        crate::decide!(
            target: "sync.file_pipeline",
            attempted = "send_frame",
            outcome = Failed,
            because = "no_recipient_key_for_relay",
            rule = "file_pipeline.send.relay_fallback",
            evidence = { p2p_error = %reason },
        );
        return Err(format!("file_pipeline_relay_unavailable: {reason}"));
    }

    let transfer_id = nanoid::nanoid!(12);
    let expires_at_ms = crate::provider_common::now_ms() + RELAY_ENVELOPE_TTL_MS;
    let frames = crate::sync_file_pipeline_relay::relay_frames_for(
        &frame,
        &transfer_id,
        remote_account_route,
        recipient_agreement_public_key,
        expires_at_ms,
    )?;
    let count = frames.len();
    for envelope in frames {
        crate::sync_rendezvous::send_at(rendezvous, envelope).await?;
    }
    crate::decide!(
        target: "sync.file_pipeline",
        attempted = "send_frame",
        outcome = Deferred,
        because = "relayed_no_direct_session",
        rule = "file_pipeline.send.relay_fallback",
        evidence = { bytes = frame.len(), fragments = count, p2p_error = %reason },
    );
    Ok(SentVia::Relay)
}

/// How long a queued fragment stays useful. Long enough for a peer that is briefly offline, short
/// enough that an abandoned transfer does not sit on the relay for a week.
const RELAY_ENVELOPE_TTL_MS: u64 = 60 * 60 * 1_000;

#[tauri::command]
pub async fn sync_file_pipeline_offer_project(
    app: tauri::AppHandle,
    p2p_registry: tauri::State<'_, Arc<P2pSessionRegistry>>,
    file_sync_registry: tauri::State<'_, Arc<FileSyncSessionRegistry>>,
    rendezvous: tauri::State<'_, Arc<crate::sync_rendezvous::RendezvousRuntime>>,
    remote_account_route: String,
    project_root: String,
    // The peer's X25519 public key, base64url. Required to seal fragments for the relay path; the
    // caller already holds it — it is what chat seals its own relay messages with.
    recipient_agreement_public_key: String,
) -> Result<String, String> {
    let (device_id, signing_key) = {
        let data_root = crate::profiles::resolve_tauri_data_root(&app)?;
        let document = crate::sync_security::load_at(&data_root)?;
        let device_id = document.local_device_id.clone().ok_or_else(|| "security_device_missing".to_string())?;
        let signing_key = crate::sync_security::load_device_signing_key(&device_id)?;
        (device_id, signing_key)
    };
    let project_root_path = std::path::PathBuf::from(&project_root);
    let project_id = project_root_path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .ok_or_else(|| "file_pipeline_invalid_project_root".to_string())?;

    let (manifest, chunk_bytes) = tokio::task::spawn_blocking(move || {
        let mut chunk_bytes = HashMap::new();
        let manifest = crate::sync_manifest::build_manifest_from_dir(
            &project_root_path,
            &project_id,
            &nanoid::nanoid!(12),
            &device_id,
            &signing_key,
            crate::provider_common::now_ms(),
            |id, bytes| {
                chunk_bytes.insert(id.to_string(), bytes.to_vec());
                Ok(())
            },
        )
        .map_err(|error| error.to_string())?;
        Ok::<_, String>((manifest, chunk_bytes))
    })
    .await
    .map_err(|_| "file_pipeline_manifest_task_failed".to_string())??;

    let outbound = begin_offer(&file_sync_registry, &remote_account_route, &manifest, chunk_bytes)
        .map_err(|error| error.to_string())?;
    let recipient_key = decode_recipient_key(&recipient_agreement_public_key);
    send_preferring_p2p(&rendezvous, &p2p_registry, &remote_account_route, &recipient_key, outbound)
        .await?;
    Ok(manifest.project_id)
}

/// Decodes a base64url X25519 public key, or an empty vector when there is none to use — the
/// caller reports that as `no_recipient_key_for_relay` rather than guessing a key.
fn decode_recipient_key(encoded: &str) -> Vec<u8> {
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    if encoded.trim().is_empty() {
        return Vec::new();
    }
    URL_SAFE_NO_PAD.decode(encoded.trim()).unwrap_or_default()
}

#[tauri::command]
pub async fn sync_file_pipeline_ingest_frame(
    app: tauri::AppHandle,
    p2p_registry: tauri::State<'_, Arc<P2pSessionRegistry>>,
    file_sync_registry: tauri::State<'_, Arc<FileSyncSessionRegistry>>,
    rendezvous: tauri::State<'_, Arc<crate::sync_rendezvous::RendezvousRuntime>>,
    remote_account_route: String,
    frame: Vec<u8>,
    recipient_agreement_public_key: Option<String>,
) -> Result<FileSyncEvent, String> {
    let data_root = crate::profiles::resolve_tauri_data_root(&app)?;
    let now_ms = crate::provider_common::now_ms();
    let (event, outbound_frames) =
        ingest_inbound_frame(&file_sync_registry, &data_root, &remote_account_route, &frame, now_ms)
            .map_err(|error| error.to_string())?;
    let recipient_key = decode_recipient_key(recipient_agreement_public_key.as_deref().unwrap_or(""));
    for outbound in outbound_frames {
        // The replies matter as much as the offer: a transfer where the offer relayed and the
        // acknowledgements did not is a transfer that stalls silently after one frame.
        send_preferring_p2p(&rendezvous, &p2p_registry, &remote_account_route, &recipient_key, outbound)
            .await?;
    }
    Ok(event)
}

/// Consumes one `filesync` envelope delivered by the relay.
///
/// The mirror of the fallback in `send_preferring_p2p`: a peer with no direct session to this
/// device relayed a fragment, and this reassembles it. Returns `None` while a transfer is still
/// missing pieces — a normal state, not a failure, and the reason this is not a bare event: a
/// partial transfer and a broken one must not look the same to the caller.
#[tauri::command]
pub async fn sync_file_pipeline_ingest_relay_envelope(
    app: tauri::AppHandle,
    p2p_registry: tauri::State<'_, Arc<P2pSessionRegistry>>,
    file_sync_registry: tauri::State<'_, Arc<FileSyncSessionRegistry>>,
    rendezvous: tauri::State<'_, Arc<crate::sync_rendezvous::RendezvousRuntime>>,
    inbox: tauri::State<'_, Arc<crate::sync_file_pipeline_relay::RelayInbox>>,
    sender_account_route: String,
    ciphertext: String,
    recipient_agreement_public_key: Option<String>,
) -> Result<Option<FileSyncEvent>, String> {
    let data_root = crate::profiles::resolve_tauri_data_root(&app)?;
    let document = crate::sync_security::load_at(&data_root)?;
    let local_device_id = document
        .local_device_id
        .ok_or_else(|| "security_device_missing".to_string())?;
    let secret = crate::sync_security::load_device_agreement_secret(&local_device_id)?;

    let fragment = crate::sync_file_pipeline_relay::open_fragment(&ciphertext, &secret)?;
    let Some(frame) = inbox
        .accept(&sender_account_route, &fragment)
        .map_err(|error| error.to_string())?
    else {
        crate::decide!(
            target: "sync.file_pipeline",
            attempted = "ingest_relay_fragment",
            outcome = Deferred,
            because = "transfer_incomplete",
            rule = "file_pipeline.receive.reassemble",
            evidence = { index = fragment.index, total = fragment.total },
        );
        return Ok(None);
    };

    let now_ms = crate::provider_common::now_ms();
    let (event, outbound_frames) =
        ingest_inbound_frame(&file_sync_registry, &data_root, &sender_account_route, &frame, now_ms)
            .map_err(|error| error.to_string())?;
    let recipient_key = decode_recipient_key(recipient_agreement_public_key.as_deref().unwrap_or(""));
    for outbound in outbound_frames {
        send_preferring_p2p(&rendezvous, &p2p_registry, &sender_account_route, &recipient_key, outbound)
            .await?;
    }
    Ok(Some(event))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync_manifest::build_manifest_from_dir;
    use ed25519_dalek::SigningKey;
    use rand_core::OsRng;
    use std::fs;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("alethe-file-pipeline-session-{name}-{}", nanoid::nanoid!(8)));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// End-to-end proof of the event-driven protocol, without any real network: frames produced
    /// by one side's `FileSyncSessionRegistry` are fed directly into the other side's
    /// `ingest_inbound_frame`, exactly mirroring what the frontend's drain-loop-to-Tauri-command
    /// relay does for a live session — the only thing this doesn't exercise is the actual UDP
    /// transport and tag-stripping, both already covered separately (`sync_p2p_bridge.rs`'s own
    /// tests, and the tag round-trip below).
    #[test]
    fn full_project_sync_round_trip_through_the_event_driven_protocol() {
        let source = temp_dir("source");
        fs::create_dir_all(source.join("src")).unwrap();
        fs::write(source.join("src").join("main.rs"), b"fn main() {}\n".repeat(40)).unwrap();
        let large_content: Vec<u8> = (0..300_000_u32).map(|value| (value % 197) as u8).collect();
        fs::write(source.join("data.bin"), &large_content).unwrap();

        let signing_key = SigningKey::generate(&mut OsRng);
        let mut chunk_bytes = HashMap::new();
        let manifest = build_manifest_from_dir(&source, "demo-project", "rev-1", "dev-sender", &signing_key, 1_000, |id, bytes| {
            chunk_bytes.insert(id.to_string(), bytes.to_vec());
            Ok(())
        })
        .unwrap();

        let sender_registry = FileSyncSessionRegistry::default();
        let receiver_registry = FileSyncSessionRegistry::default();
        let receiver_data_root = temp_dir("receiver-data");

        // Sender begins the offer, addressed to "peer-b" from its own point of view.
        let mut in_flight_to_receiver = vec![begin_offer(&sender_registry, "peer-b", &manifest, chunk_bytes).unwrap()];
        let mut in_flight_to_sender: Vec<Vec<u8>> = Vec::new();
        let mut destination: Option<String> = None;

        // Alternate delivering queued frames to whichever side has something pending, exactly
        // like two devices relaying through the P2P queue, until neither side has anything left
        // to say — bounded iteration count as a safety net against an infinite protocol bug
        // turning this test into a hang.
        for _ in 0..64 {
            if in_flight_to_receiver.is_empty() && in_flight_to_sender.is_empty() {
                break;
            }
            for tagged in std::mem::take(&mut in_flight_to_receiver) {
                let (_tag, payload) = tagged.split_first().unwrap();
                let (event, outbound) =
                    ingest_inbound_frame(&receiver_registry, &receiver_data_root, "peer-a", payload, 2_000).unwrap();
                if let FileSyncEvent::SyncCompleted { destination: d } = event {
                    destination = Some(d);
                }
                in_flight_to_sender.extend(outbound);
            }
            for tagged in std::mem::take(&mut in_flight_to_sender) {
                let (_tag, payload) = tagged.split_first().unwrap();
                let (_event, outbound) =
                    ingest_inbound_frame(&sender_registry, &temp_dir("sender-data-unused"), "peer-b", payload, 2_100).unwrap();
                in_flight_to_receiver.extend(outbound);
            }
        }

        let destination = PathBuf::from(destination.expect("sync should have completed"));
        assert_eq!(fs::read(destination.join("data.bin")).unwrap(), large_content);
        assert_eq!(
            fs::read(destination.join("src").join("main.rs")).unwrap(),
            fs::read(source.join("src").join("main.rs")).unwrap()
        );

        fs::remove_dir_all(&source).unwrap();
        fs::remove_dir_all(&receiver_data_root).unwrap();
        crate::best_effort!(fs::remove_dir_all(&destination), "test_dir_already_absent");
    }

    #[test]
    fn tag_byte_is_stable_and_distinguishes_the_two_channels() {
        assert_ne!(P2P_CHANNEL_CHAT, P2P_CHANNEL_FILE_SYNC);
        let tagged = tag_frame(P2P_CHANNEL_FILE_SYNC, b"payload");
        assert_eq!(tagged[0], P2P_CHANNEL_FILE_SYNC);
        assert_eq!(&tagged[1..], b"payload");
    }

    #[test]
    fn a_chunk_request_for_content_the_sender_never_offered_is_rejected() {
        let registry = FileSyncSessionRegistry::default();
        registry.senders.lock().unwrap().insert("peer".to_string(), SenderState { chunk_bytes: HashMap::new() });
        let frame = encode_frame(&FileSyncFrame::ChunkRequest { chunk_id: "not-real".to_string() }).unwrap();
        let result = ingest_inbound_frame(&registry, &temp_dir("unused"), "peer", &frame, 1_000);
        assert_eq!(result.unwrap_err(), PipelineError::UnknownChunk);
    }
}
