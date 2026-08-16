use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::AppHandle;

use crate::cli_resolver::find_vscode_launcher;
use crate::paths::{app_data_dir, spawn_log_path};

fn existing_path_from_user_input(path: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("path vazio".to_string());
    }
    let target = PathBuf::from(trimmed);
    if !target.exists() {
        return Err(format!("path nao existe: {trimmed}"));
    }
    Ok(target)
}

#[tauri::command]
pub fn open_in_file_explorer(path: String) -> Result<(), String> {
    let target = existing_path_from_user_input(&path)?;

    #[cfg(target_os = "windows")]
    let result = if target.is_file() {
        Command::new("explorer")
            .arg("/select,")
            .arg(target.as_os_str())
            .spawn()
    } else {
        Command::new("explorer").arg(target.as_os_str()).spawn()
    };

    #[cfg(target_os = "macos")]
    let result = if target.is_file() {
        Command::new("open")
            .arg("-R")
            .arg(target.as_os_str())
            .spawn()
    } else {
        Command::new("open").arg(target.as_os_str()).spawn()
    };

    #[cfg(all(unix, not(target_os = "macos")))]
    let result = {
        let dir = if target.is_file() {
            target
                .parent()
                .map(|p| p.to_path_buf())
                .unwrap_or_else(|| target.clone())
        } else {
            target.clone()
        };
        Command::new("xdg-open").arg(dir.as_os_str()).spawn()
    };

    result.map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn open_in_vscode(path: String) -> Result<(), String> {
    let target = existing_path_from_user_input(&path)?;
    let launcher = find_vscode_launcher().ok_or_else(|| {
        "VS Code não encontrado (procurado em PATH, LOCALAPPDATA, ProgramFiles)".to_string()
    })?;
    let is_cmd = launcher
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.eq_ignore_ascii_case("cmd"))
        .unwrap_or(false);

    let result = if is_cmd {
        let mut command = Command::new("cmd");
        command
            .arg("/C")
            .arg(launcher.as_os_str())
            .arg(target.as_os_str());
        crate::git_control::hide_console(&mut command);
        command.spawn()
    } else {
        let mut command = Command::new(launcher.as_os_str());
        command.arg(target.as_os_str());
        crate::git_control::hide_console(&mut command);
        command.spawn()
    };
    result.map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn open_in_browser(target: String) -> Result<(), String> {
    let trimmed = target.trim();
    if trimmed.is_empty() {
        return Err("target vazio".to_string());
    }

    let open_target = if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        trimmed.to_string()
    } else {
        existing_path_from_user_input(trimmed)?
            .canonicalize()
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .to_string()
    };

    #[cfg(target_os = "windows")]
    let result = Command::new("rundll32")
        .arg("url.dll,FileProtocolHandler")
        .arg(open_target)
        .spawn();

    #[cfg(target_os = "macos")]
    let result = Command::new("open").arg(open_target).spawn();

    #[cfg(all(unix, not(target_os = "macos")))]
    let result = Command::new("xdg-open").arg(open_target).spawn();

    result.map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn write_clipboard_text(text: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        windows_clipboard::write_text(&text)
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        unix_clipboard::write_text(&text)
    }

    #[cfg(target_os = "macos")]
    {
        macos_clipboard::write_text(&text)
    }
}

#[tauri::command]
pub fn read_clipboard_text() -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        windows_clipboard::read_text()
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        unix_clipboard::read_text()
    }

    #[cfg(target_os = "macos")]
    {
        macos_clipboard::read_text()
    }
}

/// Unified clipboard payload: text, file paths (CF_HDROP on Windows, text/uri-list
/// on Linux) or a raw image (registered CF_DIB/PNG on Windows, image/png on Linux)
/// already written to a temporary PNG.
#[derive(serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ClipboardPayload {
    Text { text: String },
    Paths { paths: Vec<String> },
    Image { path: String },
    Empty,
}

#[tauri::command]
pub fn read_clipboard_payload() -> Result<ClipboardPayload, String> {
    #[cfg(target_os = "windows")]
    {
        windows_clipboard::read_payload()
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        unix_clipboard::read_payload()
    }

    #[cfg(target_os = "macos")]
    {
        macos_clipboard::read_payload()
    }
}

#[cfg(target_os = "windows")]
mod windows_clipboard {
    use std::ptr;
    use std::thread;
    use std::time::Duration;
    use windows_sys::Win32::Foundation::GlobalFree;
    use windows_sys::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, GetClipboardData, IsClipboardFormatAvailable,
        OpenClipboard, RegisterClipboardFormatW, SetClipboardData,
    };
    use windows_sys::Win32::System::Memory::{
        GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE,
    };
    use windows_sys::Win32::System::Ole::{CF_DIB, CF_HDROP, CF_UNICODETEXT};
    use windows_sys::Win32::UI::Shell::{DragQueryFileW, HDROP};

    use super::ClipboardPayload;

    const CF_UNICODETEXT_U32: u32 = CF_UNICODETEXT as u32;
    const CF_HDROP_U32: u32 = CF_HDROP as u32;
    const CF_DIB_U32: u32 = CF_DIB as u32;

    struct ClipboardGuard;

    impl Drop for ClipboardGuard {
        fn drop(&mut self) {
            unsafe {
                CloseClipboard();
            }
        }
    }

    fn open_clipboard() -> Result<ClipboardGuard, String> {
        for _ in 0..20 {
            let opened = unsafe { OpenClipboard(ptr::null_mut()) };
            if opened != 0 {
                return Ok(ClipboardGuard);
            }
            thread::sleep(Duration::from_millis(15));
        }
        Err("clipboard ocupado".to_string())
    }

    pub fn write_text(text: &str) -> Result<(), String> {
        let _guard = open_clipboard()?;
        let mut wide = text.encode_utf16().collect::<Vec<u16>>();
        wide.push(0);
        let size_bytes = wide.len() * std::mem::size_of::<u16>();

        let handle = unsafe { GlobalAlloc(GMEM_MOVEABLE, size_bytes) };
        if handle.is_null() {
            return Err("GlobalAlloc clipboard falhou".to_string());
        }

        let locked = unsafe { GlobalLock(handle) } as *mut u16;
        if locked.is_null() {
            unsafe {
                GlobalFree(handle);
            }
            return Err("GlobalLock clipboard falhou".to_string());
        }

        unsafe {
            locked.copy_from_nonoverlapping(wide.as_ptr(), wide.len());
            GlobalUnlock(handle);
        }

        let emptied = unsafe { EmptyClipboard() };
        if emptied == 0 {
            unsafe {
                GlobalFree(handle);
            }
            return Err("EmptyClipboard falhou".to_string());
        }

        let stored = unsafe { SetClipboardData(CF_UNICODETEXT_U32, handle) };
        if stored.is_null() {
            unsafe {
                GlobalFree(handle);
            }
            return Err("SetClipboardData falhou".to_string());
        }

        Ok(())
    }

    pub fn read_text() -> Result<String, String> {
        let _guard = open_clipboard()?;
        let available = unsafe { IsClipboardFormatAvailable(CF_UNICODETEXT_U32) };
        if available == 0 {
            return Ok(String::new());
        }
        read_unicode_text_locked()
    }

    /// Le CF_UNICODETEXT assumindo que o clipboard ja esta aberto e o formato

    fn read_unicode_text_locked() -> Result<String, String> {
        let handle = unsafe { GetClipboardData(CF_UNICODETEXT_U32) };
        if handle.is_null() {
            return Err("GetClipboardData falhou".to_string());
        }

        let locked = unsafe { GlobalLock(handle) } as *const u16;
        if locked.is_null() {
            return Err("GlobalLock clipboard falhou".to_string());
        }

        let mut len = 0usize;
        unsafe {
            while *locked.add(len) != 0 {
                len += 1;
            }
            let slice = std::slice::from_raw_parts(locked, len);
            let text = String::from_utf16_lossy(slice);
            GlobalUnlock(handle);
            Ok(text)
        }
    }

    /// Enumera os paths de CF_HDROP (arquivos copiados no Windows Explorer).

    fn read_hdrop_paths() -> Result<Vec<String>, String> {
        let handle = unsafe { GetClipboardData(CF_HDROP_U32) };
        if handle.is_null() {
            return Err("GetClipboardData falhou".to_string());
        }
        let hdrop = handle as HDROP;

        let count = unsafe { DragQueryFileW(hdrop, u32::MAX, ptr::null_mut(), 0) };
        let mut paths = Vec::with_capacity(count as usize);
        for i in 0..count {
            let len = unsafe { DragQueryFileW(hdrop, i, ptr::null_mut(), 0) };
            if len == 0 {
                continue;
            }
            let mut buf = vec![0u16; len as usize + 1];
            let written = unsafe { DragQueryFileW(hdrop, i, buf.as_mut_ptr(), buf.len() as u32) };
            if written == 0 {
                continue;
            }
            paths.push(String::from_utf16_lossy(&buf[..written as usize]));
        }
        Ok(paths)
    }

    /// Le os bytes crus de um formato de clipboard ja verificado como
    /// disponivel (via GlobalLock/GlobalSize).
    fn read_format_bytes(format: u32) -> Result<Vec<u8>, String> {
        let handle = unsafe { GetClipboardData(format) };
        if handle.is_null() {
            return Err("GetClipboardData falhou".to_string());
        }
        let size = unsafe { GlobalSize(handle) };
        let locked = unsafe { GlobalLock(handle) } as *const u8;
        if locked.is_null() {
            return Err("GlobalLock clipboard falhou".to_string());
        }
        let bytes = unsafe {
            let slice = std::slice::from_raw_parts(locked, size);
            let owned = slice.to_vec();
            GlobalUnlock(handle);
            owned
        };
        Ok(bytes)
    }

    fn write_bytes_to_temp_png(bytes: &[u8]) -> Result<String, String> {
        let path =
            std::env::temp_dir().join(format!("alethe-clipboard-img-{}.png", nanoid::nanoid!(8)));
        std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
        Ok(path.to_string_lossy().into_owned())
    }

    /// Se o clipboard tiver o formato registrado "PNG" (Chrome/Edge colocam

    fn read_registered_png() -> Option<Result<String, String>> {
        let name: Vec<u16> = "PNG".encode_utf16().chain(std::iter::once(0)).collect();
        let format = unsafe { RegisterClipboardFormatW(name.as_ptr()) };
        if format == 0 || unsafe { IsClipboardFormatAvailable(format) } == 0 {
            return None;
        }
        Some(read_format_bytes(format).and_then(|bytes| write_bytes_to_temp_png(&bytes)))
    }

    /// 14 bytes que um .bmp de verdade tem. Prepende esse header manualmente

    fn read_dib_as_png() -> Result<String, String> {
        let dib = read_format_bytes(CF_DIB_U32)?;
        if dib.len() < 40 {
            return Err("dados DIB invalidos".to_string());
        }

        let header_size = u32::from_le_bytes(dib[0..4].try_into().unwrap()) as usize;
        let bit_count = u16::from_le_bytes(dib[14..16].try_into().unwrap());
        let colors_used = u32::from_le_bytes(dib[32..36].try_into().unwrap());
        let palette_entries = if colors_used != 0 {
            colors_used as usize
        } else if bit_count <= 8 {
            1usize << bit_count
        } else {
            0
        };
        let pixel_offset = 14 + header_size + palette_entries * 4;
        let file_size = 14 + dib.len();

        let mut bmp = Vec::with_capacity(file_size);
        bmp.extend_from_slice(b"BM");
        bmp.extend_from_slice(&(file_size as u32).to_le_bytes());
        bmp.extend_from_slice(&0u16.to_le_bytes());
        bmp.extend_from_slice(&0u16.to_le_bytes());
        bmp.extend_from_slice(&(pixel_offset as u32).to_le_bytes());
        bmp.extend_from_slice(&dib);

        let img = image::load_from_memory_with_format(&bmp, image::ImageFormat::Bmp)
            .map_err(|e| e.to_string())?;
        let path =
            std::env::temp_dir().join(format!("alethe-clipboard-img-{}.png", nanoid::nanoid!(8)));
        img.save_with_format(&path, image::ImageFormat::Png)
            .map_err(|e| e.to_string())?;
        Ok(path.to_string_lossy().into_owned())
    }

    pub fn read_payload() -> Result<ClipboardPayload, String> {
        let _guard = open_clipboard()?;

        if unsafe { IsClipboardFormatAvailable(CF_UNICODETEXT_U32) } != 0 {
            return read_unicode_text_locked().map(|text| ClipboardPayload::Text { text });
        }

        if unsafe { IsClipboardFormatAvailable(CF_HDROP_U32) } != 0 {
            return read_hdrop_paths().map(|paths| ClipboardPayload::Paths { paths });
        }

        if let Some(result) = read_registered_png() {
            return result.map(|path| ClipboardPayload::Image { path });
        }

        if unsafe { IsClipboardFormatAvailable(CF_DIB_U32) } != 0 {
            return read_dib_as_png().map(|path| ClipboardPayload::Image { path });
        }

        Ok(ClipboardPayload::Empty)
    }
}

/// Backend de clipboard pra Linux/BSD via ferramentas de linha de comando
/// (`wl-paste`/`wl-copy` no Wayland, `xclip` no X11) — sem essas ferramentas
/// instaladas, os comandos de clipboard retornam erro em vez de panicar.
#[cfg(all(unix, not(target_os = "macos")))]
mod unix_clipboard {
    use std::io::Write;
    use std::process::{Command, Stdio};

    use super::ClipboardPayload;

    fn wayland() -> bool {
        std::env::var_os("WAYLAND_DISPLAY").is_some()
    }

    fn paste_tool() -> Result<&'static str, String> {
        let (tool, package) = if wayland() {
            ("wl-paste", "wl-clipboard")
        } else {
            ("xclip", "xclip")
        };
        which::which(tool)
            .map(|_| tool)
            .map_err(|_| format!("{tool} não encontrado no PATH (pacote `{package}`)"))
    }

    fn copy_tool() -> Result<&'static str, String> {
        let (tool, package) = if wayland() {
            ("wl-copy", "wl-clipboard")
        } else {
            ("xclip", "xclip")
        };
        which::which(tool)
            .map(|_| tool)
            .map_err(|_| format!("{tool} não encontrado no PATH (pacote `{package}`)"))
    }

    /// Lista os mimetypes disponíveis no clipboard (equivalente a
    /// IsClipboardFormatAvailable, mas descobrindo tudo de uma vez).
    fn list_types() -> Vec<String> {
        let Ok(tool) = paste_tool() else {
            return Vec::new();
        };
        let output = if tool == "wl-paste" {
            Command::new("wl-paste").arg("--list-types").output()
        } else {
            Command::new("xclip")
                .args(["-selection", "clipboard", "-t", "TARGETS", "-o"])
                .output()
        };
        output
            .ok()
            .filter(|o| o.status.success())
            .map(|o| {
                String::from_utf8_lossy(&o.stdout)
                    .lines()
                    .map(str::trim)
                    .filter(|line| !line.is_empty())
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default()
    }

    fn read_type(mime: &str) -> Result<Vec<u8>, String> {
        let tool = paste_tool()?;
        let output = if tool == "wl-paste" {
            Command::new("wl-paste")
                .args(["--type", mime, "--no-newline"])
                .output()
        } else {
            Command::new("xclip")
                .args(["-selection", "clipboard", "-t", mime, "-o"])
                .output()
        }
        .map_err(|e| e.to_string())?;
        if !output.status.success() {
            return Err(format!("falha ao ler clipboard ({mime})"));
        }
        Ok(output.stdout)
    }

    /// `text/uri-list` é o mimetype padrão que gerenciadores de arquivo
    /// (Nautilus, Dolphin, Thunar, ...) usam ao copiar arquivos: uma lista de
    /// URIs `file://` separadas por linha, com comentários opcionais em `#`.
    /// GNOME/Nautilus às vezes só expõe `x-special/gnome-copied-files`
    /// (mesmo formato, com uma linha extra "copy"/"cut" no início).
    fn parse_uri_list(raw: &str) -> Vec<String> {
        raw.lines()
            .map(str::trim)
            .filter(|line| !line.is_empty() && !line.starts_with('#'))
            .filter_map(|line| line.strip_prefix("file://"))
            .map(|encoded| {
                urlencoding::decode(encoded)
                    .map(|decoded| decoded.into_owned())
                    .unwrap_or_else(|_| encoded.to_string())
            })
            .collect()
    }

    fn save_png_to_temp(bytes: &[u8]) -> Result<String, String> {
        let path =
            std::env::temp_dir().join(format!("alethe-clipboard-img-{}.png", nanoid::nanoid!(8)));
        std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
        Ok(path.to_string_lossy().into_owned())
    }

    pub fn read_payload() -> Result<ClipboardPayload, String> {
        let types = list_types();
        if types.is_empty() {
            return Ok(ClipboardPayload::Empty);
        }

        // Mesma ordem de prioridade do backend Windows: arquivos > imagem > texto.
        let uri_mime = ["text/uri-list", "x-special/gnome-copied-files"]
            .into_iter()
            .find(|mime| types.iter().any(|t| t == mime));
        if let Some(mime) = uri_mime {
            let raw = String::from_utf8_lossy(&read_type(mime)?).into_owned();
            let paths = parse_uri_list(&raw);
            if !paths.is_empty() {
                return Ok(ClipboardPayload::Paths { paths });
            }
        }

        // image/png cobre a esmagadora maioria dos casos reais (screenshots,
        // "copiar imagem" no navegador). Formatos crus como image/bmp ou
        // image/jpeg não são reencodados aqui de propósito, pra não exigir
        // features extras da crate `image` só pra esse caminho.
        if types.iter().any(|t| t == "image/png") {
            let bytes = read_type("image/png")?;
            if !bytes.is_empty() {
                return save_png_to_temp(&bytes).map(|path| ClipboardPayload::Image { path });
            }
        }

        if types.iter().any(|t| t.starts_with("text/plain")) {
            let text = String::from_utf8_lossy(&read_type("text/plain")?).into_owned();
            if !text.is_empty() {
                return Ok(ClipboardPayload::Text { text });
            }
        }

        Ok(ClipboardPayload::Empty)
    }

    pub fn read_text() -> Result<String, String> {
        if !list_types().iter().any(|t| t.starts_with("text/plain")) {
            return Ok(String::new());
        }
        read_type("text/plain").map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
    }

    pub fn write_text(text: &str) -> Result<(), String> {
        let tool = copy_tool()?;
        let mut command = if tool == "wl-copy" {
            Command::new("wl-copy")
        } else {
            let mut cmd = Command::new("xclip");
            cmd.args(["-selection", "clipboard"]);
            cmd
        };

        let mut child = command
            .stdin(Stdio::piped())
            .spawn()
            .map_err(|e| e.to_string())?;
        child
            .stdin
            .take()
            .ok_or_else(|| "stdin do clipboard indisponível".to_string())?
            .write_all(text.as_bytes())
            .map_err(|e| e.to_string())?;

        let status = child.wait().map_err(|e| e.to_string())?;
        if !status.success() {
            return Err(format!("{tool} retornou erro"));
        }
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn parse_uri_list_decodes_percent_encoded_paths() {
            let raw = "file:///home/user/My%20Screenshot.png\nfile:///tmp/plain.png\n";
            assert_eq!(
                parse_uri_list(raw),
                vec![
                    "/home/user/My Screenshot.png".to_string(),
                    "/tmp/plain.png".to_string()
                ]
            );
        }

        #[test]
        fn parse_uri_list_skips_comments_and_non_file_lines() {
            let raw = "# copy\nfile:///a/b.txt\nhttp://example.com/not-a-file\n";
            assert_eq!(parse_uri_list(raw), vec!["/a/b.txt".to_string()]);
        }

        #[test]
        fn parse_uri_list_handles_empty_input() {
            assert!(parse_uri_list("").is_empty());
        }
    }
}

pub fn append_spawn_log(app: &AppHandle, message: &str) -> Result<(), String> {
    use std::io::Write;
    let path = spawn_log_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|error| error.to_string())?;
    writeln!(file, "[{}] {message}", timestamp_ms()).map_err(|error| error.to_string())
}

pub fn timestamp_ms() -> String {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(duration) => format!("{}.{:03}", duration.as_secs(), duration.subsec_millis()),
        Err(_) => "0.000".to_string(),
    }
}

#[tauri::command]
pub fn open_data_folder(app: AppHandle) -> Result<(), String> {
    let path = app_data_dir(&app)?;
    fs::create_dir_all(&path).map_err(|error| error.to_string())?;

    #[cfg(target_os = "windows")]
    let result = Command::new("explorer").arg(&path).spawn();
    #[cfg(target_os = "macos")]
    let result = Command::new("open").arg(&path).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let result = Command::new("xdg-open").arg(&path).spawn();

    result.map(|_| ()).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn open_spawn_log(app: AppHandle) -> Result<(), String> {
    let path = spawn_log_path(&app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    if !path.exists() {
        fs::write(&path, "").map_err(|error| error.to_string())?;
    }

    #[cfg(target_os = "windows")]
    let result = Command::new("notepad").arg(&path).spawn();
    #[cfg(target_os = "macos")]
    let result = Command::new("open").arg(&path).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let result = Command::new("xdg-open").arg(&path).spawn();

    result.map(|_| ()).map_err(|error| error.to_string())
}

/// permitir que o app continue rodando.
#[tauri::command]
pub fn reset_app_data(app: AppHandle) -> Result<(), String> {
    let dir = app_data_dir(&app)?;
    if !dir.exists() {
        return Ok(());
    }
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            let _ = if path.is_dir() {
                fs::remove_dir_all(&path)
            } else {
                fs::remove_file(&path)
            };
        }
    }
    Ok(())
}

/// Full factory reset: wipes every profile, the profiles registry and logs
/// under the app's local data root, so the next launch behaves like a fresh
/// install. Best-effort — files currently held open by the running app are
/// skipped; the caller should relaunch so nothing keeps them locked.
#[tauri::command]
pub fn wipe_all_app_data(app: AppHandle) -> Result<(), String> {
    use tauri::Manager;
    let root = app
        .path()
        .app_local_data_dir()
        .map_err(|error| error.to_string())?;
    if !root.exists() {
        return Ok(());
    }
    if let Ok(entries) = fs::read_dir(&root) {
        for entry in entries.flatten() {
            let path = entry.path();
            let _ = if path.is_dir() {
                fs::remove_dir_all(&path)
            } else {
                fs::remove_file(&path)
            };
        }
    }
    Ok(())
}

#[tauri::command]
pub fn open_logs_folder(app: AppHandle) -> Result<(), String> {
    let path = crate::logging::logs_dir(&app)?;
    fs::create_dir_all(&path).map_err(|error| error.to_string())?;

    #[cfg(target_os = "windows")]
    let result = Command::new("explorer").arg(&path).spawn();
    #[cfg(target_os = "macos")]
    let result = Command::new("open").arg(&path).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let result = Command::new("xdg-open").arg(&path).spawn();

    result.map(|_| ()).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn export_logs(app: AppHandle, target_path: String) -> Result<(), String> {
    use std::io::Write;
    use zip::write::FileOptions;
    use zip::{CompressionMethod, ZipWriter};

    let dir = crate::logging::logs_dir(&app)?;
    let target = PathBuf::from(target_path);
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let file = fs::File::create(&target).map_err(|e| e.to_string())?;
    let mut zip = ZipWriter::new(file);
    let opts = FileOptions::default().compression_method(CompressionMethod::Deflated);

    if dir.is_dir() {
        for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let name = path
                .file_name()
                .ok_or_else(|| "log sem nome".to_string())?
                .to_string_lossy()
                .to_string();
            zip.start_file(name, opts).map_err(|e| e.to_string())?;
            let bytes = fs::read(&path).map_err(|e| e.to_string())?;
            zip.write_all(&bytes).map_err(|e| e.to_string())?;
        }
    }
    zip.finish().map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(target_os = "macos")]
mod macos_clipboard {
    use std::io::Write;
    use std::process::{Command, Stdio};

    use super::ClipboardPayload;

    pub fn write_text(text: &str) -> Result<(), String> {
        let mut child = Command::new("pbcopy")
            .stdin(Stdio::piped())
            .spawn()
            .map_err(|e| e.to_string())?;

        if let Some(mut stdin) = child.stdin.take() {
            stdin
                .write_all(text.as_bytes())
                .map_err(|e| e.to_string())?;
        }

        let status = child.wait().map_err(|e| e.to_string())?;
        if status.success() {
            Ok(())
        } else {
            Err("pbcopy falhou".to_string())
        }
    }

    pub fn read_text() -> Result<String, String> {
        let output = Command::new("pbpaste")
            .output()
            .map_err(|e| e.to_string())?;
        if output.status.success() {
            Ok(String::from_utf8_lossy(&output.stdout).to_string())
        } else {
            Err("pbpaste falhou".to_string())
        }
    }

    pub fn read_payload() -> Result<ClipboardPayload, String> {
        let text = read_text()?;
        if text.trim().is_empty() {
            Ok(ClipboardPayload::Empty)
        } else {
            Ok(ClipboardPayload::Text { text })
        }
    }
}
