//! Bridge nativo macOS para o backend de terminal Ghostty.
//!

//! Windows/Linux ele vira um conjunto de stubs que retornam erro, para que o
//! `invoke_handler` continue registrando os mesmos comandos em todas as

//!

//! mesma `NSWindow`. O frontend desenha um placeholder `<div data-surface-id>`

//!

use serde::Serialize;

/// como o `getBoundingClientRect()` do placeholder reporta.
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, serde::Deserialize)]
pub struct WebRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Serialize)]
pub struct GhosttySurfaceResponse {
    pub id: String,

    pub attached: bool,
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
#[cfg(target_os = "macos")]
mod imp {
    use super::{GhosttySurfaceResponse, WebRect};
    use std::collections::HashMap;
    use std::sync::Mutex;

    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    #[cfg(not(ghostty_linked))]
    use objc2_app_kit::NSColor;
    use objc2_app_kit::NSView;
    use objc2_foundation::{MainThreadMarker, NSRect};
    use tauri::{Manager, State};

    #[cfg(ghostty_linked)]
    static PROBE_STARTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    #[cfg(ghostty_linked)]
    static WATCH_STARTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

    /// Registro global de surfaces vivas: surfaceId -> NSView nativa.

    #[derive(Default)]
    pub struct GhosttySurfaces {
        // Guardamos o ponteiro como usize para o mapa ser Send/Sync; a NSView
        views: Mutex<HashMap<String, SurfaceEntry>>,

        // check e criar duas surfaces (over-spawn do StrictMode). #4
        reserving: Mutex<std::collections::HashSet<String>>,
    }

    impl GhosttySurfaces {
        pub fn try_reserve(&self, id: &str) -> bool {
            let views = self.views.lock().expect("views lock");
            if views.contains_key(id) {
                return false;
            }
            let mut reserving = self.reserving.lock().expect("reserving lock");
            reserving.insert(id.to_string())
        }

        /// mapa de views).
        pub fn release_reservation(&self, id: &str) {
            if let Ok(mut reserving) = self.reserving.lock() {
                reserving.remove(id);
            }
        }
    }

    struct SurfaceEntry {
        last_scale: f64,

        #[cfg(ghostty_linked)]
        surface: crate::ghostty_ffi::AletheSurface,

        #[cfg(not(ghostty_linked))]
        view: Retained<NSView>,
    }

    unsafe impl Send for SurfaceEntry {}
    unsafe impl Sync for SurfaceEntry {}

    pub type GhosttyState = GhosttySurfaces;

    /// esquerda no AppKit), respeitando a altura total da content view.
    fn web_rect_to_appkit_frame(content_height: f64, rect: WebRect) -> NSRect {
        // basta inverter o eixo Y usando a altura da content view.
        let appkit_y = content_height - rect.y - rect.height;
        NSRect::new(
            objc2_foundation::NSPoint::new(rect.x, appkit_y),
            objc2_foundation::NSSize::new(rect.width.max(1.0), rect.height.max(1.0)),
        )
    }

    fn content_view(
        window: &tauri::WebviewWindow,
        _mtm: MainThreadMarker,
    ) -> Result<Retained<NSView>, String> {
        let ns_window_ptr = window
            .ns_window()
            .map_err(|e| format!("ns_window indisponível: {e}"))?;
        if ns_window_ptr.is_null() {
            return Err("ns_window retornou ponteiro nulo".into());
        }

        unsafe {
            let ns_window: &AnyObject = &*(ns_window_ptr as *const AnyObject);
            let content: *mut NSView = objc2::msg_send![ns_window, contentView];
            if content.is_null() {
                return Err("contentView nula".into());
            }
            Retained::retain(content).ok_or_else(|| "falha ao reter contentView".into())
        }
    }

    pub fn spawn(
        app: &tauri::AppHandle,
        state: &State<'_, GhosttyState>,
        id: String,
        cwd: Option<String>,
        command: Option<String>,
    ) -> Result<GhosttySurfaceResponse, String> {
        let mtm = MainThreadMarker::new()
            .ok_or_else(|| "ghostty_spawn precisa rodar na main thread".to_string())?;
        let _ = (&cwd, &command);

        // (o StrictMode chamava spawn 2x e gerava over-spawn).
        if !state.try_reserve(&id) {
            return Ok(GhosttySurfaceResponse { id, attached: true });
        }

        struct ReservationGuard<'a> {
            state: &'a GhosttyState,
            id: String,
            active: bool,
        }
        impl<'a> Drop for ReservationGuard<'a> {
            fn drop(&mut self) {
                if self.active {
                    self.state.release_reservation(&self.id);
                }
            }
        }
        let mut guard = ReservationGuard {
            state,
            id: id.clone(),
            active: true,
        };

        let window = app
            .get_webview_window("main")
            .ok_or_else(|| "janela 'main' não encontrada".to_string())?;
        let content = content_view(&window, mtm)?;

        #[cfg(ghostty_linked)]
        let entry = {
            use crate::ghostty_ffi::*;
            use std::ffi::CString;
            let content_ptr = objc2::rc::Retained::as_ptr(&content) as *mut std::ffi::c_void;
            let scale = window.scale_factor().unwrap_or(2.0);

            let cwd_c = cwd
                .as_deref()
                .filter(|s| !s.trim().is_empty())
                .and_then(|s| CString::new(s).ok());
            let cmd_c = command
                .as_deref()
                .filter(|s| !s.trim().is_empty())
                .and_then(|s| CString::new(s).ok());
            let s = unsafe {
                alethe_ghostty_surface_new(
                    content_ptr,
                    cwd_c.as_ref().map_or(std::ptr::null(), |c| c.as_ptr()),
                    cmd_c.as_ref().map_or(std::ptr::null(), |c| c.as_ptr()),
                    scale,
                )
            };
            if s.is_null() {
                eprintln!("[alethe-ghostty] surface_new FALHOU id={id}");
                return Err("ghostty_surface_new retornou null".into());
            }
            eprintln!("[alethe-ghostty] surface criada id={id}");

            // estabilizar, digitamos um echo e lemos o grid de volta — provando o

            if std::env::var("ALETHE_GHOSTTY_PROBE").as_deref() == Ok("1")
                && !PROBE_STARTED.swap(true, std::sync::atomic::Ordering::SeqCst)
            {
                let app_thread = app.clone();
                std::thread::spawn(move || {
                    // Espera o StrictMode assentar e o shell iniciar.
                    std::thread::sleep(std::time::Duration::from_secs(5));
                    for attempt in 1..=10 {
                        let app_main = app_thread.clone();
                        let (tx, rx) = std::sync::mpsc::channel::<Option<String>>();
                        let _ = app_thread.run_on_main_thread(move || {
                            use tauri::Manager;
                            let state = app_main.state::<GhosttyState>();
                            // Pega qualquer surface viva no momento.
                            let live_id = {
                                let v = state.views.lock().ok();
                                v.and_then(|m| m.keys().next().cloned())
                            };
                            let result = live_id.and_then(|lid| {
                                debug_send_read(
                                    &state,
                                    lid,
                                    "echo alethe_app_marker_99\r".to_string(),
                                )
                                .ok()
                            });
                            let _ = tx.send(result);
                        });
                        if let Ok(Some(screen)) = rx.recv() {
                            let ok = screen.contains("alethe_app_marker_99");
                            let preview: String = screen
                                .lines()
                                .filter(|l| !l.trim().is_empty())
                                .take(3)
                                .collect::<Vec<_>>()
                                .join(" | ");
                            eprintln!("[alethe-ghostty] PROBE echo_visivel={ok} tela: {preview}");
                            return;
                        }
                        std::thread::sleep(std::time::Duration::from_secs(1));
                        let _ = attempt;
                    }
                    eprintln!("[alethe-ghostty] PROBE erro: nenhuma surface viva após retries");
                });
            }

            if std::env::var("ALETHE_GHOSTTY_WATCH").as_deref() == Ok("1")
                && !WATCH_STARTED.swap(true, std::sync::atomic::Ordering::SeqCst)
            {
                let app_w = app.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(4));
                    for _ in 0..30 {
                        let app_m = app_w.clone();
                        let (tx, rx) = std::sync::mpsc::channel::<Option<String>>();
                        let _ = app_w.run_on_main_thread(move || {
                            use tauri::Manager;
                            let st = app_m.state::<GhosttyState>();
                            let id = st.views.lock().ok().and_then(|m| m.keys().next().cloned());
                            let r = id.and_then(|i| debug_send_read(&st, i, String::new()).ok());
                            let _ = tx.send(r);
                        });
                        if let Ok(Some(screen)) = rx.recv() {
                            let last: String = screen
                                .lines()
                                .rfind(|l| !l.trim().is_empty())
                                .unwrap_or("(vazio)")
                                .to_string();
                            eprintln!("[alethe-ghostty] WATCH última-linha: {last}");
                        }
                        std::thread::sleep(std::time::Duration::from_secs(2));
                    }
                });
            }

            SurfaceEntry {
                last_scale: scale,
                surface: s,
            }
        };

        #[cfg(not(ghostty_linked))]
        let entry = {
            let v = NSView::new(mtm);
            v.setWantsLayer(true);
            content.addSubview(&v);
            unsafe {
                if let Some(layer) = v.layer() {
                    let color = NSColor::colorWithSRGBRed_green_blue_alpha(0.06, 0.07, 0.09, 1.0);
                    let cg = color.CGColor();
                    let _: () = objc2::msg_send![&*layer, setBackgroundColor: &*cg];
                }
            }
            SurfaceEntry {
                last_scale: 1.0,
                view: v,
            }
        };

        {
            let mut views = state
                .views
                .lock()
                .map_err(|_| "lock poisoned".to_string())?;
            views.insert(id.clone(), entry);
        }

        // disparar de novo).
        guard.active = false;
        state.release_reservation(&id);

        Ok(GhosttySurfaceResponse { id, attached: true })
    }

    pub fn sync_frame(
        app: &tauri::AppHandle,
        state: &State<'_, GhosttyState>,
        id: String,
        rect: WebRect,
        scale: f64,
    ) -> Result<(), String> {
        let mtm = MainThreadMarker::new()
            .ok_or_else(|| "ghostty_sync_frame precisa rodar na main thread".to_string())?;
        let window = app
            .get_webview_window("main")
            .ok_or_else(|| "janela 'main' não encontrada".to_string())?;
        let content = content_view(&window, mtm)?;
        let content_height = content.frame().size.height;

        let mut views = state
            .views
            .lock()
            .map_err(|_| "lock poisoned".to_string())?;
        let entry = views
            .get_mut(&id)
            .ok_or_else(|| format!("surface não encontrada: {id}"))?;
        let frame = web_rect_to_appkit_frame(content_height, rect);
        entry.last_scale = scale;

        #[cfg(ghostty_linked)]
        {
            use crate::ghostty_ffi::*;
            if !entry.surface.is_null() {
                let w = (rect.width * scale).round().max(1.0) as u32;
                let h = (rect.height * scale).round().max(1.0) as u32;
                unsafe {
                    alethe_ghostty_surface_set_frame(
                        entry.surface,
                        frame.origin.x,
                        frame.origin.y,
                        frame.size.width,
                        frame.size.height,
                    );
                    alethe_ghostty_surface_set_content_scale(entry.surface, scale, scale);
                    alethe_ghostty_surface_set_size(entry.surface, w, h);
                    alethe_ghostty_surface_draw(entry.surface);
                }
            }
        }
        #[cfg(not(ghostty_linked))]
        {
            entry.view.setFrame(frame);
        }
        Ok(())
    }

    pub fn set_hidden(
        state: &State<'_, GhosttyState>,
        id: String,
        hidden: bool,
    ) -> Result<(), String> {
        let _mtm = MainThreadMarker::new()
            .ok_or_else(|| "ghostty_set_hidden precisa rodar na main thread".to_string())?;
        let mut views = state
            .views
            .lock()
            .map_err(|_| "lock poisoned".to_string())?;
        if let Some(entry) = views.get_mut(&id) {
            #[cfg(ghostty_linked)]
            {
                use crate::ghostty_ffi::*;
                if !entry.surface.is_null() {
                    unsafe { alethe_ghostty_surface_set_hidden(entry.surface, hidden) };
                }
            }
            #[cfg(not(ghostty_linked))]
            {
                entry.view.setHidden(hidden);
            }
        }
        Ok(())
    }

    pub fn kill_all(state: &State<'_, GhosttyState>) -> Result<(), String> {
        let _mtm = MainThreadMarker::new()
            .ok_or_else(|| "ghostty_kill_all precisa rodar na main thread".to_string())?;
        #[cfg(ghostty_linked)]
        {
            use crate::ghostty_ffi::*;
            unsafe { alethe_ghostty_kill_all() };
        }
        let mut views = state
            .views
            .lock()
            .map_err(|_| "lock poisoned".to_string())?;
        #[cfg(not(ghostty_linked))]
        {
            for (_, entry) in views.iter() {
                entry.view.removeFromSuperview();
            }
        }
        views.clear();
        if let Ok(mut r) = state.reserving.lock() {
            r.clear();
        }
        Ok(())
    }

    #[cfg(ghostty_linked)]
    pub fn debug_send_read(
        state: &State<'_, GhosttyState>,
        id: String,
        text: String,
    ) -> Result<String, String> {
        use crate::ghostty_ffi::*;
        use std::ffi::CString;
        let _mtm =
            MainThreadMarker::new().ok_or_else(|| "precisa rodar na main thread".to_string())?;
        let surface = {
            let views = state
                .views
                .lock()
                .map_err(|_| "lock poisoned".to_string())?;
            let e = views
                .get(&id)
                .ok_or_else(|| format!("surface {id} não encontrada"))?;
            e.surface
        };
        if surface.is_null() {
            return Err("surface nula".into());
        }
        if !text.is_empty() {
            let c = CString::new(text).map_err(|_| "texto inválido".to_string())?;
            unsafe { alethe_ghostty_surface_send_text(surface, c.as_ptr(), c.as_bytes().len()) };
        }

        unsafe { alethe_ghostty_app_tick() };
        std::thread::sleep(std::time::Duration::from_millis(400));
        unsafe {
            alethe_ghostty_app_tick();
            alethe_ghostty_surface_draw(surface);
        }
        let mut buf = vec![0u8; 64 * 1024];
        let n = unsafe {
            alethe_ghostty_surface_read_screen(
                surface,
                buf.as_mut_ptr() as *mut std::os::raw::c_char,
                buf.len(),
            )
        };
        buf.truncate(n);
        Ok(String::from_utf8_lossy(&buf).to_string())
    }

    pub fn set_focus(
        state: &State<'_, GhosttyState>,
        id: String,
        focused: bool,
    ) -> Result<(), String> {
        let _mtm = MainThreadMarker::new()
            .ok_or_else(|| "ghostty_set_focus precisa rodar na main thread".to_string())?;
        let mut views = state
            .views
            .lock()
            .map_err(|_| "lock poisoned".to_string())?;
        if let Some(entry) = views.get_mut(&id) {
            #[cfg(ghostty_linked)]
            {
                use crate::ghostty_ffi::*;
                if !entry.surface.is_null() {
                    unsafe { alethe_ghostty_surface_set_focus(entry.surface, focused) };
                }
            }
            #[cfg(not(ghostty_linked))]
            {
                let _ = (&entry, focused);
            }
        }
        Ok(())
    }

    pub fn process_exited(state: &State<'_, GhosttyState>, id: String) -> Result<bool, String> {
        let _mtm = MainThreadMarker::new()
            .ok_or_else(|| "ghostty_process_exited precisa rodar na main thread".to_string())?;
        let views = state
            .views
            .lock()
            .map_err(|_| "lock poisoned".to_string())?;
        match views.get(&id) {
            #[cfg(ghostty_linked)]
            Some(entry) => {
                use crate::ghostty_ffi::*;
                if entry.surface.is_null() {
                    return Ok(false);
                }
                Ok(unsafe { alethe_ghostty_surface_process_exited(entry.surface) })
            }
            #[cfg(not(ghostty_linked))]
            Some(_entry) => Ok(false),

            None => Ok(true),
        }
    }

    pub fn kill(state: &State<'_, GhosttyState>, id: String) -> Result<(), String> {
        let _mtm = MainThreadMarker::new()
            .ok_or_else(|| "ghostty_kill precisa rodar na main thread".to_string())?;
        let mut views = state
            .views
            .lock()
            .map_err(|_| "lock poisoned".to_string())?;
        if let Some(entry) = views.remove(&id) {
            #[cfg(ghostty_linked)]
            {
                use crate::ghostty_ffi::*;
                if !entry.surface.is_null() {
                    // O shim remove a NSView da superview ao liberar a surface.
                    unsafe { alethe_ghostty_surface_free(entry.surface) };
                }
            }
            #[cfg(not(ghostty_linked))]
            {
                entry.view.removeFromSuperview();
            }
        }
        Ok(())
    }

    // -----------------------------------------------------------------------

    // Os testes funcionais do terminal (echo/ls/cd) tocam AppKit/Metal e exigem

    // `cargo test -- --ignored --test-threads=1`).
    // -----------------------------------------------------------------------
    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn web_rect_to_appkit_inverts_y() {
            // content de 1000px de altura; rect 100px de altura no topo (y=0)

            let f = web_rect_to_appkit_frame(
                1000.0,
                WebRect {
                    x: 10.0,
                    y: 0.0,
                    width: 200.0,
                    height: 100.0,
                },
            );
            assert_eq!(f.origin.x, 10.0);
            assert_eq!(f.origin.y, 900.0);
            assert_eq!(f.size.width, 200.0);
            assert_eq!(f.size.height, 100.0);
        }

        #[test]
        fn web_rect_to_appkit_bottom() {
            let f = web_rect_to_appkit_frame(
                1000.0,
                WebRect {
                    x: 0.0,
                    y: 900.0,
                    width: 50.0,
                    height: 100.0,
                },
            );
            assert_eq!(f.origin.y, 0.0);
        }

        #[test]
        fn web_rect_clamps_min_size() {
            let f = web_rect_to_appkit_frame(
                500.0,
                WebRect {
                    x: 0.0,
                    y: 0.0,
                    width: 0.0,
                    height: 0.0,
                },
            );
            assert!(f.size.width >= 1.0);
            assert!(f.size.height >= 1.0);
        }

        #[test]
        fn reserve_is_idempotent_per_id() {
            let s = GhosttySurfaces::default();
            assert!(s.try_reserve("abc"), "1ª reserva deve vencer");
            assert!(!s.try_reserve("abc"), "2ª reserva do mesmo id deve perder");
            assert!(s.try_reserve("xyz"), "id diferente reserva normalmente");

            s.release_reservation("abc");
            assert!(s.try_reserve("abc"), "após liberar, pode reservar de novo");
        }

        // porque exige GUI/main thread; rode com:
        //   cargo test -- --ignored --test-threads=1 terminal_runs
        #[cfg(ghostty_linked)]
        #[test]
        #[ignore]
        fn terminal_runs_echo_cd_ls() {
            super::super::functional_tests::run_echo_cd_ls();
        }

        #[cfg(ghostty_linked)]
        #[test]
        #[ignore]
        fn terminal_cwd_respected() {
            super::super::functional_tests::run_cwd_respected();
        }

        #[cfg(ghostty_linked)]
        #[test]
        #[ignore]
        fn terminal_renders_continuously() {
            super::super::functional_tests::run_render_loop_draws();
        }

        #[cfg(ghostty_linked)]
        #[test]
        #[ignore]
        fn terminal_ime_dead_key_accents() {
            super::super::functional_tests::run_ime_dead_key();
        }

        // manual — prova a root fix (tick no render loop). Era o bug "nada
        // aparece ao digitar".
        #[cfg(ghostty_linked)]
        #[test]
        #[ignore]
        fn terminal_typed_input_renders() {
            super::super::functional_tests::run_typed_input_renders();
        }

        #[cfg(ghostty_linked)]
        #[test]
        #[ignore]
        fn terminal_deadkey_compose() {
            super::super::functional_tests::run_deadkey_compose();
        }
    }
}

#[cfg(all(target_os = "macos", ghostty_linked, test))]
mod functional_tests {
    use crate::ghostty_ffi::*;
    use std::ffi::CString;
    use std::os::raw::{c_char, c_void};
    use std::time::{Duration, Instant};

    fn make_nsview() -> *mut c_void {
        use objc2::msg_send;
        use objc2::runtime::AnyClass;
        unsafe {
            let cls = AnyClass::get(c"NSView").expect("NSView");
            let alloc: *mut c_void = msg_send![cls, alloc];
            let frame = objc2_foundation::NSRect::new(
                objc2_foundation::NSPoint::new(0.0, 0.0),
                objc2_foundation::NSSize::new(800.0, 480.0),
            );
            msg_send![alloc as *mut objc2::runtime::AnyObject, initWithFrame: frame]
        }
    }

    fn pump(dur: Duration) {
        use objc2::msg_send;
        use objc2::runtime::AnyClass;
        let deadline = Instant::now() + dur;
        unsafe {
            let rl_cls = AnyClass::get(c"NSRunLoop").unwrap();
            let rl: *mut objc2::runtime::AnyObject = msg_send![rl_cls, currentRunLoop];
            let date_cls = AnyClass::get(c"NSDate").unwrap();
            while Instant::now() < deadline {
                alethe_ghostty_app_tick();
                let until: *mut objc2::runtime::AnyObject =
                    msg_send![date_cls, dateWithTimeIntervalSinceNow: 0.05_f64];
                let mode = objc2_foundation::NSString::from_str("kCFRunLoopDefaultMode");
                let _: bool = msg_send![rl, runMode: &*mode, beforeDate: until];
            }
        }
    }

    fn read_screen(s: *mut c_void) -> String {
        let mut buf = vec![0u8; 64 * 1024];
        let n = unsafe {
            alethe_ghostty_surface_read_screen(s, buf.as_mut_ptr() as *mut c_char, buf.len())
        };
        buf.truncate(n);
        String::from_utf8_lossy(&buf).to_string()
    }

    fn send(s: *mut c_void, text: &str) {
        let c = CString::new(text).unwrap();
        unsafe { alethe_ghostty_surface_send_text(s, c.as_ptr(), text.len()) };
    }

    fn type_char(s: *mut c_void, ch: &str, keycode: u16) {
        let c = CString::new(ch).unwrap();
        unsafe { alethe_ghostty_test_type_key(s, c.as_ptr(), keycode) };
    }

    fn last_key_text() -> String {
        let p = unsafe { alethe_ghostty_test_last_key_text() };
        if p.is_null() {
            return String::new();
        }
        unsafe { std::ffi::CStr::from_ptr(p) }
            .to_string_lossy()
            .to_string()
    }
    fn last_key_composing() -> bool {
        unsafe { alethe_ghostty_test_last_key_composing() }
    }

    pub fn run_deadkey_compose() {
        assert!(unsafe { alethe_ghostty_ensure_app() }, "ensure_app falhou");
        let view = make_nsview();
        let surface =
            unsafe { alethe_ghostty_surface_new(view, std::ptr::null(), std::ptr::null(), 2.0) };
        assert!(!surface.is_null(), "surface_new NULL");

        type_char(surface, "a", 0);
        assert_eq!(last_key_text(), "a", "letra normal deve emitir 'a'");
        assert!(!last_key_composing(), "letra normal não é composing");

        type_char(surface, "", 36); // Enter

        assert_eq!(last_key_text(), "\r", "Enter deve emitir CR");
        assert!(!last_key_composing(), "Enter NÃO pode ficar composing");

        // --- dead-key (keycode 39): depende do layout do sistema ---
        type_char(surface, "", 39); // tecla de acento (´ no ABNT2)
        let dead = last_key_composing();
        if dead {
            assert_eq!(last_key_text(), "", "dead-key pendente não emite texto");
            type_char(surface, "a", 0);
            assert!(!last_key_composing(), "após compor, não é mais composing");
            let composed = last_key_text();
            assert!(
                composed == "á"
                    || composed == "à"
                    || composed == "ã"
                    || composed == "â"
                    || composed == "ä",
                "dead-key + a deveria compor um 'a' acentuado, veio: {composed:?}"
            );
        } else {
            eprintln!(
                "[teste] keycode 39 não é dead-key neste layout (emitiu {:?}) — ok",
                last_key_text()
            );
        }
        unsafe { alethe_ghostty_surface_free(surface) };
    }

    pub fn run_typed_input_renders() {
        assert!(unsafe { alethe_ghostty_ensure_app() }, "ensure_app falhou");
        let view = make_nsview();
        let surface =
            unsafe { alethe_ghostty_surface_new(view, std::ptr::null(), std::ptr::null(), 2.0) };
        assert!(!surface.is_null(), "surface_new NULL (Metal headless?)");
        unsafe {
            alethe_ghostty_surface_set_content_scale(surface, 2.0, 2.0);
            alethe_ghostty_surface_set_size(surface, 1600, 960);
        }

        pump(Duration::from_secs(2));

        // e=14 c=8 h=4 o=31 space=49 z=6 t=17 p=35
        let keys: &[(&str, u16)] = &[
            ("e", 14),
            ("c", 8),
            ("h", 4),
            ("o", 31),
            (" ", 49),
            ("z", 6),
            ("z", 6),
            ("t", 17),
            ("o", 31),
            ("p", 35),
        ];
        for (ch, kc) in keys {
            type_char(surface, ch, *kc);
        }

        // echo do shell aparecerem.
        pump_runloop_only(Duration::from_millis(1500));

        let screen = read_screen(surface);
        assert!(
            screen.contains("echo zztop") || screen.contains("zztop"),
            "texto digitado pelo keyDown não renderizou (root fix do tick no render loop):\n{screen}"
        );
        unsafe { alethe_ghostty_surface_free(surface) };
    }

    pub fn run_echo_cd_ls() {
        assert!(unsafe { alethe_ghostty_ensure_app() }, "ensure_app falhou");
        let view = make_nsview();
        assert!(!view.is_null(), "NSView nula");

        let surface =
            unsafe { alethe_ghostty_surface_new(view, std::ptr::null(), std::ptr::null(), 2.0) };
        assert!(
            !surface.is_null(),
            "surface_new NULL — ambiente sem contexto gráfico (Metal headless)"
        );
        unsafe {
            alethe_ghostty_surface_set_content_scale(surface, 2.0, 2.0);
            alethe_ghostty_surface_set_size(surface, 1600, 960);
        }
        pump(Duration::from_secs(2));

        send(surface, "echo alethe_marker_42\r");
        pump(Duration::from_secs(2));
        let screen = read_screen(surface);
        assert!(
            screen.contains("alethe_marker_42"),
            "echo falhou:\n{screen}"
        );

        send(surface, "cd /tmp && pwd\r");
        pump(Duration::from_secs(2));
        let screen = read_screen(surface);
        assert!(screen.contains("/tmp"), "cd/pwd falhou:\n{screen}");

        send(
            surface,
            "touch /tmp/alethe_ghostty_probe && ls /tmp/alethe_ghostty_probe\r",
        );
        pump(Duration::from_secs(2));
        let screen = read_screen(surface);
        assert!(
            screen.contains("alethe_ghostty_probe"),
            "ls falhou:\n{screen}"
        );

        unsafe { alethe_ghostty_surface_free(surface) };
    }

    pub fn run_cwd_respected() {
        assert!(unsafe { alethe_ghostty_ensure_app() }, "ensure_app falhou");
        let view = make_nsview();
        let cwd = CString::new("/tmp").unwrap();
        let surface =
            unsafe { alethe_ghostty_surface_new(view, cwd.as_ptr(), std::ptr::null(), 2.0) };
        assert!(!surface.is_null(), "surface_new NULL (Metal headless?)");
        unsafe {
            alethe_ghostty_surface_set_content_scale(surface, 2.0, 2.0);
            alethe_ghostty_surface_set_size(surface, 1600, 960);
        }
        pump(Duration::from_secs(2));
        send(surface, "pwd\r");
        pump(Duration::from_secs(2));
        let screen = read_screen(surface);
        // macOS resolve /tmp -> /private/tmp; aceita os dois.
        assert!(
            screen.contains("/tmp") || screen.contains("/private/tmp"),
            "cwd inicial não respeitado (esperava /tmp):\n{screen}"
        );
        unsafe { alethe_ghostty_surface_free(surface) };
    }

    fn pump_runloop_only(dur: Duration) {
        use objc2::msg_send;
        use objc2::runtime::AnyClass;
        let deadline = Instant::now() + dur;
        unsafe {
            let rl_cls = AnyClass::get(c"NSRunLoop").unwrap();
            let rl: *mut objc2::runtime::AnyObject = msg_send![rl_cls, currentRunLoop];
            let date_cls = AnyClass::get(c"NSDate").unwrap();
            while Instant::now() < deadline {
                let until: *mut objc2::runtime::AnyObject =
                    msg_send![date_cls, dateWithTimeIntervalSinceNow: 0.02_f64];
                let mode = objc2_foundation::NSString::from_str("kCFRunLoopDefaultMode");
                let _: bool = msg_send![rl, runMode: &*mode, beforeDate: until];
            }
        }
    }

    pub fn run_ime_dead_key() {
        assert!(unsafe { alethe_ghostty_ensure_app() }, "ensure_app falhou");
        let view = make_nsview();
        let surface =
            unsafe { alethe_ghostty_surface_new(view, std::ptr::null(), std::ptr::null(), 2.0) };
        assert!(!surface.is_null(), "surface_new NULL (Metal headless?)");
        unsafe {
            alethe_ghostty_surface_set_content_scale(surface, 2.0, 2.0);
            alethe_ghostty_surface_set_size(surface, 1600, 960);
        }
        pump(Duration::from_secs(2));

        // Prefixo do comando via texto normal.
        send(surface, "echo IME_");

        let marked = CString::new("\u{00b4}").unwrap(); // ´
        let final_ = CString::new("\u{00e1}").unwrap();
        let ok =
            unsafe { alethe_ghostty_test_ime_compose(surface, marked.as_ptr(), final_.as_ptr()) };
        assert!(ok, "test_ime_compose não achou a view");

        let cedilha = CString::new("\u{00e7}\u{00e3}").unwrap();
        unsafe { alethe_ghostty_test_ime_compose(surface, std::ptr::null(), cedilha.as_ptr()) };
        send(surface, "_END\r");
        pump(Duration::from_secs(2));

        let screen = read_screen(surface);
        assert!(
            screen.contains("IME_áçã_END"),
            "composição IME não chegou ao terminal. Esperava 'IME_áçã_END':\n{screen}"
        );
        unsafe { alethe_ghostty_surface_free(surface) };
    }

    pub fn run_render_loop_draws() {
        assert!(unsafe { alethe_ghostty_ensure_app() }, "ensure_app falhou");
        let view = make_nsview();
        let surface =
            unsafe { alethe_ghostty_surface_new(view, std::ptr::null(), std::ptr::null(), 2.0) };
        assert!(!surface.is_null(), "surface_new NULL (Metal headless?)");
        unsafe {
            alethe_ghostty_surface_set_content_scale(surface, 2.0, 2.0);
            alethe_ghostty_surface_set_size(surface, 1600, 960);
        }

        pump(Duration::from_secs(1));
        let before = unsafe { alethe_ghostty_draw_count() };
        pump_runloop_only(Duration::from_millis(1000));
        let after = unsafe { alethe_ghostty_draw_count() };
        let frames = after - before;

        assert!(
            frames >= 20,
            "render contínuo ausente: {frames} draws em 1s só de run loop (esperado >= 20)"
        );
        unsafe { alethe_ghostty_surface_free(surface) };
    }
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
#[cfg(not(target_os = "macos"))]
mod imp {
    use super::{GhosttySurfaceResponse, WebRect};
    use tauri::State;

    #[derive(Default)]
    pub struct GhosttySurfaces;
    pub type GhosttyState = GhosttySurfaces;

    const UNSUPPORTED: &str = "terminal nativo (Ghostty) só é suportado no macOS";

    pub fn spawn(
        _app: &tauri::AppHandle,
        _state: &State<'_, GhosttyState>,
        _id: String,
        _cwd: Option<String>,
        _command: Option<String>,
    ) -> Result<GhosttySurfaceResponse, String> {
        Err(UNSUPPORTED.into())
    }
    pub fn sync_frame(
        _app: &tauri::AppHandle,
        _state: &State<'_, GhosttyState>,
        _id: String,
        _rect: WebRect,
        _scale: f64,
    ) -> Result<(), String> {
        Err(UNSUPPORTED.into())
    }
    pub fn set_hidden(
        _state: &State<'_, GhosttyState>,
        _id: String,
        _hidden: bool,
    ) -> Result<(), String> {
        Err(UNSUPPORTED.into())
    }
    pub fn set_focus(
        _state: &State<'_, GhosttyState>,
        _id: String,
        _focused: bool,
    ) -> Result<(), String> {
        Err(UNSUPPORTED.into())
    }
    pub fn process_exited(_state: &State<'_, GhosttyState>, _id: String) -> Result<bool, String> {
        Err(UNSUPPORTED.into())
    }
    pub fn kill(_state: &State<'_, GhosttyState>, _id: String) -> Result<(), String> {
        Err(UNSUPPORTED.into())
    }
    pub fn kill_all(_state: &State<'_, GhosttyState>) -> Result<(), String> {
        Ok(())
    }
}

pub use imp::{GhosttyState, GhosttySurfaces};

// ---------------------------------------------------------------------------
// Comandos Tauri (mesma assinatura em todas as plataformas)
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn ghostty_spawn(
    app: tauri::AppHandle,
    state: tauri::State<'_, GhosttyState>,
    id: String,
    cwd: Option<String>,
    command: Option<String>,
) -> Result<GhosttySurfaceResponse, String> {
    imp::spawn(&app, &state, id, cwd, command)
}

#[tauri::command]
pub fn ghostty_sync_frame(
    app: tauri::AppHandle,
    state: tauri::State<'_, GhosttyState>,
    id: String,
    rect: WebRect,
    scale: f64,
) -> Result<(), String> {
    imp::sync_frame(&app, &state, id, rect, scale)
}

#[tauri::command]
pub fn ghostty_set_hidden(
    state: tauri::State<'_, GhosttyState>,
    id: String,
    hidden: bool,
) -> Result<(), String> {
    imp::set_hidden(&state, id, hidden)
}

#[tauri::command]
pub fn ghostty_set_focus(
    state: tauri::State<'_, GhosttyState>,
    id: String,
    focused: bool,
) -> Result<(), String> {
    imp::set_focus(&state, id, focused)
}

#[tauri::command]
pub fn ghostty_surface_exited(
    state: tauri::State<'_, GhosttyState>,
    id: String,
) -> Result<bool, String> {
    imp::process_exited(&state, id)
}

#[tauri::command]
pub fn ghostty_kill(state: tauri::State<'_, GhosttyState>, id: String) -> Result<(), String> {
    imp::kill(&state, id)
}

#[tauri::command]
pub fn ghostty_kill_all(state: tauri::State<'_, GhosttyState>) -> Result<(), String> {
    imp::kill_all(&state)
}

#[tauri::command]
pub fn ghostty_debug_send_read(
    state: tauri::State<'_, GhosttyState>,
    id: String,
    text: String,
) -> Result<String, String> {
    #[cfg(all(target_os = "macos", ghostty_linked))]
    {
        imp::debug_send_read(&state, id, text)
    }
    #[cfg(not(all(target_os = "macos", ghostty_linked)))]
    {
        let _ = (&state, &id, &text);
        Err("ghostty_debug_send_read indisponível (precisa macOS + libghostty)".into())
    }
}
