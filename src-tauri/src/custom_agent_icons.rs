use std::fs;
use std::path::PathBuf;
use tauri::AppHandle;

const MAX_ICON_BYTES: u64 = 512 * 1024;
fn is_valid_agent_id(id: &str) -> bool {
    if id.len() < 2 || id.len() > 32 {
        return false;
    }
    id.chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

fn icons_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(crate::paths::app_data_dir(app)?.join("custom-agent-icons"))
}

fn icon_path(app: &AppHandle, agent_id: &str) -> Result<PathBuf, String> {
    if !is_valid_agent_id(agent_id) {
        return Err("invalid agent id".to_string());
    }
    Ok(icons_dir(app)?.join(format!("{agent_id}.ico")))
}

fn check_ico_bytes(bytes: &[u8]) -> Result<(), String> {
    if bytes.len() as u64 > MAX_ICON_BYTES {
        return Err("icon exceeds 512KB".to_string());
    }
    if bytes.len() < 4 || bytes[0] != 0x00 || bytes[1] != 0x00 || bytes[2] != 0x01 || bytes[3] != 0x00
    {
        return Err("not a valid .ico file".to_string());
    }
    // Best-effort squareness check on the first directory entry (width/height
    // bytes, where 0 means 256). Undecodable headers still pass on magic alone.
    if bytes.len() >= 8 {
        let width = u32::from(bytes[6]);
        let height = u32::from(bytes[7]);
        let width = if width == 0 { 256 } else { width };
        let height = if height == 0 { 256 } else { height };
        if width != height {
            return Err("icon must be square".to_string());
        }
    }
    Ok(())
}

#[tauri::command]
pub fn import_custom_agent_icon(
    app: AppHandle,
    source_path: String,
    agent_id: String,
) -> Result<(), String> {
    let agent_id = agent_id.trim().to_lowercase();
    let target = icon_path(&app, &agent_id)?;
    let source = source_path.trim();
    if !source.to_lowercase().ends_with(".ico") {
        return Err("only .ico files are accepted".to_string());
    }
    let bytes = fs::read(source).map_err(|error| error.to_string())?;
    check_ico_bytes(&bytes)?;
    let dir = icons_dir(&app)?;
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let tmp = dir.join(format!("{agent_id}.ico.tmp"));
    fs::write(&tmp, &bytes).map_err(|error| error.to_string())?;
    fs::rename(&tmp, &target).map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn custom_agent_icon_path(app: AppHandle, agent_id: String) -> Result<String, String> {
    let agent_id = agent_id.trim().to_lowercase();
    let path = icon_path(&app, &agent_id)?;
    if !path.is_file() {
        return Err("icon asset not found".to_string());
    }
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn remove_custom_agent_icon(app: AppHandle, agent_id: String) -> Result<(), String> {
    let agent_id = agent_id.trim().to_lowercase();
    let path = icon_path(&app, &agent_id)?;
    if path.is_file() {
        fs::remove_file(&path).map_err(|error| error.to_string())?;
    }
    Ok(())
}
