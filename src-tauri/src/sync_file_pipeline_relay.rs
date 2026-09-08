//! Carrying project transfers over the rendezvous relay when the direct path is unavailable.
//!
//! Chat has always had this: a message that cannot go peer-to-peer is sealed and enqueued on the
//! relay instead. Project transfer did not — `sync_file_pipeline_offer_project` ended at
//! `P2pSessionRegistry::send`, and if that returned `p2p_session_not_found` the offer simply did
//! not happen. Behind a symmetric NAT, which the P2P bridge's own comment acknowledges defeats this
//! technique the same way it defeats WebRTC and Tailscale, **sharing a project could not work at
//! all** — not slowly, not eventually: never.
//!
//! # Why fragmentation is the whole problem
//!
//! The relay rejects any frame over `MAX_FRAME_BYTES` (24 KiB), and a pipeline frame is far larger
//! than that. A chunk subframe is 150 KiB raw, and a `ManifestOffer` for a real project — thousands
//! of paths, each with its hashes — has no bound at all. So this is not "send the frame over the
//! relay instead"; it is a small transport of its own that cuts an opaque byte string into relay-
//! sized pieces and puts it back together on the other side.
//!
//! Reassembly is deliberately strict. A piece that arrives twice, out of order, or from a transfer
//! that was never opened is a protocol error, not something to paper over: the bytes it carries are
//! about to be handed to `sync_staging`, which will verify content hashes and reject the lot. It is
//! far better to fail here, where the reason is nameable, than to hand up a plausible-looking
//! buffer that fails an integrity check later with nothing explaining why.

use std::collections::HashMap;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde::{Deserialize, Serialize};

/// The relay's own ceiling on a WebSocket frame, mirrored from `sync_rendezvous.rs`.
const RELAY_MAX_FRAME_BYTES: usize = 24 * 1024;

/// Raw bytes per fragment.
///
/// The budget is not the frame size, and the difference is larger than it looks. A fragment is
/// base64'd into its own JSON (×4/3), sealed (+60 bytes), base64url-encoded again to travel inside
/// the enqueue frame (×4/3), and wrapped in that frame's JSON — about 1.8× the raw size by the time
/// the relay sees it. 12 KiB looked comfortable and left only 2 KiB of the 24 KiB frame spare;
/// 10 KiB leaves closer to 6 KiB, so a later field added to the envelope cannot silently push a
/// transfer over the edge. A fragment that overshoots is rejected outright, and one rejected
/// fragment stalls the whole transfer.
pub const RELAY_FRAGMENT_RAW_BYTES: usize = 10 * 1024;

/// One piece of a pipeline frame in transit over the relay.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayFragment {
    /// Groups the pieces of one pipeline frame. Two transfers to the same peer interleave freely.
    pub transfer_id: String,
    pub index: u32,
    pub total: u32,
    pub payload_b64: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RelayError {
    /// A fragment names a transfer whose pieces disagree about how many there are.
    TotalMismatch,
    /// A fragment arrived out of order, or twice.
    OutOfOrder,
    /// The payload is not valid base64.
    Decode,
    /// More bytes are buffered for one transfer than any legitimate frame could need.
    TooLarge,
}

impl RelayError {
    pub fn as_str(self) -> &'static str {
        match self {
            RelayError::TotalMismatch => "relay_fragment_total_mismatch",
            RelayError::OutOfOrder => "relay_fragment_out_of_order",
            RelayError::Decode => "relay_fragment_decode",
            RelayError::TooLarge => "relay_transfer_too_large",
        }
    }
}

impl std::fmt::Display for RelayError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// Ceiling on what one reassembling transfer may buffer, so a peer cannot make this allocate
/// without bound by sending fragments that never complete.
const MAX_TRANSFER_BYTES: usize = 32 * 1024 * 1024;

/// Cuts one pipeline frame into relay-sized fragments.
///
/// An empty frame still produces one fragment: "nothing" has to be distinguishable from "no
/// transfer", or the receiver waits forever for a piece that was never sent.
pub fn fragment(transfer_id: &str, frame: &[u8]) -> Vec<RelayFragment> {
    if frame.is_empty() {
        return vec![RelayFragment {
            transfer_id: transfer_id.to_string(),
            index: 0,
            total: 1,
            payload_b64: String::new(),
        }];
    }
    let pieces: Vec<&[u8]> = frame.chunks(RELAY_FRAGMENT_RAW_BYTES).collect();
    let total = pieces.len() as u32;
    pieces
        .into_iter()
        .enumerate()
        .map(|(index, piece)| RelayFragment {
            transfer_id: transfer_id.to_string(),
            index: index as u32,
            total,
            payload_b64: BASE64.encode(piece),
        })
        .collect()
}

/// Collects fragments until a frame is whole.
#[derive(Debug, Default)]
pub struct Reassembler {
    partial: HashMap<String, Partial>,
}

#[derive(Debug)]
struct Partial {
    total: u32,
    next_index: u32,
    buffer: Vec<u8>,
}

impl Reassembler {
    /// Accepts one fragment. Returns the completed frame when this was its last piece.
    pub fn accept(&mut self, fragment: &RelayFragment) -> Result<Option<Vec<u8>>, RelayError> {
        let piece = BASE64
            .decode(&fragment.payload_b64)
            .map_err(|_| RelayError::Decode)?;

        let entry = self
            .partial
            .entry(fragment.transfer_id.clone())
            .or_insert_with(|| Partial {
                total: fragment.total,
                next_index: 0,
                buffer: Vec::new(),
            });

        if entry.total != fragment.total {
            self.partial.remove(&fragment.transfer_id);
            return Err(RelayError::TotalMismatch);
        }
        // Strictly sequential. The relay preserves order per recipient, so anything else means a
        // lost or duplicated fragment — and silently accepting it would splice a corrupt buffer.
        if entry.next_index != fragment.index {
            self.partial.remove(&fragment.transfer_id);
            return Err(RelayError::OutOfOrder);
        }
        if entry.buffer.len() + piece.len() > MAX_TRANSFER_BYTES {
            self.partial.remove(&fragment.transfer_id);
            return Err(RelayError::TooLarge);
        }

        entry.buffer.extend_from_slice(&piece);
        entry.next_index += 1;

        if entry.next_index == entry.total {
            let done = self.partial.remove(&fragment.transfer_id).expect("just inserted");
            return Ok(Some(done.buffer));
        }
        Ok(None)
    }

    /// Transfers still waiting for pieces. Used to report a stalled transfer rather than let it sit.
    pub fn pending(&self) -> usize {
        self.partial.len()
    }

    /// Forgets a transfer that will never complete.
    pub fn abandon(&mut self, transfer_id: &str) {
        self.partial.remove(transfer_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn round_trip(bytes: &[u8]) -> Vec<u8> {
        let mut reassembler = Reassembler::default();
        let mut out = None;
        for piece in fragment("t1", bytes) {
            if let Some(done) = reassembler.accept(&piece).unwrap() {
                out = Some(done);
            }
        }
        assert_eq!(reassembler.pending(), 0, "nothing is left buffered");
        out.expect("the frame completed")
    }

    #[test]
    fn a_frame_survives_being_cut_up_and_put_back() {
        let bytes: Vec<u8> = (0..(RELAY_FRAGMENT_RAW_BYTES * 3 + 777))
            .map(|index| (index % 251) as u8)
            .collect();
        assert_eq!(round_trip(&bytes), bytes);
    }

    #[test]
    fn a_frame_smaller_than_one_fragment_still_round_trips() {
        assert_eq!(round_trip(b"manifest offer"), b"manifest offer");
    }

    #[test]
    fn an_empty_frame_produces_one_fragment_rather_than_none() {
        // "Nothing to send" has to be distinguishable from "no transfer started", or the receiver
        // waits forever for a piece that was never sent.
        let pieces = fragment("t1", b"");
        assert_eq!(pieces.len(), 1);
        assert_eq!(round_trip(b""), b"");
    }

    /// Bytes a fragment occupies in the frame the relay actually receives.
    ///
    /// The fragment's own JSON is only the first of four inflations. Measuring just that — which
    /// this test did at first — reports about 16 KiB for a payload that arrives as 22 KiB, and
    /// would have declared a size safe that the relay rejects.
    fn wire_size(piece: &RelayFragment) -> usize {
        let json = serde_json::to_vec(piece).unwrap().len();
        // Sealing prepends a 32-byte ephemeral key and a 12-byte nonce and appends a 16-byte tag.
        let sealed = json + 32 + 12 + 16;
        // The sealed blob travels base64url-encoded inside the enqueue frame's JSON.
        let encoded = sealed.div_ceil(3) * 4;
        // `type`, `id`, `kind`, `recipientAccountRoute`, `expiresAtMs` and the key names around the
        // ciphertext, generously rounded up.
        encoded + 320
    }

    #[test]
    fn every_fragment_fits_the_relay_frame_budget_as_it_arrives_on_the_wire() {
        // The ceiling this whole module exists to respect. A fragment that overshoots is rejected
        // by the relay, and one rejected fragment stalls the entire transfer.
        let bytes = vec![0xABu8; RELAY_FRAGMENT_RAW_BYTES * 4];
        for piece in fragment("transfer-with-a-fairly-long-identifier", &bytes) {
            let size = wire_size(&piece);
            assert!(
                size < RELAY_MAX_FRAME_BYTES,
                "fragment reaches the relay as {size} bytes, over its {RELAY_MAX_FRAME_BYTES}",
            );
        }
    }

    #[test]
    fn the_fragment_size_keeps_real_headroom_under_the_relay_ceiling() {
        // Not just "fits": a change to the envelope that adds a field must not silently eat the
        // whole margin. A full fragment should leave at least a tenth of the frame spare.
        let full = fragment("t", &vec![0u8; RELAY_FRAGMENT_RAW_BYTES]);
        let size = wire_size(&full[0]);
        assert!(
            size < RELAY_MAX_FRAME_BYTES - RELAY_MAX_FRAME_BYTES / 10,
            "only {} bytes of headroom left",
            RELAY_MAX_FRAME_BYTES - size
        );
    }

    #[test]
    fn two_transfers_can_interleave_without_mixing() {
        let mut reassembler = Reassembler::default();
        let a = fragment("a", &vec![1u8; RELAY_FRAGMENT_RAW_BYTES + 10]);
        let b = fragment("b", &vec![2u8; RELAY_FRAGMENT_RAW_BYTES + 20]);
        assert!(reassembler.accept(&a[0]).unwrap().is_none());
        assert!(reassembler.accept(&b[0]).unwrap().is_none());
        let done_a = reassembler.accept(&a[1]).unwrap().expect("a completed");
        let done_b = reassembler.accept(&b[1]).unwrap().expect("b completed");
        assert!(done_a.iter().all(|byte| *byte == 1));
        assert!(done_b.iter().all(|byte| *byte == 2));
    }

    #[test]
    fn a_repeated_fragment_is_an_error_rather_than_a_spliced_buffer() {
        // Accepting it would produce a buffer that looks fine and fails a content hash later, with
        // nothing to explain why. Failing here names the reason.
        let mut reassembler = Reassembler::default();
        let pieces = fragment("t1", &vec![7u8; RELAY_FRAGMENT_RAW_BYTES * 2]);
        assert!(reassembler.accept(&pieces[0]).unwrap().is_none());
        assert_eq!(reassembler.accept(&pieces[0]), Err(RelayError::OutOfOrder));
        // The failed transfer is dropped, not left half-built for the next fragment to extend.
        assert_eq!(reassembler.pending(), 0);
    }

    #[test]
    fn a_gap_is_an_error() {
        let mut reassembler = Reassembler::default();
        let pieces = fragment("t1", &vec![7u8; RELAY_FRAGMENT_RAW_BYTES * 3]);
        assert!(reassembler.accept(&pieces[0]).unwrap().is_none());
        assert_eq!(reassembler.accept(&pieces[2]), Err(RelayError::OutOfOrder));
    }

    #[test]
    fn fragments_disagreeing_about_the_total_are_rejected() {
        let mut reassembler = Reassembler::default();
        let mut pieces = fragment("t1", &vec![7u8; RELAY_FRAGMENT_RAW_BYTES * 2]);
        assert!(reassembler.accept(&pieces[0]).unwrap().is_none());
        pieces[1].total = 99;
        assert_eq!(reassembler.accept(&pieces[1]), Err(RelayError::TotalMismatch));
    }

    #[test]
    fn a_malformed_payload_is_rejected_before_it_is_buffered() {
        let mut reassembler = Reassembler::default();
        let bad = RelayFragment {
            transfer_id: "t1".into(),
            index: 0,
            total: 1,
            payload_b64: "!!! not base64 !!!".into(),
        };
        assert_eq!(reassembler.accept(&bad), Err(RelayError::Decode));
        assert_eq!(reassembler.pending(), 0);
    }

    #[test]
    fn a_transfer_cannot_buffer_without_bound() {
        // A peer that keeps sending fragments for a transfer that never completes must not be able
        // to make this allocate forever.
        let mut reassembler = Reassembler::default();
        let piece = RelayFragment {
            transfer_id: "flood".into(),
            index: 0,
            total: 10_000,
            payload_b64: BASE64.encode(vec![0u8; RELAY_FRAGMENT_RAW_BYTES]),
        };
        let mut index = 0u32;
        let outcome = loop {
            let mut next = piece.clone();
            next.index = index;
            match reassembler.accept(&next) {
                Ok(_) => index += 1,
                Err(error) => break error,
            }
            assert!(index < 10_000, "the ceiling was never reached");
        };
        assert_eq!(outcome, RelayError::TooLarge);
    }
}

// -------------------------------------------------------------------------------------------
// Sending: prefer the direct path, fall back to the relay
// -------------------------------------------------------------------------------------------

/// The envelope kind project transfers travel under. Free-form on the relay, which only uses the
/// kind to decide TTL and whether a delivery is worth notifying a person about — and a fragment of
/// a file transfer is machinery, never something the user took an action on.
pub const RELAY_ENVELOPE_KIND: &str = "filesync";

/// Domain separation for the sealed envelope, so a fragment can never be replayed as some other
/// kind of sealed message and vice versa.
const SEAL_INFO: &[u8] = b"alethe-filesync-fragment-v1";

/// How the frame actually left. Recorded rather than inferred: "it went out" and "it went out the
/// slow way" are different facts, and a user watching a transfer crawl deserves to know which.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SentVia {
    Direct,
    Relay,
}

/// Builds the enqueue frames that carry `frame` to a peer over the relay.
///
/// Separated from the sending so it can be tested without a live rendezvous connection: this is
/// where the fragmenting, sealing and envelope shape live, and it is the part that can be wrong.
pub fn relay_frames_for(
    frame: &[u8],
    transfer_id: &str,
    recipient_account_route: &str,
    recipient_agreement_public_key: &[u8],
    expires_at_ms: u64,
) -> Result<Vec<serde_json::Value>, String> {
    let mut out = Vec::new();
    for piece in fragment(transfer_id, frame) {
        let plaintext = serde_json::to_vec(&piece).map_err(|_| "relay_fragment_encode".to_string())?;
        let sealed = crate::sync_crypto::seal_for_recipient(
            &plaintext,
            recipient_agreement_public_key,
            SEAL_INFO,
        )
        .map_err(|_| "relay_fragment_seal".to_string())?;
        let mut packed = Vec::with_capacity(44 + sealed.ciphertext.len());
        packed.extend_from_slice(&sealed.ephemeral_public_key);
        packed.extend_from_slice(&sealed.nonce);
        packed.extend_from_slice(&sealed.ciphertext);
        out.push(serde_json::json!({
            "type": "enqueue",
            "id": format!("fs_{}_{}", transfer_id, piece.index),
            "kind": RELAY_ENVELOPE_KIND,
            "recipientAccountRoute": recipient_account_route,
            "expiresAtMs": expires_at_ms,
            "ciphertext": base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&packed),
        }));
    }
    Ok(out)
}

/// Opens one relay-delivered fragment.
pub fn open_fragment(
    ciphertext_b64: &str,
    recipient_secret: &x25519_dalek::StaticSecret,
) -> Result<RelayFragment, String> {
    let packed = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(ciphertext_b64)
        .map_err(|_| RelayError::Decode.to_string())?;
    if packed.len() < 44 {
        return Err(RelayError::Decode.to_string());
    }
    let (ephemeral_public_key, rest) = packed.split_at(32);
    let (nonce, ciphertext) = rest.split_at(12);
    let sealed = crate::sync_crypto::SealedEnvelope {
        ephemeral_public_key: ephemeral_public_key.to_vec(),
        nonce: nonce.to_vec(),
        ciphertext: ciphertext.to_vec(),
    };
    let plaintext = crate::sync_crypto::open_sealed(&sealed, recipient_secret, SEAL_INFO)
        .map_err(|_| RelayError::Decode.to_string())?;
    serde_json::from_slice(&plaintext).map_err(|_| RelayError::Decode.to_string())
}

#[cfg(test)]
mod transport_tests {
    use super::*;

    fn keypair() -> (x25519_dalek::StaticSecret, Vec<u8>) {
        let secret = x25519_dalek::StaticSecret::random_from_rng(rand_core::OsRng);
        let public = x25519_dalek::PublicKey::from(&secret);
        (secret, public.as_bytes().to_vec())
    }

    #[test]
    fn a_frame_survives_the_whole_relay_round_trip() {
        // Fragment, seal, envelope, and back — the path a project transfer actually takes when the
        // direct one is unavailable.
        let (secret, public) = keypair();
        let payload: Vec<u8> = (0..(RELAY_FRAGMENT_RAW_BYTES * 2 + 33))
            .map(|index| (index % 253) as u8)
            .collect();

        let frames = relay_frames_for(&payload, "t1", "route-abc", &public, 1_000).unwrap();
        assert_eq!(frames.len(), 3, "two full fragments and a remainder");

        let mut reassembler = Reassembler::default();
        let mut done = None;
        for frame in &frames {
            let ciphertext = frame["ciphertext"].as_str().unwrap();
            let piece = open_fragment(ciphertext, &secret).unwrap();
            if let Some(complete) = reassembler.accept(&piece).unwrap() {
                done = Some(complete);
            }
        }
        assert_eq!(done.unwrap(), payload);
    }

    #[test]
    fn every_enqueue_frame_is_shaped_the_way_the_relay_demands() {
        // `sanitize_outgoing_frame` on the relay rejects an enqueue with any unexpected key, so a
        // stray field would fail every fragment rather than degrade.
        let (_, public) = keypair();
        let frames = relay_frames_for(b"hello", "t1", "route-abc", &public, 4_242).unwrap();
        let object = frames[0].as_object().unwrap();
        let mut keys: Vec<&str> = object.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            ["ciphertext", "expiresAtMs", "id", "kind", "recipientAccountRoute", "type"]
        );
        assert_eq!(object["type"], "enqueue");
        assert_eq!(object["kind"], RELAY_ENVELOPE_KIND);
        assert_eq!(object["expiresAtMs"], 4_242);
    }

    #[test]
    fn every_enqueue_frame_fits_the_relay_ceiling() {
        let (_, public) = keypair();
        let payload = vec![0xCDu8; RELAY_FRAGMENT_RAW_BYTES * 3];
        for frame in relay_frames_for(&payload, "a-transfer-id-of-realistic-length", "acct_route_abcdefghijklmnop", &public, 1).unwrap() {
            let size = serde_json::to_vec(&frame).unwrap().len();
            assert!(size < RELAY_MAX_FRAME_BYTES, "enqueue frame is {size} bytes");
        }
    }

    #[test]
    fn a_fragment_sealed_for_someone_else_does_not_open() {
        let (_, public) = keypair();
        let (other_secret, _) = keypair();
        let frames = relay_frames_for(b"secret", "t1", "route", &public, 1).unwrap();
        let ciphertext = frames[0]["ciphertext"].as_str().unwrap();
        assert!(open_fragment(ciphertext, &other_secret).is_err());
    }
}

// -------------------------------------------------------------------------------------------
// Receiving
// -------------------------------------------------------------------------------------------

/// Fragments arriving from the relay, kept until each transfer is whole.
///
/// Keyed by sender: two peers may relay to this device at the same time, and their fragments must
/// never be spliced into each other. Keeping senders apart means a broken or hostile peer can only
/// corrupt its own transfers.
#[derive(Default)]
pub struct RelayInbox {
    by_sender: std::sync::Mutex<HashMap<String, Reassembler>>,
}

impl RelayInbox {
    /// Accepts one relay-delivered fragment, returning the completed pipeline frame if this was its
    /// last piece.
    pub fn accept(
        &self,
        sender_account_route: &str,
        fragment: &RelayFragment,
    ) -> Result<Option<Vec<u8>>, RelayError> {
        let mut inboxes = self
            .by_sender
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        inboxes
            .entry(sender_account_route.to_string())
            .or_default()
            .accept(fragment)
    }

    /// Transfers still waiting on pieces, across every sender.
    pub fn pending(&self) -> usize {
        self.by_sender
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .values()
            .map(Reassembler::pending)
            .sum()
    }
}

#[cfg(test)]
mod inbox_tests {
    use super::*;

    #[test]
    fn two_senders_relaying_at_once_never_splice_into_each_other() {
        // Both peers use the same transfer id on purpose — the worst case.
        let inbox = RelayInbox::default();
        let from_a = fragment("same-id", &vec![1u8; RELAY_FRAGMENT_RAW_BYTES + 5]);
        let from_b = fragment("same-id", &vec![2u8; RELAY_FRAGMENT_RAW_BYTES + 5]);

        assert!(inbox.accept("peer-a", &from_a[0]).unwrap().is_none());
        assert!(inbox.accept("peer-b", &from_b[0]).unwrap().is_none());
        assert_eq!(inbox.pending(), 2);

        let a = inbox.accept("peer-a", &from_a[1]).unwrap().expect("a completed");
        let b = inbox.accept("peer-b", &from_b[1]).unwrap().expect("b completed");
        assert!(a.iter().all(|byte| *byte == 1), "peer A's bytes are its own");
        assert!(b.iter().all(|byte| *byte == 2), "peer B's bytes are its own");
        assert_eq!(inbox.pending(), 0);
    }

    #[test]
    fn one_peer_sending_garbage_does_not_disturb_another() {
        let inbox = RelayInbox::default();
        let good = fragment("t", &vec![9u8; RELAY_FRAGMENT_RAW_BYTES + 1]);
        assert!(inbox.accept("good", &good[0]).unwrap().is_none());

        let bad = RelayFragment {
            transfer_id: "t".into(),
            index: 7,
            total: 9,
            payload_b64: String::new(),
        };
        assert_eq!(inbox.accept("bad", &bad), Err(RelayError::OutOfOrder));

        let done = inbox.accept("good", &good[1]).unwrap().expect("still completes");
        assert!(done.iter().all(|byte| *byte == 9));
    }
}
