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
/// Chunk size ceiling for files classified as binary (see `is_probably_binary`) — large enough to
/// keep chunk counts reasonable for big binary assets, small enough to bound per-chunk memory
/// during hashing/verification. Binary files are still chunked at this single fixed size (not
/// content-defined): most of them (images, executables) do not benefit from CDC's "only the
/// touched region re-hashes" property the way text/source files do, and fixed chunking is cheaper.
pub const CHUNK_SIZE_BYTES: usize = 4 * 1024 * 1024;
/// Content-defined chunk size bounds for files classified as text/source (the common case for a
/// code project). Deliberately in the tens-of-KB range rather than `CHUNK_SIZE_BYTES`: a whole
/// small file becoming a single chunk (the old fixed-4MiB behavior) meant any edit, even one line,
/// retransmitted the entire file. See `cdc_cut_points` for how the actual boundaries are chosen.
const TEXT_CHUNK_MIN_BYTES: usize = 16 * 1024;
const TEXT_CHUNK_TARGET_BYTES: usize = 32 * 1024;
const TEXT_CHUNK_MAX_BYTES: usize = 128 * 1024;
/// How many leading bytes of a file are inspected to decide text vs. binary — enough to catch a
/// null byte in typical binary formats without reading the whole file (the same heuristic
/// `git`/`file` use: a null byte in the first few KB is treated as decisive evidence of binary
/// content, since legitimate text never contains one).
const BINARY_SNIFF_BYTES: usize = 8 * 1024;
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

/// Classic "sniff the first few KB for a null byte" heuristic (the same one `git`/`file` use) for
/// deciding whether a file is text/source (eligible for content-defined chunking) or binary
/// (chunked at the larger fixed `CHUNK_SIZE_BYTES`). Deliberately not extension-based — a `.txt`
/// file that is actually binary, or an unfamiliar extension, would otherwise be misclassified.
fn is_probably_binary(path: &Path) -> Result<bool, ManifestError> {
    let mut file = fs::File::open(path).map_err(|_| ManifestError::Io)?;
    let mut buffer = vec![0_u8; BINARY_SNIFF_BYTES];
    let mut filled = 0_usize;
    while filled < buffer.len() {
        let read = file.read(&mut buffer[filled..]).map_err(|_| ManifestError::Io)?;
        if read == 0 {
            break;
        }
        filled += read;
    }
    Ok(buffer[..filled].contains(&0))
}

/// Precomputed 256-entry table for the gear-hash rolling hash `cdc_cut_points` uses to find
/// content-defined chunk boundaries. Generated once, deterministically (fixed seed, splitmix64) —
/// determinism matters here: both peers must derive identical chunk boundaries for identical
/// bytes, or the whole point of content-addressed chunk IDs (recognizing already-known chunks)
/// breaks.
fn gear_table() -> &'static [u64; 256] {
    static TABLE: std::sync::OnceLock<[u64; 256]> = std::sync::OnceLock::new();
    TABLE.get_or_init(|| {
        // splitmix64, a small deterministic PRNG — good enough statistical spread for a gear-hash
        // table, and trivial to keep reproducible across builds/platforms (unlike relying on a
        // hashing crate's internal, possibly-changing constants).
        let mut state: u64 = 0x9E3779B97F4A7C15;
        let mut table = [0_u64; 256];
        for slot in table.iter_mut() {
            state = state.wrapping_add(0x9E3779B97F4A7C15);
            let mut z = state;
            z = (z ^ (z >> 30)).wrapping_mul(0xBF58476D1CE4E5B9);
            z = (z ^ (z >> 27)).wrapping_mul(0x94D049BB133111EB);
            *slot = z ^ (z >> 31);
        }
        table
    })
}

/// Finds content-defined chunk boundaries within `data` using a gear-hash rolling hash: the cut
/// point after each byte depends only on the bytes immediately preceding it, so inserting or
/// removing bytes elsewhere in the file shifts chunk boundaries only in the region actually
/// touched — chunks before and after that region keep their exact same content and hash, unlike
/// fixed-offset chunking where every chunk after an edit changes. Returns the lengths of each
/// chunk found; the caller is responsible for slicing/hashing.
fn cdc_cut_points(data: &[u8], min_size: usize, target_size: usize, max_size: usize) -> Vec<usize> {
    if data.is_empty() {
        return Vec::new();
    }
    let table = gear_table();
    // Mask width chosen so a boundary occurs on average every `target_size` bytes: for a uniform
    // random hash, the chance of `hash & mask == 0` is `1 / (mask + 1)`.
    let mask = (target_size.next_power_of_two() as u64).saturating_sub(1);
    let mut lengths = Vec::new();
    let mut chunk_start = 0_usize;
    let mut hash: u64 = 0;
    let mut index = 0_usize;
    while index < data.len() {
        hash = (hash << 1).wrapping_add(table[data[index] as usize]);
        let chunk_len = index - chunk_start + 1;
        let at_boundary = chunk_len >= min_size && (hash & mask) == 0;
        let at_forced_max = chunk_len >= max_size;
        if at_boundary || at_forced_max {
            lengths.push(chunk_len);
            chunk_start = index + 1;
            hash = 0;
        }
        index += 1;
    }
    if chunk_start < data.len() {
        lengths.push(data.len() - chunk_start);
    }
    lengths
}

/// Reads a file and splits it into bounded, content-addressed chunks, returning the chunk
/// references (for the manifest) and the whole-file hash. Binary files (see `is_probably_binary`)
/// are chunked at the fixed `CHUNK_SIZE_BYTES`, same as before; text/source files use
/// content-defined chunking (`cdc_cut_points`) at a much smaller size, so a small edit only
/// changes the chunk(s) actually touched instead of retransmitting the whole file. Does not keep
/// more than one file's worth... — see the per-branch comments for the actual memory bound of
/// each path.
fn chunk_file(
    path: &Path,
    mut on_chunk: impl FnMut(&str, &[u8]) -> Result<(), ManifestError>,
) -> Result<(String, Vec<ChunkRef>, u64), ManifestError> {
    if is_probably_binary(path)? {
        return chunk_file_fixed_size(path, CHUNK_SIZE_BYTES, &mut on_chunk);
    }
    chunk_file_content_defined(path, &mut on_chunk)
}

/// Fixed-offset chunking — bounded memory regardless of file size, since only one chunk-sized
/// buffer is ever held at once.
fn chunk_file_fixed_size(
    path: &Path,
    chunk_size: usize,
    on_chunk: &mut impl FnMut(&str, &[u8]) -> Result<(), ManifestError>,
) -> Result<(String, Vec<ChunkRef>, u64), ManifestError> {
    let mut file = fs::File::open(path).map_err(|_| ManifestError::Io)?;
    let mut whole_file_hasher = Sha256::new();
    let mut buffer = vec![0_u8; chunk_size];
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

/// Content-defined chunking for text/source files. Reads the whole file into memory to feed the
/// rolling hash — bounded in practice because text/source files this applies to are, by
/// construction of `is_probably_binary`'s exclusion, not the large binary assets
/// `chunk_file_fixed_size` handles; `MAX_FILE_SIZE_BYTES` remains the hard ceiling either way.
fn chunk_file_content_defined(
    path: &Path,
    on_chunk: &mut impl FnMut(&str, &[u8]) -> Result<(), ManifestError>,
) -> Result<(String, Vec<ChunkRef>, u64), ManifestError> {
    let data = fs::read(path).map_err(|_| ManifestError::Io)?;
    if data.len() as u64 > MAX_FILE_SIZE_BYTES {
        return Err(ManifestError::FileTooLarge);
    }
    let mut whole_file_hasher = Sha256::new();
    whole_file_hasher.update(&data);
    let mut chunks = Vec::new();
    let mut offset = 0_usize;
    for length in cdc_cut_points(&data, TEXT_CHUNK_MIN_BYTES, TEXT_CHUNK_TARGET_BYTES, TEXT_CHUNK_MAX_BYTES) {
        let chunk_bytes = &data[offset..offset + length];
        let chunk_id = hex(&Sha256::digest(chunk_bytes));
        on_chunk(&chunk_id, chunk_bytes)?;
        chunks.push(ChunkRef { chunk_id, size: length as u64 });
        offset += length;
    }
    Ok((hex(&whole_file_hasher.finalize()), chunks, data.len() as u64))
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

    #[test]
    fn is_probably_binary_detects_a_null_byte_and_accepts_plain_text() {
        let root = temp_dir("binary-sniff");
        fs::write(root.join("text.txt"), b"just some ordinary source code\nwith multiple lines\n").unwrap();
        let mut binary_content = b"PNG-ish header".to_vec();
        binary_content.push(0);
        binary_content.extend_from_slice(b"more bytes after the null");
        fs::write(root.join("image.bin"), &binary_content).unwrap();

        assert!(!is_probably_binary(&root.join("text.txt")).unwrap());
        assert!(is_probably_binary(&root.join("image.bin")).unwrap());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cdc_cut_points_cover_the_whole_input_without_gaps_or_overlap() {
        let data: Vec<u8> = (0..200_000_u32).map(|value| (value % 251) as u8).collect();
        let lengths = cdc_cut_points(&data, TEXT_CHUNK_MIN_BYTES, TEXT_CHUNK_TARGET_BYTES, TEXT_CHUNK_MAX_BYTES);
        assert!(!lengths.is_empty());
        let total: usize = lengths.iter().sum();
        assert_eq!(total, data.len());
        for length in &lengths {
            assert!(*length >= 1);
            assert!(*length <= TEXT_CHUNK_MAX_BYTES);
        }
    }

    #[test]
    fn cdc_boundaries_are_stable_away_from_a_localized_edit() {
        // The core promise of content-defined chunking: inserting bytes in the middle of a large
        // file should only change the chunk(s) near the insertion point — everything before that
        // region, and most of what's after it (once the rolling hash resynchronizes), should
        // reproduce byte-identical chunks. This is exactly what fixed-offset chunking cannot do
        // (every chunk after the edit point would shift and re-hash).
        let base: Vec<u8> = (0..300_000_u32).map(|value| ((value * 37) % 256) as u8).collect();
        let mut edited = base.clone();
        let insertion_point = 150_000;
        edited.splice(insertion_point..insertion_point, std::iter::repeat(0xAB_u8).take(500));

        let hash_chunks = |data: &[u8]| -> Vec<String> {
            let lengths = cdc_cut_points(data, TEXT_CHUNK_MIN_BYTES, TEXT_CHUNK_TARGET_BYTES, TEXT_CHUNK_MAX_BYTES);
            let mut offset = 0;
            let mut hashes = Vec::new();
            for length in lengths {
                hashes.push(hex(&Sha256::digest(&data[offset..offset + length])));
                offset += length;
            }
            hashes
        };

        let base_hashes = hash_chunks(&base);
        let edited_hashes = hash_chunks(&edited);

        // Chunks entirely before the insertion point must be untouched.
        let prefix_chunk_count = {
            let mut offset = 0usize;
            let mut count = 0usize;
            for length in cdc_cut_points(&base, TEXT_CHUNK_MIN_BYTES, TEXT_CHUNK_TARGET_BYTES, TEXT_CHUNK_MAX_BYTES) {
                if offset + length > insertion_point {
                    break;
                }
                offset += length;
                count += 1;
            }
            count
        };
        assert!(prefix_chunk_count > 0, "fixture should span multiple chunks before the edit point");
        assert_eq!(&base_hashes[..prefix_chunk_count], &edited_hashes[..prefix_chunk_count]);

        // The tail of the file (well after the edit + resync distance) should also match — proof
        // that only a bounded region around the edit was affected, not everything downstream.
        let base_suffix: &[String] = &base_hashes[base_hashes.len().saturating_sub(3)..];
        let edited_suffix: &[String] = &edited_hashes[edited_hashes.len().saturating_sub(3)..];
        assert_eq!(base_suffix, edited_suffix);

        // And the two chunk lists as a whole must actually differ somewhere — otherwise this test
        // would trivially pass even if chunking ignored the insertion entirely.
        assert_ne!(base_hashes, edited_hashes);
    }

    #[test]
    fn chunk_file_uses_content_defined_chunking_for_text_and_fixed_size_for_binary() {
        let root = temp_dir("chunk-dispatch");
        let text_content: Vec<u8> = (0..200_000_u32).map(|value| (value % 97) as u8 + 1).collect();
        fs::write(root.join("source.rs"), &text_content).unwrap();
        let mut binary_content = vec![0_u8; 10 * 1024 * 1024];
        binary_content[0] = 0; // guarantees the null-byte sniff sees it within the first window
        fs::write(root.join("asset.bin"), &binary_content).unwrap();

        let (_, text_chunks, _) = chunk_file(&root.join("source.rs"), |_id, _bytes| Ok(())).unwrap();
        assert!(text_chunks.len() > 1, "large text file should split into multiple CDC chunks");
        assert!(text_chunks.iter().all(|chunk| chunk.size as usize <= TEXT_CHUNK_MAX_BYTES));

        let (_, binary_chunks, _) = chunk_file(&root.join("asset.bin"), |_id, _bytes| Ok(())).unwrap();
        assert!(binary_chunks.iter().all(|chunk| chunk.size as usize == CHUNK_SIZE_BYTES || chunk.size < CHUNK_SIZE_BYTES as u64));
        // Fixed-size chunking: every chunk but the last is exactly CHUNK_SIZE_BYTES.
        for chunk in &binary_chunks[..binary_chunks.len() - 1] {
            assert_eq!(chunk.size as usize, CHUNK_SIZE_BYTES);
        }
        fs::remove_dir_all(root).unwrap();
    }
}
