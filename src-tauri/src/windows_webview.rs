/// Windows WebView2 Memory Management
///
/// Chamadas COM para controlar o consumo de RAM do WebView2:
///   - `ICoreWebView2ExperimentalSettings::put_MemoryUsageTargetLevel`
///   - `ICoreWebView2::TrySuspend` / `TryResume`
///

/// usar macros `#![allow(non_snake_case)]` com bindings `windows`/`windows-sys`
/// para chamar o COM diretamente via `IWebView2WebView::QueryInterface`.
///

///
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum WebViewMemoryMode {
    Normal,
    Low,
}

/// (equivalente a `COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW`).
///

/// ```cpp
/// auto settings = webview->GetSettings();
/// auto experimental = settings->QueryInterface<ICoreWebView2ExperimentalSettings>();
/// experimental->put_MemoryUsageTargetLevel(
///     low ? COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW
///         : COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL
/// );
/// ```
pub fn set_memory_mode(low: bool) -> Result<(), String> {
    if low {
        eprintln!("[WebView2] Memory mode → LOW (stub)");
    } else {
        eprintln!("[WebView2] Memory mode → NORMAL (stub)");
    }
    // TODO: implementar bindings COM para ICoreWebView2ExperimentalSettings
    Ok(())
}

///

/// ```cpp
/// HRESULT hr = webview->TrySuspend(&completed_handler);
/// ```
pub fn suspend() -> Result<(), String> {
    eprintln!("[WebView2] Suspend (stub)");
    // TODO: implementar bindings COM para TrySuspend
    Ok(())
}

pub fn resume() -> Result<(), String> {
    eprintln!("[WebView2] Resume (stub)");
    // TODO: implementar bindings COM para TryResume
    Ok(())
}
