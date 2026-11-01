/// Rounder than the system default (~10pt on Sequoia/Tahoe).
#[cfg(target_os = "macos")]
const CORNER_RADIUS: f64 = 16.0;

pub fn apply_rounded_corners(app: &tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    {
        use tauri::Manager;

        let Some(window) = app.get_webview_window("main") else {
            return;
        };
        // macOS already rounds a native frame; clipping contentView too would misalign the corners.
        if window.is_decorated().unwrap_or(false) {
            return;
        }
        if let Err(e) = round_macos_window(&window) {
            eprintln!("[window_style] could not round the window: {e}");
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
    }
}

#[cfg(target_os = "macos")]
fn round_macos_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    use objc2::runtime::AnyObject;

    let ns_window_ptr = window
        .ns_window()
        .map_err(|e| format!("ns_window unavailable: {e}"))?;
    if ns_window_ptr.is_null() {
        return Err("ns_window returned a null pointer".into());
    }

    // SAFETY: a valid NSWindow, messaged on the main thread (Tauri setup runs there).
    unsafe {
        let ns_window: &AnyObject = &*(ns_window_ptr as *const AnyObject);

        let _: () = objc2::msg_send![ns_window, setOpaque: false];
        let clear: *mut AnyObject = objc2::msg_send![objc2::class!(NSColor), clearColor];
        let _: () = objc2::msg_send![ns_window, setBackgroundColor: clear];

        let content: *mut AnyObject = objc2::msg_send![ns_window, contentView];
        if content.is_null() {
            return Err("contentView is null".into());
        }
        let _: () = objc2::msg_send![content, setWantsLayer: true];
        let layer: *mut AnyObject = objc2::msg_send![content, layer];
        if layer.is_null() {
            return Err("contentView layer is null".into());
        }
        let _: () = objc2::msg_send![layer, setCornerRadius: CORNER_RADIUS];
        let _: () = objc2::msg_send![layer, setMasksToBounds: true];
    }

    Ok(())
}
