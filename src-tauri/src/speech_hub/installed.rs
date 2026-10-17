//! Manifests of Hugging Face models on disk. A manifest is written when a download starts
//! (`complete: false`) and completed when every file is verified, so a paused download survives
//! a restart and resumes the same commit. Every read re-validates the manifest.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::detect::{safe_path, Family, HubLayout, RepoFile};
use super::hf::{self, SearchHit};
use super::meta::ModelMeta;
use super::{hub_id, hub_info, HubModelInfo, Resolved};

pub const MANIFEST: &str = "alethe-model.json";
pub const VERSION: u32 = 1;
const DIR_PREFIX: &str = "hf--";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HubManifest {
    pub version: u32,
    pub id: String,
    pub repo: String,
    pub commit: String,
    pub family: Family,
    pub layout: HubLayout,
    pub files: Vec<RepoFile>,
    pub meta: ModelMeta,
    pub stats: SearchHit,
    pub complete: bool,
}

impl HubManifest {
    pub fn total_bytes(&self) -> u64 {
        super::total_size(&self.files)
    }

    pub fn info(&self) -> HubModelInfo {
        hub_info(
            &self.stats,
            Some(&self.commit),
            self.family,
            &self.meta,
            Some(&self.files),
        )
    }
}

pub fn repo_of(id: &str) -> Option<&str> {
    id.strip_prefix("hf:")
}

pub fn dir_name(id: &str) -> Option<String> {
    let repo = repo_of(id).filter(|repo| hf::valid_repo(repo))?;
    Some(format!("{DIR_PREFIX}{}", repo.replace('/', "--")))
}

pub fn from_resolved(resolved: &Resolved) -> HubManifest {
    HubManifest {
        version: VERSION,
        id: hub_id(&resolved.info.hit.repo),
        repo: resolved.info.hit.repo.clone(),
        commit: resolved.info.commit.clone(),
        family: resolved.planned.family,
        layout: resolved.planned.layout.clone(),
        files: resolved.planned.files.clone(),
        meta: resolved.meta.clone(),
        stats: resolved.info.hit.clone(),
        complete: false,
    }
}

pub fn for_download(
    existing: Option<HubManifest>,
    resolved: impl FnOnce() -> HubManifest,
) -> HubManifest {
    existing.unwrap_or_else(resolved)
}

pub fn validate(manifest: &HubManifest, dir_name_on_disk: &str) -> bool {
    let listed = |path: &str| manifest.files.iter().any(|f| f.path == path);
    manifest.version == VERSION
        && hf::valid_repo(&manifest.repo)
        && manifest.id == hub_id(&manifest.repo)
        && dir_name(&manifest.id).as_deref() == Some(dir_name_on_disk)
        && hf::valid_commit(&manifest.commit)
        && !manifest.files.is_empty()
        && manifest
            .files
            .iter()
            .all(|f| safe_path(&f.path) && f.path != MANIFEST && !f.path.ends_with(".part"))
        && manifest.family.is_tts() == matches!(manifest.layout, HubLayout::Tts(_))
        && manifest.layout.files().iter().all(|path| listed(path))
}

pub fn read(dir: &Path) -> Option<HubManifest> {
    let name = dir.file_name()?.to_str()?;
    let body = fs::read_to_string(dir.join(MANIFEST)).ok()?;
    let manifest: HubManifest = serde_json::from_str(&body).ok()?;
    validate(&manifest, name).then_some(manifest)
}

/// Written next to the files through a temporary name, so a crash never leaves half a manifest.
pub fn write(dir: &Path, manifest: &HubManifest) -> Result<(), String> {
    let body = serde_json::to_vec_pretty(manifest).map_err(|e| format!("manifest: {e}"))?;
    let tmp = dir.join(format!("{MANIFEST}.tmp"));
    fs::write(&tmp, body).map_err(|e| format!("write {}: {e}", tmp.display()))?;
    fs::rename(&tmp, dir.join(MANIFEST)).map_err(|e| format!("finalize manifest: {e}"))
}

/// Every valid manifest under `root`, by label.
pub fn list(root: &Path) -> Vec<(PathBuf, HubManifest)> {
    let Ok(entries) = fs::read_dir(root) else {
        return Vec::new();
    };
    let mut found: Vec<(PathBuf, HubManifest)> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with(DIR_PREFIX))
        })
        .filter_map(|path| read(&path).map(|manifest| (path, manifest)))
        .collect();
    found.sort_by(|a, b| a.1.meta.label.cmp(&b.1.meta.label));
    found
}

pub fn is_ready(dir: &Path, manifest: &HubManifest) -> bool {
    manifest.complete && manifest.files.iter().all(|f| dir.join(&f.path).is_file())
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;
    use crate::speech_hub::detect::{plan, RepoFile};
    use crate::speech_hub::hf::{RepoInfo, SearchHit};
    use crate::speech_hub::meta::describe;
    use crate::speech_hub::Resolved;

    const REPO: &str = "csukuangfj/vits-piper-pt_BR-faber-medium";

    fn resolved(commit: char) -> Resolved {
        let files: Vec<RepoFile> = [
            "pt_BR-faber-medium.onnx",
            "tokens.txt",
            "espeak-ng-data/pt_dict",
        ]
        .iter()
        .map(|p| RepoFile {
            path: (*p).into(),
            size: 3,
            sha256: None,
            git_sha1: Some("0".repeat(40)),
        })
        .collect();
        let name = "vits-piper-pt_BR-faber-medium";
        Resolved {
            info: RepoInfo {
                hit: SearchHit {
                    repo: REPO.into(),
                    likes: 6,
                    ..Default::default()
                },
                commit: commit.to_string().repeat(40),
            },
            planned: plan(name, &files).unwrap(),
            meta: describe(crate::speech_hub::detect::Family::Vits, name, None),
        }
    }

    fn temp_root(tag: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("alethe-hub-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn ids_map_to_safe_folder_names() {
        assert_eq!(repo_of("hf:csukuangfj/x"), Some("csukuangfj/x"));
        assert_eq!(repo_of("piper-en-us-amy-low"), None);
        assert_eq!(
            dir_name("hf:csukuangfj/x").as_deref(),
            Some("hf--csukuangfj--x")
        );
        assert_eq!(dir_name("hf:someone/x"), None);
        assert_eq!(dir_name("hf:csukuangfj/../x"), None);
    }

    #[test]
    fn manifest_round_trips_and_validates() {
        let root = temp_root("roundtrip");
        let manifest = from_resolved(&resolved('a'));
        assert!(!manifest.complete);
        let dir = root.join(dir_name(&manifest.id).unwrap());
        fs::create_dir_all(&dir).unwrap();
        write(&dir, &manifest).unwrap();
        assert_eq!(read(&dir), Some(manifest.clone()));
        assert_eq!(list(&root).len(), 1);
    }

    #[test]
    fn manifest_in_the_wrong_folder_is_rejected() {
        let manifest = from_resolved(&resolved('a'));
        assert!(validate(
            &manifest,
            "hf--csukuangfj--vits-piper-pt_BR-faber-medium"
        ));
        assert!(!validate(&manifest, "hf--csukuangfj--other"));
    }

    #[test]
    fn manifest_with_unsafe_path_is_rejected() {
        let mut manifest = from_resolved(&resolved('a'));
        manifest.files.push(RepoFile {
            path: "../escape".into(),
            size: 1,
            sha256: None,
            git_sha1: Some("0".repeat(40)),
        });
        assert!(!validate(
            &manifest,
            "hf--csukuangfj--vits-piper-pt_BR-faber-medium"
        ));
        let mut missing = from_resolved(&resolved('a'));
        missing.files.retain(|f| f.path != "tokens.txt");
        assert!(
            !validate(&missing, "hf--csukuangfj--vits-piper-pt_BR-faber-medium"),
            "layout names a file not in the list"
        );
        let mut shadow = from_resolved(&resolved('a'));
        shadow.files.push(RepoFile {
            path: MANIFEST.into(),
            size: 1,
            sha256: None,
            git_sha1: Some("0".repeat(40)),
        });
        assert!(!validate(
            &shadow,
            "hf--csukuangfj--vits-piper-pt_BR-faber-medium"
        ));
    }

    #[test]
    fn readiness_needs_completion_and_every_file() {
        let root = temp_root("ready");
        let mut manifest = from_resolved(&resolved('a'));
        let dir = root.join(dir_name(&manifest.id).unwrap());
        fs::create_dir_all(dir.join("espeak-ng-data")).unwrap();
        for file in &manifest.files {
            fs::write(dir.join(&file.path), b"abc").unwrap();
        }
        assert!(
            !is_ready(&dir, &manifest),
            "a pending manifest is not ready"
        );
        manifest.complete = true;
        assert!(is_ready(&dir, &manifest));
        fs::remove_file(dir.join("tokens.txt")).unwrap();
        assert!(!is_ready(&dir, &manifest));
    }

    #[test]
    fn download_reuses_the_pending_manifest() {
        let pending = from_resolved(&resolved('a'));
        let used = for_download(Some(pending.clone()), || from_resolved(&resolved('b')));
        assert_eq!(
            used.commit,
            "a".repeat(40),
            "a resumed download keeps its commit"
        );
        let fresh = for_download(None, || from_resolved(&resolved('b')));
        assert_eq!(fresh.commit, "b".repeat(40));
    }

    #[test]
    fn unreadable_or_foreign_folders_are_skipped() {
        let root = temp_root("skip");
        fs::create_dir_all(root.join("hf--csukuangfj--broken")).unwrap();
        fs::write(
            root.join("hf--csukuangfj--broken").join(MANIFEST),
            b"{not json",
        )
        .unwrap();
        fs::create_dir_all(root.join("piper-en-us-amy-low")).unwrap();
        assert!(list(&root).is_empty());
    }

    #[test]
    fn a_forgotten_repo_is_resolved_again() {
        let state = crate::speech_hub::HubState::default();
        let mut cache = state.resolved.lock().unwrap();
        cache.insert(REPO.into(), resolved('a'));
        cache.insert("csukuangfj/other".into(), resolved('b'));
        drop(cache);
        state.forget(REPO);
        let cache = state.resolved.lock().unwrap();
        assert!(!cache.contains_key(REPO));
        assert!(cache.contains_key("csukuangfj/other"));
    }
}
