use nanoid::nanoid;
use serde_json::json;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

#[allow(dead_code)]
pub struct MonitoredAgent {
    pub agent_id: String,
    pub worktree_path: String,
    pub project_id: String,
    pub task_id: String,
    pub last_activity_ms: u64,
    pub retry_count: u32,
    pub max_retries: u32,
}

static MONITORED_AGENTS: OnceLock<Mutex<HashMap<String, MonitoredAgent>>> = OnceLock::new();

pub fn get_monitored_agents() -> &'static Mutex<HashMap<String, MonitoredAgent>> {
    MONITORED_AGENTS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn start_monitoring(
    agent_id: String,
    worktree_path: String,
    project_id: String,
    task_id: String,
) {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    let mut map = get_monitored_agents().lock().unwrap();
    map.insert(
        agent_id.clone(),
        MonitoredAgent {
            agent_id,
            worktree_path,
            project_id,
            task_id,
            last_activity_ms: now,
            retry_count: 0,
            max_retries: 3,
        },
    );
}

pub fn stop_monitoring(agent_id: &str) {
    let mut map = get_monitored_agents().lock().unwrap();
    map.remove(agent_id);
}

pub fn start_supervisor_event_loop() {
    // 1. Ouvinte do EventBus para registrar atividade do agente
    tauri::async_runtime::spawn(async move {
        let mut rx = crate::event_bus::subscribe();
        while let Ok(event) = rx.recv().await {
            if let Some(ref agent_id) = event.agent_id {
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0);

                let mut map = get_monitored_agents().lock().unwrap();
                if let Some(agent) = map.get_mut(agent_id) {
                    agent.last_activity_ms = now;
                }
            }
        }
    });

    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;

            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);

            let mut to_restart = Vec::new();
            let mut to_kill = Vec::new();

            {
                let mut map = get_monitored_agents().lock().unwrap();
                for agent in map.values_mut() {
                    // 10 minutos de inatividade = 10 * 60 * 1000 ms = 600_000 ms
                    if now - agent.last_activity_ms > 600_000 {
                        agent.retry_count += 1;
                        if agent.retry_count <= agent.max_retries {
                            agent.last_activity_ms = now;
                            to_restart.push(agent.agent_id.clone());
                        } else {
                            to_kill.push(agent.agent_id.clone());
                        }
                    }
                }
            }

            for id in to_restart {
                let (project_id, task_id) = {
                    let map = get_monitored_agents().lock().unwrap();
                    let agent = map.get(&id).unwrap();
                    (agent.project_id.clone(), agent.task_id.clone())
                };

                crate::event_bus::publish_event_simple(
                    "AgentTimeout",
                    &format!("super-{}", nanoid!()),
                    Some(project_id.clone()),
                    Some(task_id.clone()),
                    json!({ "agent_id": id }),
                );

                crate::event_bus::publish_event_simple(
                    "AgentRestarted",
                    &format!("super-{}", nanoid!()),
                    Some(project_id.clone()),
                    Some(task_id.clone()),
                    json!({ "agent_id": id }),
                );
            }

            for id in to_kill {
                let (project_id, task_id) = {
                    let mut map = get_monitored_agents().lock().unwrap();
                    let agent = map.remove(&id).unwrap();
                    (agent.project_id, agent.task_id)
                };

                {
                    let mut sched = crate::scheduler::get_scheduler().lock().unwrap();
                    let mut to_remove_lease = None;
                    if let Some(task) = sched.tasks.get_mut(&task_id) {
                        task.status = crate::scheduler::TaskStatus::Failed;
                        to_remove_lease = task.lease_resource.take();
                        task.assigned_agent_id = None;
                    }
                    if let Some(ref res) = to_remove_lease {
                        sched.leases.remove(res);
                    }
                }

                crate::event_bus::publish_event_simple(
                    "AgentKilled",
                    &format!("super-{}", nanoid!()),
                    Some(project_id.clone()),
                    Some(task_id.clone()),
                    json!({ "agent_id": id, "reason": "Max retries exceeded on inactivity timeout" }),
                );

                crate::event_bus::publish_event_simple(
                    "TaskFailed",
                    &format!("super-{}", nanoid!()),
                    Some(project_id),
                    Some(task_id),
                    json!({ "error": "Agent inactive and failed to recover" }),
                );
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_supervisor_monitoring() {
        start_monitoring(
            "agent-test".to_string(),
            "/path/to/worktree".to_string(),
            "proj-test".to_string(),
            "task-test".to_string(),
        );

        {
            let map = get_monitored_agents().lock().unwrap();
            let agent = map.get("agent-test").unwrap();
            assert_eq!(agent.project_id, "proj-test");
            assert_eq!(agent.task_id, "task-test");
            assert_eq!(agent.worktree_path, "/path/to/worktree");
        }

        stop_monitoring("agent-test");

        {
            let map = get_monitored_agents().lock().unwrap();
            assert!(!map.contains_key("agent-test"));
        }
    }
}
