use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::Extension;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use futures_util::{SinkExt, StreamExt};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::broadcast;

use super::{AuthenticatedLocalSession, CoreSyncEvent, ServerRuntime};

pub fn router() -> Router {
    Router::new().route("/api/events/ws", get(open_event_stream))
}

async fn open_event_stream(
    Extension(runtime): Extension<Arc<ServerRuntime>>,
    Extension(session): Extension<AuthenticatedLocalSession>,
    ws: WebSocketUpgrade,
) -> Response {
    let protocol = format!("alethe-auth.{}", session.token());
    ws.protocols([protocol])
        .on_upgrade(move |socket| stream_events(socket, runtime, session))
        .into_response()
}

async fn send_event(
    sender: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    event: &CoreSyncEvent,
) -> Result<(), ()> {
    let payload = serde_json::to_string(event).map_err(|_| ())?;
    sender.send(Message::Text(payload)).await.map_err(|_| ())
}

/// WS close code meaning "try again" (RFC 6455 §7.4.1 private-use range,
/// matching the value tungstenite/axum expose as `close_code::AGAIN`).
/// Sent explicitly so `coreEvents.ts`'s `onclose` handler reconnects with
/// backoff instead of the client being left on a socket that never got a
/// usable snapshot.
const WS_CLOSE_TRY_AGAIN: u16 = 1013;

async fn stream_events(
    socket: WebSocket,
    runtime: Arc<ServerRuntime>,
    session: AuthenticatedLocalSession,
) {
    let mut events = runtime.subscribe_sync_events();
    let initial = runtime.current_sync_event("connected");
    let (mut sender, mut receiver) = socket.split();

    match initial {
        Ok(event) => {
            if send_event(&mut sender, &event).await.is_err() {
                return;
            }
        }
        Err(_) => {
            // An invalid initial snapshot must never leave the client parked
            // on a socket with no state at all — close with a retryable code
            // so it reconnects (with backoff) instead of silently staying
            // stale.
            let _ = sender
                .send(Message::Close(Some(axum::extract::ws::CloseFrame {
                    code: WS_CLOSE_TRY_AGAIN,
                    reason: "initial_snapshot_unavailable".into(),
                })))
                .await;
            return;
        }
    }

    let mut revalidation = tokio::time::interval(Duration::from_secs(15));
    revalidation.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    loop {
        tokio::select! {
            received = events.recv() => {
                match received {
                    Ok(event) => {
                        if send_event(&mut sender, &event).await.is_err() {
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        let Ok(snapshot) = runtime.current_sync_event("recovered_after_lag") else {
                            break;
                        };
                        if send_event(&mut sender, &snapshot).await.is_err() {
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
            incoming = receiver.next() => {
                match incoming {
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                    _ => {}
                }
            }
            _ = revalidation.tick() => {
                if !runtime.session_is_valid(session.token()) {
                    break;
                }
                // Authoritative self-heal: resend the full catalog/revision
                // snapshot on every tick, not just a ping. This is the
                // equivalent of periodic reconciliation without reintroducing
                // frontend polling — any diff dropped for a reason other than
                // broadcast lag (e.g. a publish that failed to reach this
                // subscriber) heals itself within one interval.
                match runtime.current_sync_event("periodic_reconciliation") {
                    Ok(snapshot) => {
                        if send_event(&mut sender, &snapshot).await.is_err() {
                            break;
                        }
                    }
                    Err(_) => {
                        if sender.send(Message::Ping(Vec::new())).await.is_err() {
                            break;
                        }
                    }
                }
            }
        }
    }
}
