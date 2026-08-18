use std::collections::{BTreeMap, HashMap, VecDeque};
use std::fs::OpenOptions;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use tauri::AppHandle;

use crate::event_bus::EventBusPayload;

const TELEMETRY_LOG_MAX_BYTES: u64 = 2 * 1024 * 1024;
const PERSISTED_METRIC_FIELDS: [&str; 3] = ["duration_ms", "cost_usd", "memory_mb"];

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct MetricData {
    pub count: i64,
    pub last_value: f64,
    pub sum: f64,
}

#[derive(serde::Serialize)]
struct PersistedTelemetryEvent<'a> {
    event_type: &'a str,
    timestamp_ms: u64,
    correlation_id: &'a str,
    task_id: &'a Option<String>,
    agent_id: &'a Option<String>,
    data: BTreeMap<&'static str, f64>,
}

static METRICS: OnceLock<Mutex<HashMap<String, MetricData>>> = OnceLock::new();
static TRACES: OnceLock<Mutex<VecDeque<EventBusPayload>>> = OnceLock::new();

fn get_metrics() -> &'static Mutex<HashMap<String, MetricData>> {
    METRICS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn get_traces() -> &'static Mutex<VecDeque<EventBusPayload>> {
    TRACES.get_or_init(|| Mutex::new(VecDeque::with_capacity(500)))
}

fn is_persistable_metric(field: &str, value: f64) -> bool {
    PERSISTED_METRIC_FIELDS.contains(&field) && value.is_finite()
}

fn persisted_telemetry_line(event: &EventBusPayload) -> serde_json::Result<Vec<u8>> {
    let mut data = BTreeMap::new();
    if let serde_json::Value::Object(event_data) = &event.data {
        for field in PERSISTED_METRIC_FIELDS {
            if let Some(value) = event_data.get(field).and_then(serde_json::Value::as_f64) {
                if is_persistable_metric(field, value) {
                    data.insert(field, value);
                }
            }
        }
    }

    let persisted = PersistedTelemetryEvent {
        event_type: &event.event_type,
        timestamp_ms: event.timestamp_ms,
        correlation_id: &event.correlation_id,
        task_id: &event.task_id,
        agent_id: &event.agent_id,
        data,
    };
    let mut line = serde_json::to_vec(&persisted)?;
    line.push(b'\n');
    Ok(line)
}

fn telemetry_log_path(app: &AppHandle) -> io::Result<PathBuf> {
    crate::logging::logs_dir(app)
        .map(|dir| dir.join("telemetry.jsonl"))
        .map_err(io::Error::other)
}

fn open_telemetry_log(path: &Path, truncate: bool) -> io::Result<std::fs::File> {
    let mut options = OpenOptions::new();
    options.create(true).write(true);
    if truncate {
        options.truncate(true);
    } else {
        options.append(true);
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }

    let file = options.open(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(file)
}

/// Appends a minimized event, replacing older telemetry when the size cap would be exceeded.
/// Returns `false` without changing the file when one serialized event exceeds the cap.
fn append_telemetry_log_at(path: &Path, event: &EventBusPayload) -> io::Result<bool> {
    let line = persisted_telemetry_line(event).map_err(io::Error::other)?;
    let line_len = u64::try_from(line.len()).unwrap_or(u64::MAX);
    if line_len > TELEMETRY_LOG_MAX_BYTES {
        return Ok(false);
    }

    let existing_len = match std::fs::metadata(path) {
        Ok(metadata) => metadata.len(),
        Err(error) if error.kind() == io::ErrorKind::NotFound => 0,
        Err(error) => return Err(error),
    };
    let replace_existing = existing_len
        .checked_add(line_len)
        .map_or(true, |new_len| new_len > TELEMETRY_LOG_MAX_BYTES);

    let mut file = open_telemetry_log(path, replace_existing)?;
    file.write_all(&line)?;
    Ok(true)
}

fn append_telemetry_log(app: &AppHandle, event: &EventBusPayload) {
    if let Ok(path) = telemetry_log_path(app) {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = append_telemetry_log_at(&path, event);
    }
}

fn update_metrics(event: &EventBusPayload) {
    let mut metrics = match get_metrics().lock() {
        Ok(m) => m,
        Err(_) => return,
    };

    // Increment the total event count by type.
    let key = format!("alethe_event_{}", event.event_type.to_lowercase());
    let entry = metrics.entry(key).or_insert(MetricData {
        count: 0,
        last_value: 0.0,
        sum: 0.0,
    });
    entry.count += 1;

    // Preserve the existing in-memory aggregation of numeric event data.
    if let serde_json::Value::Object(map) = &event.data {
        for (field, val) in map {
            if let Some(num) = val.as_f64() {
                if field == "duration_ms" || field == "cost_usd" || field == "memory_mb" {
                    let metric_key = format!("alethe_metric_{}", field);
                    let entry = metrics.entry(metric_key).or_insert(MetricData {
                        count: 0,
                        last_value: 0.0,
                        sum: 0.0,
                    });
                    entry.count += 1;
                    entry.last_value = num;
                    entry.sum += num;
                }
            }
        }
    }
}

fn add_trace(event: EventBusPayload) {
    let mut traces = match get_traces().lock() {
        Ok(t) => t,
        Err(_) => return,
    };
    if traces.len() >= 500 {
        traces.pop_front();
    }
    traces.push_back(event);
}

pub fn start_telemetry_watcher(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut rx = crate::event_bus::subscribe();
        loop {
            match rx.recv().await {
                Ok(event) => {
                    append_telemetry_log(&app, &event);
                    update_metrics(&event);
                    add_trace(event);
                }
                // A lagged receiver skips old events and continues processing new ones.
                Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                    eprintln!(
                        "[telemetry] receiver lagged; skipped {skipped} event(s) and continuing"
                    );
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    });
}

#[tauri::command]
pub fn get_telemetry_metrics() -> Result<HashMap<String, MetricData>, String> {
    let metrics = get_metrics().lock().map_err(|e| e.to_string())?;
    Ok(metrics.clone())
}

#[tauri::command]
pub fn get_telemetry_traces(
    correlation_id: Option<String>,
) -> Result<Vec<EventBusPayload>, String> {
    let traces = get_traces().lock().map_err(|e| e.to_string())?;
    if let Some(corr_id) = correlation_id {
        Ok(traces
            .iter()
            .filter(|t| t.correlation_id == corr_id)
            .cloned()
            .collect())
    } else {
        Ok(traces.iter().cloned().collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event_bus::EventBusPayload;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(0);

    struct TempTelemetryDir(PathBuf);

    impl TempTelemetryDir {
        fn new() -> Self {
            let id = NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir()
                .join(format!("alethe-telemetry-test-{}-{id}", std::process::id()));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn log_path(&self) -> PathBuf {
            self.0.join("telemetry.jsonl")
        }
    }

    impl Drop for TempTelemetryDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn payload(correlation_id: impl Into<String>, data: serde_json::Value) -> EventBusPayload {
        EventBusPayload {
            event_type: "TaskFinished".to_string(),
            timestamp_ms: 2_000,
            correlation_id: correlation_id.into(),
            task_id: Some("task-1".to_string()),
            agent_id: Some("agent-1".to_string()),
            data,
        }
    }

    #[test]
    fn persisted_events_exclude_arbitrary_data_and_keep_only_numeric_metrics() {
        let event = payload(
            "corr-private",
            serde_json::json!({
                "duration_ms": 125.5,
                "cost_usd": "0.50",
                "memory_mb": 256,
                "prompt": "never persist this",
                "credentials": { "token": "secret" },
                "items": [1, 2, 3]
            }),
        );

        let line = persisted_telemetry_line(&event).unwrap();
        let persisted: serde_json::Value = serde_json::from_slice(&line).unwrap();

        assert_eq!(persisted["event_type"], "TaskFinished");
        assert_eq!(persisted["timestamp_ms"], 2_000);
        assert_eq!(persisted["correlation_id"], "corr-private");
        assert_eq!(persisted["task_id"], "task-1");
        assert_eq!(persisted["agent_id"], "agent-1");
        assert_eq!(
            persisted["data"],
            serde_json::json!({
                "duration_ms": 125.5,
                "memory_mb": 256.0
            })
        );
        assert!(persisted.get("prompt").is_none());
        assert!(!String::from_utf8(line)
            .unwrap()
            .contains("never persist this"));
        assert!(!persisted["data"]
            .as_object()
            .unwrap()
            .contains_key("credentials"));
    }

    #[test]
    fn non_finite_metrics_and_single_oversized_events_are_excluded() {
        assert!(!is_persistable_metric("duration_ms", f64::NAN));
        assert!(!is_persistable_metric("cost_usd", f64::INFINITY));
        assert!(!is_persistable_metric("memory_mb", f64::NEG_INFINITY));
        assert!(!is_persistable_metric("arbitrary", 1.0));

        let temp = TempTelemetryDir::new();
        let path = temp.log_path();
        let original = payload("original", serde_json::json!({ "duration_ms": 1 }));
        assert!(append_telemetry_log_at(&path, &original).unwrap());
        let original_contents = std::fs::read(&path).unwrap();

        let oversized = payload(
            "x".repeat(TELEMETRY_LOG_MAX_BYTES as usize),
            serde_json::json!({ "duration_ms": 2 }),
        );
        assert!(!append_telemetry_log_at(&path, &oversized).unwrap());
        assert_eq!(std::fs::read(&path).unwrap(), original_contents);
    }

    #[test]
    fn telemetry_file_stays_bounded_and_replaces_old_content() {
        let temp = TempTelemetryDir::new();
        let path = temp.log_path();
        let padding = "x".repeat(700 * 1024);

        for index in 0..6 {
            let event = payload(
                format!("event-{index}-{padding}"),
                serde_json::json!({ "memory_mb": index }),
            );
            assert!(append_telemetry_log_at(&path, &event).unwrap());
            assert!(std::fs::metadata(&path).unwrap().len() <= TELEMETRY_LOG_MAX_BYTES);
        }

        let contents = std::fs::read_to_string(&path).unwrap();
        assert!(contents.contains("event-5-"));
        assert!(!contents.contains("event-0-"));
    }

    #[cfg(unix)]
    #[test]
    fn telemetry_file_is_created_and_migrated_to_owner_only_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let temp = TempTelemetryDir::new();
        let path = temp.log_path();
        std::fs::write(&path, b"").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        let event = payload("permissions", serde_json::json!({}));

        assert!(append_telemetry_log_at(&path, &event).unwrap());
        assert_eq!(
            std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    #[test]
    fn test_telemetry_metrics_and_traces() {
        let payload1 = EventBusPayload {
            event_type: "TaskStarted".to_string(),
            timestamp_ms: 1000,
            correlation_id: "corr-123".to_string(),
            task_id: Some("task-1".to_string()),
            agent_id: None,
            data: serde_json::json!({ "memory_mb": 150.0 }),
        };

        let payload2 = EventBusPayload {
            event_type: "TaskFinished".to_string(),
            timestamp_ms: 2000,
            correlation_id: "corr-123".to_string(),
            task_id: Some("task-1".to_string()),
            agent_id: None,
            data: serde_json::json!({ "duration_ms": 1000.0, "cost_usd": 0.05 }),
        };

        // Process the events manually.
        update_metrics(&payload1);
        add_trace(payload1.clone());

        update_metrics(&payload2);
        add_trace(payload2.clone());

        let metrics = get_telemetry_metrics().unwrap();
        assert_eq!(metrics.get("alethe_event_taskstarted").unwrap().count, 1);
        assert_eq!(metrics.get("alethe_event_taskfinished").unwrap().count, 1);
        assert_eq!(
            metrics.get("alethe_metric_memory_mb").unwrap().last_value,
            150.0
        );
        assert_eq!(
            metrics.get("alethe_metric_duration_ms").unwrap().last_value,
            1000.0
        );
        assert_eq!(
            metrics.get("alethe_metric_cost_usd").unwrap().last_value,
            0.05
        );

        // Verify traces filtered by correlation_id.
        let traces_all = get_telemetry_traces(None).unwrap();
        assert!(traces_all.len() >= 2);

        let traces_specific = get_telemetry_traces(Some("corr-123".to_string())).unwrap();
        assert_eq!(traces_specific.len(), 2);
        assert_eq!(traces_specific[0].event_type, "TaskStarted");
        assert_eq!(traces_specific[1].event_type, "TaskFinished");
    }
}
