//! Provider-independent encrypted peer transport (Phase 4, ADR-0005). Two devices that already
//! trust each other's Ed25519 identity (Phase 1) and hold a signed X25519 key binding
//! (Phase 3/ADR-0003) can establish an authenticated, end-to-end encrypted session over any byte
//! stream — loopback, a manually supplied address, or an opt-in LAN candidate. No rendezvous or
//! relay provider is contacted by anything in this module.

use std::collections::VecDeque;
use std::io::{Read, Write};

use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use rand_core::RngCore;
use x25519_dalek::{PublicKey as X25519PublicKey, StaticSecret as X25519StaticSecret};

use crate::sync_crypto::{self, DeviceKeyBinding};

pub const TRANSPORT_PROTOCOL_VERSION: u32 = 1;
/// Ceiling on a single encoded frame (header + ciphertext), enforced from the length prefix
/// before any buffer of that size is allocated.
pub const MAX_FRAME_BYTES: usize = 256 * 1024;
/// Ceiling on the handshake `Hello` message, which is small and fixed-shape.
pub const MAX_HANDSHAKE_BYTES: usize = 8 * 1024;
/// Application-level backpressure bound: outbound frames queued but not yet flushed to the
/// underlying stream.
pub const MAX_QUEUED_FRAMES: usize = 64;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TransportError {
    Io,
    Malformed,
    FrameTooLarge,
    HandshakeTooLarge,
    VersionIncompatible,
    InvalidKeyBinding,
    InvalidProof,
    NotTrusted,
    NotAuthorized,
    Replayed,
    OutOfOrder,
    WrongSession,
    WrongStream,
    WrongProject,
    Closed,
    Revoked,
    Backpressure,
}

impl std::fmt::Display for TransportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let code = match self {
            TransportError::Io => "transport_io_error",
            TransportError::Malformed => "transport_malformed",
            TransportError::FrameTooLarge => "transport_frame_too_large",
            TransportError::HandshakeTooLarge => "transport_handshake_too_large",
            TransportError::VersionIncompatible => "transport_version_incompatible",
            TransportError::InvalidKeyBinding => "transport_key_binding_invalid",
            TransportError::InvalidProof => "transport_handshake_proof_invalid",
            TransportError::NotTrusted => "transport_device_not_trusted",
            TransportError::NotAuthorized => "transport_not_authorized",
            TransportError::Replayed => "transport_frame_replayed",
            TransportError::OutOfOrder => "transport_frame_out_of_order",
            TransportError::WrongSession => "transport_wrong_session",
            TransportError::WrongStream => "transport_wrong_stream",
            TransportError::WrongProject => "transport_wrong_project",
            TransportError::Closed => "transport_stream_closed",
            TransportError::Revoked => "transport_session_revoked",
            TransportError::Backpressure => "transport_backpressure",
        };
        write!(f, "{code}")
    }
}

/// Authorizes a device's account/device-trust state. Backed by `sync_security.rs` in
/// production; a fixture in tests, so this module has no file-I/O dependency of its own.
pub trait DeviceTrustOracle {
    fn check_trusted(&self, account_route: &str, device_id: &str) -> Result<(), TransportError>;
}

/// Authorizes opening a stream for a specific (optional) project/grant context. Phase 4 does not
/// move real project content, so callers may pass `None`/`None` for a bare authenticated
/// channel; later phases supply real project/grant IDs here.
pub trait GrantAuthorizer {
    fn check_authorized(
        &self,
        account_route: &str,
        device_id: &str,
        project_id: Option<&str>,
        grant_id: Option<&str>,
    ) -> Result<(), TransportError>;
}

/// A candidate address to attempt a direct connection to. Phase 4 only supports a caller-
/// supplied manual candidate or a loopback/LAN fixture — no automatic internet discovery, which
/// requires a rendezvous service (Phase 10B).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Candidate {
    pub host: String,
    pub port: u16,
}

/// Yields bounded candidate sets. `ManualCandidateSource` is the only Phase 4 implementation;
/// later phases may add LAN mDNS discovery behind the same trait without touching session code.
pub trait CandidateSource {
    fn candidates(&self) -> Vec<Candidate>;
}

pub struct ManualCandidateSource(pub Vec<Candidate>);

impl CandidateSource for ManualCandidateSource {
    fn candidates(&self) -> Vec<Candidate> {
        self.0.clone()
    }
}

/// This device's identity material needed to establish a session — never includes anything that
/// is not already held locally per Phase 1/3.
pub struct LocalIdentity<'a> {
    pub account_route: String,
    pub device_id: String,
    pub signing_key: &'a SigningKey,
    pub agreement_secret: &'a X25519StaticSecret,
    pub key_binding: DeviceKeyBinding,
}

struct RemoteHello {
    min_protocol_version: u32,
    max_protocol_version: u32,
    account_route: String,
    device_id: String,
    challenge: [u8; 32],
    key_binding: DeviceKeyBinding,
}

fn write_len_prefixed(buffer: &mut Vec<u8>, bytes: &[u8]) {
    buffer.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
    buffer.extend_from_slice(bytes);
}

fn encode_hello(
    local: &LocalIdentity,
    challenge: &[u8; 32],
) -> Vec<u8> {
    let mut buffer = Vec::with_capacity(256);
    buffer.extend_from_slice(&TRANSPORT_PROTOCOL_VERSION.to_le_bytes());
    buffer.extend_from_slice(&TRANSPORT_PROTOCOL_VERSION.to_le_bytes());
    write_len_prefixed(&mut buffer, local.account_route.as_bytes());
    write_len_prefixed(&mut buffer, local.device_id.as_bytes());
    buffer.extend_from_slice(challenge);
    write_len_prefixed(&mut buffer, &local.key_binding.ed25519_public_key);
    write_len_prefixed(&mut buffer, &local.key_binding.x25519_public_key);
    buffer.extend_from_slice(&local.key_binding.bound_at_ms.to_le_bytes());
    write_len_prefixed(&mut buffer, &local.key_binding.signature);
    buffer
}

fn decode_hello(bytes: &[u8]) -> Result<RemoteHello, TransportError> {
    let mut offset = 0_usize;
    let take = |offset: &mut usize, count: usize, bytes: &[u8]| -> Result<Vec<u8>, TransportError> {
        let end = offset.checked_add(count).ok_or(TransportError::Malformed)?;
        let slice = bytes.get(*offset..end).ok_or(TransportError::Malformed)?;
        *offset = end;
        Ok(slice.to_vec())
    };
    let read_len_prefixed = |offset: &mut usize, bytes: &[u8]| -> Result<Vec<u8>, TransportError> {
        let length_bytes = take(offset, 4, bytes)?;
        let length = u32::from_le_bytes(length_bytes.try_into().unwrap()) as usize;
        if length > MAX_HANDSHAKE_BYTES {
            return Err(TransportError::FrameTooLarge);
        }
        take(offset, length, bytes)
    };

    let min_protocol_version =
        u32::from_le_bytes(take(&mut offset, 4, bytes)?.try_into().unwrap());
    let max_protocol_version =
        u32::from_le_bytes(take(&mut offset, 4, bytes)?.try_into().unwrap());
    let account_route =
        String::from_utf8(read_len_prefixed(&mut offset, bytes)?).map_err(|_| TransportError::Malformed)?;
    let device_id =
        String::from_utf8(read_len_prefixed(&mut offset, bytes)?).map_err(|_| TransportError::Malformed)?;
    let challenge_vec = take(&mut offset, 32, bytes)?;
    let challenge: [u8; 32] = challenge_vec.try_into().map_err(|_| TransportError::Malformed)?;
    let ed25519_public_key = read_len_prefixed(&mut offset, bytes)?;
    let x25519_public_key = read_len_prefixed(&mut offset, bytes)?;
    let bound_at_ms = u64::from_le_bytes(take(&mut offset, 8, bytes)?.try_into().unwrap());
    let signature = read_len_prefixed(&mut offset, bytes)?;
    if offset != bytes.len() {
        return Err(TransportError::Malformed);
    }
    Ok(RemoteHello {
        min_protocol_version,
        max_protocol_version,
        account_route,
        device_id: device_id.clone(),
        challenge,
        key_binding: DeviceKeyBinding {
            device_id,
            ed25519_public_key,
            x25519_public_key,
            bound_at_ms,
            signature,
        },
    })
}

fn write_frame(stream: &mut impl Write, payload: &[u8]) -> Result<(), TransportError> {
    let mut framed = Vec::with_capacity(payload.len() + 4);
    write_len_prefixed(&mut framed, payload);
    stream.write_all(&framed).map_err(|_| TransportError::Io)
}

fn read_frame(stream: &mut impl Read, max_len: usize) -> Result<Vec<u8>, TransportError> {
    let mut length_bytes = [0_u8; 4];
    stream.read_exact(&mut length_bytes).map_err(|_| TransportError::Io)?;
    let length = u32::from_le_bytes(length_bytes) as usize;
    if length > max_len {
        return Err(TransportError::FrameTooLarge);
    }
    let mut payload = vec![0_u8; length];
    stream.read_exact(&mut payload).map_err(|_| TransportError::Io)?;
    Ok(payload)
}

fn random_challenge() -> [u8; 32] {
    let mut challenge = [0_u8; 32];
    rand_core::OsRng.fill_bytes(&mut challenge);
    challenge
}

/// Established, authenticated, encrypted session between two devices. Holds only directional
/// session keys and bookkeeping state — no long-lived private material beyond what the caller
/// already supplied.
pub struct Session {
    pub session_id: String,
    pub local_device_id: String,
    pub remote_device_id: String,
    pub remote_account_route: String,
    send_key: [u8; 32],
    receive_key: [u8; 32],
    send_base_nonce: [u8; 12],
    receive_base_nonce: [u8; 12],
    revoked: bool,
}

impl std::fmt::Debug for Session {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Session")
            .field("session_id", &self.session_id)
            .field("local_device_id", &self.local_device_id)
            .field("remote_device_id", &self.remote_device_id)
            .field("remote_account_route", &self.remote_account_route)
            .field("revoked", &self.revoked)
            .field("send_key", &"[redacted]")
            .field("receive_key", &"[redacted]")
            .finish()
    }
}

fn frame_nonce(base: &[u8; 12], sequence: u64) -> Nonce {
    let mut nonce_bytes = *base;
    let sequence_bytes = sequence.to_be_bytes();
    for (index, byte) in sequence_bytes.iter().enumerate() {
        nonce_bytes[4 + index] ^= byte;
    }
    Nonce::clone_from_slice(&nonce_bytes)
}

fn perform_handshake(
    stream: &mut (impl Read + Write),
    local: &LocalIdentity,
    trust_oracle: &dyn DeviceTrustOracle,
    is_initiator: bool,
) -> Result<Session, TransportError> {
    let local_challenge = random_challenge();
    let hello_bytes = encode_hello(local, &local_challenge);

    let remote = if is_initiator {
        write_frame(stream, &hello_bytes)?;
        let remote_bytes = read_frame(stream, MAX_HANDSHAKE_BYTES)?;
        decode_hello(&remote_bytes)?
    } else {
        let remote_bytes = read_frame(stream, MAX_HANDSHAKE_BYTES)?;
        let remote = decode_hello(&remote_bytes)?;
        write_frame(stream, &hello_bytes)?;
        remote
    };

    if remote.min_protocol_version > TRANSPORT_PROTOCOL_VERSION
        || remote.max_protocol_version < TRANSPORT_PROTOCOL_VERSION
    {
        return Err(TransportError::VersionIncompatible);
    }
    sync_crypto::verify_key_binding(&remote.key_binding)
        .map_err(|_| TransportError::InvalidKeyBinding)?;
    trust_oracle.check_trusted(&remote.account_route, &remote.device_id)?;

    let remote_ed25519_bytes: [u8; 32] = remote
        .key_binding
        .ed25519_public_key
        .as_slice()
        .try_into()
        .map_err(|_| TransportError::Malformed)?;
    let remote_verifying_key =
        VerifyingKey::from_bytes(&remote_ed25519_bytes).map_err(|_| TransportError::Malformed)?;

    // Challenge-response: each side signs the *other's* challenge to prove possession of its
    // Ed25519 identity private key without ever transmitting it.
    let local_proof = local.signing_key.sign(&remote.challenge);
    let proof_bytes = local_proof.to_bytes().to_vec();
    let remote_proof_bytes = if is_initiator {
        write_frame(stream, &proof_bytes)?;
        read_frame(stream, MAX_HANDSHAKE_BYTES)?
    } else {
        let remote_proof = read_frame(stream, MAX_HANDSHAKE_BYTES)?;
        write_frame(stream, &proof_bytes)?;
        remote_proof
    };
    let remote_signature_bytes: [u8; 64] = remote_proof_bytes
        .as_slice()
        .try_into()
        .map_err(|_| TransportError::Malformed)?;
    let remote_signature = Signature::from_bytes(&remote_signature_bytes);
    remote_verifying_key
        .verify(&local_challenge, &remote_signature)
        .map_err(|_| TransportError::InvalidProof)?;

    let remote_x25519_bytes: [u8; 32] = remote
        .key_binding
        .x25519_public_key
        .as_slice()
        .try_into()
        .map_err(|_| TransportError::Malformed)?;
    let remote_x25519_public = X25519PublicKey::from(remote_x25519_bytes);

    let session_id = {
        let mut combined = Vec::with_capacity(64);
        let (first, second) = if is_initiator {
            (local_challenge, remote.challenge)
        } else {
            (remote.challenge, local_challenge)
        };
        combined.extend_from_slice(&first);
        combined.extend_from_slice(&second);
        use sha2::{Digest, Sha256};
        let digest = Sha256::digest(&combined);
        digest.iter().map(|byte| format!("{byte:02x}")).collect::<String>()
    };

    let keys = sync_crypto::derive_session_keys(
        local.agreement_secret,
        &remote_x25519_public,
        TRANSPORT_PROTOCOL_VERSION,
        &local.device_id,
        &remote.device_id,
        &session_id,
        is_initiator,
    );

    // Base nonces are derived from the session id (public, unique per session) rather than kept
    // secret — uniqueness, not secrecy, is what a nonce needs; secrecy comes from the key. Both
    // sides must label each *direction* identically regardless of which side is computing it, so
    // the initiator's send nonce base matches the responder's receive nonce base (and vice
    // versa) — using "is_initiator" in the label here would desynchronize the two sides.
    use sha2::{Digest, Sha256};
    let mut initiator_to_responder_nonce = [0_u8; 12];
    let mut responder_to_initiator_nonce = [0_u8; 12];
    initiator_to_responder_nonce
        .copy_from_slice(&Sha256::digest(format!("{session_id}|initiator_to_responder").as_bytes())[..12]);
    responder_to_initiator_nonce
        .copy_from_slice(&Sha256::digest(format!("{session_id}|responder_to_initiator").as_bytes())[..12]);
    let (send_base_nonce, receive_base_nonce) = if is_initiator {
        (initiator_to_responder_nonce, responder_to_initiator_nonce)
    } else {
        (responder_to_initiator_nonce, initiator_to_responder_nonce)
    };

    Ok(Session {
        session_id,
        local_device_id: local.device_id.clone(),
        remote_device_id: remote.device_id,
        remote_account_route: remote.account_route,
        send_key: keys.send,
        receive_key: keys.receive,
        send_base_nonce,
        receive_base_nonce,
        revoked: false,
    })
}

pub fn establish_as_initiator(
    stream: &mut (impl Read + Write),
    local: &LocalIdentity,
    trust_oracle: &dyn DeviceTrustOracle,
) -> Result<Session, TransportError> {
    perform_handshake(stream, local, trust_oracle, true)
}

pub fn establish_as_responder(
    stream: &mut (impl Read + Write),
    local: &LocalIdentity,
    trust_oracle: &dyn DeviceTrustOracle,
) -> Result<Session, TransportError> {
    perform_handshake(stream, local, trust_oracle, false)
}

impl Session {
    pub fn revoke(&mut self) {
        self.revoked = true;
    }

    pub fn is_revoked(&self) -> bool {
        self.revoked
    }

    /// Opens one logical stream for a specific (optional) project/grant purpose, after checking
    /// authorization. Phase 4 ships exactly one logical stream per session (ADR-0005); later
    /// phases add multiplexing when there is real content to multiplex.
    pub fn open_stream(
        &self,
        authorizer: &dyn GrantAuthorizer,
        project_id: Option<&str>,
        grant_id: Option<&str>,
    ) -> Result<PeerStream, TransportError> {
        if self.revoked {
            return Err(TransportError::Revoked);
        }
        authorizer.check_authorized(
            &self.remote_account_route,
            &self.remote_device_id,
            project_id,
            grant_id,
        )?;
        Ok(PeerStream {
            session_id: self.session_id.clone(),
            stream_id: 0,
            local_device_id: self.local_device_id.clone(),
            remote_device_id: self.remote_device_id.clone(),
            project_id: project_id.map(str::to_string),
            grant_id: grant_id.map(str::to_string),
            send_key: self.send_key,
            receive_key: self.receive_key,
            send_base_nonce: self.send_base_nonce,
            receive_base_nonce: self.receive_base_nonce,
            next_send_sequence: 0,
            next_receive_sequence: 0,
            closed: false,
            outbound_queue: VecDeque::new(),
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct FrameHeader {
    protocol_version: u32,
    session_id: String,
    stream_id: u32,
    sender_device_id: String,
    recipient_device_id: String,
    project_id: Option<String>,
    grant_id: Option<String>,
    sequence: u64,
}

fn header_aad(header: &FrameHeader) -> Vec<u8> {
    let mut buffer = Vec::with_capacity(128);
    buffer.extend_from_slice(&header.protocol_version.to_le_bytes());
    write_len_prefixed(&mut buffer, header.session_id.as_bytes());
    buffer.extend_from_slice(&header.stream_id.to_le_bytes());
    write_len_prefixed(&mut buffer, header.sender_device_id.as_bytes());
    write_len_prefixed(&mut buffer, header.recipient_device_id.as_bytes());
    write_len_prefixed(&mut buffer, header.project_id.as_deref().unwrap_or("").as_bytes());
    write_len_prefixed(&mut buffer, header.grant_id.as_deref().unwrap_or("").as_bytes());
    buffer.extend_from_slice(&header.sequence.to_le_bytes());
    buffer
}

/// A single bounded, encrypted, sequence-ordered logical channel within a session. Every frame
/// is bound (via AEAD associated data) to protocol version, session, stream, sender/recipient
/// device, project/grant context, and sequence — substituting any of those fields invalidates
/// the authentication tag.
pub struct PeerStream {
    session_id: String,
    stream_id: u32,
    local_device_id: String,
    remote_device_id: String,
    project_id: Option<String>,
    grant_id: Option<String>,
    send_key: [u8; 32],
    receive_key: [u8; 32],
    send_base_nonce: [u8; 12],
    receive_base_nonce: [u8; 12],
    next_send_sequence: u64,
    next_receive_sequence: u64,
    closed: bool,
    outbound_queue: VecDeque<Vec<u8>>,
}

impl std::fmt::Debug for PeerStream {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PeerStream")
            .field("session_id", &self.session_id)
            .field("stream_id", &self.stream_id)
            .field("remote_device_id", &self.remote_device_id)
            .field("project_id", &self.project_id)
            .field("grant_id", &self.grant_id)
            .field("next_send_sequence", &self.next_send_sequence)
            .field("next_receive_sequence", &self.next_receive_sequence)
            .field("closed", &self.closed)
            .field("send_key", &"[redacted]")
            .field("receive_key", &"[redacted]")
            .finish()
    }
}

impl PeerStream {
    /// Encrypts `plaintext` and enqueues it for send. Enforces the backpressure bound
    /// (`MAX_QUEUED_FRAMES`) and the per-frame size ceiling before touching any stream I/O, so a
    /// caller that never flushes cannot grow unbounded memory.
    pub fn enqueue(&mut self, plaintext: &[u8]) -> Result<(), TransportError> {
        if self.closed {
            return Err(TransportError::Closed);
        }
        if plaintext.len() > MAX_FRAME_BYTES {
            return Err(TransportError::FrameTooLarge);
        }
        if self.outbound_queue.len() >= MAX_QUEUED_FRAMES {
            return Err(TransportError::Backpressure);
        }
        let header = FrameHeader {
            protocol_version: TRANSPORT_PROTOCOL_VERSION,
            session_id: self.session_id.clone(),
            stream_id: self.stream_id,
            sender_device_id: self.local_device_id.clone(),
            recipient_device_id: self.remote_device_id.clone(),
            project_id: self.project_id.clone(),
            grant_id: self.grant_id.clone(),
            sequence: self.next_send_sequence,
        };
        let aad = header_aad(&header);
        let cipher = ChaCha20Poly1305::new(Key::from_slice(&self.send_key));
        let nonce = frame_nonce(&self.send_base_nonce, header.sequence);
        let ciphertext = cipher
            .encrypt(&nonce, chacha20poly1305::aead::Payload { msg: plaintext, aad: &aad })
            .map_err(|_| TransportError::Io)?;

        let mut encoded = Vec::with_capacity(aad.len() + ciphertext.len() + 8);
        write_len_prefixed(&mut encoded, &aad);
        write_len_prefixed(&mut encoded, &ciphertext);
        self.outbound_queue.push_back(encoded);
        self.next_send_sequence += 1;
        Ok(())
    }

    /// Flushes every queued frame to `stream` in order.
    pub fn flush(&mut self, stream: &mut impl Write) -> Result<(), TransportError> {
        while let Some(frame) = self.outbound_queue.pop_front() {
            write_frame(stream, &frame)?;
        }
        Ok(())
    }

    pub fn queued_frames(&self) -> usize {
        self.outbound_queue.len()
    }

    /// Reads and decrypts exactly one frame from `stream`. Rejects: frames from a stale/foreign
    /// session or stream, a sequence that is not exactly the next expected value (both replay
    /// and out-of-order/reordering fail this check), a project/grant mismatch, and any tampering
    /// (via AEAD tag failure).
    pub fn receive(&mut self, stream: &mut impl Read) -> Result<Vec<u8>, TransportError> {
        if self.closed {
            return Err(TransportError::Closed);
        }
        let encoded = read_frame(stream, MAX_FRAME_BYTES + 4_096)?;
        self.decrypt_received(&encoded)
    }

    /// Decrypts an already-read frame. Split out from `receive` so frame-integrity tests do not
    /// need a real socket.
    fn decrypt_received(&mut self, encoded: &[u8]) -> Result<Vec<u8>, TransportError> {
        let mut offset = 0_usize;
        let aad_len = u32::from_le_bytes(
            encoded.get(0..4).ok_or(TransportError::Malformed)?.try_into().unwrap(),
        ) as usize;
        offset += 4;
        let aad = encoded
            .get(offset..offset + aad_len)
            .ok_or(TransportError::Malformed)?;
        offset += aad_len;
        let ciphertext_len = u32::from_le_bytes(
            encoded
                .get(offset..offset + 4)
                .ok_or(TransportError::Malformed)?
                .try_into()
                .unwrap(),
        ) as usize;
        offset += 4;
        let ciphertext = encoded
            .get(offset..offset + ciphertext_len)
            .ok_or(TransportError::Malformed)?;

        let header = parse_header_aad(aad)?;
        if header.session_id != self.session_id {
            return Err(TransportError::WrongSession);
        }
        if header.stream_id != self.stream_id {
            return Err(TransportError::WrongStream);
        }
        if header.project_id != self.project_id || header.grant_id != self.grant_id {
            return Err(TransportError::WrongProject);
        }
        if header.sequence < self.next_receive_sequence {
            return Err(TransportError::Replayed);
        }
        if header.sequence > self.next_receive_sequence {
            return Err(TransportError::OutOfOrder);
        }

        let cipher = ChaCha20Poly1305::new(Key::from_slice(&self.receive_key));
        let nonce = frame_nonce(&self.receive_base_nonce, header.sequence);
        let plaintext = cipher
            .decrypt(&nonce, chacha20poly1305::aead::Payload { msg: ciphertext, aad })
            .map_err(|_| TransportError::InvalidProof)?;
        self.next_receive_sequence += 1;
        Ok(plaintext)
    }

    pub fn close(&mut self) {
        self.closed = true;
        self.outbound_queue.clear();
    }
}

fn parse_header_aad(aad: &[u8]) -> Result<FrameHeader, TransportError> {
    let mut offset = 0_usize;
    let take = |offset: &mut usize, count: usize| -> Result<&[u8], TransportError> {
        let end = offset.checked_add(count).ok_or(TransportError::Malformed)?;
        let slice = aad.get(*offset..end).ok_or(TransportError::Malformed)?;
        *offset = end;
        Ok(slice)
    };
    let read_len_prefixed = |offset: &mut usize| -> Result<Vec<u8>, TransportError> {
        let length = u32::from_le_bytes(take(offset, 4)?.try_into().unwrap()) as usize;
        Ok(take(offset, length)?.to_vec())
    };
    let protocol_version = u32::from_le_bytes(take(&mut offset, 4)?.try_into().unwrap());
    let session_id =
        String::from_utf8(read_len_prefixed(&mut offset)?).map_err(|_| TransportError::Malformed)?;
    let stream_id = u32::from_le_bytes(take(&mut offset, 4)?.try_into().unwrap());
    let sender_device_id =
        String::from_utf8(read_len_prefixed(&mut offset)?).map_err(|_| TransportError::Malformed)?;
    let recipient_device_id =
        String::from_utf8(read_len_prefixed(&mut offset)?).map_err(|_| TransportError::Malformed)?;
    let project_raw =
        String::from_utf8(read_len_prefixed(&mut offset)?).map_err(|_| TransportError::Malformed)?;
    let grant_raw =
        String::from_utf8(read_len_prefixed(&mut offset)?).map_err(|_| TransportError::Malformed)?;
    let sequence = u64::from_le_bytes(take(&mut offset, 8)?.try_into().unwrap());
    Ok(FrameHeader {
        protocol_version,
        session_id,
        stream_id,
        sender_device_id,
        recipient_device_id,
        project_id: (!project_raw.is_empty()).then_some(project_raw),
        grant_id: (!grant_raw.is_empty()).then_some(grant_raw),
        sequence,
    })
}

/// Safe, non-secret metadata a caller may persist to attempt resuming a session after a
/// disconnect. Contains no key material — a resumed session re-derives keys from a fresh
/// handshake; this ticket only lets the caller validate continuity (device/account still match,
/// sequence does not rewind) before accepting old application state as still valid.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResumeTicket {
    pub session_id: String,
    pub remote_account_route: String,
    pub remote_device_id: String,
    pub last_sent_sequence: u64,
    pub last_received_sequence: u64,
    pub created_at_ms: u64,
}

impl PeerStream {
    pub fn resume_ticket(&self, remote_account_route: &str, now_ms: u64) -> ResumeTicket {
        ResumeTicket {
            session_id: self.session_id.clone(),
            remote_account_route: remote_account_route.to_string(),
            remote_device_id: self.remote_device_id.clone(),
            last_sent_sequence: self.next_send_sequence,
            last_received_sequence: self.next_receive_sequence,
            created_at_ms: now_ms,
        }
    }
}

/// Validates a resume ticket against a freshly established session before letting a caller treat
/// old application state as still authorized. Revocation or an account/device mismatch since the
/// ticket was issued must invalidate it.
pub fn validate_resume(
    ticket: &ResumeTicket,
    fresh_session: &Session,
    trust_oracle: &dyn DeviceTrustOracle,
) -> Result<(), TransportError> {
    if ticket.remote_device_id != fresh_session.remote_device_id
        || ticket.remote_account_route != fresh_session.remote_account_route
    {
        return Err(TransportError::WrongSession);
    }
    trust_oracle.check_trusted(&ticket.remote_account_route, &ticket.remote_device_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand_core::OsRng;
    use std::io::Cursor;
    use std::net::{TcpListener, TcpStream};
    use std::thread;

    struct AllowAll;
    impl DeviceTrustOracle for AllowAll {
        fn check_trusted(&self, _account_route: &str, _device_id: &str) -> Result<(), TransportError> {
            Ok(())
        }
    }
    struct DenyAll;
    impl DeviceTrustOracle for DenyAll {
        fn check_trusted(&self, _account_route: &str, _device_id: &str) -> Result<(), TransportError> {
            Err(TransportError::NotTrusted)
        }
    }
    struct AllowAllGrants;
    impl GrantAuthorizer for AllowAllGrants {
        fn check_authorized(
            &self,
            _account_route: &str,
            _device_id: &str,
            _project_id: Option<&str>,
            _grant_id: Option<&str>,
        ) -> Result<(), TransportError> {
            Ok(())
        }
    }
    struct DenyProject(&'static str);
    impl GrantAuthorizer for DenyProject {
        fn check_authorized(
            &self,
            _account_route: &str,
            _device_id: &str,
            project_id: Option<&str>,
            _grant_id: Option<&str>,
        ) -> Result<(), TransportError> {
            if project_id == Some(self.0) {
                return Err(TransportError::NotAuthorized);
            }
            Ok(())
        }
    }

    fn make_identity(account_route: &str, device_id: &str) -> (SigningKey, X25519StaticSecret, DeviceKeyBinding) {
        let signing_key = SigningKey::generate(&mut OsRng);
        let (agreement_secret, binding) =
            sync_crypto::generate_bound_key_agreement(device_id, &signing_key, 1_000);
        let _ = account_route;
        (signing_key, agreement_secret, binding)
    }

    #[test]
    fn two_devices_authenticate_over_real_tcp_loopback() {
        let (signing_a, secret_a, binding_a) = make_identity("route-a", "dev-a");
        let (signing_b, secret_b, binding_b) = make_identity("route-a", "dev-b");

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();

        let responder = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let local = LocalIdentity {
                account_route: "route-a".to_string(),
                device_id: "dev-b".to_string(),
                signing_key: &signing_b,
                agreement_secret: &secret_b,
                key_binding: binding_b,
            };
            establish_as_responder(&mut stream, &local, &AllowAll).unwrap()
        });

        let mut client = TcpStream::connect(addr).unwrap();
        let local = LocalIdentity {
            account_route: "route-a".to_string(),
            device_id: "dev-a".to_string(),
            signing_key: &signing_a,
            agreement_secret: &secret_a,
            key_binding: binding_a,
        };
        let initiator_session = establish_as_initiator(&mut client, &local, &AllowAll).unwrap();
        let responder_session = responder.join().unwrap();

        assert_eq!(initiator_session.session_id, responder_session.session_id);
        assert_eq!(initiator_session.remote_device_id, "dev-b");
        assert_eq!(responder_session.remote_device_id, "dev-a");

        let mut initiator_stream = initiator_session.open_stream(&AllowAllGrants, None, None).unwrap();
        initiator_stream.enqueue(b"hello from a").unwrap();
        let mut wire = Vec::new();
        initiator_stream.flush(&mut wire).unwrap();

        let mut responder_stream = responder_session.open_stream(&AllowAllGrants, None, None).unwrap();
        let mut reader = Cursor::new(wire);
        let received = responder_stream.receive(&mut reader).unwrap();
        assert_eq!(received, b"hello from a");
    }

    #[test]
    fn handshake_rejects_an_untrusted_device() {
        let (signing_a, secret_a, binding_a) = make_identity("route-a", "dev-a");
        let (signing_b, secret_b, binding_b) = make_identity("route-a", "dev-b");
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();

        let responder = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let local = LocalIdentity {
                account_route: "route-a".to_string(),
                device_id: "dev-b".to_string(),
                signing_key: &signing_b,
                agreement_secret: &secret_b,
                key_binding: binding_b,
            };
            establish_as_responder(&mut stream, &local, &AllowAll)
        });

        let mut client = TcpStream::connect(addr).unwrap();
        let local = LocalIdentity {
            account_route: "route-a".to_string(),
            device_id: "dev-a".to_string(),
            signing_key: &signing_a,
            agreement_secret: &secret_a,
            key_binding: binding_a,
        };
        let result = establish_as_initiator(&mut client, &local, &DenyAll);
        assert_eq!(result.unwrap_err(), TransportError::NotTrusted);
        // The initiator never writes its handshake proof after a distrust rejection, so the
        // responder — still blocked reading that proof — must see the socket close (EOF) rather
        // than hang forever waiting for bytes that will never arrive.
        let _ = client.shutdown(std::net::Shutdown::Both);
        drop(client);
        let _ = responder.join().unwrap();
    }

    fn established_pair() -> (Session, Session) {
        let (signing_a, secret_a, binding_a) = make_identity("route-a", "dev-a");
        let (signing_b, secret_b, binding_b) = make_identity("route-a", "dev-b");
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let responder = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let local = LocalIdentity {
                account_route: "route-a".to_string(),
                device_id: "dev-b".to_string(),
                signing_key: &signing_b,
                agreement_secret: &secret_b,
                key_binding: binding_b,
            };
            establish_as_responder(&mut stream, &local, &AllowAll).unwrap()
        });
        let mut client = TcpStream::connect(addr).unwrap();
        let local = LocalIdentity {
            account_route: "route-a".to_string(),
            device_id: "dev-a".to_string(),
            signing_key: &signing_a,
            agreement_secret: &secret_a,
            key_binding: binding_a,
        };
        let initiator_session = establish_as_initiator(&mut client, &local, &AllowAll).unwrap();
        let responder_session = responder.join().unwrap();
        (initiator_session, responder_session)
    }

    #[test]
    fn replayed_and_out_of_order_frames_are_rejected() {
        let (initiator, responder) = established_pair();
        let mut sender = initiator.open_stream(&AllowAllGrants, None, None).unwrap();
        sender.enqueue(b"frame-0").unwrap();
        sender.enqueue(b"frame-1").unwrap();
        let mut wire = Vec::new();
        sender.flush(&mut wire).unwrap();

        // Split the two encoded frames out of the wire buffer so we can feed them out of order.
        let mut cursor = Cursor::new(wire.clone());
        let mut receiver = responder.open_stream(&AllowAllGrants, None, None).unwrap();
        let first = receiver.receive(&mut cursor).unwrap();
        assert_eq!(first, b"frame-0");

        // Replay: feed the same already-consumed bytes again via a fresh cursor over just frame 0.
        let mut replay_cursor = Cursor::new(wire[..cursor.position() as usize].to_vec());
        assert_eq!(
            receiver.receive(&mut replay_cursor).unwrap_err(),
            TransportError::Replayed
        );

        // Out of order: skip straight to a hypothetical frame 2 without consuming frame 1 first.
        let mut skip_sender = initiator.open_stream(&AllowAllGrants, None, None).unwrap();
        skip_sender.next_send_sequence = 2;
        skip_sender.enqueue(b"frame-2").unwrap();
        let mut skip_wire = Vec::new();
        skip_sender.flush(&mut skip_wire).unwrap();
        let mut skip_cursor = Cursor::new(skip_wire);
        assert_eq!(
            receiver.receive(&mut skip_cursor).unwrap_err(),
            TransportError::OutOfOrder
        );
    }

    #[test]
    fn tampered_ciphertext_and_wrong_project_are_rejected() {
        let (initiator, responder) = established_pair();
        let mut sender = initiator
            .open_stream(&AllowAllGrants, Some("project-a"), Some("grant-a"))
            .unwrap();
        sender.enqueue(b"payload").unwrap();
        let mut wire = Vec::new();
        sender.flush(&mut wire).unwrap();

        // Tamper with a ciphertext byte near the end of the buffer.
        let last = wire.len() - 1;
        wire[last] ^= 0xFF;
        let mut receiver = responder
            .open_stream(&AllowAllGrants, Some("project-a"), Some("grant-a"))
            .unwrap();
        let mut cursor = Cursor::new(wire);
        assert_eq!(receiver.receive(&mut cursor).unwrap_err(), TransportError::InvalidProof);

        // A receiver opened for a *different* project must reject even an untampered frame from
        // a sender authorized for a different project (cross-project substitution).
        let mut sender2 = initiator
            .open_stream(&AllowAllGrants, Some("project-a"), Some("grant-a"))
            .unwrap();
        sender2.enqueue(b"payload").unwrap();
        let mut wire2 = Vec::new();
        sender2.flush(&mut wire2).unwrap();
        let mut receiver_wrong_project = responder
            .open_stream(&AllowAllGrants, Some("project-b"), Some("grant-a"))
            .unwrap();
        let mut cursor2 = Cursor::new(wire2);
        assert_eq!(
            receiver_wrong_project.receive(&mut cursor2).unwrap_err(),
            TransportError::WrongProject
        );
    }

    #[test]
    fn open_stream_is_denied_when_the_authorizer_rejects_the_project() {
        let (initiator, _responder) = established_pair();
        let result = initiator.open_stream(&DenyProject("project-secret"), Some("project-secret"), None);
        assert_eq!(result.unwrap_err(), TransportError::NotAuthorized);
    }

    #[test]
    fn oversized_frame_is_rejected_before_allocating_it() {
        let (initiator, responder) = established_pair();
        let sender = initiator.open_stream(&AllowAllGrants, None, None).unwrap();
        let _ = sender;
        let mut receiver = responder.open_stream(&AllowAllGrants, None, None).unwrap();
        let mut oversize_length_prefix = Vec::new();
        oversize_length_prefix.extend_from_slice(&((MAX_FRAME_BYTES as u32) + 4_097).to_le_bytes());
        let mut cursor = Cursor::new(oversize_length_prefix);
        assert_eq!(
            receiver.receive(&mut cursor).unwrap_err(),
            TransportError::FrameTooLarge
        );
    }

    #[test]
    fn enqueue_enforces_backpressure_bound() {
        let (initiator, _responder) = established_pair();
        let mut sender = initiator.open_stream(&AllowAllGrants, None, None).unwrap();
        for _ in 0..MAX_QUEUED_FRAMES {
            sender.enqueue(b"x").unwrap();
        }
        assert_eq!(sender.enqueue(b"one-too-many").unwrap_err(), TransportError::Backpressure);
        assert_eq!(sender.queued_frames(), MAX_QUEUED_FRAMES);
    }

    #[test]
    fn closing_a_stream_rejects_further_send_and_receive() {
        let (initiator, responder) = established_pair();
        let mut sender = initiator.open_stream(&AllowAllGrants, None, None).unwrap();
        sender.close();
        assert_eq!(sender.enqueue(b"after-close").unwrap_err(), TransportError::Closed);

        let mut receiver = responder.open_stream(&AllowAllGrants, None, None).unwrap();
        receiver.close();
        let mut cursor = Cursor::new(Vec::new());
        assert_eq!(receiver.receive(&mut cursor).unwrap_err(), TransportError::Closed);
    }

    #[test]
    fn revoking_a_session_blocks_opening_new_streams() {
        let (mut initiator, _responder) = established_pair();
        initiator.revoke();
        assert!(initiator.is_revoked());
        assert_eq!(
            initiator.open_stream(&AllowAllGrants, None, None).unwrap_err(),
            TransportError::Revoked
        );
    }

    #[test]
    fn resume_ticket_is_rejected_once_the_device_is_no_longer_trusted() {
        let (initiator, _responder) = established_pair();
        let stream = initiator.open_stream(&AllowAllGrants, None, None).unwrap();
        let ticket = stream.resume_ticket(&initiator.remote_account_route, 5_000);

        // Simulate a reconnect: a fresh handshake with the same remote device produces a new
        // `Session` object that must still satisfy the old ticket's identity check (note this is
        // deliberately *not* the `responder` from the pair above — that object represents the
        // *other* device's own view, where `remote_device_id` is the initiator's ID, not a fresh
        // session with the same remote peer).
        let (fresh_initiator, _fresh_responder) = established_pair();
        assert!(validate_resume(&ticket, &fresh_initiator, &AllowAll).is_ok());
        assert_eq!(
            validate_resume(&ticket, &fresh_initiator, &DenyAll).unwrap_err(),
            TransportError::NotTrusted
        );

        let mut wrong = ticket.clone();
        wrong.remote_device_id = "someone-else".to_string();
        assert_eq!(
            validate_resume(&wrong, &fresh_initiator, &AllowAll).unwrap_err(),
            TransportError::WrongSession
        );
    }
}
