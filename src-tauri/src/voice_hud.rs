//! The floating voice HUD: its window, where it goes on screen, and the relay between it and the
//! main window. The placement maths is kept pure so it can be tested.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

pub const HUD_LABEL: &str = "voice-hud";
const STATE_EVENT: &str = "voice-hud://state";
const ACTION_EVENT: &str = "voice-hud://action";
const MOVED_EVENT: &str = "voice-hud://moved";
const SHORTCUT_EVENT: &str = "voice://shortcut";

pub const HUD_WIDTH: f64 = 560.0;
pub const HUD_HEIGHT: f64 = 240.0;
pub const HUD_MARGIN: f64 = 48.0;

#[derive(Clone, Copy, Debug, PartialEq, Deserialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Preset {
    BottomCenter,
    BottomLeft,
    BottomRight,
    TopCenter,
    TopLeft,
    TopRight,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct CustomPosition {
    pub monitor: String,
    pub x: f64,
    pub y: f64,
    /// The monitor's full bounds in physical pixels when it was saved. macOS names monitors after
    /// their model, so two identical displays share a name; positions saved before this have none.
    #[serde(default)]
    pub bounds: Option<Rect>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum HudPlacement {
    Preset { preset: Preset },
    Custom { custom: CustomPosition },
}

#[derive(Clone, Debug)]
pub struct MonitorArea {
    pub name: String,
    pub work_area: Rect,
    /// The full monitor in physical pixels, compared with `CustomPosition::bounds`.
    pub bounds: Rect,
    /// Physical pixels per logical pixel on this monitor.
    pub scale: f64,
}

impl MonitorArea {
    #[cfg(test)]
    fn clone_area(&self) -> Self {
        self.clone()
    }
}

pub fn preset_origin(area: Rect, preset: Preset) -> (f64, f64) {
    let left = area.x + HUD_MARGIN;
    let center = area.x + (area.width - HUD_WIDTH) / 2.0;
    let right = area.x + area.width - HUD_WIDTH - HUD_MARGIN;
    let top = area.y + HUD_MARGIN;
    let bottom = area.y + area.height - HUD_HEIGHT - HUD_MARGIN;
    match preset {
        Preset::BottomCenter => (center, bottom),
        Preset::BottomLeft => (left, bottom),
        Preset::BottomRight => (right, bottom),
        Preset::TopCenter => (center, top),
        Preset::TopLeft => (left, top),
        Preset::TopRight => (right, top),
    }
}

/// Places a dragged HUD from its saved fractions, keeping all of it on screen.
pub fn custom_origin(area: Rect, x: f64, y: f64) -> (f64, f64) {
    let max_x = area.x + (area.width - HUD_WIDTH).max(0.0);
    let max_y = area.y + (area.height - HUD_HEIGHT).max(0.0);
    let ox = (area.x + x * area.width).clamp(area.x, max_x);
    let oy = (area.y + y * area.height).clamp(area.y, max_y);
    (ox, oy)
}

pub fn fractions_for(area: Rect, origin: (f64, f64)) -> (f64, f64) {
    let fx = if area.width > 0.0 { (origin.0 - area.x) / area.width } else { 0.0 };
    let fy = if area.height > 0.0 { (origin.1 - area.y) / area.height } else { 0.0 };
    (fx.clamp(0.0, 1.0), fy.clamp(0.0, 1.0))
}

fn bounds_distance(a: Rect, b: Rect) -> f64 {
    (a.x - b.x).abs() + (a.y - b.y).abs() + (a.width - b.width).abs() + (a.height - b.height).abs()
}

/// The connected monitor a custom position was saved on: same name and bounds, else the same name
/// with the nearest bounds (the display was rearranged), else the first with that name when the
/// position was saved without bounds.
pub fn custom_monitor<'a>(custom: &CustomPosition, monitors: &'a [MonitorArea]) -> Option<&'a MonitorArea> {
    let mut named = monitors.iter().filter(|m| m.name == custom.monitor);
    match custom.bounds {
        None => named.next(),
        Some(saved) => named.min_by(|a, b| {
            bounds_distance(a.bounds, saved).total_cmp(&bounds_distance(b.bounds, saved))
        }),
    }
}

/// The monitor the HUD lands on: the saved one for a custom position when it is connected,
/// otherwise the one under the pointer.
pub fn target_monitor<'a>(
    placement: &HudPlacement,
    monitors: &'a [MonitorArea],
    pointer: &'a MonitorArea,
) -> &'a MonitorArea {
    match placement {
        HudPlacement::Preset { .. } => pointer,
        HudPlacement::Custom { custom } => custom_monitor(custom, monitors).unwrap_or(pointer),
    }
}

pub fn origin_for(placement: &HudPlacement, monitors: &[MonitorArea], pointer: &MonitorArea) -> (f64, f64) {
    match placement {
        HudPlacement::Preset { preset } => preset_origin(pointer.work_area, *preset),
        HudPlacement::Custom { custom } => match custom_monitor(custom, monitors) {
            Some(monitor) => custom_origin(monitor.work_area, custom.x, custom.y),
            // The saved monitor is not connected; the saved position stays for when it is.
            None => preset_origin(pointer.work_area, Preset::BottomCenter),
        },
    }
}

/// A logical origin in the target monitor's space, in physical pixels. Outside macOS a
/// `LogicalPosition` is converted with the scale of the monitor the window is on now, which is
/// wrong when the HUD moves to a monitor with another scale.
#[cfg(any(test, not(target_os = "macos")))]
pub fn physical_origin(origin: (f64, f64), scale: f64) -> (i32, i32) {
    ((origin.0 * scale).round() as i32, (origin.1 * scale).round() as i32)
}

/// The Alt variant that starts a Jev turn, or `None` when the shortcut already holds Alt (a legacy
/// value): `Alt+Alt+X` cannot be registered.
pub fn jev_accelerator(accelerator: &str) -> Option<String> {
    let mut parts: Vec<&str> = accelerator.split('+').map(str::trim).collect();
    parts.pop();
    let has_alt = parts.iter().any(|p| p.eq_ignore_ascii_case("alt") || p.eq_ignore_ascii_case("option"));
    (!has_alt).then(|| format!("Alt+{accelerator}"))
}

/// True when the HUD sits exactly where `voice_hud_show` last put it: the window reports its own
/// placement as a move too, and that must not be saved as a drag.
pub fn is_placement_echo(placed: Option<(i32, i32)>, now: (i32, i32)) -> bool {
    placed == Some(now)
}

/// Bumped by every hide, so a show that started before it does not bring the HUD back.
#[derive(Default)]
pub struct ShowGeneration(AtomicU64);

impl ShowGeneration {
    pub fn current(&self) -> u64 {
        self.0.load(Ordering::SeqCst)
    }

    pub fn cancel(&self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }

    pub fn is_current(&self, generation: u64) -> bool {
        self.current() == generation
    }
}

/// Where `voice_hud_show` last placed the HUD (physical outer position), and the show generation.
#[derive(Default)]
pub struct HudWindowState {
    placed: Mutex<Option<(i32, i32)>>,
    pub generation: ShowGeneration,
}

impl HudWindowState {
    fn set_placed(&self, origin: Option<(i32, i32)>) {
        if let Ok(mut slot) = self.placed.lock() {
            *slot = origin;
        }
    }

    fn placed(&self) -> Option<(i32, i32)> {
        self.placed.lock().ok().and_then(|slot| *slot)
    }
}

pub fn require_window(label: &str, expected: &str) -> Result<(), String> {
    if label == expected {
        Ok(())
    } else {
        Err(format!("window {label} may not call this command"))
    }
}

/// The last state the main window published, so a HUD that loads late starts from it.
#[derive(Default)]
pub struct StateStore(Mutex<Option<String>>);

impl StateStore {
    pub fn set(&self, state: String) {
        if let Ok(mut slot) = self.0.lock() {
            *slot = Some(state);
        }
    }

    pub fn get(&self) -> Option<String> {
        self.0.lock().ok().and_then(|slot| slot.clone())
    }
}

/// Registered accelerators, so a change unregisters exactly what was registered.
#[derive(Default)]
pub struct ShortcutState(Mutex<Vec<String>>);

/// Creates the hidden HUD window. Called from `setup` through `tauri::async_runtime::spawn`:
/// building a window synchronously there deadlocks on Windows.
pub async fn create_hud(app: AppHandle) -> Result<(), String> {
    if app.get_webview_window(HUD_LABEL).is_some() {
        return Ok(());
    }
    let builder = WebviewWindowBuilder::new(&app, HUD_LABEL, WebviewUrl::App("index.html".into()))
        .title("Alethe voice")
        .inner_size(HUD_WIDTH, HUD_HEIGHT)
        .resizable(false)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focusable(false)
        // macOS: the first click on the non-key panel (Allow / Deny) reaches the page.
        .accept_first_mouse(true)
        .visible_on_all_workspaces(true)
        .visible(false);
    // macOS: a clear window lets the page draw the rounded shape, so the corners look the same
    // whether Alethe is active or not.
    #[cfg(target_os = "macos")]
    let builder = builder.transparent(true);
    let window = builder.build().map_err(|e| e.to_string())?;
    #[cfg(target_os = "macos")]
    {
        // AppKit calls must run on the main thread; this task runs on the async runtime.
        let (tx, rx) = tokio::sync::oneshot::channel();
        let panel_window = window.clone();
        app.run_on_main_thread(move || {
            let _ = tx.send(macos::make_panel(&panel_window));
        })
        .map_err(|e| e.to_string())?;
        rx.await.map_err(|e| e.to_string())??;
    }
    let _ = window;
    Ok(())
}

/// Matches `border-radius` on the HUD root in `VoiceHud.module.css`.
#[cfg(target_os = "macos")]
const HUD_CORNER_RADIUS: f64 = 14.0;

#[cfg(target_os = "macos")]
mod macos {
    use super::HUD_CORNER_RADIUS;
    use tauri_nspanel::{tauri_panel, CollectionBehavior, PanelLevel, WebviewWindowExt};

    tauri_panel! {
        panel!(VoiceHudPanel {
            config: {
                can_become_key_window: false,
                is_floating_panel: true
            }
        })
    }

    /// A non-activating panel: clicking Allow on the HUD must not pull Alethe in front of the
    /// app the person is working in.
    pub fn make_panel<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) -> Result<(), String> {
        let panel = window.to_panel::<VoiceHudPanel<R>>().map_err(|e| e.to_string())?;
        panel.set_level(PanelLevel::Floating.value());
        panel
            .add_style_mask(tauri_nspanel::objc2_app_kit::NSWindowStyleMask::NonactivatingPanel)
            .map_err(|e| e.to_string())?;
        panel.set_collection_behavior(
            CollectionBehavior::new().can_join_all_spaces().full_screen_auxiliary().into(),
        );
        panel.set_transparent(true);
        panel.set_corner_radius(HUD_CORNER_RADIUS);
        // The radius alone only rounds the layer's own background; clip the webview to it too.
        unsafe {
            use tauri_nspanel::objc2::{msg_send, rc::Retained, runtime::AnyObject};
            let layer: Option<Retained<AnyObject>> = msg_send![&*panel.content_view(), layer];
            if let Some(layer) = layer {
                let _: () = msg_send![&*layer, setMasksToBounds: true];
            }
        }
        Ok(())
    }
}

/// Native show/hide on Windows: `ShowWindow(SW_SHOW)` can activate the HUD right after the
/// hotkey and take focus from the person's app. Both directions are native so they stay paired.
#[cfg(windows)]
mod native {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        SetWindowPos, ShowWindow, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
        SWP_SHOWWINDOW, SW_HIDE,
    };

    pub fn show(window: &tauri::WebviewWindow) -> Result<(), String> {
        let hwnd = window.hwnd().map_err(|e| e.to_string())?.0;
        let flags = SWP_SHOWWINDOW | SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE;
        if unsafe { SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, flags) } == 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        Ok(())
    }

    pub fn hide(window: &tauri::WebviewWindow) -> Result<(), String> {
        let hwnd = window.hwnd().map_err(|e| e.to_string())?.0;
        // The return value is the previous visibility, not an error.
        unsafe { ShowWindow(hwnd, SW_HIDE) };
        Ok(())
    }
}

#[cfg(not(windows))]
mod native {
    pub fn show(window: &tauri::WebviewWindow) -> Result<(), String> {
        window.show().map_err(|e| e.to_string())
    }

    pub fn hide(window: &tauri::WebviewWindow) -> Result<(), String> {
        window.hide().map_err(|e| e.to_string())
    }
}

/// A monitor's work area in logical pixels, with its full bounds in physical pixels.
fn logical_area(monitor: &tauri::Monitor) -> MonitorArea {
    let scale = monitor.scale_factor();
    let wa = monitor.work_area();
    let (position, size) = (monitor.position(), monitor.size());
    MonitorArea {
        name: monitor.name().cloned().unwrap_or_default(),
        bounds: Rect {
            x: position.x as f64,
            y: position.y as f64,
            width: size.width as f64,
            height: size.height as f64,
        },
        work_area: Rect {
            x: wa.position.x as f64 / scale,
            y: wa.position.y as f64 / scale,
            width: wa.size.width as f64 / scale,
            height: wa.size.height as f64 / scale,
        },
        scale,
    }
}

/// Every monitor, plus the one under the pointer (the primary one when the pointer is unknown).
fn monitor_areas(app: &AppHandle) -> Result<(Vec<MonitorArea>, MonitorArea), String> {
    let monitors = app.available_monitors().map_err(|e| e.to_string())?;
    let areas: Vec<MonitorArea> = monitors.iter().map(logical_area).collect();
    let pointer = app
        .cursor_position()
        .ok()
        .and_then(|p| app.monitor_from_point(p.x, p.y).ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten())
        .ok_or_else(|| "no monitor".to_string())?;
    Ok((areas, logical_area(&pointer)))
}

#[tauri::command]
pub async fn voice_hud_show(
    app: AppHandle,
    webview: tauri::WebviewWindow,
    placement: HudPlacement,
) -> Result<(), String> {
    require_window(webview.label(), "main")?;
    let Some(window) = app.get_webview_window(HUD_LABEL) else {
        return Err("the HUD is not available".into());
    };
    let hud = app.state::<HudWindowState>();
    let generation = hud.generation.current();
    let (monitors, pointer) = monitor_areas(&app)?;
    let origin = origin_for(&placement, &monitors, &pointer);
    place(&window, origin, target_monitor(&placement, &monitors, &pointer).scale)?;
    hud.set_placed(window.outer_position().ok().map(|p| (p.x, p.y)));
    // A hide that arrived while this command was placing the HUD wins.
    if !hud.generation.is_current(generation) {
        return Ok(());
    }
    show_without_focus(&app, &window, generation)
}

/// macOS positions in global points, so logical values go through as they are.
#[cfg(target_os = "macos")]
fn place(window: &tauri::WebviewWindow, origin: (f64, f64), _scale: f64) -> Result<(), String> {
    use tauri::{LogicalPosition, LogicalSize};
    window.set_size(LogicalSize::new(HUD_WIDTH, HUD_HEIGHT)).map_err(|e| e.to_string())?;
    window.set_position(LogicalPosition::new(origin.0, origin.1)).map_err(|e| e.to_string())
}

/// Elsewhere logical values would be converted with the current monitor's scale, so place in
/// physical pixels of the target monitor. Moving first lets a DPI change settle before sizing;
/// moving again undoes any shift the DPI change made.
#[cfg(not(target_os = "macos"))]
fn place(window: &tauri::WebviewWindow, origin: (f64, f64), scale: f64) -> Result<(), String> {
    use tauri::{PhysicalPosition, PhysicalSize};
    let (x, y) = physical_origin(origin, scale);
    let (width, height) = physical_origin((HUD_WIDTH, HUD_HEIGHT), scale);
    let position = PhysicalPosition::new(x, y);
    window.set_position(position).map_err(|e| e.to_string())?;
    window.set_size(PhysicalSize::new(width as u32, height as u32)).map_err(|e| e.to_string())?;
    window.set_position(position).map_err(|e| e.to_string())
}

fn show_without_focus(app: &AppHandle, window: &tauri::WebviewWindow, generation: u64) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use tauri_nspanel::ManagerExt;
        match app.get_webview_panel(HUD_LABEL) {
            Ok(panel) => {
                let handle = app.clone();
                // Checked again on the main thread, where a hide queued meanwhile has already run.
                return app
                    .run_on_main_thread(move || {
                        if handle.state::<HudWindowState>().generation.is_current(generation) {
                            panel.order_front_regardless();
                        }
                    })
                    .map_err(|e| e.to_string());
            }
            Err(_) => eprintln!("[voice_hud] the HUD panel is missing; showing it as a plain window"),
        }
    }
    let _ = (app, generation);
    native::show(window)
}

#[tauri::command]
pub fn voice_hud_hide(app: AppHandle, webview: tauri::WebviewWindow) -> Result<(), String> {
    require_window(webview.label(), "main")?;
    app.state::<HudWindowState>().generation.cancel();
    if let Some(window) = app.get_webview_window(HUD_LABEL) {
        native::hide(&window)?;
    }
    Ok(())
}

#[tauri::command]
pub fn voice_hud_publish(app: AppHandle, webview: tauri::WebviewWindow, state: String) -> Result<(), String> {
    require_window(webview.label(), "main")?;
    app.state::<StateStore>().set(state.clone());
    app.emit_to(HUD_LABEL, STATE_EVENT, state).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn voice_hud_snapshot(webview: tauri::WebviewWindow) -> Result<Option<String>, String> {
    require_window(webview.label(), HUD_LABEL)?;
    Ok(webview.state::<StateStore>().get())
}

#[tauri::command]
pub fn voice_hud_action(app: AppHandle, webview: tauri::WebviewWindow, action: String) -> Result<(), String> {
    require_window(webview.label(), HUD_LABEL)?;
    app.emit_to("main", ACTION_EVENT, action).map_err(|e| e.to_string())
}

/// Reports where the person dropped the HUD, as fractions of its monitor's work area.
#[tauri::command]
pub fn voice_hud_moved(app: AppHandle, webview: tauri::WebviewWindow) -> Result<(), String> {
    require_window(webview.label(), HUD_LABEL)?;
    let monitor = webview.current_monitor().map_err(|e| e.to_string())?.ok_or("no monitor")?;
    let scale = monitor.scale_factor();
    let position = webview.outer_position().map_err(|e| e.to_string())?;
    if is_placement_echo(webview.state::<HudWindowState>().placed(), (position.x, position.y)) {
        return Ok(());
    }
    let area = logical_area(&monitor);
    let (x, y) = fractions_for(area.work_area, (position.x as f64 / scale, position.y as f64 / scale));
    let b = area.bounds;
    let payload = serde_json::json!({
        "monitor": area.name,
        "x": x,
        "y": y,
        "bounds": { "x": b.x, "y": b.y, "width": b.width, "height": b.height },
    });
    app.emit_to("main", MOVED_EVENT, payload).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn voice_shortcut_set(
    app: AppHandle,
    webview: tauri::WebviewWindow,
    accelerator: Option<String>,
) -> Result<(), String> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    require_window(webview.label(), "main")?;
    let shortcuts = app.global_shortcut();
    let state = app.state::<ShortcutState>();
    let mut registered = state.0.lock().map_err(|_| "shortcut state poisoned".to_string())?;
    let previous = std::mem::take(&mut *registered);
    for old in &previous {
        let _ = shortcuts.unregister(old.as_str());
    }
    let Some(plain) = accelerator.filter(|a| !a.trim().is_empty()) else {
        return Ok(());
    };
    let jev = jev_accelerator(&plain);
    if jev.is_none() {
        eprintln!("[voice_hud] {plain} already holds Alt; registering it without the Jev variant");
    }
    let result = shortcuts
        .register(plain.as_str())
        .and_then(|()| jev.as_deref().map_or(Ok(()), |jev| shortcuts.register(jev)));
    match result {
        Ok(()) => {
            *registered = std::iter::once(plain).chain(jev).collect();
            Ok(())
        }
        Err(error) => {
            let _ = shortcuts.unregister(plain.as_str());
            // Restore what worked before, so a failed change never leaves voice without a shortcut.
            let mut restored = Vec::with_capacity(previous.len());
            for old in previous {
                match shortcuts.register(old.as_str()) {
                    Ok(()) => restored.push(old),
                    Err(e) => eprintln!("[voice_hud] could not restore the shortcut {old}: {e}"),
                }
            }
            *registered = restored;
            Err(format!("shortcut unavailable: {error}"))
        }
    }
}

/// Plugin handler: forwards press/release of our accelerators to the main window.
pub fn on_shortcut(
    app: &AppHandle,
    shortcut: &tauri_plugin_global_shortcut::Shortcut,
    event: tauri_plugin_global_shortcut::ShortcutEvent,
) {
    use tauri_plugin_global_shortcut::{Modifiers, ShortcutState as KeyState};
    let state = match event.state() {
        KeyState::Pressed => "pressed",
        KeyState::Released => "released",
    };
    // A legacy shortcut that holds Alt has no Jev variant, so its Alt is not a Jev press.
    // `try_lock`: on X11 this runs on the hotkey thread that `voice_shortcut_set` waits on while
    // holding the lock, so blocking here would deadlock; mid-change, assume the variant exists.
    let has_jev_variant = app.state::<ShortcutState>().0.try_lock().map(|r| r.len() > 1).unwrap_or(true);
    let jev = has_jev_variant && shortcut.mods.contains(Modifiers::ALT);
    let _ = app.emit_to("main", SHORTCUT_EVENT, serde_json::json!({ "state": state, "jev": jev }));
}

#[cfg(test)]
mod tests {
    use super::*;

    const AREA: Rect = Rect { x: 0.0, y: 25.0, width: 1440.0, height: 875.0 };

    #[test]
    fn presets_sit_inside_the_work_area_with_the_margin() {
        assert_eq!(preset_origin(AREA, Preset::BottomCenter), (440.0, 25.0 + 875.0 - 240.0 - 48.0));
        assert_eq!(preset_origin(AREA, Preset::BottomLeft), (48.0, 612.0));
        assert_eq!(preset_origin(AREA, Preset::BottomRight), (1440.0 - 560.0 - 48.0, 612.0));
        assert_eq!(preset_origin(AREA, Preset::TopCenter), (440.0, 25.0 + 48.0));
        assert_eq!(preset_origin(AREA, Preset::TopLeft), (48.0, 73.0));
        assert_eq!(preset_origin(AREA, Preset::TopRight), (832.0, 73.0));
    }

    #[test]
    fn a_second_monitor_offsets_the_origin() {
        let right = Rect { x: 1440.0, y: 0.0, width: 1920.0, height: 1080.0 };
        assert_eq!(preset_origin(right, Preset::BottomCenter), (1440.0 + 680.0, 1080.0 - 288.0));
    }

    #[test]
    fn custom_fractions_round_trip_and_are_clamped_on_screen() {
        let origin = (300.0, 400.0);
        let (fx, fy) = fractions_for(AREA, origin);
        let back = custom_origin(AREA, fx, fy);
        assert!((back.0 - origin.0).abs() < 0.5 && (back.1 - origin.1).abs() < 0.5);
        // Off-screen fractions keep the whole HUD visible.
        assert_eq!(custom_origin(AREA, 2.0, -1.0), (1440.0 - 560.0, 25.0));
        assert_eq!(custom_origin(AREA, -3.0, 5.0), (0.0, 25.0 + 875.0 - 240.0));
    }

    #[test]
    fn custom_uses_its_monitor_and_falls_back_when_it_is_gone() {
        let main = MonitorArea { name: "Built-in".into(), work_area: AREA, bounds: Rect { x: 0.0, y: 0.0, width: 2880.0, height: 1800.0 }, scale: 2.0 };
        let side = MonitorArea { name: "DELL".into(), work_area: Rect { x: 1440.0, y: 0.0, width: 1920.0, height: 1080.0 }, bounds: Rect { x: 2880.0, y: 0.0, width: 1920.0, height: 1080.0 }, scale: 1.0 };
        let placement = HudPlacement::Custom { custom: CustomPosition { monitor: "DELL".into(), x: 0.5, y: 0.5, bounds: None } };
        let on_side = origin_for(&placement, &[main.clone_area(), side.clone_area()], &main);
        assert!(on_side.0 >= 1440.0);
        // The saved monitor is not connected: bottom-center on the pointer's monitor.
        assert_eq!(origin_for(&placement, &[main.clone_area()], &main), preset_origin(AREA, Preset::BottomCenter));
        let preset = HudPlacement::Preset { preset: Preset::TopRight };
        assert_eq!(origin_for(&preset, &[main.clone_area(), side.clone_area()], &side), preset_origin(side.work_area, Preset::TopRight));
    }

    #[test]
    fn the_jev_variant_adds_alt() {
        assert_eq!(jev_accelerator("CmdOrCtrl+Shift+Space").as_deref(), Some("Alt+CmdOrCtrl+Shift+Space"));
        assert_eq!(jev_accelerator("F9").as_deref(), Some("Alt+F9"));
    }

    #[test]
    fn a_shortcut_that_already_has_alt_gets_no_jev_variant() {
        assert_eq!(jev_accelerator("Alt+CmdOrCtrl+K"), None);
        assert_eq!(jev_accelerator("CmdOrCtrl+option+K"), None);
        assert_eq!(jev_accelerator("Shift+ALT+F9"), None);
        // Only modifiers count: a key is never Alt.
        assert_eq!(jev_accelerator("CmdOrCtrl+A").as_deref(), Some("Alt+CmdOrCtrl+A"));
    }

    fn twin(work_x: f64, bounds_x: f64) -> MonitorArea {
        MonitorArea {
            name: "Monitor #41234".into(),
            work_area: Rect { x: work_x, y: 0.0, width: 1920.0, height: 1080.0 },
            bounds: Rect { x: bounds_x, y: 0.0, width: 1920.0, height: 1080.0 },
            scale: 1.0,
        }
    }

    fn custom_on(bounds: Option<Rect>) -> CustomPosition {
        CustomPosition { monitor: "Monitor #41234".into(), x: 0.5, y: 0.5, bounds }
    }

    #[test]
    fn identical_monitors_are_told_apart_by_their_bounds() {
        let monitors = [twin(0.0, 0.0), twin(1920.0, 1920.0)];
        let right = custom_on(Some(monitors[1].bounds));
        assert_eq!(custom_monitor(&right, &monitors).unwrap().work_area.x, 1920.0);
        let left = custom_on(Some(monitors[0].bounds));
        assert_eq!(custom_monitor(&left, &monitors).unwrap().work_area.x, 0.0);
    }

    #[test]
    fn a_moved_monitor_falls_back_to_the_nearest_with_the_same_name() {
        let monitors = [twin(0.0, 0.0), twin(1920.0, 1920.0)];
        let saved = Rect { x: 2000.0, y: 100.0, width: 1920.0, height: 1080.0 };
        assert_eq!(custom_monitor(&custom_on(Some(saved)), &monitors).unwrap().work_area.x, 1920.0);
        // Another name never matches, however close its bounds are.
        let other = CustomPosition { monitor: "DELL".into(), ..custom_on(Some(monitors[1].bounds)) };
        assert!(custom_monitor(&other, &monitors).is_none());
    }

    #[test]
    fn a_position_saved_without_bounds_matches_by_name() {
        let monitors = [twin(0.0, 0.0), twin(1920.0, 1920.0)];
        assert_eq!(custom_monitor(&custom_on(None), &monitors).unwrap().work_area.x, 0.0);
        let placement = HudPlacement::Custom { custom: custom_on(Some(monitors[1].bounds)) };
        let pointer = twin(0.0, 0.0);
        assert_eq!(target_monitor(&placement, &monitors, &pointer).work_area.x, 1920.0);
        assert_eq!(origin_for(&placement, &monitors, &pointer), custom_origin(monitors[1].work_area, 0.5, 0.5));
    }

    #[test]
    fn a_hide_cancels_a_show_that_has_not_landed() {
        let generation = ShowGeneration::default();
        let show = generation.current();
        assert!(generation.is_current(show));
        generation.cancel();
        assert!(!generation.is_current(show));
        let next = generation.current();
        assert!(generation.is_current(next));
    }

    #[test]
    fn a_move_to_the_placed_origin_is_not_a_drag() {
        assert!(is_placement_echo(Some((100, 200)), (100, 200)));
        assert!(!is_placement_echo(Some((100, 200)), (101, 200)));
        assert!(!is_placement_echo(None, (100, 200)));
    }

    #[test]
    fn the_target_monitor_is_the_one_the_origin_is_computed_on() {
        let main = MonitorArea { name: "Built-in".into(), work_area: AREA, bounds: Rect { x: 0.0, y: 0.0, width: 2880.0, height: 1800.0 }, scale: 2.0 };
        let side = MonitorArea { name: "DELL".into(), work_area: Rect { x: 1440.0, y: 0.0, width: 1920.0, height: 1080.0 }, bounds: Rect { x: 2880.0, y: 0.0, width: 2400.0, height: 1350.0 }, scale: 1.25 };
        let monitors = [main.clone_area(), side.clone_area()];
        let custom = HudPlacement::Custom { custom: CustomPosition { monitor: "DELL".into(), x: 0.5, y: 0.5, bounds: None } };
        assert_eq!(target_monitor(&custom, &monitors, &main).scale, 1.25);
        // A saved monitor that is gone falls back to the pointer's monitor, like `origin_for`.
        assert_eq!(target_monitor(&custom, &[main.clone_area()], &main).scale, 2.0);
        let preset = HudPlacement::Preset { preset: Preset::BottomCenter };
        assert_eq!(target_monitor(&preset, &monitors, &side).name, "DELL");
    }

    #[test]
    fn logical_origins_become_physical_with_the_target_scale() {
        assert_eq!(physical_origin((440.0, 612.0), 1.0), (440, 612));
        assert_eq!(physical_origin((1440.0 + 680.0, 792.0), 1.5), (3180, 1188));
        assert_eq!(physical_origin((100.0, 50.5), 1.5), (150, 76));
        assert_eq!(physical_origin((-1920.0, 0.0), 1.25), (-2400, 0));
    }

    #[test]
    fn commands_accept_only_their_window() {
        assert!(require_window("main", "main").is_ok());
        assert!(require_window("voice-hud", "main").is_err());
        assert!(require_window("orchestration-x", "voice-hud").is_err());
        assert!(require_window("voice-hud", "voice-hud").is_ok());
    }

    #[test]
    fn the_snapshot_keeps_the_last_published_state() {
        let store = StateStore::default();
        assert_eq!(store.get(), None);
        store.set("{\"a\":1}".to_string());
        store.set("{\"a\":2}".to_string());
        assert_eq!(store.get().as_deref(), Some("{\"a\":2}"));
    }

    #[test]
    fn placements_deserialize_from_the_frontend_shape() {
        let preset: HudPlacement = serde_json::from_str(r#"{"kind":"preset","preset":"bottom-left"}"#).unwrap();
        assert_eq!(preset, HudPlacement::Preset { preset: Preset::BottomLeft });
        let custom: HudPlacement = serde_json::from_str(r#"{"kind":"custom","custom":{"monitor":"DELL","x":0.1,"y":0.2}}"#).unwrap();
        assert_eq!(custom, HudPlacement::Custom { custom: CustomPosition { monitor: "DELL".into(), x: 0.1, y: 0.2, bounds: None } });
        let with_bounds: HudPlacement = serde_json::from_str(
            r#"{"kind":"custom","custom":{"monitor":"DELL","x":0.1,"y":0.2,"bounds":{"x":-1920,"y":0,"width":1920,"height":1080}}}"#,
        )
        .unwrap();
        let bounds = Rect { x: -1920.0, y: 0.0, width: 1920.0, height: 1080.0 };
        assert_eq!(with_bounds, HudPlacement::Custom { custom: CustomPosition { monitor: "DELL".into(), x: 0.1, y: 0.2, bounds: Some(bounds) } });
    }
}
