//! Recipient-controlled project subscription (Phase 5). Turns an accepted grant
//! (`sync_security::GrantRecord`) into a local destination/mode decision made explicitly by the
//! recipient. Nothing in this module ever writes project content — that begins in Phase 6, once
//! a manifest/staging protocol exists. The one filesystem write this module performs is creating
//! an empty destination directory shell, and only after final explicit confirmation.

use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

const SUBSCRIPTION_SCHEMA_VERSION: u32 = 1;
/// Coarse pre-flight free-space check. Phase 5 has no manifest yet to size a real transfer
/// against (that arrives in Phase 6); this only rejects an obviously full destination volume.
const MIN_FREE_BYTES: u64 = 10 * 1024 * 1024;
const MAX_DESTINATION_PATH_LEN: usize = 240;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SubscriptionState {
    Offered,
    Configuring,
    AwaitingConfirmation,
    Staging,
    Verifying,
    Active,
    Deferred,
    Declined,
    Paused,
    Revoked,
    Error,
    Removing,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SubscriptionMode {
    ManualSnapshot,
    ReceiveAfterConfirmation,
    Bidirectional,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionRecord {
    pub subscription_id: String,
    pub project_id: String,
    pub grant_id: String,
    pub device_id: String,
    /// Local destination path chosen by the recipient. Never sent to a peer or provider —
    /// stored only in this local, per-device record.
    pub destination: Option<String>,
    pub mode: Option<SubscriptionMode>,
    pub state: SubscriptionState,
    pub exclusion_policy_version: u32,
    pub remote_manifest_revision: Option<String>,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
    pub error_code: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SubscriptionDocument {
    schema_version: u32,
    subscriptions: Vec<SubscriptionRecord>,
}

impl Default for SubscriptionDocument {
    fn default() -> Self {
        Self {
            schema_version: SUBSCRIPTION_SCHEMA_VERSION,
            subscriptions: Vec::new(),
        }
    }
}

pub fn subscription_document_path(data_root: &Path) -> PathBuf {
    data_root.join("sync").join("subscriptions-v1.json")
}

fn load_at(data_root: &Path) -> Result<SubscriptionDocument, String> {
    let path = subscription_document_path(data_root);
    if !path.exists() {
        return Ok(SubscriptionDocument::default());
    }
    let bytes = fs::read(&path).map_err(|_| "subscription_document_read_failed".to_string())?;
    let document: SubscriptionDocument =
        serde_json::from_slice(&bytes).map_err(|_| "subscription_document_invalid".to_string())?;
    if document.schema_version != SUBSCRIPTION_SCHEMA_VERSION {
        return Err("subscription_schema_unsupported".to_string());
    }
    Ok(document)
}

#[cfg(windows)]
fn replace_file(source: &Path, destination: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination.as_os_str().encode_wide().chain(Some(0)).collect();
    let result =
        unsafe { MoveFileExW(source.as_ptr(), destination.as_ptr(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) };
    if result == 0 {
        Err("subscription_document_commit_failed".to_string())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn replace_file(source: &Path, destination: &Path) -> Result<(), String> {
    fs::rename(source, destination).map_err(|_| "subscription_document_commit_failed".to_string())
}

fn save_at(data_root: &Path, document: &SubscriptionDocument) -> Result<(), String> {
    let path = subscription_document_path(data_root);
    let parent = path.parent().ok_or_else(|| "subscription_document_path_invalid".to_string())?;
    fs::create_dir_all(parent).map_err(|_| "subscription_document_directory_failed".to_string())?;
    let temporary = parent.join(format!(".subscriptions-{}.tmp", nanoid::nanoid!(12)));
    let bytes = serde_json::to_vec_pretty(document)
        .map_err(|_| "subscription_document_serialize_failed".to_string())?;
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)
        .map_err(|_| "subscription_document_write_failed".to_string())?;
    if file.write_all(&bytes).and_then(|_| file.sync_all()).is_err() {
        let _ = fs::remove_file(&temporary);
        return Err("subscription_document_write_failed".to_string());
    }
    replace_file(&temporary, &path).map_err(|error| {
        let _ = fs::remove_file(&temporary);
        error
    })
}

/// Creates a new subscription in `Offered` state for an accepted grant. Performs no filesystem
/// write beyond the subscription record itself — no destination directory exists yet.
pub fn offer_subscription_at(
    data_root: &Path,
    project_id: &str,
    grant_id: &str,
    device_id: &str,
    now_ms: u64,
) -> Result<SubscriptionRecord, String> {
    if project_id.trim().is_empty() || grant_id.trim().is_empty() || device_id.trim().is_empty() {
        return Err("subscription_request_invalid".to_string());
    }
    let mut document = load_at(data_root)?;
    if document.subscriptions.iter().any(|s| s.grant_id == grant_id) {
        return Err("subscription_already_exists_for_grant".to_string());
    }
    let record = SubscriptionRecord {
        subscription_id: format!("sub_{}", nanoid::nanoid!(24)),
        project_id: project_id.to_string(),
        grant_id: grant_id.to_string(),
        device_id: device_id.to_string(),
        destination: None,
        mode: None,
        state: SubscriptionState::Offered,
        exclusion_policy_version: 1,
        remote_manifest_revision: None,
        created_at_ms: now_ms,
        updated_at_ms: now_ms,
        error_code: None,
    };
    document.subscriptions.push(record.clone());
    save_at(data_root, &document)?;
    Ok(record)
}

pub fn list_subscriptions_at(data_root: &Path) -> Result<Vec<SubscriptionRecord>, String> {
    Ok(load_at(data_root)?.subscriptions)
}

fn find_mut<'a>(
    document: &'a mut SubscriptionDocument,
    subscription_id: &str,
) -> Result<&'a mut SubscriptionRecord, String> {
    document
        .subscriptions
        .iter_mut()
        .find(|s| s.subscription_id == subscription_id)
        .ok_or_else(|| "subscription_unavailable".to_string())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DestinationError {
    Empty,
    NotAbsolute,
    TooLong,
    ContainsNulByte,
    ParentMissing,
    UnsafeComponent,
    AlreadyAssigned,
    ExistsAsFile,
    ExistsAndNonEmpty,
    InsufficientFreeSpace,
}

impl std::fmt::Display for DestinationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let code = match self {
            DestinationError::Empty => "destination_empty",
            DestinationError::NotAbsolute => "destination_not_absolute",
            DestinationError::TooLong => "destination_path_too_long",
            DestinationError::ContainsNulByte => "destination_invalid_bytes",
            DestinationError::ParentMissing => "destination_parent_missing",
            DestinationError::UnsafeComponent => "destination_unsafe_component",
            DestinationError::AlreadyAssigned => "destination_already_assigned",
            DestinationError::ExistsAsFile => "destination_exists_as_file",
            DestinationError::ExistsAndNonEmpty => "destination_exists_and_non_empty",
            DestinationError::InsufficientFreeSpace => "destination_insufficient_free_space",
        };
        write!(f, "{code}")
    }
}

/// Validates a candidate destination without creating or modifying anything on disk. Rejects
/// traversal-unsafe components, an existing non-empty directory (Phase 5 does not implement the
/// "attach existing copy" dry-run comparison yet — that is Phase 6 work), a path already claimed
/// by another subscription, and an obviously full volume.
fn validate_destination(
    candidate: &str,
    other_destinations: &[String],
) -> Result<PathBuf, DestinationError> {
    if candidate.trim().is_empty() {
        return Err(DestinationError::Empty);
    }
    if candidate.contains('\0') {
        return Err(DestinationError::ContainsNulByte);
    }
    if candidate.len() > MAX_DESTINATION_PATH_LEN {
        return Err(DestinationError::TooLong);
    }
    let path = Path::new(candidate);
    if !path.is_absolute() {
        return Err(DestinationError::NotAbsolute);
    }
    // Reject any literal ".." component in the original candidate outright, before any
    // existence-based resolution. This must happen first: Windows normalizes ".." textually at
    // the OS-call level (even through non-existent intermediate components), which would
    // otherwise let an existence-based ancestor walk silently step past ".." segments before
    // this function ever sees them in a "remainder" to check.
    if path
        .components()
        .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err(DestinationError::UnsafeComponent);
    }

    // Find the nearest existing ancestor and canonicalize it to resolve symlinks/junctions
    // before deciding the path is safe — a destination reached only through a symlink that
    // escapes somewhere unexpected must be rejected the same way project-content paths are
    // (SYNC-INV-005), even though this destination lives outside any single project root.
    let mut existing_ancestor = path;
    while !existing_ancestor.exists() {
        match existing_ancestor.parent() {
            Some(parent) => existing_ancestor = parent,
            None => return Err(DestinationError::ParentMissing),
        }
    }
    let canonical_ancestor =
        fs::canonicalize(existing_ancestor).map_err(|_| DestinationError::UnsafeComponent)?;
    let remainder = path
        .strip_prefix(existing_ancestor)
        .map_err(|_| DestinationError::UnsafeComponent)?;
    let resolved = canonical_ancestor.join(remainder);
    // Strip Windows' `\\?\` verbatim prefix (an artifact of `fs::canonicalize`) so the stored
    // and displayed destination stays a normal, comparable path. Collision detection below must
    // run on this normalized form — comparing a fresh candidate's raw string against an
    // already-canonicalized stored value would falsely allow a collision through.
    let normalized = strip_verbatim_prefix(&resolved);
    if other_destinations.iter().any(|existing| Path::new(existing) == normalized) {
        return Err(DestinationError::AlreadyAssigned);
    }

    if resolved.exists() {
        let metadata = fs::symlink_metadata(&resolved).map_err(|_| DestinationError::UnsafeComponent)?;
        if metadata.is_symlink() {
            return Err(DestinationError::UnsafeComponent);
        }
        if resolved.is_file() {
            return Err(DestinationError::ExistsAsFile);
        }
        let has_entries = fs::read_dir(&resolved)
            .map_err(|_| DestinationError::UnsafeComponent)?
            .next()
            .is_some();
        if has_entries {
            return Err(DestinationError::ExistsAndNonEmpty);
        }
    }

    if let Some(free_bytes) = available_space_bytes(&canonical_ancestor) {
        if free_bytes < MIN_FREE_BYTES {
            return Err(DestinationError::InsufficientFreeSpace);
        }
    }

    Ok(normalized)
}

#[cfg(windows)]
fn strip_verbatim_prefix(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    match text.strip_prefix(r"\\?\") {
        Some(stripped) => PathBuf::from(stripped),
        None => path.to_path_buf(),
    }
}

#[cfg(not(windows))]
fn strip_verbatim_prefix(path: &Path) -> PathBuf {
    path.to_path_buf()
}

pub(crate) fn available_space_bytes(path: &Path) -> Option<u64> {
    let disks = sysinfo::Disks::new_with_refreshed_list();
    disks
        .list()
        .iter()
        .filter(|disk| path.starts_with(disk.mount_point()))
        .max_by_key(|disk| disk.mount_point().as_os_str().len())
        .map(|disk| disk.available_space())
}

/// Records the recipient's chosen destination after validating it. Only legal from `Offered` or
/// `Configuring`. Performs no filesystem write — validation only.
pub fn configure_destination_at(
    data_root: &Path,
    subscription_id: &str,
    destination: &str,
    now_ms: u64,
) -> Result<SubscriptionRecord, String> {
    let mut document = load_at(data_root)?;
    let other_destinations: Vec<String> = document
        .subscriptions
        .iter()
        .filter(|s| s.subscription_id != subscription_id)
        .filter_map(|s| s.destination.clone())
        .collect();
    let resolved = validate_destination(destination, &other_destinations)
        .map_err(|error| error.to_string())?;

    let record = find_mut(&mut document, subscription_id)?;
    if !matches!(record.state, SubscriptionState::Offered | SubscriptionState::Configuring) {
        return Err("subscription_not_configurable".to_string());
    }
    record.destination = Some(resolved.to_string_lossy().into_owned());
    record.state = SubscriptionState::Configuring;
    record.updated_at_ms = now_ms;
    advance_to_awaiting_confirmation(record);
    let updated = record.clone();
    save_at(data_root, &document)?;
    Ok(updated)
}

/// Records the recipient's chosen synchronization mode. Only legal from `Offered` or
/// `Configuring`.
pub fn select_mode_at(
    data_root: &Path,
    subscription_id: &str,
    mode: SubscriptionMode,
    now_ms: u64,
) -> Result<SubscriptionRecord, String> {
    let mut document = load_at(data_root)?;
    let record = find_mut(&mut document, subscription_id)?;
    if !matches!(record.state, SubscriptionState::Offered | SubscriptionState::Configuring) {
        return Err("subscription_not_configurable".to_string());
    }
    record.mode = Some(mode);
    record.state = SubscriptionState::Configuring;
    record.updated_at_ms = now_ms;
    advance_to_awaiting_confirmation(record);
    let updated = record.clone();
    save_at(data_root, &document)?;
    Ok(updated)
}

fn advance_to_awaiting_confirmation(record: &mut SubscriptionRecord) {
    if record.state == SubscriptionState::Configuring
        && record.destination.is_some()
        && record.mode.is_some()
    {
        record.state = SubscriptionState::AwaitingConfirmation;
    }
}

/// The one filesystem write Phase 5 performs: creates an empty destination directory shell
/// after explicit final confirmation. Never writes any project content — that is Phase 6.
pub fn confirm_subscription_at(
    data_root: &Path,
    subscription_id: &str,
    now_ms: u64,
) -> Result<SubscriptionRecord, String> {
    let mut document = load_at(data_root)?;
    let record = find_mut(&mut document, subscription_id)?;
    if record.state != SubscriptionState::AwaitingConfirmation {
        return Err("subscription_not_awaiting_confirmation".to_string());
    }
    let destination = record
        .destination
        .clone()
        .ok_or_else(|| "subscription_destination_missing".to_string())?;
    fs::create_dir_all(&destination).map_err(|_| "subscription_destination_create_failed".to_string())?;
    record.state = SubscriptionState::Staging;
    record.updated_at_ms = now_ms;
    let updated = record.clone();
    save_at(data_root, &document)?;
    Ok(updated)
}

fn transition_at(
    data_root: &Path,
    subscription_id: &str,
    allowed_from: &[SubscriptionState],
    to: SubscriptionState,
    now_ms: u64,
) -> Result<SubscriptionRecord, String> {
    let mut document = load_at(data_root)?;
    let record = find_mut(&mut document, subscription_id)?;
    if !allowed_from.contains(&record.state) {
        return Err("subscription_invalid_transition".to_string());
    }
    record.state = to;
    record.updated_at_ms = now_ms;
    if to != SubscriptionState::Error {
        record.error_code = None;
    }
    let updated = record.clone();
    save_at(data_root, &document)?;
    Ok(updated)
}

/// The recipient explicitly defers a decision without declining it — the grant remains offered
/// and can be reconfigured later.
pub fn defer_subscription_at(data_root: &Path, subscription_id: &str, now_ms: u64) -> Result<SubscriptionRecord, String> {
    transition_at(
        data_root,
        subscription_id,
        &[SubscriptionState::Offered, SubscriptionState::Configuring, SubscriptionState::AwaitingConfirmation],
        SubscriptionState::Deferred,
        now_ms,
    )
}

pub fn decline_subscription_at(data_root: &Path, subscription_id: &str, now_ms: u64) -> Result<SubscriptionRecord, String> {
    transition_at(
        data_root,
        subscription_id,
        &[
            SubscriptionState::Offered,
            SubscriptionState::Configuring,
            SubscriptionState::AwaitingConfirmation,
            SubscriptionState::Deferred,
        ],
        SubscriptionState::Declined,
        now_ms,
    )
}

/// Resumes a deferred subscription back into configuration.
pub fn reopen_subscription_at(data_root: &Path, subscription_id: &str, now_ms: u64) -> Result<SubscriptionRecord, String> {
    transition_at(
        data_root,
        subscription_id,
        &[SubscriptionState::Deferred],
        SubscriptionState::Configuring,
        now_ms,
    )
}

/// Extension points for Phase 6 (manifest/staging) and Phase 7 (continuous sync) to drive the
/// remaining state machine — defined and tested now so the full state list in the blueprint is
/// covered, even though nothing in the product calls these yet.
pub fn mark_verifying_at(data_root: &Path, subscription_id: &str, now_ms: u64) -> Result<SubscriptionRecord, String> {
    transition_at(data_root, subscription_id, &[SubscriptionState::Staging], SubscriptionState::Verifying, now_ms)
}

pub fn mark_active_at(data_root: &Path, subscription_id: &str, now_ms: u64) -> Result<SubscriptionRecord, String> {
    transition_at(data_root, subscription_id, &[SubscriptionState::Verifying], SubscriptionState::Active, now_ms)
}

pub fn pause_subscription_at(data_root: &Path, subscription_id: &str, now_ms: u64) -> Result<SubscriptionRecord, String> {
    transition_at(data_root, subscription_id, &[SubscriptionState::Active], SubscriptionState::Paused, now_ms)
}

pub fn resume_subscription_at(data_root: &Path, subscription_id: &str, now_ms: u64) -> Result<SubscriptionRecord, String> {
    transition_at(data_root, subscription_id, &[SubscriptionState::Paused], SubscriptionState::Active, now_ms)
}

/// Reacts to the owning grant being revoked elsewhere (`sync_security::revoke_grant_at`). Any
/// state except `Removing` can be revoked — an in-progress or already-active subscription must
/// stop being treated as authorized the moment its grant is gone.
pub fn revoke_subscription_at(data_root: &Path, subscription_id: &str, now_ms: u64) -> Result<SubscriptionRecord, String> {
    let mut document = load_at(data_root)?;
    let record = find_mut(&mut document, subscription_id)?;
    if record.state == SubscriptionState::Removing {
        return Err("subscription_invalid_transition".to_string());
    }
    record.state = SubscriptionState::Revoked;
    record.updated_at_ms = now_ms;
    let updated = record.clone();
    save_at(data_root, &document)?;
    Ok(updated)
}

pub fn mark_error_at(data_root: &Path, subscription_id: &str, error_code: &str, now_ms: u64) -> Result<SubscriptionRecord, String> {
    let mut document = load_at(data_root)?;
    let record = find_mut(&mut document, subscription_id)?;
    record.state = SubscriptionState::Error;
    record.error_code = Some(error_code.to_string());
    record.updated_at_ms = now_ms;
    let updated = record.clone();
    save_at(data_root, &document)?;
    Ok(updated)
}

/// Permanently removes a subscription record. Only legal for a subscription that is no longer
/// live (`Declined`, `Deferred`, `Revoked`, or `Error`), mirroring the device/invitation removal
/// pattern in `sync_security.rs`.
pub fn remove_subscription_at(data_root: &Path, subscription_id: &str) -> Result<(), String> {
    let mut document = load_at(data_root)?;
    let record = document
        .subscriptions
        .iter()
        .find(|s| s.subscription_id == subscription_id)
        .ok_or_else(|| "subscription_unavailable".to_string())?;
    if !matches!(
        record.state,
        SubscriptionState::Declined | SubscriptionState::Deferred | SubscriptionState::Revoked | SubscriptionState::Error
    ) {
        return Err("subscription_not_removable".to_string());
    }
    document.subscriptions.retain(|s| s.subscription_id != subscription_id);
    save_at(data_root, &document)
}

#[tauri::command]
pub fn sync_list_subscriptions(app: tauri::AppHandle) -> Result<Vec<SubscriptionRecord>, String> {
    let data_root = crate::profiles::resolve_tauri_data_root(&app)?;
    list_subscriptions_at(&data_root)
}

#[tauri::command]
pub fn sync_offer_subscription(
    app: tauri::AppHandle,
    project_id: String,
    grant_id: String,
    device_id: String,
) -> Result<SubscriptionRecord, String> {
    let data_root = crate::profiles::resolve_tauri_data_root(&app)?;
    offer_subscription_at(&data_root, &project_id, &grant_id, &device_id, crate::provider_common::now_ms())
}

#[tauri::command]
pub fn sync_configure_subscription_destination(
    app: tauri::AppHandle,
    subscription_id: String,
    destination: String,
) -> Result<SubscriptionRecord, String> {
    let data_root = crate::profiles::resolve_tauri_data_root(&app)?;
    configure_destination_at(&data_root, &subscription_id, &destination, crate::provider_common::now_ms())
}

#[tauri::command]
pub fn sync_select_subscription_mode(
    app: tauri::AppHandle,
    subscription_id: String,
    mode: SubscriptionMode,
) -> Result<SubscriptionRecord, String> {
    let data_root = crate::profiles::resolve_tauri_data_root(&app)?;
    select_mode_at(&data_root, &subscription_id, mode, crate::provider_common::now_ms())
}

#[tauri::command]
pub fn sync_confirm_subscription(app: tauri::AppHandle, subscription_id: String) -> Result<SubscriptionRecord, String> {
    let data_root = crate::profiles::resolve_tauri_data_root(&app)?;
    confirm_subscription_at(&data_root, &subscription_id, crate::provider_common::now_ms())
}

#[tauri::command]
pub fn sync_defer_subscription(app: tauri::AppHandle, subscription_id: String) -> Result<SubscriptionRecord, String> {
    let data_root = crate::profiles::resolve_tauri_data_root(&app)?;
    defer_subscription_at(&data_root, &subscription_id, crate::provider_common::now_ms())
}

#[tauri::command]
pub fn sync_decline_subscription(app: tauri::AppHandle, subscription_id: String) -> Result<SubscriptionRecord, String> {
    let data_root = crate::profiles::resolve_tauri_data_root(&app)?;
    decline_subscription_at(&data_root, &subscription_id, crate::provider_common::now_ms())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root() -> PathBuf {
        let root = std::env::temp_dir().join(format!("alethe-sync-subscription-{}", nanoid::nanoid!()));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn offering_creates_no_filesystem_write_beyond_the_record() {
        let root = temp_root();
        let record = offer_subscription_at(&root, "project-a", "grant-a", "dev-recipient", 1_000).unwrap();
        assert_eq!(record.state, SubscriptionState::Offered);
        assert!(record.destination.is_none());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn duplicate_offer_for_the_same_grant_is_rejected() {
        let root = temp_root();
        offer_subscription_at(&root, "project-a", "grant-a", "dev-recipient", 1_000).unwrap();
        assert_eq!(
            offer_subscription_at(&root, "project-a", "grant-a", "dev-recipient", 2_000),
            Err("subscription_already_exists_for_grant".to_string())
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn destination_and_mode_together_move_to_awaiting_confirmation() {
        let root = temp_root();
        let record = offer_subscription_at(&root, "project-a", "grant-a", "dev-recipient", 1_000).unwrap();
        let destination = root.join("dest-1");

        let after_destination = configure_destination_at(
            &root,
            &record.subscription_id,
            destination.to_str().unwrap(),
            2_000,
        )
        .unwrap();
        assert_eq!(after_destination.state, SubscriptionState::Configuring);
        assert!(!destination.exists(), "configuring must not create the directory");

        let after_mode = select_mode_at(
            &root,
            &record.subscription_id,
            SubscriptionMode::ManualSnapshot,
            3_000,
        )
        .unwrap();
        assert_eq!(after_mode.state, SubscriptionState::AwaitingConfirmation);
        assert!(!destination.exists(), "selecting a mode must not create the directory");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn confirmation_is_the_only_step_that_creates_the_destination_directory() {
        let root = temp_root();
        let record = offer_subscription_at(&root, "project-a", "grant-a", "dev-recipient", 1_000).unwrap();
        let destination = root.join("dest-2");
        configure_destination_at(&root, &record.subscription_id, destination.to_str().unwrap(), 2_000).unwrap();
        select_mode_at(&root, &record.subscription_id, SubscriptionMode::ManualSnapshot, 3_000).unwrap();
        assert!(!destination.exists());

        let confirmed = confirm_subscription_at(&root, &record.subscription_id, 4_000).unwrap();
        assert_eq!(confirmed.state, SubscriptionState::Staging);
        assert!(destination.is_dir());
        // Confirming twice is not a valid transition — it is no longer AwaitingConfirmation.
        assert_eq!(
            confirm_subscription_at(&root, &record.subscription_id, 5_000),
            Err("subscription_not_awaiting_confirmation".to_string())
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn viewing_deferring_and_declining_never_touch_the_filesystem() {
        let root = temp_root();
        let record = offer_subscription_at(&root, "project-a", "grant-a", "dev-recipient", 1_000).unwrap();
        let destination = root.join("dest-3");
        configure_destination_at(&root, &record.subscription_id, destination.to_str().unwrap(), 2_000).unwrap();

        let deferred = defer_subscription_at(&root, &record.subscription_id, 3_000).unwrap();
        assert_eq!(deferred.state, SubscriptionState::Deferred);
        assert!(!destination.exists());

        let reopened = reopen_subscription_at(&root, &record.subscription_id, 4_000).unwrap();
        assert_eq!(reopened.state, SubscriptionState::Configuring);

        let declined = decline_subscription_at(&root, &record.subscription_id, 5_000).unwrap();
        assert_eq!(declined.state, SubscriptionState::Declined);
        assert!(!destination.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn destination_rejects_traversal_symlink_and_collision() {
        let root = temp_root();
        let record_a = offer_subscription_at(&root, "project-a", "grant-a", "dev-recipient", 1_000).unwrap();
        let record_b = offer_subscription_at(&root, "project-b", "grant-b", "dev-recipient", 1_100).unwrap();

        let good_destination = root.join("safe-dest");
        configure_destination_at(&root, &record_a.subscription_id, good_destination.to_str().unwrap(), 2_000).unwrap();

        // Collision: record_b cannot claim the same destination.
        assert_eq!(
            configure_destination_at(&root, &record_b.subscription_id, good_destination.to_str().unwrap(), 2_100),
            Err("destination_already_assigned".to_string())
        );

        // Relative path is rejected outright.
        assert_eq!(
            configure_destination_at(&root, &record_b.subscription_id, "relative/path", 2_200),
            Err("destination_not_absolute".to_string())
        );

        // A traversal component past an existing ancestor is rejected.
        let traversal = root.join("escape").join("..").join("..").join("outside");
        assert_eq!(
            configure_destination_at(&root, &record_b.subscription_id, traversal.to_str().unwrap(), 2_300)
                .unwrap_err(),
            "destination_unsafe_component".to_string()
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn destination_rejects_an_existing_non_empty_directory() {
        let root = temp_root();
        let record = offer_subscription_at(&root, "project-a", "grant-a", "dev-recipient", 1_000).unwrap();
        let occupied = root.join("occupied");
        fs::create_dir_all(&occupied).unwrap();
        fs::write(occupied.join("existing-file.txt"), b"data").unwrap();

        assert_eq!(
            configure_destination_at(&root, &record.subscription_id, occupied.to_str().unwrap(), 2_000),
            Err("destination_exists_and_non_empty".to_string())
        );
        // The unrelated existing content must never be touched by a rejected configuration.
        assert!(occupied.join("existing-file.txt").is_file());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn full_state_machine_progression_is_available_for_later_phases_to_drive() {
        let root = temp_root();
        let record = offer_subscription_at(&root, "project-a", "grant-a", "dev-recipient", 1_000).unwrap();
        let destination = root.join("dest-progress");
        configure_destination_at(&root, &record.subscription_id, destination.to_str().unwrap(), 2_000).unwrap();
        select_mode_at(&root, &record.subscription_id, SubscriptionMode::Bidirectional, 3_000).unwrap();
        confirm_subscription_at(&root, &record.subscription_id, 4_000).unwrap();

        let verifying = mark_verifying_at(&root, &record.subscription_id, 5_000).unwrap();
        assert_eq!(verifying.state, SubscriptionState::Verifying);
        let active = mark_active_at(&root, &record.subscription_id, 6_000).unwrap();
        assert_eq!(active.state, SubscriptionState::Active);
        let paused = pause_subscription_at(&root, &record.subscription_id, 7_000).unwrap();
        assert_eq!(paused.state, SubscriptionState::Paused);
        let resumed = resume_subscription_at(&root, &record.subscription_id, 8_000).unwrap();
        assert_eq!(resumed.state, SubscriptionState::Active);

        // Skipping a step (e.g. Staging -> Active without Verifying) must fail.
        let record2 = offer_subscription_at(&root, "project-c", "grant-c", "dev-recipient", 9_000).unwrap();
        let destination2 = root.join("dest-progress-2");
        configure_destination_at(&root, &record2.subscription_id, destination2.to_str().unwrap(), 9_100).unwrap();
        select_mode_at(&root, &record2.subscription_id, SubscriptionMode::ManualSnapshot, 9_200).unwrap();
        confirm_subscription_at(&root, &record2.subscription_id, 9_300).unwrap();
        assert_eq!(
            mark_active_at(&root, &record2.subscription_id, 9_400),
            Err("subscription_invalid_transition".to_string())
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn revocation_ends_any_live_subscription_state() {
        let root = temp_root();
        let record = offer_subscription_at(&root, "project-a", "grant-a", "dev-recipient", 1_000).unwrap();
        let revoked = revoke_subscription_at(&root, &record.subscription_id, 2_000).unwrap();
        assert_eq!(revoked.state, SubscriptionState::Revoked);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn removal_is_restricted_to_terminal_states() {
        let root = temp_root();
        let record = offer_subscription_at(&root, "project-a", "grant-a", "dev-recipient", 1_000).unwrap();
        assert_eq!(
            remove_subscription_at(&root, &record.subscription_id),
            Err("subscription_not_removable".to_string())
        );
        decline_subscription_at(&root, &record.subscription_id, 2_000).unwrap();
        remove_subscription_at(&root, &record.subscription_id).unwrap();
        assert!(list_subscriptions_at(&root).unwrap().is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn state_survives_a_reload_from_disk() {
        let root = temp_root();
        let record = offer_subscription_at(&root, "project-a", "grant-a", "dev-recipient", 1_000).unwrap();
        let destination = root.join("dest-restart");
        configure_destination_at(&root, &record.subscription_id, destination.to_str().unwrap(), 2_000).unwrap();

        let reloaded = list_subscriptions_at(&root).unwrap();
        assert_eq!(reloaded.len(), 1);
        assert_eq!(reloaded[0].state, SubscriptionState::Configuring);
        assert_eq!(reloaded[0].destination.as_deref(), destination.to_str());
        fs::remove_dir_all(root).unwrap();
    }
}
