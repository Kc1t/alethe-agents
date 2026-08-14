//! Bridge nativo macOS para o backend de terminal Ghostty.
//!
//! Este módulo é compilado APENAS no macOS (`cfg(target_os = "macos")`). Em
//! Windows/Linux ele vira um conjunto de stubs que retornam erro, para que o
//! `invoke_handler` continue registrando os mesmos comandos em todas as
//! plataformas sem `cfg` no `lib.rs` — o frontend só os chama quando
//! `platform === 'macos'` e a flag `nativeTerminalMacos` está ligada.
//!
//! Estratégia (ver docs/PLAN-ghostty-native-macos.md §4):
//! a UI inteira do Alethe vive numa WKWebView (Tauri). As surfaces de terminal
//! são `NSView`s nativas adicionadas como IRMÃS da WebView, por cima dela, na
//! mesma `NSWindow`. O frontend desenha um placeholder `<div data-surface-id>`
//! e nos manda, via `ghostty_sync_frame`, o retângulo em coordenadas de tela
//! da WebView; nós convertemos para coordenadas AppKit e posicionamos a NSView.
//!
//! NESTA FASE (spike), a NSView é um STUB colorido — sem libghostty ainda — só
//! para validar reparenting + sincronização de layout. A troca pela surface
//! real do Ghostty é a etapa seguinte (task #5 / §6 Fase 5 do plano).

use serde::Serialize;

/// Retângulo em coordenadas da WebView (CSS px, origem no topo-esquerda),
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
    /// true quando a NSView nativa foi de fato criada e anexada à janela.
    pub attached: bool,
}

// ---------------------------------------------------------------------------
// Implementação macOS
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

    /// Garante que o auto-probe de debug rode só uma vez por processo.
    #[cfg(ghostty_linked)]
    static PROBE_STARTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    #[cfg(ghostty_linked)]
    static WATCH_STARTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

    /// Registro global de surfaces vivas: surfaceId -> NSView nativa.
    /// Protegido por Mutex; todo acesso à AppKit é feito na main thread (ver
    /// `MainThreadMarker`), então o Mutex só guarda o mapa, não a UI.
    #[derive(Default)]
    pub struct GhosttySurfaces {
        // Guardamos o ponteiro como usize para o mapa ser Send/Sync; a NSView
        // só é tocada na main thread, onde reconstruímos o Retained.
        views: Mutex<HashMap<String, SurfaceEntry>>,
        // IDs com criação em andamento (reservados mas ainda sem entry no mapa).
        // Fecha a janela entre "checar que não existe" e "inserir a surface":
        // sem isto, duas chamadas de spawn pro mesmo id poderiam ambas passar o
        // check e criar duas surfaces (over-spawn do StrictMode). #4
        reserving: Mutex<std::collections::HashSet<String>>,
    }

    impl GhosttySurfaces {
        /// Reserva um id para criação. Retorna true se reservou (não havia
        /// surface viva nem outra reserva pendente); false se já existe/reservado.
        /// Atômico: check de views + reserving sob locks, antes de qualquer
        /// criação cara de surface.
        pub fn try_reserve(&self, id: &str) -> bool {
            let views = self.views.lock().expect("views lock");
            if views.contains_key(id) {
                return false;
            }
            let mut reserving = self.reserving.lock().expect("reserving lock");
            reserving.insert(id.to_string())
        }

        /// Libera uma reserva (ex.: a criação falhou ou concluiu e já está no
        /// mapa de views).
        pub fn release_reservation(&self, id: &str) {
            if let Ok(mut reserving) = self.reserving.lock() {
                reserving.remove(id);
            }
        }
    }

    struct SurfaceEntry {
        /// Devicepixel ratio com que a última sync foi feita.
        last_scale: f64,
        /// Modo real (libghostty linkado): o shim cria/gere a NSView de input e
        /// a surface; guardamos só o handle e posicionamos via shim.
        #[cfg(ghostty_linked)]
        surface: crate::ghostty_ffi::AletheSurface,
        /// Modo stub (sem libghostty): NSView colorida que o Rust gere.
        #[cfg(not(ghostty_linked))]
        view: Retained<NSView>,
    }

    // SAFETY: as NSViews só são acessadas na main thread (todos os comandos
    // abaixo exigem MainThreadMarker). O HashMap em si é protegido por Mutex.
    unsafe impl Send for SurfaceEntry {}
    unsafe impl Sync for SurfaceEntry {}

    pub type GhosttyState = GhosttySurfaces;

    /// Converte um retângulo em coordenadas da WebView (origem topo-esquerda,
    /// CSS px) para o frame de uma subview da content view (origem inferior-
    /// esquerda no AppKit), respeitando a altura total da content view.
    fn web_rect_to_appkit_frame(content_height: f64, rect: WebRect) -> NSRect {
        // AppKit: y cresce pra cima. Web: y cresce pra baixo a partir do topo.
        // Como a NSView é irmã da WebView e ambas preenchem a content view,
        // basta inverter o eixo Y usando a altura da content view.
        let appkit_y = content_height - rect.y - rect.height;
        NSRect::new(
            objc2_foundation::NSPoint::new(rect.x, appkit_y),
            objc2_foundation::NSSize::new(rect.width.max(1.0), rect.height.max(1.0)),
        )
    }

    /// Pega a content view da NSWindow do Tauri (a view raiz que contém a
    /// WebView). É aí que penduramos as surfaces como irmãs da WebView.
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
        // SAFETY: ns_window_ptr é uma NSWindow* válida fornecida pelo Tauri.
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
        let _ = (&cwd, &command); // usados só no caminho ghostty_linked

        // Idempotente + atômico (#4): reserva o id sob lock. Se já há surface
        // viva OU outra criação em andamento pro mesmo id, não criamos a 2ª —
        // devolvemos a existente. Isso fecha a janela entre o check e a inserção
        // (o StrictMode chamava spawn 2x e gerava over-spawn).
        if !state.try_reserve(&id) {
            return Ok(GhosttySurfaceResponse { id, attached: true });
        }
        // Guard RAII: libera a reserva em QUALQUER saída (erro com `?`, pânico,
        // ou sucesso). Chamamos `.done()` no fim pra não liberar antes da hora.
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

        // Modo REAL: o shim cria a NSView de input + a surface dentro da content
        // view e devolve o handle. O Ghostty faz o spawn do shell (backend EXEC).
        #[cfg(ghostty_linked)]
        let entry = {
            use crate::ghostty_ffi::*;
            use std::ffi::CString;
            let content_ptr = objc2::rc::Retained::as_ptr(&content) as *mut std::ffi::c_void;
            let scale = window.scale_factor().unwrap_or(2.0);
            // CStrings vivem até depois do surface_new (ponteiros usados na chamada).
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

            // Auto-probe opcional: com ALETHE_GHOSTTY_PROBE=1, depois de a surface
            // estabilizar, digitamos um echo e lemos o grid de volta — provando o
            // fluxo input→shell→render no app REAL, e logando o resultado. É o que
            // o smoke usa pra verificar de forma determinística (sem screenshot).
            // Só registra o probe UMA vez por processo (o StrictMode/re-render
            // cria várias surfaces; queremos um único teste, com retry até achar
            // uma surface viva — imune ao churn de montagem do React).
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

            // WATCH: com ALETHE_GHOSTTY_WATCH=1, loga o conteúdo do grid a cada
            // 2s — pra EU observar o que está renderizado sem depender de
            // screenshot/usuário. Só uma vez por processo.
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

        // Modo STUB: NSView colorida gerida pelo Rust, só pra provar reparenting.
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
        // Surface está no mapa de views agora; libera a reserva (sem o guard
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
                // Posição da NSView (pontos AppKit) + tamanho/escala da surface
                // (pixels de dispositivo) — senão o grid sai borrado/errado.
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

    /// Mata TODAS as surfaces vivas e limpa o registro. Usado no boot do
    /// frontend para descartar surfaces órfãs que sobreviveram a um reload da
    /// WebView (o JS é recriado, mas as NSViews/o app Ghostty persistem). Sem
    /// isso, surfaces antigas ficam empilhadas e roubam o foco do teclado.
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

    /// DEBUG/automação: envia texto pra surface e devolve o conteúdo do grid
    /// após um curto tick. Prova o fluxo input→shell→render no app REAL, de
    /// forma determinística (sem screenshot). Só no modo linked.
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
        // Dá um tempinho pro shell processar e o Ghostty desenhar.
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
                // Modo stub (sem libghostty): a NSView é só um placeholder
                // colorido, sem shell real — foco de teclado é no-op.
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
            // Surface ausente (já morta/nunca criada) — trata como "saiu" para o
            // frontend não ficar preso esperando por uma surface inexistente.
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
    // Testes — a conversão de coordenadas é pura e roda sempre (cargo test).
    // Os testes funcionais do terminal (echo/ls/cd) tocam AppKit/Metal e exigem
    // main thread + run loop, então ficam #[ignore] (rodados sob demanda com
    // `cargo test -- --ignored --test-threads=1`).
    // -----------------------------------------------------------------------
    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn web_rect_to_appkit_inverts_y() {
            // content de 1000px de altura; rect 100px de altura no topo (y=0)
            // deve ir pro topo em AppKit => appkit_y = 1000 - 0 - 100 = 900.
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
            // rect no rodapé (y=900, h=100) => appkit_y = 1000-900-100 = 0.
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
            // largura/altura zero nunca viram 0 (Ghostty/AppKit não gostam).
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

        // #4: a reserva de slot é atômica e idempotente. A 1ª reserva de um id
        // vence (true); a 2ª (mesmo id, ainda não liberada/criada) perde (false)
        // — garante que nunca criamos uma 2ª surface pro mesmo id. Sem GUI.
        #[test]
        fn reserve_is_idempotent_per_id() {
            let s = GhosttySurfaces::default();
            assert!(s.try_reserve("abc"), "1ª reserva deve vencer");
            assert!(!s.try_reserve("abc"), "2ª reserva do mesmo id deve perder");
            assert!(s.try_reserve("xyz"), "id diferente reserva normalmente");
            // Liberar a reserva permite reservar de novo (ex.: falha na criação).
            s.release_reservation("abc");
            assert!(s.try_reserve("abc"), "após liberar, pode reservar de novo");
        }

        // Teste funcional do terminal real. Só com libghostty linkado. #[ignore]
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

        // #2: a surface deve se redesenhar continuamente (display link), sem
        // input nem sync manual. RED até o CADisplayLink existir.
        #[cfg(ghostty_linked)]
        #[test]
        #[ignore]
        fn terminal_renders_continuously() {
            super::super::functional_tests::run_render_loop_draws();
        }

        // #3: a composição de dead-key (NSTextInputClient) encaminha o caractere
        // acentuado ao terminal. Exercita setMarkedText+insertText (o mesmo
        // caminho do teclado real) e confere que "á" renderiza no grid.
        #[cfg(ghostty_linked)]
        #[test]
        #[ignore]
        fn terminal_ime_dead_key_accents() {
            super::super::functional_tests::run_ime_dead_key();
        }

        // input: digitar pelo caminho REAL do keyDown renderiza, sem app_tick
        // manual — prova a root fix (tick no render loop). Era o bug "nada
        // aparece ao digitar".
        #[cfg(ghostty_linked)]
        #[test]
        #[ignore]
        fn terminal_typed_input_renders() {
            super::super::functional_tests::run_typed_input_renders();
        }

        // dead-key (UCKeyTranslate): compõe acento + vogal, e NÃO quebra
        // digitação básica / Enter. Prova via o texto que chega à surface.
        #[cfg(ghostty_linked)]
        #[test]
        #[ignore]
        fn terminal_deadkey_compose() {
            super::super::functional_tests::run_deadkey_compose();
        }
    }
}

// Implementação dos testes funcionais (fora de #[cfg(test)] para poder usar o
// FFI linkado; chamado pelo teste #[ignore] acima).
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

    /// Digita 1 char pelo caminho REAL do keyDown (NSEvent sintético).
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

    /// Prova a composição de dead-key (UCKeyTranslate) pelo caminho REAL do
    /// keyDown, SEM ler o grid — verifica o texto que chega à surface.
    /// Robusto ao layout: se o keycode 39 não for dead-key no layout atual
    /// (ex.: US puro = apóstrofo), valida o comportamento correto desse layout.
    pub fn run_deadkey_compose() {
        assert!(unsafe { alethe_ghostty_ensure_app() }, "ensure_app falhou");
        let view = make_nsview();
        let surface =
            unsafe { alethe_ghostty_surface_new(view, std::ptr::null(), std::ptr::null(), 2.0) };
        assert!(!surface.is_null(), "surface_new NULL");

        // --- regressão: digitação básica e controle NÃO podem quebrar ---
        type_char(surface, "a", 0);
        assert_eq!(last_key_text(), "a", "letra normal deve emitir 'a'");
        assert!(!last_key_composing(), "letra normal não é composing");

        type_char(surface, "", 36); // Enter
                                    // UCKeyTranslate traduz Enter -> "\r" (carriage return) — é o que faz o
                                    // shell executar. O importante: NÃO pode ficar travado em composing.
        assert_eq!(last_key_text(), "\r", "Enter deve emitir CR");
        assert!(!last_key_composing(), "Enter NÃO pode ficar composing");

        // --- dead-key (keycode 39): depende do layout do sistema ---
        type_char(surface, "", 39); // tecla de acento (´ no ABNT2)
        let dead = last_key_composing();
        if dead {
            // Layout com dead-key: a próxima vogal deve compor.
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
            // Layout sem dead-key (ex.: US): a tecla emite um caractere direto.
            // Aceita qualquer caractere não-vazio (apóstrofo, etc.) — só garante
            // que NÃO travou em composing.
            eprintln!(
                "[teste] keycode 39 não é dead-key neste layout (emitiu {:?}) — ok",
                last_key_text()
            );
        }
        unsafe { alethe_ghostty_surface_free(surface) };
    }

    /// #input: digita pelo caminho real do keyDown e confirma que renderiza SEM
    /// app_tick manual — só o run loop (que agora faz tick por frame). Falha se
    /// o render loop não bombear o IO (era o bug do "nada aparece").
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
        // Deixa o shell iniciar — aqui pode usar pump (com tick) só pra subir.
        pump(Duration::from_secs(2));

        // Digita "echo zztop" pelo keyDown real. Virtual keycodes (US layout).
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

        // Render SÓ pelo run loop (sem app_tick manual) — é o que prova a root
        // fix: o NSTimer precisa fazer tick por frame pra o texto digitado e o
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

    /// Prova que o `cwd` passado a surface_new é respeitado: cria a surface em
    /// /tmp e confirma que `pwd` (sem cd) já reporta /tmp. (#5)
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

    /// Roda SÓ o run loop por `dur`, sem chamar app_tick/draw manualmente.
    /// Assim isolamos o render espontâneo (display link) do render por input.
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

    /// #3: prova que a composição de dead-key (NSTextInputClient) entrega o
    /// caractere acentuado ao terminal. Monta `echo MARK_á_END` onde o "á" vem
    /// da composição IME (setMarkedText "´" + insertText "á"), e confere no grid.
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
        // Composição dead-key: "´" marcado, depois "á" inserido (como option+e,a).
        let marked = CString::new("\u{00b4}").unwrap(); // ´
        let final_ = CString::new("\u{00e1}").unwrap(); // á
        let ok =
            unsafe { alethe_ghostty_test_ime_compose(surface, marked.as_ptr(), final_.as_ptr()) };
        assert!(ok, "test_ime_compose não achou a view");
        // Mais acentos por insertText direto (ç, ã) e fecha o comando.
        let cedilha = CString::new("\u{00e7}\u{00e3}").unwrap(); // çã
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

    /// #2: prova que a surface se redesenha sozinha (display link), sem input
    /// nem tick/draw manual. Conta os draws antes/depois de ~1s só de run loop.
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
        // Deixa estabilizar (com tick), depois mede SÓ o run loop.
        pump(Duration::from_secs(1));
        let before = unsafe { alethe_ghostty_draw_count() };
        pump_runloop_only(Duration::from_millis(1000));
        let after = unsafe { alethe_ghostty_draw_count() };
        let frames = after - before;
        // Um display link a ~60fps faz dezenas de draws em 1s. Sem render
        // contínuo (estado atual), frames == 0 -> RED.
        assert!(
            frames >= 20,
            "render contínuo ausente: {frames} draws em 1s só de run loop (esperado >= 20)"
        );
        unsafe { alethe_ghostty_surface_free(surface) };
    }
}

// ---------------------------------------------------------------------------
// Stubs para plataformas não-macOS
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

/// Mata todas as surfaces vivas (limpeza de órfãs no boot/reload da WebView).
#[tauri::command]
pub fn ghostty_kill_all(state: tauri::State<'_, GhosttyState>) -> Result<(), String> {
    imp::kill_all(&state)
}

/// DEBUG/automação: envia texto pra surface e lê o grid de volta. Prova o fluxo
/// input→shell→render no app real, sem screenshot. No-op fora do macOS/linked.
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
