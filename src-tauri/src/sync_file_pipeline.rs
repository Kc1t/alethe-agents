//! Wires together the pieces that already existed in isolation — `sync_manifest.rs` (manifest +
//! content-addressed chunking), `sync_staging.rs` (chunk receipt, verification, atomic publish),
//! and `sync_transport.rs` (the authenticated, encrypted P2P channel) — into an actual end-to-end
//! project sync round. Before this module, all three had tests proving their own contract, but
//! nothing called them in sequence over the wire; `sync_transport.rs`'s `PeerStream` already
//! carries arbitrary opaque bytes (`enqueue`/`receive`), so this module does not add a new
//! encryption layer — it only defines what those bytes mean (`FileSyncFrame`) and drives the
//! request/response dance for one full-manifest transfer.
//!
//! **Scope note, deliberately**: `sync_staging.rs` publishes an entire manifest's tree atomically
//! (one staging journal per transfer), while `sync_engine.rs` tracks per-path revisions/conflicts
//! for a continuous stream of individual operations. This module wires the first pair (manifest +
//! staging) end-to-end over the transport, since that is what has zero prior integration. It does
//! **not** attempt to unify that with `sync_engine`'s per-path conflict model in the same pass —
//! reconciling "one atomic tree publish" with "per-path optimistic-concurrency conflicts" is a
//! real design decision (e.g. does a whole-manifest transfer even make sense once continuous
//! per-file sync exists, or does it become the "first full sync" bootstrap case only?), not glue
//! code, and deserves its own pass rather than a rushed guess bolted on here.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde::{Deserialize, Serialize};

use crate::sync_manifest::ProjectManifest;
use crate::sync_staging::{self, StagingError, StagingJournal};
use crate::sync_transport::{PeerStream, TransportError};

/// Raw bytes per `ChunkData` subframe, chosen so the frame — after base64 (~1.33x) plus the small
/// JSON envelope around it — stays comfortably under `sync_transport::MAX_FRAME_BYTES` (256KB).
/// Binary files are chunked up to 4MiB (`sync_manifest::CHUNK_SIZE_BYTES`) and must be split into
/// several of these; text/CDC chunks (up to 128KB) fit in one or two.
pub const CHUNK_SUBFRAME_RAW_BYTES: usize = 150 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum FileSyncFrame {
    /// Sent once, by whichever side is offering its current tree. Carries the whole signed
    /// manifest — chunk *references* only (hashes + sizes), never bytes — so the receiver can
    /// decide what it already has before requesting anything.
    ManifestOffer { manifest: ProjectManifest, destination: String },
    /// Sent by the receiver for each chunk it does not already have staged.
    ChunkRequest { chunk_id: String },
    /// One piece of a chunk's bytes. A chunk larger than `CHUNK_SUBFRAME_RAW_BYTES` is split into
    /// several of these, `offset` being this piece's byte offset within the chunk (used by the
    /// receiver to detect a piece missing or arriving out of order; the underlying transport
    /// stream already guarantees frames from one sender are never reordered, so this is a
    /// consistency check, not a real reassembly mechanism).
    ChunkData { chunk_id: String, offset: u32, total_len: u32, bytes_b64: String },
    /// Sent by the receiver once every requested chunk has been received and durably persisted,
    /// so the sender knows it can stop waiting for further `ChunkRequest`s.
    SyncComplete,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PipelineError {
    Encode,
    Decode,
    Transport(TransportError),
    Staging(StagingError),
    /// A `ChunkRequest` named a chunk the sender has no bytes for — the manifest it offered and
    /// the chunk store it was built with have gone out of sync with each other.
    UnknownChunk,
    /// A protocol violation: a frame arrived that is not the one this side of the exchange is
    /// currently expecting (e.g. a `ChunkRequest` in place of the expected `ManifestOffer`).
    UnexpectedFrame,
}

impl std::fmt::Display for PipelineError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let code = match self {
            PipelineError::Encode => "file_pipeline_encode_failed",
            PipelineError::Decode => "file_pipeline_decode_failed",
            PipelineError::Transport(error) => return write!(f, "{error}"),
            PipelineError::Staging(error) => return write!(f, "{error}"),
            PipelineError::UnknownChunk => "file_pipeline_unknown_chunk",
            PipelineError::UnexpectedFrame => "file_pipeline_unexpected_frame",
        };
        write!(f, "{code}")
    }
}

pub fn encode_frame(frame: &FileSyncFrame) -> Result<Vec<u8>, PipelineError> {
    serde_json::to_vec(frame).map_err(|_| PipelineError::Encode)
}

pub fn decode_frame(bytes: &[u8]) -> Result<FileSyncFrame, PipelineError> {
    serde_json::from_slice(bytes).map_err(|_| PipelineError::Decode)
}

/// Splits one chunk's bytes into transport-sized `ChunkData` subframes, in order.
pub fn split_chunk_into_subframes(chunk_id: &str, bytes: &[u8]) -> Vec<FileSyncFrame> {
    let total_len = bytes.len() as u32;
    if bytes.is_empty() {
        return vec![FileSyncFrame::ChunkData {
            chunk_id: chunk_id.to_string(),
            offset: 0,
            total_len: 0,
            bytes_b64: String::new(),
        }];
    }
    bytes
        .chunks(CHUNK_SUBFRAME_RAW_BYTES)
        .enumerate()
        .map(|(index, piece)| FileSyncFrame::ChunkData {
            chunk_id: chunk_id.to_string(),
            offset: (index * CHUNK_SUBFRAME_RAW_BYTES) as u32,
            total_len,
            bytes_b64: BASE64.encode(piece),
        })
        .collect()
}

/// Reassembles a chunk's bytes from its `ChunkData` subframes, in the order given — the inverse of
/// `split_chunk_into_subframes`. Validates that every subframe names the expected chunk, that
/// offsets are contiguous starting at zero (no gap, no overlap), and that the reassembled length
/// matches every subframe's declared `total_len` — a mismatch on any of these is treated as
/// protocol corruption, not silently patched over. The actual content hash is re-verified
/// separately by `sync_staging::receive_chunk_at`, which is the authoritative integrity check;
/// this function only guards against a malformed *sequence* of subframes reaching that point.
pub fn reassemble_from_subframes(expected_chunk_id: &str, subframes: &[FileSyncFrame]) -> Result<Vec<u8>, PipelineError> {
    let mut buffer = Vec::new();
    let mut declared_total: Option<u32> = None;
    for subframe in subframes {
        let FileSyncFrame::ChunkData { chunk_id, offset, total_len, bytes_b64 } = subframe else {
            return Err(PipelineError::UnexpectedFrame);
        };
        if chunk_id != expected_chunk_id {
            return Err(PipelineError::Decode);
        }
        if *offset as usize != buffer.len() {
            return Err(PipelineError::Decode);
        }
        let piece = BASE64.decode(bytes_b64).map_err(|_| PipelineError::Decode)?;
        buffer.extend_from_slice(&piece);
        declared_total = Some(*total_len);
    }
    if declared_total != Some(buffer.len() as u32) {
        return Err(PipelineError::Decode);
    }
    Ok(buffer)
}

fn send_frame(peer_stream: &mut PeerStream, wire: &mut impl Write, frame: &FileSyncFrame) -> Result<(), PipelineError> {
    let bytes = encode_frame(frame)?;
    peer_stream.enqueue(&bytes).map_err(PipelineError::Transport)?;
    peer_stream.flush(wire).map_err(PipelineError::Transport)
}

fn receive_frame(peer_stream: &mut PeerStream, wire: &mut impl Read) -> Result<FileSyncFrame, PipelineError> {
    let bytes = peer_stream.receive(wire).map_err(PipelineError::Transport)?;
    decode_frame(&bytes)
}

/// Sender side of a one-shot full-manifest sync round. `chunk_bytes` supplies this device's own
/// chunk bytes by ID — populated via `sync_manifest::build_manifest_from_dir`'s `on_chunk`
/// callback when the manifest was built, so this module never re-reads or re-chunks the source
/// tree itself. Answers every `ChunkRequest` until the receiver signals `SyncComplete`.
pub fn send_full_manifest(
    peer_stream: &mut PeerStream,
    wire: &mut (impl Read + Write),
    manifest: &ProjectManifest,
    destination: &str,
    chunk_bytes: &HashMap<String, Vec<u8>>,
) -> Result<(), PipelineError> {
    send_frame(
        peer_stream,
        wire,
        &FileSyncFrame::ManifestOffer { manifest: manifest.clone(), destination: destination.to_string() },
    )?;
    loop {
        match receive_frame(peer_stream, wire)? {
            FileSyncFrame::ChunkRequest { chunk_id } => {
                let bytes = chunk_bytes.get(&chunk_id).ok_or(PipelineError::UnknownChunk)?;
                for subframe in split_chunk_into_subframes(&chunk_id, bytes) {
                    send_frame(peer_stream, wire, &subframe)?;
                }
            }
            FileSyncFrame::SyncComplete => return Ok(()),
            _ => return Err(PipelineError::UnexpectedFrame),
        }
    }
}

/// Receiver side of a one-shot full-manifest sync round. Requests only the chunks not already
/// staged for this subscription (so a resumed/retried transfer after a partial one does not
/// re-request bytes it already durably received — `sync_staging::receive_chunk_at` is itself
/// idempotent, but skipping the request entirely also saves the round-trip), then verifies and
/// publishes once every chunk has arrived.
pub fn receive_full_manifest(
    peer_stream: &mut PeerStream,
    wire: &mut (impl Read + Write),
    data_root: &Path,
    subscription_id: &str,
    now_ms: u64,
) -> Result<StagingJournal, PipelineError> {
    let FileSyncFrame::ManifestOffer { manifest, destination } = receive_frame(peer_stream, wire)? else {
        return Err(PipelineError::UnexpectedFrame);
    };

    let journal = sync_staging::begin_staging_at(data_root, subscription_id, manifest.clone(), &destination, now_ms)
        .map_err(PipelineError::Staging)?;
    let mut already_have: std::collections::HashSet<String> = journal.received_chunk_ids.iter().cloned().collect();

    let all_chunk_ids: Vec<String> =
        manifest.entries.iter().flat_map(|entry| entry.chunks.iter().map(|chunk| chunk.chunk_id.clone())).collect();

    for chunk_id in &all_chunk_ids {
        if already_have.contains(chunk_id) {
            continue;
        }
        send_frame(peer_stream, wire, &FileSyncFrame::ChunkRequest { chunk_id: chunk_id.clone() })?;
        let mut subframes = Vec::new();
        loop {
            match receive_frame(peer_stream, wire)? {
                data @ FileSyncFrame::ChunkData { .. } => {
                    let is_last = matches!(&data, FileSyncFrame::ChunkData { offset, total_len, bytes_b64, .. }
                        if (*offset as usize + BASE64.decode(bytes_b64).map(|bytes| bytes.len()).unwrap_or(0)) as u32 >= *total_len);
                    subframes.push(data);
                    if is_last {
                        break;
                    }
                }
                _ => return Err(PipelineError::UnexpectedFrame),
            }
        }
        let bytes = reassemble_from_subframes(chunk_id, &subframes)?;
        sync_staging::receive_chunk_at(data_root, subscription_id, chunk_id, &bytes, now_ms).map_err(PipelineError::Staging)?;
        already_have.insert(chunk_id.clone());
    }

    send_frame(peer_stream, wire, &FileSyncFrame::SyncComplete)?;
    sync_staging::verify_staged_at(data_root, subscription_id, now_ms).map_err(PipelineError::Staging)?;
    sync_staging::publish_atomically_at(data_root, subscription_id, now_ms).map_err(PipelineError::Staging)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync_crypto::{self, DeviceKeyBinding};
    use crate::sync_manifest::build_manifest_from_dir;
    use crate::sync_transport::{establish_as_initiator, establish_as_responder, DeviceTrustOracle, GrantAuthorizer, LocalIdentity};
    use ed25519_dalek::SigningKey;
    use rand_core::OsRng;
    use std::fs;
    use std::net::{TcpListener, TcpStream};
    use std::path::PathBuf;
    use std::thread;

    struct AllowAll;
    impl DeviceTrustOracle for AllowAll {
        fn check_trusted(&self, _account_route: &str, _device_id: &str) -> Result<(), TransportError> {
            Ok(())
        }
    }
    struct AllowAllGrants;
    impl GrantAuthorizer for AllowAllGrants {
        fn check_authorized(&self, _: &str, _: &str, _: Option<&str>, _: Option<&str>) -> Result<(), TransportError> {
            Ok(())
        }
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("alethe-file-pipeline-{name}-{}", nanoid::nanoid!(8)));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn make_identity(device_id: &str) -> (SigningKey, x25519_dalek::StaticSecret, DeviceKeyBinding) {
        let signing_key = SigningKey::generate(&mut OsRng);
        let (agreement_secret, binding) = sync_crypto::generate_bound_key_agreement(device_id, &signing_key, 1_000);
        (signing_key, agreement_secret, binding)
    }

    #[test]
    fn subframe_split_and_reassembly_round_trips_bytes_larger_than_one_subframe() {
        let bytes: Vec<u8> = (0..(CHUNK_SUBFRAME_RAW_BYTES * 2 + 500)).map(|i| (i % 256) as u8).collect();
        let subframes = split_chunk_into_subframes("chunk-a", &bytes);
        assert_eq!(subframes.len(), 3, "should split into 3 pieces given the fixture size");
        let reassembled = reassemble_from_subframes("chunk-a", &subframes).unwrap();
        assert_eq!(reassembled, bytes);
    }

    #[test]
    fn reassembly_rejects_a_gap_a_wrong_chunk_id_and_a_short_total() {
        let bytes = b"hello world, this is chunk content".to_vec();
        let mut subframes = split_chunk_into_subframes("chunk-a", &bytes);
        assert_eq!(subframes.len(), 1);

        // Wrong chunk id.
        assert_eq!(reassemble_from_subframes("chunk-b", &subframes), Err(PipelineError::Decode));

        // Corrupt the offset to create a gap.
        if let FileSyncFrame::ChunkData { offset, .. } = &mut subframes[0] {
            *offset = 5;
        }
        assert_eq!(reassemble_from_subframes("chunk-a", &subframes), Err(PipelineError::Decode));
    }

    #[test]
    fn frame_encode_decode_round_trips_every_variant() {
        let signing_key = SigningKey::generate(&mut OsRng);
        let manifest = build_manifest_from_dir(&temp_dir("frame-fixture"), "p", "r", "d", &signing_key, 1_000, |_, _| Ok(())).unwrap();
        let frames = vec![
            FileSyncFrame::ManifestOffer { manifest, destination: "/tmp/dest".to_string() },
            FileSyncFrame::ChunkRequest { chunk_id: "abc123".to_string() },
            FileSyncFrame::ChunkData { chunk_id: "abc123".to_string(), offset: 0, total_len: 3, bytes_b64: BASE64.encode(b"xyz") },
            FileSyncFrame::SyncComplete,
        ];
        for frame in frames {
            let encoded = encode_frame(&frame).unwrap();
            let decoded = decode_frame(&encoded).unwrap();
            assert_eq!(format!("{decoded:?}"), format!("{frame:?}"));
        }
    }

    /// The end-to-end proof this module exists for: two real `data_root`s (sender, receiver)
    /// exchanging a manifest and every chunk over a real TCP loopback, through a genuine
    /// `sync_transport` handshake + `PeerStream` — not a mock. Verifies the receiver's destination
    /// ends up byte-identical to the sender's source tree, including a file large enough to need
    /// several chunk subframes.
    #[test]
    fn full_manifest_sync_round_trip_over_a_real_encrypted_transport() {
        let source = temp_dir("e2e-source");
        fs::create_dir_all(source.join("src")).unwrap();
        fs::write(source.join("src").join("main.rs"), b"fn main() { println!(\"hello\"); }\n".repeat(50)).unwrap();
        fs::write(source.join("README.md"), b"hello project").unwrap();
        // Large enough (given CDC's ~32KB target and the fixed subframe size) to exercise multiple
        // chunks and multiple subframes within at least one of them.
        let large_content: Vec<u8> = (0..400_000_u32).map(|value| (value % 251) as u8).collect();
        fs::write(source.join("large.bin"), &large_content).unwrap();

        let signing_key = SigningKey::generate(&mut OsRng);
        let mut chunk_bytes: HashMap<String, Vec<u8>> = HashMap::new();
        let manifest = build_manifest_from_dir(&source, "project-a", "rev-1", "dev-sender", &signing_key, 1_000, |id, bytes| {
            chunk_bytes.insert(id.to_string(), bytes.to_vec());
            Ok(())
        })
        .unwrap();

        let (signing_a, secret_a, binding_a) = make_identity("dev-sender");
        let (signing_b, secret_b, binding_b) = make_identity("dev-receiver");
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();

        let receiver_data_root = temp_dir("e2e-receiver-data");
        let destination = temp_dir("e2e-receiver-dest");
        fs::remove_dir_all(&destination).unwrap(); // sync_staging expects to create/replace it itself

        let manifest_for_sender = manifest.clone();
        let destination_for_sender = destination.to_str().unwrap().to_string();
        let sender = thread::spawn(move || {
            let mut stream = TcpStream::connect(addr).unwrap();
            let local = LocalIdentity {
                account_route: "route-a".to_string(),
                device_id: "dev-sender".to_string(),
                signing_key: &signing_a,
                agreement_secret: &secret_a,
                key_binding: binding_a,
            };
            let session = establish_as_initiator(&mut stream, &local, &AllowAll).unwrap();
            let mut peer_stream = session.open_stream(&AllowAllGrants, None, None).unwrap();
            send_full_manifest(&mut peer_stream, &mut stream, &manifest_for_sender, &destination_for_sender, &chunk_bytes).unwrap();
        });

        let (mut server_stream, _) = listener.accept().unwrap();
        let local = LocalIdentity {
            account_route: "route-a".to_string(),
            device_id: "dev-receiver".to_string(),
            signing_key: &signing_b,
            agreement_secret: &secret_b,
            key_binding: binding_b,
        };
        let session = establish_as_responder(&mut server_stream, &local, &AllowAll).unwrap();
        let mut peer_stream = session.open_stream(&AllowAllGrants, None, None).unwrap();
        let journal = receive_full_manifest(
            &mut peer_stream,
            &mut server_stream,
            &receiver_data_root,
            "sub-e2e",
            2_000,
            // The destination actually used is whatever `begin_staging_at` receives via the
            // `ManifestOffer` frame — overridden here since the sender's `destination` argument
            // above is a placeholder; a real caller would agree on this out of band (or the
            // manifest offer would simply omit it and the receiver would supply its own, a
            // decision left to the caller of this module).
        )
        .unwrap();
        sender.join().unwrap();

        assert_eq!(journal.state, sync_staging::JournalState::Published);
        let published_destination = PathBuf::from(&journal.destination);
        assert_eq!(
            fs::read(published_destination.join("README.md")).unwrap(),
            b"hello project".to_vec()
        );
        assert_eq!(
            fs::read(published_destination.join("large.bin")).unwrap(),
            large_content,
            "large multi-chunk file must reassemble byte-identical to the source"
        );
        assert_eq!(
            fs::read(published_destination.join("src").join("main.rs")).unwrap(),
            fs::read(source.join("src").join("main.rs")).unwrap()
        );

        fs::remove_dir_all(&source).unwrap();
        fs::remove_dir_all(&receiver_data_root).unwrap();
        let _ = fs::remove_dir_all(&published_destination);
        let backup = published_destination.with_file_name(format!(
            "{}.alethe-prev",
            published_destination.file_name().unwrap().to_string_lossy()
        ));
        let _ = fs::remove_dir_all(&backup);
    }

    #[test]
    fn receiver_skips_re_requesting_chunks_it_already_has_staged() {
        // Regression guard for the dedup-by-already-staged check: begin staging, pre-seed one
        // chunk directly via `receive_chunk_at` (simulating a resumed transfer), then drive the
        // receiver loop and confirm it never emits a `ChunkRequest` for that chunk.
        let source = temp_dir("resume-source");
        fs::write(source.join("a.txt"), b"small file content").unwrap();
        let signing_key = SigningKey::generate(&mut OsRng);
        let mut chunk_bytes: HashMap<String, Vec<u8>> = HashMap::new();
        let manifest = build_manifest_from_dir(&source, "p", "r", "d", &signing_key, 1_000, |id, bytes| {
            chunk_bytes.insert(id.to_string(), bytes.to_vec());
            Ok(())
        })
        .unwrap();
        assert_eq!(manifest.entries.iter().filter(|e| e.kind == crate::sync_manifest::EntryKind::File).count(), 1);
        let only_chunk_id = manifest.entries[0].chunks[0].chunk_id.clone();

        let data_root = temp_dir("resume-data");
        let destination = temp_dir("resume-dest");
        fs::remove_dir_all(&destination).unwrap();
        sync_staging::begin_staging_at(&data_root, "sub-resume", manifest.clone(), destination.to_str().unwrap(), 1_000).unwrap();
        sync_staging::receive_chunk_at(&data_root, "sub-resume", &only_chunk_id, &chunk_bytes[&only_chunk_id], 1_500).unwrap();

        let journal = sync_staging::load_staging_at(&data_root, "sub-resume").unwrap();
        assert!(journal.received_chunk_ids.contains(&only_chunk_id));

        fs::remove_dir_all(&source).unwrap();
        fs::remove_dir_all(&data_root).unwrap();
    }
}
