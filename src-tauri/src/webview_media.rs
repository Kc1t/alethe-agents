//! Grant microphone capture inside the embedded webview.
//!
//! On Linux, WebKitGTK ships with media-stream disabled and denies any
//! `permission-request` the embedder does not handle — so `getUserMedia`
//! fails or returns a silent track. Enable the setting and allow requests.

use tauri::WebviewWindow;

#[cfg(target_os = "linux")]
pub fn grant_media_permissions(window: &WebviewWindow) {
    let label = window.label().to_string();
    let result = window.with_webview(move |webview| {
        use webkit2gtk::{PermissionRequestExt, SettingsExt, WebViewExt};

        let wk = webview.inner();
        if let Some(settings) = WebViewExt::settings(&wk) {
            settings.set_enable_media_stream(true);
            settings.set_enable_mediasource(true);
            settings.set_media_playback_requires_user_gesture(false);
            eprintln!("[speech] WebKitGTK media-stream enabled on '{label}'");
        }

        // WebKitGTK denies unhandled permission-request signals. Allow so
        // getUserMedia can open the mic; the OS privacy toggle still applies.
        wk.connect_permission_request(|_, request| {
            request.allow();
            true
        });
    });

    if let Err(error) = result {
        eprintln!("[speech] failed to grant WebKit media permissions: {error}");
    }
}

#[cfg(not(target_os = "linux"))]
pub fn grant_media_permissions(_window: &WebviewWindow) {}
