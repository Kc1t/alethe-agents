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
        Command::new("open").arg("-R").arg(target.as_os_str()).spawn()
    } else {
        Command::new("open").arg(target.as_os_str()).spawn()
    };

    // xdg-open não tem "revelar/selecionar": abre o diretório (pai, se for arquivo).
    #[cfg(all(unix, not(target_os = "macos")))]
    let result = {
        let dir = if target.is_file() {
            target.parent().map(|p| p.to_path_buf()).unwrap_or_else(|| target.clone())
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
        command.arg("/C").arg(launcher.as_os_str()).arg(target.as_os_str());
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

    #[cfg(not(target_os = "windows"))]
    {
        unix_clipboard::write_text(&text)
    }
}

#[tauri::command]
pub fn read_clipboard_text() -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        windows_clipboard::read_text()
    }

    #[cfg(not(target_os = "windows"))]
    {
        unix_clipboard::read_text()
    }
}

/// Payload unificado do clipboard: texto, paths de arquivo (CF_HDROP) ou uma
/// imagem crua (CF_DIB / formato "PNG" registrado) já salva num PNG temporario.
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

    #[cfg(not(target_os = "windows"))]
    {
        unix_clipboard::read_payload()
    }
}

#[cfg(target_os = "windows")]
mod windows_clipboard {
    use std::ptr;
    use std::thread;
    use std::time::Duration;
    use windows_sys::Win32::Foundation::GlobalFree;
    use windows_sys::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard,
        RegisterClipboardFormatW, SetClipboardData,
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
    /// disponivel foi verificado pelo chamador.
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
    /// O handle de CF_HDROP e usado diretamente por DragQueryFileW — sem
    /// GlobalLock/GlobalUnlock, diferente dos outros formatos deste modulo.
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
    /// isso ao copiar uma imagem da web), os bytes ja sao um PNG valido —
    /// grava direto em disco, sem recodificar.
    fn read_registered_png() -> Option<Result<String, String>> {
        let name: Vec<u16> = "PNG".encode_utf16().chain(std::iter::once(0)).collect();
        let format = unsafe { RegisterClipboardFormatW(name.as_ptr()) };
        if format == 0 || unsafe { IsClipboardFormatAvailable(format) } == 0 {
            return None;
        }
        Some(read_format_bytes(format).and_then(|bytes| write_bytes_to_temp_png(&bytes)))
    }

    /// CF_DIB devolve um BITMAPINFOHEADER + pixels, sem o BITMAPFILEHEADER de
    /// 14 bytes que um .bmp de verdade tem. Prepende esse header manualmente
    /// pra poder decodificar com a crate `image` e reexportar como PNG.
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

/// Backend de clipboard pra Linux/macOS via `arboard` (usa o próprio
/// backend X11/Wayland do sistema, sem depender do GTK). Cobre texto e
/// imagem — paths de arquivo (equivalente ao CF_HDROP do Windows) não têm
/// API estável no arboard, então esse payload cai pra `Empty` fora do
/// Windows em vez de tentar advinhar um formato.
#[cfg(not(target_os = "windows"))]
mod unix_clipboard {
    use super::ClipboardPayload;

    fn open() -> Result<arboard::Clipboard, String> {
        arboard::Clipboard::new().map_err(|e| e.to_string())
    }

    pub fn write_text(text: &str) -> Result<(), String> {
        open()?.set_text(text).map_err(|e| e.to_string())
    }

    pub fn read_text() -> Result<String, String> {
        open()?.get_text().map_err(|e| e.to_string())
    }

    fn image_to_temp_png(image: arboard::ImageData) -> Result<String, String> {
        let width = image.width as u32;
        let height = image.height as u32;
        let buffer = image::RgbaImage::from_raw(width, height, image.bytes.into_owned())
            .ok_or_else(|| "dados de imagem do clipboard invalidos".to_string())?;
        let path =
            std::env::temp_dir().join(format!("alethe-clipboard-img-{}.png", nanoid::nanoid!(8)));
        buffer.save_with_format(&path, image::ImageFormat::Png).map_err(|e| e.to_string())?;
        Ok(path.to_string_lossy().into_owned())
    }

    pub fn read_payload() -> Result<ClipboardPayload, String> {
        let mut clipboard = open()?;

        if let Ok(text) = clipboard.get_text() {
            if !text.is_empty() {
                return Ok(ClipboardPayload::Text { text });
            }
        }

        if let Ok(image) = clipboard.get_image() {
            return image_to_temp_png(image).map(|path| ClipboardPayload::Image { path });
        }

        Ok(ClipboardPayload::Empty)
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

/// Limpa todo o conteúdo de `%LOCALAPPDATA%\dev.alethe\` (projects.json,
/// scrollback/, spawn.log). Itera em vez de remover o dir inteiro pra
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

/// Abre a pasta de logs (raiz `app_local_data_dir()/logs`, compartilhada por
/// todos os perfis) no explorer/Finder.
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

/// Empacota a pasta de logs num zip em `target_path` (pra anexar a um report de
/// bug). Mesmo padrão de `backup::export_backup`.
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
