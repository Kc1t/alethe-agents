//! Continuous synchronization: revisioned operations, watcher-event coalescing, per-operation
//! reauthorization, and explicit conflict handling (Phase 7). Operates on the local per-
//! subscription state built by Phases 5–6; it never trusts a permission cached when an operation
//! was queued — every apply rechecks authorization against current state. No filesystem watcher
//! or peer transport is wired to this module yet: `coalesce_watch_events` and the apply functions
//! are pure/local-fixture-tested building blocks for that future integration.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::sync_manifest::normalize_and_validate_path;

const ENGINE_SCHEMA_VERSION: u32 = 1;
/// Bound on queued raw watcher events per coalescing pass. Exceeding this signals overflow —
/// the caller must fall back to a full rescan rather than trust a partial, possibly-incomplete
/// batch.
pub const MAX_QUEUED_EVENTS: usize = 2_048;
/// Bound on retained operation-log entries per subscription (oldest entries are dropped once
/// exceeded — this is a local audit trail, not project storage).
pub const MAX_OP_LOG_ENTRIES: usize = 10_000;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "type")]
pub enum OperationKind {
    Create,
    Update,
    Rename { from: String },
    Delete,
    MetadataChange,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignedOperation {
    pub sequence: u64,
    pub relative_path: String,
    pub kind: OperationKind,
    /// The path's revision this operation assumes as its parent. `None` means "path did not
    /// exist locally yet". A mismatch against the actual current revision is exactly what
    /// signals a conflict rather than a clean fast-forward.
    pub base_revision: Option<u64>,
    pub content_hash: Option<String>,
    pub author_device_id: String,
    pub applied_at_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PathRevisionState {
    relative_path: String,
    current_revision: u64,
    content_hash: Option<String>,
    deleted: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConflictResolution {
    KeepLocal,
    KeepRemote,
    KeepBoth,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictRecord {
    pub conflict_id: String,
    pub relative_path: String,
    pub local_operation: SignedOperation,
    pub remote_operation: SignedOperation,
    pub created_at_ms: u64,
    pub resolution: Option<ConflictResolution>,
    pub resolved_at_ms: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineState {
    schema_version: u32,
    pub subscription_id: String,
    path_revisions: Vec<PathRevisionState>,
    pub op_log: Vec<SignedOperation>,
    next_sequence: u64,
    pub paused: bool,
    pub needs_rescan: bool,
    pub conflicts: Vec<ConflictRecord>,
    pub updated_at_ms: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EngineError {
    InvalidPath,
    NotAuthorized,
    Paused,
    Conflict,
    NotFound,
    ConflictNotFound,
    ConflictAlreadyResolved,
    Io,
}

impl std::fmt::Display for EngineError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let code = match self {
            EngineError::InvalidPath => "engine_invalid_path",
            EngineError::NotAuthorized => "engine_not_authorized",
            EngineError::Paused => "engine_subscription_paused",
            EngineError::Conflict => "engine_conflict_recorded",
            EngineError::NotFound => "engine_state_not_found",
            EngineError::ConflictNotFound => "engine_conflict_not_found",
            EngineError::ConflictAlreadyResolved => "engine_conflict_already_resolved",
            EngineError::Io => "engine_io_error",
        };
        write!(f, "{code}")
    }
}

/// Rechecked immediately before every operation is applied — never before, and never cached.
/// Backed by `sync_security.rs` in production; a fixture in tests.
pub trait OperationAuthorizer {
    fn check(&self, device_id: &str, relative_path: &str) -> Result<(), EngineError>;
}

fn engine_state_path(data_root: &Path, subscription_id: &str) -> PathBuf {
    data_root.join("sync").join("engine").join(format!("{subscription_id}.json"))
}

fn load_at(data_root: &Path, subscription_id: &str) -> Result<EngineState, EngineError> {
    let path = engine_state_path(data_root, subscription_id);
    if !path.exists() {
        return Ok(EngineState {
            schema_version: ENGINE_SCHEMA_VERSION,
            subscription_id: subscription_id.to_string(),
            path_revisions: Vec::new(),
            op_log: Vec::new(),
            next_sequence: 1,
            paused: false,
            needs_rescan: false,
            conflicts: Vec::new(),
            updated_at_ms: 0,
        });
    }
    let bytes = fs::read(&path).map_err(|_| EngineError::Io)?;
    let state: EngineState = serde_json::from_slice(&bytes).map_err(|_| EngineError::Io)?;
    if state.schema_version != ENGINE_SCHEMA_VERSION {
        return Err(EngineError::Io);
    }
    Ok(state)
}

#[cfg(windows)]
fn replace_file(source: &Path, destination: &Path) -> Result<(), EngineError> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination.as_os_str().encode_wide().chain(Some(0)).collect();
    let result =
        unsafe { MoveFileExW(source.as_ptr(), destination.as_ptr(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) };
    if result == 0 {
        Err(EngineError::Io)
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn replace_file(source: &Path, destination: &Path) -> Result<(), EngineError> {
    fs::rename(source, destination).map_err(|_| EngineError::Io)
}

fn save_at(data_root: &Path, state: &EngineState) -> Result<(), EngineError> {
    let path = engine_state_path(data_root, &state.subscription_id);
    let parent = path.parent().ok_or(EngineError::Io)?;
    fs::create_dir_all(parent).map_err(|_| EngineError::Io)?;
    let temporary = parent.join(format!(".engine-{}.tmp", nanoid::nanoid!(12)));
    let bytes = serde_json::to_vec_pretty(state).map_err(|_| EngineError::Io)?;
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)
        .map_err(|_| EngineError::Io)?;
    if file.write_all(&bytes).and_then(|_| file.sync_all()).is_err() {
        let _ = fs::remove_file(&temporary);
        return Err(EngineError::Io);
    }
    replace_file(&temporary, &path).map_err(|error| {
        let _ = fs::remove_file(&temporary);
        error
    })
}

fn push_op_log(state: &mut EngineState, operation: SignedOperation) {
    state.op_log.push(operation);
    if state.op_log.len() > MAX_OP_LOG_ENTRIES {
        let overflow = state.op_log.len() - MAX_OP_LOG_ENTRIES;
        state.op_log.drain(0..overflow);
    }
}

fn current_revision<'a>(state: &'a EngineState, relative_path: &str) -> Option<&'a PathRevisionState> {
    state.path_revisions.iter().find(|entry| entry.relative_path == relative_path)
}

fn upsert_revision(
    state: &mut EngineState,
    relative_path: &str,
    revision: u64,
    content_hash: Option<String>,
    deleted: bool,
) {
    if let Some(entry) = state
        .path_revisions
        .iter_mut()
        .find(|entry| entry.relative_path == relative_path)
    {
        entry.current_revision = revision;
        entry.content_hash = content_hash;
        entry.deleted = deleted;
    } else {
        state.path_revisions.push(PathRevisionState {
            relative_path: relative_path.to_string(),
            current_revision: revision,
            content_hash,
            deleted,
        });
    }
}

pub fn load_engine_at(data_root: &Path, subscription_id: &str) -> Result<EngineState, EngineError> {
    load_at(data_root, subscription_id)
}

/// Applies a locally originated operation (this device made a change). Rechecks authorization
/// immediately before applying — a permission cached when the change was queued is never
/// sufficient. Fails closed while the subscription is paused.
pub fn apply_local_operation_at(
    data_root: &Path,
    subscription_id: &str,
    device_id: &str,
    relative_path: &str,
    kind: OperationKind,
    content_hash: Option<String>,
    authorizer: &dyn OperationAuthorizer,
    now_ms: u64,
) -> Result<SignedOperation, EngineError> {
    let normalized = normalize_and_validate_path(relative_path).map_err(|_| EngineError::InvalidPath)?;
    let mut state = load_at(data_root, subscription_id)?;
    if state.paused {
        return Err(EngineError::Paused);
    }
    authorizer.check(device_id, &normalized)?;

    let base_revision = current_revision(&state, &normalized).map(|entry| entry.current_revision);
    let sequence = state.next_sequence;
    state.next_sequence += 1;
    let operation = SignedOperation {
        sequence,
        relative_path: normalized.clone(),
        kind,
        base_revision,
        content_hash: content_hash.clone(),
        author_device_id: device_id.to_string(),
        applied_at_ms: now_ms,
    };
    let deleted = matches!(operation.kind, OperationKind::Delete);
    upsert_revision(&mut state, &normalized, sequence, content_hash, deleted);
    push_op_log(&mut state, operation.clone());
    state.updated_at_ms = now_ms;
    save_at(data_root, &state)?;
    Ok(operation)
}

/// Applies (or conflicts) an operation received from a remote peer. If the remote operation's
/// `base_revision` matches the path's current local revision, it fast-forwards cleanly. If it
/// does not — the local and remote histories diverged — this records an explicit `ConflictRecord`
/// with both operations preserved and applies neither, rather than silently overwriting (never
/// last-writer-wins).
pub fn apply_remote_operation_at(
    data_root: &Path,
    subscription_id: &str,
    remote_operation: SignedOperation,
    authorizer: &dyn OperationAuthorizer,
    now_ms: u64,
) -> Result<Result<SignedOperation, ConflictRecord>, EngineError> {
    let mut state = load_at(data_root, subscription_id)?;
    if state.paused {
        return Err(EngineError::Paused);
    }
    authorizer.check(&remote_operation.author_device_id, &remote_operation.relative_path)?;

    let local_entry = current_revision(&state, &remote_operation.relative_path).cloned();
    let local_revision = local_entry.as_ref().map(|entry| entry.current_revision);

    if remote_operation.base_revision == local_revision {
        let deleted = matches!(remote_operation.kind, OperationKind::Delete);
        upsert_revision(
            &mut state,
            &remote_operation.relative_path,
            remote_operation.sequence,
            remote_operation.content_hash.clone(),
            deleted,
        );
        push_op_log(&mut state, remote_operation.clone());
        state.updated_at_ms = now_ms;
        save_at(data_root, &state)?;
        return Ok(Ok(remote_operation));
    }

    // Diverged: find the local operation that produced the current local revision, so the
    // conflict record preserves both sides' actual inputs.
    let local_operation = state
        .op_log
        .iter()
        .rev()
        .find(|op| op.relative_path == remote_operation.relative_path && Some(op.sequence) == local_revision)
        .cloned()
        .unwrap_or(SignedOperation {
            sequence: local_revision.unwrap_or(0),
            relative_path: remote_operation.relative_path.clone(),
            kind: OperationKind::Create,
            base_revision: None,
            content_hash: local_entry.and_then(|entry| entry.content_hash),
            author_device_id: "unknown".to_string(),
            applied_at_ms: 0,
        });

    let conflict = ConflictRecord {
        conflict_id: format!("conflict_{}", nanoid::nanoid!(24)),
        relative_path: remote_operation.relative_path.clone(),
        local_operation,
        remote_operation,
        created_at_ms: now_ms,
        resolution: None,
        resolved_at_ms: None,
    };
    state.conflicts.push(conflict.clone());
    state.updated_at_ms = now_ms;
    save_at(data_root, &state)?;
    Ok(Err(conflict))
}

/// Resolves a recorded conflict. `KeepLocal` discards the remote operation (no state change).
/// `KeepRemote` fast-forwards to the remote operation now, overwriting the local revision.
/// `KeepBoth` applies the remote content under a renamed sibling path, leaving the local file
/// untouched at its original path — both versions survive.
pub fn resolve_conflict_at(
    data_root: &Path,
    subscription_id: &str,
    conflict_id: &str,
    resolution: ConflictResolution,
    now_ms: u64,
) -> Result<EngineState, EngineError> {
    let mut state = load_at(data_root, subscription_id)?;
    let conflict_index = state
        .conflicts
        .iter()
        .position(|conflict| conflict.conflict_id == conflict_id)
        .ok_or(EngineError::ConflictNotFound)?;
    if state.conflicts[conflict_index].resolution.is_some() {
        return Err(EngineError::ConflictAlreadyResolved);
    }

    let remote_operation = state.conflicts[conflict_index].remote_operation.clone();
    match resolution {
        ConflictResolution::KeepLocal => {}
        ConflictResolution::KeepRemote => {
            let deleted = matches!(remote_operation.kind, OperationKind::Delete);
            upsert_revision(
                &mut state,
                &remote_operation.relative_path,
                remote_operation.sequence,
                remote_operation.content_hash.clone(),
                deleted,
            );
            push_op_log(&mut state, remote_operation);
        }
        ConflictResolution::KeepBoth => {
            let (stem, ext) = split_extension(&remote_operation.relative_path);
            let renamed_path = match &ext {
                Some(ext) => format!("{stem}.conflict-{now_ms}.{ext}"),
                None => format!("{stem}.conflict-{now_ms}"),
            };
            let mut side_operation = remote_operation.clone();
            side_operation.relative_path = renamed_path.clone();
            side_operation.base_revision = None;
            upsert_revision(
                &mut state,
                &renamed_path,
                remote_operation.sequence,
                remote_operation.content_hash.clone(),
                false,
            );
            push_op_log(&mut state, side_operation);
        }
    }

    state.conflicts[conflict_index].resolution = Some(resolution);
    state.conflicts[conflict_index].resolved_at_ms = Some(now_ms);
    state.updated_at_ms = now_ms;
    save_at(data_root, &state)?;
    Ok(state)
}

fn split_extension(relative_path: &str) -> (String, Option<String>) {
    match relative_path.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => (stem.to_string(), Some(ext.to_string())),
        _ => (relative_path.to_string(), None),
    }
}

pub fn pause_sync_at(data_root: &Path, subscription_id: &str, now_ms: u64) -> Result<EngineState, EngineError> {
    let mut state = load_at(data_root, subscription_id)?;
    state.paused = true;
    state.updated_at_ms = now_ms;
    save_at(data_root, &state)?;
    Ok(state)
}

pub fn resume_sync_at(data_root: &Path, subscription_id: &str, now_ms: u64) -> Result<EngineState, EngineError> {
    let mut state = load_at(data_root, subscription_id)?;
    state.paused = false;
    state.updated_at_ms = now_ms;
    save_at(data_root, &state)?;
    Ok(state)
}

pub fn mark_needs_rescan_at(data_root: &Path, subscription_id: &str, now_ms: u64) -> Result<EngineState, EngineError> {
    let mut state = load_at(data_root, subscription_id)?;
    state.needs_rescan = true;
    state.updated_at_ms = now_ms;
    save_at(data_root, &state)?;
    Ok(state)
}

pub fn clear_rescan_flag_at(data_root: &Path, subscription_id: &str, now_ms: u64) -> Result<EngineState, EngineError> {
    let mut state = load_at(data_root, subscription_id)?;
    state.needs_rescan = false;
    state.updated_at_ms = now_ms;
    save_at(data_root, &state)?;
    Ok(state)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RawWatchEvent {
    pub relative_path: String,
    pub sequence: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CoalescedBatch {
    /// Deduplicated set of paths that changed, in first-seen order. Empty and meaningless when
    /// `overflow` is `true` — the caller must trigger a full rescan instead of trusting this.
    pub changed_paths: Vec<String>,
    pub overflow: bool,
}

/// Coalesces a burst of raw filesystem events into a deduplicated, bounded batch of changed
/// paths. Pure and deterministic — no OS watcher dependency, so it can be tested directly.
/// Exceeding `MAX_QUEUED_EVENTS` reports overflow rather than silently truncating: a partial
/// batch could hide changes and desynchronize local/remote state, so the caller must do a full
/// deterministic rescan instead of trusting whatever fit in the queue.
pub fn coalesce_watch_events(events: &[RawWatchEvent]) -> CoalescedBatch {
    if events.len() > MAX_QUEUED_EVENTS {
        return CoalescedBatch {
            changed_paths: Vec::new(),
            overflow: true,
        };
    }
    let mut order: Vec<String> = Vec::new();
    let mut latest: HashMap<&str, u64> = HashMap::new();
    for event in events {
        if !latest.contains_key(event.relative_path.as_str()) {
            order.push(event.relative_path.clone());
        }
        latest.insert(&event.relative_path, event.sequence);
    }
    CoalescedBatch {
        changed_paths: order,
        overflow: false,
    }
}

/// Restores the destination to its single retained prior generation (the `.alethe-prev` backup
/// Phase 6's `publish_atomically_at` preserves), via the same atomic two-step rename swap. This
/// is a single-generation rollback — Phase 7 does not retain a deep per-operation history of
/// file bytes, only the operation log's metadata, so "rollback" here means "restore the last
/// published generation," not "replay to an arbitrary earlier revision."
pub fn restore_previous_backup_at(destination: &str) -> Result<(), EngineError> {
    let destination_path = Path::new(destination);
    let mut name = destination_path.file_name().map(|n| n.to_os_string()).unwrap_or_default();
    name.push(".alethe-prev");
    let backup_path = destination_path.with_file_name(name);
    if !backup_path.exists() {
        return Err(EngineError::NotFound);
    }
    let mut current_name = destination_path.file_name().map(|n| n.to_os_string()).unwrap_or_default();
    current_name.push(".alethe-rolled-back");
    let rolled_back_aside = destination_path.with_file_name(current_name);
    if destination_path.exists() {
        fs::rename(destination_path, &rolled_back_aside).map_err(|_| EngineError::Io)?;
    }
    fs::rename(&backup_path, destination_path).map_err(|_| EngineError::Io)?;
    if rolled_back_aside.exists() {
        fs::rename(&rolled_back_aside, &backup_path).map_err(|_| EngineError::Io)?;
    }
    Ok(())
}

/// Production `OperationAuthorizer`: a device is authorized only while it is `Trusted` for the
/// currently verified account, rechecked fresh from `sync_security`'s persisted state on every
/// call — never from a cached frontend value.
struct SecurityBackedAuthorizer<'a> {
    data_root: &'a Path,
}

impl OperationAuthorizer for SecurityBackedAuthorizer<'_> {
    fn check(&self, device_id: &str, _relative_path: &str) -> Result<(), EngineError> {
        let document = crate::sync_security::load_at(self.data_root).map_err(|_| EngineError::Io)?;
        let is_trusted = document
            .devices
            .iter()
            .any(|device| device.device_id == device_id && device.trust == crate::sync_security::DeviceTrust::Trusted);
        if is_trusted {
            Ok(())
        } else {
            Err(EngineError::NotAuthorized)
        }
    }
}

#[tauri::command]
pub fn sync_engine_pause(app: tauri::AppHandle, subscription_id: String) -> Result<EngineState, String> {
    let data_root = crate::profiles::resolve_tauri_data_root(&app)?;
    pause_sync_at(&data_root, &subscription_id, crate::provider_common::now_ms()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sync_engine_resume(app: tauri::AppHandle, subscription_id: String) -> Result<EngineState, String> {
    let data_root = crate::profiles::resolve_tauri_data_root(&app)?;
    resume_sync_at(&data_root, &subscription_id, crate::provider_common::now_ms()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sync_engine_mark_needs_rescan(app: tauri::AppHandle, subscription_id: String) -> Result<EngineState, String> {
    let data_root = crate::profiles::resolve_tauri_data_root(&app)?;
    mark_needs_rescan_at(&data_root, &subscription_id, crate::provider_common::now_ms()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sync_engine_load(app: tauri::AppHandle, subscription_id: String) -> Result<EngineState, String> {
    let data_root = crate::profiles::resolve_tauri_data_root(&app)?;
    load_engine_at(&data_root, &subscription_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sync_engine_resolve_conflict(
    app: tauri::AppHandle,
    subscription_id: String,
    conflict_id: String,
    resolution: ConflictResolution,
) -> Result<EngineState, String> {
    let data_root = crate::profiles::resolve_tauri_data_root(&app)?;
    resolve_conflict_at(&data_root, &subscription_id, &conflict_id, resolution, crate::provider_common::now_ms())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sync_engine_apply_local(
    app: tauri::AppHandle,
    subscription_id: String,
    device_id: String,
    relative_path: String,
    kind: OperationKind,
    content_hash: Option<String>,
) -> Result<SignedOperation, String> {
    let data_root = crate::profiles::resolve_tauri_data_root(&app)?;
    let authorizer = SecurityBackedAuthorizer { data_root: &data_root };
    apply_local_operation_at(
        &data_root,
        &subscription_id,
        &device_id,
        &relative_path,
        kind,
        content_hash,
        &authorizer,
        crate::provider_common::now_ms(),
    )
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct AllowAll;
    impl OperationAuthorizer for AllowAll {
        fn check(&self, _device_id: &str, _relative_path: &str) -> Result<(), EngineError> {
            Ok(())
        }
    }
    struct DenyAll;
    impl OperationAuthorizer for DenyAll {
        fn check(&self, _device_id: &str, _relative_path: &str) -> Result<(), EngineError> {
            Err(EngineError::NotAuthorized)
        }
    }

    fn temp_root(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("alethe-engine-{name}-{}", nanoid::nanoid!(8)));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn local_operations_advance_the_paths_revision_and_are_logged() {
        let root = temp_root("local-ops");
        let first = apply_local_operation_at(
            &root, "sub-1", "dev-a", "src/main.rs", OperationKind::Create,
            Some("hash-1".to_string()), &AllowAll, 1_000,
        )
        .unwrap();
        assert_eq!(first.base_revision, None);

        let second = apply_local_operation_at(
            &root, "sub-1", "dev-a", "src/main.rs", OperationKind::Update,
            Some("hash-2".to_string()), &AllowAll, 2_000,
        )
        .unwrap();
        assert_eq!(second.base_revision, Some(first.sequence));

        let state = load_engine_at(&root, "sub-1").unwrap();
        assert_eq!(state.op_log.len(), 2);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn revoked_authorization_blocks_the_operation_before_any_state_changes() {
        let root = temp_root("revoked");
        let result = apply_local_operation_at(
            &root, "sub-1", "dev-a", "src/main.rs", OperationKind::Create, None, &DenyAll, 1_000,
        );
        assert_eq!(result.unwrap_err(), EngineError::NotAuthorized);
        let state = load_engine_at(&root, "sub-1").unwrap();
        assert!(state.op_log.is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn paused_subscription_rejects_new_operations() {
        let root = temp_root("paused");
        pause_sync_at(&root, "sub-1", 1_000).unwrap();
        let result = apply_local_operation_at(
            &root, "sub-1", "dev-a", "a.txt", OperationKind::Create, None, &AllowAll, 2_000,
        );
        assert_eq!(result.unwrap_err(), EngineError::Paused);
        resume_sync_at(&root, "sub-1", 3_000).unwrap();
        apply_local_operation_at(&root, "sub-1", "dev-a", "a.txt", OperationKind::Create, None, &AllowAll, 4_000)
            .unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn matching_base_revision_fast_forwards_a_remote_operation() {
        let root = temp_root("fast-forward");
        let local = apply_local_operation_at(
            &root, "sub-1", "dev-a", "a.txt", OperationKind::Create, Some("h1".to_string()), &AllowAll, 1_000,
        )
        .unwrap();
        let remote = SignedOperation {
            sequence: 999,
            relative_path: "a.txt".to_string(),
            kind: OperationKind::Update,
            base_revision: Some(local.sequence),
            content_hash: Some("h2".to_string()),
            author_device_id: "dev-b".to_string(),
            applied_at_ms: 2_000,
        };
        let outcome = apply_remote_operation_at(&root, "sub-1", remote, &AllowAll, 3_000).unwrap();
        assert!(outcome.is_ok());
        let state = load_engine_at(&root, "sub-1").unwrap();
        assert!(state.conflicts.is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn diverged_base_revision_records_a_conflict_and_applies_neither_side() {
        let root = temp_root("diverge");
        let first = apply_local_operation_at(
            &root, "sub-1", "dev-a", "a.txt", OperationKind::Create, Some("h1".to_string()), &AllowAll, 1_000,
        )
        .unwrap();
        // Local moves on independently.
        apply_local_operation_at(
            &root, "sub-1", "dev-a", "a.txt", OperationKind::Update, Some("h2-local".to_string()), &AllowAll, 2_000,
        )
        .unwrap();

        // Remote operation still assumes the *first* revision as its parent — it diverged.
        let remote = SignedOperation {
            sequence: 999,
            relative_path: "a.txt".to_string(),
            kind: OperationKind::Update,
            base_revision: Some(first.sequence),
            content_hash: Some("h2-remote".to_string()),
            author_device_id: "dev-b".to_string(),
            applied_at_ms: 3_000,
        };
        let outcome = apply_remote_operation_at(&root, "sub-1", remote.clone(), &AllowAll, 4_000).unwrap();
        let conflict = outcome.unwrap_err();
        assert_eq!(conflict.relative_path, "a.txt");
        assert_eq!(conflict.remote_operation, remote);
        assert_eq!(conflict.local_operation.content_hash, Some("h2-local".to_string()));

        let state = load_engine_at(&root, "sub-1").unwrap();
        assert_eq!(state.conflicts.len(), 1);
        // Neither side's content_hash for this path silently changed to the remote's value.
        let current = current_revision(&state, "a.txt").unwrap();
        assert_eq!(current.content_hash, Some("h2-local".to_string()));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn resolve_keep_remote_overwrites_and_keep_both_preserves_a_renamed_sibling() {
        let root = temp_root("resolve");
        let first = apply_local_operation_at(
            &root, "sub-1", "dev-a", "notes.md", OperationKind::Create, Some("h1".to_string()), &AllowAll, 1_000,
        )
        .unwrap();
        apply_local_operation_at(
            &root, "sub-1", "dev-a", "notes.md", OperationKind::Update, Some("h2-local".to_string()), &AllowAll, 2_000,
        )
        .unwrap();
        let remote = SignedOperation {
            sequence: 999,
            relative_path: "notes.md".to_string(),
            kind: OperationKind::Update,
            base_revision: Some(first.sequence),
            content_hash: Some("h2-remote".to_string()),
            author_device_id: "dev-b".to_string(),
            applied_at_ms: 3_000,
        };
        let conflict = apply_remote_operation_at(&root, "sub-1", remote, &AllowAll, 4_000)
            .unwrap()
            .unwrap_err();

        let after_keep_remote = resolve_conflict_at(
            &root, "sub-1", &conflict.conflict_id, ConflictResolution::KeepRemote, 5_000,
        )
        .unwrap();
        let current = current_revision(&after_keep_remote, "notes.md").unwrap();
        assert_eq!(current.content_hash, Some("h2-remote".to_string()));
        assert_eq!(
            resolve_conflict_at(&root, "sub-1", &conflict.conflict_id, ConflictResolution::KeepLocal, 6_000)
                .unwrap_err(),
            EngineError::ConflictAlreadyResolved
        );
        fs::remove_dir_all(&root).unwrap();

        // Separate scenario for KeepBoth so the renamed sibling assertion is unambiguous.
        let root2 = temp_root("resolve-both");
        let first2 = apply_local_operation_at(
            &root2, "sub-1", "dev-a", "notes.md", OperationKind::Create, Some("h1".to_string()), &AllowAll, 1_000,
        )
        .unwrap();
        apply_local_operation_at(
            &root2, "sub-1", "dev-a", "notes.md", OperationKind::Update, Some("h2-local".to_string()), &AllowAll, 2_000,
        )
        .unwrap();
        let remote2 = SignedOperation {
            sequence: 999,
            relative_path: "notes.md".to_string(),
            kind: OperationKind::Update,
            base_revision: Some(first2.sequence),
            content_hash: Some("h2-remote".to_string()),
            author_device_id: "dev-b".to_string(),
            applied_at_ms: 3_000,
        };
        let conflict2 = apply_remote_operation_at(&root2, "sub-1", remote2, &AllowAll, 4_000)
            .unwrap()
            .unwrap_err();
        let after_keep_both = resolve_conflict_at(
            &root2, "sub-1", &conflict2.conflict_id, ConflictResolution::KeepBoth, 5_000,
        )
        .unwrap();
        assert!(current_revision(&after_keep_both, "notes.md").is_some());
        assert!(
            after_keep_both
                .path_revisions
                .iter()
                .any(|entry| entry.relative_path.starts_with("notes.conflict-") && entry.relative_path.ends_with(".md"))
        );
        fs::remove_dir_all(root2).unwrap();
    }

    #[test]
    fn coalescing_dedupes_paths_and_flags_overflow() {
        let events: Vec<RawWatchEvent> = vec![
            RawWatchEvent { relative_path: "a.txt".to_string(), sequence: 1 },
            RawWatchEvent { relative_path: "b.txt".to_string(), sequence: 2 },
            RawWatchEvent { relative_path: "a.txt".to_string(), sequence: 3 },
        ];
        let batch = coalesce_watch_events(&events);
        assert!(!batch.overflow);
        assert_eq!(batch.changed_paths, vec!["a.txt".to_string(), "b.txt".to_string()]);

        let overflowing: Vec<RawWatchEvent> = (0..(MAX_QUEUED_EVENTS + 1))
            .map(|i| RawWatchEvent { relative_path: format!("file-{i}.txt"), sequence: i as u64 })
            .collect();
        let overflow_batch = coalesce_watch_events(&overflowing);
        assert!(overflow_batch.overflow);
        assert!(overflow_batch.changed_paths.is_empty());
    }

    #[test]
    fn op_log_stays_bounded_under_a_long_history() {
        // Exercises `push_op_log` directly (pure, in-memory) rather than routing tens of
        // thousands of entries through the full load/save-to-disk path — the bounding logic
        // under test does not depend on persistence, and doing so keeps this test fast instead
        // of performing O(n^2) growing-document disk I/O for a multi-thousand-entry log.
        let mut state = EngineState {
            schema_version: ENGINE_SCHEMA_VERSION,
            subscription_id: "sub-1".to_string(),
            path_revisions: Vec::new(),
            op_log: Vec::new(),
            next_sequence: 1,
            paused: false,
            needs_rescan: false,
            conflicts: Vec::new(),
            updated_at_ms: 0,
        };
        for i in 0..(MAX_OP_LOG_ENTRIES + 50) {
            push_op_log(
                &mut state,
                SignedOperation {
                    sequence: i as u64,
                    relative_path: format!("file-{i}.txt"),
                    kind: OperationKind::Create,
                    base_revision: None,
                    content_hash: None,
                    author_device_id: "dev-a".to_string(),
                    applied_at_ms: 1_000 + i as u64,
                },
            );
        }
        assert_eq!(state.op_log.len(), MAX_OP_LOG_ENTRIES);
        // The oldest entries are the ones dropped, not the newest.
        assert_eq!(state.op_log.first().unwrap().sequence, 50);
        assert_eq!(state.op_log.last().unwrap().sequence, (MAX_OP_LOG_ENTRIES + 49) as u64);
    }

    #[test]
    fn restore_previous_backup_swaps_the_backup_back_into_place() {
        let root = temp_root("rollback");
        let destination = root.join("dest");
        let backup = root.join("dest.alethe-prev");
        fs::create_dir_all(&destination).unwrap();
        fs::write(destination.join("current.txt"), b"generation-2").unwrap();
        fs::create_dir_all(&backup).unwrap();
        fs::write(backup.join("previous.txt"), b"generation-1").unwrap();

        restore_previous_backup_at(destination.to_str().unwrap()).unwrap();

        assert!(destination.join("previous.txt").is_file());
        assert!(!destination.join("current.txt").exists());
        // The generation that was rolled back away from becomes the new recoverable backup.
        assert!(backup.join("current.txt").is_file());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn restore_previous_backup_fails_when_there_is_nothing_to_restore() {
        let root = temp_root("no-backup");
        let destination = root.join("dest");
        fs::create_dir_all(&destination).unwrap();
        assert_eq!(
            restore_previous_backup_at(destination.to_str().unwrap()),
            Err(EngineError::NotFound)
        );
        fs::remove_dir_all(root).unwrap();
    }
}
