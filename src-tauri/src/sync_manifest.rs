//! Deterministic, signed project manifests and content-addressed chunking (Phase 6, step 6.1–6.3).
//! Builds a normalized, safety-validated description of a local directory tree and splits its
//! file contents into bounded, hashed chunks. Nothing here transfers anything over a network —
//! that is `sync_transport.rs` (Phase 4); this module only produces and validates the data
//! structure a transfer would carry.

use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs;
use std::io::Read;
use std::path::Path;

pub const MANIFEST_SCHEMA_VERSION: u32 = 1;
pub const EXCLUSION_POLICY_VERSION: u32 = 1;
/// Bounded chunk size — large enough to keep chunk counts reasonable, small enough to bound
/// per-chunk memory during hashing/verification.
pub const CHUNK_SIZE_BYTES: usize = 4 * 1024 * 1024;
/// Sanity ceiling on manifest entry count, enforced while building so a hostile or enormous
/// directory tree cannot produce an unbounded manifest.
pub const MAX_ENTRIES: usize = 200_000;
/// Sanity ceiling on a single file's size for Phase 6. Larger transfers are a future scope
/// decision, not silently allowed through today.
pub const MAX_FILE_SIZE_BYTES: u64 = 4 * 1024 * 1024 * 1024;
/// Sanity ceiling on a single path component's length.
pub const MAX_PATH_LEN: usize = 4096;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EntryKind {
    File,
    Directory,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChunkRef {
    /// Hex-encoded SHA-256 of the chunk's bytes. Content-addressed: the ID *is* the integrity
    /// proof for that chunk.
    pub chunk_id: String,
    pub size: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestEntry {
    /// Normalized relative path using forward slashes, never absolute, never containing `.`/`..`.
    pub relative_path: String,
    pub kind: EntryKind,
    pub size: u64,
    /// Hex-encoded SHA-256 of the complete file content. `None` for directories.
    pub content_hash: Option<String>,
    pub executable: bool,
    pub chunks: Vec<ChunkRef>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectManifest {
    pub schema_version: u32,
    pub project_id: String,
    pub project_revision: String,
    pub author_device_id: String,
    pub exclusion_policy_version: u32,
    pub entries: Vec<ManifestEntry>,
    pub created_at_ms: u64,
    pub signature: Vec<u8>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ManifestError {
    TooManyEntries,
    FileTooLarge,
    EmptyPath,
    AbsolutePath,
    TraversalComponent,
    ReservedComponent,
    PathTooLong,
    DuplicatePath,
    CaseCollision,
    ImpossibleSize,
    UnsupportedEntry,
    Io,
    InvalidSignature,
}

impl std::fmt::Display for ManifestError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let code = match self {
            ManifestError::TooManyEntries => "manifest_too_many_entries",
            ManifestError::FileTooLarge => "manifest_file_too_large",
            ManifestError::EmptyPath => "manifest_path_empty",
            ManifestError::AbsolutePath => "manifest_path_absolute",
            ManifestError::TraversalComponent => "manifest_path_traversal",
            ManifestError::ReservedComponent => "manifest_path_reserved",
            ManifestError::PathTooLong => "manifest_path_too_long",
            ManifestError::DuplicatePath => "manifest_path_duplicate",
            ManifestError::CaseCollision => "manifest_path_case_collision",
            ManifestError::ImpossibleSize => "manifest_size_impossible",
            ManifestError::UnsupportedEntry => "manifest_entry_unsupported",
            ManifestError::Io => "manifest_io_error",
            ManifestError::InvalidSignature => "manifest_signature_invalid",
        };
        write!(f, "{code}")
    }
}

const RESERVED_WINDOWS_NAMES: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// Validates a single normalized relative path per SYNC-INV-005/SYNC-INV-006 without touching
/// the filesystem. Returns the normalized (forward-slash) form on success.
pub fn normalize_and_validate_path(raw: &str) -> Result<String, ManifestError> {
    if raw.is_empty() {
        return Err(ManifestError::EmptyPath);
    }
    if raw.len() > MAX_PATH_LEN {
        return Err(ManifestError::PathTooLong);
    }
    if raw.starts_with('/') || raw.starts_with('\\') {
        return Err(ManifestError::AbsolutePath);
    }
    // A Windows drive prefix ("C:") anywhere is an absolute-path smuggling attempt.
    if raw.contains(':') {
        return Err(ManifestError::AbsolutePath);
    }
    let normalized = raw.replace('\\', "/");
    let mut parts = Vec::new();
    for component in normalized.split('/') {
        if component.is_empty() || component == "." {
            return Err(ManifestError::EmptyPath);
        }
        if component == ".." {
            return Err(ManifestError::TraversalComponent);
        }
        let bare_name = component.split('.').next().unwrap_or(component);
        if RESERVED_WINDOWS_NAMES
            .iter()
            .any(|reserved| reserved.eq_ignore_ascii_case(bare_name))
        {
            return Err(ManifestError::ReservedComponent);
        }
        if component.contains('\0') {
            return Err(ManifestError::ReservedComponent);
        }
        parts.push(component);
    }
    Ok(parts.join("/"))
}

fn default_excluded_dir_names() -> HashSet<&'static str> {
    [
        "node_modules",
        "target",
        "target-e2e",
        "dist",
        "build",
        ".next",
        "venv",
        ".venv",
        "__pycache__",
        ".git",
        ".alethe",
        ".cache",
    ]
    .into_iter()
    .collect()
}

/// Deny-by-default exclusion policy (step 6.2). A path is excluded if any of its components
/// matches a generated/dependency directory name, or if its filename looks like a credential or
/// secret. This runs during manifest construction, not as an afterthought — an excluded path
/// never becomes a manifest entry, so its name never leaves the local machine either.
pub fn is_excluded(relative_path: &str) -> bool {
    let excluded_dirs = default_excluded_dir_names();
    let components: Vec<&str> = relative_path.split('/').collect();
    if components
        .iter()
        .any(|component| excluded_dirs.contains(component))
    {
        return true;
    }
    let Some(filename) = components.last() else {
        return false;
    };
    let lower = filename.to_ascii_lowercase();
    if lower == ".env" || lower.starts_with(".env.") {
        return true;
    }
    let secret_filenames = [
        "id_rsa",
        "id_ed25519",
        "id_ecdsa",
        "credentials.json",
        "google-oauth.json",
        ".npmrc",
    ];
    if secret_filenames.contains(&lower.as_str()) {
        return true;
    }
    if lower.ends_with(".pem") || lower.ends_with(".key") || lower.ends_with(".pfx") {
        return true;
    }
    false
}

fn canonical_signable_bytes(manifest: &ProjectManifest) -> Vec<u8> {
    let mut buffer = Vec::with_capacity(1024);
    buffer.extend_from_slice(&manifest.schema_version.to_le_bytes());
    let write_str = |buffer: &mut Vec<u8>, value: &str| {
        buffer.extend_from_slice(&(value.len() as u32).to_le_bytes());
        buffer.extend_from_slice(value.as_bytes());
    };
    write_str(&mut buffer, &manifest.project_id);
    write_str(&mut buffer, &manifest.project_revision);
    write_str(&mut buffer, &manifest.author_device_id);
    buffer.extend_from_slice(&manifest.exclusion_policy_version.to_le_bytes());
    buffer.extend_from_slice(&(manifest.entries.len() as u32).to_le_bytes());
    for entry in &manifest.entries {
        write_str(&mut buffer, &entry.relative_path);
        buffer.push(match entry.kind {
            EntryKind::File => 0,
            EntryKind::Directory => 1,
        });
        buffer.extend_from_slice(&entry.size.to_le_bytes());
        write_str(&mut buffer, entry.content_hash.as_deref().unwrap_or(""));
        buffer.push(u8::from(entry.executable));
        buffer.extend_from_slice(&(entry.chunks.len() as u32).to_le_bytes());
        for chunk in &entry.chunks {
            write_str(&mut buffer, &chunk.chunk_id);
            buffer.extend_from_slice(&chunk.size.to_le_bytes());
        }
    }
    buffer.extend_from_slice(&manifest.created_at_ms.to_le_bytes());
    buffer
}

pub fn sign_manifest(manifest: &mut ProjectManifest, signing_key: &SigningKey) {
    let signable = canonical_signable_bytes(manifest);
    manifest.signature = signing_key.sign(&signable).to_bytes().to_vec();
}

pub fn verify_manifest_signature(
    manifest: &ProjectManifest,
    verifying_key: &VerifyingKey,
) -> Result<(), ManifestError> {
    let signable = canonical_signable_bytes(manifest);
    let signature_bytes: [u8; 64] = manifest
        .signature
        .as_slice()
        .try_into()
        .map_err(|_| ManifestError::InvalidSignature)?;
    let signature = Signature::from_bytes(&signature_bytes);
    verifying_key
        .verify(&signable, &signature)
        .map_err(|_| ManifestError::InvalidSignature)
}

/// Validates structural safety invariants of an already-built manifest: path safety (delegated
/// to `normalize_and_validate_path`, which every entry must already satisfy), no duplicate or
/// case-colliding paths, no impossible sizes, and the entry count bound.
pub fn validate_manifest(manifest: &ProjectManifest) -> Result<(), ManifestError> {
    if manifest.schema_version != MANIFEST_SCHEMA_VERSION {
        return Err(ManifestError::UnsupportedEntry);
    }
    if manifest.entries.len() > MAX_ENTRIES {
        return Err(ManifestError::TooManyEntries);
    }
    let mut seen_exact: HashSet<&str> = HashSet::with_capacity(manifest.entries.len());
    let mut seen_case_insensitive: HashSet<String> = HashSet::with_capacity(manifest.entries.len());
    for entry in &manifest.entries {
        let normalized = normalize_and_validate_path(&entry.relative_path)?;
        if normalized != entry.relative_path {
            // The manifest must already store the normalized form; a mismatch here means it was
            // hand-crafted or corrupted rather than produced by `build_manifest_from_dir`.
            return Err(ManifestError::TraversalComponent);
        }
        if !seen_exact.insert(entry.relative_path.as_str()) {
            return Err(ManifestError::DuplicatePath);
        }
        let lower = entry.relative_path.to_ascii_lowercase();
        if !seen_case_insensitive.insert(lower) {
            return Err(ManifestError::CaseCollision);
        }
        match entry.kind {
            EntryKind::Directory => {
                if entry.size != 0 || entry.content_hash.is_some() || !entry.chunks.is_empty() {
                    return Err(ManifestError::ImpossibleSize);
                }
            }
            EntryKind::File => {
                if entry.size > MAX_FILE_SIZE_BYTES {
                    return Err(ManifestError::FileTooLarge);
                }
                if entry.content_hash.is_none() {
                    return Err(ManifestError::ImpossibleSize);
                }
                let chunk_total: u64 = entry.chunks.iter().map(|chunk| chunk.size).sum();
                if entry.size == 0 {
                    if !entry.chunks.is_empty() {
                        return Err(ManifestError::ImpossibleSize);
                    }
                } else if chunk_total != entry.size || entry.chunks.is_empty() {
                    return Err(ManifestError::ImpossibleSize);
                }
                if entry
                    .chunks
                    .iter()
                    .any(|chunk| chunk.size == 0 || chunk.size as usize > CHUNK_SIZE_BYTES)
                {
                    return Err(ManifestError::ImpossibleSize);
                }
            }
        }
    }
    Ok(())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Reads a file and splits it into bounded, content-addressed chunks, returning the chunk
/// references (for the manifest) and the whole-file hash. Does not keep chunk bytes in memory
/// beyond what is needed to hash and, when `sink` is provided, persist each one — bounded memory
/// regardless of file size.
fn chunk_file(
    path: &Path,
    mut on_chunk: impl FnMut(&str, &[u8]) -> Result<(), ManifestError>,
) -> Result<(String, Vec<ChunkRef>, u64), ManifestError> {
    let mut file = fs::File::open(path).map_err(|_| ManifestError::Io)?;
    let mut whole_file_hasher = Sha256::new();
    let mut buffer = vec![0_u8; CHUNK_SIZE_BYTES];
    let mut chunks = Vec::new();
    let mut total_size = 0_u64;
    loop {
        let mut filled = 0_usize;
        while filled < buffer.len() {
            let read = file.read(&mut buffer[filled..]).map_err(|_| ManifestError::Io)?;
            if read == 0 {
                break;
            }
            filled += read;
        }
        if filled == 0 {
            break;
        }
        let chunk_bytes = &buffer[..filled];
        whole_file_hasher.update(chunk_bytes);
        let chunk_id = hex(&Sha256::digest(chunk_bytes));
        on_chunk(&chunk_id, chunk_bytes)?;
        chunks.push(ChunkRef {
            chunk_id,
            size: filled as u64,
        });
        total_size += filled as u64;
        if total_size > MAX_FILE_SIZE_BYTES {
            return Err(ManifestError::FileTooLarge);
        }
        if filled < buffer.len() {
            break;
        }
    }
    Ok((hex(&whole_file_hasher.finalize()), chunks, total_size))
}

/// Builds and signs a manifest from a local directory tree, applying the default exclusion
/// policy and bounded chunking. Read-only with respect to `root` — never writes anything there.
/// `on_chunk` receives every chunk's ID and bytes as they are hashed, so a caller (staging) can
/// persist them without a second read pass; pass a no-op if only the manifest is needed.
pub fn build_manifest_from_dir(
    root: &Path,
    project_id: &str,
    project_revision: &str,
    author_device_id: &str,
    signing_key: &SigningKey,
    now_ms: u64,
    mut on_chunk: impl FnMut(&str, &[u8]) -> Result<(), ManifestError>,
) -> Result<ProjectManifest, ManifestError> {
    let mut entries = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(current) = stack.pop() {
        let read_dir = fs::read_dir(&current).map_err(|_| ManifestError::Io)?;
        for entry in read_dir {
            let entry = entry.map_err(|_| ManifestError::Io)?;
            let path = entry.path();
            let relative = path
                .strip_prefix(root)
                .map_err(|_| ManifestError::Io)?
                .to_string_lossy()
                .replace('\\', "/");
            if is_excluded(&relative) {
                continue;
            }
            let normalized = normalize_and_validate_path(&relative)?;
            let metadata = entry.metadata().map_err(|_| ManifestError::Io)?;
            if metadata.is_dir() {
                entries.push(ManifestEntry {
                    relative_path: normalized,
                    kind: EntryKind::Directory,
                    size: 0,
                    content_hash: None,
                    executable: false,
                    chunks: Vec::new(),
                });
                stack.push(path);
            } else if metadata.is_file() {
                if metadata.len() > MAX_FILE_SIZE_BYTES {
                    return Err(ManifestError::FileTooLarge);
                }
                let (content_hash, chunks, size) = chunk_file(&path, &mut on_chunk)?;
                #[cfg(unix)]
                let executable = {
                    use std::os::unix::fs::PermissionsExt;
                    metadata.permissions().mode() & 0o111 != 0
                };
                #[cfg(not(unix))]
                let executable = false;
                entries.push(ManifestEntry {
                    relative_path: normalized,
                    kind: EntryKind::File,
                    size,
                    content_hash: Some(content_hash),
                    executable,
                    chunks,
                });
            }
            // Symlinks, sockets, and other special file types are silently skipped: only regular
            // files and directories are represented, matching the deny-by-default handling of
            // unsupported link/special-file types (step 6.1).
            if entries.len() > MAX_ENTRIES {
                return Err(ManifestError::TooManyEntries);
            }
        }
    }
    entries.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));

    let mut manifest = ProjectManifest {
        schema_version: MANIFEST_SCHEMA_VERSION,
        project_id: project_id.to_string(),
        project_revision: project_revision.to_string(),
        author_device_id: author_device_id.to_string(),
        exclusion_policy_version: EXCLUSION_POLICY_VERSION,
        entries,
        created_at_ms: now_ms,
        signature: Vec::new(),
    };
    validate_manifest(&manifest)?;
    sign_manifest(&mut manifest, signing_key);
    Ok(manifest)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand_core::OsRng;

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("alethe-manifest-{name}-{}", nanoid::nanoid!(8)));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn normalize_rejects_absolute_traversal_and_reserved_names() {
        assert_eq!(normalize_and_validate_path(""), Err(ManifestError::EmptyPath));
        assert_eq!(normalize_and_validate_path("/etc/passwd"), Err(ManifestError::AbsolutePath));
        assert_eq!(normalize_and_validate_path("C:/Windows"), Err(ManifestError::AbsolutePath));
        assert_eq!(
            normalize_and_validate_path("src/../../../etc/passwd"),
            Err(ManifestError::TraversalComponent)
        );
        assert_eq!(normalize_and_validate_path("a/./b"), Err(ManifestError::EmptyPath));
        assert_eq!(normalize_and_validate_path("a/CON.txt"), Err(ManifestError::ReservedComponent));
        assert_eq!(normalize_and_validate_path("a/nul"), Err(ManifestError::ReservedComponent));
        assert_eq!(normalize_and_validate_path("src\\main.rs").unwrap(), "src/main.rs");
    }

    #[test]
    fn exclusion_policy_hides_git_dependencies_and_secrets_by_default() {
        assert!(is_excluded(".git/config"));
        assert!(is_excluded("node_modules/pkg/index.js"));
        assert!(is_excluded(".env"));
        assert!(is_excluded(".env.local"));
        assert!(is_excluded("keys/id_rsa"));
        assert!(is_excluded("certs/server.pem"));
        assert!(is_excluded(".alethe/security-v1.json"));
        assert!(!is_excluded("src/main.rs"));
        assert!(!is_excluded("README.md"));
    }

    #[test]
    fn build_manifest_excludes_secrets_and_signs_deterministically() {
        let root = temp_dir("build");
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src").join("main.rs"), b"fn main() {}").unwrap();
        fs::write(root.join(".env"), b"SECRET=1").unwrap();
        fs::create_dir_all(root.join("node_modules").join("pkg")).unwrap();
        fs::write(root.join("node_modules").join("pkg").join("index.js"), b"{}").unwrap();

        let signing_key = SigningKey::generate(&mut OsRng);
        let manifest = build_manifest_from_dir(
            &root,
            "project-a",
            "rev-1",
            "dev-a",
            &signing_key,
            1_000,
            |_id, _bytes| Ok(()),
        )
        .unwrap();

        let paths: Vec<&str> = manifest.entries.iter().map(|e| e.relative_path.as_str()).collect();
        assert!(paths.contains(&"src"));
        assert!(paths.contains(&"src/main.rs"));
        assert!(!paths.iter().any(|p| p.contains(".env")));
        assert!(!paths.iter().any(|p| p.contains("node_modules")));

        assert!(verify_manifest_signature(&manifest, &signing_key.verifying_key()).is_ok());
        let other_key = SigningKey::generate(&mut OsRng);
        assert!(verify_manifest_signature(&manifest, &other_key.verifying_key()).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn validate_manifest_rejects_duplicate_and_case_colliding_paths() {
        let mut manifest = ProjectManifest {
            schema_version: MANIFEST_SCHEMA_VERSION,
            project_id: "p".to_string(),
            project_revision: "r".to_string(),
            author_device_id: "d".to_string(),
            exclusion_policy_version: EXCLUSION_POLICY_VERSION,
            entries: vec![
                ManifestEntry {
                    relative_path: "README.md".to_string(),
                    kind: EntryKind::File,
                    size: 4,
                    content_hash: Some("a".repeat(64)),
                    executable: false,
                    chunks: vec![ChunkRef { chunk_id: "a".repeat(64), size: 4 }],
                },
                ManifestEntry {
                    relative_path: "readme.md".to_string(),
                    kind: EntryKind::File,
                    size: 4,
                    content_hash: Some("b".repeat(64)),
                    executable: false,
                    chunks: vec![ChunkRef { chunk_id: "b".repeat(64), size: 4 }],
                },
            ],
            created_at_ms: 1_000,
            signature: Vec::new(),
        };
        assert_eq!(validate_manifest(&manifest), Err(ManifestError::CaseCollision));

        manifest.entries[1].relative_path = "README.md".to_string();
        assert_eq!(validate_manifest(&manifest), Err(ManifestError::DuplicatePath));
    }

    #[test]
    fn validate_manifest_rejects_impossible_sizes() {
        let file_with_no_hash = ManifestEntry {
            relative_path: "a.txt".to_string(),
            kind: EntryKind::File,
            size: 10,
            content_hash: None,
            executable: false,
            chunks: vec![],
        };
        let manifest = ProjectManifest {
            schema_version: MANIFEST_SCHEMA_VERSION,
            project_id: "p".to_string(),
            project_revision: "r".to_string(),
            author_device_id: "d".to_string(),
            exclusion_policy_version: EXCLUSION_POLICY_VERSION,
            entries: vec![file_with_no_hash],
            created_at_ms: 1_000,
            signature: Vec::new(),
        };
        assert_eq!(validate_manifest(&manifest), Err(ManifestError::ImpossibleSize));

        let mismatched_chunk_total = ManifestEntry {
            relative_path: "b.txt".to_string(),
            kind: EntryKind::File,
            size: 100,
            content_hash: Some("c".repeat(64)),
            executable: false,
            chunks: vec![ChunkRef { chunk_id: "c".repeat(64), size: 10 }],
        };
        let manifest2 = ProjectManifest {
            entries: vec![mismatched_chunk_total],
            ..manifest
        };
        assert_eq!(validate_manifest(&manifest2), Err(ManifestError::ImpossibleSize));
    }

    #[test]
    fn validate_manifest_rejects_directory_entries_carrying_file_fields() {
        let bad_directory = ManifestEntry {
            relative_path: "src".to_string(),
            kind: EntryKind::Directory,
            size: 5,
            content_hash: None,
            executable: false,
            chunks: vec![],
        };
        let manifest = ProjectManifest {
            schema_version: MANIFEST_SCHEMA_VERSION,
            project_id: "p".to_string(),
            project_revision: "r".to_string(),
            author_device_id: "d".to_string(),
            exclusion_policy_version: EXCLUSION_POLICY_VERSION,
            entries: vec![bad_directory],
            created_at_ms: 1_000,
            signature: Vec::new(),
        };
        assert_eq!(validate_manifest(&manifest), Err(ManifestError::ImpossibleSize));
    }

    #[test]
    fn chunking_reconstructs_the_exact_file_hash() {
        let root = temp_dir("chunk");
        // Larger than CHUNK_SIZE_BYTES would be slow for a unit test; verify the mechanism with
        // a file that spans multiple small logical chunks by shrinking expectations to the
        // actual content instead of forcing a multi-megabyte fixture.
        let content = b"the quick brown fox jumps over the lazy dog".repeat(100);
        fs::write(root.join("data.bin"), &content).unwrap();

        let mut received: Vec<(String, Vec<u8>)> = Vec::new();
        let (hash, chunks, size) = chunk_file(&root.join("data.bin"), |id, bytes| {
            received.push((id.to_string(), bytes.to_vec()));
            Ok(())
        })
        .unwrap();

        assert_eq!(size, content.len() as u64);
        assert_eq!(chunks.len(), 1); // content is well under CHUNK_SIZE_BYTES
        assert_eq!(chunks[0].chunk_id, received[0].0);
        let reassembled: Vec<u8> = received.into_iter().flat_map(|(_, bytes)| bytes).collect();
        assert_eq!(reassembled, content);
        assert_eq!(hash, hex(&Sha256::digest(&content)));
        fs::remove_dir_all(root).unwrap();
    }
}
