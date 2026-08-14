//! Estilo nativo da janela — só macOS.
//!
//! Como a janela roda com `decorations: false` (title bar custom do Alethe), o
//! macOS não aplica os cantos arredondados que uma janela nativa teria. Aqui
//! reintroduzimos esse arredondamento no nível do AppKit: tornamos a NSWindow
//! transparente e recortamos o `contentView` com um `cornerRadius`, para que a
//! janela do app tenha cantos arredondados no estilo do macOS moderno.
//!
//! Em Windows/Linux este módulo é um no-op (a função existe, mas o corpo com
//! AppKit fica atrás de `cfg(target_os = "macos")`).

/// Raio dos cantos, em pontos AppKit. Acima do padrão do macOS
/// (Sequoia/Tahoe ~10pt) para um visual mais arredondado.
#[cfg(target_os = "macos")]
const CORNER_RADIUS: f64 = 16.0;

/// Arredonda os cantos da janela `main` no macOS. No-op nas outras plataformas.
pub fn apply_rounded_corners(app: &tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    {
        use tauri::Manager;

        let Some(window) = app.get_webview_window("main") else {
            return;
        };
        if let Err(e) = round_macos_window(&window) {
            eprintln!("[window_style] falha ao arredondar a janela: {e}");
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
        .map_err(|e| format!("ns_window indisponível: {e}"))?;
    if ns_window_ptr.is_null() {
        return Err("ns_window retornou ponteiro nulo".into());
    }

    // SAFETY: ns_window_ptr é uma NSWindow* válida fornecida pelo Tauri. Todas
    // as mensagens abaixo (setOpaque:, setBackgroundColor:, contentView,
    // wantsLayer/layer) são da API pública de NSWindow/NSView e rodam na main
    // thread (o setup do Tauri roda nela).
    unsafe {
        let ns_window: &AnyObject = &*(ns_window_ptr as *const AnyObject);

        // Janela transparente: sem isto, os cantos recortados do contentView
        // revelariam o fundo opaco da janela (um "L" escuro em cada canto).
        let _: () = objc2::msg_send![ns_window, setOpaque: false];
        let clear: *mut AnyObject = objc2::msg_send![objc2::class!(NSColor), clearColor];
        let _: () = objc2::msg_send![ns_window, setBackgroundColor: clear];

        // Recorta o contentView com cornerRadius. O conteúdo (WebView) é
        // desenhado dentro dessa view, então o clip a arredonda junto.
        let content: *mut AnyObject = objc2::msg_send![ns_window, contentView];
        if content.is_null() {
            return Err("contentView nula".into());
        }
        let _: () = objc2::msg_send![content, setWantsLayer: true];
        let layer: *mut AnyObject = objc2::msg_send![content, layer];
        if layer.is_null() {
            return Err("layer do contentView nula".into());
        }
        let _: () = objc2::msg_send![layer, setCornerRadius: CORNER_RADIUS];
        let _: () = objc2::msg_send![layer, setMasksToBounds: true];
    }

    Ok(())
}
