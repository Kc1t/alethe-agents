use nanoid::nanoid;
use serde::{Deserialize, Serialize};
use std::collections::hash_map::DefaultHasher;
use std::collections::{HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::sync::{Mutex, OnceLock};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TaskStatus {
    Pending,
    Ready,
    Running,
    Completed,
    Failed,
    Blocked,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub dependencies: Vec<String>,
    pub status: TaskStatus,
    pub assigned_agent_id: Option<String>,
    pub lease_resource: Option<String>,

    /// checando o `.planning/` real dessa worktree (ver `run_scheduler_tick`).
    pub worktree_path: Option<String>,
    pub priority: i32,
}

pub struct Scheduler {
    pub tasks: HashMap<String, Task>,
    pub leases: HashSet<String>,
}

static SCHEDULER: OnceLock<Mutex<Scheduler>> = OnceLock::new();

/// o front informa o modo no `trigger_scheduler_tick` e o autotick (event-loop,

static PROJECT_MODES: OnceLock<Mutex<HashMap<String, crate::worktrees::WorktreeMode>>> =
    OnceLock::new();

fn project_modes() -> &'static Mutex<HashMap<String, crate::worktrees::WorktreeMode>> {
    PROJECT_MODES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn mode_for_project(project_id: &str) -> crate::worktrees::WorktreeMode {
    project_modes()
        .lock()
        .ok()
        .and_then(|map| map.get(project_id).copied())
        .unwrap_or(crate::worktrees::WorktreeMode::GitWorktree)
}

pub fn get_scheduler() -> &'static Mutex<Scheduler> {
    SCHEDULER.get_or_init(|| {
        Mutex::new(Scheduler {
            tasks: HashMap::new(),
            leases: HashSet::new(),
        })
    })
}

/// (`task.md`) — hash do texto do item. Namespacing por `project_id` corrige

fn derive_item_task_id(project_id: &str, text: &str) -> String {
    let mut hasher = DefaultHasher::new();
    text.hash(&mut hasher);
    format!("{project_id}-gsd-{:x}", hasher.finish())
}

/// formato real (escrito por `alethe-gsd-state.ts` a partir de `todowrite`)

pub fn load_gsd_tasks(project_id: &str, repo_path: &str) -> Result<(), String> {
    let repo_root = crate::git_control::repository_root(repo_path)?;
    let task_md_path = repo_root.join(".planning").join("task.md");
    let Ok(content) = std::fs::read_to_string(&task_md_path) else {
        return Ok(());
    };

    let items = crate::planning_gate::parse_roadmap_items(&content);
    let mut fresh_ids: HashSet<String> = HashSet::new();
    let mut fresh_tasks: Vec<Task> = Vec::new();
    let mut prev_id: Option<String> = None;
    for item in &items {
        if item.text.is_empty() {
            continue;
        }
        let id = derive_item_task_id(project_id, &item.text);
        fresh_ids.insert(id.clone());
        fresh_tasks.push(Task {
            id: id.clone(),
            project_id: project_id.to_string(),
            title: item.text.clone(),
            dependencies: match &prev_id {
                Some(p) => vec![p.clone()],
                None => Vec::new(),
            },
            status: if item.checked {
                TaskStatus::Completed
            } else {
                TaskStatus::Pending
            },
            assigned_agent_id: None,
            lease_resource: None,
            worktree_path: None,
            priority: 0,
        });
        prev_id = Some(id);
    }

    let mut scheduler = get_scheduler().lock().unwrap();

    scheduler.tasks.retain(|id, task| {
        task.project_id != project_id
            || fresh_ids.contains(id)
            || matches!(
                task.status,
                TaskStatus::Running | TaskStatus::Completed | TaskStatus::Failed
            )
    });

    for mut task in fresh_tasks {
        if let Some(existing) = scheduler.tasks.get(&task.id) {
            if matches!(
                existing.status,
                TaskStatus::Running | TaskStatus::Completed | TaskStatus::Failed
            ) {
                task.status = existing.status.clone();
                task.assigned_agent_id = existing.assigned_agent_id.clone();
                task.lease_resource = existing.lease_resource.clone();
                task.worktree_path = existing.worktree_path.clone();
            }
        }
        scheduler.tasks.insert(task.id.clone(), task);
    }

    Ok(())
}

pub fn run_scheduler_tick(project_id: &str, repo_path: &str) -> Result<(), String> {
    let mut scheduler = get_scheduler().lock().unwrap();

    let mut to_ready = Vec::new();
    for task in scheduler.tasks.values() {
        if task.project_id == project_id && task.status == TaskStatus::Pending {
            let mut all_completed = true;
            for dep in &task.dependencies {
                if let Some(dep_task) = scheduler.tasks.get(dep) {
                    if dep_task.status != TaskStatus::Completed {
                        all_completed = false;
                        break;
                    }
                } else {
                    all_completed = false;
                    break;
                }
            }
            if all_completed {
                to_ready.push(task.id.clone());
            }
        }
    }

    for id in to_ready {
        if let Some(t) = scheduler.tasks.get_mut(&id) {
            t.status = TaskStatus::Ready;
            crate::event_bus::publish_event_simple(
                "TaskReserved",
                &format!("sched-{}", nanoid!()),
                Some(t.project_id.clone()),
                Some(t.id.clone()),
                serde_json::json!({}),
            );
        }
    }

    // 2. Ready -> Running se puder obter lease
    let mut to_start = Vec::new();
    for task in scheduler.tasks.values() {
        if task.project_id == project_id && task.status == TaskStatus::Ready {
            let resource = format!("worktree:{}", task.id);
            if !scheduler.leases.contains(&resource) {
                to_start.push((task.id.clone(), resource, task.title.clone()));
            }
        }
    }

    for (id, resource, task_title) in to_start {
        scheduler.leases.insert(resource.clone());
        if let Some(t) = scheduler.tasks.get_mut(&id) {
            t.status = TaskStatus::Running;
            let agent_id = format!("agent-{}", id);
            t.assigned_agent_id = Some(agent_id.clone());
            t.lease_resource = Some(resource);

            crate::event_bus::publish_event_simple(
                "TaskStarted",
                &format!("sched-{}", nanoid!()),
                Some(t.project_id.clone()),
                Some(t.id.clone()),
                serde_json::json!({ "agent_id": agent_id }),
            );

            let repo_path_clone = repo_path.to_string();
            let agent_id_clone = agent_id.clone();
            let project_id_clone = t.project_id.clone();
            let task_id_clone = t.id.clone();

            let mode = mode_for_project(&t.project_id);
            tauri::async_runtime::spawn(async move {
                match crate::worktrees::worktree_provision_inner(
                    repo_path_clone.clone(),
                    agent_id_clone.clone(),
                    mode,
                ) {
                    Ok(info) => {
                        crate::supervisor::start_monitoring(
                            agent_id_clone.clone(),
                            info.path.clone(),
                            project_id_clone.clone(),
                            task_id_clone.clone(),
                        );
                        if let Ok(mut sched) = get_scheduler().lock() {
                            if let Some(task) = sched.tasks.get_mut(&task_id_clone) {
                                task.worktree_path = Some(info.path.clone());
                            }
                        }

                        crate::event_bus::publish_event_simple(
                            "AgentSpawnRequested",
                            &format!("sched-{}", nanoid!()),
                            Some(project_id_clone.clone()),
                            Some(task_id_clone.clone()),
                            serde_json::json!({
                                "agent_id": agent_id_clone,
                                "worktree_path": info.path,
                                "task_title": task_title,
                            }),
                        );
                    }
                    Err(e) => {
                        eprintln!(
                            "[Scheduler] Falha ao provisionar worktree para {}: {}",
                            task_id_clone, e
                        );
                        let mut sched = get_scheduler().lock().unwrap();
                        let mut to_remove_lease = None;
                        if let Some(task) = sched.tasks.get_mut(&task_id_clone) {
                            task.status = TaskStatus::Failed;
                            to_remove_lease = task.lease_resource.take();
                            task.assigned_agent_id = None;
                        }
                        if let Some(ref res) = to_remove_lease {
                            sched.leases.remove(res);
                        }
                        crate::event_bus::publish_event_simple(
                            "TaskFailed",
                            &format!("sched-{}", nanoid!()),
                            Some(project_id_clone),
                            Some(task_id_clone),
                            serde_json::json!({ "error": e }),
                        );
                    }
                }
            });
        }
    }

    let mut to_complete = Vec::new();
    for task in scheduler.tasks.values() {
        if task.project_id == project_id && task.status == TaskStatus::Running {
            if let Some(worktree_path) = &task.worktree_path {
                let status = crate::planning_gate::compute_planning_status(std::path::Path::new(
                    worktree_path,
                ));
                if status.has_planning && status.reported_complete {
                    to_complete.push(task.id.clone());
                }
            }
        }
    }
    for id in to_complete {
        let mut to_remove_lease = None;
        if let Some(t) = scheduler.tasks.get_mut(&id) {
            t.status = TaskStatus::Completed;
            to_remove_lease = t.lease_resource.take();
        }
        if let Some(ref resource) = to_remove_lease {
            scheduler.leases.remove(resource);
        }
        crate::event_bus::publish_event_simple(
            "TaskCompleted",
            &format!("sched-{}", nanoid!()),
            Some(project_id.to_string()),
            Some(id),
            serde_json::json!({}),
        );
    }

    Ok(())
}

#[tauri::command]
pub fn get_scheduler_tasks(project_id: String) -> Result<Vec<Task>, String> {
    let scheduler = get_scheduler().lock().unwrap();
    let list: Vec<Task> = scheduler
        .tasks
        .values()
        .filter(|t| t.project_id == project_id)
        .cloned()
        .collect();
    Ok(list)
}

#[tauri::command]
pub fn trigger_scheduler_tick(
    project_id: String,
    repo_path: String,
    worktree_mode: Option<crate::worktrees::WorktreeMode>,
) -> Result<(), String> {
    if let Some(mode) = worktree_mode {
        if let Ok(mut map) = project_modes().lock() {
            map.insert(project_id.clone(), mode);
        }
    }
    let _ = load_gsd_tasks(&project_id, &repo_path);
    run_scheduler_tick(&project_id, &repo_path)?;
    Ok(())
}

#[tauri::command]
pub fn cancel_task(task_id: String) -> Result<(), String> {
    let mut scheduler = get_scheduler().lock().unwrap();
    let mut to_remove_lease = None;
    let mut to_stop_agent = None;
    let project_id = if let Some(task) = scheduler.tasks.get_mut(&task_id) {
        if task.status == TaskStatus::Running {
            task.status = TaskStatus::Failed;
            to_stop_agent = task.assigned_agent_id.take();
            to_remove_lease = task.lease_resource.take();
            Some(task.project_id.clone())
        } else {
            None
        }
    } else {
        None
    };

    if let Some(proj_id) = project_id {
        if let Some(ref agent_id) = to_stop_agent {
            crate::supervisor::stop_monitoring(agent_id);
        }
        if let Some(ref resource) = to_remove_lease {
            scheduler.leases.remove(resource);
        }

        crate::event_bus::publish_event_simple(
            "TaskFailed",
            &format!("cancel-{}", nanoid!()),
            Some(proj_id),
            Some(task_id),
            serde_json::json!({ "reason": "Cancelled by user" }),
        );
    }
    Ok(())
}

pub fn start_scheduler_event_loop() {
    tauri::async_runtime::spawn(async move {
        let mut rx = crate::event_bus::subscribe();
        while let Ok(event) = rx.recv().await {
            if event.event_type == "PlanningUpdated" {
                if let Some(ref project_id) = event.task_id {
                    if let serde_json::Value::Object(map) = &event.data {
                        if let Some(planning_dir) = map.get("planning_dir").and_then(|v| v.as_str())
                        {
                            let repo_path = std::path::Path::new(planning_dir)
                                .parent()
                                .map(|p| p.to_string_lossy().to_string())
                                .unwrap_or_default();
                            if !repo_path.is_empty() {
                                eprintln!(
                                    "[Scheduler] Autotick disparado por PlanningUpdated para {}",
                                    project_id
                                );
                                let _ = trigger_scheduler_tick(project_id.clone(), repo_path, None);
                            }
                        }
                    }
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_project_id(label: &str) -> String {
        format!("test-{label}-{}", nanoid!())
    }

    fn temp_git_repo(label: &str) -> std::path::PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("alethe-scheduler-{label}-{suffix}"));
        fs::create_dir_all(&root).unwrap();
        crate::git_control::checked_output(&root, &["init", "-b", "main"]).unwrap();
        crate::git_control::checked_output(&root, &["config", "user.name", "Alethe Test"]).unwrap();
        crate::git_control::checked_output(
            &root,
            &["config", "user.email", "alethe@example.invalid"],
        )
        .unwrap();
        fs::write(root.join("a.txt"), "a\n").unwrap();
        crate::git_control::checked_output(&root, &["add", "-A"]).unwrap();
        crate::git_control::checked_output(&root, &["commit", "-m", "base"]).unwrap();
        root
    }

    #[test]
    fn derive_item_task_id_is_deterministic_and_namespaced_by_project() {
        let a1 = derive_item_task_id("proj-a", "Fazer login");
        let a2 = derive_item_task_id("proj-a", "Fazer login");
        let b = derive_item_task_id("proj-b", "Fazer login");
        assert_eq!(a1, a2, "mesmo projeto + mesmo texto = mesmo id");
        assert_ne!(
            a1, b,
            "projetos diferentes nunca colidem, mesmo com texto igual"
        );
    }

    #[test]
    fn load_gsd_tasks_reads_real_task_md_and_builds_sequential_chain() {
        let project_id = unique_project_id("chain");
        let root = temp_git_repo("chain");
        fs::create_dir_all(root.join(".planning")).unwrap();
        fs::write(
            root.join(".planning").join("task.md"),
            "- [x] Item A\n- [ ] Item B\n- [ ] Item C\n",
        )
        .unwrap();

        load_gsd_tasks(&project_id, root.to_string_lossy().as_ref()).unwrap();

        let scheduler = get_scheduler().lock().unwrap();
        let mut tasks: Vec<&Task> = scheduler
            .tasks
            .values()
            .filter(|t| t.project_id == project_id)
            .collect();
        tasks.sort_by(|a, b| a.title.cmp(&b.title));
        assert_eq!(tasks.len(), 3);

        let a = tasks.iter().find(|t| t.title == "Item A").unwrap();
        let b = tasks.iter().find(|t| t.title == "Item B").unwrap();
        let c = tasks.iter().find(|t| t.title == "Item C").unwrap();
        assert_eq!(a.status, TaskStatus::Completed);
        assert!(a.dependencies.is_empty());
        assert_eq!(b.status, TaskStatus::Pending);
        assert_eq!(b.dependencies, vec![a.id.clone()]);
        assert_eq!(c.status, TaskStatus::Pending);
        assert_eq!(c.dependencies, vec![b.id.clone()]);

        drop(scheduler);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn load_gsd_tasks_reload_preserves_running_and_drops_stale_pending() {
        let project_id = unique_project_id("reload");
        let root = temp_git_repo("reload");
        fs::create_dir_all(root.join(".planning")).unwrap();
        fs::write(
            root.join(".planning").join("task.md"),
            "- [ ] Item A\n- [ ] Item B\n",
        )
        .unwrap();
        load_gsd_tasks(&project_id, root.to_string_lossy().as_ref()).unwrap();

        let item_a_id = derive_item_task_id(&project_id, "Item A");
        let item_b_id = derive_item_task_id(&project_id, "Item B");
        {
            let mut scheduler = get_scheduler().lock().unwrap();
            let task = scheduler.tasks.get_mut(&item_a_id).unwrap();
            task.status = TaskStatus::Running;
            task.worktree_path = Some("D:/fake/worktree".to_string());
        }

        fs::write(root.join(".planning").join("task.md"), "- [ ] Item C\n").unwrap();
        load_gsd_tasks(&project_id, root.to_string_lossy().as_ref()).unwrap();

        let scheduler = get_scheduler().lock().unwrap();
        let a = scheduler
            .tasks
            .get(&item_a_id)
            .expect("Running sobrevive mesmo com a linha removida");
        assert_eq!(a.status, TaskStatus::Running);
        assert_eq!(a.worktree_path.as_deref(), Some("D:/fake/worktree"));
        assert!(
            scheduler.tasks.get(&item_b_id).is_none(),
            "Pending cuja linha sumiu deve ser descartada"
        );
        let item_c_id = derive_item_task_id(&project_id, "Item C");
        assert!(scheduler.tasks.get(&item_c_id).is_some());

        drop(scheduler);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn run_scheduler_tick_completes_running_task_when_worktree_planning_is_done() {
        let project_id = unique_project_id("complete");
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let worktree = std::env::temp_dir().join(format!("alethe-scheduler-wt-{suffix}"));
        fs::create_dir_all(worktree.join(".planning")).unwrap();
        fs::write(
            worktree.join(".planning").join("status.md"),
            "Status: Completed\n",
        )
        .unwrap();

        let task_id = format!("{project_id}-manual-task");
        {
            let mut scheduler = get_scheduler().lock().unwrap();
            scheduler.leases.insert(format!("worktree:{task_id}"));
            scheduler.tasks.insert(
                task_id.clone(),
                Task {
                    id: task_id.clone(),
                    project_id: project_id.clone(),
                    title: "Task manual".to_string(),
                    dependencies: Vec::new(),
                    status: TaskStatus::Running,
                    assigned_agent_id: Some("agent-manual".to_string()),
                    lease_resource: Some(format!("worktree:{task_id}")),
                    worktree_path: Some(worktree.to_string_lossy().to_string()),
                    priority: 0,
                },
            );
        }

        run_scheduler_tick(&project_id, "unused-repo-path").unwrap();

        let scheduler = get_scheduler().lock().unwrap();
        let task = scheduler.tasks.get(&task_id).unwrap();
        assert_eq!(task.status, TaskStatus::Completed);
        assert!(
            !scheduler.leases.contains(&format!("worktree:{task_id}")),
            "lease deve ser liberado quando a task completa"
        );

        drop(scheduler);
        fs::remove_dir_all(worktree).unwrap();
    }
}
