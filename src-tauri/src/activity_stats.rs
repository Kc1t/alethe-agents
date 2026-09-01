use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::paths::activity_stats_file_path;

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSample {
    pub agent: String,
    pub project_id: Option<String>,
    pub terminal_id: Option<String>,
    pub state: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivitySample {
    pub date: String,
    pub duration_ms: u64,
    pub app_focused: bool,
    pub user_active: bool,
    pub active_project_id: Option<String>,
    pub active_terminal_id: Option<String>,
    #[serde(default)]
    pub agents: Vec<AgentSample>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimeTotals {
    pub app_open_ms: u64,
    pub app_focused_ms: u64,
    pub user_active_ms: u64,
    pub user_idle_ms: u64,
    pub agent_wall_ms: u64,
    pub agent_sum_ms: u64,
    pub agent_background_ms: u64,
    pub parallel_ms: u64,
    pub peak_concurrent: u32,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTotals {
    pub working_ms: u64,
    pub waiting_ms: u64,
    pub focused_ms: u64,
    pub background_ms: u64,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectTotals {
    pub focused_ms: u64,
    pub active_ms: u64,
    pub idle_ms: u64,
    pub agent_wall_ms: u64,
    pub agent_sum_ms: u64,
    pub agent_background_ms: u64,
    pub parallel_ms: u64,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DayStats {
    pub totals: TimeTotals,
    #[serde(default)]
    pub agents: BTreeMap<String, AgentTotals>,
    #[serde(default)]
    pub projects: BTreeMap<String, ProjectTotals>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ActivityStatsFile {
    pub version: u32,
    #[serde(default)]
    pub days: BTreeMap<String, DayStats>,
}

impl Default for ActivityStatsFile {
    fn default() -> Self {
        Self {
            version: 1,
            days: BTreeMap::new(),
        }
    }
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivitySummary {
    pub totals: TimeTotals,
    pub agents: BTreeMap<String, AgentTotals>,
    pub projects: BTreeMap<String, ProjectTotals>,
}

fn add_time_totals(target: &mut TimeTotals, value: &TimeTotals) {
    target.app_open_ms += value.app_open_ms;
    target.app_focused_ms += value.app_focused_ms;
    target.user_active_ms += value.user_active_ms;
    target.user_idle_ms += value.user_idle_ms;
    target.agent_wall_ms += value.agent_wall_ms;
    target.agent_sum_ms += value.agent_sum_ms;
    target.agent_background_ms += value.agent_background_ms;
    target.parallel_ms += value.parallel_ms;
    target.peak_concurrent = target.peak_concurrent.max(value.peak_concurrent);
}

fn add_agent_totals(target: &mut AgentTotals, value: &AgentTotals) {
    target.working_ms += value.working_ms;
    target.waiting_ms += value.waiting_ms;
    target.focused_ms += value.focused_ms;
    target.background_ms += value.background_ms;
}

fn add_project_totals(target: &mut ProjectTotals, value: &ProjectTotals) {
    target.focused_ms += value.focused_ms;
    target.active_ms += value.active_ms;
    target.idle_ms += value.idle_ms;
    target.agent_wall_ms += value.agent_wall_ms;
    target.agent_sum_ms += value.agent_sum_ms;
    target.agent_background_ms += value.agent_background_ms;
    target.parallel_ms += value.parallel_ms;
}

fn apply_sample(day: &mut DayStats, sample: &ActivitySample) {
    let duration = sample.duration_ms.min(15_000);
    if duration == 0 {
        return;
    }

    day.totals.app_open_ms += duration;
    if sample.app_focused {
        day.totals.app_focused_ms += duration;
        if sample.user_active {
            day.totals.user_active_ms += duration;
        } else {
            day.totals.user_idle_ms += duration;
        }
    }

    if let Some(project_id) = sample
        .active_project_id
        .as_ref()
        .filter(|_| sample.app_focused)
    {
        let project = day.projects.entry(project_id.clone()).or_default();
        project.focused_ms += duration;
        if sample.user_active {
            project.active_ms += duration;
        } else {
            project.idle_ms += duration;
        }
    }

    let working: Vec<&AgentSample> = sample
        .agents
        .iter()
        .filter(|a| a.state == "working")
        .collect();
    let working_count = working.len() as u32;
    if working_count > 0 {
        day.totals.agent_wall_ms += duration;
    }
    day.totals.agent_sum_ms += duration * working_count as u64;
    day.totals.peak_concurrent = day.totals.peak_concurrent.max(working_count);
    if working_count >= 2 {
        day.totals.parallel_ms += duration;
    }

    let has_background_work = working.iter().any(|agent| {
        !sample.app_focused || agent.project_id.as_deref() != sample.active_project_id.as_deref()
    });
    if has_background_work {
        day.totals.agent_background_ms += duration;
    }

    for agent in &sample.agents {
        let totals = day.agents.entry(agent.agent.clone()).or_default();
        if agent.state == "working" {
            totals.working_ms += duration;
            let is_focused = sample.app_focused
                && agent.terminal_id.as_ref() == sample.active_terminal_id.as_ref();
            if is_focused {
                totals.focused_ms += duration;
            } else {
                totals.background_ms += duration;
            }
        } else if agent.state == "waiting" {
            totals.waiting_ms += duration;
        }
    }

    let mut project_counts: BTreeMap<&str, u64> = BTreeMap::new();
    for agent in working {
        let project_id = agent.project_id.as_deref().unwrap_or("__unassigned__");
        *project_counts.entry(project_id).or_default() += 1;
    }
    for (project_id, count) in project_counts {
        let project = day.projects.entry(project_id.to_string()).or_default();
        project.agent_wall_ms += duration;
        project.agent_sum_ms += duration * count;
        if count >= 2 {
            project.parallel_ms += duration;
        }
        if !sample.app_focused || sample.active_project_id.as_deref() != Some(project_id) {
            project.agent_background_ms += duration;
        }
    }
}

fn read_stats(path: &Path) -> Result<ActivityStatsFile, String> {
    if !path.exists() {
        return Ok(ActivityStatsFile::default());
    }
    let raw = fs::read_to_string(path).map_err(|error| error.to_string())?;
    let parsed: ActivityStatsFile =
        serde_json::from_str(&raw).map_err(|error| error.to_string())?;
    if parsed.version != 1 {
        return Err(format!(
            "unsupported activity stats version: {}",
            parsed.version
        ));
    }
    Ok(parsed)
}

fn write_stats(path: &Path, stats: &ActivityStatsFile) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("json.tmp");
    let raw = serde_json::to_string(stats).map_err(|error| error.to_string())?;
    fs::write(&tmp, raw).map_err(|error| error.to_string())?;
    fs::rename(&tmp, path).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn record_activity_samples(app: AppHandle, samples: Vec<ActivitySample>) -> Result<(), String> {
    if samples.is_empty() {
        return Ok(());
    }
    let path = activity_stats_file_path(&app)?;

    let mut stats = read_stats(&path)?;
    for sample in &samples {
        if sample.date.len() == 10 {
            apply_sample(stats.days.entry(sample.date.clone()).or_default(), sample);
        }
    }
    write_stats(&path, &stats)
}

#[tauri::command]
pub async fn get_activity_summary(
    app: AppHandle,
    dates: Vec<String>,
) -> Result<ActivitySummary, String> {
    // Resolve the path asynchronously, then run file aggregation off the Tauri thread.
    let path = activity_stats_file_path(&app)?;
    tokio::task::spawn_blocking(move || get_activity_summary_inner(path, dates))
        .await
        .map_err(|e| e.to_string())?
}

fn get_activity_summary_inner(
    path: PathBuf,
    dates: Vec<String>,
) -> Result<ActivitySummary, String> {
    let stats = read_stats(&path)?;
    let filter: BTreeSet<String> = dates.into_iter().collect();
    let mut summary = ActivitySummary::default();
    for (date, day) in stats.days {
        if !filter.is_empty() && !filter.contains(&date) {
            continue;
        }
        add_time_totals(&mut summary.totals, &day.totals);
        for (key, value) in day.agents {
            add_agent_totals(summary.agents.entry(key).or_default(), &value);
        }
        for (key, value) in day.projects {
            add_project_totals(summary.projects.entry(key).or_default(), &value);
        }
    }
    Ok(summary)
}

#[tauri::command]
pub fn clear_activity_stats(app: AppHandle) -> Result<(), String> {
    let path = activity_stats_file_path(&app)?;
    if path.exists() {
        fs::remove_file(path).map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parallel_time_keeps_wall_clock_separate_from_agent_sum() {
        let mut day = DayStats::default();
        apply_sample(
            &mut day,
            &ActivitySample {
                date: "2026-06-20".into(),
                duration_ms: 5_000,
                app_focused: false,
                user_active: false,
                active_project_id: None,
                active_terminal_id: None,
                agents: vec![
                    AgentSample {
                        agent: "claude".into(),
                        project_id: Some("x".into()),
                        terminal_id: Some("a".into()),
                        state: "working".into(),
                    },
                    AgentSample {
                        agent: "codex".into(),
                        project_id: Some("y".into()),
                        terminal_id: Some("b".into()),
                        state: "working".into(),
                    },
                ],
            },
        );
        assert_eq!(day.totals.agent_wall_ms, 5_000);
        assert_eq!(day.totals.agent_sum_ms, 10_000);
        assert_eq!(day.totals.parallel_ms, 5_000);
        assert_eq!(day.totals.peak_concurrent, 2);
    }
}
