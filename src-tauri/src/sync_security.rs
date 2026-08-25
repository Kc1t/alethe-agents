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

fn local_device_id_at(data_root: &Path) -> Result<String, String> {
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueInvitationRequest {
    pub project_id: String,
    pub recipient_account_id: String,
    pub recipient_device_id: Option<String>,
    pub permissions: Vec<SyncPermission>,
    pub path_scopes: Vec<PathScope>,
    pub expires_at_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IssuedInvitationResponse {
    pub invitation: InvitationSummary,
    pub bearer_token: String,
}

fn to_summary(invitation: InvitationRecord) -> InvitationSummary {
    InvitationSummary {
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
    }
}

#[tauri::command]
pub fn sync_issue_invitation(
    app: tauri::AppHandle,
    request: IssueInvitationRequest,
) -> Result<IssuedInvitationResponse, String> {
    let data_root = crate::profiles::resolve_tauri_data_root(&app)?;
    let issuer = local_device_id_at(&data_root)?;
    let issued = issue_invitation(
        &data_root,
        &issuer,
        &request.project_id,
        &request.recipient_account_id,
        request.recipient_device_id,
        normalize_permissions(request.permissions),
        request.path_scopes,
        now_ms(),
        request.expires_at_ms,
    )?;
    Ok(IssuedInvitationResponse {
        invitation: to_summary(issued.invitation),
        bearer_token: issued.bearer_token,
    })
}

#[tauri::command]
pub fn sync_revoke_invitation(
    app: tauri::AppHandle,
    invitation_id: String,
) -> Result<InvitationSummary, String> {
    let data_root = crate::profiles::resolve_tauri_data_root(&app)?;
    let actor = local_device_id_at(&data_root)?;
    revoke_invitation_at(&data_root, &actor, &invitation_id, now_ms()).map(to_summary)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedeemInvitationRequest {
    pub invitation_id: String,
    pub bearer_token: String,
}

#[tauri::command]
pub fn sync_redeem_invitation(
    app: tauri::AppHandle,
    request: RedeemInvitationRequest,
) -> Result<GrantRecord, String> {
    let data_root = crate::profiles::resolve_tauri_data_root(&app)?;
    let document = load_at(&data_root)?;
    let account_id = document
        .account
        .ok_or_else(|| "security_account_invalid".to_string())?
        .account_id;
    let recipient_device_id = document
        .local_device_id
        .ok_or_else(|| "local_device_unknown".to_string())?;
    redeem_invitation(
        &data_root,
        &request.invitation_id,
        &request.bearer_token,
        &account_id,
        &recipient_device_id,
        now_ms(),
    )
}

#[tauri::command]
pub fn sync_revoke_grant(app: tauri::AppHandle, grant_id: String) -> Result<GrantRecord, String> {
    let data_root = crate::profiles::resolve_tauri_data_root(&app)?;
    let actor = local_device_id_at(&data_root)?;
    revoke_grant_at(&data_root, &actor, &grant_id, now_ms())
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
    document.grants.iter().any(|grant| {
        grant.device_id == remote_device_id
            && crate::sync_protocol::account_route_id(&grant.account_id) == remote_account_route
            && grant.revoked_at_ms.is_none()
            && grant.expires_at_ms.is_none_or(|expires| expires > now_ms)
    })
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
