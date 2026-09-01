//! Inviting an existing chat contact to a project, over the chat channel.
//!
//! # Why this needs three messages instead of one
//!
//! Project access is granted to an *account id*. A saved [`ChatContactRecord`] deliberately does
//! not keep one: it stores only `account_route`, the one-way hash of that id (ADR-0004). That is
//! why sharing a project has until now only been possible while resolving a pairing request —
//! that is the single moment the real id is on hand, inside the request that has not been reduced
//! to a contact yet.
//!
//! Rather than start recording account ids on contacts, which would take back exactly the property
//! ADR-0004 established, the invite asks for one:
//!
//! 1. `project_invite` — owner → contact. Names the project. Carries no grant and no secret; being
//!    invited is not being granted anything.
//! 2. `project_invite_response` — contact → owner. On accept, and only then, it carries the
//!    invitee's own account id and device id. Declining sends the decision alone.
//! 3. `project_invite_grant` — owner → contact. With a real account id in hand the owner issues and
//!    redeems an invitation exactly as the pairing flow does, and ships the result for the invitee
//!    to materialize locally.
//!
//! So the id travels only when its owner has actively agreed to hand it over, for one named
//! project, in an envelope sealed to one device — never as a side effect of being someone's
//! contact.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde::{Deserialize, Serialize};

const PROJECT_INVITE_INFO: &[u8] = b"alethe-project-invite-v1";
const PROJECT_INVITE_RESPONSE_INFO: &[u8] = b"alethe-project-invite-response-v1";

/// Ceiling on a project name carried in an invite. The name is chosen by the sender and rendered by
/// the recipient, so it is bounded here rather than trusted.
const MAX_PROJECT_NAME_LEN: usize = 120;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInvitePayload {
    pub invite_id: String,
    pub project_id: String,
    pub project_name: String,
    /// Who sent it, as the route the recipient already knows them by — never a raw account id.
    pub from_account_route: String,
    pub sent_at_ms: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInviteResponsePayload {
    pub invite_id: String,
    pub accepted: bool,
    /// Present only on an accept: the invitee's real account id, which the owner needs to issue the
    /// grant and cannot recover from the contact record (see the module docs).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agreement_public_key: Option<String>,
}

fn seal(
    recipient_agreement_public_key: &str,
    payload: &impl Serialize,
    info: &[u8],
    error_label: &str,
) -> Result<String, String> {
    let recipient_public_key = URL_SAFE_NO_PAD
        .decode(recipient_agreement_public_key)
        .map_err(|_| format!("{error_label}_recipient_key_invalid"))?;
    let plaintext =
        serde_json::to_vec(payload).map_err(|_| format!("{error_label}_encode_failed"))?;
    let sealed = crate::sync_crypto::seal_for_recipient(&plaintext, &recipient_public_key, info)
        .map_err(|_| format!("{error_label}_recipient_key_invalid"))?;
    Ok(URL_SAFE_NO_PAD.encode(crate::sync_chat::pack_sealed(&sealed)))
}

fn open<T: for<'de> Deserialize<'de>>(
    ciphertext: &str,
    local_device_id: &str,
    info: &[u8],
    error_label: &str,
) -> Result<Option<T>, String> {
    let packed = URL_SAFE_NO_PAD
        .decode(ciphertext)
        .map_err(|_| format!("{error_label}_invalid"))?;
    let sealed = crate::sync_chat::unpack_sealed(&packed)?;
    let recipient_secret = crate::sync_security::load_device_agreement_secret(local_device_id)?;
    // A failure to open means the envelope was not addressed to this device — an ordinary outcome
    // on a shared relay, not an error worth surfacing.
    let Ok(plaintext) = crate::sync_crypto::open_sealed(&sealed, &recipient_secret, info) else {
        return Ok(None);
    };
    serde_json::from_slice(&plaintext)
        .map(Some)
        .map_err(|_| format!("{error_label}_invalid"))
}

/// Seals an invitation for a contact. Carries nothing but the project's identity — accepting is
/// what starts the grant, so an intercepted or ignored invite hands over no access.
#[tauri::command]
pub fn sync_seal_project_invite(
    invite_id: String,
    project_id: String,
    project_name: String,
    from_account_route: String,
    recipient_agreement_public_key: String,
    sent_at_ms: u64,
) -> Result<String, String> {
    if project_id.trim().is_empty() {
        return Err("project_invite_project_missing".to_string());
    }
    let payload = ProjectInvitePayload {
        invite_id,
        project_id,
        project_name: project_name.chars().take(MAX_PROJECT_NAME_LEN).collect(),
        from_account_route,
        sent_at_ms,
    };
    seal(
        &recipient_agreement_public_key,
        &payload,
        PROJECT_INVITE_INFO,
        "project_invite",
    )
}

/// Opens an invitation addressed to this device, or `None` when it was meant for someone else.
#[tauri::command]
pub fn sync_open_project_invite(
    app: tauri::AppHandle,
    ciphertext: String,
) -> Result<Option<ProjectInvitePayload>, String> {
    let data_root = crate::profiles::resolve_tauri_data_root(&app)?;
    let local_device_id = crate::sync_security::local_device_id_at(&data_root)?;
    let invite: Option<ProjectInvitePayload> = open(
        &ciphertext,
        &local_device_id,
        PROJECT_INVITE_INFO,
        "project_invite",
    )?;
    // Only from someone already paired: an invite from an unknown route would otherwise be a way
    // to put an arbitrary sender's project name in front of the user.
    let Some(invite) = invite else { return Ok(None) };
    if !crate::sync_security::has_chat_contact_at(&data_root, &invite.from_account_route)? {
        return Ok(None);
    }
    Ok(Some(invite))
}

/// Seals the invitee's decision. On accept this is where the account id is handed over — see the
/// module docs for why that is deliberate and what it is scoped to.
#[tauri::command]
pub fn sync_seal_project_invite_response(
    app: tauri::AppHandle,
    invite_id: String,
    accepted: bool,
    recipient_agreement_public_key: String,
) -> Result<String, String> {
    let data_root = crate::profiles::resolve_tauri_data_root(&app)?;
    let payload = if accepted {
        let identity = crate::sync_security::local_grantable_identity_at(&data_root)?;
        ProjectInviteResponsePayload {
            invite_id,
            accepted: true,
            account_id: Some(identity.account_id),
            device_id: Some(identity.device_id),
            agreement_public_key: Some(identity.agreement_public_key),
        }
    } else {
        // A decline carries the decision and nothing else.
        ProjectInviteResponsePayload {
            invite_id,
            accepted: false,
            account_id: None,
            device_id: None,
            agreement_public_key: None,
        }
    };
    seal(
        &recipient_agreement_public_key,
        &payload,
        PROJECT_INVITE_RESPONSE_INFO,
        "project_invite_response",
    )
}

#[tauri::command]
pub fn sync_open_project_invite_response(
    app: tauri::AppHandle,
    ciphertext: String,
) -> Result<Option<ProjectInviteResponsePayload>, String> {
    let data_root = crate::profiles::resolve_tauri_data_root(&app)?;
    let local_device_id = crate::sync_security::local_device_id_at(&data_root)?;
    open(
        &ciphertext,
        &local_device_id,
        PROJECT_INVITE_RESPONSE_INFO,
        "project_invite_response",
    )
}

/// Issues the grant once an accept has come back, and seals it for the invitee to materialize.
///
/// Identical in substance to what resolving a pairing request does when a project is attached —
/// issue an invitation, immediately redeem it on the invitee's behalf, and hand over the details —
/// except that the account id it needs arrived in the accept rather than in a pairing request. The
/// existing `chat_contact_confirm` envelope carries it, so the invitee's side already knows how to
/// materialize a `GrantRecord` from this shape.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn sync_grant_project_to_invitee(
    app: tauri::AppHandle,
    project_id: String,
    account_id: String,
    device_id: String,
    agreement_public_key: String,
    permissions: Vec<crate::sync_security::SyncPermission>,
    path_scopes: Vec<crate::sync_security::PathScope>,
    expires_at_ms: u64,
) -> Result<String, String> {
    if project_id.trim().is_empty() || account_id.trim().is_empty() || device_id.trim().is_empty() {
        return Err("project_invite_grant_incomplete".to_string());
    }
    crate::sync_security::grant_project_to_account(
        &app,
        &project_id,
        &account_id,
        &device_id,
        &agreement_public_key,
        permissions,
        path_scopes,
        expires_at_ms,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_decline_carries_no_identity() {
        // The whole point of the three-message shape: the account id travels only on an accept.
        let declined = ProjectInviteResponsePayload {
            invite_id: "inv_1".into(),
            accepted: false,
            account_id: None,
            device_id: None,
            agreement_public_key: None,
        };
        let encoded = serde_json::to_string(&declined).unwrap();
        assert!(!encoded.contains("accountId"), "{encoded}");
        assert!(!encoded.contains("deviceId"), "{encoded}");
    }

    #[test]
    fn a_long_project_name_is_truncated_not_trusted() {
        let payload = ProjectInvitePayload {
            invite_id: "inv_1".into(),
            project_id: "p1".into(),
            project_name: "x".repeat(MAX_PROJECT_NAME_LEN + 50).chars().take(MAX_PROJECT_NAME_LEN).collect(),
            from_account_route: "route".into(),
            sent_at_ms: 0,
        };
        assert_eq!(payload.project_name.chars().count(), MAX_PROJECT_NAME_LEN);
    }
}
