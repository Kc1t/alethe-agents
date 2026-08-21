//! Persistent local access-center projection for collaboration events (Phase 11). Records contain
//! only stable event kinds and opaque subject handles; private content stays in its authorized
//! domain store and is resolved only after a fresh Core check.

use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

const SCHEMA_VERSION: u32 = 1;
const MAX_RECORDS: usize = 512;
const MAX_DEFER_MS: u64 = 30 * 24 * 60 * 60 * 1_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AccessCategory {
    Security,
    Collaboration,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AccessKind {
    RemoteInvitation,
    ConnectionCandidate,
    Revocation,
    ProviderAttention,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccessRecord {
    pub id: String,
    pub category: AccessCategory,
    pub kind: AccessKind,
    pub subject_handle: String,
    pub action_handle: String,
    pub unread: bool,
    pub dismissed_at_ms: Option<u64>,
    pub deferred_until_ms: Option<u64>,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
}

#[derive(Serialize, Deserialize)]
struct AccessDocument {
    schema_version: u32,
    records: Vec<AccessRecord>,
}

fn path(data_root: &Path) -> PathBuf {
    data_root.join("sync").join("access-center-v1.json")
}

fn load_at(data_root: &Path) -> Result<AccessDocument, String> {
    let path = path(data_root);
    if !path.exists() {
        return Ok(AccessDocument {
            schema_version: SCHEMA_VERSION,
            records: Vec::new(),
        });
    }
    let bytes = fs::read(path).map_err(|_| "access_center_read_failed".to_string())?;
    let document: AccessDocument =
        serde_json::from_slice(&bytes).map_err(|_| "access_center_document_invalid".to_string())?;
    if document.schema_version != SCHEMA_VERSION || document.records.len() > MAX_RECORDS {
        return Err("access_center_document_invalid".to_string());
    }
    Ok(document)
}

#[cfg(windows)]
fn replace(source: &Path, destination: &Path) -> Result<(), String> {
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
        Err("access_center_write_failed".to_string())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn replace(source: &Path, destination: &Path) -> Result<(), String> {
    fs::rename(source, destination).map_err(|_| "access_center_write_failed".to_string())
}

fn save_at(data_root: &Path, document: &AccessDocument) -> Result<(), String> {
    let destination = path(data_root);
    let parent = destination
        .parent()
        .ok_or_else(|| "access_center_write_failed".to_string())?;
    fs::create_dir_all(parent).map_err(|_| "access_center_write_failed".to_string())?;
    let temporary = parent.join(format!(".access-{}.tmp", nanoid::nanoid!(12)));
    let bytes = serde_json::to_vec_pretty(document)
        .map_err(|_| "access_center_write_failed".to_string())?;
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)
        .map_err(|_| "access_center_write_failed".to_string())?;
    if file
        .write_all(&bytes)
        .and_then(|_| file.sync_all())
        .is_err()
    {
        let _ = fs::remove_file(&temporary);
        return Err("access_center_write_failed".to_string());
    }
    replace(&temporary, &destination).map_err(|error| {
        let _ = fs::remove_file(&temporary);
        error
    })
}

fn valid_opaque(value: &str) -> bool {
    (8..=128).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

pub fn record_at(
    data_root: &Path,
    category: AccessCategory,
    kind: AccessKind,
    subject_handle: &str,
    now_ms: u64,
) -> Result<AccessRecord, String> {
    if !valid_opaque(subject_handle) {
        return Err("access_center_invalid_subject".to_string());
    }
    let mut document = load_at(data_root)?;
    if let Some(existing) = document.records.iter_mut().find(|record| {
        record.kind == kind
            && record.subject_handle == subject_handle
            && record.dismissed_at_ms.is_none()
    }) {
        existing.unread = true;
        existing.deferred_until_ms = None;
        existing.updated_at_ms = now_ms;
        let record = existing.clone();
        save_at(data_root, &document)?;
        return Ok(record);
    }
    let record = AccessRecord {
        id: format!("access_{}", nanoid::nanoid!(20)),
        category,
        kind,
        subject_handle: subject_handle.to_string(),
        action_handle: format!("action_{}", nanoid::nanoid!(28)),
        unread: true,
        dismissed_at_ms: None,
        deferred_until_ms: None,
        created_at_ms: now_ms,
        updated_at_ms: now_ms,
    };
    document.records.insert(0, record.clone());
    document.records.truncate(MAX_RECORDS);
    save_at(data_root, &document)?;
    Ok(record)
}

pub fn list_at(data_root: &Path, now_ms: u64) -> Result<Vec<AccessRecord>, String> {
    Ok(load_at(data_root)?
        .records
        .into_iter()
        .filter(|record| {
            record.dismissed_at_ms.is_none()
                && record
                    .deferred_until_ms
                    .is_none_or(|deferred| deferred <= now_ms)
        })
        .collect())
}

pub fn update_at(
    data_root: &Path,
    id: &str,
    operation: &str,
    defer_until_ms: Option<u64>,
    now_ms: u64,
) -> Result<AccessRecord, String> {
    let mut document = load_at(data_root)?;
    let record = document
        .records
        .iter_mut()
        .find(|record| record.id == id)
        .ok_or_else(|| "access_center_not_found".to_string())?;
    match operation {
        "read" => record.unread = false,
        "dismiss" => record.dismissed_at_ms = Some(now_ms),
        "defer" => {
            let until = defer_until_ms.ok_or_else(|| "access_center_invalid_defer".to_string())?;
            if until <= now_ms || until - now_ms > MAX_DEFER_MS {
                return Err("access_center_invalid_defer".to_string());
            }
            record.deferred_until_ms = Some(until);
        }
        _ => return Err("access_center_invalid_operation".to_string()),
    }
    record.updated_at_ms = now_ms;
    let result = record.clone();
    save_at(data_root, &document)?;
    Ok(result)
}

/// Resolves an opaque action handle only after checking the record is still current. The return
/// value is a navigation hint, never authorization to accept an invitation or mutate a project.
pub fn resolve_action_at(
    data_root: &Path,
    action_handle: &str,
    now_ms: u64,
) -> Result<AccessRecord, String> {
    let document = load_at(data_root)?;
    document
        .records
        .into_iter()
        .find(|record| {
            record.action_handle == action_handle
                && record.dismissed_at_ms.is_none()
                && record
                    .deferred_until_ms
                    .is_none_or(|deferred| deferred <= now_ms)
        })
        .ok_or_else(|| "access_center_action_stale".to_string())
}

#[tauri::command]
pub fn sync_access_list(app: tauri::AppHandle) -> Result<Vec<AccessRecord>, String> {
    let data_root = crate::profiles::resolve_tauri_data_root(&app)?;
    list_at(&data_root, crate::provider_common::now_ms())
}

#[tauri::command]
pub fn sync_access_update(
    app: tauri::AppHandle,
    id: String,
    operation: String,
    defer_until_ms: Option<u64>,
) -> Result<AccessRecord, String> {
    let data_root = crate::profiles::resolve_tauri_data_root(&app)?;
    update_at(
        &data_root,
        &id,
        &operation,
        defer_until_ms,
        crate::provider_common::now_ms(),
    )
}

#[tauri::command]
pub fn sync_access_resolve_action(
    app: tauri::AppHandle,
    action_handle: String,
) -> Result<AccessRecord, String> {
    let data_root = crate::profiles::resolve_tauri_data_root(&app)?;
    resolve_action_at(&data_root, &action_handle, crate::provider_common::now_ms())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_root(name: &str) -> PathBuf {
        let root =
            std::env::temp_dir().join(format!("alethe-access-{name}-{}", nanoid::nanoid!(8)));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn records_are_bounded_deduplicated_and_contain_no_private_content_fields() {
        let root = test_root("dedupe");
        let first = record_at(
            &root,
            AccessCategory::Collaboration,
            AccessKind::RemoteInvitation,
            "message_opaque_123",
            1_000,
        )
        .unwrap();
        let second = record_at(
            &root,
            AccessCategory::Collaboration,
            AccessKind::RemoteInvitation,
            "message_opaque_123",
            2_000,
        )
        .unwrap();
        assert_eq!(first.id, second.id);
        let serialized = serde_json::to_string(&second).unwrap();
        for forbidden in ["projectName", "filePath", "bearer", "oauth", "ciphertext"] {
            assert!(!serialized.contains(forbidden));
        }
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn dismissed_and_deferred_records_fail_action_revalidation() {
        let root = test_root("actions");
        let record = record_at(
            &root,
            AccessCategory::Security,
            AccessKind::Revocation,
            "revocation_opaque_123",
            1_000,
        )
        .unwrap();
        update_at(&root, &record.id, "dismiss", None, 2_000).unwrap();
        assert_eq!(
            resolve_action_at(&root, &record.action_handle, 2_001).unwrap_err(),
            "access_center_action_stale"
        );

        let deferred = record_at(
            &root,
            AccessCategory::Collaboration,
            AccessKind::ConnectionCandidate,
            "candidate_opaque_123",
            3_000,
        )
        .unwrap();
        update_at(&root, &deferred.id, "defer", Some(5_000), 3_100).unwrap();
        assert!(list_at(&root, 4_000).unwrap().is_empty());
        assert_eq!(list_at(&root, 5_000).unwrap().len(), 1);
        let _ = fs::remove_dir_all(root);
    }
}
