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

pub struct PlatformDeviceSecretStore;

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
        return Err(error);
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
    }
    let path = security_document_path(data_root);
    if path.exists() {
        fs::remove_file(path).map_err(|_| "security_document_delete_failed".to_string())?;
    }
    Ok(())
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
    secret_store.delete(target_device_id)
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
}
