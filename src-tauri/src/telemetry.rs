use std::collections::{HashMap, VecDeque};
use std::fs::OpenOptions;
use std::io::Write;
use std::sync::{Mutex, OnceLock};
use tauri::AppHandle;

use crate::event_bus::EventBusPayload;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct MetricData {
    pub count: i64,
    pub last_value: f64,
    pub sum: f64,
}

static METRICS: OnceLock<Mutex<HashMap<String, MetricData>>> = OnceLock::new();
static TRACES: OnceLock<Mutex<VecDeque<EventBusPayload>>> = OnceLock::new();

fn get_metrics() -> &'static Mutex<HashMap<String, MetricData>> {
    METRICS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn get_traces() -> &'static Mutex<VecDeque<EventBusPayload>> {
    TRACES.get_or_init(|| Mutex::new(VecDeque::with_capacity(500)))
}

fn append_telemetry_log(app: &AppHandle, event: &EventBusPayload) {
    if let Ok(dir) = crate::logging::logs_dir(app) {
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("telemetry.jsonl");
        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
            if let Ok(line) = serde_json::to_string(event) {
                let _ = writeln!(file, "{}", line);
            }
        }
    }
}

fn update_metrics(event: &EventBusPayload) {
    let mut metrics = match get_metrics().lock() {
        Ok(m) => m,
        Err(_) => return,
    };

    // 1. Increment total count of events by type
    let key = format!("alethe_event_{}", event.event_type.to_lowercase());
    let entry = metrics.entry(key).or_insert(MetricData {
        count: 0,
        last_value: 0.0,
        sum: 0.0,
    });
    entry.count += 1;

    // 2. Custom metric extraction if there are numbers in event.data
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
                    // 1. Log to file
                    append_telemetry_log(&app, &event);

                    // 2. Update metrics
                    update_metrics(&event);

                    // 3. Keep trace
                    add_trace(event);
                }

                // conseguir processar tudo — o `while let Ok(...)` original

                // Execution metrics/Recent event history (aba Multi-Agent &

                // eventos reais continuando a acontecer. O receiver continua
                Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                    eprintln!(
                        "[telemetry] receiver atrasado, {skipped} evento(s) perdido(s) — continuando"
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

        // Simula processamento manual
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

        // Verifica traces com correlation_id
        let traces_all = get_telemetry_traces(None).unwrap();
        assert!(traces_all.len() >= 2);

        let traces_specific = get_telemetry_traces(Some("corr-123".to_string())).unwrap();
        assert_eq!(traces_specific.len(), 2);
        assert_eq!(traces_specific[0].event_type, "TaskStarted");
        assert_eq!(traces_specific[1].event_type, "TaskFinished");
    }
}
