//! Minimal Chrome DevTools Protocol client.
//!
//! The browser owned by `browser_session` already speaks CDP, and Playwright MCP attaches to the
//! same endpoint. This is the second consumer: it lets Alethe drive and observe a tab itself —
//! frames in, input events out — instead of only handing the browser to an agent.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::{broadcast, mpsc, oneshot};
use tokio_tungstenite::tungstenite::Message;

const CALL_TIMEOUT: Duration = Duration::from_secs(20);
const EVENT_BUFFER: usize = 256;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CdpEvent {
    pub method: String,
    pub params: Value,
    pub session_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CdpTarget {
    pub target_id: String,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub url: String,
}

#[derive(Debug)]
pub enum Incoming {
    Response {
        id: u64,
        result: Result<Value, String>,
    },
    Event(CdpEvent),
    Ignored,
}

pub fn encode_request(id: u64, method: &str, params: &Value, session: Option<&str>) -> String {
    let mut message = json!({ "id": id, "method": method });
    if !params.is_null() {
        message["params"] = params.clone();
    }
    if let Some(session) = session {
        message["sessionId"] = Value::String(session.to_string());
    }
    message.to_string()
}

pub fn parse_incoming(text: &str) -> Incoming {
    let Ok(value) = serde_json::from_str::<Value>(text) else {
        return Incoming::Ignored;
    };

    if let Some(id) = value.get("id").and_then(Value::as_u64) {
        if let Some(error) = value.get("error") {
            let code = error.get("code").and_then(Value::as_i64).unwrap_or(0);
            let message = error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("cdp_error");
            return Incoming::Response {
                id,
                result: Err(format!("{code}:{message}")),
            };
        }
        return Incoming::Response {
            id,
            result: Ok(value.get("result").cloned().unwrap_or(Value::Null)),
        };
    }

    match value.get("method").and_then(Value::as_str) {
        Some(method) => Incoming::Event(CdpEvent {
            method: method.to_string(),
            params: value.get("params").cloned().unwrap_or(Value::Null),
            session_id: value
                .get("sessionId")
                .and_then(Value::as_str)
                .map(str::to_string),
        }),
        None => Incoming::Ignored,
    }
}

/// Only `page` targets can be shown in a pane; workers and the browser target cannot be screencast.
pub fn page_targets_from(result: &Value) -> Vec<CdpTarget> {
    result
        .get("targetInfos")
        .and_then(Value::as_array)
        .map(|infos| {
            infos
                .iter()
                .filter_map(|info| serde_json::from_value::<CdpTarget>(info.clone()).ok())
                .filter(|target| target.kind == "page")
                .collect()
        })
        .unwrap_or_default()
}

pub fn session_id_from(result: &Value) -> Result<String, String> {
    result
        .get("sessionId")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| "cdp_attach_failed".to_string())
}

pub struct CdpClient {
    next_id: AtomicU64,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>,
    outgoing: mpsc::UnboundedSender<Message>,
    events: broadcast::Sender<CdpEvent>,
}

impl CdpClient {
    pub async fn connect(ws_url: &str) -> Result<Arc<Self>, String> {
        let (stream, _) = tokio_tungstenite::connect_async(ws_url)
            .await
            .map_err(|error| format!("cdp_connect_failed:{error}"))?;
        let (mut sink, mut source) = stream.split();
        let (outgoing, mut queue) = mpsc::unbounded_channel::<Message>();
        let (events, _) = broadcast::channel(EVENT_BUFFER);
        let pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>> =
            Arc::new(Mutex::new(HashMap::new()));

        tokio::spawn(async move {
            while let Some(message) = queue.recv().await {
                if sink.send(message).await.is_err() {
                    break;
                }
            }
        });

        let reader_pending = Arc::clone(&pending);
        let reader_events = events.clone();
        tokio::spawn(async move {
            while let Some(Ok(message)) = source.next().await {
                let Message::Text(text) = message else {
                    continue;
                };
                match parse_incoming(&text) {
                    Incoming::Response { id, result } => {
                        let waiter = reader_pending
                            .lock()
                            .ok()
                            .and_then(|mut map| map.remove(&id));
                        if let Some(waiter) = waiter {
                            let _ = waiter.send(result);
                        }
                    }
                    Incoming::Event(event) => {
                        let _ = reader_events.send(event);
                    }
                    Incoming::Ignored => {}
                }
            }
            // Waking every waiter on disconnect keeps callers from blocking until their timeout.
            if let Ok(mut map) = reader_pending.lock() {
                for (_, waiter) in map.drain() {
                    let _ = waiter.send(Err("cdp_disconnected".to_string()));
                }
            }
        });

        Ok(Arc::new(Self {
            next_id: AtomicU64::new(1),
            pending,
            outgoing,
            events,
        }))
    }

    pub async fn call(
        &self,
        method: &str,
        params: Value,
        session: Option<&str>,
    ) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = oneshot::channel();
        self.pending
            .lock()
            .map_err(|_| "cdp pending lock poisoned")?
            .insert(id, sender);

        let payload = encode_request(id, method, &params, session);
        if self.outgoing.send(Message::Text(payload.into())).is_err() {
            self.forget(id);
            return Err("cdp_disconnected".to_string());
        }

        match tokio::time::timeout(CALL_TIMEOUT, receiver).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("cdp_disconnected".to_string()),
            Err(_) => {
                self.forget(id);
                Err(format!("cdp_timeout:{method}"))
            }
        }
    }

    fn forget(&self, id: u64) {
        if let Ok(mut map) = self.pending.lock() {
            map.remove(&id);
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<CdpEvent> {
        self.events.subscribe()
    }

    pub async fn page_targets(&self) -> Result<Vec<CdpTarget>, String> {
        let result = self.call("Target.getTargets", Value::Null, None).await?;
        Ok(page_targets_from(&result))
    }

    /// `flatten` multiplexes every tab session onto this one socket, so one connection drives all.
    pub async fn attach(&self, target_id: &str) -> Result<String, String> {
        let result = self
            .call(
                "Target.attachToTarget",
                json!({ "targetId": target_id, "flatten": true }),
                None,
            )
            .await?;
        session_id_from(&result)
    }
}

/// The browser-level socket is only discoverable through the HTTP endpoint; it cannot be derived
/// from the port alone.
pub async fn browser_ws_url(endpoint: &str) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|error| error.to_string())?;
    let value: Value = client
        .get(format!("{endpoint}/json/version"))
        .send()
        .await
        .map_err(|error| format!("cdp_version_failed:{error}"))?
        .json()
        .await
        .map_err(|error| format!("cdp_version_body:{error}"))?;
    value
        .get("webSocketDebuggerUrl")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| "cdp_no_ws_url".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_request_without_a_session_carries_no_session_field() {
        let encoded = encode_request(7, "Page.enable", &Value::Null, None);
        let value: Value = serde_json::from_str(&encoded).expect("valid json");
        assert_eq!(value["id"], 7);
        assert_eq!(value["method"], "Page.enable");
        assert!(
            value.get("sessionId").is_none(),
            "a browser-level call must not be addressed to a tab session"
        );
        assert!(
            value.get("params").is_none(),
            "null params must be omitted, not sent as an explicit null"
        );
    }

    #[test]
    fn a_request_with_a_session_is_addressed_to_that_tab() {
        let encoded = encode_request(
            8,
            "Page.navigate",
            &json!({ "url": "https://example.com" }),
            Some("SESSION-1"),
        );
        let value: Value = serde_json::from_str(&encoded).expect("valid json");
        assert_eq!(value["sessionId"], "SESSION-1");
        assert_eq!(value["params"]["url"], "https://example.com");
    }

    #[test]
    fn a_successful_response_is_matched_by_id() {
        match parse_incoming("{\"id\":3,\"result\":{\"frameId\":\"F1\"}}") {
            Incoming::Response { id, result } => {
                assert_eq!(id, 3);
                assert_eq!(result.expect("ok")["frameId"], "F1");
            }
            other => panic!("expected a response, got {other:?}"),
        }
    }

    #[test]
    fn an_error_response_resolves_the_caller_instead_of_hanging() {
        match parse_incoming("{\"id\":4,\"error\":{\"code\":-32000,\"message\":\"No target\"}}") {
            Incoming::Response { id, result } => {
                assert_eq!(id, 4);
                assert_eq!(result.unwrap_err(), "-32000:No target");
            }
            other => panic!("expected a response, got {other:?}"),
        }
    }

    #[test]
    fn an_event_keeps_the_session_it_belongs_to() {
        let raw = "{\"method\":\"Page.screencastFrame\",\"params\":{\"data\":\"AA\"},\"sessionId\":\"S9\"}";
        match parse_incoming(raw) {
            Incoming::Event(event) => {
                assert_eq!(event.method, "Page.screencastFrame");
                assert_eq!(event.session_id.as_deref(), Some("S9"));
                assert_eq!(event.params["data"], "AA");
            }
            other => panic!("expected an event, got {other:?}"),
        }
    }

    #[test]
    fn malformed_traffic_is_dropped_rather_than_panicking() {
        assert!(matches!(parse_incoming("not json"), Incoming::Ignored));
        assert!(matches!(parse_incoming("{}"), Incoming::Ignored));
    }

    #[test]
    fn only_page_targets_are_offered_to_a_pane() {
        let result = json!({
            "targetInfos": [
                { "targetId": "T1", "type": "page", "title": "Tab", "url": "https://a" },
                { "targetId": "T2", "type": "service_worker", "title": "SW", "url": "https://b" },
                { "targetId": "T3", "type": "browser", "title": "", "url": "" }
            ]
        });
        let targets = page_targets_from(&result);
        assert_eq!(
            targets.len(),
            1,
            "workers and the browser target are not pages"
        );
        assert_eq!(targets[0].target_id, "T1");
    }

    #[test]
    fn a_target_missing_optional_fields_still_parses() {
        let result = json!({ "targetInfos": [{ "targetId": "T4", "type": "page" }] });
        assert_eq!(page_targets_from(&result)[0].target_id, "T4");
    }

    #[test]
    fn an_attach_without_a_session_is_an_error_not_an_empty_string() {
        assert_eq!(
            session_id_from(&json!({})).unwrap_err(),
            "cdp_attach_failed"
        );
        assert_eq!(
            session_id_from(&json!({ "sessionId": "S1" })).unwrap(),
            "S1"
        );
    }

    /// Needs a real browser, so it stays out of the default run:
    /// `ALETHE_CDP_ENDPOINT=http://127.0.0.1:PORT cargo test --lib cdp -- --ignored --nocapture`
    #[tokio::test]
    #[ignore]
    async fn drives_a_live_browser_end_to_end() {
        let endpoint = std::env::var("ALETHE_CDP_ENDPOINT")
            .expect("set ALETHE_CDP_ENDPOINT to a running browser");

        let ws = browser_ws_url(&endpoint).await.expect("browser ws url");
        let client = CdpClient::connect(&ws).await.expect("cdp connect");

        let targets = client.page_targets().await.expect("targets");
        assert!(!targets.is_empty(), "the browser must expose a page target");
        let session = client.attach(&targets[0].target_id).await.expect("attach");

        client
            .call("Page.enable", Value::Null, Some(&session))
            .await
            .expect("page enable");

        let evaluated = client
            .call(
                "Runtime.evaluate",
                json!({
                    "expression": "document.title = 'alethe-cdp-probe'; document.title",
                    "returnByValue": true
                }),
                Some(&session),
            )
            .await
            .expect("evaluate");
        assert_eq!(
            evaluated["result"]["value"], "alethe-cdp-probe",
            "a round trip must carry the evaluated value back"
        );

        let mut frames = client.subscribe();
        client
            .call(
                "Page.startScreencast",
                json!({ "format": "jpeg", "quality": 60, "maxWidth": 640, "maxHeight": 480 }),
                Some(&session),
            )
            .await
            .expect("start screencast");

        let frame = tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                match frames.recv().await {
                    Ok(event) if event.method == "Page.screencastFrame" => return event,
                    Ok(_) => continue,
                    Err(error) => panic!("event stream ended: {error}"),
                }
            }
        })
        .await
        .expect("a screencast frame must arrive within 10s");

        assert!(
            frame.params["data"].as_str().is_some_and(|d| !d.is_empty()),
            "a screencast frame must carry image data"
        );

        client
            .call("Page.stopScreencast", Value::Null, Some(&session))
            .await
            .expect("stop screencast");
    }
}
