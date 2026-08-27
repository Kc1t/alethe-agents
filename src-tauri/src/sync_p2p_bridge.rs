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
use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::net::{SocketAddr, UdpSocket};
use std::sync::mpsc as std_mpsc;
use std::sync::{Arc, Mutex};
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
/// Deliberately generous: the peer may still be finishing its own punch loop when this side starts
/// the handshake, and it cannot answer until it gets there. At 400ms per try this tolerates roughly
/// eight seconds of that skew — matching the punch budget — instead of failing the whole connection
/// with `transport_io_error` while the other side was about to be ready (observed live).
const MAX_RETRANSMITS: u32 = 20;
/// Datagrams sent to the peer right after this side's punch succeeds, so the peer — which only
/// completes when it *receives* one — is very unlikely to be left punching into silence. See the
/// call site for the full failure this prevents.
const PUNCH_CONFIRM_BURST: u32 = 20;
/// Hard ceiling on a single `Read::read` — a peer that disappears mid-handshake must surface as a
/// timeout error rather than blocking the caller forever (see `read`'s own comment).
const READ_TOTAL_TIMEOUT: Duration = Duration::from_secs(30);
/// How long each individual socket poll inside that budget waits, so the deadline above is checked
/// regularly instead of only after one long blocking wait.
const RECV_POLL_TIMEOUT: Duration = Duration::from_secs(1);
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
    /// This device's local (LAN-interface) address. When both peers are behind the same router
    /// (common case: two people testing on the same home/office network), the STUN-derived
    /// public candidate above cannot be punched to at all — most consumer routers do not support
    /// NAT hairpinning/loopback, so a device cannot reach its own public IP from inside the LAN.
    /// Trying this local candidate first lets same-LAN pairs connect near-instantly without any
    /// NAT traversal. Carries its own port (`local_port`), NOT `public_port` — the router almost
    /// always rewrites the port too, so the socket's local LAN port and its STUN-mapped public
    /// port are two different numbers; sending the wrong one here just gets "connection reset"
    /// from nothing listening on that port on the peer's LAN address.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    local_host: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    local_port: Option<u16>,
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
    /// See `RemoteCandidatePayload::local_host`/`local_port`.
    pub local_host: Option<String>,
    pub local_port: Option<u16>,
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
    local_host: Option<String>,
    local_port: Option<u16>,
    recipient_account_route: String,
    recipient_device_id: Option<String>,
    recipient_agreement_public_key: String,
) -> Result<OutgoingCandidateEnvelope, String> {
    let public_key = URL_SAFE_NO_PAD
        .decode(&recipient_agreement_public_key)
        .map_err(|_| P2pError::InvalidRecipientKey.to_string())?;
    let payload =
        RemoteCandidatePayload { session_id: session_id.clone(), public_host, public_port, local_host, local_port };
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
        local_host: payload.local_host,
        local_port: payload.local_port,
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
    /// The local port to reuse for the actual punch attempt (`punch_and_wrap_candidates`) — STUN's mapping
    /// is only valid for the exact local port it was observed on.
    pub local_port: u16,
    /// This device's LAN-facing IP address (the source address the OS would use to reach the
    /// public internet), best-effort — `None` if it could not be determined. See
    /// `RemoteCandidatePayload::local_host` for why this matters.
    pub local_host: Option<String>,
}

/// Best-effort local (LAN) IP discovery: opens a UDP socket and "connects" it (no packet is
/// actually sent for UDP) to a public address, then reads back which local interface address the
/// OS picked as the route — the standard portable trick for this, works even without real
/// internet connectivity since UDP connect never sends anything.
fn detect_local_ip() -> Option<String> {
    let probe = UdpSocket::bind("0.0.0.0:0").ok()?;
    probe.connect("8.8.8.8:80").ok()?;
    probe.local_addr().ok().map(|addr| addr.ip().to_string())
}

/// Binds a UDP socket and discovers its public `IP:port` via STUN. Call this once per attempt on
/// both devices before exchanging candidates — the socket must be reused for punching (a fresh
/// socket would get a different NAT mapping).
/// Off the UI thread for the same reason as `sync_p2p_connect` — STUN resolution blocks on network
/// round-trips (and its own retry/timeout budget) and would otherwise freeze the app window.
#[tauri::command]
pub async fn p2p_discover_candidate() -> Result<DiscoveredCandidate, String> {
    tokio::task::spawn_blocking(discover_candidate_blocking)
        .await
        .map_err(|_| "p2p_discover_task_failed".to_string())?
}

fn discover_candidate_blocking() -> Result<DiscoveredCandidate, String> {
    let socket = match UdpSocket::bind("0.0.0.0:0") {
        Ok(socket) => socket,
        Err(cause) => {
            eprintln!("[p2p] discover: failed to bind local UDP socket: {cause}");
            return Err(P2pError::Io.to_string());
        }
    };
    let public_addr = match stun_discover(&socket) {
        Ok(addr) => addr,
        Err(cause) => {
            eprintln!("[p2p] discover: STUN resolution failed: {cause}");
            return Err(cause.to_string());
        }
    };
    // The bound socket itself cannot cross the Tauri command boundary, so the caller re-binds an
    // identical local port for the actual punch attempt — see `punch_and_wrap_candidates` below, which is
    // why this function only returns discovery info, not a handle.
    let local_port = socket.local_addr().map_err(|_| P2pError::Io.to_string())?.port();
    let local_host = detect_local_ip();
    eprintln!(
        "[p2p] discover: local_port={local_port} public={}:{} local_host={:?}",
        public_addr.ip(),
        public_addr.port(),
        local_host
    );
    Ok(DiscoveredCandidate {
        public_host: public_addr.ip().to_string(),
        public_port: public_addr.port(),
        local_port,
        local_host,
    })
}

/// Attempts to punch through NAT to `peer_addr` and wraps the resulting UDP path in a minimal
/// reliable stream. `local_port` should be the same port `p2p_discover_candidate` bound, reused
/// with `SO_REUSEADDR` so this attempt gets the same NAT mapping STUN just observed.
/// Punches toward every candidate at once (round-robin, one datagram per candidate per round) for
/// the whole budget, and accepts a reply from *any* of them — whichever answers first wins.
///
/// Two properties here are what actually make this work in practice, both learned from live
/// failures:
///
/// 1. **Accept from any known candidate, not just the one currently being targeted.** Hole punching
///    only succeeds when both sides happen to be sending during the same window, and the two sides
///    run their own unsynchronized retry loops — so the peer's reply routinely arrives via a
///    different candidate than the one this side is mid-send to. The previous sequential version
///    logged exactly that and threw the reply away ("received packet from unexpected source ...
///    ignoring"), discarding a perfectly good connection.
/// 2. **Interleave candidates instead of draining one before starting the next.** Spending the
///    first half of the budget on only the LAN candidate and the second half on only the public one
///    means two peers sitting in opposite phases never overlap at all.
///
/// The candidate order still matters as a preference hint (LAN first — instant, no NAT traversal,
/// and the only thing that can ever work for two peers behind the same router, see
/// `RemoteCandidatePayload::local_host`), but no candidate is ever starved of the budget.
pub fn punch_and_wrap_candidates(local_port: u16, candidates: &[SocketAddr]) -> Result<ReliableUdpStream, P2pError> {
    if candidates.is_empty() {
        return Err(P2pError::Punch);
    }
    eprintln!(
        "[p2p] punch: attempting local_port={local_port} candidates={candidates:?} rounds={PUNCH_ATTEMPTS} total_timeout={PUNCH_TOTAL_TIMEOUT:?}"
    );
    let socket = match bind_reusable(local_port) {
        Ok(socket) => socket,
        Err(cause) => {
            eprintln!("[p2p] punch: failed to rebind local_port={local_port}: {cause}");
            return Err(cause);
        }
    };
    socket.set_read_timeout(Some(PUNCH_INTERVAL)).map_err(|_| P2pError::Io)?;

    let overall_deadline = Instant::now() + PUNCH_TOTAL_TIMEOUT;
    let mut buffer = [0_u8; 64];
    let mut rounds = 0_u32;
    let mut last_recv_error: Option<String> = None;

    while Instant::now() < overall_deadline {
        rounds += 1;
        for peer_addr in candidates {
            if let Err(cause) = socket.send_to(b"alethe-p2p-punch", peer_addr) {
                eprintln!("[p2p] punch: send_to {peer_addr} failed on round {rounds}: {cause}");
            }
        }
        // One bounded read per round — a reply from *any* candidate completes the punch.
        match socket.recv_from(&mut buffer) {
            Ok((_, from)) if candidates.contains(&from) => {
                eprintln!("[p2p] punch: SUCCESS candidate={from} after {rounds} round(s)");
                // Keep answering for a moment before moving on. Punching is symmetric: this side
                // succeeds as soon as it *receives* a datagram, but the peer only succeeds when it
                // receives one of ours. Returning immediately stopped our transmissions the instant
                // we were satisfied, so a peer that hadn't received anything yet kept punching into
                // silence and eventually gave up — while this side, already past the punch, tried
                // to speak the handshake protocol to someone still punching, and failed with
                // `transport_io_error`. Observed live from both machines at once: one side logging
                // SUCCESS, the other logging only failures. This burst makes it overwhelmingly
                // likely the peer also completes, so both sides enter the handshake together.
                for _ in 0..PUNCH_CONFIRM_BURST {
                    let _ = socket.send_to(b"alethe-p2p-punch", from);
                }
                socket.connect(from).map_err(|_| P2pError::Io)?;
                return Ok(ReliableUdpStream::new(socket));
            }
            Ok((_, from)) => {
                eprintln!("[p2p] punch: ignoring packet from {from} (not one of this session's candidates)");
            }
            Err(cause) => {
                last_recv_error = Some(cause.to_string());
            }
        }
    }
    eprintln!(
        "[p2p] punch: all {} candidate(s) FAILED after {rounds} round(s), last_recv_error={:?} — falling back to relay",
        candidates.len(),
        last_recv_error
    );
    Err(P2pError::Punch)
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

    /// Non-blocking-ish poll for exactly one complete application frame, bounded by `timeout`
    /// instead of `Read::read`'s internal 30s wait — used by the background session reader
    /// (`P2pSessionHandle`) so it can interleave polling for outgoing frames to send without
    /// getting stuck inside a long blocking read. Shares the same ACK/dedup/ordering logic as
    /// `Read::read` (via `pending_data`/`recv_seq`), just parameterized on the wait duration.
    fn poll_frame(&mut self, timeout: Duration) -> std::io::Result<Option<Vec<u8>>> {
        let (seq, payload) = match self.pending_data.pop_front() {
            Some(next) => next,
            None => match self.recv_next(timeout)? {
                Some((kind, seq, payload)) if kind == PACKET_KIND_DATA => {
                    self.send_packet(PACKET_KIND_ACK, seq, &[])?;
                    (seq, payload)
                }
                _ => return Ok(None),
            },
        };
        if seq != self.recv_seq {
            return Ok(None);
        }
        self.recv_seq = self.recv_seq.wrapping_add(1);
        Ok(Some(payload))
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
            // Bounds the whole wait, not just each individual socket poll. Without this the loop
            // below could spin forever: a poll that times out (or yields a non-DATA packet) hits
            // `continue`, which starts another full wait, with no exit condition at all — so a peer
            // that goes away mid-handshake left `read()` blocked permanently. That is exactly what
            // wedged a connection attempt in production: the punch succeeded, the Phase-4 handshake
            // then waited here forever, and the caller's "one attempt at a time" guard never
            // cleared, silently stopping every future reconnection attempt on that device.
            let deadline = Instant::now() + READ_TOTAL_TIMEOUT;
            loop {
                if Instant::now() >= deadline {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::TimedOut,
                        "p2p_stream_read_timeout",
                    ));
                }
                // Bytes queued by a previous `write()` call while it waited for its own ACK take
                // priority over the socket, since they already arrived and were already ACKed.
                let (seq, payload) = match self.pending_data.pop_front() {
                    Some(next) => next,
                    None => {
                        let remaining = deadline.saturating_duration_since(Instant::now());
                        match self.recv_next(remaining.min(RECV_POLL_TIMEOUT))? {
                            Some((kind, seq, payload)) if kind == PACKET_KIND_DATA => {
                                self.send_packet(PACKET_KIND_ACK, seq, &[])?;
                                (seq, payload)
                            }
                            _ => continue,
                        }
                    }
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
///
/// `remote_account_route` is not used for authorization (the handshake's trust oracle already
/// re-derives and checks that independently) — it is only the registry key so a later
/// `p2p_send_frame`/`p2p_drain_frames` call knows which live session to use. On success the
/// session is registered and kept alive by a background reader thread (see
/// `P2pSessionRegistry::register`) instead of being dropped when this function returns.
/// Runs entirely off the UI thread: a synchronous `#[tauri::command]` executes on Tauri's main
/// thread, and this one blocks for the whole punch budget plus the full Phase-4 handshake — which
/// froze the entire app window for seconds at a time whenever a connection was attempted
/// (reported live: "the app locked up the moment it connected").
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn sync_p2p_connect(
    app: tauri::AppHandle,
    registry: tauri::State<'_, Arc<P2pSessionRegistry>>,
    local_port: u16,
    peer_host: String,
    peer_port: u16,
    peer_local_host: Option<String>,
    peer_local_port: Option<u16>,
    is_initiator: bool,
    remote_account_route: String,
) -> Result<P2pConnectResult, String> {
    let registry = Arc::clone(&registry);
    tokio::task::spawn_blocking(move || {
        p2p_connect_blocking(
            app,
            registry,
            local_port,
            peer_host,
            peer_port,
            peer_local_host,
            peer_local_port,
            is_initiator,
            remote_account_route,
        )
    })
    .await
    .map_err(|_| "p2p_connect_task_failed".to_string())?
}

#[allow(clippy::too_many_arguments)]
fn p2p_connect_blocking(
    app: tauri::AppHandle,
    registry: Arc<P2pSessionRegistry>,
    local_port: u16,
    peer_host: String,
    peer_port: u16,
    peer_local_host: Option<String>,
    peer_local_port: Option<u16>,
    is_initiator: bool,
    remote_account_route: String,
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
    // Local (same-LAN) candidate first — when both peers are behind the same router, this is the
    // only address that can ever work (see `RemoteCandidatePayload::local_host`'s doc comment);
    // the public/STUN candidate is always tried too, as a fallback for peers on different networks.
    let mut candidates: Vec<SocketAddr> = Vec::with_capacity(2);
    if let (Some(local_host), Some(local_port)) = (peer_local_host.as_deref(), peer_local_port) {
        match format!("{local_host}:{local_port}").parse::<SocketAddr>() {
            Ok(local_addr) if local_addr != peer_addr => candidates.push(local_addr),
            Ok(_) => {}
            Err(cause) => eprintln!("[p2p] connect: peer_local_host {local_host:?} did not parse, skipping: {cause}"),
        }
    }
    candidates.push(peer_addr);
    eprintln!(
        "[p2p] connect: peer={remote_account_route} candidates={candidates:?} is_initiator={is_initiator}"
    );
    let mut stream = punch_and_wrap_candidates(local_port, &candidates).map_err(|error| {
        eprintln!("[p2p] connect: punch failed for peer={remote_account_route}: {error}");
        error.to_string()
    })?;

    let trust_oracle = AletheDeviceTrustOracle { document, now_ms: crate::provider_common::now_ms() };
    let session = if is_initiator {
        crate::sync_transport::establish_as_initiator(&mut stream, &local_identity, &trust_oracle)
    } else {
        crate::sync_transport::establish_as_responder(&mut stream, &local_identity, &trust_oracle)
    }
    .map_err(|error| {
        eprintln!("[p2p] connect: Phase-4 handshake failed for peer={remote_account_route} (punch succeeded): {error}");
        error.to_string()
    })?;

    eprintln!("[p2p] connect: SUCCESS peer={remote_account_route} remote_device_id={}", session.remote_device_id);
    registry.register(remote_account_route, stream);

    Ok(P2pConnectResult { connected: true, remote_device_id: Some(session.remote_device_id) })
}

/// Keeps a live, authenticated P2P session usable after the connecting Tauri command returns,
/// instead of dropping the socket the moment the handshake finishes. One background thread per
/// session owns the `ReliableUdpStream` exclusively (its stop-and-wait ARQ state cannot safely be
/// split across threads — see the struct's own doc comment), alternating between polling for
/// outgoing frames to send and polling the socket for inbound frames, so neither direction can
/// starve the other for more than `SESSION_POLL_INTERVAL`.
const SESSION_POLL_INTERVAL: Duration = Duration::from_millis(200);

pub enum P2pSessionState {
    Connected,
    Closed,
}

struct P2pSessionHandle {
    outgoing_tx: std_mpsc::Sender<Vec<u8>>,
    incoming: Arc<Mutex<VecDeque<Vec<u8>>>>,
    closed: Arc<std::sync::atomic::AtomicBool>,
}

#[derive(Default)]
pub struct P2pSessionRegistry {
    sessions: Mutex<HashMap<String, P2pSessionHandle>>,
}

impl P2pSessionRegistry {
    /// Replaces any prior session for this `remote_account_route` (a fresh successful connect
    /// always wins) and starts its background reader/writer thread.
    fn register(&self, remote_account_route: String, mut stream: ReliableUdpStream) {
        let (outgoing_tx, outgoing_rx) = std_mpsc::channel::<Vec<u8>>();
        let incoming = Arc::new(Mutex::new(VecDeque::new()));
        let closed = Arc::new(std::sync::atomic::AtomicBool::new(false));

        let thread_incoming = incoming.clone();
        let thread_closed = closed.clone();
        std::thread::spawn(move || loop {
            if thread_closed.load(std::sync::atomic::Ordering::Relaxed) {
                break;
            }
            match outgoing_rx.try_recv() {
                Ok(frame) => {
                    if stream.write_all(&frame).is_err() {
                        thread_closed.store(true, std::sync::atomic::Ordering::Relaxed);
                        break;
                    }
                    continue;
                }
                Err(std_mpsc::TryRecvError::Disconnected) => {
                    thread_closed.store(true, std::sync::atomic::Ordering::Relaxed);
                    break;
                }
                Err(std_mpsc::TryRecvError::Empty) => {}
            }
            match stream.poll_frame(SESSION_POLL_INTERVAL) {
                Ok(Some(frame)) => {
                    let mut queue = thread_incoming.lock().unwrap();
                    if queue.len() >= INCOMING_QUEUE_LIMIT {
                        queue.pop_front();
                    }
                    queue.push_back(frame);
                }
                Ok(None) => {}
                Err(_) => {
                    thread_closed.store(true, std::sync::atomic::Ordering::Relaxed);
                    break;
                }
            }
        });

        let handle = P2pSessionHandle { outgoing_tx, incoming, closed };
        self.sessions.lock().unwrap().insert(remote_account_route, handle);
    }

    fn send(&self, remote_account_route: &str, frame: Vec<u8>) -> Result<(), String> {
        let sessions = self.sessions.lock().unwrap();
        let handle = sessions.get(remote_account_route).ok_or_else(|| "p2p_session_not_found".to_string())?;
        if handle.closed.load(std::sync::atomic::Ordering::Relaxed) {
            return Err("p2p_session_closed".to_string());
        }
        handle.outgoing_tx.send(frame).map_err(|_| "p2p_session_closed".to_string())
    }

    fn drain(&self, remote_account_route: &str) -> Vec<Vec<u8>> {
        let sessions = self.sessions.lock().unwrap();
        match sessions.get(remote_account_route) {
            Some(handle) => handle.incoming.lock().unwrap().drain(..).collect(),
            None => Vec::new(),
        }
    }

    fn state(&self, remote_account_route: &str) -> P2pSessionState {
        let sessions = self.sessions.lock().unwrap();
        match sessions.get(remote_account_route) {
            Some(handle) if !handle.closed.load(std::sync::atomic::Ordering::Relaxed) => P2pSessionState::Connected,
            _ => P2pSessionState::Closed,
        }
    }
}

const INCOMING_QUEUE_LIMIT: usize = 256;

#[tauri::command]
pub fn p2p_send_frame(
    registry: tauri::State<'_, Arc<P2pSessionRegistry>>,
    remote_account_route: String,
    frame: Vec<u8>,
) -> Result<(), String> {
    registry.send(&remote_account_route, frame)
}

#[tauri::command]
pub fn p2p_drain_frames(
    registry: tauri::State<'_, Arc<P2pSessionRegistry>>,
    remote_account_route: String,
) -> Result<Vec<Vec<u8>>, String> {
    Ok(registry.drain(&remote_account_route))
}

#[tauri::command]
pub fn p2p_session_state(
    registry: tauri::State<'_, Arc<P2pSessionRegistry>>,
    remote_account_route: String,
) -> Result<&'static str, String> {
    Ok(match registry.state(&remote_account_route) {
        P2pSessionState::Connected => "connected",
        P2pSessionState::Closed => "closed",
    })
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

    fn loopback_pair() -> (ReliableUdpStream, ReliableUdpStream) {
        let a = UdpSocket::bind("127.0.0.1:0").unwrap();
        let b = UdpSocket::bind("127.0.0.1:0").unwrap();
        let a_addr = a.local_addr().unwrap();
        let b_addr = b.local_addr().unwrap();
        a.connect(b_addr).unwrap();
        b.connect(a_addr).unwrap();
        (ReliableUdpStream::new(a), ReliableUdpStream::new(b))
    }

    #[test]
    fn registered_session_delivers_frames_sent_via_send_to_the_other_sides_drain() {
        let (stream_a, stream_b) = loopback_pair();
        let registry_a = P2pSessionRegistry::default();
        let registry_b = P2pSessionRegistry::default();
        registry_a.register("route-b".to_string(), stream_a);
        registry_b.register("route-a".to_string(), stream_b);

        assert!(matches!(registry_a.state("route-b"), P2pSessionState::Connected));

        registry_a.send("route-b", b"hello from a".to_vec()).unwrap();

        let deadline = Instant::now() + Duration::from_secs(5);
        let mut received = Vec::new();
        while Instant::now() < deadline && received.is_empty() {
            received = registry_b.drain("route-a");
            if received.is_empty() {
                std::thread::sleep(Duration::from_millis(20));
            }
        }
        assert_eq!(received, vec![b"hello from a".to_vec()]);

        // Already drained — a second drain call finds nothing left.
        assert!(registry_b.drain("route-a").is_empty());
    }

    #[test]
    fn sending_to_an_unknown_route_fails_closed_instead_of_silently_dropping() {
        let registry = P2pSessionRegistry::default();
        let result = registry.send("route-never-connected", b"data".to_vec());
        assert_eq!(result, Err("p2p_session_not_found".to_string()));
        assert!(matches!(registry.state("route-never-connected"), P2pSessionState::Closed));
    }
}
