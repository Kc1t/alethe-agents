//! FFI para o shim C do libghostty (`ghostty_shim.m`).
//!
//! Falamos com o shim, não com o libghostty cru — assim a ABI das structs
//! grandes (passadas por valor) fica do lado C, onde o `ghostty.h` real a
//! define. O Rust só vê ponteiros opacos e tipos primitivos.
//!
//! Só compila no macOS quando o build.rs detectou o libghostty (`ghostty_linked`).
#![cfg(all(target_os = "macos", ghostty_linked))]

use std::os::raw::{c_char, c_void};

pub type AletheSurface = *mut c_void;

// `ensure_app` é chamado internamente pelo shim em `surface_new`; `app_tick`
// será usado pelo display link na fase de render contínuo. Exportados pra
// quando precisarmos chamá-los direto do Rust.
#[allow(dead_code)]
extern "C" {
    pub fn alethe_ghostty_ensure_app() -> bool;
    pub fn alethe_ghostty_surface_new(
        nsview: *mut c_void,
        cwd: *const c_char,
        command: *const c_char,
        scale_factor: f64,
    ) -> AletheSurface;
    pub fn alethe_ghostty_surface_set_frame(
        surface: AletheSurface,
        x: f64,
        y: f64,
        w: f64,
        h: f64,
    );
    pub fn alethe_ghostty_surface_set_hidden(surface: AletheSurface, hidden: bool);
    pub fn alethe_ghostty_surface_set_size(surface: AletheSurface, width_px: u32, height_px: u32);
    pub fn alethe_ghostty_surface_set_content_scale(surface: AletheSurface, x: f64, y: f64);
    pub fn alethe_ghostty_surface_set_focus(surface: AletheSurface, focused: bool);
    pub fn alethe_ghostty_surface_draw(surface: AletheSurface);
    pub fn alethe_ghostty_surface_free(surface: AletheSurface);
    pub fn alethe_ghostty_app_tick();
    pub fn alethe_ghostty_surface_send_text(
        surface: AletheSurface,
        utf8: *const c_char,
        len: usize,
    );
    pub fn alethe_ghostty_surface_read_screen(
        surface: AletheSurface,
        out: *mut c_char,
        cap: usize,
    ) -> usize;
    pub fn alethe_ghostty_draw_count() -> u64;
}
