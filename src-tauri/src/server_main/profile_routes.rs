use axum::extract::Extension;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use super::{AppError, ServerRuntime};

pub fn active_profile_dir_at(root: &Path) -> Result<PathBuf, String> {
    crate::profiles::active_profile_dir_at(root)
}

pub fn profile_dir_validated_at(root: &Path, profile_id: &str) -> Result<PathBuf, String> {
    crate::profiles::profile_data_dir_for_id_at(root, profile_id)
}

pub fn router() -> Router {
    Router::new()
        .route("/api/profiles/list", get(list))
        .route("/api/profiles/summaries", get(summaries))
        .route("/api/profiles/active", get(active))
        .route("/api/profiles/set_active", post(set_active))
        .route("/api/profiles/create", post(create))
        .route("/api/profiles/rename", post(rename))
        .route("/api/profiles/delete", post(delete))
        .route("/api/projects", get(load_projects))
        .route("/api/projects/load", get(load_projects))
        .route("/api/projects/bootstrap", get(load_projects_bootstrap))
        .route("/api/projects/save", post(save_projects))
        .route(
            "/api/projects/save_for_profile",
            post(save_projects_for_profile),
        )
}

fn app_error(error: String) -> AppError {
    let status = if error.starts_with(crate::projects::PROJECTS_REVISION_CONFLICT) {
        StatusCode::CONFLICT
    } else if error.contains("profile not found") {
        StatusCode::NOT_FOUND
    } else if error == "profile_name_exists"
        || error.contains("last local profile")
        || error.contains("projects content contains invalid JSON")
    {
        StatusCode::BAD_REQUEST
    } else {
        StatusCode::INTERNAL_SERVER_ERROR
    };
    AppError(status, error)
}

fn respond<T: serde::Serialize>(result: Result<T, String>) -> Response {
    match result {
        Ok(value) => Json(value).into_response(),
        Err(error) => app_error(error).into_response(),
    }
}

fn publish_sync(
    runtime: &ServerRuntime,
    reason: &'static str,
    changed_profile_id: Option<String>,
    changed_projects_revision: Option<String>,
) {
    if let Err(error) =
        runtime.publish_sync_event(reason, changed_profile_id, changed_projects_revision)
    {
        eprintln!("[core-events] Failed to publish {reason}: {error}");
    }
}

fn respond_profile_mutation(
    runtime: &ServerRuntime,
    result: Result<crate::profiles::ProfilesState, String>,
    reason: &'static str,
) -> Response {
    match result {
        Ok(state) => {
            publish_sync(runtime, reason, None, None);
            Json(state).into_response()
        }
        Err(error) => app_error(error).into_response(),
    }
}

async fn list(Extension(runtime): Extension<Arc<ServerRuntime>>) -> Response {
    respond(crate::profiles::list_profiles_state_at(runtime.data_root()))
}

async fn summaries(Extension(runtime): Extension<Arc<ServerRuntime>>) -> Response {
    respond(crate::profiles::list_profile_summaries_state_at(
        runtime.data_root(),
    ))
}

async fn active(Extension(runtime): Extension<Arc<ServerRuntime>>) -> Response {
    respond(crate::profiles::active_profile_state_at(
        runtime.data_root(),
    ))
}

#[derive(Deserialize)]
struct SetActiveBody {
    #[serde(rename = "profileId")]
    profile_id: String,
}

async fn set_active(
    Extension(runtime): Extension<Arc<ServerRuntime>>,
    Json(body): Json<SetActiveBody>,
) -> Response {
    respond_profile_mutation(
        &runtime,
        crate::profiles::set_active_profile_id_at(runtime.data_root(), &body.profile_id),
        "active_profile_changed",
    )
}

#[derive(Deserialize)]
struct CreateBody {
    name: Option<String>,
}

async fn create(
    Extension(runtime): Extension<Arc<ServerRuntime>>,
    Json(body): Json<CreateBody>,
) -> Response {
    respond_profile_mutation(
        &runtime,
        crate::profiles::create_profile_state_at(runtime.data_root(), body.name),
        "profile_created",
    )
}

#[derive(Deserialize)]
struct RenameBody {
    #[serde(rename = "profileId")]
    profile_id: String,
    name: String,
}

async fn rename(
    Extension(runtime): Extension<Arc<ServerRuntime>>,
    Json(body): Json<RenameBody>,
) -> Response {
    respond_profile_mutation(
        &runtime,
        crate::profiles::rename_profile_state_at(runtime.data_root(), &body.profile_id, body.name),
        "profile_renamed",
    )
}

#[derive(Deserialize)]
struct DeleteBody {
    #[serde(rename = "profileId")]
    profile_id: String,
}

async fn delete(
    Extension(runtime): Extension<Arc<ServerRuntime>>,
    Json(body): Json<DeleteBody>,
) -> Response {
    respond_profile_mutation(
        &runtime,
        crate::profiles::delete_profile_state_at(runtime.data_root(), &body.profile_id),
        "profile_deleted",
    )
}

async fn load_projects(Extension(runtime): Extension<Arc<ServerRuntime>>) -> Response {
    respond(crate::projects::load_projects_at(runtime.data_root()))
}

async fn load_projects_bootstrap(Extension(runtime): Extension<Arc<ServerRuntime>>) -> Response {
    respond(crate::projects::load_projects_bootstrap_at(
        runtime.data_root(),
    ))
}

#[derive(Deserialize)]
struct SaveProjectsBody {
    content: String,
    #[allow(dead_code)]
    sequence: Option<u64>,
}

async fn save_projects(
    Extension(runtime): Extension<Arc<ServerRuntime>>,
    Json(body): Json<SaveProjectsBody>,
) -> Response {
    let bootstrap = match crate::projects::load_projects_bootstrap_at(runtime.data_root()) {
        Ok(bootstrap) => bootstrap,
        Err(error) => return app_error(error).into_response(),
    };
    match crate::projects::save_projects_for_profile_at(
        runtime.data_root().to_path_buf(),
        bootstrap.active_profile_id,
        body.content,
        bootstrap.revision,
    )
    .await
    {
        Ok(result) => {
            publish_sync(
                &runtime,
                "projects_saved",
                Some(result.profile_id),
                Some(result.revision),
            );
            Json(json!({ "status": "saved" })).into_response()
        }
        Err(error) => app_error(error).into_response(),
    }
}

#[derive(Deserialize)]
struct SaveProjectsForProfileBody {
    #[serde(rename = "profileId")]
    profile_id: String,
    content: String,
    #[serde(rename = "expectedRevision")]
    expected_revision: String,
}

async fn save_projects_for_profile(
    Extension(runtime): Extension<Arc<ServerRuntime>>,
    Json(body): Json<SaveProjectsForProfileBody>,
) -> Response {
    match crate::projects::save_projects_for_profile_at(
        runtime.data_root().to_path_buf(),
        body.profile_id,
        body.content,
        body.expected_revision,
    )
    .await
    {
        Ok(result) => {
            publish_sync(
                &runtime,
                "projects_saved",
                Some(result.profile_id.clone()),
                Some(result.revision.clone()),
            );
            Json(result).into_response()
        }
        Err(error) => app_error(error).into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;
    use std::fs;

    struct TestRoot(PathBuf);

    impl TestRoot {
        fn new(label: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "alethe-profile-routes-{label}-{}-{}",
                std::process::id(),
                nanoid::nanoid!(8)
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn runtime(&self) -> Arc<ServerRuntime> {
            Arc::new(ServerRuntime::new(
                "test",
                "com.kc1t.alethe.dev".to_string(),
                self.0.clone(),
                Arc::new(crate::pty_sink::WebSocketSink),
                Arc::new(crate::sync_rendezvous::RendezvousRuntime::default()),
            ))
        }
    }

    impl Drop for TestRoot {
        fn drop(&mut self) {
            crate::best_effort!(fs::remove_dir_all(&self.0), "dir_already_absent");
        }
    }

    async fn response_json(response: Response) -> serde_json::Value {
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[test]
    fn runtime_identity_uses_the_canonical_root_fingerprint_without_leaking_its_path() {
        let root = TestRoot::new("identity");
        let runtime = root.runtime();
        let payload = super::super::runtime_payload(&runtime);

        assert_eq!(payload["appIdentifier"], "com.kc1t.alethe.dev");
        assert_eq!(
            payload["dataRootId"],
            crate::profiles::data_root_fingerprint(&root.0)
        );
        let root_display = root.0.to_string_lossy();
        assert!(!payload.to_string().contains(root_display.as_ref()));
    }

    #[tokio::test]
    async fn profile_http_crud_returns_the_same_typed_core_state() {
        let root = TestRoot::new("crud");
        let response = create(
            Extension(root.runtime()),
            Json(CreateBody {
                name: Some("Browser".to_string()),
            }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);

        let http_state = response_json(response).await;
        let core_state = crate::profiles::list_profiles_state_at(&root.0).unwrap();
        assert_eq!(http_state, serde_json::to_value(core_state).unwrap());
    }

    #[tokio::test]
    async fn project_http_save_reports_conflict_without_exposing_the_data_root() {
        let root = TestRoot::new("cas");
        crate::profiles::ensure_profiles_index_at(&root.0).unwrap();
        let initial =
            serde_json::json!({ "version": 6, "projects": [{ "id": "winner" }] }).to_string();
        let first = save_projects_for_profile(
            Extension(root.runtime()),
            Json(SaveProjectsForProfileBody {
                profile_id: "default".to_string(),
                content: initial,
                expected_revision: "missing".to_string(),
            }),
        )
        .await;
        assert_eq!(first.status(), StatusCode::OK);

        let stale = save_projects_for_profile(
            Extension(root.runtime()),
            Json(SaveProjectsForProfileBody {
                profile_id: "default".to_string(),
                content: serde_json::json!({
                    "version": 6,
                    "projects": [{ "id": "rejected" }]
                })
                .to_string(),
                expected_revision: "missing".to_string(),
            }),
        )
        .await;
        assert_eq!(stale.status(), StatusCode::CONFLICT);
        let body = to_bytes(stale.into_body(), usize::MAX).await.unwrap();
        let body = String::from_utf8(body.to_vec()).unwrap();
        let root_display = root.0.to_string_lossy();
        assert!(body.starts_with(crate::projects::PROJECTS_REVISION_CONFLICT));
        assert!(!body.contains(root_display.as_ref()));
    }

    #[tokio::test]
    async fn incoming_invalid_json_is_bad_request_but_corrupt_storage_is_server_error() {
        let invalid_payload_root = TestRoot::new("invalid-payload");
        crate::profiles::ensure_profiles_index_at(&invalid_payload_root.0).unwrap();
        let invalid_payload = save_projects_for_profile(
            Extension(invalid_payload_root.runtime()),
            Json(SaveProjectsForProfileBody {
                profile_id: "default".to_string(),
                content: "{not-json".to_string(),
                expected_revision: "missing".to_string(),
            }),
        )
        .await;
        assert_eq!(invalid_payload.status(), StatusCode::BAD_REQUEST);

        let corrupt_storage_root = TestRoot::new("corrupt-storage");
        crate::profiles::ensure_profiles_index_at(&corrupt_storage_root.0).unwrap();
        let projects_path = corrupt_storage_root
            .0
            .join("profiles")
            .join("default")
            .join("projects.json");
        fs::write(&projects_path, "{corrupt-storage").unwrap();
        let corrupt_storage = save_projects_for_profile(
            Extension(corrupt_storage_root.runtime()),
            Json(SaveProjectsForProfileBody {
                profile_id: "default".to_string(),
                content: serde_json::json!({ "version": 6, "projects": [] }).to_string(),
                expected_revision: "missing".to_string(),
            }),
        )
        .await;
        assert_eq!(corrupt_storage.status(), StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(
            fs::read_to_string(projects_path).unwrap(),
            "{corrupt-storage"
        );
    }
}
