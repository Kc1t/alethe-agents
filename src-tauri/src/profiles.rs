use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager};

pub(crate) use crate::provider_common::now_ms;

const PROFILES_DIR_NAME: &str = "profiles";
const PROFILES_REGISTRY_FILE: &str = "profiles.json";
const DEFAULT_PROFILE_ID: &str = "default";

const WEBVIEW_CACHE_DIR: &str = "EBWebView";

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ProfileMeta {
    pub id: String,
    pub name: String,
    pub created_at_ms: u64,
    pub last_used_at_ms: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ProfilesIndex {
    pub version: u32,
    pub active_profile_id: String,
    pub profiles: Vec<ProfileMeta>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ProfilesState {
    pub active_profile_id: String,
    pub profiles: Vec<ProfileMeta>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ProfileSummary {
    pub id: String,
    pub name: String,
    pub profile_image_url: String,
    pub created_at_ms: u64,
    pub last_used_at_ms: u64,
    pub project_count: usize,
    pub terminal_count: usize,
    pub is_active: bool,
}

fn root_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map_err(|error| error.to_string())
}

fn profiles_root_dir(root: &Path) -> PathBuf {
    root.join(PROFILES_DIR_NAME)
}

fn registry_path(root: &Path) -> PathBuf {
    root.join(PROFILES_REGISTRY_FILE)
}

fn profile_dir(root: &Path, id: &str) -> PathBuf {
    profiles_root_dir(root).join(id)
}

pub fn profile_data_dir_for_id(app: &AppHandle, profile_id: &str) -> Result<PathBuf, String> {
    let root = root_data_dir(app)?;
    let index = ensure_profiles_index(app)?;
    if !index
        .profiles
        .iter()
        .any(|profile| profile.id == profile_id)
    {
        return Err("profile not found".to_string());
    }
    Ok(profile_dir(&root, profile_id))
}

pub fn default_profiles_index() -> ProfilesIndex {
    let now = now_ms();
    ProfilesIndex {
        version: 1,
        active_profile_id: DEFAULT_PROFILE_ID.to_string(),
        profiles: vec![ProfileMeta {
            id: DEFAULT_PROFILE_ID.to_string(),
            name: "Default".to_string(),
            created_at_ms: now,
            last_used_at_ms: now,
        }],
    }
}

pub fn parse_profiles_index(raw: &str) -> Result<ProfilesIndex, String> {
    let mut index: ProfilesIndex = serde_json::from_str(raw).map_err(|error| error.to_string())?;
    if index.version != 1 {
        return Err(format!(
            "unsupported profiles index version: {}",
            index.version
        ));
    }
    if index.profiles.is_empty() {
        return Ok(default_profiles_index());
    }
    if !index
        .profiles
        .iter()
        .any(|profile| profile.id == index.active_profile_id)
    {
        index.active_profile_id = index.profiles[0].id.clone();
    }
    Ok(index)
}

fn write_json_atomic(path: &Path, content: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, content).map_err(|error| error.to_string())?;
    fs::rename(&tmp, path).map_err(|error| error.to_string())
}

fn profiles_state_from(index: &ProfilesIndex) -> ProfilesState {
    let mut profiles = index.profiles.clone();
    profiles.sort_by(|a, b| {
        if a.id == index.active_profile_id {
            return std::cmp::Ordering::Less;
        }
        if b.id == index.active_profile_id {
            return std::cmp::Ordering::Greater;
        }
        b.last_used_at_ms
            .cmp(&a.last_used_at_ms)
            .then_with(|| a.name.cmp(&b.name))
    });
    ProfilesState {
        active_profile_id: index.active_profile_id.clone(),
        profiles,
    }
}

fn profile_summary(
    root: &Path,
    profile: &ProfileMeta,
    active_profile_id: &str,
) -> Result<ProfileSummary, String> {
    let projects_path = profile_dir(root, &profile.id).join("projects.json");
    let (project_count, terminal_count, profile_image_url) = if projects_path.is_file() {
        let raw = fs::read_to_string(projects_path).map_err(|error| error.to_string())?;
        let value: Value = serde_json::from_str(&raw).map_err(|error| error.to_string())?;
        let profile_image_url = value
            .get("preferences")
            .and_then(|preferences| preferences.get("profileImageUrl"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let projects = value.get("projects").and_then(Value::as_array);
        let project_count = projects.map_or(0, Vec::len);
        let terminal_count = projects
            .into_iter()
            .flat_map(|items| items.iter())
            .filter_map(|project| project.get("terminals").and_then(Value::as_array))
            .map(Vec::len)
            .sum();
        (project_count, terminal_count, profile_image_url)
    } else {
        (0, 0, String::new())
    };

    Ok(ProfileSummary {
        id: profile.id.clone(),
        name: profile.name.clone(),
        profile_image_url,
        created_at_ms: profile.created_at_ms,
        last_used_at_ms: profile.last_used_at_ms,
        project_count,
        terminal_count,
        is_active: profile.id == active_profile_id,
    })
}

pub fn list_profile_summaries_state(app: &AppHandle) -> Result<Vec<ProfileSummary>, String> {
    let root = root_data_dir(app)?;
    let index = ensure_profiles_index(app)?;
    let mut summaries = index
        .profiles
        .iter()
        .map(|profile| profile_summary(&root, profile, &index.active_profile_id))
        .collect::<Result<Vec<_>, _>>()?;
    summaries.sort_by(|a, b| {
        b.is_active
            .cmp(&a.is_active)
            .then_with(|| b.last_used_at_ms.cmp(&a.last_used_at_ms))
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok(summaries)
}

fn load_index(root: &Path) -> Result<ProfilesIndex, String> {
    let path = registry_path(root);
    let raw = fs::read_to_string(&path).map_err(|error| error.to_string())?;
    parse_profiles_index(&raw)
}

pub fn write_profiles_index(root: &Path, index: &ProfilesIndex) -> Result<(), String> {
    let path = registry_path(root);
    let json = serde_json::to_string_pretty(index).map_err(|error| error.to_string())?;
    write_json_atomic(&path, &json)
}

pub fn ensure_profile_dirs(root: &Path, index: &ProfilesIndex) -> Result<(), String> {
    fs::create_dir_all(profiles_root_dir(root)).map_err(|error| error.to_string())?;
    for profile in &index.profiles {
        fs::create_dir_all(profile_dir(root, &profile.id)).map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub fn discover_profiles(root: &Path) -> Result<Option<ProfilesIndex>, String> {
    let profiles_root = profiles_root_dir(root);
    if !profiles_root.is_dir() {
        return Ok(None);
    }

    let mut profiles = Vec::new();
    for entry in fs::read_dir(&profiles_root).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let id = entry.file_name().to_string_lossy().to_string();
        let metadata = entry.metadata().map_err(|error| error.to_string())?;
        let created_at_ms = metadata
            .created()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis() as u64)
            .unwrap_or_else(now_ms);
        let last_used_at_ms = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis() as u64)
            .unwrap_or(created_at_ms);
        profiles.push(ProfileMeta {
            id: id.clone(),
            name: if id == DEFAULT_PROFILE_ID {
                "Default".to_string()
            } else {
                id.replace('-', " ")
            },
            created_at_ms,
            last_used_at_ms,
        });
    }

    if profiles.is_empty() {
        return Ok(None);
    }

    profiles.sort_by(|a, b| a.id.cmp(&b.id));
    let active_profile_id = if profiles
        .iter()
        .any(|profile| profile.id == DEFAULT_PROFILE_ID)
    {
        DEFAULT_PROFILE_ID.to_string()
    } else {
        profiles[0].id.clone()
    };
    Ok(Some(ProfilesIndex {
        version: 1,
        active_profile_id,
        profiles,
    }))
}

fn legacy_payload_exists(root: &Path) -> bool {
    root.join("projects.json").exists()
        || root.join("scrollback").exists()
        || root.join("spawn.log").exists()
        || root.join("spotify_tokens.json").exists()
}

fn copy_dir_missing(src: &Path, dst: &Path) -> Result<(), String> {
    if !src.is_dir() {
        return Ok(());
    }
    fs::create_dir_all(dst).map_err(|error| error.to_string())?;
    for entry in fs::read_dir(src).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        if src_path.is_dir() {
            copy_dir_missing(&src_path, &dst_path)?;
        } else if !dst_path.exists() {
            fs::copy(&src_path, &dst_path).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

fn move_entry_into_profile(src: &Path, dst: &Path) -> Result<(), String> {
    if !src.exists() {
        return Ok(());
    }
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    if src.is_dir() {
        copy_dir_missing(src, dst)?;
        fs::remove_dir_all(src).map_err(|error| error.to_string())?;
    } else if !dst.exists() {
        fs::copy(src, dst).map_err(|error| error.to_string())?;
        fs::remove_file(src).map_err(|error| error.to_string())?;
    } else {
        fs::remove_file(src).map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn migrate_legacy_root(root: &Path) -> Result<(), String> {
    let default_dir = profile_dir(root, DEFAULT_PROFILE_ID);
    fs::create_dir_all(&default_dir).map_err(|error| error.to_string())?;
    for entry in fs::read_dir(root).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let name = entry.file_name();
        let name_str = name.to_string_lossy().into_owned();

        if name_str == PROFILES_REGISTRY_FILE
            || name_str == PROFILES_DIR_NAME
            || name_str == WEBVIEW_CACHE_DIR
        {
            continue;
        }

        if let Err(error) = move_entry_into_profile(&entry.path(), &default_dir.join(name)) {
            eprintln!("profiles: skipping legacy entry {name_str}: {error}");
        }
    }
    Ok(())
}

pub fn ensure_profiles_index(app: &AppHandle) -> Result<ProfilesIndex, String> {
    let root = root_data_dir(app)?;
    fs::create_dir_all(profiles_root_dir(&root)).map_err(|error| error.to_string())?;
    let path = registry_path(&root);
    if path.exists() {
        let index = load_index(&root)?;
        ensure_profile_dirs(&root, &index)?;
        return Ok(index);
    }

    let mut index = if let Some(existing) = discover_profiles(&root)? {
        existing
    } else {
        default_profiles_index()
    };

    if legacy_payload_exists(&root) {
        migrate_legacy_root(&root)?;
        index.active_profile_id = DEFAULT_PROFILE_ID.to_string();
        if !index
            .profiles
            .iter()
            .any(|profile| profile.id == DEFAULT_PROFILE_ID)
        {
            let now = now_ms();
            index.profiles.push(ProfileMeta {
                id: DEFAULT_PROFILE_ID.to_string(),
                name: "Default".to_string(),
                created_at_ms: now,
                last_used_at_ms: now,
            });
        }
    }

    ensure_profile_dirs(&root, &index)?;
    write_profiles_index(&root, &index)?;
    Ok(index)
}

pub fn list_profiles_state(app: &AppHandle) -> Result<ProfilesState, String> {
    Ok(profiles_state_from(&ensure_profiles_index(app)?))
}

pub fn set_active_profile_id(app: &AppHandle, profile_id: &str) -> Result<ProfilesState, String> {
    let root = root_data_dir(app)?;
    let mut index = ensure_profiles_index(app)?;
    if !index
        .profiles
        .iter()
        .any(|profile| profile.id == profile_id)
    {
        return Err(format!("profile not found: {profile_id}"));
    }
    let now = now_ms();
    index.active_profile_id = profile_id.to_string();
    index
        .profiles
        .iter_mut()
        .filter(|profile| profile.id == profile_id)
        .for_each(|profile| profile.last_used_at_ms = now);
    ensure_profile_dirs(&root, &index)?;
    write_profiles_index(&root, &index)?;
    Ok(profiles_state_from(&index))
}

pub fn create_profile_state(
    app: &AppHandle,
    name: Option<String>,
) -> Result<ProfilesState, String> {
    let root = root_data_dir(app)?;
    let mut index = ensure_profiles_index(app)?;
    let id = nanoid::nanoid!(10);
    let now = now_ms();
    let profile_name = normalize_profile_name(name.as_deref());
    if index
        .profiles
        .iter()
        .any(|existing| existing.name.eq_ignore_ascii_case(&profile_name))
    {
        return Err("profile_name_exists".to_string());
    }
    let profile = ProfileMeta {
        id: id.clone(),
        name: profile_name,
        created_at_ms: now,
        last_used_at_ms: now,
    };
    index.profiles.push(profile);
    ensure_profile_dirs(&root, &index)?;
    write_profiles_index(&root, &index)?;
    Ok(profiles_state_from(&index))
}

pub fn rename_profile_state(
    app: &AppHandle,
    profile_id: &str,
    name: String,
) -> Result<ProfilesState, String> {
    let root = root_data_dir(app)?;
    let mut index = ensure_profiles_index(app)?;
    let updated = normalize_profile_name(Some(&name));
    if index
        .profiles
        .iter()
        .any(|profile| profile.id != profile_id && profile.name.eq_ignore_ascii_case(&updated))
    {
        return Err("profile_name_exists".to_string());
    }
    let mut found = false;
    for profile in &mut index.profiles {
        if profile.id == profile_id {
            profile.name = updated.clone();
            profile.last_used_at_ms = now_ms();
            found = true;
        }
    }
    if !found {
        return Err(format!("profile not found: {profile_id}"));
    }
    ensure_profile_dirs(&root, &index)?;
    write_profiles_index(&root, &index)?;
    Ok(profiles_state_from(&index))
}

pub fn delete_profile_state(app: &AppHandle, profile_id: &str) -> Result<ProfilesState, String> {
    let root = root_data_dir(app)?;
    let mut index = ensure_profiles_index(app)?;
    if index.profiles.len() <= 1 {
        return Err("cannot delete the last local profile".to_string());
    }
    let target = index
        .profiles
        .iter()
        .find(|profile| profile.id == profile_id)
        .cloned()
        .ok_or_else(|| format!("profile not found: {profile_id}"))?;
    let target_dir = profile_dir(&root, &target.id);
    if target_dir.exists() {
        fs::remove_dir_all(&target_dir).map_err(|error| error.to_string())?;
    }

    index.profiles.retain(|profile| profile.id != profile_id);
    if index.active_profile_id == profile_id {
        let fallback = index
            .profiles
            .iter()
            .find(|profile| profile.id == DEFAULT_PROFILE_ID)
            .or_else(|| index.profiles.first())
            .cloned()
            .ok_or_else(|| "no fallback profile available".to_string())?;
        index.active_profile_id = fallback.id.clone();
        for profile in &mut index.profiles {
            if profile.id == fallback.id {
                profile.last_used_at_ms = now_ms();
            }
        }
    }
    ensure_profile_dirs(&root, &index)?;
    write_profiles_index(&root, &index)?;
    Ok(profiles_state_from(&index))
}

pub fn active_profile_state(app: &AppHandle) -> Result<ProfileMeta, String> {
    let index = ensure_profiles_index(app)?;
    let active_profile_id = index.active_profile_id.clone();
    index
        .profiles
        .into_iter()
        .find(|profile| profile.id == active_profile_id)
        .ok_or_else(|| "active profile not found".to_string())
}

#[tauri::command]
pub fn list_profiles(app: AppHandle) -> Result<ProfilesState, String> {
    list_profiles_state(&app)
}

#[tauri::command]
pub fn list_profile_summaries(app: AppHandle) -> Result<Vec<ProfileSummary>, String> {
    list_profile_summaries_state(&app)
}

#[tauri::command]
pub fn get_active_profile(app: AppHandle) -> Result<ProfileMeta, String> {
    active_profile_state(&app)
}

#[tauri::command]
pub fn set_active_profile(app: AppHandle, profile_id: String) -> Result<ProfilesState, String> {
    set_active_profile_id(&app, &profile_id)
}

#[tauri::command]
pub fn create_profile(app: AppHandle, name: Option<String>) -> Result<ProfilesState, String> {
    create_profile_state(&app, name)
}

#[tauri::command]
pub fn rename_profile(
    app: AppHandle,
    profile_id: String,
    name: String,
) -> Result<ProfilesState, String> {
    rename_profile_state(&app, &profile_id, name)
}

#[tauri::command]
pub fn delete_profile(app: AppHandle, profile_id: String) -> Result<ProfilesState, String> {
    delete_profile_state(&app, &profile_id)
}

fn normalize_profile_name(name: Option<&str>) -> String {
    let trimmed = name.unwrap_or_default().trim();
    if trimmed.is_empty() {
        "Untitled profile".to_string()
    } else {
        trimmed.to_string()
    }
}
