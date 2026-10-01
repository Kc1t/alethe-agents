//! Downloading and unpacking a plugin package.
//!
//! A package is a zip pinned by a `sha256` in the catalogue index. The hash is
//! what makes installing from the app defensible: the bytes that run are the
//! bytes the index was reviewed against. Nothing here decides whether a plugin
//! may run — the unpacked directory still goes through the normal import, and
//! still arrives disabled.

use std::io::Read;
use std::path::{Component, Path, PathBuf};

use sha2::{Digest, Sha256};

/// Caps chosen to stop a zip bomb, not to be generous. A plugin is source code
/// and a few assets; anything near these numbers is not a plugin.
const MAX_DOWNLOAD_BYTES: usize = 8 * 1024 * 1024;
const MAX_UNPACKED_BYTES: u64 = 32 * 1024 * 1024;
const MAX_ENTRIES: usize = 2_000;
const MANIFEST_FILE: &str = "plugin.json";

pub fn is_sha256(value: &str) -> bool {
    value.len() == 64 && value.chars().all(|c| c.is_ascii_hexdigit())
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Compared case-insensitively so an index written with uppercase hex still
/// matches; never short-circuited on length alone.
pub fn verify_sha256(bytes: &[u8], expected: &str) -> Result<(), String> {
    if !is_sha256(expected) {
        return Err("bad_expected_hash".to_string());
    }
    let actual = sha256_hex(bytes);
    if actual.eq_ignore_ascii_case(expected) {
        Ok(())
    } else {
        Err(format!("hash_mismatch:{actual}"))
    }
}

/// Resolves an archive entry name to a path inside the destination, or refuses.
/// Zip names are attacker-controlled: `..`, absolute paths, Windows drive
/// prefixes and UNC roots all have to be rejected rather than normalized away.
pub fn safe_entry_path(name: &str) -> Result<PathBuf, String> {
    if name.is_empty() {
        return Err("empty_entry".to_string());
    }
    if name.contains('\0') {
        return Err("nul_in_entry".to_string());
    }
    let normalized = name.replace('\\', "/");
    if normalized.starts_with('/') || normalized.contains(':') {
        return Err(format!("absolute_entry:{name}"));
    }

    let mut out = PathBuf::new();
    for part in normalized.split('/') {
        match part {
            "" | "." => continue,
            ".." => return Err(format!("escaping_entry:{name}")),
            part => out.push(part),
        }
    }
    if out.as_os_str().is_empty() {
        return Err("empty_entry".to_string());
    }
    // A second pass: `PathBuf::push` can still absorb something odd on Windows.
    if out.components().any(|c| !matches!(c, Component::Normal(_))) {
        return Err(format!("unexpected_entry:{name}"));
    }
    Ok(out)
}

pub fn check_download_size(len: usize) -> Result<(), String> {
    if len > MAX_DOWNLOAD_BYTES {
        return Err("package_too_large".to_string());
    }
    Ok(())
}

/// Unpacks into `destination`, which must not already exist. Directories are
/// created from entry paths rather than from directory entries, so an archive
/// cannot create a directory it never declares a file in.
pub fn extract_zip(bytes: &[u8], destination: &Path) -> Result<(), String> {
    let reader = std::io::Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(reader).map_err(|e| format!("bad_archive:{e}"))?;
    if archive.len() > MAX_ENTRIES {
        return Err("too_many_entries".to_string());
    }

    std::fs::create_dir_all(destination).map_err(|e| format!("mkdir_failed:{e}"))?;
    let mut written: u64 = 0;

    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|e| format!("bad_entry:{e}"))?;
        if entry.is_dir() {
            continue;
        }
        let relative = safe_entry_path(entry.name())?;
        written = written.saturating_add(entry.size());
        if written > MAX_UNPACKED_BYTES {
            return Err("unpacked_too_large".to_string());
        }

        let target = destination.join(&relative);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("mkdir_failed:{e}"))?;
        }
        let mut body = Vec::new();
        entry
            .read_to_end(&mut body)
            .map_err(|e| format!("read_failed:{e}"))?;
        std::fs::write(&target, &body).map_err(|e| format!("write_failed:{e}"))?;
    }
    Ok(())
}

/// Finds the directory holding `plugin.json`. Archives made by "download zip"
/// on a forge wrap everything in one folder, so that shape is accepted — but
/// only that one, and only when it is unambiguous.
pub fn find_manifest_root(unpacked: &Path) -> Result<PathBuf, String> {
    if unpacked.join(MANIFEST_FILE).is_file() {
        return Ok(unpacked.to_path_buf());
    }
    let mut directories = std::fs::read_dir(unpacked)
        .map_err(|e| format!("read_dir_failed:{e}"))?
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| path.is_dir());

    let Some(only) = directories.next() else {
        return Err("manifest_missing".to_string());
    };
    if directories.next().is_some() {
        return Err("manifest_ambiguous".to_string());
    }
    if only.join(MANIFEST_FILE).is_file() {
        return Ok(only);
    }
    Err("manifest_missing".to_string())
}

pub async fn download(url: &str) -> Result<Vec<u8>, String> {
    if !url.starts_with("https://") {
        return Err("unsupported_url".to_string());
    }
    let response = crate::plugin_catalog::http_client()
        .get(url)
        .send()
        .await
        .map_err(|e| format!("request_failed:{e}"))?;
    if !response.status().is_success() {
        return Err(format!("http_{}", response.status().as_u16()));
    }
    if let Some(len) = response.content_length() {
        check_download_size(len as usize)?;
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("read_failed:{e}"))?;
    check_download_size(bytes.len())?;
    Ok(bytes.to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_hash_must_match_exactly_but_not_in_case() {
        let bytes = b"alethe";
        let hash = sha256_hex(bytes);
        assert!(verify_sha256(bytes, &hash).is_ok());
        assert!(verify_sha256(bytes, &hash.to_uppercase()).is_ok());
        assert!(verify_sha256(b"alethf", &hash).is_err());
    }

    #[test]
    fn a_malformed_expected_hash_is_refused_rather_than_compared() {
        assert_eq!(
            verify_sha256(b"x", "not-a-hash").unwrap_err(),
            "bad_expected_hash"
        );
        assert_eq!(verify_sha256(b"x", "").unwrap_err(), "bad_expected_hash");
        assert_eq!(
            verify_sha256(b"x", &"a".repeat(63)).unwrap_err(),
            "bad_expected_hash"
        );
    }

    #[test]
    fn an_entry_may_not_escape_the_destination() {
        for name in [
            "../evil.js",
            "a/../../evil.js",
            "/etc/passwd",
            "C:/Windows/System32/evil.dll",
            "..\\evil.js",
            "a\\..\\..\\evil.js",
        ] {
            assert!(safe_entry_path(name).is_err(), "{name}");
        }
    }

    #[test]
    fn an_ordinary_entry_keeps_its_shape() {
        assert_eq!(
            safe_entry_path("main.js").unwrap(),
            PathBuf::from("main.js")
        );
        assert_eq!(
            safe_entry_path("./assets/icon.svg").unwrap(),
            PathBuf::from("assets").join("icon.svg")
        );
        assert_eq!(
            safe_entry_path("assets\\icon.svg").unwrap(),
            PathBuf::from("assets").join("icon.svg")
        );
    }

    #[test]
    fn an_oversized_download_is_refused() {
        assert!(check_download_size(1024).is_ok());
        assert!(check_download_size(MAX_DOWNLOAD_BYTES + 1).is_err());
    }

    fn zip_of(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut buffer = Vec::new();
        {
            let mut writer = zip::ZipWriter::new(std::io::Cursor::new(&mut buffer));
            let options: zip::write::FileOptions = Default::default();
            for (name, body) in entries {
                use std::io::Write;
                writer.start_file(*name, options).unwrap();
                writer.write_all(body).unwrap();
            }
            writer.finish().unwrap();
        }
        buffer
    }

    #[test]
    fn extracting_writes_files_and_refuses_a_traversing_archive() {
        let dir = std::env::temp_dir().join(format!("alethe-pkg-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);

        let good = zip_of(&[("plugin.json", b"{}"), ("assets/a.js", b"x")]);
        extract_zip(&good, &dir).unwrap();
        assert!(dir.join("plugin.json").is_file());
        assert!(dir.join("assets").join("a.js").is_file());

        let evil_dir = dir.join("evil");
        let evil = zip_of(&[("../escaped.js", b"x")]);
        assert!(extract_zip(&evil, &evil_dir).is_err());
        assert!(!dir.join("escaped.js").exists());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_single_wrapping_folder_is_unwrapped_but_two_are_ambiguous() {
        let base = std::env::temp_dir().join(format!("alethe-root-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);

        let flat = base.join("flat");
        std::fs::create_dir_all(&flat).unwrap();
        std::fs::write(flat.join(MANIFEST_FILE), "{}").unwrap();
        assert_eq!(find_manifest_root(&flat).unwrap(), flat);

        let wrapped = base.join("wrapped");
        std::fs::create_dir_all(wrapped.join("inner")).unwrap();
        std::fs::write(wrapped.join("inner").join(MANIFEST_FILE), "{}").unwrap();
        assert_eq!(find_manifest_root(&wrapped).unwrap(), wrapped.join("inner"));

        std::fs::create_dir_all(wrapped.join("other")).unwrap();
        assert_eq!(
            find_manifest_root(&wrapped).unwrap_err(),
            "manifest_ambiguous"
        );

        let empty = base.join("empty");
        std::fs::create_dir_all(&empty).unwrap();
        assert_eq!(find_manifest_root(&empty).unwrap_err(), "manifest_missing");

        let _ = std::fs::remove_dir_all(&base);
    }
}
