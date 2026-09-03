//! Carries the frontend's correlation id across the IPC boundary.
//!
//! Every command invocation is one edge of a user gesture. Without a shared key, a record written
//! in the UI and the records written by the Rust code it triggered are two piles of lines in two
//! files, and lining them up means guessing from timestamps. With one, `grep '"corr":"g_7f3a"'`
//! returns the whole story of a single click in order — which is the difference between "the send
//! failed somewhere" and "the enqueue happened and the transmit never did".
//!
//! The id rides as a `__corr` key in the invoke arguments. That is safe because Tauri extracts
//! command parameters **one key at a time** (`CommandItem::key`), never by deserializing the whole
//! payload into a struct — so a key no command declares is simply never read, and no existing
//! command signature has to change to make room for it.

use tauri::ipc::{Invoke, InvokeBody};
use tauri::Runtime;

/// The argument key the frontend attaches the correlation id to. Underscore-prefixed so it cannot
/// collide with a real parameter name.
pub const CORRELATION_ARG: &str = "__corr";

/// Reads the correlation id out of an invocation's arguments, if the frontend attached one.
fn correlation_of<R: Runtime>(invoke: &Invoke<R>) -> Option<String> {
    let InvokeBody::Json(serde_json::Value::Object(map)) = invoke.message.payload() else {
        return None;
    };
    match map.get(CORRELATION_ARG) {
        Some(serde_json::Value::String(value)) if !value.is_empty() => Some(value.clone()),
        _ => None,
    }
}

/// Wraps the generated command handler so every invocation runs inside a span carrying its
/// correlation id and command name.
///
/// Records emitted by the command body inherit both, including across `.await` — which is the
/// reason this is built on `tracing` spans rather than a thread-local. A thread-local is dropped
/// the moment a future yields, which for the chat and spawn paths is nearly immediately, and it
/// would have correlated exactly the synchronous prologue nobody needs correlated.
pub fn correlated<R: Runtime, F>(handler: F) -> impl Fn(Invoke<R>) -> bool + Send + Sync + 'static
where
    F: Fn(Invoke<R>) -> bool + Send + Sync + 'static,
{
    move |invoke| {
        let command = invoke.message.command().to_string();
        let corr = correlation_of(&invoke).unwrap_or_default();
        let span = tracing::info_span!(
            target: "alethe.ipc",
            "invoke",
            corr = corr.as_str(),
            command = command.as_str(),
        );
        let _entered = span.enter();
        // One record per invocation, before dispatch. This alone answers "did the UI actually call
        // the backend, or did it stop earlier?" — a question that previously had no evidence either
        // way, because a call that was never made and a call that failed silently look the same.
        tracing::debug!(target: "alethe.ipc", command = command.as_str(), "invoke");
        handler(invoke)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_correlation_key_is_namespaced_away_from_real_parameters() {
        // A command parameter is looked up by its exact name, so this key only stays invisible to
        // every command as long as no command ever declares a parameter called `__corr`.
        assert!(CORRELATION_ARG.starts_with("__"));
    }
}
