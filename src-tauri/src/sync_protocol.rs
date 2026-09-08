//! Canonical vocabulary and signed control envelope for provider-independent project
//! collaboration (Phase 3). This module defines wire-format types only; it never contacts a
//! network service. See `docs/adr/ADR-0004-opaque-account-routing.md` for the account-route
//! derivation this module implements, and the Phase 3 security gate document for the invariants
//! each function here satisfies.

use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use sha2::{Digest, Sha256};

/// Current control-protocol version. Any envelope claiming a different value is rejected.
pub const PROTOCOL_VERSION: u32 = 1;
/// Current envelope schema version, independent from the protocol version so the envelope
/// container can evolve without renegotiating the whole protocol.
pub const ENVELOPE_SCHEMA_VERSION: u32 = 1;

/// Hard ceiling on an encoded envelope, enforced before any length-prefixed field is allocated.
/// Chosen well above any Phase 3 payload (control messages only) and far below anything that
/// could be mistaken for project content.
pub const MAX_ENVELOPE_BYTES: usize = 64 * 1024;
/// Hard ceiling on any single length-prefixed string/byte field inside an envelope.
pub const MAX_FIELD_BYTES: usize = 16 * 1024;

const ACCOUNT_ROUTE_DOMAIN_PREFIX: &str = "alethe-account-route-v1";

/// Derives the opaque account-routing identifier for a locally verified Google account, per
/// ADR-0004. This never leaves the process boundary as anything other than its hash; the
/// underlying `account_id` (Google `sub`) is never transmitted for routing purposes.
pub fn account_route_id(account_id: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(ACCOUNT_ROUTE_DOMAIN_PREFIX.as_bytes());
    hasher.update(account_id.as_bytes());
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SignedEnvelope {
    pub protocol_version: u32,
    pub schema_version: u32,
    pub message_type: String,
    pub sender_account_route: String,
    pub sender_device_id: String,
    pub recipient_account_route: Option<String>,
    pub recipient_device_id: Option<String>,
    pub message_id: String,
    pub issued_at_ms: u64,
    pub expires_at_ms: u64,
    pub sequence: Option<u64>,
    pub payload: Vec<u8>,
    pub signing_key_id: String,
    pub signature: Vec<u8>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EnvelopeError {
    FieldTooLarge,
    EnvelopeTooLarge,
    Truncated,
    Malformed,
    UnsupportedProtocolVersion,
    UnsupportedSchemaVersion,
    Expired,
    IssuedInFuture,
    InvalidSignature,
}

impl std::fmt::Display for EnvelopeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let code = match self {
            EnvelopeError::FieldTooLarge => "envelope_field_too_large",
            EnvelopeError::EnvelopeTooLarge => "envelope_too_large",
            EnvelopeError::Truncated => "envelope_truncated",
            EnvelopeError::Malformed => "envelope_malformed",
            EnvelopeError::UnsupportedProtocolVersion => "envelope_protocol_unsupported",
            EnvelopeError::UnsupportedSchemaVersion => "envelope_schema_unsupported",
            EnvelopeError::Expired => "envelope_expired",
            EnvelopeError::IssuedInFuture => "envelope_issued_in_future",
            EnvelopeError::InvalidSignature => "envelope_signature_invalid",
        };
        write!(f, "{code}")
    }
}

fn write_len_prefixed(buffer: &mut Vec<u8>, bytes: &[u8]) -> Result<(), EnvelopeError> {
    if bytes.len() > MAX_FIELD_BYTES {
        return Err(EnvelopeError::FieldTooLarge);
    }
    buffer.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
    buffer.extend_from_slice(bytes);
    Ok(())
}

fn write_optional_str(buffer: &mut Vec<u8>, value: Option<&str>) -> Result<(), EnvelopeError> {
    match value {
        Some(text) => {
            buffer.push(1);
            write_len_prefixed(buffer, text.as_bytes())
        }
        None => {
            buffer.push(0);
            Ok(())
        }
    }
}

fn write_optional_u64(buffer: &mut Vec<u8>, value: Option<u64>) {
    match value {
        Some(number) => {
            buffer.push(1);
            buffer.extend_from_slice(&number.to_le_bytes());
        }
        None => buffer.push(0),
    }
}

/// Serializes every signable field into a deterministic byte sequence. Field order, encoding,
/// and length prefixes are fixed by this function; the TypeScript mirror in
/// `src/lib/sync/protocol.ts` must produce byte-identical output for the same logical envelope
/// (verified by the shared test vectors in both test suites).
pub fn canonical_signable_bytes(envelope: &SignedEnvelope) -> Result<Vec<u8>, EnvelopeError> {
    let mut buffer = Vec::with_capacity(256);
    buffer.extend_from_slice(&envelope.protocol_version.to_le_bytes());
    buffer.extend_from_slice(&envelope.schema_version.to_le_bytes());
    write_len_prefixed(&mut buffer, envelope.message_type.as_bytes())?;
    write_len_prefixed(&mut buffer, envelope.sender_account_route.as_bytes())?;
    write_len_prefixed(&mut buffer, envelope.sender_device_id.as_bytes())?;
    write_optional_str(&mut buffer, envelope.recipient_account_route.as_deref())?;
    write_optional_str(&mut buffer, envelope.recipient_device_id.as_deref())?;
    write_len_prefixed(&mut buffer, envelope.message_id.as_bytes())?;
    buffer.extend_from_slice(&envelope.issued_at_ms.to_le_bytes());
    buffer.extend_from_slice(&envelope.expires_at_ms.to_le_bytes());
    write_optional_u64(&mut buffer, envelope.sequence);
    write_len_prefixed(&mut buffer, &envelope.payload)?;
    write_len_prefixed(&mut buffer, envelope.signing_key_id.as_bytes())?;
    if buffer.len() > MAX_ENVELOPE_BYTES {
        return Err(EnvelopeError::EnvelopeTooLarge);
    }
    Ok(buffer)
}

/// Encodes a fully signed envelope (signable bytes followed by the length-prefixed signature)
/// for transport. Kept separate from `canonical_signable_bytes` because the signature itself is
/// never part of what gets signed.
pub fn encode_envelope(envelope: &SignedEnvelope) -> Result<Vec<u8>, EnvelopeError> {
    let mut buffer = canonical_signable_bytes(envelope)?;
    write_len_prefixed(&mut buffer, &envelope.signature)?;
    if buffer.len() > MAX_ENVELOPE_BYTES {
        return Err(EnvelopeError::EnvelopeTooLarge);
    }
    Ok(buffer)
}

struct Reader<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl<'a> Reader<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, offset: 0 }
    }

    fn take(&mut self, count: usize) -> Result<&'a [u8], EnvelopeError> {
        let end = self.offset.checked_add(count).ok_or(EnvelopeError::Malformed)?;
        let slice = self.bytes.get(self.offset..end).ok_or(EnvelopeError::Truncated)?;
        self.offset = end;
        Ok(slice)
    }

    fn u32(&mut self) -> Result<u32, EnvelopeError> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }

    fn u64(&mut self) -> Result<u64, EnvelopeError> {
        Ok(u64::from_le_bytes(self.take(8)?.try_into().unwrap()))
    }

    fn len_prefixed(&mut self) -> Result<&'a [u8], EnvelopeError> {
        let length = self.u32()? as usize;
        if length > MAX_FIELD_BYTES {
            return Err(EnvelopeError::FieldTooLarge);
        }
        self.take(length)
    }

    fn optional_str(&mut self) -> Result<Option<String>, EnvelopeError> {
        match self.take(1)?[0] {
            0 => Ok(None),
            1 => Ok(Some(
                String::from_utf8(self.len_prefixed()?.to_vec()).map_err(|_| EnvelopeError::Malformed)?,
            )),
            _ => Err(EnvelopeError::Malformed),
        }
    }

    fn optional_u64(&mut self) -> Result<Option<u64>, EnvelopeError> {
        match self.take(1)?[0] {
            0 => Ok(None),
            1 => Ok(Some(self.u64()?)),
            _ => Err(EnvelopeError::Malformed),
        }
    }

    fn utf8_len_prefixed(&mut self) -> Result<String, EnvelopeError> {
        String::from_utf8(self.len_prefixed()?.to_vec()).map_err(|_| EnvelopeError::Malformed)
    }
}

/// Strictly decodes an envelope, rejecting oversized fields before allocating them and rejecting
/// any trailing bytes after the signature (a truncation/injection smell, not a valid encoding).
pub fn decode_envelope(bytes: &[u8]) -> Result<SignedEnvelope, EnvelopeError> {
    if bytes.len() > MAX_ENVELOPE_BYTES {
        return Err(EnvelopeError::EnvelopeTooLarge);
    }
    let mut reader = Reader::new(bytes);
    let protocol_version = reader.u32()?;
    let schema_version = reader.u32()?;
    let message_type = reader.utf8_len_prefixed()?;
    let sender_account_route = reader.utf8_len_prefixed()?;
    let sender_device_id = reader.utf8_len_prefixed()?;
    let recipient_account_route = reader.optional_str()?;
    let recipient_device_id = reader.optional_str()?;
    let message_id = reader.utf8_len_prefixed()?;
    let issued_at_ms = reader.u64()?;
    let expires_at_ms = reader.u64()?;
    let sequence = reader.optional_u64()?;
    let payload = reader.len_prefixed()?.to_vec();
    let signing_key_id = reader.utf8_len_prefixed()?;
    let signature = reader.len_prefixed()?.to_vec();
    if reader.offset != bytes.len() {
        return Err(EnvelopeError::Malformed);
    }
    if protocol_version != PROTOCOL_VERSION {
        return Err(EnvelopeError::UnsupportedProtocolVersion);
    }
    if schema_version != ENVELOPE_SCHEMA_VERSION {
        return Err(EnvelopeError::UnsupportedSchemaVersion);
    }
    Ok(SignedEnvelope {
        protocol_version,
        schema_version,
        message_type,
        sender_account_route,
        sender_device_id,
        recipient_account_route,
        recipient_device_id,
        message_id,
        issued_at_ms,
        expires_at_ms,
        sequence,
        payload,
        signing_key_id,
        signature,
    })
}

/// Signs the envelope's canonical bytes with the given Ed25519 device identity key.
pub fn sign_envelope(envelope: &mut SignedEnvelope, signing_key: &SigningKey) -> Result<(), EnvelopeError> {
    let signable = canonical_signable_bytes(envelope)?;
    envelope.signature = signing_key.sign(&signable).to_bytes().to_vec();
    Ok(())
}

/// Verifies the envelope's signature, protocol/schema version, and a bounded expiry/issuance
/// window against the caller-supplied `now_ms`. Does not evaluate replay/sequence policy — that
/// is caller-scoped state (see the Phase 3 replay-window tests) because it depends on which
/// device/account is receiving, not on the envelope alone.
pub fn verify_envelope(
    envelope: &SignedEnvelope,
    verifying_key: &VerifyingKey,
    now_ms: u64,
    max_future_skew_ms: u64,
) -> Result<(), EnvelopeError> {
    if envelope.protocol_version != PROTOCOL_VERSION {
        return Err(EnvelopeError::UnsupportedProtocolVersion);
    }
    if envelope.schema_version != ENVELOPE_SCHEMA_VERSION {
        return Err(EnvelopeError::UnsupportedSchemaVersion);
    }
    if envelope.issued_at_ms > now_ms.saturating_add(max_future_skew_ms) {
        return Err(EnvelopeError::IssuedInFuture);
    }
    if now_ms > envelope.expires_at_ms {
        return Err(EnvelopeError::Expired);
    }
    let signable = canonical_signable_bytes(envelope)?;
    let signature_bytes: [u8; 64] = envelope
        .signature
        .as_slice()
        .try_into()
        .map_err(|_| EnvelopeError::InvalidSignature)?;
    let signature = Signature::from_bytes(&signature_bytes);
    verifying_key
        .verify(&signable, &signature)
        .map_err(|_| EnvelopeError::InvalidSignature)
}

/// Bounded replay/duplicate-suppression window keyed by message ID. Callers own the instance
/// lifetime and bound its size; this type only enforces the bound and dedup logic.
pub struct ReplayWindow {
    max_entries: usize,
    seen: std::collections::VecDeque<String>,
    seen_set: std::collections::HashSet<String>,
}

impl ReplayWindow {
    pub fn new(max_entries: usize) -> Self {
        Self {
            max_entries,
            seen: std::collections::VecDeque::with_capacity(max_entries.min(1024)),
            seen_set: std::collections::HashSet::with_capacity(max_entries.min(1024)),
        }
    }

    /// Returns `true` if this message ID was already observed (i.e. this call is a replay).
    /// Otherwise records it and returns `false`.
    pub fn observe(&mut self, message_id: &str) -> bool {
        if self.seen_set.contains(message_id) {
            return true;
        }
        if self.seen.len() >= self.max_entries {
            if let Some(oldest) = self.seen.pop_front() {
                self.seen_set.remove(&oldest);
            }
        }
        self.seen.push_back(message_id.to_string());
        self.seen_set.insert(message_id.to_string());
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand_core::OsRng;

    fn sample_envelope() -> SignedEnvelope {
        SignedEnvelope {
            protocol_version: PROTOCOL_VERSION,
            schema_version: ENVELOPE_SCHEMA_VERSION,
            message_type: "invitation.notify".to_string(),
            sender_account_route: account_route_id("acct-owner"),
            sender_device_id: "dev_owner".to_string(),
            recipient_account_route: Some(account_route_id("acct-recipient")),
            recipient_device_id: Some("dev_recipient".to_string()),
            message_id: "msg_1".to_string(),
            issued_at_ms: 1_000,
            expires_at_ms: 10_000,
            sequence: Some(1),
            payload: b"ciphertext-placeholder".to_vec(),
            signing_key_id: "dev_owner".to_string(),
            signature: Vec::new(),
        }
    }

    #[test]
    fn canonical_signable_bytes_match_the_fixed_cross_language_vector() {
        // Same envelope and expected hex asserted by the TypeScript side
        // (`src/lib/sync/protocol.test.ts`), independently computed field-by-field so a bug
        // shared by both implementations cannot hide behind a self-referential vector.
        let envelope = SignedEnvelope {
            protocol_version: 1,
            schema_version: 1,
            message_type: "invitation.notify".to_string(),
            sender_account_route: "route-sender".to_string(),
            sender_device_id: "dev-sender".to_string(),
            recipient_account_route: Some("route-recipient".to_string()),
            recipient_device_id: Some("dev-recipient".to_string()),
            message_id: "msg-1".to_string(),
            issued_at_ms: 1_000,
            expires_at_ms: 10_000,
            sequence: Some(1),
            payload: b"payload-bytes".to_vec(),
            signing_key_id: "dev-sender".to_string(),
            signature: Vec::new(),
        };
        let bytes = canonical_signable_bytes(&envelope).unwrap();
        let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
        assert_eq!(
            hex,
            "010000000100000011000000696e7669746174696f6e2e6e6f746966790c000000726f7574652d73656e6465720a0000006465762d73656e646572010f000000726f7574652d726563697069656e74010d0000006465762d726563697069656e74050000006d73672d31e80300000000000010270000000000000101000000000000000d0000007061796c6f61642d62797465730a0000006465762d73656e646572"
        );
    }

    #[test]
    fn account_route_id_matches_the_fixed_cross_language_vector() {
        // Same input/output pair asserted by the TypeScript side
        // (`src/lib/sync/accountRoute.test.ts`), independently computed as
        // SHA-256("alethe-account-route-v1" + "acct-owner").
        assert_eq!(
            account_route_id("acct-owner"),
            "fb656d1fd22a71da157f6959877b97c105fa3efe799b4646fd6fbc20105d555b"
        );
    }

    #[test]
    fn account_route_id_is_deterministic_and_never_reveals_the_input() {
        let route_a = account_route_id("google-sub-a");
        let route_b = account_route_id("google-sub-a");
        let route_c = account_route_id("google-sub-b");
        assert_eq!(route_a, route_b);
        assert_ne!(route_a, route_c);
        assert_eq!(route_a.len(), 64);
        assert!(!route_a.contains("google-sub-a"));
    }

    #[test]
    fn sign_and_verify_round_trip_succeeds() {
        let signing_key = SigningKey::generate(&mut OsRng);
        let mut envelope = sample_envelope();
        sign_envelope(&mut envelope, &signing_key).unwrap();
        assert!(verify_envelope(&envelope, &signing_key.verifying_key(), 5_000, 0).is_ok());
    }

    #[test]
    fn verify_rejects_wrong_key_tampered_payload_and_expiry() {
        let signing_key = SigningKey::generate(&mut OsRng);
        let other_key = SigningKey::generate(&mut OsRng);
        let mut envelope = sample_envelope();
        sign_envelope(&mut envelope, &signing_key).unwrap();

        assert_eq!(
            verify_envelope(&envelope, &other_key.verifying_key(), 5_000, 0),
            Err(EnvelopeError::InvalidSignature)
        );

        let mut tampered = envelope.clone();
        tampered.payload = b"different-ciphertext".to_vec();
        assert_eq!(
            verify_envelope(&tampered, &signing_key.verifying_key(), 5_000, 0),
            Err(EnvelopeError::InvalidSignature)
        );

        assert_eq!(
            verify_envelope(&envelope, &signing_key.verifying_key(), 11_000, 0),
            Err(EnvelopeError::Expired)
        );
        assert_eq!(
            verify_envelope(&envelope, &signing_key.verifying_key(), 0, 0),
            Err(EnvelopeError::IssuedInFuture)
        );
    }

    #[test]
    fn verify_rejects_unsupported_protocol_and_schema_versions() {
        let signing_key = SigningKey::generate(&mut OsRng);
        let mut envelope = sample_envelope();
        sign_envelope(&mut envelope, &signing_key).unwrap();

        let mut wrong_protocol = envelope.clone();
        wrong_protocol.protocol_version = PROTOCOL_VERSION + 1;
        assert_eq!(
            verify_envelope(&wrong_protocol, &signing_key.verifying_key(), 5_000, 0),
            Err(EnvelopeError::UnsupportedProtocolVersion)
        );

        let mut wrong_schema = envelope.clone();
        wrong_schema.schema_version = ENVELOPE_SCHEMA_VERSION + 1;
        assert_eq!(
            verify_envelope(&wrong_schema, &signing_key.verifying_key(), 5_000, 0),
            Err(EnvelopeError::UnsupportedSchemaVersion)
        );
    }

    #[test]
    fn encode_decode_round_trip_is_lossless() {
        let signing_key = SigningKey::generate(&mut OsRng);
        let mut envelope = sample_envelope();
        sign_envelope(&mut envelope, &signing_key).unwrap();
        let encoded = encode_envelope(&envelope).unwrap();
        let decoded = decode_envelope(&encoded).unwrap();
        assert_eq!(decoded, envelope);
    }

    #[test]
    fn decode_rejects_oversized_fields_before_allocating_them() {
        // A length prefix claiming more than MAX_FIELD_BYTES must fail immediately, not attempt
        // to read/allocate that many bytes.
        let mut buffer = Vec::new();
        buffer.extend_from_slice(&PROTOCOL_VERSION.to_le_bytes());
        buffer.extend_from_slice(&ENVELOPE_SCHEMA_VERSION.to_le_bytes());
        buffer.extend_from_slice(&((MAX_FIELD_BYTES as u32) + 1).to_le_bytes());
        // No further bytes are provided; a correct implementation must reject on the length
        // prefix alone rather than trying to slice past the end of `buffer`.
        assert_eq!(decode_envelope(&buffer), Err(EnvelopeError::FieldTooLarge));
    }

    #[test]
    fn decode_rejects_truncated_and_trailing_bytes() {
        let signing_key = SigningKey::generate(&mut OsRng);
        let mut envelope = sample_envelope();
        sign_envelope(&mut envelope, &signing_key).unwrap();
        let mut encoded = encode_envelope(&envelope).unwrap();

        let truncated = &encoded[..encoded.len() - 4];
        assert!(decode_envelope(truncated).is_err());

        encoded.extend_from_slice(b"trailing-garbage");
        assert_eq!(decode_envelope(&encoded), Err(EnvelopeError::Malformed));
    }

    #[test]
    fn decode_rejects_envelopes_over_the_hard_size_ceiling() {
        let oversized = vec![0_u8; MAX_ENVELOPE_BYTES + 1];
        assert_eq!(
            decode_envelope(&oversized),
            Err(EnvelopeError::EnvelopeTooLarge)
        );
    }

    #[test]
    fn replay_window_flags_duplicates_and_stays_bounded() {
        let mut window = ReplayWindow::new(2);
        assert!(!window.observe("a"));
        assert!(window.observe("a"));
        assert!(!window.observe("b"));
        // Evicts "a" once capacity (2) is exceeded by a third distinct ID.
        assert!(!window.observe("c"));
        assert!(!window.observe("a"));
    }
}
