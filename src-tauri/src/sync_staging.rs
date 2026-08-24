//! Staging journal and atomic publication (Phase 6, steps 6.4–6.5). Receives content-addressed
//! chunks into a staging area outside the live destination, verifies the complete tree against
//! its manifest, then publishes atomically by swapping directories — never mixing an old and a
//! new tree, and preserving one recoverable prior version. Nothing here initiates a network
//! transfer; a caller (a later integration with `sync_transport.rs`) drives `receive_chunk_at`.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::sync_manifest::{validate_manifest, EntryKind, ProjectManifest};

const STAGING_SCHEMA_VERSION: u32 = 1;
/// Extra margin reserved beyond the manifest's declared total size, so a transfer does not
/// consume every last byte of free space before verification/publication needs headroom.
const FREE_SPACE_MARGIN_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JournalState {
    Staging,
    Verified,
    Publishing,
    Published,
    Failed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PublishStep {
    None,
    MovedOldAside,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StagingJournal {
    pub schema_version: u32,
    pub subscription_id: String,
    pub manifest: ProjectManifest,
    pub destination: String,
    pub staging_root: String,
    pub received_chunk_ids: Vec<String>,
    pub state: JournalState,
    pub publish_step: PublishStep,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
    pub error_code: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StagingError {
    AlreadyStaging,
    NotFound,
    ManifestInvalid,
    InsufficientFreeSpace,
    WrongState,
    UnknownChunk,
    ChunkHashMismatch,
    ChunkTooLarge,
    MissingChunk,
    FileHashMismatch,
    Io,
}

impl std::fmt::Display for StagingError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let code = match self {
            StagingError::AlreadyStaging => "staging_already_in_progress",
            StagingError::NotFound => "staging_not_found",
            StagingError::ManifestInvalid => "staging_manifest_invalid",
            StagingError::InsufficientFreeSpace => "staging_insufficient_free_space",
            StagingError::WrongState => "staging_wrong_state",
            StagingError::UnknownChunk => "staging_chunk_unknown",
            StagingError::ChunkHashMismatch => "staging_chunk_hash_mismatch",
            StagingError::ChunkTooLarge => "staging_chunk_too_large",
            StagingError::MissingChunk => "staging_chunk_missing",
            StagingError::FileHashMismatch => "staging_file_hash_mismatch",
            StagingError::Io => "staging_io_error",
        };
        write!(f, "{code}")
    }
}

fn journal_path(data_root: &Path, subscription_id: &str) -> PathBuf {
    data_root.join("sync").join("staging").join(format!("{subscription_id}.json"))
}

fn staging_root_path(data_root: &Path, subscription_id: &str) -> PathBuf {
    data_root.join("sync").join("staging").join(format!("{subscription_id}-work"))
}

fn chunks_dir(staging_root: &Path) -> PathBuf {
    staging_root.join("chunks")
}

fn tree_dir(staging_root: &Path) -> PathBuf {
    staging_root.join("tree")
}

fn load_journal_at(data_root: &Path, subscription_id: &str) -> Result<StagingJournal, StagingError> {
    let path = journal_path(data_root, subscription_id);
    let bytes = fs::read(&path).map_err(|_| StagingError::NotFound)?;
    let journal: StagingJournal = serde_json::from_slice(&bytes).map_err(|_| StagingError::Io)?;
    if journal.schema_version != STAGING_SCHEMA_VERSION {
        return Err(StagingError::Io);
    }
    Ok(journal)
}

#[cfg(windows)]
fn replace_file(source: &Path, destination: &Path) -> Result<(), StagingError> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination.as_os_str().encode_wide().chain(Some(0)).collect();
    let result =
        unsafe { MoveFileExW(source.as_ptr(), destination.as_ptr(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) };
    if result == 0 {
        Err(StagingError::Io)
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn replace_file(source: &Path, destination: &Path) -> Result<(), StagingError> {
    fs::rename(source, destination).map_err(|_| StagingError::Io)
}

fn save_journal_at(data_root: &Path, journal: &StagingJournal) -> Result<(), StagingError> {
    let path = journal_path(data_root, &journal.subscription_id);
    let parent = path.parent().ok_or(StagingError::Io)?;
    fs::create_dir_all(parent).map_err(|_| StagingError::Io)?;
    let temporary = parent.join(format!(".staging-{}.tmp", nanoid::nanoid!(12)));
    let bytes = serde_json::to_vec_pretty(journal).map_err(|_| StagingError::Io)?;
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)
        .map_err(|_| StagingError::Io)?;
    if file.write_all(&bytes).and_then(|_| file.sync_all()).is_err() {
        let _ = fs::remove_file(&temporary);
        return Err(StagingError::Io);
    }
    replace_file(&temporary, &path).map_err(|error| {
        let _ = fs::remove_file(&temporary);
        error
    })
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Begins staging a verified manifest for one subscription. Reserves (checks, does not lock)
/// free space against the manifest's declared total size plus a margin, then creates an empty
/// staging work area outside the live destination. Fails if staging is already in progress for
/// this subscription — one active transfer per subscription at a time.
pub fn begin_staging_at(
    data_root: &Path,
    subscription_id: &str,
    manifest: ProjectManifest,
    destination: &str,
    now_ms: u64,
) -> Result<StagingJournal, StagingError> {
    if journal_path(data_root, subscription_id).exists() {
        return Err(StagingError::AlreadyStaging);
    }
    validate_manifest(&manifest).map_err(|_| StagingError::ManifestInvalid)?;

    let total_bytes: u64 = manifest.entries.iter().map(|entry| entry.size).sum();
    if let Some(free) = crate::sync_subscription::available_space_bytes(Path::new(destination)) {
        if free < total_bytes.saturating_add(FREE_SPACE_MARGIN_BYTES) {
            return Err(StagingError::InsufficientFreeSpace);
        }
    }

    let staging_root = staging_root_path(data_root, subscription_id);
    fs::create_dir_all(chunks_dir(&staging_root)).map_err(|_| StagingError::Io)?;
    fs::create_dir_all(tree_dir(&staging_root)).map_err(|_| StagingError::Io)?;

    let journal = StagingJournal {
        schema_version: STAGING_SCHEMA_VERSION,
        subscription_id: subscription_id.to_string(),
        manifest,
        destination: destination.to_string(),
        staging_root: staging_root.to_string_lossy().into_owned(),
        received_chunk_ids: Vec::new(),
        state: JournalState::Staging,
        publish_step: PublishStep::None,
        created_at_ms: now_ms,
        updated_at_ms: now_ms,
    error_code: None,
    };
    save_journal_at(data_root, &journal)?;
    Ok(journal)
}

pub fn load_staging_at(data_root: &Path, subscription_id: &str) -> Result<StagingJournal, StagingError> {
    load_journal_at(data_root, subscription_id)
}

/// Verifies and durably records one received chunk before returning success — a caller must
/// never acknowledge delivery to a sender until this returns `Ok`. Rejects chunks that are not
/// referenced by the manifest, do not hash to their claimed ID, or exceed the bounded chunk size
/// — corrupt, truncated, and substituted chunks all fail this check because their bytes cannot
/// produce the claimed content-addressed ID. Receiving an already-received chunk again is a safe
/// no-op (idempotent duplicate delivery).
pub fn receive_chunk_at(
    data_root: &Path,
    subscription_id: &str,
    chunk_id: &str,
    bytes: &[u8],
    now_ms: u64,
) -> Result<StagingJournal, StagingError> {
    let mut journal = load_journal_at(data_root, subscription_id)?;
    if journal.state != JournalState::Staging {
        return Err(StagingError::WrongState);
    }
    if bytes.len() > crate::sync_manifest::CHUNK_SIZE_BYTES {
        return Err(StagingError::ChunkTooLarge);
    }
    let declared_size = journal
        .manifest
        .entries
        .iter()
        .flat_map(|entry| entry.chunks.iter())
        .find(|chunk| chunk.chunk_id == chunk_id)
        .map(|chunk| chunk.size);
    let Some(declared_size) = declared_size else {
        return Err(StagingError::UnknownChunk);
    };
    if bytes.len() as u64 != declared_size {
        return Err(StagingError::ChunkHashMismatch);
    }
    let actual_hash = hex(&Sha256::digest(bytes));
    if actual_hash != chunk_id {
        return Err(StagingError::ChunkHashMismatch);
    }

    if journal.received_chunk_ids.iter().any(|id| id == chunk_id) {
        // Idempotent duplicate delivery: already verified and persisted, nothing further to do.
        return Ok(journal);
    }

    let staging_root = PathBuf::from(&journal.staging_root);
    let chunk_path = chunks_dir(&staging_root).join(format!("{chunk_id}.bin"));
    fs::write(&chunk_path, bytes).map_err(|_| StagingError::Io)?;

    journal.received_chunk_ids.push(chunk_id.to_string());
    journal.updated_at_ms = now_ms;
    save_journal_at(data_root, &journal)?;
    Ok(journal)
}

/// Verifies that every file's chunks were received and reassemble to the manifest's declared
/// hash, then materializes the verified tree under the staging work area (never touching the
/// live destination). Fails closed: any missing chunk or hash mismatch aborts before any file is
/// written to the tree, and moves the journal to `Failed` with a specific reason.
pub fn verify_staged_at(
    data_root: &Path,
    subscription_id: &str,
    now_ms: u64,
) -> Result<StagingJournal, StagingError> {
    let mut journal = load_journal_at(data_root, subscription_id)?;
    if journal.state != JournalState::Staging {
        return Err(StagingError::WrongState);
    }
    let staging_root = PathBuf::from(&journal.staging_root);
    let received: std::collections::HashSet<&str> =
        journal.received_chunk_ids.iter().map(String::as_str).collect();

    let result = (|| -> Result<(), StagingError> {
        for entry in &journal.manifest.entries {
            if entry.kind != EntryKind::File {
                continue;
            }
            let mut assembled = Vec::with_capacity(entry.size as usize);
            for chunk in &entry.chunks {
                if !received.contains(chunk.chunk_id.as_str()) {
                    return Err(StagingError::MissingChunk);
                }
                let chunk_path = chunks_dir(&staging_root).join(format!("{}.bin", chunk.chunk_id));
                let bytes = fs::read(&chunk_path).map_err(|_| StagingError::MissingChunk)?;
                assembled.extend_from_slice(&bytes);
            }
            let actual_hash = hex(&Sha256::digest(&assembled));
            if Some(actual_hash) != entry.content_hash {
                return Err(StagingError::FileHashMismatch);
            }
            let target = tree_dir(&staging_root).join(&entry.relative_path);
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(|_| StagingError::Io)?;
            }
            fs::write(&target, &assembled).map_err(|_| StagingError::Io)?;
        }
        for entry in &journal.manifest.entries {
            if entry.kind == EntryKind::Directory {
                let target = tree_dir(&staging_root).join(&entry.relative_path);
                fs::create_dir_all(&target).map_err(|_| StagingError::Io)?;
            }
        }
        Ok(())
    })();

    match result {
        Ok(()) => {
            journal.state = JournalState::Verified;
            journal.error_code = None;
        }
        Err(error) => {
            journal.state = JournalState::Failed;
            journal.error_code = Some(error.to_string());
            journal.updated_at_ms = now_ms;
            save_journal_at(data_root, &journal)?;
            // Best-effort: a missing or corrupt chunk here is terminal for this staged transfer
            // (nothing local can recover a chunk that never arrived intact) and needs the
            // recipient's attention to re-request the transfer. In-progress publish-step failures
            // (`do_publish_steps`) are deliberately not published here — those are resumable via
            // `recover_publication_at` on the next call, not a state requiring user action.
            let _ = crate::sync_access::record_at(
                data_root,
                crate::sync_access::AccessCategory::Collaboration,
                crate::sync_access::AccessKind::TransferFailure,
                subscription_id,
                now_ms,
            );
            return Err(error);
        }
    }
    journal.updated_at_ms = now_ms;
    save_journal_at(data_root, &journal)?;
    Ok(journal)
}

fn backup_path(destination: &Path) -> PathBuf {
    let mut name = destination.file_name().map(|n| n.to_os_string()).unwrap_or_default();
    name.push(".alethe-prev");
    destination.with_file_name(name)
}

/// Publishes the verified staging tree to the live destination via a two-step atomic rename
/// swap: the current destination (if any) moves aside to a recoverable backup, then the verified
/// tree moves into place. Each individual rename is an atomic OS operation; the journal makes
/// the two-step sequence crash-recoverable (see `recover_publication_at`) rather than claiming a
/// single-syscall atomic swap, which the underlying filesystem does not provide for a directory
/// with existing content.
pub fn publish_atomically_at(
    data_root: &Path,
    subscription_id: &str,
    now_ms: u64,
) -> Result<StagingJournal, StagingError> {
    let mut journal = load_journal_at(data_root, subscription_id)?;
    if journal.state != JournalState::Verified {
        return Err(StagingError::WrongState);
    }
    journal.state = JournalState::Publishing;
    save_journal_at(data_root, &journal)?;
    do_publish_steps(data_root, &mut journal, now_ms)?;
    Ok(journal)
}

fn do_publish_steps(
    data_root: &Path,
    journal: &mut StagingJournal,
    now_ms: u64,
) -> Result<(), StagingError> {
    let destination = PathBuf::from(&journal.destination);
    let backup = backup_path(&destination);
    let tree = tree_dir(&PathBuf::from(&journal.staging_root));

    if journal.publish_step == PublishStep::None {
        // Retention: keep exactly one recoverable prior version. Remove an older backup left
        // over from a previous successful publish before creating a new one.
        if backup.exists() {
            fs::remove_dir_all(&backup).map_err(|_| StagingError::Io)?;
        }
        if destination.exists() {
            fs::rename(&destination, &backup).map_err(|_| StagingError::Io)?;
        }
        journal.publish_step = PublishStep::MovedOldAside;
        journal.updated_at_ms = now_ms;
        save_journal_at(data_root, journal)?;
    }

    if journal.publish_step == PublishStep::MovedOldAside {
        if tree.exists() && !destination.exists() {
            fs::rename(&tree, &destination).map_err(|_| StagingError::Io)?;
        }
        journal.state = JournalState::Published;
        journal.publish_step = PublishStep::None;
        journal.updated_at_ms = now_ms;
        save_journal_at(data_root, journal)?;
    }

    Ok(())
}

/// Resumes an interrupted publication. Safe to call unconditionally (e.g. on startup for every
/// known subscription) — a no-op unless the journal is mid-`Publishing`. Ensures the destination
/// ends up as either the complete previous tree or the complete new tree, never a mix: the first
/// rename either fully happened or fully did not (an OS-atomic rename), and this function only
/// ever completes the second rename or discovers it already completed — it never partially
/// applies either.
pub fn recover_publication_at(data_root: &Path, subscription_id: &str, now_ms: u64) -> Result<StagingJournal, StagingError> {
    let mut journal = load_journal_at(data_root, subscription_id)?;
    if journal.state == JournalState::Publishing {
        do_publish_steps(data_root, &mut journal, now_ms)?;
    }
    Ok(journal)
}

/// Removes the staging work area (raw chunk cache and any leftover tree) after a terminal
/// outcome (`Published` or `Failed`). Never touches the live destination or its backup.
pub fn cleanup_staging_at(data_root: &Path, subscription_id: &str) -> Result<(), StagingError> {
    let journal = load_journal_at(data_root, subscription_id)?;
    if !matches!(journal.state, JournalState::Published | JournalState::Failed) {
        return Err(StagingError::WrongState);
    }
    let staging_root = PathBuf::from(&journal.staging_root);
    if staging_root.exists() {
        fs::remove_dir_all(&staging_root).map_err(|_| StagingError::Io)?;
    }
    fs::remove_file(journal_path(data_root, subscription_id)).map_err(|_| StagingError::Io)?;
    Ok(())
}

#[tauri::command]
pub fn sync_begin_staging(
    app: tauri::AppHandle,
    subscription_id: String,
    manifest: ProjectManifest,
    destination: String,
) -> Result<StagingJournal, String> {
    let data_root = crate::profiles::resolve_tauri_data_root(&app)?;
    begin_staging_at(&data_root, &subscription_id, manifest, &destination, crate::provider_common::now_ms())
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn sync_receive_chunk(
    app: tauri::AppHandle,
    subscription_id: String,
    chunk_id: String,
    bytes: Vec<u8>,
) -> Result<StagingJournal, String> {
    let data_root = crate::profiles::resolve_tauri_data_root(&app)?;
    receive_chunk_at(&data_root, &subscription_id, &chunk_id, &bytes, crate::provider_common::now_ms())
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn sync_verify_staged(app: tauri::AppHandle, subscription_id: String) -> Result<StagingJournal, String> {
    let data_root = crate::profiles::resolve_tauri_data_root(&app)?;
    verify_staged_at(&data_root, &subscription_id, crate::provider_common::now_ms()).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn sync_publish_staging(app: tauri::AppHandle, subscription_id: String) -> Result<StagingJournal, String> {
    let data_root = crate::profiles::resolve_tauri_data_root(&app)?;
    publish_atomically_at(&data_root, &subscription_id, crate::provider_common::now_ms())
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn sync_load_staging(app: tauri::AppHandle, subscription_id: String) -> Result<StagingJournal, String> {
    let data_root = crate::profiles::resolve_tauri_data_root(&app)?;
    load_staging_at(&data_root, &subscription_id).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync_manifest::build_manifest_from_dir;
    use ed25519_dalek::SigningKey;
    use rand_core::OsRng;

    fn temp_root(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("alethe-staging-{name}-{}", nanoid::nanoid!(8)));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    struct Fixture {
        data_root: PathBuf,
        destination: PathBuf,
        manifest: ProjectManifest,
        chunks: Vec<(String, Vec<u8>)>,
    }

    fn build_fixture(name: &str) -> Fixture {
        let data_root = temp_root(&format!("{name}-data"));
        let source = temp_root(&format!("{name}-src"));
        fs::create_dir_all(source.join("src")).unwrap();
        fs::write(source.join("src").join("main.rs"), b"fn main() { println!(\"hi\"); }").unwrap();
        fs::write(source.join("README.md"), b"hello project").unwrap();

        let destination = data_root.join("dest");
        fs::create_dir_all(&destination).unwrap(); // Phase 5 already creates it empty

        let signing_key = SigningKey::generate(&mut OsRng);
        let mut chunks = Vec::new();
        let manifest = build_manifest_from_dir(
            &source,
            "project-a",
            "rev-1",
            "dev-a",
            &signing_key,
            1_000,
            |id, bytes| {
                chunks.push((id.to_string(), bytes.to_vec()));
                Ok(())
            },
        )
        .unwrap();

        Fixture {
            data_root,
            destination,
            manifest,
            chunks,
        }
    }

    #[test]
    fn full_happy_path_publishes_the_exact_verified_tree() {
        let fixture = build_fixture("happy");
        let subscription_id = "sub-1";
        begin_staging_at(
            &fixture.data_root,
            subscription_id,
            fixture.manifest.clone(),
            fixture.destination.to_str().unwrap(),
            2_000,
        )
        .unwrap();

        for (id, bytes) in &fixture.chunks {
            receive_chunk_at(&fixture.data_root, subscription_id, id, bytes, 3_000).unwrap();
        }
        let verified = verify_staged_at(&fixture.data_root, subscription_id, 4_000).unwrap();
        assert_eq!(verified.state, JournalState::Verified);

        let published = publish_atomically_at(&fixture.data_root, subscription_id, 5_000).unwrap();
        assert_eq!(published.state, JournalState::Published);
        assert!(fixture.destination.join("src").join("main.rs").is_file());
        assert!(fixture.destination.join("README.md").is_file());
        assert_eq!(
            fs::read(fixture.destination.join("README.md")).unwrap(),
            b"hello project"
        );
        fs::remove_dir_all(&fixture.data_root).unwrap();
    }

    #[test]
    fn substituted_and_oversized_chunks_are_rejected_at_receive_time() {
        let fixture = build_fixture("substitute");
        let subscription_id = "sub-2";
        begin_staging_at(
            &fixture.data_root,
            subscription_id,
            fixture.manifest.clone(),
            fixture.destination.to_str().unwrap(),
            2_000,
        )
        .unwrap();

        let (real_id, _) = &fixture.chunks[0];
        assert_eq!(
            receive_chunk_at(&fixture.data_root, subscription_id, real_id, b"tampered-bytes", 3_000),
            Err(StagingError::ChunkHashMismatch)
        );

        let oversized = vec![0_u8; crate::sync_manifest::CHUNK_SIZE_BYTES + 1];
        assert_eq!(
            receive_chunk_at(&fixture.data_root, subscription_id, real_id, &oversized, 3_000),
            Err(StagingError::ChunkTooLarge)
        );

        assert_eq!(
            receive_chunk_at(&fixture.data_root, subscription_id, "not-a-real-chunk-id", b"x", 3_000),
            Err(StagingError::UnknownChunk)
        );
        fs::remove_dir_all(&fixture.data_root).unwrap();
    }

    #[test]
    fn duplicate_chunk_delivery_is_a_safe_no_op() {
        let fixture = build_fixture("duplicate");
        let subscription_id = "sub-3";
        begin_staging_at(
            &fixture.data_root,
            subscription_id,
            fixture.manifest.clone(),
            fixture.destination.to_str().unwrap(),
            2_000,
        )
        .unwrap();
        let (id, bytes) = &fixture.chunks[0];
        receive_chunk_at(&fixture.data_root, subscription_id, id, bytes, 3_000).unwrap();
        let after_second = receive_chunk_at(&fixture.data_root, subscription_id, id, bytes, 3_100).unwrap();
        assert_eq!(
            after_second.received_chunk_ids.iter().filter(|received| *received == id).count(),
            1
        );
        fs::remove_dir_all(&fixture.data_root).unwrap();
    }

    #[test]
    fn verification_fails_closed_on_missing_chunk_and_never_publishes() {
        let fixture = build_fixture("missing");
        let subscription_id = "sub-4";
        begin_staging_at(
            &fixture.data_root,
            subscription_id,
            fixture.manifest.clone(),
            fixture.destination.to_str().unwrap(),
            2_000,
        )
        .unwrap();
        // Deliberately skip one chunk.
        for (id, bytes) in fixture.chunks.iter().skip(1) {
            receive_chunk_at(&fixture.data_root, subscription_id, id, bytes, 3_000).unwrap();
        }
        let result = verify_staged_at(&fixture.data_root, subscription_id, 4_000);
        assert_eq!(result.unwrap_err(), StagingError::MissingChunk);

        assert_eq!(
            publish_atomically_at(&fixture.data_root, subscription_id, 5_000),
            Err(StagingError::WrongState)
        );
        assert_eq!(
            fs::read_dir(&fixture.destination).unwrap().count(),
            0,
            "destination must remain untouched after a failed verification"
        );
        fs::remove_dir_all(&fixture.data_root).unwrap();
    }

    #[test]
    fn verification_failure_publishes_an_access_center_record() {
        let fixture = build_fixture("missing-notify");
        let subscription_id = "sub_notify_test_0000000001";
        begin_staging_at(
            &fixture.data_root,
            subscription_id,
            fixture.manifest.clone(),
            fixture.destination.to_str().unwrap(),
            2_000,
        )
        .unwrap();
        for (id, bytes) in fixture.chunks.iter().skip(1) {
            receive_chunk_at(&fixture.data_root, subscription_id, id, bytes, 3_000).unwrap();
        }
        verify_staged_at(&fixture.data_root, subscription_id, 4_000).unwrap_err();

        let records = crate::sync_access::list_at(&fixture.data_root, 4_000).unwrap();
        let record = records
            .iter()
            .find(|record| record.kind == crate::sync_access::AccessKind::TransferFailure)
            .unwrap();
        assert_eq!(record.category, crate::sync_access::AccessCategory::Collaboration);
        assert_eq!(record.subject_handle, subscription_id);
        fs::remove_dir_all(&fixture.data_root).unwrap();
    }

    #[test]
    fn crash_between_publish_steps_recovers_to_the_new_verified_tree() {
        let fixture = build_fixture("crash");
        let subscription_id = "sub-5";
        begin_staging_at(
            &fixture.data_root,
            subscription_id,
            fixture.manifest.clone(),
            fixture.destination.to_str().unwrap(),
            2_000,
        )
        .unwrap();
        for (id, bytes) in &fixture.chunks {
            receive_chunk_at(&fixture.data_root, subscription_id, id, bytes, 3_000).unwrap();
        }
        verify_staged_at(&fixture.data_root, subscription_id, 4_000).unwrap();

        // Simulate a crash exactly between the two renames: manually drive step 1 only, persist
        // the journal as `Publishing`/`MovedOldAside`, and stop — exactly the state a real crash
        // would leave on disk.
        let mut journal = load_journal_at(&fixture.data_root, subscription_id).unwrap();
        journal.state = JournalState::Publishing;
        save_journal_at(&fixture.data_root, &journal).unwrap();
        let destination = PathBuf::from(&journal.destination);
        let backup = backup_path(&destination);
        fs::rename(&destination, &backup).unwrap();
        journal.publish_step = PublishStep::MovedOldAside;
        save_journal_at(&fixture.data_root, &journal).unwrap();
        // At this exact instant: destination is missing, backup holds the (empty) prior tree,
        // and the verified new tree still sits in staging — never a mixed tree.
        assert!(!destination.exists());
        assert!(backup.exists());

        let recovered = recover_publication_at(&fixture.data_root, subscription_id, 6_000).unwrap();
        assert_eq!(recovered.state, JournalState::Published);
        assert!(destination.join("README.md").is_file());
        assert!(backup.exists(), "the prior version must remain recoverable");
        fs::remove_dir_all(&fixture.data_root).unwrap();
    }

    #[test]
    fn republishing_keeps_exactly_one_recoverable_prior_version() {
        let fixture = build_fixture("retention");
        let subscription_id = "sub-6";
        begin_staging_at(
            &fixture.data_root,
            subscription_id,
            fixture.manifest.clone(),
            fixture.destination.to_str().unwrap(),
            2_000,
        )
        .unwrap();
        for (id, bytes) in &fixture.chunks {
            receive_chunk_at(&fixture.data_root, subscription_id, id, bytes, 3_000).unwrap();
        }
        verify_staged_at(&fixture.data_root, subscription_id, 4_000).unwrap();
        publish_atomically_at(&fixture.data_root, subscription_id, 5_000).unwrap();
        cleanup_staging_at(&fixture.data_root, subscription_id).unwrap();

        // Mark the destination's first-generation content so we can tell the two backups apart.
        fs::write(fixture.destination.join("generation.txt"), b"gen-1").unwrap();

        // Republish a second generation from the same source (new manifest revision, new
        // staging run, same subscription id).
        let signing_key = SigningKey::generate(&mut OsRng);
        let source2 = temp_root("retention-src2");
        fs::write(source2.join("README.md"), b"hello project v2").unwrap();
        let mut chunks2 = Vec::new();
        let manifest2 = build_manifest_from_dir(
            &source2,
            "project-a",
            "rev-2",
            "dev-a",
            &signing_key,
            10_000,
            |id, bytes| {
                chunks2.push((id.to_string(), bytes.to_vec()));
                Ok(())
            },
        )
        .unwrap();
        begin_staging_at(
            &fixture.data_root,
            subscription_id,
            manifest2,
            fixture.destination.to_str().unwrap(),
            11_000,
        )
        .unwrap();
        for (id, bytes) in &chunks2 {
            receive_chunk_at(&fixture.data_root, subscription_id, id, bytes, 12_000).unwrap();
        }
        verify_staged_at(&fixture.data_root, subscription_id, 13_000).unwrap();
        publish_atomically_at(&fixture.data_root, subscription_id, 14_000).unwrap();

        let backup = backup_path(&fixture.destination);
        assert!(backup.is_dir());
        assert!(
            backup.join("generation.txt").is_file(),
            "the immediately preceding version must be the recoverable backup"
        );
        assert_eq!(
            fs::read(fixture.destination.join("README.md")).unwrap(),
            b"hello project v2"
        );
        fs::remove_dir_all(&fixture.data_root).unwrap();
    }
}
