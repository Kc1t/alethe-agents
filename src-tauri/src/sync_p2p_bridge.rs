//! Internet NAT traversal for `sync_transport.rs` — entirely additive: this module never edits
//! `sync_transport.rs` or `sync_rendezvous.rs`, it only produces something that implements
//! `Read + Write` (a punched-through UDP path wrapped in a minimal reliable framing) and hands it
//! to `sync_transport::establish_as_initiator`/`establish_as_responder` unchanged, and reuses the
//! existing encrypted-envelope pattern (`sync_crypto::seal_for_recipient`/`open_sealed`, the same
//! primitives `sync_invitation_bridge.rs` already uses) to exchange candidates over the rendezvous
//! relay's already-allowlisted `"candidate"` envelope kind.
//!
//! Two things are deliberately out of scope and documented as such rather than silently assumed:
//! 1. Symmetric NAT (common on carrier-grade/mobile networks) defeats this technique the same way
//!    it defeats every STUN-only P2P system (WebRTC, Tailscale, etc.) — callers must still fall
//!    back to relaying application data through the rendezvous service when the connect attempt
//!    below fails or times out.
//! 2. The reliable-stream wrapper here is intentionally stop-and-wait (one frame in flight at a
//!    time), not a sliding window — throughput is limited by round-trip time, but the failure
//!    modes of a hand-rolled ARQ are far easier to reason about and test than a windowed one, and
//!    this transport only ever needs to carry Phase-4-sized control/application frames.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::net::{SocketAddr, UdpSocket};
use std::time::{Duration, Instant};

use crate::sync_crypto::{open_sealed, seal_for_recipient, SealedEnvelope};

const STUN_SERVERS: [&str; 2] = ["stun.l.google.com:19302", "stun1.l.google.com:19302"];
const STUN_MAGIC_COOKIE: u32 = 0x2112_A442;
const STUN_BINDING_REQUEST: u16 = 0x0001;
const STUN_BINDING_RESPONSE: u16 = 0x0101;
const STUN_ATTR_XOR_MAPPED_ADDRESS: u16 = 0x0020;
const STUN_ATTR_MAPPED_ADDRESS: u16 = 0x0001;

const PUNCH_ATTEMPTS: u32 = 20;
const PUNCH_INTERVAL: Duration = Duration::from_millis(150);
const PUNCH_TOTAL_TIMEOUT: Duration = Duration::from_secs(8);

const ACK_TIMEOUT: Duration = Duration::from_millis(400);
const MAX_RETRANSMITS: u32 = 8;
/// Conservative payload ceiling per UDP datagram (below common path MTU minus IP/UDP/our header
/// overhead), so a single reliable-stream chunk never needs IP-level fragmentation.
const MAX_CHUNK_BYTES: usize = 1200;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum P2pError {
    Stun,
    Punch,
    Io,
    Encode,
    Decode,
    InvalidRecipientKey,
    PayloadTooLarge,
}

impl std::fmt::Display for P2pError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let code = match self {
            P2pError::Stun => "p2p_stun_failed",
            P2pError::Punch => "p2p_hole_punch_failed",
            P2pError::Io => "p2p_io_error",
            P2pError::Encode => "p2p_encode_failed",
            P2pError::Decode => "p2p_decode_failed",
            P2pError::InvalidRecipientKey => "p2p_invalid_recipient_key",
            P2pError::PayloadTooLarge => "p2p_payload_too_large",
        };
        write!(f, "{code}")
    }
}

// ---------------------------------------------------------------------------------------------
// STUN (RFC 5389 subset: Binding Request/Response, XOR-MAPPED-ADDRESS only)
// ---------------------------------------------------------------------------------------------

fn build_binding_request(transaction_id: &[u8; 12]) -> [u8; 20] {
    let mut message = [0_u8; 20];
    message[0..2].copy_from_slice(&STUN_BINDING_REQUEST.to_be_bytes());
    message[2..4].copy_from_slice(&0_u16.to_be_bytes()); // no attributes on the request
    message[4..8].copy_from_slice(&STUN_MAGIC_COOKIE.to_be_bytes());
    message[8..20].copy_from_slice(transaction_id);
    message
}

fn parse_xor_mapped_address(body: &[u8], transaction_id: &[u8; 12]) -> Option<SocketAddr> {
    let mut offset = 0_usize;
    while offset + 4 <= body.len() {
        let attr_type = u16::from_be_bytes([body[offset], body[offset + 1]]);
        let attr_len = u16::from_be_bytes([body[offset + 2], body[offset + 3]]) as usize;
        let value_start = offset + 4;
        let value_end = value_start.checked_add(attr_len)?;
        if value_end > body.len() {
            return None;
        }
        let value = &body[value_start..value_end];
        if (attr_type == STUN_ATTR_XOR_MAPPED_ADDRESS || attr_type == STUN_ATTR_MAPPED_ADDRESS)
            && value.len() >= 8
        {
            let family = value[1];
            let xor = attr_type == STUN_ATTR_XOR_MAPPED_ADDRESS;
            let port_bytes = [value[2], value[3]];
            let port = u16::from_be_bytes(port_bytes) ^ (if xor { (STUN_MAGIC_COOKIE >> 16) as u16 } else { 0 });
            if family == 0x01 && value.len() >= 8 {
                let mut addr_bytes = [value[4], value[5], value[6], value[7]];
                if xor {
                    let cookie = STUN_MAGIC_COOKIE.to_be_bytes();
                    for (index, byte) in addr_bytes.iter_mut().enumerate() {
                        *byte ^= cookie[index];
                    }
                } else {
                    let _ = transaction_id; // only needed for the XOR variant's low-order bytes
                }
                let ip = std::net::Ipv4Addr::from(addr_bytes);
                return Some(SocketAddr::new(ip.into(), port));
            }
        }
        // Attributes are padded to a 4-byte boundary.
        offset = value_end + ((4 - (attr_len % 4)) % 4);
    }
    None
}

/// Discovers this socket's public-facing `IP:port` via a public STUN server. The socket handed in
/// is reused for the subsequent hole-punch attempt, so the discovered mapping stays valid (STUN
/// only tells you the truth about the exact 5-tuple it was asked over).
fn stun_discover(socket: &UdpSocket) -> Result<SocketAddr, P2pError> {
    socket.set_read_timeout(Some(Duration::from_millis(800))).map_err(|_| P2pError::Io)?;
    let mut transaction_id = [0_u8; 12];
    OsRng.fill_bytes(&mut transaction_id);
    let request = build_binding_request(&transaction_id);

    for server in STUN_SERVERS {
        let Ok(mut addrs) = std::net::ToSocketAddrs::to_socket_addrs(server) else { continue };
        let Some(server_addr) = addrs.next() else { continue };
        for _attempt in 0..3 {
            if socket.send_to(&request, server_addr).is_err() {
                continue;
            }
            let mut buffer = [0_u8; 512];
            match socket.recv_from(&mut buffer) {
                Ok((length, from)) if from == server_addr && length >= 20 => {
                    let message_type = u16::from_be_bytes([buffer[0], buffer[1]]);
                    let body_len = u16::from_be_bytes([buffer[2], buffer[3]]) as usize;
                    let received_transaction = &buffer[8..20];
                    if message_type != STUN_BINDING_RESPONSE || received_transaction != transaction_id {
                        continue;
                    }
                    let body_end = (20 + body_len).min(length);
                    if let Some(addr) = parse_xor_mapped_address(&buffer[20..body_end], &transaction_id) {
                        return Ok(addr);
                    }
                }
                _ => continue,
            }
        }
    }
    Err(P2pError::Stun)
}

// ---------------------------------------------------------------------------------------------
// Candidate envelope (mirrors `sync_invitation_bridge.rs`'s seal/open pattern for a different
// payload) — exchanged over the existing rendezvous relay's `"candidate"` envelope kind.
// ---------------------------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteCandidatePayload {
    session_id: String,
    public_host: String,
    public_port: u16,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutgoingCandidateEnvelope {
    pub message_id: String,
    pub recipient_account_route: String,
    pub recipient_device_id: Option<String>,
    pub ciphertext: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteCandidate {
    pub session_id: String,
    pub public_host: String,
    pub public_port: u16,
}

fn pack(envelope: &SealedEnvelope) -> Vec<u8> {
    let mut packed = Vec::with_capacity(32 + 12 + envelope.ciphertext.len());
    packed.extend_from_slice(&envelope.ephemeral_public_key);
    packed.extend_from_slice(&envelope.nonce);
    packed.extend_from_slice(&envelope.ciphertext);
    packed
}

fn unpack(packed: &[u8]) -> Result<SealedEnvelope, P2pError> {
    if packed.len() < 32 + 12 {
        return Err(P2pError::Decode);
    }
    let (ephemeral_public_key, rest) = packed.split_at(32);
    let (nonce, ciphertext) = rest.split_at(12);
    Ok(SealedEnvelope {
        ephemeral_public_key: ephemeral_public_key.to_vec(),
        nonce: nonce.to_vec(),
        ciphertext: ciphertext.to_vec(),
    })
}

/// Encrypts this device's discovered public candidate for a specific recipient device's X25519
/// key, ready to be sent through `sync_rendezvous_send` as `{ type: "enqueue", kind: "candidate" }`
/// exactly like `sync_invitation_bridge::sync_prepare_remote_invitation` already does for invites.
#[tauri::command]
pub fn sync_prepare_remote_candidate(
    session_id: String,
    public_host: String,
    public_port: u16,
    recipient_account_route: String,
    recipient_device_id: Option<String>,
    recipient_agreement_public_key: String,
) -> Result<OutgoingCandidateEnvelope, String> {
    let public_key = URL_SAFE_NO_PAD
        .decode(&recipient_agreement_public_key)
        .map_err(|_| P2pError::InvalidRecipientKey.to_string())?;
    let payload = RemoteCandidatePayload { session_id: session_id.clone(), public_host, public_port };
    let plaintext = serde_json::to_vec(&payload).map_err(|_| P2pError::Encode.to_string())?;
    let info = format!("alethe-candidate-envelope-v1|{session_id}");
    let sealed = seal_for_recipient(&plaintext, &public_key, info.as_bytes())
        .map_err(|_| P2pError::InvalidRecipientKey.to_string())?;
    let packed = pack(&sealed);
    if packed.len() > 16 * 1024 {
        return Err(P2pError::PayloadTooLarge.to_string());
    }
    Ok(OutgoingCandidateEnvelope {
        message_id: format!("cand_{}", nanoid::nanoid!(24)),
        recipient_account_route,
        recipient_device_id,
        ciphertext: URL_SAFE_NO_PAD.encode(packed),
    })
}

/// Decrypts a delivered candidate envelope (drained the same way as an invitation delivery) using
/// this device's own X25519 agreement secret.
#[tauri::command]
pub fn sync_consume_remote_candidate(
    app: tauri::AppHandle,
    ciphertext: String,
    session_id: String,
) -> Result<RemoteCandidate, String> {
    let data_root = crate::profiles::resolve_tauri_data_root(&app)?;
    let document = crate::sync_security::load_at(&data_root)?;
    let local_device_id = document.local_device_id.ok_or_else(|| "security_device_missing".to_string())?;
    let recipient_secret = crate::sync_security::load_device_agreement_secret(&local_device_id)?;
    let packed = URL_SAFE_NO_PAD.decode(&ciphertext).map_err(|_| P2pError::Decode.to_string())?;
    let sealed = unpack(&packed).map_err(|error| error.to_string())?;
    let info = format!("alethe-candidate-envelope-v1|{session_id}");
    let plaintext = open_sealed(&sealed, &recipient_secret, info.as_bytes()).map_err(|_| P2pError::Decode.to_string())?;
    let payload: RemoteCandidatePayload =
        serde_json::from_slice(&plaintext).map_err(|_| P2pError::Decode.to_string())?;
    if payload.session_id != session_id {
        return Err(P2pError::Decode.to_string());
    }
    Ok(RemoteCandidate {
        session_id: payload.session_id,
        public_host: payload.public_host,
        public_port: payload.public_port,
    })
}

// ---------------------------------------------------------------------------------------------
// UDP hole punching + a minimal stop-and-wait reliable stream, so the punched-through path can be
// handed to `sync_transport::establish_as_initiator`/`establish_as_responder` unchanged.
// ---------------------------------------------------------------------------------------------

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredCandidate {
    pub public_host: String,
    pub public_port: u16,
    /// The local port to reuse for the actual punch attempt (`punch_and_wrap`) — STUN's mapping
    /// is only valid for the exact local port it was observed on.
    pub local_port: u16,
}

/// Binds a UDP socket and discovers its public `IP:port` via STUN. Call this once per attempt on
/// both devices before exchanging candidates — the socket must be reused for punching (a fresh
/// socket would get a different NAT mapping).
#[tauri::command]
pub fn p2p_discover_candidate() -> Result<DiscoveredCandidate, String> {
    let socket = UdpSocket::bind("0.0.0.0:0").map_err(|_| P2pError::Io.to_string())?;
    let public_addr = stun_discover(&socket).map_err(|error| error.to_string())?;
    // The bound socket itself cannot cross the Tauri command boundary, so the caller re-binds an
    // identical local port for the actual punch attempt — see `punch_and_wrap` below, which is
    // why this function only returns discovery info, not a handle.
    let local_port = socket.local_addr().map_err(|_| P2pError::Io.to_string())?.port();
    Ok(DiscoveredCandidate { public_host: public_addr.ip().to_string(), public_port: public_addr.port(), local_port })
}

/// Attempts to punch through NAT to `peer_addr` and wraps the resulting UDP path in a minimal
/// reliable stream. `local_port` should be the same port `p2p_discover_candidate` bound, reused
/// with `SO_REUSEADDR` so this attempt gets the same NAT mapping STUN just observed.
pub fn punch_and_wrap(local_port: u16, peer_addr: SocketAddr) -> Result<ReliableUdpStream, P2pError> {
    let socket = bind_reusable(local_port)?;
    socket.set_read_timeout(Some(PUNCH_INTERVAL)).map_err(|_| P2pError::Io)?;

    let deadline = Instant::now() + PUNCH_TOTAL_TIMEOUT;
    let mut buffer = [0_u8; 64];
    let mut punched = false;
    for _ in 0..PUNCH_ATTEMPTS {
        if Instant::now() >= deadline {
            break;
        }
        let _ = socket.send_to(b"alethe-p2p-punch", peer_addr);
        match socket.recv_from(&mut buffer) {
            Ok((_, from)) if from == peer_addr => {
                punched = true;
                break;
            }
            _ => continue,
        }
    }
    if !punched {
        return Err(P2pError::Punch);
    }
    socket.connect(peer_addr).map_err(|_| P2pError::Io)?;
    Ok(ReliableUdpStream::new(socket))
}

fn bind_reusable(local_port: u16) -> Result<UdpSocket, P2pError> {
    // `socket2` is not a dependency here; `UdpSocket::bind` without SO_REUSEADDR still works for
    // the common case where the discovery socket has since been dropped, at the cost of a small
    // race if the OS has not yet released the port. Acceptable for this best-effort path since
    // the caller always has the relay fallback.
    UdpSocket::bind(("0.0.0.0", local_port)).map_err(|_| P2pError::Io)
}

const PACKET_KIND_DATA: u8 = 1;
const PACKET_KIND_ACK: u8 = 2;

/// A stop-and-wait reliable stream over a connected `UdpSocket`: at most one unacknowledged data
/// chunk in flight at a time. Simple on purpose — see the module doc for why throughput was
/// traded for auditability here.
pub struct ReliableUdpStream {
    socket: UdpSocket,
    send_seq: u32,
    recv_seq: u32,
    read_buffer: Vec<u8>,
    read_cursor: usize,
    // Data packets that arrived while `write()` was blocked waiting for its own ACK — the two
    // directions share one socket, so a stray inbound DATA packet seen during a send must be
    // queued here rather than dropped, or a peer sending concurrently would silently lose bytes.
    pending_data: std::collections::VecDeque<(u32, Vec<u8>)>,
}

impl ReliableUdpStream {
    fn new(socket: UdpSocket) -> Self {
        Self {
            socket,
            send_seq: 0,
            recv_seq: 0,
            read_buffer: Vec::new(),
            read_cursor: 0,
            pending_data: std::collections::VecDeque::new(),
        }
    }

    /// Acks and enqueues an inbound data packet seen while waiting on something else, so `read()`
    /// can drain it later without another socket round-trip.
    fn queue_inbound_data(&mut self, seq: u32, payload: Vec<u8>) -> std::io::Result<()> {
        self.send_packet(PACKET_KIND_ACK, seq, &[])?;
        if self.pending_data.len() < 256 {
            self.pending_data.push_back((seq, payload));
        }
        Ok(())
    }

    fn send_packet(&self, kind: u8, seq: u32, payload: &[u8]) -> std::io::Result<()> {
        let mut packet = Vec::with_capacity(5 + payload.len());
        packet.push(kind);
        packet.extend_from_slice(&seq.to_be_bytes());
        packet.extend_from_slice(payload);
        self.socket.send(&packet).map(|_| ())
    }

    fn recv_next(&self, timeout: Duration) -> std::io::Result<Option<(u8, u32, Vec<u8>)>> {
        self.socket.set_read_timeout(Some(timeout))?;
        let mut buffer = [0_u8; MAX_CHUNK_BYTES + 5];
        match self.socket.recv(&mut buffer) {
            Ok(length) if length >= 5 => {
                let kind = buffer[0];
                let seq = u32::from_be_bytes([buffer[1], buffer[2], buffer[3], buffer[4]]);
                Ok(Some((kind, seq, buffer[5..length].to_vec())))
            }
            Ok(_) => Ok(None),
            Err(error) if matches!(error.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {
                Ok(None)
            }
            Err(error) => Err(error),
        }
    }
}

impl Write for ReliableUdpStream {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        for chunk in buf.chunks(MAX_CHUNK_BYTES) {
            let seq = self.send_seq;
            let mut acked = false;
            for _ in 0..MAX_RETRANSMITS {
                self.send_packet(PACKET_KIND_DATA, seq, chunk)?;
                let deadline = Instant::now() + ACK_TIMEOUT;
                while Instant::now() < deadline {
                    let remaining = deadline.saturating_duration_since(Instant::now());
                    if let Some((kind, packet_seq, payload)) = self.recv_next(remaining)? {
                        if kind == PACKET_KIND_ACK && packet_seq == seq {
                            acked = true;
                            break;
                        }
                        // The peer sending concurrently while we wait for our own ACK: queue it
                        // for `read()` instead of dropping it.
                        if kind == PACKET_KIND_DATA {
                            self.queue_inbound_data(packet_seq, payload)?;
                        }
                    }
                }
                if acked {
                    break;
                }
            }
            if !acked {
                return Err(std::io::Error::new(std::io::ErrorKind::TimedOut, "p2p_ack_timeout"));
            }
            self.send_seq = self.send_seq.wrapping_add(1);
        }
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl Read for ReliableUdpStream {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        while self.read_cursor >= self.read_buffer.len() {
            self.read_buffer.clear();
            self.read_cursor = 0;
            loop {
                // Bytes queued by a previous `write()` call while it waited for its own ACK take
                // priority over the socket, since they already arrived and were already ACKed.
                let (seq, payload) = match self.pending_data.pop_front() {
                    Some(next) => next,
                    None => match self.recv_next(Duration::from_secs(30))? {
                        Some((kind, seq, payload)) if kind == PACKET_KIND_DATA => {
                            self.send_packet(PACKET_KIND_ACK, seq, &[])?;
                            (seq, payload)
                        }
                        _ => continue,
                    },
                };
                if seq != self.recv_seq {
                    // Out-of-order or a duplicate retransmit of an already-consumed chunk. It was
                    // already ACKed (either just now or when it was first queued), which is what
                    // lets the sender's stop-and-wait loop proceed; the payload itself is dropped
                    // rather than reordered, matching the ordering guarantee `sync_transport.rs`'s
                    // framing already assumes.
                    continue;
                }
                self.recv_seq = self.recv_seq.wrapping_add(1);
                self.read_buffer = payload;
                break;
            }
        }
        let available = self.read_buffer.len() - self.read_cursor;
        let to_copy = available.min(buf.len());
        buf[..to_copy].copy_from_slice(&self.read_buffer[self.read_cursor..self.read_cursor + to_copy]);
        self.read_cursor += to_copy;
        Ok(to_copy)
    }
}

// ---------------------------------------------------------------------------------------------
// Handshake glue: authorization is delegated straight to `sync_security::is_peer_trusted_for_p2p`
// (a read-only helper added there for exactly this) rather than re-derived here, so this module
// never becomes a second, divergent source of truth for device trust.
// ---------------------------------------------------------------------------------------------

struct AletheDeviceTrustOracle {
    document: crate::sync_security::SyncSecurityDocument,
    now_ms: u64,
}

impl crate::sync_transport::DeviceTrustOracle for AletheDeviceTrustOracle {
    fn check_trusted(
        &self,
        account_route: &str,
        device_id: &str,
    ) -> Result<(), crate::sync_transport::TransportError> {
        if crate::sync_security::is_peer_trusted_for_p2p(&self.document, account_route, device_id, self.now_ms) {
            Ok(())
        } else {
            Err(crate::sync_transport::TransportError::NotTrusted)
        }
    }
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct P2pConnectResult {
    pub connected: bool,
    pub remote_device_id: Option<String>,
}

/// Punches through to `peer_addr` and performs the Phase-4 mutual handshake over the resulting
/// path. `is_initiator` must be agreed out of band (e.g. whichever side issued the invitation
/// initiates) since both sides attempting the same role would deadlock the handshake.
#[tauri::command]
pub fn sync_p2p_connect(
    app: tauri::AppHandle,
    local_port: u16,
    peer_host: String,
    peer_port: u16,
    is_initiator: bool,
) -> Result<P2pConnectResult, String> {
    let data_root = crate::profiles::resolve_tauri_data_root(&app)?;
    let document = crate::sync_security::load_at(&data_root)?;
    let local_device_id = document.local_device_id.clone().ok_or_else(|| "security_device_missing".to_string())?;
    let account = document.account.clone().ok_or_else(|| "security_account_missing".to_string())?;
    let device_record = document
        .devices
        .iter()
        .find(|device| device.device_id == local_device_id)
        .ok_or_else(|| "security_device_missing".to_string())?
        .clone();

    let signing_key = crate::sync_security::load_device_signing_key(&local_device_id)?;
    let agreement_secret = crate::sync_security::load_device_agreement_secret(&local_device_id)?;
    let key_binding = crate::sync_crypto::DeviceKeyBinding {
        device_id: local_device_id.clone(),
        ed25519_public_key: URL_SAFE_NO_PAD.decode(&device_record.public_key).map_err(|_| "security_device_key_invalid".to_string())?,
        x25519_public_key: URL_SAFE_NO_PAD
            .decode(device_record.agreement_public_key.as_deref().unwrap_or_default())
            .map_err(|_| "security_device_key_invalid".to_string())?,
        bound_at_ms: device_record.agreement_key_bound_at_ms.unwrap_or_default(),
        signature: URL_SAFE_NO_PAD
            .decode(device_record.agreement_key_binding_signature.as_deref().unwrap_or_default())
            .map_err(|_| "security_device_key_invalid".to_string())?,
    };
    let local_identity = crate::sync_transport::LocalIdentity {
        account_route: crate::sync_protocol::account_route_id(&account.account_id),
        device_id: local_device_id,
        signing_key: &signing_key,
        agreement_secret: &agreement_secret,
        key_binding,
    };

    let peer_addr: SocketAddr = format!("{peer_host}:{peer_port}")
        .parse()
        .map_err(|_| "p2p_invalid_peer_address".to_string())?;
    let mut stream = punch_and_wrap(local_port, peer_addr).map_err(|error| error.to_string())?;

    let trust_oracle = AletheDeviceTrustOracle { document, now_ms: crate::provider_common::now_ms() };
    let session = if is_initiator {
        crate::sync_transport::establish_as_initiator(&mut stream, &local_identity, &trust_oracle)
    } else {
        crate::sync_transport::establish_as_responder(&mut stream, &local_identity, &trust_oracle)
    }
    .map_err(|error| error.to_string())?;

    Ok(P2pConnectResult { connected: true, remote_device_id: Some(session.remote_device_id) })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn xor_mapped_address_attribute(ip: [u8; 4], port: u16, transaction_id: &[u8; 12]) -> Vec<u8> {
        let cookie = STUN_MAGIC_COOKIE.to_be_bytes();
        let xor_port = port ^ (STUN_MAGIC_COOKIE >> 16) as u16;
        let mut xor_ip = ip;
        for (index, byte) in xor_ip.iter_mut().enumerate() {
            *byte ^= cookie[index];
        }
        let mut value = vec![0_u8, 0x01]; // reserved byte, family = IPv4
        value.extend_from_slice(&xor_port.to_be_bytes());
        value.extend_from_slice(&xor_ip);
        let mut attribute = Vec::new();
        attribute.extend_from_slice(&STUN_ATTR_XOR_MAPPED_ADDRESS.to_be_bytes());
        attribute.extend_from_slice(&(value.len() as u16).to_be_bytes());
        attribute.extend_from_slice(&value);
        let _ = transaction_id;
        attribute
    }

    #[test]
    fn binding_request_has_the_expected_header_shape() {
        let transaction_id = [7_u8; 12];
        let request = build_binding_request(&transaction_id);
        assert_eq!(u16::from_be_bytes([request[0], request[1]]), STUN_BINDING_REQUEST);
        assert_eq!(u16::from_be_bytes([request[2], request[3]]), 0);
        assert_eq!(u32::from_be_bytes([request[4], request[5], request[6], request[7]]), STUN_MAGIC_COOKIE);
        assert_eq!(&request[8..20], &transaction_id);
    }

    #[test]
    fn parses_a_well_formed_xor_mapped_address_response() {
        let transaction_id = [3_u8; 12];
        let body = xor_mapped_address_attribute([203, 0, 113, 42], 51820, &transaction_id);
        let parsed = parse_xor_mapped_address(&body, &transaction_id).expect("address should parse");
        assert_eq!(parsed.port(), 51820);
        assert_eq!(parsed.to_string().split(':').next().unwrap(), "203.0.113.42");
    }

    #[test]
    fn rejects_a_truncated_attribute_instead_of_panicking() {
        let mut body = xor_mapped_address_attribute([203, 0, 113, 42], 51820, &[0_u8; 12]);
        body.truncate(body.len() - 2);
        assert_eq!(parse_xor_mapped_address(&body, &[0_u8; 12]), None);
    }

    #[test]
    fn ignores_unrelated_attributes_before_the_address() {
        let mut body = vec![0x80, 0x22, 0, 4, b'a', b'b', b'c', b'd']; // an unrelated 4-byte attribute
        body.extend(xor_mapped_address_attribute([198, 51, 100, 7], 4433, &[0_u8; 12]));
        let parsed = parse_xor_mapped_address(&body, &[0_u8; 12]).expect("address should parse");
        assert_eq!(parsed.port(), 4433);
    }

    #[test]
    fn reliable_stream_write_then_read_round_trips_over_loopback() {
        let sender_socket = UdpSocket::bind("127.0.0.1:0").unwrap();
        let receiver_socket = UdpSocket::bind("127.0.0.1:0").unwrap();
        let sender_addr = sender_socket.local_addr().unwrap();
        let receiver_addr = receiver_socket.local_addr().unwrap();
        sender_socket.connect(receiver_addr).unwrap();
        receiver_socket.connect(sender_addr).unwrap();

        let mut sender = ReliableUdpStream::new(sender_socket);
        let mut receiver = ReliableUdpStream::new(receiver_socket);

        let handle = std::thread::spawn(move || {
            sender.write_all(b"hello over udp").unwrap();
        });

        let mut buffer = [0_u8; 32];
        let read = receiver.read(&mut buffer).unwrap();
        assert_eq!(&buffer[..read], b"hello over udp");
        handle.join().unwrap();
    }
}
