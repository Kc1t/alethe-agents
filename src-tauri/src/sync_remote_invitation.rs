//! Closes a real gap left by `sync_invitation_bridge.rs`'s own round-trip test: that module's
//! `consume_remote_invitation_delivery` calls `sync_security::redeem_invitation`, which requires
//! an `InvitationRecord` to already exist in the *caller's own* local document — true for the
//! bridge's single-document test, but never true for an actual second machine, whose document
//! never received the issuer's invitation. `sync_security::redeem_remote_invitation_at` closes
//! that gap by materializing the record first; this file is the thin decrypt step that feeds it,
//! kept separate so `sync_invitation_bridge.rs` itself is never touched. The envelope format
//! (ephemeral key || nonce || ciphertext, sealed with `sync_crypto`) intentionally mirrors that
//! module's exactly, since it's the same wire format produced by `sync_prepare_remote_invitation`.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde::{Deserialize, Serialize};

use crate::sync_crypto::{open_sealed, SealedEnvelope};
use crate::sync_security::{GrantRecord, PathScope, SyncPermission};

/// A device's own identity, shaped exactly like `sync_invitation_bridge::DiscoveredDevice` so it
/// can be verified with the existing `sync_verify_discovered_device` command — meant to be shared
/// out of band (a paste, a QR code) between two accounts that have no automated cross-account
/// discovery (by design; see `ADR-0004` — same-account discovery never grants project access, and
/// there is no discovery at all between different accounts). This is the bootstrap step a first
/// real test between two people needs: it only ever exposes public key material, nothing secret.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingCode {
    /// The real Google account id (`sub`), needed to address an invitation to this person —
    /// `account_route` alone (a one-way hash) can't be reversed back into it. Sharing it here is
    /// fine because the pairing code is itself an explicit, deliberate out-of-band exchange
    /// between two people who already intend to collaborate, not something broadcast or logged.
    pub account_id: String,
    pub account_route: String,
    pub device_id: String,
    pub public_key: String,
    pub agreement_public_key: String,
    pub agreement_bound_at_ms: u64,
    pub agreement_binding_signature: String,
    /// A single-use token (see `sync_security::ChatInviteToken`) the recipient hands back inside
    /// a `"chat_contact_ack"` envelope once they've verified and saved this code as a contact —
    /// that's what lets the issuer auto-add them back without ever having to paste anything.
    #[serde(default)]
    pub invite_token: String,
    /// This device's own validated rendezvous endpoint (its personal Cloudflare Worker URL), if
    /// one is configured and enabled — `None` otherwise. Carrying it here is what lets the other
    /// side reach this device without deploying (or even knowing about) a Worker of their own:
    /// there is no central directory (see `ADR-0002`), so without this field embedded in the
    /// pairing code itself, two people would have no way to discover which endpoint to share.
    #[serde(default)]
    pub rendezvous_endpoint: Option<String>,
    /// This device's own display name (the exporter's profile name), if set — lets the recipient
    /// default the new contact's label to the real name instead of a raw device id, without either
    /// side having to type anything at pairing time. Still just a starting point: the recipient can
    /// always rename the contact afterward (see `sync_rename_chat_contact`).
    #[serde(default)]
    pub display_name: Option<String>,
}

/// Exports this device's own pairing code, base64url-encoded JSON ready to paste to the other
/// side. Fails if this device hasn't completed Google sign-in and device registration yet.
#[tauri::command]
pub fn sync_export_pairing_code(app: tauri::AppHandle, display_name: Option<String>) -> Result<String, String> {
    let data_root = crate::profiles::resolve_tauri_data_root(&app)?;
    let document = crate::sync_security::load_at(&data_root)?;
    let local_device_id = document.local_device_id.clone().ok_or_else(|| "security_device_missing".to_string())?;
    let account = document.account.clone().ok_or_else(|| "security_account_missing".to_string())?;
    let device = document
        .devices
        .iter()
        .find(|device| device.device_id == local_device_id)
        .ok_or_else(|| "security_device_missing".to_string())?;
    let invite_token = crate::sync_security::current_or_new_chat_invite_token_at(
        &data_root,
        crate::provider_common::now_ms(),
    )?;
    let activation = crate::sync_activation::load_settings_at(&data_root, crate::provider_common::now_ms())
        .ok();
    let rendezvous_endpoint = activation.and_then(|settings| {
        if settings.enabled {
            settings.validated_endpoint
        } else {
            None
        }
    });
    let code = PairingCode {
        account_id: account.account_id.clone(),
        account_route: crate::sync_protocol::account_route_id(&account.account_id),
        device_id: device.device_id.clone(),
        public_key: device.public_key.clone(),
        agreement_public_key: device.agreement_public_key.clone().unwrap_or_default(),
        agreement_bound_at_ms: device.agreement_key_bound_at_ms.unwrap_or_default(),
        agreement_binding_signature: device.agreement_key_binding_signature.clone().unwrap_or_default(),
        invite_token,
        rendezvous_endpoint,
        display_name: display_name.filter(|name| !name.trim().is_empty()),
    };
    let json = serde_json::to_vec(&code).map_err(|_| "pairing_code_encode_failed".to_string())?;
    Ok(URL_SAFE_NO_PAD.encode(json))
}

/// Parses a pairing code pasted from the other side back into its fields, ready to be handed to
/// the existing `sync_verify_discovered_device` (which checks the Ed25519→X25519 key binding
/// signature) before trusting `agreement_public_key`/`account_route` for anything.
#[tauri::command]
pub fn sync_parse_pairing_code(code: String) -> Result<PairingCode, String> {
    let json = URL_SAFE_NO_PAD.decode(&code).map_err(|_| "pairing_code_decode_failed".to_string())?;
    serde_json::from_slice(&json).map_err(|_| "pairing_code_decode_failed".to_string())
}

#[derive(Deserialize)]
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

fn unpack_envelope(packed: &[u8]) -> Result<SealedEnvelope, String> {
    if packed.len() < 32 + 12 {
        return Err("invitation_bridge_invalid_envelope".to_string());
    }
    let (ephemeral_public_key, rest) = packed.split_at(32);
    let (nonce, ciphertext) = rest.split_at(12);
    Ok(SealedEnvelope {
        ephemeral_public_key: ephemeral_public_key.to_vec(),
        nonce: nonce.to_vec(),
        ciphertext: ciphertext.to_vec(),
    })
}

/// The genuinely cross-device counterpart to `sync_invitation_bridge::sync_consume_remote_invitation`:
/// decrypts the same envelope shape, then redeems it via `redeem_remote_invitation_at` instead of
/// the plain `redeem_invitation` the bridge module calls, so this works when the invitation truly
/// only ever existed on a different machine.
#[tauri::command]
pub fn sync_consume_remote_invitation_cross_device(
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

    let packed = URL_SAFE_NO_PAD.decode(&ciphertext).map_err(|_| "invitation_bridge_decode_failed".to_string())?;
    let sealed = unpack_envelope(&packed)?;
    let info = format!("alethe-invitation-envelope-v1|{invitation_id}");
    let plaintext = open_sealed(&sealed, &recipient_secret, info.as_bytes())
        .map_err(|_| "invitation_bridge_decode_failed".to_string())?;
    let payload: RemoteInvitationPayload =
        serde_json::from_slice(&plaintext).map_err(|_| "invitation_bridge_decode_failed".to_string())?;
    if payload.invitation_id != invitation_id {
        return Err("invitation_bridge_invalid_envelope".to_string());
    }

    crate::sync_security::redeem_remote_invitation_at(
        &data_root,
        &payload.invitation_id,
        &payload.bearer_token,
        &payload.project_id,
        payload.permissions,
        payload.path_scopes,
        payload.expires_at_ms,
        &account_id,
        &local_device_id,
        &payload.issuer_account_id,
        &payload.issuer_agreement_public_key,
        crate::provider_common::now_ms(),
    )
}
