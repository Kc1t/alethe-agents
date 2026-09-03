//! Collaboration tasks (Phase 8) — deliberately a separate domain from the local agent scheduler
//! in `scheduler.rs`. Collaboration tasks are human-authored, project-scoped, and optionally
//! restricted to named members; the local scheduler tracks agent work items and has its own
//! store (`sched.tasks`), its own ID scheme, and no relationship to this module. Collaboration
//! task IDs use the `ctask_` prefix specifically so the two can never collide even if someone
//! later merges their persistence.

use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

const TASKS_SCHEMA_VERSION: u32 = 1;
/// Bound on retained operation-log entries per project (oldest dropped beyond this — a local
/// audit trail, not the tasks themselves, which are tracked in `tasks` directly).
pub const MAX_OP_LOG_ENTRIES: usize = 10_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskVisibility {
    Public,
    Restricted,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Open,
    InProgress,
    Completed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskComment {
    pub author_device_id: String,
    pub body: String,
    pub created_at_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskRecord {
    pub task_id: String,
    pub project_id: String,
    pub revision: u64,
    pub visibility: TaskVisibility,
    /// Account routes (see ADR-0004) allowed to see this task when `visibility` is `Restricted`.
    /// Ignored for `Public` tasks.
    pub restricted_members: Vec<String>,
    pub title: String,
    pub body: String,
    pub author_device_id: String,
    pub assignees: Vec<String>,
    pub labels: Vec<String>,
    pub due_at_ms: Option<u64>,
    pub status: TaskStatus,
    pub comments: Vec<TaskComment>,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
    pub tombstoned: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "type")]
pub enum TaskOperationKind {
    Create,
    Update,
    Assign,
    Complete,
    Reopen,
    Comment,
    Delete,
    Restore,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskOperation {
    pub sequence: u64,
    pub task_id: String,
    pub kind: TaskOperationKind,
    pub base_revision: Option<u64>,
    pub author_device_id: String,
    pub applied_at_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskProjectDocument {
    schema_version: u32,
    project_id: String,
    tasks: Vec<TaskRecord>,
    op_log: Vec<TaskOperation>,
    next_sequence: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TaskError {
    NotAuthorized,
    /// Returned both when a task ID genuinely does not exist *and* when it exists but the
    /// viewer is not a member of a restricted task — the two cases are indistinguishable from
    /// the outside on purpose, so a restricted task's existence never leaks through a distinct
    /// error.
    NotFound,
    Conflict,
    InvalidInput,
    Io,
}

impl std::fmt::Display for TaskError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let code = match self {
            TaskError::NotAuthorized => "task_not_authorized",
            TaskError::NotFound => "task_not_found",
            TaskError::Conflict => "task_conflict",
            TaskError::InvalidInput => "task_invalid_input",
            TaskError::Io => "task_io_error",
        };
        write!(f, "{code}")
    }
}

/// Authorizes whether a device may act on tasks for a project at all (equivalent to "is a
/// project member"). Visibility filtering for *restricted* tasks is separate and stricter —
/// project membership alone does not imply restricted-task membership.
pub trait ProjectMembershipAuthorizer {
    fn is_project_member(&self, device_id: &str) -> Result<(), TaskError>;
}

fn tasks_document_path(data_root: &Path, project_id: &str) -> PathBuf {
    data_root.join("sync").join("tasks").join(format!("{project_id}.json"))
}

fn load_at(data_root: &Path, project_id: &str) -> Result<TaskProjectDocument, TaskError> {
    let path = tasks_document_path(data_root, project_id);
    if !path.exists() {
        return Ok(TaskProjectDocument {
            schema_version: TASKS_SCHEMA_VERSION,
            project_id: project_id.to_string(),
            tasks: Vec::new(),
            op_log: Vec::new(),
            next_sequence: 1,
        });
    }
    let bytes = fs::read(&path).map_err(|_| TaskError::Io)?;
    let document: TaskProjectDocument = serde_json::from_slice(&bytes).map_err(|_| TaskError::Io)?;
    if document.schema_version != TASKS_SCHEMA_VERSION {
        return Err(TaskError::Io);
    }
    Ok(document)
}

#[cfg(windows)]
fn replace_file(source: &Path, destination: &Path) -> Result<(), TaskError> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination.as_os_str().encode_wide().chain(Some(0)).collect();
    let result =
        unsafe { MoveFileExW(source.as_ptr(), destination.as_ptr(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) };
    if result == 0 {
        Err(TaskError::Io)
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn replace_file(source: &Path, destination: &Path) -> Result<(), TaskError> {
    fs::rename(source, destination).map_err(|_| TaskError::Io)
}

fn save_at(data_root: &Path, document: &TaskProjectDocument) -> Result<(), TaskError> {
    let path = tasks_document_path(data_root, &document.project_id);
    let parent = path.parent().ok_or(TaskError::Io)?;
    fs::create_dir_all(parent).map_err(|_| TaskError::Io)?;
    let temporary = parent.join(format!(".tasks-{}.tmp", nanoid::nanoid!(12)));
    let bytes = serde_json::to_vec_pretty(document).map_err(|_| TaskError::Io)?;
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)
        .map_err(|_| TaskError::Io)?;
    if file.write_all(&bytes).and_then(|_| file.sync_all()).is_err() {
        crate::best_effort!(fs::remove_file(&temporary), "temp_file_already_gone");
        return Err(TaskError::Io);
    }
    replace_file(&temporary, &path).map_err(|error| {
        crate::best_effort!(fs::remove_file(&temporary), "temp_file_already_gone");
        error
    })
}

fn push_op_log(document: &mut TaskProjectDocument, operation: TaskOperation) {
    document.op_log.push(operation);
    if document.op_log.len() > MAX_OP_LOG_ENTRIES {
        let overflow = document.op_log.len() - MAX_OP_LOG_ENTRIES;
        document.op_log.drain(0..overflow);
    }
}

fn next_sequence(document: &mut TaskProjectDocument) -> u64 {
    let sequence = document.next_sequence;
    document.next_sequence += 1;
    sequence
}

/// Whether `viewer_device_id`/`viewer_account_route` may see this specific task. `Public` tasks
/// are visible to any project member (already checked by the caller). `Restricted` tasks are
/// visible only to an explicitly listed member.
fn is_visible_to(task: &TaskRecord, viewer_account_route: &str) -> bool {
    match task.visibility {
        TaskVisibility::Public => true,
        TaskVisibility::Restricted => task.restricted_members.iter().any(|member| member == viewer_account_route),
    }
}

#[allow(clippy::too_many_arguments)]
pub fn create_task_at(
    data_root: &Path,
    project_id: &str,
    author_device_id: &str,
    title: &str,
    body: &str,
    visibility: TaskVisibility,
    restricted_members: Vec<String>,
    authorizer: &dyn ProjectMembershipAuthorizer,
    now_ms: u64,
) -> Result<TaskRecord, TaskError> {
    if title.trim().is_empty() {
        return Err(TaskError::InvalidInput);
    }
    authorizer.is_project_member(author_device_id)?;
    let mut document = load_at(data_root, project_id)?;
    let sequence = next_sequence(&mut document);
    let task = TaskRecord {
        task_id: format!("ctask_{}", nanoid::nanoid!(24)),
        project_id: project_id.to_string(),
        revision: sequence,
        visibility,
        restricted_members,
        title: title.to_string(),
        body: body.to_string(),
        author_device_id: author_device_id.to_string(),
        assignees: Vec::new(),
        labels: Vec::new(),
        due_at_ms: None,
        status: TaskStatus::Open,
        comments: Vec::new(),
        created_at_ms: now_ms,
        updated_at_ms: now_ms,
        tombstoned: false,
    };
    document.tasks.push(task.clone());
    push_op_log(
        &mut document,
        TaskOperation {
            sequence,
            task_id: task.task_id.clone(),
            kind: TaskOperationKind::Create,
            base_revision: None,
            author_device_id: author_device_id.to_string(),
            applied_at_ms: now_ms,
        },
    );
    save_at(data_root, &document)?;
    Ok(task)
}

/// Lists tasks visible to `viewer_account_route`: all public, non-tombstoned tasks plus any
/// restricted task the viewer is explicitly a member of. A restricted task the viewer cannot see
/// is simply absent from the list — never present with content redacted, which would itself leak
/// its existence.
pub fn list_visible_tasks_at(
    data_root: &Path,
    project_id: &str,
    viewer_device_id: &str,
    viewer_account_route: &str,
    authorizer: &dyn ProjectMembershipAuthorizer,
) -> Result<Vec<TaskRecord>, TaskError> {
    authorizer.is_project_member(viewer_device_id)?;
    let document = load_at(data_root, project_id)?;
    Ok(document
        .tasks
        .into_iter()
        .filter(|task| !task.tombstoned && is_visible_to(task, viewer_account_route))
        .collect())
}

/// Fetches one task. Returns `NotFound` uniformly for a genuinely unknown task ID *and* for a
/// restricted task the viewer cannot see — proven identical by
/// `restricted_task_is_indistinguishable_from_a_nonexistent_one`.
pub fn get_task_at(
    data_root: &Path,
    project_id: &str,
    task_id: &str,
    viewer_device_id: &str,
    viewer_account_route: &str,
    authorizer: &dyn ProjectMembershipAuthorizer,
) -> Result<TaskRecord, TaskError> {
    authorizer.is_project_member(viewer_device_id)?;
    let document = load_at(data_root, project_id)?;
    let task = document
        .tasks
        .into_iter()
        .find(|task| task.task_id == task_id && !task.tombstoned)
        .ok_or(TaskError::NotFound)?;
    if !is_visible_to(&task, viewer_account_route) {
        return Err(TaskError::NotFound);
    }
    Ok(task)
}

fn mutate_task<F>(
    data_root: &Path,
    project_id: &str,
    task_id: &str,
    device_id: &str,
    expected_base_revision: u64,
    authorizer: &dyn ProjectMembershipAuthorizer,
    kind: TaskOperationKind,
    now_ms: u64,
    mutator: F,
) -> Result<TaskRecord, TaskError>
where
    F: FnOnce(&mut TaskRecord),
{
    authorizer.is_project_member(device_id)?;
    let mut document = load_at(data_root, project_id)?;
    let sequence = next_sequence(&mut document);
    let task = document
        .tasks
        .iter_mut()
        .find(|task| task.task_id == task_id)
        .ok_or(TaskError::NotFound)?;
    // A stale caller-supplied base revision is a deterministic conflict, not a silent overwrite:
    // the caller must re-fetch the current task and retry with the fresh revision.
    if task.revision != expected_base_revision {
        return Err(TaskError::Conflict);
    }
    mutator(task);
    task.revision = sequence;
    task.updated_at_ms = now_ms;
    let updated = task.clone();
    push_op_log(
        &mut document,
        TaskOperation {
            sequence,
            task_id: task_id.to_string(),
            kind,
            base_revision: Some(expected_base_revision),
            author_device_id: device_id.to_string(),
            applied_at_ms: now_ms,
        },
    );
    save_at(data_root, &document)?;
    Ok(updated)
}

pub fn update_task_at(
    data_root: &Path,
    project_id: &str,
    task_id: &str,
    device_id: &str,
    expected_base_revision: u64,
    title: Option<String>,
    body: Option<String>,
    labels: Option<Vec<String>>,
    due_at_ms: Option<Option<u64>>,
    authorizer: &dyn ProjectMembershipAuthorizer,
    now_ms: u64,
) -> Result<TaskRecord, TaskError> {
    mutate_task(
        data_root,
        project_id,
        task_id,
        device_id,
        expected_base_revision,
        authorizer,
        TaskOperationKind::Update,
        now_ms,
        |task| {
            if let Some(title) = title {
                task.title = title;
            }
            if let Some(body) = body {
                task.body = body;
            }
            if let Some(labels) = labels {
                task.labels = labels;
            }
            if let Some(due_at_ms) = due_at_ms {
                task.due_at_ms = due_at_ms;
            }
        },
    )
}

pub fn assign_task_at(
    data_root: &Path,
    project_id: &str,
    task_id: &str,
    device_id: &str,
    expected_base_revision: u64,
    assignees: Vec<String>,
    authorizer: &dyn ProjectMembershipAuthorizer,
    now_ms: u64,
) -> Result<TaskRecord, TaskError> {
    let result = mutate_task(
        data_root,
        project_id,
        task_id,
        device_id,
        expected_base_revision,
        authorizer,
        TaskOperationKind::Assign,
        now_ms,
        |task| task.assignees = assignees,
    );
    if result.is_ok() {
        crate::sync_access::record_or_report_at(
            data_root,
            crate::sync_access::AccessCategory::Collaboration,
            crate::sync_access::AccessKind::TaskAssigned,
            task_id,
            now_ms,
        );
    }
    result
}

pub fn complete_task_at(
    data_root: &Path,
    project_id: &str,
    task_id: &str,
    device_id: &str,
    expected_base_revision: u64,
    authorizer: &dyn ProjectMembershipAuthorizer,
    now_ms: u64,
) -> Result<TaskRecord, TaskError> {
    mutate_task(
        data_root,
        project_id,
        task_id,
        device_id,
        expected_base_revision,
        authorizer,
        TaskOperationKind::Complete,
        now_ms,
        |task| task.status = TaskStatus::Completed,
    )
}

pub fn reopen_task_at(
    data_root: &Path,
    project_id: &str,
    task_id: &str,
    device_id: &str,
    expected_base_revision: u64,
    authorizer: &dyn ProjectMembershipAuthorizer,
    now_ms: u64,
) -> Result<TaskRecord, TaskError> {
    mutate_task(
        data_root,
        project_id,
        task_id,
        device_id,
        expected_base_revision,
        authorizer,
        TaskOperationKind::Reopen,
        now_ms,
        |task| task.status = TaskStatus::Open,
    )
}

pub fn add_comment_at(
    data_root: &Path,
    project_id: &str,
    task_id: &str,
    device_id: &str,
    expected_base_revision: u64,
    body: &str,
    authorizer: &dyn ProjectMembershipAuthorizer,
    now_ms: u64,
) -> Result<TaskRecord, TaskError> {
    if body.trim().is_empty() {
        return Err(TaskError::InvalidInput);
    }
    let body = body.to_string();
    mutate_task(
        data_root,
        project_id,
        task_id,
        device_id,
        expected_base_revision,
        authorizer,
        TaskOperationKind::Comment,
        now_ms,
        |task| {
            task.comments.push(TaskComment {
                author_device_id: device_id.to_string(),
                body,
                created_at_ms: now_ms,
            });
        },
    )
}

pub fn delete_task_at(
    data_root: &Path,
    project_id: &str,
    task_id: &str,
    device_id: &str,
    expected_base_revision: u64,
    authorizer: &dyn ProjectMembershipAuthorizer,
    now_ms: u64,
) -> Result<TaskRecord, TaskError> {
    mutate_task(
        data_root,
        project_id,
        task_id,
        device_id,
        expected_base_revision,
        authorizer,
        TaskOperationKind::Delete,
        now_ms,
        |task| task.tombstoned = true,
    )
}

pub fn restore_task_at(
    data_root: &Path,
    project_id: &str,
    task_id: &str,
    device_id: &str,
    expected_base_revision: u64,
    authorizer: &dyn ProjectMembershipAuthorizer,
    now_ms: u64,
) -> Result<TaskRecord, TaskError> {
    mutate_task(
        data_root,
        project_id,
        task_id,
        device_id,
        expected_base_revision,
        authorizer,
        TaskOperationKind::Restore,
        now_ms,
        |task| task.tombstoned = false,
    )
}

/// Production `ProjectMembershipAuthorizer`: a device is a project member only while it is
/// `Trusted` for the currently verified account, rechecked fresh on every call.
pub struct SecurityBackedMembership<'a> {
    pub data_root: &'a Path,
}

impl ProjectMembershipAuthorizer for SecurityBackedMembership<'_> {
    fn is_project_member(&self, device_id: &str) -> Result<(), TaskError> {
        let document = crate::sync_security::load_at(self.data_root).map_err(|_| TaskError::Io)?;
        let is_trusted = document
            .devices
            .iter()
            .any(|device| device.device_id == device_id && device.trust == crate::sync_security::DeviceTrust::Trusted);
        if is_trusted {
            Ok(())
        } else {
            Err(TaskError::NotAuthorized)
        }
    }
}

#[tauri::command]
pub fn sync_create_task(
    app: tauri::AppHandle,
    project_id: String,
    device_id: String,
    title: String,
    body: String,
    visibility: TaskVisibility,
    restricted_members: Vec<String>,
) -> Result<TaskRecord, String> {
    let data_root = crate::profiles::resolve_tauri_data_root(&app)?;
    let authorizer = SecurityBackedMembership { data_root: &data_root };
    create_task_at(
        &data_root, &project_id, &device_id, &title, &body, visibility, restricted_members, &authorizer,
        crate::provider_common::now_ms(),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sync_list_visible_tasks(
    app: tauri::AppHandle,
    project_id: String,
    viewer_device_id: String,
    viewer_account_route: String,
) -> Result<Vec<TaskRecord>, String> {
    let data_root = crate::profiles::resolve_tauri_data_root(&app)?;
    let authorizer = SecurityBackedMembership { data_root: &data_root };
    list_visible_tasks_at(&data_root, &project_id, &viewer_device_id, &viewer_account_route, &authorizer)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sync_get_task(
    app: tauri::AppHandle,
    project_id: String,
    task_id: String,
    viewer_device_id: String,
    viewer_account_route: String,
) -> Result<TaskRecord, String> {
    let data_root = crate::profiles::resolve_tauri_data_root(&app)?;
    let authorizer = SecurityBackedMembership { data_root: &data_root };
    get_task_at(&data_root, &project_id, &task_id, &viewer_device_id, &viewer_account_route, &authorizer)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sync_complete_task(
    app: tauri::AppHandle,
    project_id: String,
    task_id: String,
    device_id: String,
    expected_base_revision: u64,
) -> Result<TaskRecord, String> {
    let data_root = crate::profiles::resolve_tauri_data_root(&app)?;
    let authorizer = SecurityBackedMembership { data_root: &data_root };
    complete_task_at(
        &data_root, &project_id, &task_id, &device_id, expected_base_revision, &authorizer,
        crate::provider_common::now_ms(),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sync_reopen_task(
    app: tauri::AppHandle,
    project_id: String,
    task_id: String,
    device_id: String,
    expected_base_revision: u64,
) -> Result<TaskRecord, String> {
    let data_root = crate::profiles::resolve_tauri_data_root(&app)?;
    let authorizer = SecurityBackedMembership { data_root: &data_root };
    reopen_task_at(
        &data_root, &project_id, &task_id, &device_id, expected_base_revision, &authorizer,
        crate::provider_common::now_ms(),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sync_add_task_comment(
    app: tauri::AppHandle,
    project_id: String,
    task_id: String,
    device_id: String,
    expected_base_revision: u64,
    body: String,
) -> Result<TaskRecord, String> {
    let data_root = crate::profiles::resolve_tauri_data_root(&app)?;
    let authorizer = SecurityBackedMembership { data_root: &data_root };
    add_comment_at(
        &data_root, &project_id, &task_id, &device_id, expected_base_revision, &body, &authorizer,
        crate::provider_common::now_ms(),
    )
    .map_err(|e| e.to_string())
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn sync_update_task(
    app: tauri::AppHandle,
    project_id: String,
    task_id: String,
    device_id: String,
    expected_base_revision: u64,
    title: Option<String>,
    body: Option<String>,
    labels: Option<Vec<String>>,
    due_at_ms: Option<Option<u64>>,
) -> Result<TaskRecord, String> {
    let data_root = crate::profiles::resolve_tauri_data_root(&app)?;
    let authorizer = SecurityBackedMembership { data_root: &data_root };
    update_task_at(
        &data_root,
        &project_id,
        &task_id,
        &device_id,
        expected_base_revision,
        title,
        body,
        labels,
        due_at_ms,
        &authorizer,
        crate::provider_common::now_ms(),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sync_assign_task(
    app: tauri::AppHandle,
    project_id: String,
    task_id: String,
    device_id: String,
    expected_base_revision: u64,
    assignees: Vec<String>,
) -> Result<TaskRecord, String> {
    let data_root = crate::profiles::resolve_tauri_data_root(&app)?;
    let authorizer = SecurityBackedMembership { data_root: &data_root };
    assign_task_at(
        &data_root,
        &project_id,
        &task_id,
        &device_id,
        expected_base_revision,
        assignees,
        &authorizer,
        crate::provider_common::now_ms(),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sync_delete_task(
    app: tauri::AppHandle,
    project_id: String,
    task_id: String,
    device_id: String,
    expected_base_revision: u64,
) -> Result<TaskRecord, String> {
    let data_root = crate::profiles::resolve_tauri_data_root(&app)?;
    let authorizer = SecurityBackedMembership { data_root: &data_root };
    delete_task_at(&data_root, &project_id, &task_id, &device_id, expected_base_revision, &authorizer, crate::provider_common::now_ms())
        .map_err(|e| e.to_string())
}

/// Permanently deletes the tasks document for a project. Returns Ok(()) even if the document
/// did not exist.
pub fn delete_project_tasks_at(data_root: &Path, project_id: &str) -> Result<(), std::io::Error> {
    let path = tasks_document_path(data_root, project_id);
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

#[tauri::command]
pub fn sync_delete_project_tasks(
    app: tauri::AppHandle,
    project_id: String,
) -> Result<(), String> {
    let data_root = crate::profiles::resolve_tauri_data_root(&app)?;
    delete_project_tasks_at(&data_root, &project_id).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct AllowAll;
    impl ProjectMembershipAuthorizer for AllowAll {
        fn is_project_member(&self, _device_id: &str) -> Result<(), TaskError> {
            Ok(())
        }
    }
    struct DenyAll;
    impl ProjectMembershipAuthorizer for DenyAll {
        fn is_project_member(&self, _device_id: &str) -> Result<(), TaskError> {
            Err(TaskError::NotAuthorized)
        }
    }

    fn temp_root(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("alethe-tasks-{name}-{}", nanoid::nanoid!(8)));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn creating_and_completing_a_public_task_is_visible_to_any_member() {
        let root = temp_root("public");
        let task = create_task_at(
            &root, "project-a", "dev-a", "Fix the bug", "details", TaskVisibility::Public, vec![],
            &AllowAll, 1_000,
        )
        .unwrap();
        assert_eq!(task.status, TaskStatus::Open);

        let visible = list_visible_tasks_at(&root, "project-a", "dev-b", "route-b", &AllowAll).unwrap();
        assert_eq!(visible.len(), 1);

        let completed = complete_task_at(&root, "project-a", &task.task_id, "dev-b", task.revision, &AllowAll, 2_000)
            .unwrap();
        assert_eq!(completed.status, TaskStatus::Completed);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn assigning_a_task_publishes_an_access_center_record() {
        let root = temp_root("assign");
        let task = create_task_at(
            &root, "project-a", "dev-a", "Fix the bug", "details", TaskVisibility::Public, vec![],
            &AllowAll, 1_000,
        )
        .unwrap();
        assert!(crate::sync_access::list_at(&root, 1_000).unwrap().is_empty());

        assign_task_at(
            &root, "project-a", &task.task_id, "dev-a", task.revision, vec!["route-b".to_string()],
            &AllowAll, 2_000,
        )
        .unwrap();

        let records = crate::sync_access::list_at(&root, 2_000).unwrap();
        let record = records
            .iter()
            .find(|record| record.kind == crate::sync_access::AccessKind::TaskAssigned)
            .unwrap();
        assert_eq!(record.category, crate::sync_access::AccessCategory::Collaboration);
        assert_eq!(record.subject_handle, task.task_id);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn restricted_task_is_invisible_to_non_members_in_lists_and_direct_lookup() {
        let root = temp_root("restricted");
        let task = create_task_at(
            &root, "project-a", "dev-a", "Confidential", "sensitive", TaskVisibility::Restricted,
            vec!["route-owner".to_string()], &AllowAll, 1_000,
        )
        .unwrap();

        let visible_to_member =
            list_visible_tasks_at(&root, "project-a", "dev-a", "route-owner", &AllowAll).unwrap();
        assert_eq!(visible_to_member.len(), 1);

        let visible_to_outsider =
            list_visible_tasks_at(&root, "project-a", "dev-b", "route-outsider", &AllowAll).unwrap();
        assert!(visible_to_outsider.is_empty());

        let lookup_by_outsider =
            get_task_at(&root, "project-a", &task.task_id, "dev-b", "route-outsider", &AllowAll);
        assert_eq!(lookup_by_outsider.unwrap_err(), TaskError::NotFound);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn restricted_task_is_indistinguishable_from_a_nonexistent_one() {
        let root = temp_root("indistinguishable");
        let task = create_task_at(
            &root, "project-a", "dev-a", "Confidential", "sensitive", TaskVisibility::Restricted,
            vec!["route-owner".to_string()], &AllowAll, 1_000,
        )
        .unwrap();

        let real_restricted_result =
            get_task_at(&root, "project-a", &task.task_id, "dev-b", "route-outsider", &AllowAll);
        let nonexistent_result =
            get_task_at(&root, "project-a", "ctask_does_not_exist", "dev-b", "route-outsider", &AllowAll);
        assert_eq!(real_restricted_result.unwrap_err(), nonexistent_result.unwrap_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn non_project_members_cannot_create_list_or_read_tasks() {
        let root = temp_root("not-a-member");
        assert_eq!(
            create_task_at(&root, "project-a", "dev-a", "t", "b", TaskVisibility::Public, vec![], &DenyAll, 1_000)
                .unwrap_err(),
            TaskError::NotAuthorized
        );
        assert_eq!(
            list_visible_tasks_at(&root, "project-a", "dev-a", "route-a", &DenyAll).unwrap_err(),
            TaskError::NotAuthorized
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn stale_base_revision_is_a_deterministic_conflict_not_a_silent_overwrite() {
        let root = temp_root("conflict");
        let task = create_task_at(
            &root, "project-a", "dev-a", "Title", "body", TaskVisibility::Public, vec![], &AllowAll, 1_000,
        )
        .unwrap();

        // Two offline devices both start from the same revision and both try to mutate.
        let first_update = update_task_at(
            &root, "project-a", &task.task_id, "dev-a", task.revision, Some("Updated by A".to_string()),
            None, None, None, &AllowAll, 2_000,
        )
        .unwrap();
        assert_eq!(first_update.title, "Updated by A");

        // The second device's operation still assumes the *original* revision — it must not
        // silently overwrite what device A already committed.
        let second_update = update_task_at(
            &root, "project-a", &task.task_id, "dev-b", task.revision, Some("Updated by B".to_string()),
            None, None, None, &AllowAll, 3_000,
        );
        assert_eq!(second_update.unwrap_err(), TaskError::Conflict);

        let current = get_task_at(&root, "project-a", &task.task_id, "dev-a", "route-a", &AllowAll).unwrap();
        assert_eq!(current.title, "Updated by A");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn comments_accumulate_and_delete_restore_round_trips() {
        let root = temp_root("comments-delete");
        let task = create_task_at(
            &root, "project-a", "dev-a", "Title", "body", TaskVisibility::Public, vec![], &AllowAll, 1_000,
        )
        .unwrap();
        let commented = add_comment_at(
            &root, "project-a", &task.task_id, "dev-b", task.revision, "looks good", &AllowAll, 2_000,
        )
        .unwrap();
        assert_eq!(commented.comments.len(), 1);
        assert_eq!(commented.comments[0].body, "looks good");

        let deleted = delete_task_at(&root, "project-a", &task.task_id, "dev-a", commented.revision, &AllowAll, 3_000)
            .unwrap();
        assert!(deleted.tombstoned);
        assert!(list_visible_tasks_at(&root, "project-a", "dev-a", "route-a", &AllowAll).unwrap().is_empty());
        assert_eq!(
            get_task_at(&root, "project-a", &task.task_id, "dev-a", "route-a", &AllowAll).unwrap_err(),
            TaskError::NotFound
        );

        let restored = restore_task_at(&root, "project-a", &task.task_id, "dev-a", deleted.revision, &AllowAll, 4_000)
            .unwrap();
        assert!(!restored.tombstoned);
        assert_eq!(list_visible_tasks_at(&root, "project-a", "dev-a", "route-a", &AllowAll).unwrap().len(), 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn task_ids_never_collide_with_the_local_agent_scheduler_prefix() {
        let root = temp_root("prefix");
        let task = create_task_at(
            &root, "project-a", "dev-a", "Title", "body", TaskVisibility::Public, vec![], &AllowAll, 1_000,
        )
        .unwrap();
        assert!(task.task_id.starts_with("ctask_"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn op_log_stays_bounded() {
        let mut document = TaskProjectDocument {
            schema_version: TASKS_SCHEMA_VERSION,
            project_id: "p".to_string(),
            tasks: Vec::new(),
            op_log: Vec::new(),
            next_sequence: 1,
        };
        for i in 0..(MAX_OP_LOG_ENTRIES + 50) {
            push_op_log(
                &mut document,
                TaskOperation {
                    sequence: i as u64,
                    task_id: format!("ctask_{i}"),
                    kind: TaskOperationKind::Create,
                    base_revision: None,
                    author_device_id: "dev-a".to_string(),
                    applied_at_ms: 1_000 + i as u64,
                },
            );
        }
        assert_eq!(document.op_log.len(), MAX_OP_LOG_ENTRIES);
    }

    #[test]
    fn delete_project_tasks_removes_file() {
        let root = temp_root("delete-tasks");
        let path = tasks_document_path(&root, "proj-to-delete");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, b"{}").unwrap();
        assert!(path.exists());

        delete_project_tasks_at(&root, "proj-to-delete").unwrap();
        assert!(!path.exists());
        assert!(delete_project_tasks_at(&root, "proj-to-delete").is_ok());
        fs::remove_dir_all(root).unwrap();
    }
}
