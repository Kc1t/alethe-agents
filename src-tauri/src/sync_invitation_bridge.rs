//! Bridges the local invitation/grant domain (`sync_security.rs`) to the rendezvous transport
//! (`sync_rendezvous.rs`), closing the gap the Phase 10B gate documented as pending: "the service
//! can route ciphertext, but the current client does not yet convert a remote delivery into an
//! accepted project grant." This module owns three things: (1) verifying a discovered device's
//! advertised X25519 agreement key against its Ed25519 identity binding, so the untrusted
//! rendezvous server can never substitute its own key for a device's real one; (2) turning an
//! already-issued local invitation into an encrypted `enqueue` frame body addressed to a specific
//! recipient device's verified key; and (3) turning a decrypted delivery back into a call to the
//! existing `redeem_invitation`. It never touches the network itself —
//! `sync_rendezvous::send_at`/`drain_events_at` remain the only code that talks to a live
//! connection, consistent with every prior phase's "mechanism proven, live wiring deferred"
//! pattern.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde::{Deserialize, Serialize};

use crate::sync_crypto::{open_sealed, seal_for_recipient, verify_key_binding, DeviceKeyBinding, SealedEnvelope};
use crate::sync_security::{GrantRecord, PathScope, SyncPermission};

const ENVELOPE_MAX_TTL_MS: u64 = 7 * 24 * 60 * 60 * 1000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BridgeError {
    InvalidRecipientKey,
    PayloadTooLarge,
    Encode,
    Decode,
    InvalidEnvelope,
    Redeem,
}

impl std::fmt::Display for BridgeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let code = match self {
            BridgeError::InvalidRecipientKey => "invitation_bridge_invalid_recipient_key",
            BridgeError::PayloadTooLarge => "invitation_bridge_payload_too_large",
            BridgeError::Encode => "invitation_bridge_encode_failed",
            BridgeError::Decode => "invitation_bridge_decode_failed",
            BridgeError::InvalidEnvelope => "invitation_bridge_invalid_envelope",
            BridgeError::Redeem => "invitation_bridge_redeem_failed",
        };
        write!(f, "{code}")
    }
}

/// Exactly the fields a recipient needs to call `redeem_invitation` themselves — nothing about
/// the issuer's device identity or any other local state leaks into this payload.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteInvitationPayload {
    invitation_id: String,
    bearer_token: String,
    project_id: String,
    permissions: Vec<SyncPermission>,
    path_scopes: Vec<PathScope>,
    expires_at_ms: u64,
    #[serde(default)]
    issuer_account_id: String,
    #[serde(default)]
    issuer_agreement_public_key: String,
}

/// The fields needed to build a `sync_rendezvous` "enqueue" frame, kept transport-agnostic here —
/// the caller (Tauri command / Web route) assembles the actual JSON frame and calls `send_at`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutgoingInvitationEnvelope {
    pub message_id: String,
    pub recipient_account_route: String,
    pub recipient_device_id: Option<String>,
    pub expires_at_ms: u64,
    /// Base64url (no padding) encoding of `ephemeral_public_key(32) || nonce(12) || ciphertext`,
    /// matching `sync_rendezvous`'s single-field `ciphertext` frame slot and its documented
    /// `MAX_CIPHERTEXT_BYTES` (16 KiB) budget.
    pub ciphertext: String,
}

fn pack_envelope(envelope: &SealedEnvelope) -> Vec<u8> {
    let mut packed = Vec::with_capacity(32 + 12 + envelope.ciphertext.len());
    packed.extend_from_slice(&envelope.ephemeral_public_key);
    packed.extend_from_slice(&envelope.nonce);
    packed.extend_from_slice(&envelope.ciphertext);
    packed
}

fn unpack_envelope(packed: &[u8]) -> Result<SealedEnvelope, BridgeError> {
    if packed.len() < 32 + 12 {
        return Err(BridgeError::InvalidEnvelope);
    }
    let (ephemeral_public_key, rest) = packed.split_at(32);
    let (nonce, ciphertext) = rest.split_at(12);
    Ok(SealedEnvelope {
        ephemeral_public_key: ephemeral_public_key.to_vec(),
        nonce: nonce.to_vec(),
        ciphertext: ciphertext.to_vec(),
    })
}

/// Fields describing an already-issued local invitation, deliberately a plain struct (not
/// `sync_security::IssuedInvitation`) so a Tauri/Web caller can build it directly from an
/// `IssuedInvitationResponse` without needing to reconstruct a full internal `InvitationRecord`.
pub struct LocalIssuedInvitation {
    pub invitation_id: String,
    pub bearer_token: String,
    pub project_id: String,
    pub permissions: Vec<SyncPermission>,
    pub path_scopes: Vec<PathScope>,
    pub expires_at_ms: u64,
    pub created_at_ms: u64,
    /// The issuing account's own raw Google account id — carried through so the recipient can
    /// later address a `sync_suggest_project_collaborator` proposal back to the right account.
    pub issuer_account_id: String,
    /// The issuing device's own X25519 agreement public key (base64url, no padding) — lets the
    /// recipient seal a future collaborator suggestion for the owner without a separate lookup.
    pub issuer_agreement_public_key: String,
}

/// Encrypts an already-issued local invitation for delivery to `recipient_account_route` /
/// `recipient_agreement_public_key` (the recipient device's X25519 public key). The bearer token
/// is included in the encrypted payload only — it is never present in the returned envelope's
/// unencrypted fields, matching the existing rule that the bearer token is never persisted or
/// transmitted in the clear anywhere in this codebase.
pub fn prepare_remote_invitation_envelope(
    issued: &LocalIssuedInvitation,
    recipient_account_route: &str,
    recipient_device_id: Option<String>,
    recipient_agreement_public_key: &[u8],
    message_id: String,
) -> Result<OutgoingInvitationEnvelope, BridgeError> {
    let payload = RemoteInvitationPayload {
        invitation_id: issued.invitation_id.clone(),
        bearer_token: issued.bearer_token.clone(),
        project_id: issued.project_id.clone(),
        permissions: issued.permissions.clone(),
        path_scopes: issued.path_scopes.clone(),
        expires_at_ms: issued.expires_at_ms,
        issuer_account_id: issued.issuer_account_id.clone(),
        issuer_agreement_public_key: issued.issuer_agreement_public_key.clone(),
    };
    let plaintext = serde_json::to_vec(&payload).map_err(|_| BridgeError::Encode)?;
    let info = format!("alethe-invitation-envelope-v1|{}", issued.invitation_id);
    let sealed = seal_for_recipient(&plaintext, recipient_agreement_public_key, info.as_bytes())
        .map_err(|_| BridgeError::InvalidRecipientKey)?;
    let packed = pack_envelope(&sealed);
    // sync_rendezvous::MAX_CIPHERTEXT_BYTES is 16 KiB on the decoded payload; enforced again here
    // so a bad envelope fails at construction time with a bridge-specific error rather than only
    // being caught later by the transport layer's generic rejection.
    if packed.len() > 16 * 1024 {
        return Err(BridgeError::PayloadTooLarge);
    }
    let expires_at_ms = issued.expires_at_ms.min(
        // Never exceed the transport's own TTL ceiling even if the invitation itself lives
        // longer; the recipient must simply request re-delivery after this envelope expires.
        issued.created_at_ms.saturating_add(ENVELOPE_MAX_TTL_MS),
    );

    Ok(OutgoingInvitationEnvelope {
        message_id,
        recipient_account_route: recipient_account_route.to_string(),
        recipient_device_id,
        expires_at_ms,
        ciphertext: URL_SAFE_NO_PAD.encode(packed),
    })
}

/// Decrypts a delivered invitation envelope's `ciphertext` (as received from
/// `sync_rendezvous::drain_events_at`) using the local recipient's X25519 agreement secret, then
/// redeems it through the existing local invitation domain. Returns the resulting `GrantRecord`
/// exactly as `redeem_invitation` would for a same-device redemption — the remote origin is
/// invisible to that function by design, since a grant means the same thing regardless of how the
/// invitation ID and bearer token reached this device.
pub fn consume_remote_invitation_delivery(
    data_root: &std::path::Path,
    ciphertext_base64url: &str,
    invitation_id_for_context: &str,
    recipient_secret: &x25519_dalek::StaticSecret,
    recipient_account_id: &str,
    recipient_device_id: &str,
    now_ms: u64,
) -> Result<GrantRecord, BridgeError> {
    let packed = URL_SAFE_NO_PAD.decode(ciphertext_base64url).map_err(|_| BridgeError::Decode)?;
    let sealed = unpack_envelope(&packed)?;
    let info = format!("alethe-invitation-envelope-v1|{invitation_id_for_context}");
    let plaintext = open_sealed(&sealed, recipient_secret, info.as_bytes()).map_err(|_| BridgeError::Decode)?;
    let payload: RemoteInvitationPayload =
        serde_json::from_slice(&plaintext).map_err(|_| BridgeError::Decode)?;
    if payload.invitation_id != invitation_id_for_context {
        return Err(BridgeError::InvalidEnvelope);
    }
    crate::sync_security::redeem_invitation(
        data_root,
        &payload.invitation_id,
        &payload.bearer_token,
        recipient_account_id,
        recipient_device_id,
        now_ms,
    )
    .map_err(|_| BridgeError::Redeem)
}

/// One entry from a rendezvous `"devices"` discovery event
/// (`sync_rendezvous::RendezvousEvent.devices`), as sent by the (untrusted) rendezvous service.
/// Every field is base64url (no padding) except `device_id`, matching the encoding
/// `sync_security.rs` already uses when it originally sent this data during connect/auth.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredDevice {
    pub device_id: String,
    pub public_key: String,
    pub agreement_public_key: String,
    pub agreement_bound_at_ms: u64,
    pub agreement_binding_signature: String,
}

/// Verifies that a device discovered through the rendezvous service actually owns the X25519
/// agreement key it advertised, by checking the Ed25519 signature binding the two keys together
/// (ADR-0003) — the same binding every device already signs locally in Phase 3. The rendezvous
/// service only ever forwards this binding; it cannot forge one, since it never holds any
/// device's Ed25519 private key. A discovered key that fails this check is never handed to
/// `prepare_remote_invitation_envelope`, closing the "which device/key do I address" gap this
/// module previously left to the caller.
pub fn verify_discovered_device_agreement_key(device: &DiscoveredDevice) -> Result<Vec<u8>, BridgeError> {
    let ed25519_public_key = URL_SAFE_NO_PAD.decode(&device.public_key).map_err(|_| BridgeError::InvalidEnvelope)?;
    let x25519_public_key =
        URL_SAFE_NO_PAD.decode(&device.agreement_public_key).map_err(|_| BridgeError::InvalidEnvelope)?;
    let signature =
        URL_SAFE_NO_PAD.decode(&device.agreement_binding_signature).map_err(|_| BridgeError::InvalidEnvelope)?;
    let binding = DeviceKeyBinding {
        device_id: device.device_id.clone(),
        ed25519_public_key,
        x25519_public_key: x25519_public_key.clone(),
        bound_at_ms: device.agreement_bound_at_ms,
        signature,
    };
    verify_key_binding(&binding).map_err(|_| BridgeError::InvalidRecipientKey)?;
    Ok(x25519_public_key)
}

/// Builds the encrypted envelope for an already-issued local invitation. Pure with respect to
/// disk/network — the caller (Web route or the equivalent JS `invoke`) is responsible for then
/// passing the returned `ciphertext`/fields into `sync_rendezvous_send` as an `"enqueue"` frame
/// with `kind: "invitation"`.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn sync_prepare_remote_invitation(
    invitation_id: String,
    bearer_token: String,
    project_id: String,
    permissions: Vec<SyncPermission>,
    path_scopes: Vec<PathScope>,
    expires_at_ms: u64,
    created_at_ms: u64,
    recipient_account_route: String,
    recipient_device_id: Option<String>,
    recipient_agreement_public_key: String,
    issuer_account_id: Option<String>,
    issuer_agreement_public_key: Option<String>,
) -> Result<OutgoingInvitationEnvelope, String> {
    let public_key = URL_SAFE_NO_PAD
        .decode(&recipient_agreement_public_key)
        .map_err(|_| BridgeError::InvalidRecipientKey.to_string())?;
    let issued = LocalIssuedInvitation {
        invitation_id,
        bearer_token,
        project_id,
        permissions,
        path_scopes,
        expires_at_ms,
        created_at_ms,
        issuer_account_id: issuer_account_id.unwrap_or_default(),
        issuer_agreement_public_key: issuer_agreement_public_key.unwrap_or_default(),
    };
    let message_id = format!("inv_{}", nanoid::nanoid!(24));
    prepare_remote_invitation_envelope(&issued, &recipient_account_route, recipient_device_id, &public_key, message_id)
        .map_err(|error| error.to_string())
}

/// Verifies one discovered device's advertised agreement key and returns it base64url-encoded,
/// ready to pass as `recipient_agreement_public_key` to `sync_prepare_remote_invitation`. Fails
/// closed on any malformed or unverifiable binding — never returns a key it could not validate.
#[tauri::command]
pub fn sync_verify_discovered_device(device: DiscoveredDevice) -> Result<String, String> {
    verify_discovered_device_agreement_key(&device)
        .map(|key| URL_SAFE_NO_PAD.encode(key))
        .map_err(|error| error.to_string())
}

/// Decrypts a delivered invitation event (as drained from `sync_rendezvous_drain_events`) using
/// the local device's own X25519 agreement secret (read once from the OS keyring into process
/// memory, never returned to the caller) and redeems it into a `GrantRecord`.
#[tauri::command]
pub fn sync_consume_remote_invitation(
    app: tauri::AppHandle,
    ciphertext: String,
    invitation_id: String,
) -> Result<GrantRecord, String> {
    let data_root = crate::profiles::resolve_tauri_data_root(&app)?;
    let document = crate::sync_security::load_at(&data_root)?;
    let local_device_id = document.local_device_id.ok_or_else(|| "security_device_missing".to_string())?;
    let account_id = document
        .account
        .ok_or_else(|| "security_account_missing".to_string())?
        .account_id;
    let recipient_secret = crate::sync_security::load_device_agreement_secret(&local_device_id)?;
    consume_remote_invitation_delivery(
        &data_root,
        &ciphertext,
        &invitation_id,
        &recipient_secret,
        &account_id,
        &local_device_id,
        crate::provider_common::now_ms(),
    )
    .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync_security::{self, DeviceSecretStore, InvitationState, VerifiedAccount};
    use std::collections::HashMap;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::Mutex;
    use x25519_dalek::{PublicKey as X25519PublicKey, StaticSecret as X25519StaticSecret};

    #[derive(Default)]
    struct MemorySecrets(Mutex<HashMap<String, Vec<u8>>>);

    impl DeviceSecretStore for MemorySecrets {
        fn set(&self, device_id: &str, secret: &[u8]) -> Result<(), String> {
            self.0.lock().unwrap().insert(device_id.to_string(), secret.to_vec());
            Ok(())
        }

        fn delete(&self, device_id: &str) -> Result<(), String> {
            self.0.lock().unwrap().remove(device_id);
            Ok(())
        }
    }

    fn temp_root(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("alethe-invitation-bridge-{name}-{}", nanoid::nanoid!(8)));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn issue_local_invitation(root: &std::path::Path) -> (String, LocalIssuedInvitation) {
        let secrets = MemorySecrets::default();
        let account = VerifiedAccount {
            account_id: "issuer-account".to_string(),
            provider: "google".to_string(),
            display_name: "Test Issuer".to_string(),
            email_hint: None,
            connected_at_ms: 1_000,
        };
        // The first device registered for a fresh account is trusted automatically.
        let issuer = sync_security::complete_verified_identity(root, &secrets, account, "Issuer PC", 1_000).unwrap();

        let issued = sync_security::issue_invitation(
            root,
            &issuer.device_id,
            "project-1",
            "recipient-account",
            None,
            vec![SyncPermission::Read, SyncPermission::Write],
            vec![],
            1_000,
            1_000 + 60_000,
        )
        .unwrap();
        let invitation_id = issued.invitation.invitation_id.clone();
        (
            invitation_id,
            LocalIssuedInvitation {
                invitation_id: issued.invitation.invitation_id,
                bearer_token: issued.bearer_token,
                project_id: issued.invitation.project_id,
                permissions: issued.invitation.permissions,
                path_scopes: issued.invitation.path_scopes,
                expires_at_ms: issued.invitation.expires_at_ms,
                created_at_ms: issued.invitation.created_at_ms,
                issuer_account_id: "issuer-account".to_string(),
                issuer_agreement_public_key: "issuer-key".to_string(),
            },
        )
    }

    #[test]
    fn envelope_round_trips_and_the_recipient_can_redeem_it() {
        let root = temp_root("round-trip");
        let (invitation_id, issued) = issue_local_invitation(&root);
        let recipient_secret = X25519StaticSecret::random_from_rng(rand_core::OsRng);
        let recipient_public = X25519PublicKey::from(&recipient_secret);

        let envelope = prepare_remote_invitation_envelope(
            &issued,
            "recipient-route",
            Some("recipient-device".to_string()),
            recipient_public.as_bytes(),
            "msg-1".to_string(),
        )
        .unwrap();
        // The bearer token must never appear in the envelope's plaintext fields.
        assert!(!format!("{envelope:?}").contains(&issued.bearer_token));

        let grant = consume_remote_invitation_delivery(
            &root,
            &envelope.ciphertext,
            &invitation_id,
            &recipient_secret,
            "recipient-account",
            "recipient-device",
            2_000,
        )
        .unwrap();
        assert_eq!(grant.invitation_id, invitation_id);
        assert_eq!(grant.permissions, vec![SyncPermission::Read, SyncPermission::Write]);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn wrong_recipient_secret_cannot_decrypt_the_envelope() {
        let root = temp_root("wrong-key");
        let (invitation_id, issued) = issue_local_invitation(&root);
        let recipient_secret = X25519StaticSecret::random_from_rng(rand_core::OsRng);
        let recipient_public = X25519PublicKey::from(&recipient_secret);
        let attacker_secret = X25519StaticSecret::random_from_rng(rand_core::OsRng);

        let envelope = prepare_remote_invitation_envelope(
            &issued,
            "recipient-route",
            None,
            recipient_public.as_bytes(),
            "msg-1".to_string(),
        )
        .unwrap();

        let result = consume_remote_invitation_delivery(
            &root,
            &envelope.ciphertext,
            &invitation_id,
            &attacker_secret,
            "recipient-account",
            "recipient-device",
            2_000,
        );
        assert_eq!(result.unwrap_err(), BridgeError::Decode);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn redeeming_twice_fails_the_second_time_exactly_like_a_local_double_redeem() {
        let root = temp_root("double-redeem");
        let (invitation_id, issued) = issue_local_invitation(&root);
        let recipient_secret = X25519StaticSecret::random_from_rng(rand_core::OsRng);
        let recipient_public = X25519PublicKey::from(&recipient_secret);
        let envelope = prepare_remote_invitation_envelope(
            &issued,
            "recipient-route",
            None,
            recipient_public.as_bytes(),
            "msg-1".to_string(),
        )
        .unwrap();

        consume_remote_invitation_delivery(
            &root,
            &envelope.ciphertext,
            &invitation_id,
            &recipient_secret,
            "recipient-account",
            "recipient-device",
            2_000,
        )
        .unwrap();

        let second = consume_remote_invitation_delivery(
            &root,
            &envelope.ciphertext,
            &invitation_id,
            &recipient_secret,
            "recipient-account",
            "recipient-device",
            3_000,
        );
        assert_eq!(second.unwrap_err(), BridgeError::Redeem);

        let snapshot = sync_security::load_at(&root).unwrap();
        let record = snapshot.invitations.iter().find(|i| i.invitation_id == invitation_id).unwrap();
        assert_eq!(record.state, InvitationState::Redeemed);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn oversized_recipient_key_is_rejected_before_any_network_shape_is_built() {
        let root = temp_root("bad-key");
        let (_invitation_id, issued) = issue_local_invitation(&root);
        let result = prepare_remote_invitation_envelope(
            &issued,
            "recipient-route",
            None,
            &[1, 2, 3],
            "msg-1".to_string(),
        );
        assert_eq!(result.unwrap_err(), BridgeError::InvalidRecipientKey);
        fs::remove_dir_all(root).unwrap();
    }

    fn discovered_device_from(device_id: &str, identity: &ed25519_dalek::SigningKey, bound_at_ms: u64) -> DiscoveredDevice {
        let (_agreement_secret, binding) = crate::sync_crypto::generate_bound_key_agreement(device_id, identity, bound_at_ms);
        DiscoveredDevice {
            device_id: device_id.to_string(),
            public_key: URL_SAFE_NO_PAD.encode(binding.ed25519_public_key),
            agreement_public_key: URL_SAFE_NO_PAD.encode(binding.x25519_public_key),
            agreement_bound_at_ms: binding.bound_at_ms,
            agreement_binding_signature: URL_SAFE_NO_PAD.encode(binding.signature),
        }
    }

    #[test]
    fn a_genuinely_bound_discovered_device_key_is_accepted() {
        let identity = ed25519_dalek::SigningKey::generate(&mut rand_core::OsRng);
        let device = discovered_device_from("device-a", &identity, 1_000);
        let key = verify_discovered_device_agreement_key(&device).unwrap();
        let expected = URL_SAFE_NO_PAD.decode(&device.agreement_public_key).unwrap();
        assert_eq!(key, expected);
    }

    #[test]
    fn a_rendezvous_server_cannot_substitute_its_own_key_for_a_device() {
        let identity = ed25519_dalek::SigningKey::generate(&mut rand_core::OsRng);
        let mut device = discovered_device_from("device-a", &identity, 1_000);
        // Simulate a malicious/compromised server swapping in a key it controls, without a
        // matching signature — this must be rejected, never silently accepted.
        let attacker_secret = X25519StaticSecret::random_from_rng(rand_core::OsRng);
        device.agreement_public_key =
            URL_SAFE_NO_PAD.encode(X25519PublicKey::from(&attacker_secret).as_bytes());
        assert_eq!(
            verify_discovered_device_agreement_key(&device).unwrap_err(),
            BridgeError::InvalidRecipientKey
        );
    }

    #[test]
    fn a_signature_replayed_for_a_different_device_id_is_rejected() {
        let identity = ed25519_dalek::SigningKey::generate(&mut rand_core::OsRng);
        let mut device = discovered_device_from("device-a", &identity, 1_000);
        device.device_id = "device-b".to_string();
        assert_eq!(
            verify_discovered_device_agreement_key(&device).unwrap_err(),
            BridgeError::InvalidRecipientKey
        );
    }
}
