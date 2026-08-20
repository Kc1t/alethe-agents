use std::fs;
use std::path::{Path, PathBuf};

use alethe_lib::{profiles, projects};

struct TestRoot(PathBuf);

impl TestRoot {
    fn new(label: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "alethe-sync-contract-{label}-{}-{}",
            std::process::id(),
            nanoid::nanoid!(8)
        ));
        fs::create_dir_all(&path).expect("create isolated sync test root");
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TestRoot {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn document(marker: &str) -> String {
    serde_json::json!({
        "version": 6,
        "projects": [{ "id": marker }],
        "groups": [],
        "terminals": []
    })
    .to_string()
}

#[test]
fn concurrent_profile_updates_keep_every_catalog_entry() {
    let root = TestRoot::new("profile-lock");
    profiles::ensure_profiles_index_at(root.path()).unwrap();
    let root_path = root.path();

    std::thread::scope(|scope| {
        let handles = (0..8)
            .map(|index| {
                scope.spawn(move || {
                    profiles::create_profile_state_at(
                        root_path,
                        Some(format!("Concurrent {index}")),
                    )
                })
            })
            .collect::<Vec<_>>();

        for handle in handles {
            handle.join().unwrap().unwrap();
        }
    });

    let state = profiles::list_profiles_state_at(root.path()).unwrap();
    assert_eq!(state.profiles.len(), 9);
    for index in 0..8 {
        assert!(state
            .profiles
            .iter()
            .any(|profile| profile.name == format!("Concurrent {index}")));
    }
}

#[tokio::test]
async fn explicit_save_stays_with_its_profile_after_the_active_profile_changes() {
    let root = TestRoot::new("profile-routing");
    profiles::ensure_profiles_index_at(root.path()).unwrap();

    let initial = projects::save_projects_for_profile_at(
        root.path().to_path_buf(),
        "default".to_string(),
        document("desktop-initial"),
        "missing".to_string(),
    )
    .await
    .unwrap();

    let state =
        profiles::create_profile_state_at(root.path(), Some("Browser".to_string())).unwrap();
    let browser_id = state
        .profiles
        .iter()
        .find(|profile| profile.name == "Browser")
        .unwrap()
        .id
        .clone();
    profiles::set_active_profile_id_at(root.path(), &browser_id).unwrap();

    projects::save_projects_for_profile_at(
        root.path().to_path_buf(),
        "default".to_string(),
        document("desktop-after-switch"),
        initial.revision,
    )
    .await
    .unwrap();

    let browser_bootstrap = projects::load_projects_bootstrap_at(root.path()).unwrap();
    assert_eq!(browser_bootstrap.active_profile_id, browser_id);
    assert!(browser_bootstrap.content.is_none());

    profiles::set_active_profile_id_at(root.path(), "default").unwrap();
    let desktop_bootstrap = projects::load_projects_bootstrap_at(root.path()).unwrap();
    assert!(desktop_bootstrap
        .content
        .unwrap()
        .contains("desktop-after-switch"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn concurrent_cas_writes_have_one_winner_and_one_recovery_copy() {
    let root = TestRoot::new("cas-race");
    profiles::ensure_profiles_index_at(root.path()).unwrap();
    let left_content = document("left-writer");
    let right_content = document("right-writer");

    let left = projects::save_projects_for_profile_at(
        root.path().to_path_buf(),
        "default".to_string(),
        left_content.clone(),
        "missing".to_string(),
    );
    let right = projects::save_projects_for_profile_at(
        root.path().to_path_buf(),
        "default".to_string(),
        right_content.clone(),
        "missing".to_string(),
    );
    let (left_result, right_result) = tokio::join!(left, right);

    assert_ne!(left_result.is_ok(), right_result.is_ok());
    let winner = left_result
        .as_ref()
        .ok()
        .or_else(|| right_result.as_ref().ok())
        .unwrap();
    let loser_error = left_result
        .as_ref()
        .err()
        .or_else(|| right_result.as_ref().err())
        .unwrap();
    assert!(loser_error.starts_with(projects::PROJECTS_REVISION_CONFLICT));

    let bootstrap = projects::load_projects_bootstrap_at(root.path()).unwrap();
    assert_eq!(bootstrap.revision, winner.revision);
    let stored = bootstrap.content.unwrap();
    assert!(stored.contains("left-writer") || stored.contains("right-writer"));

    let conflicts_dir = root
        .path()
        .join("profiles")
        .join("default")
        .join("conflicts");
    let conflicts = fs::read_dir(conflicts_dir)
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(conflicts.len(), 1);
    let recovered = fs::read_to_string(conflicts[0].path()).unwrap();
    assert_ne!(stored, recovered);
}

/// Deliberately NOT alphabetically ordered — a real browser client's
/// `JSON.stringify` uses insertion order, never serde_json's canonical
/// (BTreeMap-sorted) order, so a test built through `serde_json::json!()`
/// would silently already be canonical and miss the bug entirely.
fn raw_document_with_todo_sidecar(marker: &str, todo_dir: &Path) -> String {
    let todo_dir_json = serde_json::to_string(&todo_dir.to_string_lossy().to_string()).unwrap();
    format!(
        r#"{{"version":6,"projects":[{{"id":"{marker}"}}],"todos":[{{"id":"todo-1","text":"Persist me"}}],"preferences":{{"todoStoragePath":{todo_dir_json}}}}}"#
    )
}

#[tokio::test]
async fn idempotent_retry_succeeds_with_a_non_canonical_payload_while_the_sidecar_still_exists() {
    let root = TestRoot::new("idempotent-sidecar-present");
    profiles::ensure_profiles_index_at(root.path()).unwrap();
    let todo_directory = root.path().join("external-todos");
    let content = raw_document_with_todo_sidecar("marker-a", &todo_directory);

    let first = projects::save_projects_for_profile_at(
        root.path().to_path_buf(),
        "default".to_string(),
        content.clone(),
        "missing".to_string(),
    )
    .await
    .unwrap();
    assert!(todo_directory.join("todos.jsonc").is_file());

    // Retry the exact same request (e.g. a client that resent after a lost
    // response) with the sidecar still present — unlike a sidecar-loss
    // scenario, the merge step here always runs — and the same stale
    // `expectedRevision` from before the first attempt was acknowledged.
    let retry = projects::save_projects_for_profile_at(
        root.path().to_path_buf(),
        "default".to_string(),
        content,
        "missing".to_string(),
    )
    .await
    .unwrap();

    assert_eq!(retry.revision, first.revision);
    assert!(todo_directory.join("todos.jsonc").is_file());

    // A real conflict (different content, still a stale `expectedRevision`)
    // must still be rejected, with the original preserved and a recovery
    // copy created — canonicalization must never mask a genuine conflict.
    let other_content = raw_document_with_todo_sidecar("marker-b", &todo_directory);
    let conflict = projects::save_projects_for_profile_at(
        root.path().to_path_buf(),
        "default".to_string(),
        other_content,
        "missing".to_string(),
    )
    .await
    .unwrap_err();
    assert!(conflict.starts_with(projects::PROJECTS_REVISION_CONFLICT));
}

#[tokio::test]
async fn idempotent_retry_recreates_the_external_todo_sidecar() {
    let root = TestRoot::new("idempotent-sidecar");
    profiles::ensure_profiles_index_at(root.path()).unwrap();
    let todo_directory = root.path().join("external-todos");
    let sidecar = todo_directory.join("todos.jsonc");
    let content = serde_json::json!({
        "version": 6,
        "projects": [],
        "todos": [{ "id": "todo-1", "text": "Persist me" }],
        "preferences": { "todoStoragePath": todo_directory }
    })
    .to_string();

    projects::save_projects_for_profile_at(
        root.path().to_path_buf(),
        "default".to_string(),
        content.clone(),
        "missing".to_string(),
    )
    .await
    .unwrap();
    assert!(sidecar.is_file());
    fs::remove_file(&sidecar).unwrap();

    let retry = projects::save_projects_for_profile_at(
        root.path().to_path_buf(),
        "default".to_string(),
        content,
        "missing".to_string(),
    )
    .await
    .unwrap();

    assert!(sidecar.is_file());
    let bootstrap = projects::load_projects_bootstrap_at(root.path()).unwrap();
    assert_eq!(retry.revision, bootstrap.revision);
}

#[tokio::test]
async fn invalid_payload_is_rejected_before_write_or_recovery() {
    let root = TestRoot::new("invalid-payload");
    profiles::ensure_profiles_index_at(root.path()).unwrap();
    let initial = projects::save_projects_for_profile_at(
        root.path().to_path_buf(),
        "default".to_string(),
        document("valid"),
        "missing".to_string(),
    )
    .await
    .unwrap();

    let error = projects::save_projects_for_profile_at(
        root.path().to_path_buf(),
        "default".to_string(),
        "{not-json".to_string(),
        initial.revision,
    )
    .await
    .unwrap_err();
    assert!(error.contains("projects content contains invalid JSON"));

    let bootstrap = projects::load_projects_bootstrap_at(root.path()).unwrap();
    assert!(bootstrap.content.unwrap().contains("valid"));
    assert!(!root
        .path()
        .join("profiles")
        .join("default")
        .join("conflicts")
        .exists());
}

#[tokio::test]
async fn repeated_conflicts_use_unique_recovery_names() {
    let root = TestRoot::new("recovery-names");
    profiles::ensure_profiles_index_at(root.path()).unwrap();
    projects::save_projects_for_profile_at(
        root.path().to_path_buf(),
        "default".to_string(),
        document("winner"),
        "missing".to_string(),
    )
    .await
    .unwrap();

    for marker in ["stale-one", "stale-two"] {
        let error = projects::save_projects_for_profile_at(
            root.path().to_path_buf(),
            "default".to_string(),
            document(marker),
            "missing".to_string(),
        )
        .await
        .unwrap_err();
        assert!(error.starts_with(projects::PROJECTS_REVISION_CONFLICT));
    }

    let conflicts = fs::read_dir(
        root.path()
            .join("profiles")
            .join("default")
            .join("conflicts"),
    )
    .unwrap()
    .collect::<Result<Vec<_>, _>>()
    .unwrap();
    assert_eq!(conflicts.len(), 2);
    assert_ne!(conflicts[0].file_name(), conflicts[1].file_name());
}

#[test]
fn data_root_identity_is_stable_for_equivalent_paths_and_distinct_for_other_roots() {
    let first = TestRoot::new("identity-a");
    let second = TestRoot::new("identity-b");

    assert_eq!(
        profiles::data_root_fingerprint(first.path()),
        profiles::data_root_fingerprint(&first.path().join("."))
    );
    assert_ne!(
        profiles::data_root_fingerprint(first.path()),
        profiles::data_root_fingerprint(second.path())
    );
}
