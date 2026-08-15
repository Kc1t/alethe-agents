use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::OnceLock;
use tokio::sync::broadcast;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EventBusPayload {
    pub event_type: String,
    pub timestamp_ms: u64,
    pub correlation_id: String,
    pub task_id: Option<String>,
    pub agent_id: Option<String>,
    pub data: Value,
}

static EVENT_BUS_SENDER: OnceLock<broadcast::Sender<EventBusPayload>> = OnceLock::new();

/// fora de um runtime Tauri).
static APP_HANDLE: OnceLock<tauri::AppHandle> = OnceLock::new();

pub fn set_app_handle(app: tauri::AppHandle) {
    let _ = APP_HANDLE.set(app);
}

pub fn get_sender() -> &'static broadcast::Sender<EventBusPayload> {
    EVENT_BUS_SENDER.get_or_init(|| {
        let (tx, _) = broadcast::channel(1024);
        tx
    })
}

pub fn publish(event: EventBusPayload) {
    let sender = get_sender();
    let _ = sender.send(event.clone());
    if let Some(app) = APP_HANDLE.get() {
        use tauri::Emitter;
        let _ = app.emit("alethe://event-bus", &event);
    }
}

pub fn subscribe() -> broadcast::Receiver<EventBusPayload> {
    get_sender().subscribe()
}

#[allow(dead_code)]
pub fn publish_event_simple(
    event_type: &str,
    correlation_id: &str,
    task_id: Option<String>,
    agent_id: Option<String>,
    data: Value,
) {
    let timestamp_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let event = EventBusPayload {
        event_type: event_type.to_string(),
        timestamp_ms,
        correlation_id: correlation_id.to_string(),
        task_id,
        agent_id,
        data,
    };
    publish(event);
}

#[tauri::command]
pub fn publish_event(event: EventBusPayload) -> Result<(), String> {
    publish(event);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_event_bus_publish_subscribe() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();

        rt.block_on(async {
            let mut rx = subscribe();

            let payload = EventBusPayload {
                event_type: "TestEvent".to_string(),
                timestamp_ms: 123456789,
                correlation_id: "test-corr-id".to_string(),
                task_id: None,
                agent_id: None,
                data: serde_json::json!({ "foo": "bar" }),
            };

            publish(payload.clone());

            let received = rx.recv().await.unwrap();
            assert_eq!(received.event_type, "TestEvent");
            assert_eq!(received.correlation_id, "test-corr-id");
            assert_eq!(received.data["foo"], "bar");
        });
    }
}
