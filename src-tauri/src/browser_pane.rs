//! A browser tab rendered inside an Alethe pane.
//!
//! Frames arrive over CDP screencast and are forwarded to the frontend, which paints them on a
//! canvas; mouse and keyboard go back the same way. Unlike a native child webview, this is ordinary
//! DOM, so clipping, z-order and dragging come for free.
//!
//! Every pane gets its own tab in the browser `browser_session` owns — the same browser Playwright
//! MCP attaches to, so the agent and the user act on one browser instead of two.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::browser_session::{browser_session_start, BrowserSessionState};
use crate::cdp::{browser_ws_url, CdpClient};

const DEFAULT_QUALITY: u32 = 60;
const MOUSE_KINDS: [&str; 4] = ["mousePressed", "mouseReleased", "mouseMoved", "mouseWheel"];
const KEY_KINDS: [&str; 3] = ["keyDown", "keyUp", "char"];
const BUTTONS: [&str; 5] = ["none", "left", "middle", "right", "back"];

#[derive(Default)]
pub struct BrowserPaneState {
    client: tokio::sync::Mutex<Option<Arc<CdpClient>>>,
    panes: Arc<Mutex<HashMap<String, PaneAttachment>>>,
}

#[derive(Clone)]
struct PaneAttachment {
    target_id: String,
    session_id: String,
    // A tab the pane opened is the pane's to close. A tab an agent opened is only being watched,
    // and closing the pane must not take the agent's page down with it.
    owned: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserPaneInfo {
    pub pane_id: String,
    pub target_id: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FramePayload {
    pub data: String,
    pub device_width: f64,
    pub device_height: f64,
    pub offset_top: f64,
    pub page_scale_factor: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MouseInput {
    pub kind: String,
    pub x: f64,
    pub y: f64,
    pub button: Option<String>,
    pub click_count: Option<u32>,
    pub delta_x: Option<f64>,
    pub delta_y: Option<f64>,
    pub modifiers: Option<u32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyInput {
    pub kind: String,
    pub key: Option<String>,
    pub code: Option<String>,
    pub text: Option<String>,
    pub windows_virtual_key_code: Option<i64>,
    pub modifiers: Option<u32>,
}

pub const TARGET_OPENED_EVENT: &str = "browser-cdp://target-opened";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedPage {
    pub target_id: String,
    pub url: String,
    pub title: String,
}

/// A page worth offering to show. Blank tabs carry nothing to look at, and a target that is not a
/// page cannot be rendered at all.
pub fn opened_page_from(params: &Value) -> Option<OpenedPage> {
    let info = params.get("targetInfo")?;
    if info.get("type").and_then(Value::as_str)? != "page" {
        return None;
    }
    let url = info.get("url").and_then(Value::as_str).unwrap_or_default();
    if url.is_empty() || url == "about:blank" {
        return None;
    }
    Some(OpenedPage {
        target_id: info.get("targetId").and_then(Value::as_str)?.to_string(),
        url: url.to_string(),
        title: info
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
    })
}

pub fn frame_event_name(pane_id: &str) -> String {
    format!("browser-cdp://frame/{pane_id}")
}

pub fn screencast_params(width: u32, height: u32) -> Value {
    json!({
        "format": "jpeg",
        "quality": DEFAULT_QUALITY,
        "maxWidth": width.max(1),
        "maxHeight": height.max(1),
        "everyNthFrame": 1
    })
}

/// The viewport is pinned to the pane so a canvas pixel maps to a page pixel without a correction
/// factor, which is what keeps click coordinates honest.
pub fn device_metrics_params(width: u32, height: u32) -> Value {
    json!({
        "width": width.max(1),
        "height": height.max(1),
        "deviceScaleFactor": 0,
        "mobile": false
    })
}

pub fn frame_payload_from(params: &Value) -> Option<FramePayload> {
    let data = params.get("data")?.as_str()?.to_string();
    let metadata = params.get("metadata");
    let number = |key: &str, fallback: f64| {
        metadata
            .and_then(|meta| meta.get(key))
            .and_then(Value::as_f64)
            .unwrap_or(fallback)
    };
    Some(FramePayload {
        data,
        device_width: number("deviceWidth", 0.0),
        device_height: number("deviceHeight", 0.0),
        offset_top: number("offsetTop", 0.0),
        page_scale_factor: number("pageScaleFactor", 1.0),
    })
}

/// Chromium stops sending frames until the previous one is acknowledged, so a missed ack reads as
/// a frozen pane rather than as an error.
pub fn ack_id_from(params: &Value) -> Option<i64> {
    params.get("sessionId").and_then(Value::as_i64)
}

pub fn mouse_params(input: &MouseInput) -> Result<Value, String> {
    if !MOUSE_KINDS.contains(&input.kind.as_str()) {
        return Err(format!("unsupported_mouse_event:{}", input.kind));
    }
    let button = input.button.as_deref().unwrap_or("none");
    if !BUTTONS.contains(&button) {
        return Err(format!("unsupported_mouse_button:{button}"));
    }

    let mut params = json!({
        "type": input.kind,
        "x": input.x,
        "y": input.y,
        "button": button,
        "clickCount": input.click_count.unwrap_or(0),
        "modifiers": input.modifiers.unwrap_or(0)
    });
    if input.kind == "mouseWheel" {
        params["deltaX"] = json!(input.delta_x.unwrap_or(0.0));
        params["deltaY"] = json!(input.delta_y.unwrap_or(0.0));
    }
    Ok(params)
}

pub fn key_params(input: &KeyInput) -> Result<Value, String> {
    if !KEY_KINDS.contains(&input.kind.as_str()) {
        return Err(format!("unsupported_key_event:{}", input.kind));
    }
    let mut params = json!({
        "type": input.kind,
        "modifiers": input.modifiers.unwrap_or(0)
    });
    if let Some(key) = &input.key {
        params["key"] = json!(key);
    }
    if let Some(code) = &input.code {
        params["code"] = json!(code);
    }
    if let Some(text) = &input.text {
        params["text"] = json!(text);
    }
    if let Some(vk) = input.windows_virtual_key_code {
        params["windowsVirtualKeyCode"] = json!(vk);
        params["nativeVirtualKeyCode"] = json!(vk);
    }
    Ok(params)
}

fn attachment(
    panes: &Arc<Mutex<HashMap<String, PaneAttachment>>>,
    pane_id: &str,
) -> Result<PaneAttachment, String> {
    panes
        .lock()
        .map_err(|_| "browser pane lock poisoned")?
        .get(pane_id)
        .cloned()
        .ok_or_else(|| "pane_not_attached".to_string())
}

fn pane_for_session(
    panes: &Arc<Mutex<HashMap<String, PaneAttachment>>>,
    session: &str,
) -> Option<String> {
    panes
        .lock()
        .ok()?
        .iter()
        .find(|(_, pane)| pane.session_id == session)
        .map(|(id, _)| id.clone())
}

async fn ensure_client(
    app: &AppHandle,
    state: &BrowserPaneState,
) -> Result<Arc<CdpClient>, String> {
    let mut guard = state.client.lock().await;
    if let Some(client) = guard.as_ref() {
        return Ok(Arc::clone(client));
    }

    let session_state = app.state::<BrowserSessionState>();
    let info = browser_session_start(app.clone(), session_state, None).await?;
    let ws = browser_ws_url(&info.endpoint).await?;
    let client = CdpClient::connect(&ws).await?;

    spawn_frame_pump(app.clone(), Arc::clone(&client), Arc::clone(&state.panes));
    // Without discovery the client never hears about tabs it did not open itself, which is exactly
    // the case that matters: a page an agent just opened.
    let _ = client
        .call(
            "Target.setDiscoverTargets",
            json!({ "discover": true }),
            None,
        )
        .await;
    *guard = Some(Arc::clone(&client));
    Ok(client)
}

fn spawn_frame_pump(
    app: AppHandle,
    client: Arc<CdpClient>,
    panes: Arc<Mutex<HashMap<String, PaneAttachment>>>,
) {
    let offered: Arc<Mutex<std::collections::HashSet<String>>> = Arc::default();
    let mut events = client.subscribe();
    tauri::async_runtime::spawn(async move {
        while let Ok(event) = events.recv().await {
            // A page is worth offering when it first shows a real address. That is usually not when
            // the tab is created: an agent attaching over CDP navigates the blank tab already there,
            // which arrives as targetInfoChanged rather than targetCreated.
            if event.method == "Target.targetCreated" || event.method == "Target.targetInfoChanged"
            {
                if let Some(opened) = opened_page_from(&event.params) {
                    let owned = panes
                        .lock()
                        .map(|panes| {
                            panes
                                .values()
                                .any(|pane| pane.target_id == opened.target_id)
                        })
                        .unwrap_or(false);
                    // Offering the same tab again on every navigation would bury the reader in
                    // notifications about a page they already answered for.
                    let first_time = offered
                        .lock()
                        .map(|mut seen| seen.insert(opened.target_id.clone()))
                        .unwrap_or(false);
                    if !owned && first_time {
                        let _ = app.emit(TARGET_OPENED_EVENT, opened);
                    }
                }
                continue;
            }

            if event.method == "Target.targetDestroyed" {
                if let Some(id) = event.params.get("targetId").and_then(Value::as_str) {
                    if let Ok(mut seen) = offered.lock() {
                        seen.remove(id);
                    }
                }
                continue;
            }
            if event.method != "Page.screencastFrame" {
                continue;
            }
            let Some(session) = event.session_id.clone() else {
                continue;
            };
            let Some(pane_id) = pane_for_session(&panes, &session) else {
                continue;
            };

            if let Some(payload) = frame_payload_from(&event.params) {
                let _ = app.emit(&frame_event_name(&pane_id), payload);
            }
            if let Some(ack) = ack_id_from(&event.params) {
                let _ = client
                    .call(
                        "Page.screencastFrameAck",
                        json!({ "sessionId": ack }),
                        Some(&session),
                    )
                    .await;
            }
        }
    });
}

/// A background tab reports `visibilityState: "hidden"` and Chromium stops rendering it, so its
/// screencast yields no frames at all. Foregrounding the tab is what makes it produce a picture.
async fn bring_to_front(client: &Arc<CdpClient>, session: &str) {
    let _ = client
        .call("Page.bringToFront", Value::Null, Some(session))
        .await;
}

#[tauri::command]
pub async fn browser_pane_open(
    app: AppHandle,
    state: State<'_, BrowserPaneState>,
    pane_id: String,
    url: String,
    width: u32,
    height: u32,
) -> Result<BrowserPaneInfo, String> {
    let client = ensure_client(&app, &state).await?;

    let created = client
        .call("Target.createTarget", json!({ "url": url }), None)
        .await?;
    let target_id = created
        .get("targetId")
        .and_then(Value::as_str)
        .ok_or_else(|| "target_not_created".to_string())?
        .to_string();

    let session_id = client.attach(&target_id).await?;
    client
        .call("Page.enable", Value::Null, Some(&session_id))
        .await?;
    client
        .call(
            "Emulation.setDeviceMetricsOverride",
            device_metrics_params(width, height),
            Some(&session_id),
        )
        .await?;

    state
        .panes
        .lock()
        .map_err(|_| "browser pane lock poisoned")?
        .insert(
            pane_id.clone(),
            PaneAttachment {
                target_id: target_id.clone(),
                session_id: session_id.clone(),
                owned: true,
            },
        );

    bring_to_front(&client, &session_id).await;
    client
        .call(
            "Page.startScreencast",
            screencast_params(width, height),
            Some(&session_id),
        )
        .await?;

    Ok(BrowserPaneInfo { pane_id, target_id })
}

#[tauri::command]
pub async fn browser_pane_close(
    app: AppHandle,
    state: State<'_, BrowserPaneState>,
    pane_id: String,
) -> Result<(), String> {
    let pane = {
        let mut guard = state
            .panes
            .lock()
            .map_err(|_| "browser pane lock poisoned")?;
        guard.remove(&pane_id)
    };
    let Some(pane) = pane else { return Ok(()) };

    let client = ensure_client(&app, &state).await?;
    let _ = client
        .call("Page.stopScreencast", Value::Null, Some(&pane.session_id))
        .await;
    if pane.owned {
        let _ = client
            .call(
                "Target.closeTarget",
                json!({ "targetId": pane.target_id }),
                None,
            )
            .await;
    }
    Ok(())
}

/// Connects to the shared browser so the app can see what happens inside it. Nothing else does
/// this on its own: a pane connects only when it opens, so without this a page an agent opened
/// would go unnoticed until someone happened to open a pane by hand.
#[tauri::command]
pub async fn browser_pane_observe(
    app: AppHandle,
    state: State<'_, BrowserPaneState>,
) -> Result<(), String> {
    ensure_client(&app, &state).await?;
    Ok(())
}

/// Every page open in the shared browser, including the ones an agent opened.
#[tauri::command]
pub async fn browser_pane_targets(
    app: AppHandle,
    state: State<'_, BrowserPaneState>,
) -> Result<Vec<crate::cdp::CdpTarget>, String> {
    let client = ensure_client(&app, &state).await?;
    client.page_targets().await
}

/// Closes a tab in the shared browser. An agent that navigates a lot leaves tabs behind and
/// nothing else ever reaps them, so this is the only way to get rid of one.
#[tauri::command]
pub async fn browser_pane_close_target(
    app: AppHandle,
    state: State<'_, BrowserPaneState>,
    target_id: String,
) -> Result<(), String> {
    let client = ensure_client(&app, &state).await?;
    client
        .call("Target.closeTarget", json!({ "targetId": target_id }), None)
        .await?;

    // A pane pointed at the closed tab has nothing left to show; dropping the record stops it from
    // sending input to a session that no longer exists.
    if let Ok(mut panes) = state.panes.lock() {
        panes.retain(|_, pane| pane.target_id != target_id);
    }
    Ok(())
}

/// Points the pane at a tab that already exists, so an agent's page can be watched live.
#[tauri::command]
pub async fn browser_pane_watch(
    app: AppHandle,
    state: State<'_, BrowserPaneState>,
    pane_id: String,
    target_id: String,
    width: u32,
    height: u32,
) -> Result<(), String> {
    let client = ensure_client(&app, &state).await?;

    if let Ok(previous) = attachment(&state.panes, &pane_id) {
        if previous.target_id == target_id {
            return Ok(());
        }
        let _ = client
            .call(
                "Page.stopScreencast",
                Value::Null,
                Some(&previous.session_id),
            )
            .await;
    }

    let session_id = client.attach(&target_id).await?;
    client
        .call("Page.enable", Value::Null, Some(&session_id))
        .await?;

    // No device metrics override here: the viewport belongs to whoever opened the tab, and
    // resizing it under an agent would change what its own automation sees.
    state
        .panes
        .lock()
        .map_err(|_| "browser pane lock poisoned")?
        .insert(
            pane_id,
            PaneAttachment {
                target_id,
                session_id: session_id.clone(),
                owned: false,
            },
        );

    bring_to_front(&client, &session_id).await;
    client
        .call(
            "Page.startScreencast",
            screencast_params(width, height),
            Some(&session_id),
        )
        .await?;
    Ok(())
}

#[tauri::command]
pub async fn browser_pane_navigate(
    app: AppHandle,
    state: State<'_, BrowserPaneState>,
    pane_id: String,
    url: String,
) -> Result<(), String> {
    let pane = attachment(&state.panes, &pane_id)?;
    let client = ensure_client(&app, &state).await?;
    client
        .call(
            "Page.navigate",
            json!({ "url": url }),
            Some(&pane.session_id),
        )
        .await?;
    Ok(())
}

#[tauri::command]
pub async fn browser_pane_reload(
    app: AppHandle,
    state: State<'_, BrowserPaneState>,
    pane_id: String,
) -> Result<(), String> {
    let pane = attachment(&state.panes, &pane_id)?;
    let client = ensure_client(&app, &state).await?;
    // A plain reload re-serves whatever the cache holds, which is the opposite of what someone
    // pressing reload on a page they are actively editing wants.
    client
        .call(
            "Page.reload",
            json!({ "ignoreCache": true }),
            Some(&pane.session_id),
        )
        .await?;
    Ok(())
}

/// `delta` is -1 for back and 1 for forward; anything out of range is a no-op rather than an error.
#[tauri::command]
pub async fn browser_pane_history(
    app: AppHandle,
    state: State<'_, BrowserPaneState>,
    pane_id: String,
    delta: i64,
) -> Result<bool, String> {
    let pane = attachment(&state.panes, &pane_id)?;
    let client = ensure_client(&app, &state).await?;
    let history = client
        .call(
            "Page.getNavigationHistory",
            Value::Null,
            Some(&pane.session_id),
        )
        .await?;

    let Some(entry) = history_entry_at(&history, delta) else {
        return Ok(false);
    };
    client
        .call(
            "Page.navigateToHistoryEntry",
            json!({ "entryId": entry }),
            Some(&pane.session_id),
        )
        .await?;
    Ok(true)
}

pub fn history_entry_at(history: &Value, delta: i64) -> Option<i64> {
    let current = history.get("currentIndex")?.as_i64()?;
    let entries = history.get("entries")?.as_array()?;
    let index = current.checked_add(delta)?;
    if index < 0 || index as usize >= entries.len() {
        return None;
    }
    entries[index as usize].get("id")?.as_i64()
}

#[tauri::command]
pub async fn browser_pane_resize(
    app: AppHandle,
    state: State<'_, BrowserPaneState>,
    pane_id: String,
    width: u32,
    height: u32,
) -> Result<(), String> {
    let pane = attachment(&state.panes, &pane_id)?;
    let client = ensure_client(&app, &state).await?;
    client
        .call(
            "Emulation.setDeviceMetricsOverride",
            device_metrics_params(width, height),
            Some(&pane.session_id),
        )
        .await?;
    // Restarting is what makes Chromium emit frames at the new size; the override alone does not.
    let _ = client
        .call("Page.stopScreencast", Value::Null, Some(&pane.session_id))
        .await;
    client
        .call(
            "Page.startScreencast",
            screencast_params(width, height),
            Some(&pane.session_id),
        )
        .await?;
    Ok(())
}

/// Streaming a pane nobody can see is pure waste, so visibility drives the screencast.
#[tauri::command]
pub async fn browser_pane_set_streaming(
    app: AppHandle,
    state: State<'_, BrowserPaneState>,
    pane_id: String,
    streaming: bool,
    width: u32,
    height: u32,
) -> Result<(), String> {
    let pane = attachment(&state.panes, &pane_id)?;
    let client = ensure_client(&app, &state).await?;
    if streaming {
        client
            .call(
                "Page.startScreencast",
                screencast_params(width, height),
                Some(&pane.session_id),
            )
            .await?;
    } else {
        client
            .call("Page.stopScreencast", Value::Null, Some(&pane.session_id))
            .await?;
    }
    Ok(())
}

#[tauri::command]
pub async fn browser_pane_mouse(
    app: AppHandle,
    state: State<'_, BrowserPaneState>,
    pane_id: String,
    input: MouseInput,
) -> Result<(), String> {
    let pane = attachment(&state.panes, &pane_id)?;
    let params = mouse_params(&input)?;
    let client = ensure_client(&app, &state).await?;
    client
        .call("Input.dispatchMouseEvent", params, Some(&pane.session_id))
        .await?;
    Ok(())
}

#[tauri::command]
pub async fn browser_pane_key(
    app: AppHandle,
    state: State<'_, BrowserPaneState>,
    pane_id: String,
    input: KeyInput,
) -> Result<(), String> {
    let pane = attachment(&state.panes, &pane_id)?;
    let params = key_params(&input)?;
    let client = ensure_client(&app, &state).await?;
    client
        .call("Input.dispatchKeyEvent", params, Some(&pane.session_id))
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mouse(kind: &str) -> MouseInput {
        MouseInput {
            kind: kind.to_string(),
            x: 10.0,
            y: 20.0,
            button: Some("left".to_string()),
            click_count: Some(1),
            delta_x: None,
            delta_y: None,
            modifiers: None,
        }
    }

    #[test]
    fn a_blank_tab_navigating_somewhere_real_is_the_common_case() {
        // An agent attaching over CDP navigates the blank tab that is already there instead of
        // opening a new one, so the page arrives as a change to an existing target.
        let params = json!({
            "targetInfo": { "targetId": "T5", "type": "page", "url": "http://localhost:8787/x", "title": "X" }
        });
        let page = opened_page_from(&params).expect("a navigated tab is still a page to offer");
        assert_eq!(page.target_id, "T5");
        assert_eq!(page.url, "http://localhost:8787/x");
    }

    #[test]
    fn a_page_an_agent_opened_is_offered() {
        let page = opened_page_from(&json!({
            "targetInfo": { "targetId": "T9", "type": "page", "url": "https://a.test/x", "title": "Alfa" }
        }))
        .expect("page");
        assert_eq!(page.target_id, "T9");
        assert_eq!(page.url, "https://a.test/x");
        assert_eq!(page.title, "Alfa");
    }

    #[test]
    fn nothing_worth_looking_at_is_offered() {
        // A blank tab has nothing to show, and only a page can be rendered at all.
        assert!(opened_page_from(&json!({
            "targetInfo": { "targetId": "T1", "type": "page", "url": "about:blank" }
        }))
        .is_none());
        assert!(opened_page_from(&json!({
            "targetInfo": { "targetId": "T2", "type": "page", "url": "" }
        }))
        .is_none());
        assert!(opened_page_from(&json!({
            "targetInfo": { "targetId": "T3", "type": "service_worker", "url": "https://a.test" }
        }))
        .is_none());
        assert!(opened_page_from(&json!({})).is_none());
    }

    #[test]
    fn a_page_without_a_title_is_still_offered() {
        let page = opened_page_from(&json!({
            "targetInfo": { "targetId": "T4", "type": "page", "url": "https://a.test" }
        }))
        .expect("page");
        assert_eq!(page.title, "", "a missing title must not drop the offer");
    }

    #[test]
    fn a_frame_event_is_addressed_to_one_pane() {
        assert_eq!(frame_event_name("pane-7"), "browser-cdp://frame/pane-7");
    }

    #[test]
    fn a_frame_carries_the_page_size_it_was_captured_at() {
        let params = json!({
            "data": "BASE64",
            "metadata": {
                "deviceWidth": 800.0,
                "deviceHeight": 600.0,
                "offsetTop": 12.0,
                "pageScaleFactor": 2.0
            }
        });
        let payload = frame_payload_from(&params).expect("payload");
        assert_eq!(payload.data, "BASE64");
        assert_eq!(payload.device_width, 800.0);
        assert_eq!(payload.device_height, 600.0);
        assert_eq!(payload.offset_top, 12.0);
        assert_eq!(payload.page_scale_factor, 2.0);
    }

    #[test]
    fn a_frame_without_metadata_still_paints() {
        let payload = frame_payload_from(&json!({ "data": "X" })).expect("payload");
        assert_eq!(
            payload.page_scale_factor, 1.0,
            "a missing scale must fall back to 1, never to 0"
        );
    }

    #[test]
    fn a_frame_without_image_data_is_rejected() {
        assert!(frame_payload_from(&json!({ "metadata": {} })).is_none());
    }

    #[test]
    fn the_ack_id_is_read_from_the_frame() {
        assert_eq!(ack_id_from(&json!({ "sessionId": 42 })), Some(42));
        assert_eq!(ack_id_from(&json!({})), None);
    }

    #[test]
    fn only_known_mouse_events_reach_the_browser() {
        for kind in MOUSE_KINDS {
            assert!(mouse_params(&mouse(kind)).is_ok(), "{kind} must be allowed");
        }
        let error = mouse_params(&mouse("dragStart")).unwrap_err();
        assert_eq!(error, "unsupported_mouse_event:dragStart");
    }

    #[test]
    fn an_unknown_button_is_refused_rather_than_forwarded() {
        let mut input = mouse("mousePressed");
        input.button = Some("elbow".to_string());
        assert_eq!(
            mouse_params(&input).unwrap_err(),
            "unsupported_mouse_button:elbow"
        );
    }

    #[test]
    fn wheel_deltas_are_sent_only_for_wheel_events() {
        let mut wheel = mouse("mouseWheel");
        wheel.delta_y = Some(-120.0);
        let params = mouse_params(&wheel).expect("wheel");
        assert_eq!(params["deltaY"], -120.0);
        assert_eq!(params["deltaX"], 0.0);

        let click = mouse_params(&mouse("mousePressed")).expect("click");
        assert!(
            click.get("deltaY").is_none(),
            "a click must not carry scroll deltas"
        );
    }

    #[test]
    fn a_key_event_carries_both_virtual_key_codes() {
        let input = KeyInput {
            kind: "keyDown".to_string(),
            key: Some("a".to_string()),
            code: Some("KeyA".to_string()),
            text: Some("a".to_string()),
            windows_virtual_key_code: Some(65),
            modifiers: Some(0),
        };
        let params = key_params(&input).expect("key");
        assert_eq!(params["windowsVirtualKeyCode"], 65);
        assert_eq!(
            params["nativeVirtualKeyCode"], 65,
            "Chromium needs the native code too or the key does nothing"
        );
        assert_eq!(params["text"], "a");
    }

    #[test]
    fn only_known_key_events_reach_the_browser() {
        let input = KeyInput {
            kind: "keyPress".to_string(),
            key: None,
            code: None,
            text: None,
            windows_virtual_key_code: None,
            modifiers: None,
        };
        assert_eq!(
            key_params(&input).unwrap_err(),
            "unsupported_key_event:keyPress"
        );
    }

    #[test]
    fn the_viewport_never_collapses_to_zero() {
        let params = device_metrics_params(0, 0);
        assert_eq!(params["width"], 1);
        assert_eq!(params["height"], 1);
        let cast = screencast_params(0, 0);
        assert_eq!(cast["maxWidth"], 1);
        assert_eq!(cast["maxHeight"], 1);
    }

    /// Needs a real browser and the lab page, so it stays out of the default run:
    /// `ALETHE_CDP_ENDPOINT=http://127.0.0.1:PORT cargo test --lib browser_pane -- --ignored`
    #[tokio::test]
    #[ignore]
    async fn a_click_sent_to_the_pane_reaches_the_page() {
        use crate::cdp::{browser_ws_url, CdpClient};

        let endpoint = std::env::var("ALETHE_CDP_ENDPOINT")
            .expect("set ALETHE_CDP_ENDPOINT to a running browser");
        let page = std::env::var("ALETHE_LAB_URL").expect("set ALETHE_LAB_URL to the lab page");

        let ws = browser_ws_url(&endpoint).await.expect("ws url");
        let client = CdpClient::connect(&ws).await.expect("connect");

        // Reproduces the real failure: with other tabs already open the new one is in the
        // background, where Chromium reports it hidden and stops rendering it entirely.
        for _ in 0..3 {
            let _ = client
                .call("Target.createTarget", json!({ "url": "about:blank" }), None)
                .await;
        }

        let created = client
            .call("Target.createTarget", json!({ "url": page }), None)
            .await
            .expect("create target");
        let target_id = created["targetId"].as_str().expect("targetId").to_string();
        let session = client.attach(&target_id).await.expect("attach");

        for _ in 0..3 {
            let _ = client
                .call("Target.createTarget", json!({ "url": "about:blank" }), None)
                .await;
        }
        bring_to_front(&client, &session).await;

        client
            .call("Page.enable", Value::Null, Some(&session))
            .await
            .expect("page enable");
        client
            .call(
                "Emulation.setDeviceMetricsOverride",
                device_metrics_params(800, 600),
                Some(&session),
            )
            .await
            .expect("device metrics");

        let mut frames = client.subscribe();
        client
            .call(
                "Page.startScreencast",
                screencast_params(800, 600),
                Some(&session),
            )
            .await
            .expect("start screencast");

        let frame = tokio::time::timeout(std::time::Duration::from_secs(15), async {
            loop {
                match frames.recv().await {
                    Ok(event)
                        if event.method == "Page.screencastFrame"
                            && event.session_id.as_deref() == Some(session.as_str()) =>
                    {
                        return event
                    }
                    Ok(_) => continue,
                    Err(error) => panic!("event stream ended: {error}"),
                }
            }
        })
        .await
        .expect("a frame must arrive");

        let payload = frame_payload_from(&frame.params).expect("payload");
        assert!(!payload.data.is_empty(), "the frame must carry image data");
        assert_eq!(
            payload.device_width, 800.0,
            "the emulated viewport must match the pane it was opened for"
        );
        let ack = ack_id_from(&frame.params).expect("ack id");
        client
            .call(
                "Page.screencastFrameAck",
                json!({ "sessionId": ack }),
                Some(&session),
            )
            .await
            .expect("ack");

        let spot = client
            .call(
                "Runtime.evaluate",
                json!({
                    "expression": "(() => { const r = document.querySelector('#increment').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()",
                    "returnByValue": true
                }),
                Some(&session),
            )
            .await
            .expect("locate the button");
        let point = &spot["result"]["value"];
        let x = point["x"].as_f64().expect("x");
        let y = point["y"].as_f64().expect("y");

        for kind in ["mousePressed", "mouseReleased"] {
            let input = MouseInput {
                kind: kind.to_string(),
                x,
                y,
                button: Some("left".to_string()),
                click_count: Some(1),
                delta_x: None,
                delta_y: None,
                modifiers: None,
            };
            client
                .call(
                    "Input.dispatchMouseEvent",
                    mouse_params(&input).expect("mouse params"),
                    Some(&session),
                )
                .await
                .expect("dispatch");
        }

        let count = client
            .call(
                "Runtime.evaluate",
                json!({
                    "expression": "document.querySelector('#count').textContent",
                    "returnByValue": true
                }),
                Some(&session),
            )
            .await
            .expect("read the counter");
        assert_eq!(
            count["result"]["value"], "1",
            "the click has to land on the page, not merely be accepted by the protocol"
        );

        let _ = client
            .call("Target.closeTarget", json!({ "targetId": target_id }), None)
            .await;
    }

    #[test]
    fn history_navigation_stops_at_both_ends() {
        let history = json!({
            "currentIndex": 1,
            "entries": [{ "id": 10 }, { "id": 11 }, { "id": 12 }]
        });
        assert_eq!(history_entry_at(&history, -1), Some(10));
        assert_eq!(history_entry_at(&history, 1), Some(12));

        let first = json!({ "currentIndex": 0, "entries": [{ "id": 10 }] });
        assert_eq!(
            history_entry_at(&first, -1),
            None,
            "there is nothing before the first entry"
        );
        assert_eq!(history_entry_at(&first, 1), None);
    }
}
