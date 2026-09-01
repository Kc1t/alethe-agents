use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use ed25519_dalek::{SigningKey, VerifyingKey};
use rand_core::OsRng;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

const SECURITY_SCHEMA_VERSION: u32 = 1;
const DEVICE_KEY_SERVICE: &str = "com.kc1t.alethe.sync-device";
const MAX_AUDIT_EVENTS: usize = 2_000;
const INVITATION_TOKEN_BYTES: usize = 32;
const MAX_INVITATION_FAILURES: u32 = 5;
const INVITATION_LOCKOUT_MS: u64 = 60_000;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifiedAccount {
    pub account_id: String,
    pub provider: String,
    pub display_name: String,
    pub email_hint: Option<String>,
    pub connected_at_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeviceTrust {
    Pending,
    Trusted,
    Revoked,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceRecord {
    pub device_id: String,
    pub account_id: String,
    pub display_name: String,
    pub public_key: String,
    pub public_key_fingerprint: String,
    pub trust: DeviceTrust,
    pub registered_at_ms: u64,
    pub last_verified_at_ms: Option<u64>,
    pub revoked_at_ms: Option<u64>,
    /// X25519 key-agreement public key, bound to `public_key` (ADR-0003). Absent only for
    /// device records persisted before this binding existed.
    #[serde(default)]
    pub agreement_public_key: Option<String>,
    #[serde(default)]
    pub agreement_key_bound_at_ms: Option<u64>,
    /// Ed25519 signature (by `public_key`) over the agreement-key binding, proving the two keys
    /// belong to the same device. See `sync_crypto::verify_key_binding`.
    #[serde(default)]
    pub agreement_key_binding_signature: Option<String>,
    /// Set the last time this device's Ed25519 identity and X25519 agreement keys were rotated
    /// via `rotate_device_keys_at` (Phase 12). `None` means the device has never rotated its keys
    /// since registration.
    #[serde(default)]
    pub key_rotated_at_ms: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecurityAuditEvent {
    pub sequence: u64,
    pub occurred_at_ms: u64,
    pub kind: String,
    pub actor_device_id: Option<String>,
    pub target_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SyncPermission {
    Read,
    Export,
    Write,
    Upload,
    Delete,
    Invite,
    Admin,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScopeEffect {
    Allow,
    Deny,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathScope {
    pub effect: ScopeEffect,
    pub pattern: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InvitationState {
    Created,
    Redeemed,
    Expired,
    Revoked,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InvitationRecord {
    pub invitation_id: String,
    pub project_id: String,
    pub issuer_device_id: String,
    pub recipient_account_id: String,
    pub recipient_device_id: Option<String>,
    pub permissions: Vec<SyncPermission>,
    pub path_scopes: Vec<PathScope>,
    pub token_hash: String,
    pub state: InvitationState,
    pub created_at_ms: u64,
    pub expires_at_ms: u64,
    pub redeemed_at_ms: Option<u64>,
    pub revoked_at_ms: Option<u64>,
    #[serde(default)]
    pub failed_attempts: u32,
    #[serde(default)]
    pub blocked_until_ms: Option<u64>,
    /// The project owner's raw Google account id (never a bearer secret) — lets a recipient later
    /// address a `sync_suggest_project_collaborator` proposal back to the right account. Empty on
    /// invitations created before this field existed; those simply can't be used to suggest a new
    /// collaborator (no project-authorization code reads this field for anything else).
    #[serde(default)]
    pub owner_account_id: String,
    /// The project owner's X25519 agreement public key (base64url, no padding) at the moment this
    /// invitation was issued — lets a recipient seal a `sync_suggest_project_collaborator` proposal
    /// end-to-end for the owner without an extra lookup round-trip. Empty on invitations created
    /// before this field existed or redeemed cross-device before the issuer's key was threaded
    /// through; those simply can't be used to suggest a new collaborator.
    #[serde(default)]
    pub owner_agreement_public_key: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrantRecord {
    pub grant_id: String,
    pub invitation_id: String,
    pub project_id: String,
    pub account_id: String,
    pub device_id: String,
    pub permissions: Vec<SyncPermission>,
    pub path_scopes: Vec<PathScope>,
    pub issued_at_ms: u64,
    pub expires_at_ms: Option<u64>,
    pub revoked_at_ms: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InvitationSummary {
    pub invitation_id: String,
    pub project_id: String,
    pub issuer_device_id: String,
    pub recipient_account_id: String,
    pub recipient_device_id: Option<String>,
    pub permissions: Vec<SyncPermission>,
    pub path_scopes: Vec<PathScope>,
    pub state: InvitationState,
    pub created_at_ms: u64,
    pub expires_at_ms: u64,
    pub redeemed_at_ms: Option<u64>,
    pub revoked_at_ms: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncSecuritySnapshot {
    pub schema_version: u32,
    pub account: Option<VerifiedAccount>,
    pub devices: Vec<DeviceRecord>,
    pub local_device_id: Option<String>,
    pub invitations: Vec<InvitationSummary>,
    pub grants: Vec<GrantRecord>,
    pub audit: Vec<SecurityAuditEvent>,
}

/// Truthful, backend-derived capability state (Phase 3 Step 3.7). The frontend may present
/// reasons for an unavailable capability but can never promote one by changing local
/// preferences — every value here is recomputed from real persisted state on every call.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CapabilityState {
    Unavailable,
    Experimental,
    Available,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncCapabilities {
    pub protocol_version: u32,
    /// A Google account has been verified locally (real OAuth + ID token validation).
    pub identity: CapabilityState,
    /// This specific device is `Trusted` for the verified account.
    pub device_trust: CapabilityState,
    /// Local invitation issue/list/revoke is real and tested, but delivery between physical
    /// machines does not exist yet (Phase 10), so this never reports `available`.
    pub invitations: CapabilityState,
    pub project_transfer: CapabilityState,
    pub shared_tasks: CapabilityState,
    pub project_chat: CapabilityState,
    /// Whether an authenticated, cryptographically verified peer transport is active. Always
    /// `false` until Phase 4 exists — never inferred from key presence alone.
    pub verified_encryption: bool,
}

fn unavailable_capabilities() -> SyncCapabilities {
    SyncCapabilities {
        protocol_version: crate::sync_protocol::PROTOCOL_VERSION,
        identity: CapabilityState::Unavailable,
        device_trust: CapabilityState::Unavailable,
        invitations: CapabilityState::Unavailable,
        project_transfer: CapabilityState::Unavailable,
        shared_tasks: CapabilityState::Unavailable,
        project_chat: CapabilityState::Unavailable,
        verified_encryption: false,
    }
}

/// Derives every collaboration capability from real persisted state. Never returns `available`
/// for a capability whose backend implementation does not exist yet.
pub fn resolve_capabilities_at(data_root: &Path) -> Result<SyncCapabilities, String> {
    let document = load_at(data_root)?;
    let Some(_account) = document.account.as_ref() else {
        return Ok(unavailable_capabilities());
    };
    let local_device = document
        .local_device_id
        .as_ref()
        .and_then(|id| document.devices.iter().find(|device| &device.device_id == id));
    let is_trusted = local_device.is_some_and(|device| device.trust == DeviceTrust::Trusted);

    Ok(SyncCapabilities {
        protocol_version: crate::sync_protocol::PROTOCOL_VERSION,
        identity: CapabilityState::Available,
        device_trust: if is_trusted {
            CapabilityState::Available
        } else {
            CapabilityState::Unavailable
        },
        invitations: if is_trusted {
            CapabilityState::Experimental
        } else {
            CapabilityState::Unavailable
        },
        project_transfer: CapabilityState::Unavailable,
        shared_tasks: CapabilityState::Unavailable,
        project_chat: CapabilityState::Unavailable,
        verified_encryption: false,
    })
}

#[tauri::command]
pub fn sync_resolve_capabilities(app: tauri::AppHandle) -> Result<SyncCapabilities, String> {
    let data_root = crate::profiles::resolve_tauri_data_root(&app)?;
    resolve_capabilities_at(&data_root)
}

/// A chat-only contact, established via `sync_add_chat_contact` (pairing-code identity exchange,
/// same verification as `sync_verify_discovered_device`) — deliberately carries no permission,
/// project, or scope field. No project-authorization code path (`issue_invitation`,
/// `redeem_invitation`, grant checks) ever reads this list; it exists only so
/// `find_trusted_device_for_account_route_at`/`is_peer_trusted_for_p2p` have a second, completely
/// separate source of P2P trust that never implies project access.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatContactRecord {
    pub account_route: String,
    pub device_id: String,
    pub agreement_public_key: String,
    pub display_label: String,
    pub added_at_ms: u64,
    /// A small downscaled profile-picture thumbnail for this contact, if known — set at pairing
    /// time from the pairing code's own `avatar_thumbnail`, and refreshed later whenever an
    /// `"avatar_update"` envelope arrives from them (see `sync_apply_avatar_update`). `None` if
    /// they have no picture set, or none has been received yet.
    #[serde(default)]
    pub avatar_thumbnail: Option<String>,
    /// This contact's short self-written bio, if known — unlike `avatar_thumbnail`, never seeded
    /// from the pairing code (bios are set later, in Preferences, not at pairing time); only ever
    /// arrives via a `"bio_update"` envelope from them (see `sync_open_bio_update`). Read-only from
    /// this side by construction — nothing on this device ever writes another contact's `bio`,
    /// only its own, which lives in local `Preferences`, not here.
    #[serde(default)]
    pub bio: Option<String>,
}

/// An invite ticket embedded in an exported pairing code (`sync_export_pairing_code`). Generating a
/// fresh one invalidates every previous unconsumed token for this device — only one code is ever
/// "live" at a time — and it's marked consumed the moment a `chat_contact_ack` from the other side
/// is opened (`sync_open_chat_contact_ack`), which is what queues the pairing request for the
/// issuer's review (see `PendingChatContactRequest`) instead of adding the contact outright.
///
/// Single-use is enforced on the issuing device (`consume_chat_invite_token_at` fails closed on
/// replay/expiry/forgery); the redeeming side additionally never commits the contact until the
/// issuer explicitly resolves the queued request and a `chat_contact_confirm` envelope actually
/// reaches them back (`sync_open_chat_contact_confirm`, `AddChatContactModal.tsx`'s
/// `waitForConfirmation`) — so a pasted-around code alone is not enough to become anyone's contact.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatInviteToken {
    pub token: String,
    pub created_at_ms: u64,
    pub expires_at_ms: u64,
    #[serde(default)]
    pub consumed_at_ms: Option<u64>,
}

/// A pairing request awaiting the issuer's review — created when a `chat_contact_ack` is opened
/// (`sync_open_chat_contact_ack`) instead of committing the contact automatically. Lets the issuer
/// decide, per person, whether to just add them as a chat contact or also grant them access to one
/// of their projects, and scales to several people asking at once (a queue, not a single blocking
/// prompt) — see `PairingRequestsPanel.tsx`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingChatContactRequest {
    pub request_id: String,
    /// The raw Google account id (`sub`) of whoever sent the ack — never exposed to the frontend;
    /// only used server-side if the issuer later chooses to grant project access (`GrantRecord`
    /// requires the real account id, not just its one-way `account_route` hash — ADR-0004).
    pub account_id: String,
    pub account_route: String,
    pub device_id: String,
    pub agreement_public_key: String,
    pub display_label: String,
    #[serde(default)]
    pub avatar_thumbnail: Option<String>,
    pub received_at_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncSecurityDocument {
    pub schema_version: u32,
    pub account: Option<VerifiedAccount>,
    pub devices: Vec<DeviceRecord>,
    /// The device record created by this install, used to resolve the acting device for
    /// every device-management operation. Never inferred from frontend-supplied input.
    #[serde(default)]
    pub local_device_id: Option<String>,
    #[serde(default)]
    pub invitations: Vec<InvitationRecord>,
    #[serde(default)]
    pub grants: Vec<GrantRecord>,
    /// See `ChatContactRecord` — never consulted by any project-authorization code.
    #[serde(default)]
    pub chat_contacts: Vec<ChatContactRecord>,
    /// See `ChatInviteToken`.
    #[serde(default)]
    pub chat_invite_tokens: Vec<ChatInviteToken>,
    /// See `PendingChatContactRequest`.
    #[serde(default)]
    pub pending_chat_contact_requests: Vec<PendingChatContactRequest>,
    pub audit: Vec<SecurityAuditEvent>,
}

impl Default for SyncSecurityDocument {
    fn default() -> Self {
        Self {
            schema_version: SECURITY_SCHEMA_VERSION,
            account: None,
            devices: Vec::new(),
            local_device_id: None,
            invitations: Vec::new(),
            grants: Vec::new(),
            chat_contacts: Vec::new(),
            chat_invite_tokens: Vec::new(),
            pending_chat_contact_requests: Vec::new(),
            audit: Vec::new(),
        }
    }
}

pub trait DeviceSecretStore {
    fn set(&self, device_id: &str, secret: &[u8]) -> Result<(), String>;
    fn delete(&self, device_id: &str) -> Result<(), String>;
}

/// Credential-store entry name for a device's X25519 agreement private key, kept distinct from
/// the Ed25519 identity entry (`device_id`) but deleted alongside it on every revocation path.
pub fn agreement_secret_entry_id(device_id: &str) -> String {
    format!("{device_id}#agree")
}

pub struct PlatformDeviceSecretStore;

/// Loads the local Ed25519 device identity only into process memory for an authenticated
/// operation. The raw key is never serialized, logged, or returned through IPC.
pub fn load_device_signing_key(device_id: &str) -> Result<SigningKey, String> {
    let entry = keyring::Entry::new(DEVICE_KEY_SERVICE, device_id)
        .map_err(|_| "credential_store_unavailable".to_string())?;
    let secret = entry
        .get_secret()
        .map_err(|_| "credential_store_read_failed".to_string())?;
    let bytes: [u8; 32] = secret
        .as_slice()
        .try_into()
        .map_err(|_| "device_private_key_invalid".to_string())?;
    Ok(SigningKey::from_bytes(&bytes))
}

/// Loads the local device's X25519 agreement private key (ADR-0003) only into process memory for
/// an authenticated operation. Mirrors `load_device_signing_key` but reads the separate
/// `#agree`-suffixed credential-store entry (`agreement_secret_entry_id`).
pub fn load_device_agreement_secret(device_id: &str) -> Result<x25519_dalek::StaticSecret, String> {
    let entry = keyring::Entry::new(DEVICE_KEY_SERVICE, &agreement_secret_entry_id(device_id))
        .map_err(|_| "credential_store_unavailable".to_string())?;
    let secret = entry.get_secret().map_err(|_| "credential_store_read_failed".to_string())?;
    let bytes: [u8; 32] =
        secret.as_slice().try_into().map_err(|_| "device_agreement_key_invalid".to_string())?;
    Ok(x25519_dalek::StaticSecret::from(bytes))
}

impl DeviceSecretStore for PlatformDeviceSecretStore {
    fn set(&self, device_id: &str, secret: &[u8]) -> Result<(), String> {
        let entry = keyring::Entry::new(DEVICE_KEY_SERVICE, device_id)
            .map_err(|_| "credential_store_unavailable".to_string())?;
        entry
            .set_secret(secret)
            .map_err(|_| "credential_store_write_failed".to_string())
    }

    fn delete(&self, device_id: &str) -> Result<(), String> {
        let entry = keyring::Entry::new(DEVICE_KEY_SERVICE, device_id)
            .map_err(|_| "credential_store_unavailable".to_string())?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err("credential_store_delete_failed".to_string()),
        }
    }
}

pub fn security_document_path(data_root: &Path) -> PathBuf {
    data_root.join("sync").join("security-v1.json")
}

pub fn load_at(data_root: &Path) -> Result<SyncSecurityDocument, String> {
    let path = security_document_path(data_root);
    if !path.exists() {
        return Ok(SyncSecurityDocument::default());
    }
    let bytes = fs::read(&path).map_err(|_| "security_document_read_failed".to_string())?;
    let document: SyncSecurityDocument =
        serde_json::from_slice(&bytes).map_err(|_| "security_document_invalid".to_string())?;
    validate_document(&document)?;
    Ok(document)
}

pub fn snapshot_at(data_root: &Path) -> Result<SyncSecuritySnapshot, String> {
    let document = load_at(data_root)?;
    Ok(SyncSecuritySnapshot {
        schema_version: document.schema_version,
        account: document.account,
        devices: document.devices,
        local_device_id: document.local_device_id,
        invitations: document
            .invitations
            .into_iter()
            .map(|invitation| InvitationSummary {
                invitation_id: invitation.invitation_id,
                project_id: invitation.project_id,
                issuer_device_id: invitation.issuer_device_id,
                recipient_account_id: invitation.recipient_account_id,
                recipient_device_id: invitation.recipient_device_id,
                permissions: invitation.permissions,
                path_scopes: invitation.path_scopes,
                state: invitation.state,
                created_at_ms: invitation.created_at_ms,
                expires_at_ms: invitation.expires_at_ms,
                redeemed_at_ms: invitation.redeemed_at_ms,
                revoked_at_ms: invitation.revoked_at_ms,
            })
            .collect(),
        grants: document.grants,
        audit: document.audit,
    })
}

#[tauri::command]
pub fn sync_security_snapshot(app: tauri::AppHandle) -> Result<SyncSecuritySnapshot, String> {
    let data_root = crate::profiles::resolve_tauri_data_root(&app)?;
    snapshot_at(&data_root)
}

pub fn local_device_id_at(data_root: &Path) -> Result<String, String> {
    load_at(data_root)?
        .local_device_id
        .ok_or_else(|| "local_device_unknown".to_string())
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalIdentity {
    pub device_id: String,
    pub account_route: String,
}

/// Resolves this install's own device ID and account route (ADR-0004) directly from the local
/// security document — used by collaboration features (tasks, chat) so the frontend never has to
/// know or supply the account-route derivation itself.
pub fn local_identity_at(data_root: &Path) -> Result<LocalIdentity, String> {
    let document = load_at(data_root)?;
    let device_id = document.local_device_id.ok_or_else(|| "local_device_unknown".to_string())?;
    let account = document.account.ok_or_else(|| "account_not_connected".to_string())?;
    Ok(LocalIdentity {
        device_id,
        account_route: crate::sync_protocol::account_route_id(&account.account_id),
    })
}

#[tauri::command]
pub fn sync_local_identity(app: tauri::AppHandle) -> Result<LocalIdentity, String> {
    let data_root = crate::profiles::resolve_tauri_data_root(&app)?;
    local_identity_at(&data_root)
}

/// Resolves this install's own X25519 agreement *public* key (base64, ADR-0003) — used to add the
/// local device as a chat conversation member. Never touches the private key or the keyring.
pub fn local_device_agreement_public_key_at(data_root: &Path) -> Result<Vec<u8>, String> {
    let document = load_at(data_root)?;
    let device_id = document.local_device_id.clone().ok_or_else(|| "local_device_unknown".to_string())?;
    let device = document
        .devices
        .iter()
        .find(|device| device.device_id == device_id)
        .ok_or_else(|| "local_device_unknown".to_string())?;
    let encoded = device
        .agreement_public_key
        .as_deref()
        .ok_or_else(|| "device_agreement_key_missing".to_string())?;
    URL_SAFE_NO_PAD.decode(encoded).map_err(|_| "device_agreement_key_invalid".to_string())
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

#[tauri::command]
pub fn sync_approve_device(
    app: tauri::AppHandle,
    target_device_id: String,
) -> Result<DeviceRecord, String> {
    let data_root = crate::profiles::resolve_tauri_data_root(&app)?;
    let actor = local_device_id_at(&data_root)?;
    approve_device_at(&data_root, &actor, &target_device_id, now_ms())
}

#[tauri::command]
pub fn sync_reject_device(app: tauri::AppHandle, target_device_id: String) -> Result<(), String> {
    let data_root = crate::profiles::resolve_tauri_data_root(&app)?;
    let actor = local_device_id_at(&data_root)?;
    reject_device_at(
        &data_root,
        &PlatformDeviceSecretStore,
        &actor,
        &target_device_id,
        now_ms(),
    )
}

#[tauri::command]
pub fn sync_rename_device(
    app: tauri::AppHandle,
    display_name: String,
) -> Result<DeviceRecord, String> {
    let data_root = crate::profiles::resolve_tauri_data_root(&app)?;
    let actor = local_device_id_at(&data_root)?;
    rename_device_at(&data_root, &actor, &display_name, now_ms())
}

#[tauri::command]
pub fn sync_revoke_device(
    app: tauri::AppHandle,
    target_device_id: String,
) -> Result<DeviceRecord, String> {
    let data_root = crate::profiles::resolve_tauri_data_root(&app)?;
    let actor = local_device_id_at(&data_root)?;
    revoke_device_at(
        &data_root,
        &PlatformDeviceSecretStore,
        &actor,
        &target_device_id,
        now_ms(),
    )
}

#[tauri::command]
pub fn sync_remove_device(app: tauri::AppHandle, target_device_id: String) -> Result<(), String> {
    let data_root = crate::profiles::resolve_tauri_data_root(&app)?;
    let actor = local_device_id_at(&data_root)?;
    remove_device_at(&data_root, &actor, &target_device_id, now_ms())
}

fn validate_document(document: &SyncSecurityDocument) -> Result<(), String> {
    if document.schema_version != SECURITY_SCHEMA_VERSION {
        return Err("security_schema_unsupported".to_string());
    }
    if let Some(account) = &document.account {
        if account.account_id.trim().is_empty() || account.display_name.trim().is_empty() {
            return Err("security_account_invalid".to_string());
        }
    }
    for device in &document.devices {
        if device.device_id.trim().is_empty()
            || device.public_key.trim().is_empty()
            || document
                .account
                .as_ref()
                .is_none_or(|account| account.account_id != device.account_id)
        {
            return Err("security_device_invalid".to_string());
        }
    }
    for invitation in &document.invitations {
        if invitation.invitation_id.trim().is_empty()
            || invitation.project_id.trim().is_empty()
            || invitation.recipient_account_id.trim().is_empty()
            || invitation.token_hash.len() != 64
            || validate_permissions(&invitation.permissions).is_err()
            || validate_scopes(&invitation.path_scopes).is_err()
        {
            return Err("security_invitation_invalid".to_string());
        }
    }
    for grant in &document.grants {
        if grant.grant_id.trim().is_empty()
            || grant.project_id.trim().is_empty()
            || grant.account_id.trim().is_empty()
            || grant.device_id.trim().is_empty()
            || validate_permissions(&grant.permissions).is_err()
            || validate_scopes(&grant.path_scopes).is_err()
        {
            return Err("security_grant_invalid".to_string());
        }
    }
    Ok(())
}

pub(crate) fn normalize_permissions(permissions: Vec<SyncPermission>) -> Vec<SyncPermission> {
    let mut normalized = permissions;
    let needs_read = normalized
        .iter()
        .any(|permission| matches!(permission, SyncPermission::Export | SyncPermission::Write));
    if needs_read && !normalized.contains(&SyncPermission::Read) {
        normalized.push(SyncPermission::Read);
    }
    normalized.sort_by_key(|permission| format!("{permission:?}"));
    normalized.dedup();
    normalized
}

fn validate_permissions(permissions: &[SyncPermission]) -> Result<(), String> {
    if permissions.is_empty() {
        return Err("permission_set_empty".to_string());
    }
    let has_read = permissions.contains(&SyncPermission::Read);
    if (permissions.contains(&SyncPermission::Export)
        || permissions.contains(&SyncPermission::Write))
        && !has_read
    {
        return Err("permission_dependency_missing".to_string());
    }
    Ok(())
}

fn validate_scopes(scopes: &[PathScope]) -> Result<(), String> {
    for scope in scopes {
        let path = scope.pattern.strip_suffix("/**").unwrap_or(&scope.pattern);
        if path.is_empty()
            || path.starts_with('/')
            || path.contains('\\')
            || path
                .split('/')
                .any(|component| component.is_empty() || component == "." || component == "..")
        {
            return Err("path_scope_invalid".to_string());
        }
    }
    Ok(())
}

#[cfg(windows)]
fn replace_file(source: &Path, destination: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let result = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err("security_document_commit_failed".to_string())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn replace_file(source: &Path, destination: &Path) -> Result<(), String> {
    fs::rename(source, destination).map_err(|_| "security_document_commit_failed".to_string())
}

fn save_at(data_root: &Path, document: &SyncSecurityDocument) -> Result<(), String> {
    validate_document(document)?;
    let path = security_document_path(data_root);
    let parent = path
        .parent()
        .ok_or_else(|| "security_document_path_invalid".to_string())?;
    fs::create_dir_all(parent).map_err(|_| "security_document_directory_failed".to_string())?;
    let temporary = parent.join(format!(".security-{}.tmp", nanoid::nanoid!(12)));
    let bytes = serde_json::to_vec_pretty(document)
        .map_err(|_| "security_document_serialize_failed".to_string())?;
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)
        .map_err(|_| "security_document_write_failed".to_string())?;
    if file
        .write_all(&bytes)
        .and_then(|_| file.sync_all())
        .is_err()
    {
        let _ = fs::remove_file(&temporary);
        return Err("security_document_write_failed".to_string());
    }
    replace_file(&temporary, &path).map_err(|error| {
        let _ = fs::remove_file(&temporary);
        error
    })?;
    if let Ok(directory) = OpenOptions::new().read(true).open(parent) {
        let _ = directory.sync_all();
    }
    Ok(())
}

fn append_audit(
    document: &mut SyncSecurityDocument,
    occurred_at_ms: u64,
    kind: &str,
    actor_device_id: Option<String>,
    target_id: Option<String>,
) {
    let sequence = document.audit.last().map_or(1, |event| event.sequence + 1);
    document.audit.push(SecurityAuditEvent {
        sequence,
        occurred_at_ms,
        kind: kind.to_string(),
        actor_device_id,
        target_id,
    });
    if document.audit.len() > MAX_AUDIT_EVENTS {
        document
            .audit
            .drain(0..document.audit.len() - MAX_AUDIT_EVENTS);
    }
}

fn public_key_fingerprint(key: &VerifyingKey) -> String {
    let digest = Sha256::digest(key.as_bytes());
    digest[..16]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn token_hash(token: &[u8]) -> String {
    Sha256::digest(token)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn hashes_equal(left: &str, right: &str) -> bool {
    let mut difference = left.len() ^ right.len();
    for index in 0..left.len().max(right.len()) {
        difference |= usize::from(
            left.as_bytes().get(index).copied().unwrap_or_default()
                ^ right.as_bytes().get(index).copied().unwrap_or_default(),
        );
    }
    difference == 0
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IssuedInvitation {
    pub invitation: InvitationRecord,
    pub bearer_token: String,
}

pub(crate) fn issue_invitation(
    data_root: &Path,
    issuer_device_id: &str,
    project_id: &str,
    recipient_account_id: &str,
    recipient_device_id: Option<String>,
    permissions: Vec<SyncPermission>,
    path_scopes: Vec<PathScope>,
    now_ms: u64,
    expires_at_ms: u64,
) -> Result<IssuedInvitation, String> {
    if project_id.trim().is_empty()
        || recipient_account_id.trim().is_empty()
        || expires_at_ms <= now_ms
    {
        return Err("invitation_request_invalid".to_string());
    }
    validate_permissions(&permissions)?;
    validate_scopes(&path_scopes)?;
    let mut document = load_at(data_root)?;
    let issuer = document
        .devices
        .iter()
        .find(|device| device.device_id == issuer_device_id)
        .ok_or_else(|| "issuer_device_unknown".to_string())?;
    if issuer.trust != DeviceTrust::Trusted {
        return Err("issuer_device_not_trusted".to_string());
    }

    let mut secret = [0_u8; INVITATION_TOKEN_BYTES];
    use rand_core::RngCore;
    OsRng.fill_bytes(&mut secret);
    let bearer_token = URL_SAFE_NO_PAD.encode(secret);
    let invitation = InvitationRecord {
        invitation_id: format!("inv_{}", nanoid::nanoid!(24)),
        project_id: project_id.to_string(),
        issuer_device_id: issuer_device_id.to_string(),
        recipient_account_id: recipient_account_id.to_string(),
        recipient_device_id,
        permissions,
        path_scopes,
        token_hash: token_hash(bearer_token.as_bytes()),
        state: InvitationState::Created,
        created_at_ms: now_ms,
        expires_at_ms,
        redeemed_at_ms: None,
        revoked_at_ms: None,
        failed_attempts: 0,
        blocked_until_ms: None,
        owner_account_id: document.account.as_ref().map(|account| account.account_id.clone()).unwrap_or_default(),
        owner_agreement_public_key: issuer.agreement_public_key.clone().unwrap_or_default(),
    };
    document.invitations.push(invitation.clone());
    append_audit(
        &mut document,
        now_ms,
        "invitation.issued",
        Some(issuer_device_id.to_string()),
        Some(invitation.invitation_id.clone()),
    );
    save_at(data_root, &document)?;
    Ok(IssuedInvitation {
        invitation,
        bearer_token,
    })
}

pub(crate) fn redeem_invitation(
    data_root: &Path,
    invitation_id: &str,
    bearer_token: &str,
    recipient_account_id: &str,
    recipient_device_id: &str,
    now_ms: u64,
) -> Result<GrantRecord, String> {
    let mut document = load_at(data_root)?;
    let index = document
        .invitations
        .iter()
        .position(|invitation| invitation.invitation_id == invitation_id)
        .ok_or_else(|| "invitation_unavailable".to_string())?;
    let invitation = &mut document.invitations[index];
    if invitation.state != InvitationState::Created
        || invitation.expires_at_ms < now_ms
        || invitation
            .blocked_until_ms
            .is_some_and(|blocked_until| blocked_until > now_ms)
    {
        return Err("invitation_unavailable".to_string());
    }
    let audience_matches = invitation.recipient_account_id == recipient_account_id
        && invitation
            .recipient_device_id
            .as_ref()
            .is_none_or(|device| device == recipient_device_id);
    let token_matches = hashes_equal(&invitation.token_hash, &token_hash(bearer_token.as_bytes()));
    if !audience_matches || !token_matches {
        invitation.failed_attempts = invitation.failed_attempts.saturating_add(1);
        if invitation.failed_attempts >= MAX_INVITATION_FAILURES {
            invitation.blocked_until_ms = Some(now_ms.saturating_add(INVITATION_LOCKOUT_MS));
            invitation.failed_attempts = 0;
        }
        save_at(data_root, &document)?;
        return Err("invitation_unavailable".to_string());
    }

    invitation.state = InvitationState::Redeemed;
    invitation.redeemed_at_ms = Some(now_ms);
    invitation.failed_attempts = 0;
    invitation.blocked_until_ms = None;
    let grant = GrantRecord {
        grant_id: format!("grant_{}", nanoid::nanoid!(24)),
        invitation_id: invitation.invitation_id.clone(),
        project_id: invitation.project_id.clone(),
        account_id: recipient_account_id.to_string(),
        device_id: recipient_device_id.to_string(),
        permissions: invitation.permissions.clone(),
        path_scopes: invitation.path_scopes.clone(),
        issued_at_ms: now_ms,
        expires_at_ms: Some(invitation.expires_at_ms),
        revoked_at_ms: None,
    };
    document.grants.push(grant.clone());
    append_audit(
        &mut document,
        now_ms,
        "invitation.redeemed",
        Some(recipient_device_id.to_string()),
        Some(invitation_id.to_string()),
    );
    save_at(data_root, &document)?;
    let _ = crate::sync_access::record_at(
        data_root,
        crate::sync_access::AccessCategory::Collaboration,
        crate::sync_access::AccessKind::InvitationRedeemed,
        invitation_id,
        now_ms,
    );
    Ok(grant)
}

/// Revokes an invitation before it is redeemed. Only a trusted device on the issuing
/// account may revoke it; it can no longer be redeemed once revoked.
pub(crate) fn revoke_invitation_at(
    data_root: &Path,
    actor_device_id: &str,
    invitation_id: &str,
    now_ms: u64,
) -> Result<InvitationRecord, String> {
    let mut document = load_at(data_root)?;
    let actor_account_id = find_trusted_actor(&document, actor_device_id)?.account_id.clone();
    let issuer_device_id = document
        .invitations
        .iter()
        .find(|invitation| invitation.invitation_id == invitation_id)
        .ok_or_else(|| "invitation_unavailable".to_string())?
        .issuer_device_id
        .clone();
    let issuer_account_matches = document
        .devices
        .iter()
        .find(|device| device.device_id == issuer_device_id)
        .is_some_and(|issuer| issuer.account_id == actor_account_id);
    if !issuer_account_matches {
        return Err("invitation_unavailable".to_string());
    }
    let invitation = document
        .invitations
        .iter_mut()
        .find(|invitation| invitation.invitation_id == invitation_id)
        .ok_or_else(|| "invitation_unavailable".to_string())?;
    if invitation.state != InvitationState::Created {
        return Err("invitation_not_revocable".to_string());
    }
    invitation.state = InvitationState::Revoked;
    invitation.revoked_at_ms = Some(now_ms);
    let updated = invitation.clone();
    append_audit(
        &mut document,
        now_ms,
        "invitation.revoked",
        Some(actor_device_id.to_string()),
        Some(invitation_id.to_string()),
    );
    save_at(data_root, &document)?;
    Ok(updated)
}

/// Revokes an active grant. Only a trusted device on the account that issued the
/// underlying invitation may revoke it.
pub(crate) fn revoke_grant_at(
    data_root: &Path,
    actor_device_id: &str,
    grant_id: &str,
    now_ms: u64,
) -> Result<GrantRecord, String> {
    let mut document = load_at(data_root)?;
    let actor = find_trusted_actor(&document, actor_device_id)?.clone();
    let grant_project_id = document
        .grants
        .iter()
        .find(|grant| grant.grant_id == grant_id)
        .ok_or_else(|| "grant_unavailable".to_string())?
        .project_id
        .clone();
    let issuer_owns_project = document.invitations.iter().any(|invitation| {
        invitation.project_id == grant_project_id
            && document
                .devices
                .iter()
                .any(|device| device.device_id == invitation.issuer_device_id && device.account_id == actor.account_id)
    });
    if !issuer_owns_project {
        return Err("grant_unavailable".to_string());
    }
    let grant = document
        .grants
        .iter_mut()
        .find(|grant| grant.grant_id == grant_id)
        .ok_or_else(|| "grant_unavailable".to_string())?;
    if grant.revoked_at_ms.is_some() {
        return Err("grant_already_revoked".to_string());
    }
    grant.revoked_at_ms = Some(now_ms);
    let updated = grant.clone();
    append_audit(
        &mut document,
        now_ms,
        "grant.revoked",
        Some(actor_device_id.to_string()),
        Some(grant_id.to_string()),
    );
    save_at(data_root, &document)?;
    Ok(updated)
}

/// Updates the `permissions`/`path_scopes` of an already-active grant in place — the only mutation
/// on a `GrantRecord` before this was full revocation (`revoke_grant_at`), which meant "editing" a
/// collaborator's access really meant revoking their grant and starting a whole new invitation from
/// scratch, losing continuity (a new `grant_id`, no record of what changed). Same authorization
/// rule as revocation: only a trusted device on the account that owns the project (i.e. issued the
/// invitation the grant came from) may narrow or widen it — a collaborator can never edit their own
/// or anyone else's grant.
pub(crate) fn update_grant_at(
    data_root: &Path,
    actor_device_id: &str,
    grant_id: &str,
    permissions: Vec<SyncPermission>,
    path_scopes: Vec<PathScope>,
    now_ms: u64,
) -> Result<GrantRecord, String> {
    validate_permissions(&permissions)?;
    validate_scopes(&path_scopes)?;
    let mut document = load_at(data_root)?;
    let actor = find_trusted_actor(&document, actor_device_id)?.clone();
    let grant_project_id = document
        .grants
        .iter()
        .find(|grant| grant.grant_id == grant_id)
        .ok_or_else(|| "grant_unavailable".to_string())?
        .project_id
        .clone();
    let issuer_owns_project = document.invitations.iter().any(|invitation| {
        invitation.project_id == grant_project_id
            && document
                .devices
                .iter()
                .any(|device| device.device_id == invitation.issuer_device_id && device.account_id == actor.account_id)
    });
    if !issuer_owns_project {
        return Err("grant_unavailable".to_string());
    }
    let grant = document
        .grants
        .iter_mut()
        .find(|grant| grant.grant_id == grant_id)
        .ok_or_else(|| "grant_unavailable".to_string())?;
    if grant.revoked_at_ms.is_some() {
        return Err("grant_already_revoked".to_string());
    }
    grant.permissions = permissions;
    grant.path_scopes = path_scopes;
    let updated = grant.clone();
    append_audit(
        &mut document,
        now_ms,
        "grant.updated",
        Some(actor_device_id.to_string()),
        Some(grant_id.to_string()),
    );
    save_at(data_root, &document)?;
    Ok(updated)
}

/// Lists every non-revoked grant for a specific project — the snapshot command returns every
/// grant across every project this account has ever issued or received, requiring the caller to
/// filter client-side. Scoped listing is what a per-project "collaborators" panel actually needs.
pub(crate) fn list_project_grants_at(data_root: &Path, project_id: &str) -> Result<Vec<GrantRecord>, String> {
    let document = load_at(data_root)?;
    Ok(document
        .grants
        .into_iter()
        .filter(|grant| grant.project_id == project_id && grant.revoked_at_ms.is_none())
        .collect())
}

/// Rotates a trusted device's Ed25519 identity key and X25519 agreement key together (Phase 12).
/// The device keeps the same `device_id`, but every peer that cached the old public key must
/// re-authenticate against the new one — nothing here notifies other devices; that is the caller's
/// responsibility once a live discovery/notification channel exists. Old key material is
/// overwritten in the credential store (never left retrievable alongside the new keys).
pub(crate) fn rotate_device_keys_at<S: DeviceSecretStore>(
    data_root: &Path,
    secret_store: &S,
    device_id: &str,
    now_ms: u64,
) -> Result<DeviceRecord, String> {
    let mut document = load_at(data_root)?;
    let index = document
        .devices
        .iter()
        .position(|device| device.device_id == device_id)
        .ok_or_else(|| "actor_device_unknown".to_string())?;
    if document.devices[index].trust != DeviceTrust::Trusted {
        return Err("actor_device_not_trusted".to_string());
    }

    let signing_key = SigningKey::generate(&mut OsRng);
    let verifying_key = signing_key.verifying_key();
    secret_store.set(device_id, &signing_key.to_bytes())?;
    let (agreement_secret, key_binding) =
        crate::sync_crypto::generate_bound_key_agreement(device_id, &signing_key, now_ms);
    if let Err(error) = secret_store.set(&agreement_secret_entry_id(device_id), &agreement_secret.to_bytes()) {
        return Err(error);
    }

    let device = &mut document.devices[index];
    device.public_key = URL_SAFE_NO_PAD.encode(verifying_key.as_bytes());
    device.public_key_fingerprint = public_key_fingerprint(&verifying_key);
    device.agreement_public_key = Some(URL_SAFE_NO_PAD.encode(&key_binding.x25519_public_key));
    device.agreement_key_bound_at_ms = Some(key_binding.bound_at_ms);
    device.agreement_key_binding_signature = Some(URL_SAFE_NO_PAD.encode(&key_binding.signature));
    device.key_rotated_at_ms = Some(now_ms);
    let updated = device.clone();
    append_audit(&mut document, now_ms, "device.keys_rotated", Some(device_id.to_string()), None);
    save_at(data_root, &document)?;
    Ok(updated)
}

/// Redacted, JSON-serializable export of the local account's collaboration state (Phase 12).
/// Never includes raw public-key bytes, invitation bearer/token-hash material, or anything else
/// the audit-privacy rule forbids ("no content, tokens, local paths, or encryption keys") — only
/// stable identifiers, fingerprints, states, and timestamps a user could plausibly want to review
/// or archive before deleting their account.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceExportEntry {
    pub device_id: String,
    pub display_name: String,
    pub public_key_fingerprint: String,
    pub trust: DeviceTrust,
    pub registered_at_ms: u64,
    pub last_verified_at_ms: Option<u64>,
    pub revoked_at_ms: Option<u64>,
    pub key_rotated_at_ms: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InvitationExportEntry {
    pub invitation_id: String,
    pub project_id: String,
    pub recipient_account_id: String,
    pub state: InvitationState,
    pub created_at_ms: u64,
    pub expires_at_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountDataExport {
    pub exported_at_ms: u64,
    pub account: Option<VerifiedAccount>,
    pub devices: Vec<DeviceExportEntry>,
    pub invitations: Vec<InvitationExportEntry>,
    pub grants: Vec<GrantRecord>,
}

pub(crate) fn export_account_data_at(data_root: &Path, now_ms: u64) -> Result<AccountDataExport, String> {
    let document = load_at(data_root)?;
    Ok(AccountDataExport {
        exported_at_ms: now_ms,
        account: document.account,
        devices: document
            .devices
            .into_iter()
            .map(|device| DeviceExportEntry {
                device_id: device.device_id,
                display_name: device.display_name,
                public_key_fingerprint: device.public_key_fingerprint,
                trust: device.trust,
                registered_at_ms: device.registered_at_ms,
                last_verified_at_ms: device.last_verified_at_ms,
                revoked_at_ms: device.revoked_at_ms,
                key_rotated_at_ms: device.key_rotated_at_ms,
            })
            .collect(),
        invitations: document
            .invitations
            .into_iter()
            .map(|invitation| InvitationExportEntry {
                invitation_id: invitation.invitation_id,
                project_id: invitation.project_id,
                recipient_account_id: invitation.recipient_account_id,
                state: invitation.state,
                created_at_ms: invitation.created_at_ms,
                expires_at_ms: invitation.expires_at_ms,
            })
            .collect(),
        grants: document.grants,
    })
}

/// Revokes every still-active grant and pending invitation for one project in a single operation
/// (Phase 12's "project-access deletion"), rather than requiring the caller to revoke each one
/// individually. Only a device on the project's issuing account may call this — same ownership
/// check as `revoke_grant_at`. Returns the number of records changed; calling it again on an
/// already-cleared project is a safe no-op that returns `0`, not an error.
pub(crate) fn delete_project_access_at(
    data_root: &Path,
    actor_device_id: &str,
    project_id: &str,
    now_ms: u64,
) -> Result<usize, String> {
    let mut document = load_at(data_root)?;
    let actor = find_trusted_actor(&document, actor_device_id)?.clone();
    let issuer_owns_project = document.invitations.iter().any(|invitation| {
        invitation.project_id == project_id
            && document.devices.iter().any(|device| {
                device.device_id == invitation.issuer_device_id && device.account_id == actor.account_id
            })
    });
    if !issuer_owns_project {
        return Err("project_access_unavailable".to_string());
    }

    let mut affected = 0_usize;
    for grant in document.grants.iter_mut().filter(|grant| grant.project_id == project_id && grant.revoked_at_ms.is_none()) {
        grant.revoked_at_ms = Some(now_ms);
        affected += 1;
    }
    for invitation in document
        .invitations
        .iter_mut()
        .filter(|invitation| invitation.project_id == project_id && invitation.state == InvitationState::Created)
    {
        invitation.state = InvitationState::Revoked;
        invitation.revoked_at_ms = Some(now_ms);
        affected += 1;
    }
    append_audit(
        &mut document,
        now_ms,
        "project_access.deleted",
        Some(actor_device_id.to_string()),
        Some(project_id.to_string()),
    );
    save_at(data_root, &document)?;
    Ok(affected)
}


#[tauri::command]
pub fn sync_revoke_invitation(
    app: tauri::AppHandle,
    invitation_id: String,
) -> Result<InvitationRecord, String> {
    let data_root = crate::profiles::resolve_tauri_data_root(&app)?;
    let actor = local_device_id_at(&data_root)?;
    revoke_invitation_at(&data_root, &actor, &invitation_id, now_ms())
}

#[tauri::command]
pub fn sync_revoke_grant(app: tauri::AppHandle, grant_id: String) -> Result<GrantRecord, String> {
    let data_root = crate::profiles::resolve_tauri_data_root(&app)?;
    let actor = local_device_id_at(&data_root)?;
    revoke_grant_at(&data_root, &actor, &grant_id, now_ms())
}

#[tauri::command]
pub fn sync_update_grant(
    app: tauri::AppHandle,
    grant_id: String,
    permissions: Vec<SyncPermission>,
    path_scopes: Vec<PathScope>,
) -> Result<GrantRecord, String> {
    let data_root = crate::profiles::resolve_tauri_data_root(&app)?;
    let actor = local_device_id_at(&data_root)?;
    update_grant_at(&data_root, &actor, &grant_id, permissions, path_scopes, now_ms())
}

#[tauri::command]
pub fn sync_list_project_grants(app: tauri::AppHandle, project_id: String) -> Result<Vec<GrantRecord>, String> {
    let data_root = crate::profiles::resolve_tauri_data_root(&app)?;
    list_project_grants_at(&data_root, &project_id)
}

#[tauri::command]
pub fn sync_rotate_device_keys(app: tauri::AppHandle) -> Result<DeviceRecord, String> {
    let data_root = crate::profiles::resolve_tauri_data_root(&app)?;
    let device_id = local_device_id_at(&data_root)?;
    rotate_device_keys_at(&data_root, &PlatformDeviceSecretStore, &device_id, now_ms())
}

#[tauri::command]
pub fn sync_export_account_data(app: tauri::AppHandle) -> Result<AccountDataExport, String> {
    let data_root = crate::profiles::resolve_tauri_data_root(&app)?;
    export_account_data_at(&data_root, now_ms())
}

#[tauri::command]
pub fn sync_delete_project_access(app: tauri::AppHandle, project_id: String) -> Result<usize, String> {
    let data_root = crate::profiles::resolve_tauri_data_root(&app)?;
    let actor = local_device_id_at(&data_root)?;
    delete_project_access_at(&data_root, &actor, &project_id, now_ms())
}

/// Completes identity only after the OAuth backend has verified the provider response.
/// This function is intentionally not exposed as a Tauri or HTTP command.
pub(crate) fn complete_verified_identity<S: DeviceSecretStore>(
    data_root: &Path,
    secret_store: &S,
    account: VerifiedAccount,
    device_name: &str,
    now_ms: u64,
) -> Result<DeviceRecord, String> {
    if account.account_id.trim().is_empty() || device_name.trim().is_empty() {
        return Err("verified_identity_invalid".to_string());
    }
    let mut document = load_at(data_root)?;
    if document
        .account
        .as_ref()
        .is_some_and(|current| current.account_id != account.account_id)
        && !document.devices.is_empty()
    {
        return Err("account_switch_requires_disconnect".to_string());
    }

    // The first device registered for an account has no trusted peer available to approve
    // it, so it is trusted automatically. Every device after that requires explicit approval
    // from an already-trusted device (SYNC-INV-003).
    let is_first_device_for_account = document
        .devices
        .iter()
        .all(|device| device.account_id != account.account_id);
    let trust = if is_first_device_for_account {
        DeviceTrust::Trusted
    } else {
        DeviceTrust::Pending
    };

    let signing_key = SigningKey::generate(&mut OsRng);
    let verifying_key = signing_key.verifying_key();
    let device_id = format!("dev_{}", nanoid::nanoid!(24));
    secret_store.set(&device_id, &signing_key.to_bytes())?;
    let (agreement_secret, key_binding) =
        crate::sync_crypto::generate_bound_key_agreement(&device_id, &signing_key, now_ms);
    if let Err(error) = secret_store.set(
        &agreement_secret_entry_id(&device_id),
        &agreement_secret.to_bytes(),
    ) {
        let _ = secret_store.delete(&device_id);
        return Err(error);
    }
    let device = DeviceRecord {
        device_id: device_id.clone(),
        account_id: account.account_id.clone(),
        display_name: device_name.trim().to_string(),
        public_key: URL_SAFE_NO_PAD.encode(verifying_key.as_bytes()),
        public_key_fingerprint: public_key_fingerprint(&verifying_key),
        trust: trust.clone(),
        registered_at_ms: now_ms,
        last_verified_at_ms: if is_first_device_for_account {
            Some(now_ms)
        } else {
            None
        },
        revoked_at_ms: None,
        agreement_public_key: Some(URL_SAFE_NO_PAD.encode(&key_binding.x25519_public_key)),
        agreement_key_bound_at_ms: Some(key_binding.bound_at_ms),
        agreement_key_binding_signature: Some(URL_SAFE_NO_PAD.encode(&key_binding.signature)),
        key_rotated_at_ms: None,
    };
    document.account = Some(account);
    document.local_device_id = Some(device_id.clone());
    document.devices.push(device.clone());
    append_audit(
        &mut document,
        now_ms,
        if is_first_device_for_account {
            "device.registered_first_device_trusted"
        } else {
            "device.registered"
        },
        Some(device_id),
        None,
    );
    if let Err(error) = save_at(data_root, &document) {
        let _ = secret_store.delete(&device.device_id);
        let _ = secret_store.delete(&agreement_secret_entry_id(&device.device_id));
        return Err(error);
    }
    if !is_first_device_for_account {
        // Best-effort: a failure to publish the access-center record must never fail device
        // registration itself, which already succeeded and was persisted above.
        let _ = crate::sync_access::record_at(
            data_root,
            crate::sync_access::AccessCategory::Security,
            crate::sync_access::AccessKind::DevicePendingApproval,
            &device.device_id,
            now_ms,
        );
    }
    Ok(device)
}

pub(crate) fn disconnect_identity_at<S: DeviceSecretStore>(
    data_root: &Path,
    secret_store: &S,
) -> Result<(), String> {
    let document = load_at(data_root)?;
    for device in &document.devices {
        secret_store.delete(&device.device_id)?;
        secret_store.delete(&agreement_secret_entry_id(&device.device_id))?;
    }
    let path = security_document_path(data_root);
    if path.exists() {
        fs::remove_file(path).map_err(|_| "security_document_delete_failed".to_string())?;
    }
    Ok(())
}

/// Materializes an invitation delivered remotely (decrypted elsewhere, by
/// `sync_p2p_bridge.rs`/`sync_invitation_bridge.rs`) into this device's own local invitation
/// list, then redeems it through the existing `redeem_invitation` — closing the gap where a
/// recipient's `redeem_invitation` call would otherwise fail with `invitation_unavailable`
/// because the `InvitationRecord` only ever existed on the issuer's own separate document.
/// Safe to call more than once for the same `invitation_id` (a retried delivery, or the envelope
/// being drained twice): the record is inserted only the first time, and `redeem_invitation`'s own
/// single-use/expiry checks apply exactly as they would for a local redemption from then on — this
/// function adds no new authorization rule, it only satisfies an existing one's precondition.
pub(crate) fn redeem_remote_invitation_at(
    data_root: &Path,
    invitation_id: &str,
    bearer_token: &str,
    project_id: &str,
    permissions: Vec<SyncPermission>,
    path_scopes: Vec<PathScope>,
    expires_at_ms: u64,
    recipient_account_id: &str,
    recipient_device_id: &str,
    owner_account_id: &str,
    owner_agreement_public_key: &str,
    now_ms: u64,
) -> Result<GrantRecord, String> {
    let mut document = load_at(data_root)?;
    if !document.invitations.iter().any(|invitation| invitation.invitation_id == invitation_id) {
        document.invitations.push(InvitationRecord {
            invitation_id: invitation_id.to_string(),
            project_id: project_id.to_string(),
            issuer_device_id: String::new(),
            recipient_account_id: recipient_account_id.to_string(),
            recipient_device_id: None,
            permissions,
            path_scopes,
            token_hash: token_hash(bearer_token.as_bytes()),
            state: InvitationState::Created,
            created_at_ms: now_ms,
            expires_at_ms,
            redeemed_at_ms: None,
            revoked_at_ms: None,
            failed_attempts: 0,
            blocked_until_ms: None,
            owner_account_id: owner_account_id.to_string(),
            owner_agreement_public_key: owner_agreement_public_key.to_string(),
        });
        save_at(data_root, &document)?;
    }
    redeem_invitation(data_root, invitation_id, bearer_token, recipient_account_id, recipient_device_id, now_ms)
}

/// Read-only trust check for `sync_transport::DeviceTrustOracle`, backed by this file the way its
/// own doc comment already says it should be (`sync_p2p_bridge.rs` calls this instead of
/// re-deriving trust rules of its own). A remote peer is trusted for a direct P2P session either
/// because it's another of *this account's own* devices (`DeviceTrust::Trusted`), or because it
/// holds a non-revoked, non-expired grant this account issued.
pub(crate) fn is_peer_trusted_for_p2p(
    document: &SyncSecurityDocument,
    remote_account_route: &str,
    remote_device_id: &str,
    now_ms: u64,
) -> bool {
    let same_account_trusted_device = document
        .account
        .as_ref()
        .is_some_and(|account| {
            crate::sync_protocol::account_route_id(&account.account_id) == remote_account_route
        })
        && document
            .devices
            .iter()
            .any(|device| device.device_id == remote_device_id && device.trust == DeviceTrust::Trusted);
    if same_account_trusted_device {
        return true;
    }
    let grant_trusted = document.grants.iter().any(|grant| {
        grant.device_id == remote_device_id
            && crate::sync_protocol::account_route_id(&grant.account_id) == remote_account_route
            && grant.revoked_at_ms.is_none()
            && grant.expires_at_ms.is_none_or(|expires| expires > now_ms)
    });
    if grant_trusted {
        return true;
    }
    // A chat-only contact (see `ChatContactRecord`) is a second, completely separate source of
    // P2P trust — it never implies project access, and no project-authorization code reads
    // `chat_contacts` for anything. This only widens who a device can open an authenticated P2P
    // session with; it never widens what that session is allowed to do once authenticated.
    document.chat_contacts.iter().any(|contact| {
        contact.device_id == remote_device_id && contact.account_route == remote_account_route
    })
}

/// Adds (or refreshes, by `account_route`) a chat-only contact. Never touches `grants`,
/// `invitations`, or any project-authorization state — see `ChatContactRecord`'s own doc comment.
pub(crate) fn add_chat_contact_at(
    data_root: &Path,
    contact: ChatContactRecord,
) -> Result<(), String> {
    let mut document = load_at(data_root)?;
    document.chat_contacts.retain(|existing| existing.account_route != contact.account_route);
    document.chat_contacts.push(contact);
    save_at(data_root, &document)
}

pub(crate) fn list_chat_contacts_at(data_root: &Path) -> Result<Vec<ChatContactRecord>, String> {
    Ok(load_at(data_root)?.chat_contacts)
}

/// Removes a chat contact by `account_route`. Only ever touches `chat_contacts` — leaves any
/// existing `Direct` conversation and its messages untouched (removing a contact stops future P2P
/// auto-connect/trust for them, it doesn't delete chat history).
pub(crate) fn remove_chat_contact_at(data_root: &Path, account_route: &str) -> Result<(), String> {
    let mut document = load_at(data_root)?;
    document.chat_contacts.retain(|contact| contact.account_route != account_route);
    save_at(data_root, &document)
}

const CHAT_INVITE_TOKEN_TTL_MS: u64 = 7 * 24 * 60 * 60 * 1_000;

/// Returns this device's currently live (unconsumed, unexpired) invite token if one exists,
/// otherwise generates a fresh one. Exporting a pairing code is not the same action as
/// *regenerating* one — re-opening the "add contact" screen just to view or re-copy the same code
/// must never silently invalidate a token that was already shared and might still be in flight to
/// the other side (this was a real bug: the automatic mutual add-back would fail whenever the
/// issuer had reopened the export screen after sharing their code, since `generate_chat_invite_token_at`
/// unconditionally invalidates every previous token). Use `generate_chat_invite_token_at` instead
/// for an explicit, user-initiated "new code" action.
pub(crate) fn current_or_new_chat_invite_token_at(
    data_root: &Path,
    now_ms: u64,
) -> Result<String, String> {
    let document = load_at(data_root)?;
    if let Some(existing) = document
        .chat_invite_tokens
        .iter()
        .find(|entry| entry.consumed_at_ms.is_none() && entry.expires_at_ms > now_ms)
    {
        return Ok(existing.token.clone());
    }
    generate_chat_invite_token_at(data_root, now_ms)
}

/// Creates a fresh single-use invite token, first invalidating every previous unconsumed token
/// for this device (only one exported pairing code is ever "live" at a time — see
/// `ChatInviteToken`'s own doc comment). Callers embed the returned token in the exported pairing
/// code; it is never valid again once `consume_chat_invite_token_at` succeeds for it.
pub(crate) fn generate_chat_invite_token_at(data_root: &Path, now_ms: u64) -> Result<String, String> {
    let mut document = load_at(data_root)?;
    for existing in document.chat_invite_tokens.iter_mut() {
        if existing.consumed_at_ms.is_none() {
            existing.consumed_at_ms = Some(now_ms);
        }
    }
    let token = format!("cit_{}", nanoid::nanoid!(24));
    document.chat_invite_tokens.push(ChatInviteToken {
        token: token.clone(),
        created_at_ms: now_ms,
        expires_at_ms: now_ms.saturating_add(CHAT_INVITE_TOKEN_TTL_MS),
        consumed_at_ms: None,
    });
    save_at(data_root, &document)?;
    Ok(token)
}

/// Marks `token` consumed if (and only if) it exists, is not already consumed, and has not
/// expired — fails closed (`Ok(false)`) on any replay, forged, or stale token instead of trusting
/// the caller. Never touches `chat_contacts` itself; the caller adds the contact separately, only
/// after this returns `Ok(true)`.
pub(crate) fn consume_chat_invite_token_at(
    data_root: &Path,
    token: &str,
    now_ms: u64,
) -> Result<bool, String> {
    let mut document = load_at(data_root)?;
    let Some(entry) = document.chat_invite_tokens.iter_mut().find(|entry| entry.token == token) else {
        return Ok(false);
    };
    if entry.consumed_at_ms.is_some() || entry.expires_at_ms <= now_ms {
        return Ok(false);
    }
    entry.consumed_at_ms = Some(now_ms);
    save_at(data_root, &document)?;
    Ok(true)
}

#[tauri::command]
pub fn sync_add_chat_contact(
    app: tauri::AppHandle,
    account_route: String,
    device_id: String,
    agreement_public_key: String,
    display_label: String,
    avatar_thumbnail: Option<String>,
) -> Result<(), String> {
    let data_root = crate::profiles::resolve_tauri_data_root(&app)?;
    add_chat_contact_at(
        &data_root,
        ChatContactRecord {
            account_route,
            device_id,
            agreement_public_key,
            display_label,
            added_at_ms: crate::provider_common::now_ms(),
            avatar_thumbnail,
            bio: None,
        },
    )
}

#[tauri::command]
pub fn sync_list_chat_contacts(app: tauri::AppHandle) -> Result<Vec<ChatContactRecord>, String> {
    let data_root = crate::profiles::resolve_tauri_data_root(&app)?;
    list_chat_contacts_at(&data_root)
}

/// Updates a contact's stored avatar thumbnail after an `"avatar_update"` envelope from them was
/// decrypted and its sender verified — see `sync_open_avatar_update` (`sync_invitation_bridge.rs`-
/// style seal/open pattern) for the decrypt step. A no-op (not an error) if the account route isn't
/// a known contact, since a stale/late update from someone since removed shouldn't surface as a
/// failure to the caller.
pub(crate) fn update_chat_contact_avatar_at(
    data_root: &Path,
    account_route: &str,
    avatar_thumbnail: Option<String>,
) -> Result<(), String> {
    let mut document = load_at(data_root)?;
    let Some(contact) = document.chat_contacts.iter_mut().find(|contact| contact.account_route == account_route)
    else {
        return Ok(());
    };
    contact.avatar_thumbnail = avatar_thumbnail;
    save_at(data_root, &document)
}

/// Same shape as `update_chat_contact_avatar_at`, for `bio` instead of `avatar_thumbnail` — see
/// `sync_open_bio_update`.
pub(crate) fn update_chat_contact_bio_at(
    data_root: &Path,
    account_route: &str,
    bio: Option<String>,
) -> Result<(), String> {
    let mut document = load_at(data_root)?;
    let Some(contact) = document.chat_contacts.iter_mut().find(|contact| contact.account_route == account_route)
    else {
        return Ok(());
    };
    contact.bio = bio;
    save_at(data_root, &document)
}

#[tauri::command]
pub fn sync_remove_chat_contact(app: tauri::AppHandle, account_route: String) -> Result<(), String> {
    let data_root = crate::profiles::resolve_tauri_data_root(&app)?;
    remove_chat_contact_at(&data_root, &account_route)
}

/// Renames an existing chat contact's local display label — never touches anything else about the
/// contact (keys, trust). A contact's name is no longer a one-time choice made only at add time.
pub(crate) fn rename_chat_contact_at(
    data_root: &Path,
    account_route: &str,
    display_label: &str,
) -> Result<(), String> {
    let mut document = load_at(data_root)?;
    let contact = document
        .chat_contacts
        .iter_mut()
        .find(|contact| contact.account_route == account_route)
        .ok_or_else(|| "chat_contact_not_found".to_string())?;
    contact.display_label = display_label.to_string();
    save_at(data_root, &document)
}

#[tauri::command]
pub fn sync_rename_chat_contact(
    app: tauri::AppHandle,
    account_route: String,
    display_label: String,
) -> Result<(), String> {
    let data_root = crate::profiles::resolve_tauri_data_root(&app)?;
    rename_chat_contact_at(&data_root, &account_route, &display_label)
}

/// The owner identity a collaborator needs to seal a `sync_suggest_project_collaborator` proposal:
/// the project owner's raw Google account id and X25519 agreement public key, both carried on the
/// `InvitationRecord` this device's own active grant for `project_id` points back to (see
/// `owner_account_id`/`owner_agreement_public_key` doc comments). Requires an active (non-revoked,
/// non-expired) grant — proves the caller is actually a collaborator on this project, not just
/// anyone. Fails for a grant issued before this field existed (both fields empty).
pub(crate) fn find_project_owner_for_active_grant_at(
    data_root: &Path,
    project_id: &str,
    now_ms: u64,
) -> Result<(String, String), String> {
    let document = load_at(data_root)?;
    let grant = document
        .grants
        .iter()
        .filter(|grant| {
            grant.project_id == project_id
                && grant.revoked_at_ms.is_none()
                && grant.expires_at_ms.is_none_or(|expires| expires > now_ms)
        })
        .max_by_key(|grant| grant.issued_at_ms)
        .ok_or_else(|| "grant_not_found".to_string())?;
    let invitation = document
        .invitations
        .iter()
        .find(|invitation| invitation.invitation_id == grant.invitation_id)
        .ok_or_else(|| "grant_not_found".to_string())?;
    if invitation.owner_account_id.is_empty() || invitation.owner_agreement_public_key.is_empty() {
        return Err("grant_owner_unknown".to_string());
    }
    Ok((invitation.owner_account_id.clone(), invitation.owner_agreement_public_key.clone()))
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollaboratorSuggestionEnvelope {
    pub owner_account_route: String,
    pub ciphertext: String,
}

const COLLABORATOR_SUGGESTION_INFO: &[u8] = b"alethe-collaborator-suggestion-v1";
const CHAT_CONTACT_ACK_INFO: &[u8] = b"alethe-chat-contact-ack-v1";
const AVATAR_UPDATE_INFO: &[u8] = b"alethe-avatar-update-v1";

/// Seals `{ token, accountId, accountRoute, deviceId, agreementPublicKey, displayLabel }` for the
/// *issuer* of a pairing code — the recipient calls this right after verifying the issuer's code,
/// so the issuer's device can queue a pairing request instead of the recipient guessing whether
/// they'll be let in (see `ChatInviteToken`'s doc comment). Never touches this (recipient) device's
/// own `chat_contacts`/tokens — purely a transport-layer helper.
///
/// `accountId` (the sender's own raw Google account id) is read straight from the local security
/// document rather than accepted as a frontend-supplied argument — the frontend/JS layer never
/// handles raw account ids by design (ADR-0004, opaque account routing); it only ever sees
/// `accountRoute`, the one-way hash. The issuer needs the real id only if it later chooses to
/// grant project access (`GrantRecord.account_id`), and only Rust-to-Rust, inside this sealed
/// envelope, ever carries it.
#[tauri::command]
pub fn sync_seal_chat_contact_ack(
    app: tauri::AppHandle,
    token: String,
    account_route: String,
    device_id: String,
    agreement_public_key: String,
    display_label: String,
    issuer_agreement_public_key: String,
    avatar_thumbnail: Option<String>,
) -> Result<String, String> {
    let data_root = crate::profiles::resolve_tauri_data_root(&app)?;
    seal_chat_contact_ack_at(
        &data_root,
        token,
        account_route,
        device_id,
        agreement_public_key,
        display_label,
        issuer_agreement_public_key,
        avatar_thumbnail,
    )
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn seal_chat_contact_ack_at(
    data_root: &Path,
    token: String,
    account_route: String,
    device_id: String,
    agreement_public_key: String,
    display_label: String,
    issuer_agreement_public_key: String,
    avatar_thumbnail: Option<String>,
) -> Result<String, String> {
    let own_account_id = load_at(data_root)?
        .account
        .ok_or_else(|| "security_account_missing".to_string())?
        .account_id;
    let issuer_public_key = URL_SAFE_NO_PAD
        .decode(&issuer_agreement_public_key)
        .map_err(|_| "chat_contact_ack_issuer_key_invalid".to_string())?;
    let payload = serde_json::json!({
        "token": token,
        "accountId": own_account_id,
        "accountRoute": account_route,
        "deviceId": device_id,
        "agreementPublicKey": agreement_public_key,
        "displayLabel": display_label,
        "avatarThumbnail": avatar_thumbnail,
    });
    let plaintext = serde_json::to_vec(&payload).map_err(|_| "chat_contact_ack_encode_failed".to_string())?;
    let sealed = crate::sync_crypto::seal_for_recipient(&plaintext, &issuer_public_key, CHAT_CONTACT_ACK_INFO)
        .map_err(|_| "chat_contact_ack_issuer_key_invalid".to_string())?;
    let packed = crate::sync_chat::pack_sealed(&sealed);
    if packed.len() > 16 * 1024 {
        return Err("chat_contact_ack_too_large".to_string());
    }
    Ok(URL_SAFE_NO_PAD.encode(packed))
}

/// Decrypts a delivered `chat_contact_ack` envelope, then — only if `token` is a still-valid,
/// unconsumed token this device itself generated (`consume_chat_invite_token_at` fails closed on
/// any replay, forged, or stale token) — queues a `PendingChatContactRequest` for the issuer to
/// review (`PairingRequestsPanel.tsx`) instead of adding the contact automatically. Returns the
/// queued request's summary on success, or `None` if the token didn't check out (the envelope is
/// silently ignored by the caller in that case, same as any other unaddressed relay delivery).
///
/// The redeeming side (`AddChatContactModal.tsx`) never commits the contact on its own either — it
/// waits for a `chat_contact_confirm` envelope that only exists once the issuer actually resolves
/// the queued request (`resolve_pending_chat_contact_request_at`). So possessing a pasted-around
/// code is not, by itself, enough to become anyone's contact: the issuer's device has to still be
/// reachable, the token has to still be live, and a human has to actually decide to let them in.
#[tauri::command]
pub fn sync_open_chat_contact_ack(
    app: tauri::AppHandle,
    ciphertext: String,
) -> Result<Option<ChatContactAckResult>, String> {
    let data_root = crate::profiles::resolve_tauri_data_root(&app)?;
    let local_device_id = load_at(&data_root)?.local_device_id.ok_or_else(|| "security_device_missing".to_string())?;
    let recipient_secret = load_device_agreement_secret(&local_device_id)?;
    let packed = URL_SAFE_NO_PAD.decode(&ciphertext).map_err(|_| "chat_contact_ack_invalid".to_string())?;
    let sealed = crate::sync_chat::unpack_sealed(&packed)?;
    let plaintext = crate::sync_crypto::open_sealed(&sealed, &recipient_secret, CHAT_CONTACT_ACK_INFO)
        .map_err(|_| "chat_contact_ack_decrypt_failed".to_string())?;
    let payload: serde_json::Value =
        serde_json::from_slice(&plaintext).map_err(|_| "chat_contact_ack_invalid".to_string())?;
    let token = payload.get("token").and_then(|v| v.as_str()).unwrap_or_default();
    let now_ms = crate::provider_common::now_ms();
    if !consume_chat_invite_token_at(&data_root, token, now_ms)? {
        return Ok(None);
    }
    let account_id = payload.get("accountId").and_then(|v| v.as_str()).unwrap_or_default().to_string();
    let account_route = payload.get("accountRoute").and_then(|v| v.as_str()).unwrap_or_default().to_string();
    let device_id = payload.get("deviceId").and_then(|v| v.as_str()).unwrap_or_default().to_string();
    let agreement_public_key =
        payload.get("agreementPublicKey").and_then(|v| v.as_str()).unwrap_or_default().to_string();
    let display_label = payload.get("displayLabel").and_then(|v| v.as_str()).unwrap_or_default().to_string();
    if account_id.is_empty() || account_route.is_empty() || device_id.is_empty() || agreement_public_key.is_empty() {
        return Err("chat_contact_ack_invalid".to_string());
    }
    let avatar_thumbnail =
        payload.get("avatarThumbnail").and_then(|v| v.as_str()).map(|s| s.to_string());
    let request = PendingChatContactRequest {
        request_id: format!("pcr_{}", nanoid::nanoid!(24)),
        account_id,
        account_route: account_route.clone(),
        device_id,
        agreement_public_key: agreement_public_key.clone(),
        display_label: display_label.clone(),
        avatar_thumbnail,
        received_at_ms: now_ms,
    };
    let request_id = request.request_id.clone();
    queue_pending_chat_contact_request_at(&data_root, request, now_ms)?;
    Ok(Some(ChatContactAckResult { request_id, account_route, agreement_public_key, display_label }))
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatContactAckResult {
    pub request_id: String,
    pub account_route: String,
    pub agreement_public_key: String,
    pub display_label: String,
}

/// Queues a pairing request for the issuer's review instead of adding the contact immediately —
/// called by `sync_open_chat_contact_ack` once the ack's token has already been validated. The
/// access-center publish is best-effort: it must never fail the queue itself, which has already
/// been persisted by this point (same reasoning as `register_device_at`'s `DevicePendingApproval`
/// publish).
fn queue_pending_chat_contact_request_at(
    data_root: &Path,
    request: PendingChatContactRequest,
    now_ms: u64,
) -> Result<(), String> {
    let mut document = load_at(data_root)?;
    document.pending_chat_contact_requests.push(request.clone());
    save_at(data_root, &document)?;
    let _ = crate::sync_access::record_at(
        data_root,
        crate::sync_access::AccessCategory::Collaboration,
        crate::sync_access::AccessKind::PairingRequestPending,
        &request.request_id,
        now_ms,
    );
    Ok(())
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingChatContactRequestSummary {
    pub request_id: String,
    pub account_route: String,
    pub display_label: String,
    pub avatar_thumbnail: Option<String>,
    pub received_at_ms: u64,
}

pub(crate) fn list_pending_chat_contact_requests_at(
    data_root: &Path,
) -> Result<Vec<PendingChatContactRequestSummary>, String> {
    Ok(load_at(data_root)?
        .pending_chat_contact_requests
        .into_iter()
        .map(|request| PendingChatContactRequestSummary {
            request_id: request.request_id,
            account_route: request.account_route,
            display_label: request.display_label,
            avatar_thumbnail: request.avatar_thumbnail,
            received_at_ms: request.received_at_ms,
        })
        .collect())
}

#[tauri::command]
pub fn sync_list_pending_chat_contact_requests(
    app: tauri::AppHandle,
) -> Result<Vec<PendingChatContactRequestSummary>, String> {
    let data_root = crate::profiles::resolve_tauri_data_root(&app)?;
    list_pending_chat_contact_requests_at(&data_root)
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingChatContactGrantChoice {
    pub project_id: String,
    pub permissions: Vec<SyncPermission>,
    pub path_scopes: Vec<PathScope>,
    pub expires_at_ms: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedPendingChatContactRequest {
    pub contact: ChatContactRecord,
    pub grant: Option<GrantRecord>,
    /// Sealed `chat_contact_confirm` envelope, ready to send to the requester over the rendezvous
    /// relay (`sendRendezvousFrame`, kind `"chat_contact_confirm"`) — carries the grant details (if
    /// any) for the requester's own device to materialize a matching local `GrantRecord` via
    /// `sync_open_chat_contact_confirm`.
    pub confirm_ciphertext: String,
    pub account_route: String,
}

/// Resolves a queued pairing request: always adds the requester as a chat contact, and — if
/// `grant` is provided — also grants them access to one of this device's projects. Reuses the
/// existing, already-tested `issue_invitation`/`redeem_invitation` pair internally for the grant
/// (never a second, parallel authorization path just for this flow) — the pairing token already
/// served as the proof-of-possession that a bearer token would otherwise provide. Removes the
/// pending request either way; fails if it's already gone (resolved from elsewhere, e.g. two
/// browser tabs, or pruned).
///
/// Also seals the `chat_contact_confirm` envelope in the same call: the grant's `bearer_token`
/// only ever exists transiently, right here, the same way it does for `issue_invitation`'s other
/// caller (`VaultPanel.tsx`'s advanced email-invite path) — never persisted in plaintext, and
/// immediately sealed for the one recipient who can decrypt it before this function returns.
pub(crate) fn resolve_pending_chat_contact_request_at(
    data_root: &Path,
    local_device_id: &str,
    request_id: &str,
    grant: Option<PendingChatContactGrantChoice>,
    now_ms: u64,
) -> Result<ResolvedPendingChatContactRequest, String> {
    let mut document = load_at(data_root)?;
    let index = document
        .pending_chat_contact_requests
        .iter()
        .position(|request| request.request_id == request_id)
        .ok_or_else(|| "pairing_request_not_found".to_string())?;
    let request = document.pending_chat_contact_requests.remove(index);
    save_at(data_root, &document)?;

    let contact = ChatContactRecord {
        account_route: request.account_route.clone(),
        device_id: request.device_id.clone(),
        agreement_public_key: request.agreement_public_key.clone(),
        display_label: request.display_label.clone(),
        added_at_ms: now_ms,
        avatar_thumbnail: request.avatar_thumbnail.clone(),
        bio: None,
    };
    add_chat_contact_at(data_root, contact.clone())?;

    let mut grant_confirm_payload = serde_json::Value::Null;
    let granted = match grant {
        Some(choice) => {
            let owner = load_at(data_root)?;
            let owner_account_id = owner
                .account
                .as_ref()
                .ok_or_else(|| "security_account_missing".to_string())?
                .account_id
                .clone();
            let owner_device = owner
                .devices
                .iter()
                .find(|device| device.device_id == local_device_id)
                .ok_or_else(|| "security_device_missing".to_string())?;
            let owner_agreement_public_key = owner_device.agreement_public_key.clone().unwrap_or_default();

            let issued = issue_invitation(
                data_root,
                local_device_id,
                &choice.project_id,
                &request.account_id,
                Some(request.device_id.clone()),
                choice.permissions.clone(),
                choice.path_scopes.clone(),
                now_ms,
                choice.expires_at_ms,
            )?;
            let granted = redeem_invitation(
                data_root,
                &issued.invitation.invitation_id,
                &issued.bearer_token,
                &request.account_id,
                &request.device_id,
                now_ms,
            )?;
            grant_confirm_payload = serde_json::json!({
                "invitationId": issued.invitation.invitation_id,
                "bearerToken": issued.bearer_token,
                "projectId": choice.project_id,
                "permissions": choice.permissions,
                "pathScopes": choice.path_scopes,
                "expiresAtMs": choice.expires_at_ms,
                "ownerAccountId": owner_account_id,
                "ownerAgreementPublicKey": owner_agreement_public_key,
            });
            Some(granted)
        }
        None => None,
    };

    let confirm_ciphertext =
        seal_chat_contact_confirm(&request.agreement_public_key, grant_confirm_payload)?;

    Ok(ResolvedPendingChatContactRequest {
        contact,
        grant: granted,
        confirm_ciphertext,
        account_route: request.account_route,
    })
}

#[tauri::command]
pub fn sync_resolve_pending_chat_contact_request(
    app: tauri::AppHandle,
    request_id: String,
    grant: Option<PendingChatContactGrantChoice>,
) -> Result<ResolvedPendingChatContactRequest, String> {
    let data_root = crate::profiles::resolve_tauri_data_root(&app)?;
    let local_device_id =
        load_at(&data_root)?.local_device_id.ok_or_else(|| "security_device_missing".to_string())?;
    resolve_pending_chat_contact_request_at(
        &data_root,
        &local_device_id,
        &request_id,
        grant,
        crate::provider_common::now_ms(),
    )
}

/// Declines a queued pairing request without adding the contact — just removes it so it stops
/// showing up for review. The requester's own device eventually times out waiting for a confirm
/// (`AddChatContactModal.tsx`'s `CONFIRM_WAIT_MS`), the same path as an issuer who never comes
/// online at all — declining never tells the requester they were explicitly rejected.
#[tauri::command]
pub fn sync_decline_pending_chat_contact_request(
    app: tauri::AppHandle,
    request_id: String,
) -> Result<(), String> {
    let data_root = crate::profiles::resolve_tauri_data_root(&app)?;
    let mut document = load_at(&data_root)?;
    let before = document.pending_chat_contact_requests.len();
    document.pending_chat_contact_requests.retain(|request| request.request_id != request_id);
    if document.pending_chat_contact_requests.len() == before {
        return Err("pairing_request_not_found".to_string());
    }
    save_at(&data_root, &document)
}

const CHAT_CONTACT_CONFIRM_INFO: &[u8] = b"alethe-chat-contact-confirm-v1";

/// Seals a minimal "the token checked out, go ahead and commit me as a contact" signal for the
/// device that redeemed a pairing code — sent by the issuer right after `sync_open_chat_contact_ack`
/// succeeds. The payload carries nothing beyond what a successful decrypt already proves (that this
/// device, and only this device, holds the matching agreement secret): possession of a valid
/// confirm envelope *is* the confirmation, there is nothing further to authenticate inside it.
/// `grant` is `Null` for a chat-only decision, or the grant payload built by
/// `resolve_pending_chat_contact_request_at` when the issuer also chose to share a project.
fn seal_chat_contact_confirm(
    recipient_agreement_public_key: &str,
    grant: serde_json::Value,
) -> Result<String, String> {
    let recipient_public_key = URL_SAFE_NO_PAD
        .decode(recipient_agreement_public_key)
        .map_err(|_| "chat_contact_confirm_recipient_key_invalid".to_string())?;
    let plaintext = serde_json::to_vec(&serde_json::json!({ "grant": grant }))
        .map_err(|_| "chat_contact_confirm_encode_failed".to_string())?;
    let sealed = crate::sync_crypto::seal_for_recipient(&plaintext, &recipient_public_key, CHAT_CONTACT_CONFIRM_INFO)
        .map_err(|_| "chat_contact_confirm_recipient_key_invalid".to_string())?;
    Ok(URL_SAFE_NO_PAD.encode(crate::sync_chat::pack_sealed(&sealed)))
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedChatContactConfirm {
    pub grant: Option<GrantRecord>,
}

/// Decrypts a delivered `chat_contact_confirm` envelope. Returns `None` if it doesn't open with
/// this device's own agreement secret (not addressed to us) — the redeeming side of
/// `AddChatContactModal.tsx` waits for `Some(...)` before calling `sync_add_chat_contact`, closing
/// the replay gap documented on `sync_open_chat_contact_ack`: a pasted-around code no longer, by
/// itself, gets its holder committed as a contact — the issuer's device has to still be alive and
/// willing to confirm it. When the issuer also chose to grant project access, this materializes a
/// matching local `GrantRecord` here too, the same way `sync_consume_remote_invitation_cross_device`
/// already does for the old email-invite flow (`redeem_remote_invitation_at`, reused as-is).
#[tauri::command]
pub fn sync_open_chat_contact_confirm(
    app: tauri::AppHandle,
    ciphertext: String,
) -> Result<Option<OpenedChatContactConfirm>, String> {
    let data_root = crate::profiles::resolve_tauri_data_root(&app)?;
    let local_device_id = load_at(&data_root)?.local_device_id.ok_or_else(|| "security_device_missing".to_string())?;
    let recipient_secret = load_device_agreement_secret(&local_device_id)?;
    let Ok(packed) = URL_SAFE_NO_PAD.decode(&ciphertext) else { return Ok(None) };
    let Ok(sealed) = crate::sync_chat::unpack_sealed(&packed) else { return Ok(None) };
    let Ok(plaintext) = crate::sync_crypto::open_sealed(&sealed, &recipient_secret, CHAT_CONTACT_CONFIRM_INFO)
    else {
        return Ok(None);
    };
    let payload: serde_json::Value = serde_json::from_slice(&plaintext).unwrap_or(serde_json::Value::Null);
    let grant_payload = payload.get("grant").cloned().unwrap_or(serde_json::Value::Null);
    if grant_payload.is_null() {
        return Ok(Some(OpenedChatContactConfirm { grant: None }));
    }
    let invitation_id = grant_payload.get("invitationId").and_then(|v| v.as_str()).unwrap_or_default();
    let bearer_token = grant_payload.get("bearerToken").and_then(|v| v.as_str()).unwrap_or_default();
    let project_id = grant_payload.get("projectId").and_then(|v| v.as_str()).unwrap_or_default();
    let permissions: Vec<SyncPermission> = grant_payload
        .get("permissions")
        .cloned()
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default();
    let path_scopes: Vec<PathScope> = grant_payload
        .get("pathScopes")
        .cloned()
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default();
    let expires_at_ms = grant_payload.get("expiresAtMs").and_then(|v| v.as_u64()).unwrap_or_default();
    let owner_account_id = grant_payload.get("ownerAccountId").and_then(|v| v.as_str()).unwrap_or_default();
    let owner_agreement_public_key =
        grant_payload.get("ownerAgreementPublicKey").and_then(|v| v.as_str()).unwrap_or_default();
    if invitation_id.is_empty() || bearer_token.is_empty() || project_id.is_empty() {
        return Err("chat_contact_confirm_invalid_grant".to_string());
    }
    let identity = local_identity_at(&data_root)?;
    let account_id = load_at(&data_root)?
        .account
        .ok_or_else(|| "security_account_missing".to_string())?
        .account_id;
    let now_ms = crate::provider_common::now_ms();
    let grant = redeem_remote_invitation_at(
        &data_root,
        invitation_id,
        bearer_token,
        project_id,
        permissions,
        path_scopes,
        expires_at_ms,
        &account_id,
        &identity.device_id,
        owner_account_id,
        owner_agreement_public_key,
        now_ms,
    )?;
    Ok(Some(OpenedChatContactConfirm { grant: Some(grant) }))
}

/// Seals `{ accountRoute, avatarThumbnail }` for a specific chat contact — sent whenever this
/// device's own profile picture changes (see `AccountPage.tsx`), to every currently-known contact,
/// so their `ChatContactRecord.avatar_thumbnail` stays live instead of only ever reflecting the
/// picture at the moment they were paired. `avatar_thumbnail: None` clears the picture on the
/// receiving side (the user removed theirs).
#[tauri::command]
pub fn sync_seal_avatar_update(
    account_route: String,
    avatar_thumbnail: Option<String>,
    recipient_agreement_public_key: String,
) -> Result<String, String> {
    let recipient_public_key = URL_SAFE_NO_PAD
        .decode(&recipient_agreement_public_key)
        .map_err(|_| "avatar_update_recipient_key_invalid".to_string())?;
    let payload = serde_json::json!({
        "accountRoute": account_route,
        "avatarThumbnail": avatar_thumbnail,
    });
    let plaintext = serde_json::to_vec(&payload).map_err(|_| "avatar_update_encode_failed".to_string())?;
    let sealed = crate::sync_crypto::seal_for_recipient(&plaintext, &recipient_public_key, AVATAR_UPDATE_INFO)
        .map_err(|_| "avatar_update_recipient_key_invalid".to_string())?;
    let packed = crate::sync_chat::pack_sealed(&sealed);
    if packed.len() > 16 * 1024 {
        return Err("avatar_update_too_large".to_string());
    }
    Ok(URL_SAFE_NO_PAD.encode(packed))
}

/// Decrypts a delivered `avatar_update` envelope and, if the sender is a known chat contact,
/// updates their stored thumbnail. Returns the sender's account route on success (so the caller
/// can e.g. refresh a currently-open conversation), `None` if the sender isn't a known contact
/// (nothing to update).
#[tauri::command]
pub fn sync_open_avatar_update(app: tauri::AppHandle, ciphertext: String) -> Result<Option<String>, String> {
    let data_root = crate::profiles::resolve_tauri_data_root(&app)?;
    let local_device_id = load_at(&data_root)?.local_device_id.ok_or_else(|| "security_device_missing".to_string())?;
    let recipient_secret = load_device_agreement_secret(&local_device_id)?;
    let packed = URL_SAFE_NO_PAD.decode(&ciphertext).map_err(|_| "avatar_update_invalid".to_string())?;
    let sealed = crate::sync_chat::unpack_sealed(&packed)?;
    let plaintext = crate::sync_crypto::open_sealed(&sealed, &recipient_secret, AVATAR_UPDATE_INFO)
        .map_err(|_| "avatar_update_decrypt_failed".to_string())?;
    let payload: serde_json::Value =
        serde_json::from_slice(&plaintext).map_err(|_| "avatar_update_invalid".to_string())?;
    let account_route = payload.get("accountRoute").and_then(|v| v.as_str()).unwrap_or_default().to_string();
    if account_route.is_empty() {
        return Err("avatar_update_invalid".to_string());
    }
    let avatar_thumbnail = payload.get("avatarThumbnail").and_then(|v| v.as_str()).map(|s| s.to_string());
    let document = load_at(&data_root)?;
    if !document.chat_contacts.iter().any(|contact| contact.account_route == account_route) {
        return Ok(None);
    }
    update_chat_contact_avatar_at(&data_root, &account_route, avatar_thumbnail)?;
    Ok(Some(account_route))
}

const BIO_UPDATE_INFO: &[u8] = b"alethe-bio-update-v1";
/// Discord's own "About Me" cap is 190 characters — matched here rather than invented, since it's
/// a well-tested size for a short bio: long enough to say something, short enough to never wrap
/// into a wall of text in a narrow side panel.
pub const MAX_BIO_LEN: usize = 190;

/// Seals `{ accountRoute, bio }` for a specific chat contact — same seal/open/live-update shape as
/// `sync_seal_avatar_update`, for the bio field instead. `bio: None` clears it on the receiving
/// side (the user cleared their own bio).
#[tauri::command]
pub fn sync_seal_bio_update(
    account_route: String,
    bio: Option<String>,
    recipient_agreement_public_key: String,
) -> Result<String, String> {
    if bio.as_deref().is_some_and(|value| value.chars().count() > MAX_BIO_LEN) {
        return Err("bio_update_too_long".to_string());
    }
    let recipient_public_key = URL_SAFE_NO_PAD
        .decode(&recipient_agreement_public_key)
        .map_err(|_| "bio_update_recipient_key_invalid".to_string())?;
    let payload = serde_json::json!({
        "accountRoute": account_route,
        "bio": bio,
    });
    let plaintext = serde_json::to_vec(&payload).map_err(|_| "bio_update_encode_failed".to_string())?;
    let sealed = crate::sync_crypto::seal_for_recipient(&plaintext, &recipient_public_key, BIO_UPDATE_INFO)
        .map_err(|_| "bio_update_recipient_key_invalid".to_string())?;
    let packed = crate::sync_chat::pack_sealed(&sealed);
    if packed.len() > 16 * 1024 {
        return Err("bio_update_too_large".to_string());
    }
    Ok(URL_SAFE_NO_PAD.encode(packed))
}

/// Decrypts a delivered `bio_update` envelope and, if the sender is a known chat contact, updates
/// their stored bio. Returns the sender's account route on success, `None` if the sender isn't a
/// known contact (nothing to update).
#[tauri::command]
pub fn sync_open_bio_update(app: tauri::AppHandle, ciphertext: String) -> Result<Option<String>, String> {
    let data_root = crate::profiles::resolve_tauri_data_root(&app)?;
    let local_device_id = load_at(&data_root)?.local_device_id.ok_or_else(|| "security_device_missing".to_string())?;
    let recipient_secret = load_device_agreement_secret(&local_device_id)?;
    let packed = URL_SAFE_NO_PAD.decode(&ciphertext).map_err(|_| "bio_update_invalid".to_string())?;
    let sealed = crate::sync_chat::unpack_sealed(&packed)?;
    let plaintext = crate::sync_crypto::open_sealed(&sealed, &recipient_secret, BIO_UPDATE_INFO)
        .map_err(|_| "bio_update_decrypt_failed".to_string())?;
    let payload: serde_json::Value =
        serde_json::from_slice(&plaintext).map_err(|_| "bio_update_invalid".to_string())?;
    let account_route = payload.get("accountRoute").and_then(|v| v.as_str()).unwrap_or_default().to_string();
    if account_route.is_empty() {
        return Err("bio_update_invalid".to_string());
    }
    let bio = payload
        .get("bio")
        .and_then(|v| v.as_str())
        .map(|s| s.chars().take(MAX_BIO_LEN).collect::<String>());
    let document = load_at(&data_root)?;
    if !document.chat_contacts.iter().any(|contact| contact.account_route == account_route) {
        return Ok(None);
    }
    update_chat_contact_bio_at(&data_root, &account_route, bio)?;
    Ok(Some(account_route))
}

/// Builds an end-to-end sealed `invite_suggestion` payload for the owner of `project_id`, callable
/// only when this device holds an active grant for that project (proof of being a real
/// collaborator, not just anyone). Never touches `issue_invitation`/`grants` itself — the caller
/// (frontend) sends the returned ciphertext through the existing rendezvous relay
/// (`sendRendezvousFrame({ kind: "invite_suggestion", ... })`); only the owner, decrypting and then
/// explicitly running the normal invite flow, can turn this into real access.
pub(crate) fn prepare_collaborator_suggestion_at(
    data_root: &Path,
    project_id: &str,
    suggested_account_id: &str,
    note: &str,
    now_ms: u64,
) -> Result<CollaboratorSuggestionEnvelope, String> {
    let (owner_account_id, owner_agreement_public_key) =
        find_project_owner_for_active_grant_at(data_root, project_id, now_ms)?;
    let owner_public_key = URL_SAFE_NO_PAD
        .decode(&owner_agreement_public_key)
        .map_err(|_| "collaborator_suggestion_owner_key_invalid".to_string())?;
    let payload = serde_json::json!({
        "projectId": project_id,
        "suggestedAccountId": suggested_account_id,
        "note": note,
    });
    let plaintext = serde_json::to_vec(&payload).map_err(|_| "collaborator_suggestion_encode_failed".to_string())?;
    let sealed = crate::sync_crypto::seal_for_recipient(&plaintext, &owner_public_key, COLLABORATOR_SUGGESTION_INFO)
        .map_err(|_| "collaborator_suggestion_owner_key_invalid".to_string())?;
    let packed = crate::sync_chat::pack_sealed(&sealed);
    if packed.len() > 16 * 1024 {
        return Err("collaborator_suggestion_too_large".to_string());
    }
    Ok(CollaboratorSuggestionEnvelope {
        owner_account_route: crate::sync_protocol::account_route_id(&owner_account_id),
        ciphertext: URL_SAFE_NO_PAD.encode(packed),
    })
}

/// Issues and immediately redeems a project invitation on behalf of an account that has just
/// accepted an invite, returning the sealed `chat_contact_confirm` envelope for them to
/// materialize the grant locally.
///
/// The same two steps the pairing flow performs when a project is attached to an approval — kept
/// here, beside `resolve_pending_chat_contact_request_at`, so both paths issue grants through one
/// implementation rather than two that can drift.
pub fn grant_project_to_account(
    app: &tauri::AppHandle,
    project_id: &str,
    recipient_account_id: &str,
    recipient_device_id: &str,
    recipient_agreement_public_key: &str,
    permissions: Vec<SyncPermission>,
    path_scopes: Vec<PathScope>,
    expires_at_ms: u64,
) -> Result<String, String> {
    let data_root = crate::profiles::resolve_tauri_data_root(app)?;
    let now_ms = crate::provider_common::now_ms();
    let local_device_id = local_device_id_at(&data_root)?;
    let document = load_at(&data_root)?;
    let owner_account_id = document
        .account
        .as_ref()
        .ok_or_else(|| "security_account_missing".to_string())?
        .account_id
        .clone();
    let owner_agreement_public_key = document
        .devices
        .iter()
        .find(|device| device.device_id == local_device_id)
        .and_then(|device| device.agreement_public_key.clone())
        .unwrap_or_default();

    let issued = issue_invitation(
        &data_root,
        &local_device_id,
        project_id,
        recipient_account_id,
        Some(recipient_device_id.to_string()),
        permissions.clone(),
        path_scopes.clone(),
        now_ms,
        expires_at_ms,
    )?;
    redeem_invitation(
        &data_root,
        &issued.invitation.invitation_id,
        &issued.bearer_token,
        recipient_account_id,
        recipient_device_id,
        now_ms,
    )?;

    let payload = serde_json::json!({
        "invitationId": issued.invitation.invitation_id,
        "bearerToken": issued.bearer_token,
        "projectId": project_id,
        "permissions": permissions,
        "pathScopes": path_scopes,
        "expiresAtMs": expires_at_ms,
        "ownerAccountId": owner_account_id,
        "ownerAgreementPublicKey": owner_agreement_public_key,
    });
    seal_chat_contact_confirm(recipient_agreement_public_key, payload)
}

/// Whether `account_route` belongs to someone already paired with this device.
pub fn has_chat_contact_at(data_root: &Path, account_route: &str) -> Result<bool, String> {
    Ok(load_at(data_root)?
        .chat_contacts
        .iter()
        .any(|contact| contact.account_route == account_route))
}

/// The identity another device needs in order to issue this device a project grant.
///
/// Contains the raw account id, which `account_route` is a one-way hash of (ADR-0004), so it must
/// only ever be sent as a direct result of the user accepting a specific invitation — see
/// `sync_project_invite.rs`. Never expose it to the frontend or write it into a contact record.
pub struct GrantableIdentity {
    pub account_id: String,
    pub device_id: String,
    pub agreement_public_key: String,
}

pub fn local_grantable_identity_at(data_root: &Path) -> Result<GrantableIdentity, String> {
    let document = load_at(data_root)?;
    let account_id = document
        .account
        .as_ref()
        .ok_or_else(|| "security_account_missing".to_string())?
        .account_id
        .clone();
    let device_id = document
        .local_device_id
        .clone()
        .ok_or_else(|| "security_device_missing".to_string())?;
    let agreement_public_key = document
        .devices
        .iter()
        .find(|device| device.device_id == device_id)
        .and_then(|device| device.agreement_public_key.clone())
        .ok_or_else(|| "security_device_missing".to_string())?;
    Ok(GrantableIdentity {
        account_id,
        device_id,
        agreement_public_key,
    })
}

pub(crate) fn open_collaborator_suggestion_at(data_root: &Path, ciphertext: &str) -> Result<Vec<u8>, String> {
    let local_device_id = load_at(data_root)?.local_device_id.ok_or_else(|| "security_device_missing".to_string())?;
    let recipient_secret = load_device_agreement_secret(&local_device_id)?;
    let packed = URL_SAFE_NO_PAD.decode(ciphertext).map_err(|_| "collaborator_suggestion_invalid".to_string())?;
    let sealed = crate::sync_chat::unpack_sealed(&packed)?;
    crate::sync_crypto::open_sealed(&sealed, &recipient_secret, COLLABORATOR_SUGGESTION_INFO)
        .map_err(|_| "collaborator_suggestion_decrypt_failed".to_string())
}

/// Builds an end-to-end sealed `invite_suggestion` payload for the owner of `project_id`, callable
/// only when this device holds an active grant for that project (proof of being a real
/// collaborator, not just anyone). Never touches `issue_invitation`/`grants` itself — the caller
/// (frontend) sends the returned ciphertext through the existing rendezvous relay
/// (`sendRendezvousFrame({ kind: "invite_suggestion", ... })`); only the owner, decrypting and then
/// explicitly running the normal invite flow, can turn this into real access.
#[tauri::command]
pub fn sync_prepare_collaborator_suggestion(
    app: tauri::AppHandle,
    project_id: String,
    suggested_account_id: String,
    note: String,
) -> Result<CollaboratorSuggestionEnvelope, String> {
    let data_root = crate::profiles::resolve_tauri_data_root(&app)?;
    prepare_collaborator_suggestion_at(&data_root, &project_id, &suggested_account_id, &note, crate::provider_common::now_ms())
}

/// Decrypts an `invite_suggestion` envelope delivered by the rendezvous relay using this device's
/// own X25519 agreement secret, returning the plaintext JSON bytes
/// (`{ projectId, suggestedAccountId, note }`) for the caller to parse and display. This never
/// creates a grant or invitation by itself — the owner must still run the normal invite flow from
/// scratch to actually grant access.
#[tauri::command]
pub fn sync_open_collaborator_suggestion(app: tauri::AppHandle, ciphertext: String) -> Result<Vec<u8>, String> {
    let data_root = crate::profiles::resolve_tauri_data_root(&app)?;
    open_collaborator_suggestion_at(&data_root, &ciphertext)
}

/// Finds a trusted device ID for `remote_account_route` from this account's active grants (a chat
/// conversation member only carries an account route, not a device ID — P2P's trust check
/// (`is_peer_trusted_for_p2p`) needs both). Returns the most recently issued matching grant's
/// device, or `None` if there is no live grant for that route to connect to yet.
pub fn find_trusted_device_for_account_route_at(
    data_root: &Path,
    remote_account_route: &str,
    now_ms: u64,
) -> Result<Option<String>, String> {
    let document = load_at(data_root)?;
    if let Some(device_id) = document
        .grants
        .iter()
        .filter(|grant| {
            crate::sync_protocol::account_route_id(&grant.account_id) == remote_account_route
                && grant.revoked_at_ms.is_none()
                && grant.expires_at_ms.is_none_or(|expires| expires > now_ms)
        })
        .max_by_key(|grant| grant.issued_at_ms)
        .map(|grant| grant.device_id.clone())
    {
        return Ok(Some(device_id));
    }
    // Second, separate source (see `ChatContactRecord`) — never a project grant.
    Ok(document
        .chat_contacts
        .iter()
        .find(|contact| contact.account_route == remote_account_route)
        .map(|contact| contact.device_id.clone()))
}

#[tauri::command]
pub fn sync_find_trusted_device_for_account_route(
    app: tauri::AppHandle,
    remote_account_route: String,
) -> Result<Option<String>, String> {
    let data_root = crate::profiles::resolve_tauri_data_root(&app)?;
    find_trusted_device_for_account_route_at(&data_root, &remote_account_route, crate::provider_common::now_ms())
}

fn find_trusted_actor<'a>(
    document: &'a SyncSecurityDocument,
    actor_device_id: &str,
) -> Result<&'a DeviceRecord, String> {
    let actor = document
        .devices
        .iter()
        .find(|device| device.device_id == actor_device_id)
        .ok_or_else(|| "actor_device_unknown".to_string())?;
    if actor.trust != DeviceTrust::Trusted {
        return Err("actor_device_not_trusted".to_string());
    }
    Ok(actor)
}

/// Approves a pending device. The actor must already be a trusted device on the same account.
pub(crate) fn approve_device_at(
    data_root: &Path,
    actor_device_id: &str,
    target_device_id: &str,
    now_ms: u64,
) -> Result<DeviceRecord, String> {
    let mut document = load_at(data_root)?;
    let actor_account_id = find_trusted_actor(&document, actor_device_id)?.account_id.clone();
    let target = document
        .devices
        .iter_mut()
        .find(|device| device.device_id == target_device_id)
        .ok_or_else(|| "target_device_unknown".to_string())?;
    if target.account_id != actor_account_id {
        return Err("target_device_unknown".to_string());
    }
    if target.trust != DeviceTrust::Pending {
        return Err("target_device_not_pending".to_string());
    }
    target.trust = DeviceTrust::Trusted;
    target.last_verified_at_ms = Some(now_ms);
    let updated = target.clone();
    append_audit(
        &mut document,
        now_ms,
        "device.approved",
        Some(actor_device_id.to_string()),
        Some(target_device_id.to_string()),
    );
    save_at(data_root, &document)?;
    Ok(updated)
}

/// Rejects and permanently removes a device that never reached `Trusted`.
pub(crate) fn reject_device_at<S: DeviceSecretStore>(
    data_root: &Path,
    secret_store: &S,
    actor_device_id: &str,
    target_device_id: &str,
    now_ms: u64,
) -> Result<(), String> {
    let mut document = load_at(data_root)?;
    let actor_account_id = find_trusted_actor(&document, actor_device_id)?.account_id.clone();
    let target = document
        .devices
        .iter()
        .find(|device| device.device_id == target_device_id)
        .ok_or_else(|| "target_device_unknown".to_string())?;
    if target.account_id != actor_account_id {
        return Err("target_device_unknown".to_string());
    }
    if target.trust != DeviceTrust::Pending {
        return Err("target_device_not_pending".to_string());
    }
    document
        .devices
        .retain(|device| device.device_id != target_device_id);
    append_audit(
        &mut document,
        now_ms,
        "device.rejected",
        Some(actor_device_id.to_string()),
        Some(target_device_id.to_string()),
    );
    save_at(data_root, &document)?;
    secret_store.delete(target_device_id)?;
    secret_store.delete(&agreement_secret_entry_id(target_device_id))
}

/// Renames a device. Only the device itself may rename its own record.
pub(crate) fn rename_device_at(
    data_root: &Path,
    actor_device_id: &str,
    new_display_name: &str,
    now_ms: u64,
) -> Result<DeviceRecord, String> {
    let name = new_display_name.trim();
    if name.is_empty() {
        return Err("device_name_invalid".to_string());
    }
    let mut document = load_at(data_root)?;
    let device = document
        .devices
        .iter_mut()
        .find(|device| device.device_id == actor_device_id)
        .ok_or_else(|| "target_device_unknown".to_string())?;
    if device.trust == DeviceTrust::Revoked {
        return Err("target_device_revoked".to_string());
    }
    device.display_name = name.to_string();
    let updated = device.clone();
    append_audit(
        &mut document,
        now_ms,
        "device.renamed",
        Some(actor_device_id.to_string()),
        Some(actor_device_id.to_string()),
    );
    save_at(data_root, &document)?;
    Ok(updated)
}

/// Revokes a device: blocks it from future operations, deletes its private key from the
/// credential store, and invalidates every grant issued to it (SYNC-INV-008).
pub(crate) fn revoke_device_at<S: DeviceSecretStore>(
    data_root: &Path,
    secret_store: &S,
    actor_device_id: &str,
    target_device_id: &str,
    now_ms: u64,
) -> Result<DeviceRecord, String> {
    let mut document = load_at(data_root)?;
    let actor_account_id = find_trusted_actor(&document, actor_device_id)?.account_id.clone();
    let target = document
        .devices
        .iter_mut()
        .find(|device| device.device_id == target_device_id)
        .ok_or_else(|| "target_device_unknown".to_string())?;
    if target.account_id != actor_account_id {
        return Err("target_device_unknown".to_string());
    }
    if target.trust == DeviceTrust::Revoked {
        return Err("target_device_already_revoked".to_string());
    }
    target.trust = DeviceTrust::Revoked;
    target.revoked_at_ms = Some(now_ms);
    let updated = target.clone();

    for grant in document
        .grants
        .iter_mut()
        .filter(|grant| grant.device_id == target_device_id && grant.revoked_at_ms.is_none())
    {
        grant.revoked_at_ms = Some(now_ms);
    }
    for invitation in document.invitations.iter_mut().filter(|invitation| {
        invitation.state == InvitationState::Created
            && invitation
                .recipient_device_id
                .as_deref()
                .is_some_and(|device_id| device_id == target_device_id)
    }) {
        invitation.state = InvitationState::Revoked;
        invitation.revoked_at_ms = Some(now_ms);
    }

    append_audit(
        &mut document,
        now_ms,
        "device.revoked",
        Some(actor_device_id.to_string()),
        Some(target_device_id.to_string()),
    );
    save_at(data_root, &document)?;
    secret_store.delete(target_device_id)?;
    secret_store.delete(&agreement_secret_entry_id(target_device_id))?;
    Ok(updated)
}

/// Permanently removes a device record that has already been revoked.
pub(crate) fn remove_device_at(
    data_root: &Path,
    actor_device_id: &str,
    target_device_id: &str,
    now_ms: u64,
) -> Result<(), String> {
    let mut document = load_at(data_root)?;
    let actor_account_id = find_trusted_actor(&document, actor_device_id)?.account_id.clone();
    let target = document
        .devices
        .iter()
        .find(|device| device.device_id == target_device_id)
        .ok_or_else(|| "target_device_unknown".to_string())?;
    if target.account_id != actor_account_id {
        return Err("target_device_unknown".to_string());
    }
    if target.trust != DeviceTrust::Revoked {
        return Err("target_device_not_revoked".to_string());
    }
    document
        .devices
        .retain(|device| device.device_id != target_device_id);
    append_audit(
        &mut document,
        now_ms,
        "device.removed",
        Some(actor_device_id.to_string()),
        Some(target_device_id.to_string()),
    );
    save_at(data_root, &document)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex;
    use x25519_dalek::{PublicKey as X25519PublicKey, StaticSecret as X25519StaticSecret};

    fn device(account_id: &str, device_id: &str, trust: DeviceTrust) -> DeviceRecord {
        DeviceRecord {
            device_id: device_id.to_string(),
            account_id: account_id.to_string(),
            display_name: "Test Device".to_string(),
            public_key: String::new(),
            public_key_fingerprint: String::new(),
            trust,
            registered_at_ms: 0,
            last_verified_at_ms: None,
            revoked_at_ms: None,
            agreement_public_key: None,
            agreement_key_bound_at_ms: None,
            agreement_key_binding_signature: None,
            key_rotated_at_ms: None,
        }
    }

    fn grant(account_id: &str, device_id: &str, revoked: bool, expires_at_ms: Option<u64>) -> GrantRecord {
        GrantRecord {
            grant_id: "grant-1".to_string(),
            invitation_id: "invitation-1".to_string(),
            project_id: "project-1".to_string(),
            account_id: account_id.to_string(),
            device_id: device_id.to_string(),
            permissions: vec![SyncPermission::Read],
            path_scopes: Vec::new(),
            issued_at_ms: 0,
            expires_at_ms,
            revoked_at_ms: revoked.then_some(1),
        }
    }

    #[test]
    fn remote_invitation_redeems_against_a_document_that_never_saw_the_issuer() {
        // The point of `redeem_remote_invitation_at`: the invitation is materialized straight
        // from delivered fields into a document that never called `issue_invitation` at all —
        // proving this actually works across two separate installs, unlike a same-document test.
        let recipient_root = temp_root();
        let grant = redeem_remote_invitation_at(
            &recipient_root,
            "invitation-from-elsewhere",
            "bearer-token-value",
            "project-1",
            vec![SyncPermission::Read],
            Vec::new(),
            10_000,
            "recipient-account",
            "recipient-device",
            "owner-account",
            "owner-key",
            1_000,
        )
        .unwrap();
        assert_eq!(grant.account_id, "recipient-account");
        assert_eq!(grant.device_id, "recipient-device");
        assert_eq!(grant.project_id, "project-1");
        fs::remove_dir_all(recipient_root).unwrap();
    }

    #[test]
    fn remote_invitation_cannot_be_redeemed_twice() {
        let root = temp_root();
        redeem_remote_invitation_at(
            &root,
            "invitation-once",
            "bearer-token",
            "project-1",
            vec![SyncPermission::Read],
            Vec::new(),
            10_000,
            "recipient-account",
            "recipient-device",
            "owner-account",
            "owner-key",
            1_000,
        )
        .unwrap();
        let second = redeem_remote_invitation_at(
            &root,
            "invitation-once",
            "bearer-token",
            "project-1",
            vec![SyncPermission::Read],
            Vec::new(),
            10_000,
            "recipient-account",
            "recipient-device",
            "owner-account",
            "owner-key",
            2_000,
        );
        assert!(second.is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn remote_invitation_past_its_expiry_is_rejected() {
        let root = temp_root();
        let result = redeem_remote_invitation_at(
            &root,
            "invitation-expired",
            "bearer-token",
            "project-1",
            vec![SyncPermission::Read],
            Vec::new(),
            1_000,
            "recipient-account",
            "recipient-device",
            "owner-account",
            "owner-key",
            5_000,
        );
        assert!(result.is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn own_trusted_device_is_trusted_for_p2p() {
        let mut document = SyncSecurityDocument::default();
        document.account = Some(VerifiedAccount {
            account_id: "owner-account".to_string(),
            provider: "google".to_string(),
            display_name: "Owner".to_string(),
            email_hint: None,
            connected_at_ms: 0,
        });
        document.devices.push(device("owner-account", "dev-laptop", DeviceTrust::Trusted));
        let route = crate::sync_protocol::account_route_id("owner-account");
        assert!(is_peer_trusted_for_p2p(&document, &route, "dev-laptop", 1_000));
    }

    #[test]
    fn own_pending_device_is_not_trusted_for_p2p() {
        let mut document = SyncSecurityDocument::default();
        document.account = Some(VerifiedAccount {
            account_id: "owner-account".to_string(),
            provider: "google".to_string(),
            display_name: "Owner".to_string(),
            email_hint: None,
            connected_at_ms: 0,
        });
        document.devices.push(device("owner-account", "dev-new", DeviceTrust::Pending));
        let route = crate::sync_protocol::account_route_id("owner-account");
        assert!(!is_peer_trusted_for_p2p(&document, &route, "dev-new", 1_000));
    }

    #[test]
    fn active_grant_recipient_is_trusted_for_p2p() {
        let mut document = SyncSecurityDocument::default();
        document.grants.push(grant("friend-account", "friend-device", false, None));
        let route = crate::sync_protocol::account_route_id("friend-account");
        assert!(is_peer_trusted_for_p2p(&document, &route, "friend-device", 1_000));
    }

    #[test]
    fn revoked_grant_recipient_is_not_trusted_for_p2p() {
        let mut document = SyncSecurityDocument::default();
        document.grants.push(grant("friend-account", "friend-device", true, None));
        let route = crate::sync_protocol::account_route_id("friend-account");
        assert!(!is_peer_trusted_for_p2p(&document, &route, "friend-device", 1_000));
    }

    #[test]
    fn expired_grant_recipient_is_not_trusted_for_p2p() {
        let mut document = SyncSecurityDocument::default();
        document.grants.push(grant("friend-account", "friend-device", false, Some(500)));
        let route = crate::sync_protocol::account_route_id("friend-account");
        assert!(!is_peer_trusted_for_p2p(&document, &route, "friend-device", 1_000));
    }

    #[test]
    fn unrelated_device_is_not_trusted_for_p2p() {
        let document = SyncSecurityDocument::default();
        let route = crate::sync_protocol::account_route_id("stranger-account");
        assert!(!is_peer_trusted_for_p2p(&document, &route, "stranger-device", 1_000));
    }

    #[test]
    fn a_chat_contact_is_trusted_for_p2p_with_no_grant_present() {
        let root = temp_root();
        let route = crate::sync_protocol::account_route_id("friend-account");
        add_chat_contact_at(
            &root,
            ChatContactRecord {
                account_route: route.clone(),
                device_id: "friend-device".to_string(),
                agreement_public_key: "AAAA".to_string(),
                display_label: "Friend".to_string(),
                added_at_ms: 1_000,
                avatar_thumbnail: None,
                bio: None,
            },
        )
        .unwrap();
        let document = load_at(&root).unwrap();
        assert!(document.grants.is_empty());
        assert!(is_peer_trusted_for_p2p(&document, &route, "friend-device", 2_000));
        assert_eq!(
            find_trusted_device_for_account_route_at(&root, &route, 2_000).unwrap(),
            Some("friend-device".to_string())
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn adding_a_chat_contact_never_creates_a_grant_or_invitation() {
        let root = temp_root();
        add_chat_contact_at(
            &root,
            ChatContactRecord {
                account_route: "route-friend".to_string(),
                device_id: "friend-device".to_string(),
                agreement_public_key: "AAAA".to_string(),
                display_label: "Friend".to_string(),
                added_at_ms: 1_000,
                avatar_thumbnail: None,
                bio: None,
            },
        )
        .unwrap();
        let document = load_at(&root).unwrap();
        assert!(document.grants.is_empty());
        assert!(document.invitations.is_empty());
        assert_eq!(document.chat_contacts.len(), 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn adding_a_chat_contact_twice_updates_instead_of_duplicating() {
        let root = temp_root();
        for label in ["First label", "Updated label"] {
            add_chat_contact_at(
                &root,
                ChatContactRecord {
                    account_route: "route-friend".to_string(),
                    device_id: "friend-device".to_string(),
                    agreement_public_key: "AAAA".to_string(),
                    display_label: label.to_string(),
                    added_at_ms: 1_000,
                    avatar_thumbnail: None,
                    bio: None,
                },
            )
            .unwrap();
        }
        let contacts = list_chat_contacts_at(&root).unwrap();
        assert_eq!(contacts.len(), 1);
        assert_eq!(contacts[0].display_label, "Updated label");
        fs::remove_dir_all(root).unwrap();
    }

    fn invitation_with_owner(invitation_id: &str, project_id: &str, owner_account_id: &str, owner_key: &str) -> InvitationRecord {
        InvitationRecord {
            invitation_id: invitation_id.to_string(),
            project_id: project_id.to_string(),
            issuer_device_id: String::new(),
            recipient_account_id: "collaborator-account".to_string(),
            recipient_device_id: None,
            permissions: vec![SyncPermission::Read],
            path_scopes: Vec::new(),
            token_hash: "0".repeat(64),
            state: InvitationState::Redeemed,
            created_at_ms: 0,
            expires_at_ms: 999_999,
            redeemed_at_ms: Some(0),
            revoked_at_ms: None,
            failed_attempts: 0,
            blocked_until_ms: None,
            owner_account_id: owner_account_id.to_string(),
            owner_agreement_public_key: owner_key.to_string(),
        }
    }

    #[test]
    fn suggesting_a_collaborator_requires_an_active_grant_for_that_project() {
        let root = temp_root();
        let owner_secret = X25519StaticSecret::random_from_rng(OsRng);
        let owner_key = URL_SAFE_NO_PAD.encode(X25519PublicKey::from(&owner_secret).as_bytes());
        let mut document = SyncSecurityDocument::default();
        document.invitations.push(invitation_with_owner("invitation-1", "project-1", "owner-account", &owner_key));
        document.grants.push(grant("collaborator-account", "collaborator-device", false, None));
        save_at(&root, &document).unwrap();

        // No grant for "project-2" at all — must fail closed.
        let missing = prepare_collaborator_suggestion_at(&root, "project-2", "someone-else", "note", 1_000);
        assert!(missing.is_err());

        let ok = prepare_collaborator_suggestion_at(&root, "project-1", "someone-else", "note", 1_000).unwrap();
        assert_eq!(ok.owner_account_route, crate::sync_protocol::account_route_id("owner-account"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn suggesting_a_collaborator_never_touches_grants_or_invitations() {
        let root = temp_root();
        let owner_secret = X25519StaticSecret::random_from_rng(OsRng);
        let owner_key = URL_SAFE_NO_PAD.encode(X25519PublicKey::from(&owner_secret).as_bytes());
        let mut document = SyncSecurityDocument::default();
        document.invitations.push(invitation_with_owner("invitation-1", "project-1", "owner-account", &owner_key));
        document.grants.push(grant("collaborator-account", "collaborator-device", false, None));
        save_at(&root, &document).unwrap();

        prepare_collaborator_suggestion_at(&root, "project-1", "someone-else", "note", 1_000).unwrap();

        let after = load_at(&root).unwrap();
        assert_eq!(after.grants.len(), 1);
        assert_eq!(after.invitations.len(), 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_grant_predating_the_owner_key_field_cannot_be_used_to_suggest() {
        let root = temp_root();
        let mut document = SyncSecurityDocument::default();
        // Old grant/invitation, from before owner_account_id/owner_agreement_public_key existed —
        // both empty, matching #[serde(default)] backward compatibility.
        document.invitations.push(invitation_with_owner("inv-old", "project-1", "", ""));
        document.grants.push(grant("collaborator-account", "collaborator-device", false, None));
        document.grants[0].invitation_id = "inv-old".to_string();
        save_at(&root, &document).unwrap();

        let result = prepare_collaborator_suggestion_at(&root, "project-1", "someone-else", "note", 1_000);
        assert!(result.is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_prepared_collaborator_suggestion_round_trips_and_never_creates_access_by_itself() {
        let owner_secret = X25519StaticSecret::random_from_rng(OsRng);
        let owner_key = URL_SAFE_NO_PAD.encode(X25519PublicKey::from(&owner_secret).as_bytes());
        let root = temp_root();
        let mut document = SyncSecurityDocument::default();
        document.invitations.push(invitation_with_owner("invitation-1", "project-1", "owner-account", &owner_key));
        document.grants.push(grant("collaborator-account", "collaborator-device", false, None));
        save_at(&root, &document).unwrap();

        let envelope = prepare_collaborator_suggestion_at(&root, "project-1", "friend-account", "please add them", 1_000).unwrap();
        let packed = URL_SAFE_NO_PAD.decode(&envelope.ciphertext).unwrap();
        let sealed = crate::sync_chat::unpack_sealed(&packed).unwrap();
        let plaintext = crate::sync_crypto::open_sealed(&sealed, &owner_secret, COLLABORATOR_SUGGESTION_INFO).unwrap();
        let parsed: serde_json::Value = serde_json::from_slice(&plaintext).unwrap();
        assert_eq!(parsed["projectId"], "project-1");
        assert_eq!(parsed["suggestedAccountId"], "friend-account");
        assert_eq!(parsed["note"], "please add them");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn generating_a_new_chat_invite_token_invalidates_the_previous_one() {
        let root = temp_root();
        let first = generate_chat_invite_token_at(&root, 1_000).unwrap();
        let second = generate_chat_invite_token_at(&root, 2_000).unwrap();
        assert_ne!(first, second);
        assert!(!consume_chat_invite_token_at(&root, &first, 3_000).unwrap());
        assert!(consume_chat_invite_token_at(&root, &second, 3_000).unwrap());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_chat_invite_token_is_single_use() {
        let root = temp_root();
        let token = generate_chat_invite_token_at(&root, 1_000).unwrap();
        assert!(consume_chat_invite_token_at(&root, &token, 2_000).unwrap());
        assert!(!consume_chat_invite_token_at(&root, &token, 3_000).unwrap());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn an_expired_or_unknown_chat_invite_token_fails_closed() {
        let root = temp_root();
        let token = generate_chat_invite_token_at(&root, 1_000).unwrap();
        assert!(!consume_chat_invite_token_at(&root, &token, 1_000 + CHAT_INVITE_TOKEN_TTL_MS).unwrap());
        assert!(!consume_chat_invite_token_at(&root, "cit_never_existed", 1_000).unwrap());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_valid_chat_contact_ack_auto_adds_the_sender_and_is_never_reusable() {
        let issuer_secret = X25519StaticSecret::random_from_rng(OsRng);
        let issuer_key = URL_SAFE_NO_PAD.encode(X25519PublicKey::from(&issuer_secret).as_bytes());
        let issuer_root = temp_root();
        let token = generate_chat_invite_token_at(&issuer_root, 1_000).unwrap();

        // Sealing an ack is the *friend's* own device acting — needs its own account on record,
        // distinct from the issuer's, so `seal_chat_contact_ack_at` can embed `accountId`.
        let friend_root = temp_root();
        let mut friend_document = SyncSecurityDocument::default();
        friend_document.account = Some(account("friend-account"));
        save_at(&friend_root, &friend_document).unwrap();

        let ciphertext = seal_chat_contact_ack_at(
            &friend_root,
            token,
            "route-friend".to_string(),
            "friend-device".to_string(),
            "friend-agreement-key".to_string(),
            "Friend".to_string(),
            issuer_key,
            None,
        )
        .unwrap();

        // Decrypt manually (no keyring in tests) — same pattern as the chat-relay round-trip test.
        let packed = URL_SAFE_NO_PAD.decode(&ciphertext).unwrap();
        let sealed = crate::sync_chat::unpack_sealed(&packed).unwrap();
        let plaintext = crate::sync_crypto::open_sealed(&sealed, &issuer_secret, CHAT_CONTACT_ACK_INFO).unwrap();
        let parsed: serde_json::Value = serde_json::from_slice(&plaintext).unwrap();
        let token = parsed["token"].as_str().unwrap();

        // Simulate what `sync_open_chat_contact_ack` does once decrypted: consume, then add.
        assert!(consume_chat_invite_token_at(&issuer_root, token, 2_000).unwrap());
        add_chat_contact_at(
            &issuer_root,
            ChatContactRecord {
                account_route: parsed["accountRoute"].as_str().unwrap().to_string(),
                device_id: parsed["deviceId"].as_str().unwrap().to_string(),
                agreement_public_key: parsed["agreementPublicKey"].as_str().unwrap().to_string(),
                display_label: parsed["displayLabel"].as_str().unwrap().to_string(),
                added_at_ms: 2_000,
                avatar_thumbnail: None,
                bio: None,
            },
        )
        .unwrap();

        let contacts = list_chat_contacts_at(&issuer_root).unwrap();
        assert_eq!(contacts.len(), 1);
        assert_eq!(contacts[0].account_route, "route-friend");
        // Replaying the same token a second time must fail closed.
        assert!(!consume_chat_invite_token_at(&issuer_root, token, 3_000).unwrap());
        fs::remove_dir_all(issuer_root).unwrap();
        fs::remove_dir_all(friend_root).unwrap();
    }

    #[derive(Default)]
    struct MemorySecrets(Mutex<HashMap<String, Vec<u8>>>);

    impl DeviceSecretStore for MemorySecrets {
        fn set(&self, device_id: &str, secret: &[u8]) -> Result<(), String> {
            self.0
                .lock()
                .unwrap()
                .insert(device_id.to_string(), secret.to_vec());
            Ok(())
        }

        fn delete(&self, device_id: &str) -> Result<(), String> {
            self.0.lock().unwrap().remove(device_id);
            Ok(())
        }
    }

    fn temp_root() -> PathBuf {
        let root = std::env::temp_dir().join(format!("alethe-sync-security-{}", nanoid::nanoid!()));
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn account(id: &str) -> VerifiedAccount {
        VerifiedAccount {
            account_id: id.to_string(),
            provider: "google".to_string(),
            display_name: "Test User".to_string(),
            email_hint: Some("t***@example.test".to_string()),
            connected_at_ms: 1_000,
        }
    }

    #[test]
    fn stores_private_key_only_in_credential_store() {
        let root = temp_root();
        let secrets = MemorySecrets::default();
        let device =
            complete_verified_identity(&root, &secrets, account("acct-a"), "Linux PC", 2_000)
                .unwrap();
        complete_verified_identity(&root, &secrets, account("acct-a"), "Windows PC", 3_000)
            .unwrap();

        let persisted = fs::read_to_string(security_document_path(&root)).unwrap();
        let secret = secrets
            .0
            .lock()
            .unwrap()
            .get(&device.device_id)
            .unwrap()
            .clone();
        assert_eq!(secret.len(), 32);
        assert!(!persisted.contains(&URL_SAFE_NO_PAD.encode(secret)));
        assert!(persisted.contains(&device.public_key_fingerprint));
        let loaded = load_at(&root).unwrap();
        assert_eq!(loaded.devices.len(), 2);
        assert_eq!(loaded.audit[0].kind, "device.registered_first_device_trusted");
        assert_eq!(loaded.audit[1].kind, "device.registered");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn registration_creates_a_verifiable_agreement_key_binding_with_its_own_secret() {
        let root = temp_root();
        let secrets = MemorySecrets::default();
        let device =
            complete_verified_identity(&root, &secrets, account("acct-a"), "Laptop", 1_000)
                .unwrap();

        let agreement_secret = secrets
            .0
            .lock()
            .unwrap()
            .get(&agreement_secret_entry_id(&device.device_id))
            .unwrap()
            .clone();
        assert_eq!(agreement_secret.len(), 32);

        let binding = crate::sync_crypto::DeviceKeyBinding {
            device_id: device.device_id.clone(),
            ed25519_public_key: URL_SAFE_NO_PAD.decode(&device.public_key).unwrap(),
            x25519_public_key: URL_SAFE_NO_PAD
                .decode(device.agreement_public_key.as_ref().unwrap())
                .unwrap(),
            bound_at_ms: device.agreement_key_bound_at_ms.unwrap(),
            signature: URL_SAFE_NO_PAD
                .decode(device.agreement_key_binding_signature.as_ref().unwrap())
                .unwrap(),
        };
        assert!(crate::sync_crypto::verify_key_binding(&binding).is_ok());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn revoking_a_device_deletes_both_its_identity_and_agreement_secrets() {
        let root = temp_root();
        let secrets = MemorySecrets::default();
        let first =
            complete_verified_identity(&root, &secrets, account("acct-a"), "Laptop", 1_000)
                .unwrap();
        let second =
            complete_verified_identity(&root, &secrets, account("acct-a"), "Desktop", 2_000)
                .unwrap();
        approve_device_at(&root, &first.device_id, &second.device_id, 3_000).unwrap();

        revoke_device_at(&root, &secrets, &first.device_id, &second.device_id, 4_000).unwrap();

        let store = secrets.0.lock().unwrap();
        assert!(store.get(&second.device_id).is_none());
        assert!(store
            .get(&agreement_secret_entry_id(&second.device_id))
            .is_none());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_second_pending_device_publishes_an_access_center_record_but_the_first_does_not() {
        let root = temp_root();
        let secrets = MemorySecrets::default();
        let first = complete_verified_identity(&root, &secrets, account("acct-a"), "Laptop", 1_000).unwrap();
        assert!(crate::sync_access::list_at(&root, 1_000).unwrap().is_empty());

        let second = complete_verified_identity(&root, &secrets, account("acct-a"), "Desktop", 2_000).unwrap();
        let records = crate::sync_access::list_at(&root, 2_000).unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].kind, crate::sync_access::AccessKind::DevicePendingApproval);
        assert_eq!(records[0].category, crate::sync_access::AccessCategory::Security);
        assert_eq!(records[0].subject_handle, second.device_id);
        assert_ne!(second.device_id, first.device_id);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn redeeming_an_invitation_publishes_an_access_center_record() {
        let root = temp_root();
        let secrets = MemorySecrets::default();
        let issuer = complete_verified_identity(&root, &secrets, account("acct-owner"), "Owner", 1_000).unwrap();
        let issued = issue_invitation(
            &root,
            &issuer.device_id,
            "project-a",
            "acct-recipient",
            Some("device-recipient".to_string()),
            vec![SyncPermission::Read],
            vec![],
            2_000,
            10_000,
        )
        .unwrap();

        redeem_invitation(
            &root,
            &issued.invitation.invitation_id,
            &issued.bearer_token,
            "acct-recipient",
            "device-recipient",
            3_000,
        )
        .unwrap();

        let records = crate::sync_access::list_at(&root, 3_000).unwrap();
        let record = records
            .iter()
            .find(|record| record.kind == crate::sync_access::AccessKind::InvitationRedeemed)
            .unwrap();
        assert_eq!(record.category, crate::sync_access::AccessCategory::Collaboration);
        assert_eq!(record.subject_handle, issued.invitation.invitation_id);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn disconnect_removes_device_secrets_and_identity_document() {
        let root = temp_root();
        let secrets = MemorySecrets::default();
        complete_verified_identity(&root, &secrets, account("acct-a"), "Linux PC", 2_000).unwrap();
        complete_verified_identity(&root, &secrets, account("acct-a"), "Windows PC", 3_000)
            .unwrap();

        disconnect_identity_at(&root, &secrets).unwrap();

        assert!(secrets.0.lock().unwrap().is_empty());
        assert!(!security_document_path(&root).exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_corrupt_documents_and_implicit_account_switches() {
        let root = temp_root();
        let secrets = MemorySecrets::default();
        complete_verified_identity(&root, &secrets, account("acct-a"), "PC", 2_000).unwrap();
        assert_eq!(
            complete_verified_identity(&root, &secrets, account("acct-b"), "PC", 3_000),
            Err("account_switch_requires_disconnect".to_string())
        );

        fs::write(security_document_path(&root), b"{broken").unwrap();
        assert_eq!(load_at(&root), Err("security_document_invalid".to_string()));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_devices_not_bound_to_the_verified_account() {
        let document = SyncSecurityDocument {
            schema_version: SECURITY_SCHEMA_VERSION,
            account: Some(account("acct-a")),
            local_device_id: Some("device-a".to_string()),
            devices: vec![DeviceRecord {
                device_id: "device-a".to_string(),
                account_id: "acct-b".to_string(),
                display_name: "PC".to_string(),
                public_key: "public".to_string(),
                public_key_fingerprint: "fingerprint".to_string(),
                trust: DeviceTrust::Pending,
                registered_at_ms: 1,
                last_verified_at_ms: None,
                revoked_at_ms: None,
                agreement_public_key: None,
                agreement_key_bound_at_ms: None,
                agreement_key_binding_signature: None,
                key_rotated_at_ms: None,
            }],
            invitations: vec![],
            grants: vec![],
            chat_contacts: vec![],
            chat_invite_tokens: vec![],
            pending_chat_contact_requests: vec![],
            audit: vec![],
        };
        assert_eq!(
            validate_document(&document),
            Err("security_device_invalid".to_string())
        );
    }

    #[test]
    fn invitation_is_single_use_and_creates_one_bound_grant() {
        let root = temp_root();
        let secrets = MemorySecrets::default();
        let issuer =
            complete_verified_identity(&root, &secrets, account("acct-owner"), "Owner", 1_000)
                .unwrap();
        let mut document = load_at(&root).unwrap();
        document.devices[0].trust = DeviceTrust::Trusted;
        document.devices[0].last_verified_at_ms = Some(1_500);
        save_at(&root, &document).unwrap();

        let issued = issue_invitation(
            &root,
            &issuer.device_id,
            "project-a",
            "acct-recipient",
            Some("device-recipient".to_string()),
            vec![SyncPermission::Read, SyncPermission::Write],
            vec![PathScope {
                effect: ScopeEffect::Allow,
                pattern: "src/**".to_string(),
            }],
            2_000,
            10_000,
        )
        .unwrap();
        let persisted = fs::read_to_string(security_document_path(&root)).unwrap();
        assert!(!persisted.contains(&issued.bearer_token));

        let grant = redeem_invitation(
            &root,
            &issued.invitation.invitation_id,
            &issued.bearer_token,
            "acct-recipient",
            "device-recipient",
            3_000,
        )
        .unwrap();
        assert_eq!(grant.project_id, "project-a");
        assert_eq!(grant.device_id, "device-recipient");
        assert_eq!(
            redeem_invitation(
                &root,
                &issued.invitation.invitation_id,
                &issued.bearer_token,
                "acct-recipient",
                "device-recipient",
                3_001,
            ),
            Err("invitation_unavailable".to_string())
        );
        assert_eq!(load_at(&root).unwrap().grants.len(), 1);
        let public = snapshot_at(&root).unwrap();
        assert!(!serde_json::to_string(&public)
            .unwrap()
            .contains(&issued.invitation.token_hash));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rotating_device_keys_replaces_both_key_pairs_and_records_the_timestamp() {
        let root = temp_root();
        let secrets = MemorySecrets::default();
        let device = complete_verified_identity(&root, &secrets, account("acct-a"), "Laptop", 1_000).unwrap();
        let original_public_key = device.public_key.clone();
        let original_agreement_key = device.agreement_public_key.clone();

        let rotated = rotate_device_keys_at(&root, &secrets, &device.device_id, 2_000).unwrap();

        assert_ne!(rotated.public_key, original_public_key);
        assert_ne!(rotated.agreement_public_key, original_agreement_key);
        assert_eq!(rotated.key_rotated_at_ms, Some(2_000));
        assert_eq!(rotated.device_id, device.device_id);
        assert_eq!(rotated.trust, DeviceTrust::Trusted);

        // The new binding verifies; the credential store now holds only the new secret key.
        let signing_key_bytes = secrets.0.lock().unwrap().get(&device.device_id).cloned().unwrap();
        assert_eq!(
            URL_SAFE_NO_PAD.encode(SigningKey::from_bytes(&signing_key_bytes.try_into().unwrap()).verifying_key().as_bytes()),
            rotated.public_key
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rotating_keys_for_an_untrusted_or_unknown_device_is_rejected() {
        let root = temp_root();
        let secrets = MemorySecrets::default();
        let first = complete_verified_identity(&root, &secrets, account("acct-a"), "Laptop", 1_000).unwrap();
        let second = complete_verified_identity(&root, &secrets, account("acct-a"), "Desktop", 2_000).unwrap();
        assert_eq!(second.trust, DeviceTrust::Pending);

        assert_eq!(
            rotate_device_keys_at(&root, &secrets, &second.device_id, 3_000),
            Err("actor_device_not_trusted".to_string())
        );
        assert_eq!(
            rotate_device_keys_at(&root, &secrets, "dev_unknown", 3_000),
            Err("actor_device_unknown".to_string())
        );
        let _ = first;
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn account_export_contains_no_raw_keys_or_bearer_material() {
        let root = temp_root();
        let secrets = MemorySecrets::default();
        let issuer = complete_verified_identity(&root, &secrets, account("acct-owner"), "Owner", 1_000).unwrap();
        let issued = issue_invitation(
            &root, &issuer.device_id, "project-a", "acct-recipient", None, vec![SyncPermission::Read], vec![],
            2_000, 10_000,
        )
        .unwrap();
        redeem_invitation(&root, &issued.invitation.invitation_id, &issued.bearer_token, "acct-recipient", "device-recipient", 3_000)
            .unwrap();

        let export = export_account_data_at(&root, 4_000).unwrap();
        assert_eq!(export.devices.len(), 1);
        assert_eq!(export.invitations.len(), 1);
        assert_eq!(export.grants.len(), 1);
        let serialized = serde_json::to_string(&export).unwrap();
        assert!(!serialized.contains(&issuer.public_key));
        assert!(!serialized.contains(&issued.bearer_token));
        assert!(!serialized.contains(&issued.invitation.token_hash));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn deleting_project_access_revokes_every_grant_and_pending_invitation_for_that_project() {
        let root = temp_root();
        let secrets = MemorySecrets::default();
        let issuer = complete_verified_identity(&root, &secrets, account("acct-owner"), "Owner", 1_000).unwrap();
        let issued_a = issue_invitation(
            &root, &issuer.device_id, "project-a", "acct-recipient-1", None, vec![SyncPermission::Read], vec![],
            2_000, 10_000,
        )
        .unwrap();
        redeem_invitation(&root, &issued_a.invitation.invitation_id, &issued_a.bearer_token, "acct-recipient-1", "device-1", 2_500)
            .unwrap();
        // A second, still-pending invitation to the same project, never redeemed.
        issue_invitation(
            &root, &issuer.device_id, "project-a", "acct-recipient-2", None, vec![SyncPermission::Read], vec![],
            2_600, 10_000,
        )
        .unwrap();
        // An unrelated project must be untouched.
        let issued_b = issue_invitation(
            &root, &issuer.device_id, "project-b", "acct-recipient-3", None, vec![SyncPermission::Read], vec![],
            2_700, 10_000,
        )
        .unwrap();
        redeem_invitation(&root, &issued_b.invitation.invitation_id, &issued_b.bearer_token, "acct-recipient-3", "device-3", 2_800)
            .unwrap();

        let affected = delete_project_access_at(&root, &issuer.device_id, "project-a", 5_000).unwrap();
        assert_eq!(affected, 2); // one grant + one still-pending invitation

        let document = load_at(&root).unwrap();
        let project_a_grant = document.grants.iter().find(|g| g.project_id == "project-a").unwrap();
        assert!(project_a_grant.revoked_at_ms.is_some());
        let project_a_invitations: Vec<_> = document.invitations.iter().filter(|i| i.project_id == "project-a").collect();
        assert_eq!(project_a_invitations.len(), 2);
        // The already-redeemed invitation keeps its historical Redeemed state — it is not
        // retroactively marked Revoked, only the grant it produced is. The still-pending one is
        // the only invitation actually revoked by this call.
        assert_eq!(
            project_a_invitations.iter().filter(|i| i.state == InvitationState::Revoked).count(),
            1
        );
        assert_eq!(
            project_a_invitations.iter().filter(|i| i.state == InvitationState::Redeemed).count(),
            1
        );
        let project_b_grant = document.grants.iter().find(|g| g.project_id == "project-b").unwrap();
        assert!(project_b_grant.revoked_at_ms.is_none());

        // Idempotent: nothing left to revoke.
        assert_eq!(delete_project_access_at(&root, &issuer.device_id, "project-a", 6_000).unwrap(), 0);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn an_unknown_device_cannot_delete_project_access_and_a_project_with_no_access_is_a_safe_no_op() {
        let root = temp_root();
        let secrets = MemorySecrets::default();
        let issuer = complete_verified_identity(&root, &secrets, account("acct-owner"), "Owner", 1_000).unwrap();
        issue_invitation(
            &root, &issuer.device_id, "project-a", "acct-recipient", None, vec![SyncPermission::Read], vec![],
            2_000, 10_000,
        )
        .unwrap();

        assert_eq!(
            delete_project_access_at(&root, "device-unknown", "project-a", 3_000),
            Err("actor_device_unknown".to_string())
        );
        // A project this account never issued anything for: the ownership check fails closed
        // rather than silently succeeding with zero effect.
        assert_eq!(
            delete_project_access_at(&root, &issuer.device_id, "project-never-issued", 3_000),
            Err("project_access_unavailable".to_string())
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn invitation_failures_are_generic_rate_limited_and_fail_closed() {
        let root = temp_root();
        let secrets = MemorySecrets::default();
        let issuer =
            complete_verified_identity(&root, &secrets, account("acct-owner"), "Owner", 1_000)
                .unwrap();
        let mut document = load_at(&root).unwrap();
        document.devices[0].trust = DeviceTrust::Trusted;
        save_at(&root, &document).unwrap();
        let issued = issue_invitation(
            &root,
            &issuer.device_id,
            "project-a",
            "acct-recipient",
            None,
            vec![SyncPermission::Read],
            vec![],
            2_000,
            100_000,
        )
        .unwrap();

        for attempt in 0..MAX_INVITATION_FAILURES {
            assert_eq!(
                redeem_invitation(
                    &root,
                    &issued.invitation.invitation_id,
                    "wrong",
                    "acct-recipient",
                    "device-recipient",
                    3_000 + u64::from(attempt),
                ),
                Err("invitation_unavailable".to_string())
            );
        }
        assert_eq!(
            redeem_invitation(
                &root,
                &issued.invitation.invitation_id,
                &issued.bearer_token,
                "acct-recipient",
                "device-recipient",
                4_000,
            ),
            Err("invitation_unavailable".to_string())
        );
        assert!(load_at(&root).unwrap().grants.is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn invalid_permissions_and_scopes_never_persist() {
        assert_eq!(
            validate_permissions(&[SyncPermission::Write]),
            Err("permission_dependency_missing".to_string())
        );
        assert_eq!(
            validate_scopes(&[PathScope {
                effect: ScopeEffect::Deny,
                pattern: "../secret/**".to_string(),
            }]),
            Err("path_scope_invalid".to_string())
        );
    }

    #[test]
    fn first_device_is_trusted_automatically_and_later_devices_are_not() {
        let root = temp_root();
        let secrets = MemorySecrets::default();
        let first =
            complete_verified_identity(&root, &secrets, account("acct-a"), "Laptop", 1_000)
                .unwrap();
        let second =
            complete_verified_identity(&root, &secrets, account("acct-a"), "Desktop", 2_000)
                .unwrap();
        assert_eq!(first.trust, DeviceTrust::Trusted);
        assert_eq!(second.trust, DeviceTrust::Pending);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn pending_device_cannot_act_before_approval_and_approval_requires_trusted_actor() {
        let root = temp_root();
        let secrets = MemorySecrets::default();
        let first =
            complete_verified_identity(&root, &secrets, account("acct-a"), "Laptop", 1_000)
                .unwrap();
        let second =
            complete_verified_identity(&root, &secrets, account("acct-a"), "Desktop", 2_000)
                .unwrap();

        assert_eq!(
            approve_device_at(&root, &second.device_id, &first.device_id, 3_000),
            Err("actor_device_not_trusted".to_string())
        );
        assert_eq!(
            issue_invitation(
                &root,
                &second.device_id,
                "project-a",
                "acct-recipient",
                None,
                vec![SyncPermission::Read],
                vec![],
                3_000,
                10_000,
            ),
            Err("issuer_device_not_trusted".to_string())
        );

        let approved = approve_device_at(&root, &first.device_id, &second.device_id, 4_000).unwrap();
        assert_eq!(approved.trust, DeviceTrust::Trusted);
        assert_eq!(approved.last_verified_at_ms, Some(4_000));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reject_removes_a_pending_device_and_its_secret_without_ever_trusting_it() {
        let root = temp_root();
        let secrets = MemorySecrets::default();
        let first =
            complete_verified_identity(&root, &secrets, account("acct-a"), "Laptop", 1_000)
                .unwrap();
        let second =
            complete_verified_identity(&root, &secrets, account("acct-a"), "Desktop", 2_000)
                .unwrap();

        reject_device_at(&root, &secrets, &first.device_id, &second.device_id, 3_000).unwrap();

        assert!(secrets.0.lock().unwrap().get(&second.device_id).is_none());
        assert!(load_at(&root)
            .unwrap()
            .devices
            .iter()
            .all(|device| device.device_id != second.device_id));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rename_device_updates_only_its_own_record() {
        let root = temp_root();
        let secrets = MemorySecrets::default();
        let first =
            complete_verified_identity(&root, &secrets, account("acct-a"), "Laptop", 1_000)
                .unwrap();

        let renamed = rename_device_at(&root, &first.device_id, "  Miguel's Laptop  ", 2_000).unwrap();
        assert_eq!(renamed.display_name, "Miguel's Laptop");
        assert_eq!(
            rename_device_at(&root, &first.device_id, "   ", 3_000),
            Err("device_name_invalid".to_string())
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn revoke_deletes_the_secret_and_invalidates_grants_bound_to_the_device() {
        let root = temp_root();
        let secrets = MemorySecrets::default();
        let issuer =
            complete_verified_identity(&root, &secrets, account("acct-owner"), "Owner", 1_000)
                .unwrap();
        let recipient =
            complete_verified_identity(&root, &secrets, account("acct-owner"), "Phone", 1_500)
                .unwrap();
        approve_device_at(&root, &issuer.device_id, &recipient.device_id, 1_600).unwrap();

        let issued = issue_invitation(
            &root,
            &issuer.device_id,
            "project-a",
            "acct-owner",
            Some(recipient.device_id.clone()),
            vec![SyncPermission::Read],
            vec![],
            2_000,
            10_000,
        )
        .unwrap();
        let grant = redeem_invitation(
            &root,
            &issued.invitation.invitation_id,
            &issued.bearer_token,
            "acct-owner",
            &recipient.device_id,
            3_000,
        )
        .unwrap();
        assert!(grant.revoked_at_ms.is_none());

        let revoked =
            revoke_device_at(&root, &secrets, &issuer.device_id, &recipient.device_id, 4_000)
                .unwrap();
        assert_eq!(revoked.trust, DeviceTrust::Revoked);
        assert!(secrets.0.lock().unwrap().get(&recipient.device_id).is_none());
        let document = load_at(&root).unwrap();
        assert!(document
            .grants
            .iter()
            .find(|g| g.grant_id == grant.grant_id)
            .unwrap()
            .revoked_at_ms
            .is_some());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn remove_device_requires_prior_revocation() {
        let root = temp_root();
        let secrets = MemorySecrets::default();
        let first =
            complete_verified_identity(&root, &secrets, account("acct-a"), "Laptop", 1_000)
                .unwrap();
        let second =
            complete_verified_identity(&root, &secrets, account("acct-a"), "Desktop", 2_000)
                .unwrap();
        approve_device_at(&root, &first.device_id, &second.device_id, 3_000).unwrap();

        assert_eq!(
            remove_device_at(&root, &first.device_id, &second.device_id, 4_000),
            Err("target_device_not_revoked".to_string())
        );
        revoke_device_at(&root, &secrets, &first.device_id, &second.device_id, 5_000).unwrap();
        remove_device_at(&root, &first.device_id, &second.device_id, 6_000).unwrap();
        assert!(load_at(&root)
            .unwrap()
            .devices
            .iter()
            .all(|device| device.device_id != second.device_id));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn revoke_invitation_blocks_future_redemption_and_requires_issuer_account() {
        let root = temp_root();
        let secrets = MemorySecrets::default();
        let issuer =
            complete_verified_identity(&root, &secrets, account("acct-owner"), "Owner", 1_000)
                .unwrap();
        let issued = issue_invitation(
            &root,
            &issuer.device_id,
            "project-a",
            "acct-recipient",
            None,
            vec![SyncPermission::Read],
            vec![],
            2_000,
            10_000,
        )
        .unwrap();

        assert_eq!(
            revoke_invitation_at(&root, "device-unknown", &issued.invitation.invitation_id, 2_500),
            Err("actor_device_unknown".to_string())
        );

        let revoked =
            revoke_invitation_at(&root, &issuer.device_id, &issued.invitation.invitation_id, 3_000)
                .unwrap();
        assert_eq!(revoked.state, InvitationState::Revoked);
        assert_eq!(
            redeem_invitation(
                &root,
                &issued.invitation.invitation_id,
                &issued.bearer_token,
                "acct-recipient",
                "device-recipient",
                3_500,
            ),
            Err("invitation_unavailable".to_string())
        );
        assert_eq!(
            revoke_invitation_at(&root, &issuer.device_id, &issued.invitation.invitation_id, 4_000),
            Err("invitation_not_revocable".to_string())
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn revoke_grant_is_idempotent_safe_and_scoped_to_the_issuing_account() {
        let root = temp_root();
        let secrets = MemorySecrets::default();
        let issuer =
            complete_verified_identity(&root, &secrets, account("acct-owner"), "Owner", 1_000)
                .unwrap();
        let co_owner =
            complete_verified_identity(&root, &secrets, account("acct-owner"), "Phone", 1_200)
                .unwrap();
        approve_device_at(&root, &issuer.device_id, &co_owner.device_id, 1_300).unwrap();
        let issued = issue_invitation(
            &root,
            &issuer.device_id,
            "project-a",
            "acct-recipient",
            Some("device-recipient".to_string()),
            vec![SyncPermission::Read],
            vec![],
            2_000,
            10_000,
        )
        .unwrap();
        let grant = redeem_invitation(
            &root,
            &issued.invitation.invitation_id,
            &issued.bearer_token,
            "acct-recipient",
            "device-recipient",
            3_000,
        )
        .unwrap();

        assert_eq!(
            revoke_grant_at(&root, "device-unknown", &grant.grant_id, 3_500),
            Err("actor_device_unknown".to_string())
        );

        // Any trusted device on the account that issued the invitation may revoke the grant,
        // not only the exact device that issued it.
        let revoked = revoke_grant_at(&root, &co_owner.device_id, &grant.grant_id, 4_000).unwrap();
        assert!(revoked.revoked_at_ms.is_some());
        assert_eq!(
            revoke_grant_at(&root, &issuer.device_id, &grant.grant_id, 5_000),
            Err("grant_already_revoked".to_string())
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn update_grant_narrows_permissions_and_is_scoped_like_revoke() {
        let root = temp_root();
        let secrets = MemorySecrets::default();
        let issuer =
            complete_verified_identity(&root, &secrets, account("acct-owner"), "Owner", 1_000)
                .unwrap();
        let issued = issue_invitation(
            &root,
            &issuer.device_id,
            "project-a",
            "acct-recipient",
            Some("device-recipient".to_string()),
            vec![SyncPermission::Read, SyncPermission::Write],
            vec![PathScope { effect: ScopeEffect::Allow, pattern: "**".to_string() }],
            2_000,
            10_000,
        )
        .unwrap();
        let grant = redeem_invitation(
            &root,
            &issued.invitation.invitation_id,
            &issued.bearer_token,
            "acct-recipient",
            "device-recipient",
            3_000,
        )
        .unwrap();
        assert_eq!(grant.permissions, vec![SyncPermission::Read, SyncPermission::Write]);

        // An unrelated device cannot edit someone else's grant, same rule as revocation.
        assert_eq!(
            update_grant_at(
                &root,
                "device-unknown",
                &grant.grant_id,
                vec![SyncPermission::Read],
                vec![],
                3_500,
            ),
            Err("actor_device_unknown".to_string())
        );

        // The issuer narrows the grant down to read-only on a single subfolder.
        let updated = update_grant_at(
            &root,
            &issuer.device_id,
            &grant.grant_id,
            vec![SyncPermission::Read],
            vec![PathScope { effect: ScopeEffect::Allow, pattern: "docs/**".to_string() }],
            4_000,
        )
        .unwrap();
        assert_eq!(updated.permissions, vec![SyncPermission::Read]);
        assert_eq!(updated.path_scopes, vec![PathScope { effect: ScopeEffect::Allow, pattern: "docs/**".to_string() }]);
        assert!(updated.revoked_at_ms.is_none());
        assert_eq!(updated.grant_id, grant.grant_id); // same grant, not a new one

        // The change actually persisted, not just returned in memory.
        let grants = list_project_grants_at(&root, "project-a").unwrap();
        assert_eq!(grants.len(), 1);
        assert_eq!(grants[0].permissions, vec![SyncPermission::Read]);

        // A revoked grant can no longer be edited.
        revoke_grant_at(&root, &issuer.device_id, &grant.grant_id, 5_000).unwrap();
        assert_eq!(
            update_grant_at(&root, &issuer.device_id, &grant.grant_id, vec![SyncPermission::Read], vec![], 6_000),
            Err("grant_already_revoked".to_string())
        );
        // ...and a revoked grant no longer shows up in the project's active-grant list.
        assert!(list_project_grants_at(&root, "project-a").unwrap().is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn update_grant_rejects_invalid_permissions_and_scopes_without_touching_the_grant() {
        let root = temp_root();
        let secrets = MemorySecrets::default();
        let issuer =
            complete_verified_identity(&root, &secrets, account("acct-owner"), "Owner", 1_000)
                .unwrap();
        let issued = issue_invitation(
            &root, &issuer.device_id, "project-a", "acct-recipient", Some("device-recipient".to_string()),
            vec![SyncPermission::Read], vec![], 2_000, 10_000,
        )
        .unwrap();
        let grant = redeem_invitation(
            &root, &issued.invitation.invitation_id, &issued.bearer_token, "acct-recipient",
            "device-recipient", 3_000,
        )
        .unwrap();

        // An absolute/parent-escaping pattern is exactly what `validate_scopes` exists to reject —
        // same validation `issue_invitation` already relies on, reused here rather than
        // reimplemented, so this must fail closed identically.
        let result = update_grant_at(
            &root, &issuer.device_id, &grant.grant_id, vec![SyncPermission::Read],
            vec![PathScope { effect: ScopeEffect::Allow, pattern: "../escape".to_string() }], 4_000,
        );
        assert!(result.is_err());

        // Rejected outright — the grant's original permissions/scopes are untouched.
        let unchanged = list_project_grants_at(&root, "project-a").unwrap();
        assert_eq!(unchanged.len(), 1);
        assert_eq!(unchanged[0].permissions, vec![SyncPermission::Read]);
        assert!(unchanged[0].path_scopes.is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn chat_contact_confirm_only_opens_for_its_actual_recipient() {
        let recipient_secret = X25519StaticSecret::random_from_rng(OsRng);
        let recipient_key = URL_SAFE_NO_PAD.encode(X25519PublicKey::from(&recipient_secret).as_bytes());
        let stranger_secret = X25519StaticSecret::random_from_rng(OsRng);

        let ciphertext = seal_chat_contact_confirm(&recipient_key, serde_json::Value::Null).unwrap();

        // The real recipient's secret opens it.
        let packed = URL_SAFE_NO_PAD.decode(&ciphertext).unwrap();
        let sealed = crate::sync_chat::unpack_sealed(&packed).unwrap();
        assert!(
            crate::sync_crypto::open_sealed(&sealed, &recipient_secret, CHAT_CONTACT_CONFIRM_INFO).is_ok()
        );
        // Nobody else's secret does — this is the whole security property `sync_open_chat_contact_
        // confirm` relies on: a successful decrypt *is* the confirmation, there is no separate
        // token to check.
        assert!(
            crate::sync_crypto::open_sealed(&sealed, &stranger_secret, CHAT_CONTACT_CONFIRM_INFO).is_err()
        );
    }

    #[test]
    fn normalize_permissions_adds_read_when_required_and_dedups() {
        assert_eq!(
            normalize_permissions(vec![SyncPermission::Write]),
            vec![SyncPermission::Read, SyncPermission::Write]
        );
        assert_eq!(
            normalize_permissions(vec![SyncPermission::Read, SyncPermission::Read]),
            vec![SyncPermission::Read]
        );
    }

    #[test]
    fn capabilities_are_unavailable_before_any_account_is_verified() {
        let root = temp_root();
        let capabilities = resolve_capabilities_at(&root).unwrap();
        assert_eq!(capabilities.identity, CapabilityState::Unavailable);
        assert_eq!(capabilities.device_trust, CapabilityState::Unavailable);
        assert_eq!(capabilities.invitations, CapabilityState::Unavailable);
        assert_eq!(capabilities.project_transfer, CapabilityState::Unavailable);
        assert_eq!(capabilities.shared_tasks, CapabilityState::Unavailable);
        assert_eq!(capabilities.project_chat, CapabilityState::Unavailable);
        assert!(!capabilities.verified_encryption);
    }

    #[test]
    fn capabilities_reflect_this_devices_real_trust_state_not_the_accounts() {
        let root = temp_root();
        let secrets = MemorySecrets::default();
        complete_verified_identity(&root, &secrets, account("acct-a"), "Laptop", 1_000).unwrap();
        let first_device_capabilities = resolve_capabilities_at(&root).unwrap();
        assert_eq!(first_device_capabilities.identity, CapabilityState::Available);
        assert_eq!(first_device_capabilities.device_trust, CapabilityState::Available);
        assert_eq!(first_device_capabilities.invitations, CapabilityState::Experimental);

        // A second registration in the same document simulates what a second, still-pending
        // device would see as `local_device_id` if it queried its own capabilities: identity is
        // available (the account is verified), but this specific device is not yet trusted, so
        // it cannot invite.
        let second_device_id =
            complete_verified_identity(&root, &secrets, account("acct-a"), "Desktop", 2_000)
                .unwrap()
                .device_id;
        let mut document = load_at(&root).unwrap();
        document.local_device_id = Some(second_device_id);
        save_at(&root, &document).unwrap();

        let second_device_capabilities = resolve_capabilities_at(&root).unwrap();
        assert_eq!(second_device_capabilities.identity, CapabilityState::Available);
        assert_eq!(second_device_capabilities.device_trust, CapabilityState::Unavailable);
        assert_eq!(second_device_capabilities.invitations, CapabilityState::Unavailable);

        // Every capability that has no real backend implementation yet must never report
        // anything but unavailable, regardless of identity/device state.
        assert_eq!(first_device_capabilities.project_transfer, CapabilityState::Unavailable);
        assert_eq!(first_device_capabilities.shared_tasks, CapabilityState::Unavailable);
        assert_eq!(first_device_capabilities.project_chat, CapabilityState::Unavailable);
        assert!(!first_device_capabilities.verified_encryption);
        fs::remove_dir_all(root).unwrap();
    }

    /// Forbidden-sentinel test (Phase 3 Step 3.8): a serialized public snapshot, a capability
    /// response, and every stable error code emitted by this module must never contain a bearer
    /// token, a private key, or any raw secret material — only opaque IDs, hashes, and enum-like
    /// error codes.
    #[test]
    fn public_snapshot_and_error_codes_never_leak_secret_material() {
        let root = temp_root();
        let secrets = MemorySecrets::default();
        let issuer =
            complete_verified_identity(&root, &secrets, account("acct-owner"), "Owner", 1_000)
                .unwrap();
        let issued = issue_invitation(
            &root,
            &issuer.device_id,
            "project-a",
            "acct-recipient",
            None,
            vec![SyncPermission::Read],
            vec![],
            2_000,
            10_000,
        )
        .unwrap();

        let snapshot = snapshot_at(&root).unwrap();
        let serialized = serde_json::to_string(&snapshot).unwrap();
        assert!(!serialized.contains(&issued.bearer_token));

        let raw_private_key = secrets
            .0
            .lock()
            .unwrap()
            .get(&issuer.device_id)
            .unwrap()
            .clone();
        let private_key_b64 = URL_SAFE_NO_PAD.encode(&raw_private_key);
        assert!(!serialized.contains(&private_key_b64));

        let capabilities = resolve_capabilities_at(&root).unwrap();
        let capabilities_json = serde_json::to_string(&capabilities).unwrap();
        assert!(!capabilities_json.contains(&issued.bearer_token));
        assert!(!capabilities_json.contains(&private_key_b64));

        // Every stable error code this module returns must be a short machine-readable
        // identifier, never an interpolated value that could carry a secret.
        let sample_errors = [
            complete_verified_identity(&root, &secrets, account("acct-owner"), "", 1_000)
                .unwrap_err(),
            redeem_invitation(&root, "unknown-invitation", "wrong-token", "acct-x", "dev-x", 3_000)
                .unwrap_err(),
            approve_device_at(&root, "unknown-device", "unknown-device", 4_000).unwrap_err(),
        ];
        for error in sample_errors {
            assert!(!error.contains(&issued.bearer_token));
            assert!(error.len() < 64, "error code should be short and stable: {error}");
            assert!(
                error.chars().all(|c| c.is_ascii_lowercase() || c == '_'),
                "error code should be a stable snake_case identifier: {error}"
            );
        }
        fs::remove_dir_all(root).unwrap();
    }
}
