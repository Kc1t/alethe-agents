use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager};

pub(crate) use crate::provider_common::now_ms;

const PROFILES_DIR_NAME: &str = "profiles";
const PROFILES_REGISTRY_FILE: &str = "profiles.json";
const DEFAULT_PROFILE_ID: &str = "default";
const MIGRATION_BACKUPS_DIR: &str = ".migration-backups";
/// WebView2 runtime cache. It can be locked while the app is running and is
/// safe to regenerate, so it must never be moved into a profile.
const WEBVIEW_CACHE_DIR: &str = "EBWebView";

static PROFILES_MUTEX: OnceLock<Mutex<()>> = OnceLock::new();

fn profiles_mutex() -> &'static Mutex<()> {
    PROFILES_MUTEX.get_or_init(|| Mutex::new(()))
}

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

#[derive(Serialize)]
pub struct CoreStorageIdentity {
    pub app_identifier: String,
    pub data_root_id: String,
}

pub fn data_root_fingerprint(path: &Path) -> String {
    let canonical = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let normalized = if cfg!(windows) {
        canonical.to_string_lossy().to_lowercase()
    } else {
        canonical.to_string_lossy().into_owned()
    };
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in normalized.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

fn explicit_data_root() -> Result<Option<PathBuf>, String> {
    let Some(value) = std::env::var_os("ALETHE_APP_DATA_DIR") else {
        return Ok(None);
    };
    let path = PathBuf::from(value);
    if path.as_os_str().is_empty() {
        return Ok(None);
    }
    if !path.is_absolute() {
        return Err("ALETHE_APP_DATA_DIR must be an absolute path".to_string());
    }
    Ok(Some(path))
}

fn prepare_data_root(path: PathBuf) -> Result<PathBuf, String> {
    fs::create_dir_all(&path).map_err(|error| {
        format!(
            "Unable to create the Alethe data root at {}: {error}",
            path.display()
        )
    })?;
    Ok(path)
}

pub fn resolve_tauri_data_root(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(path) = explicit_data_root()? {
        return prepare_data_root(path);
    }
    let path = app
        .path()
        .app_local_data_dir()
        .map_err(|error| error.to_string())?;
    prepare_data_root(path)
}

pub fn default_standalone_identifier() -> &'static str {
    if cfg!(debug_assertions) {
        "com.kc1t.alethe.dev"
    } else {
        "com.kc1t.alethe"
    }
}

pub fn resolve_standalone_identifier() -> Result<String, String> {
    let identifier = std::env::var("ALETHE_APP_IDENTIFIER")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| default_standalone_identifier().to_string());
    let trimmed = identifier.trim();
    let path = Path::new(trimmed);
    if trimmed == "." || trimmed == ".." || path.is_absolute() || path.components().count() != 1 {
        return Err("ALETHE_APP_IDENTIFIER must be a single safe path component".to_string());
    }
    Ok(trimmed.to_string())
}

pub fn resolve_standalone_data_root() -> Result<PathBuf, String> {
    if let Some(path) = explicit_data_root()? {
        return prepare_data_root(path);
    }
    let base = dirs_next::data_local_dir()
        .ok_or_else(|| "Unable to resolve the platform local data directory".to_string())?;
    prepare_data_root(base.join(resolve_standalone_identifier()?))
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

pub(crate) fn profile_dir_for_id_in_index(
    root: &Path,
    index: &ProfilesIndex,
    profile_id: &str,
) -> Result<PathBuf, String> {
    if !index
        .profiles
        .iter()
        .any(|profile| profile.id == profile_id)
    {
        return Err(format!("profile not found: {profile_id}"));
    }
    Ok(profile_dir(root, profile_id))
}

pub fn profile_data_dir_for_id_at(root: &Path, profile_id: &str) -> Result<PathBuf, String> {
    let index = ensure_profiles_index_at(root)?;
    profile_dir_for_id_in_index(root, &index, profile_id)
}

pub fn profile_data_dir_for_id(app: &AppHandle, profile_id: &str) -> Result<PathBuf, String> {
    profile_data_dir_for_id_at(&resolve_tauri_data_root(app)?, profile_id)
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
    let index: ProfilesIndex = serde_json::from_str(raw).map_err(|error| error.to_string())?;
    if index.version != 1 {
        return Err(format!(
            "unsupported profiles index version: {}",
            index.version
        ));
    }
    if index.profiles.is_empty() {
        return Err("profiles index cannot be empty".to_string());
    }
    let mut profile_ids = HashSet::new();
    for profile in &index.profiles {
        let path = Path::new(&profile.id);
        if profile.id.is_empty()
            || profile.id == "."
            || profile.id == ".."
            || path.is_absolute()
            || path.components().count() != 1
        {
            return Err(format!("invalid profile id: {}", profile.id));
        }
        if !profile_ids.insert(profile.id.as_str()) {
            return Err(format!("duplicate profile id: {}", profile.id));
        }
    }
    if !index
        .profiles
        .iter()
        .any(|profile| profile.id == index.active_profile_id)
    {
        return Err(format!(
            "active profile not found: {}",
            index.active_profile_id
        ));
    }
    Ok(index)
}

#[cfg(windows)]
fn replace_file(source: &Path, destination: &Path) -> Result<(), String> {
    use std::iter::once;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let source_wide = source
        .as_os_str()
        .encode_wide()
        .chain(once(0))
        .collect::<Vec<_>>();
    let destination_wide = destination
        .as_os_str()
        .encode_wide()
        .chain(once(0))
        .collect::<Vec<_>>();
    let result = unsafe {
        MoveFileExW(
            source_wide.as_ptr(),
            destination_wide.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(std::io::Error::last_os_error().to_string())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn replace_file(source: &Path, destination: &Path) -> Result<(), String> {
    fs::rename(source, destination).map_err(|error| error.to_string())
}

fn write_json_atomic(path: &Path, content: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, content).map_err(|error| error.to_string())?;
    replace_file(&tmp, path)
}

pub(crate) fn profiles_state_from(index: &ProfilesIndex) -> ProfilesState {
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

pub fn list_profile_summaries_state_at(root: &Path) -> Result<Vec<ProfileSummary>, String> {
    let _guard = profiles_mutex()
        .lock()
        .map_err(|_| "Profiles lock poisoned".to_string())?;
    let index = ensure_profiles_index_unlocked(root)?;
    let mut summaries = index
        .profiles
        .iter()
        .map(|profile| profile_summary(root, profile, &index.active_profile_id))
        .collect::<Result<Vec<_>, _>>()?;
    summaries.sort_by(|a, b| {
        b.is_active
            .cmp(&a.is_active)
            .then_with(|| b.last_used_at_ms.cmp(&a.last_used_at_ms))
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok(summaries)
}

pub fn list_profile_summaries_state(app: &AppHandle) -> Result<Vec<ProfileSummary>, String> {
    list_profile_summaries_state_at(&resolve_tauri_data_root(app)?)
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

fn is_legacy_migration_entry(name: &str) -> bool {
    name != PROFILES_REGISTRY_FILE
        && name != PROFILES_DIR_NAME
        && name != WEBVIEW_CACHE_DIR
        && name != MIGRATION_BACKUPS_DIR
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

fn copy_entry_missing(src: &Path, dst: &Path) -> Result<(), String> {
    if !src.exists() {
        return Ok(());
    }
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    if src.is_dir() {
        copy_dir_missing(src, dst)?;
    } else if !dst.exists() {
        fs::copy(src, dst).map_err(|error| error.to_string())?;
    }
    Ok(())
}

struct LegacyMigration {
    backup_dir: PathBuf,
    // Entries with nothing at the destination before the copy — fully
    // merged into the profile, so the root copy is redundant and safe to
    // remove once the recovery backup exists.
    migrated_entries: Vec<PathBuf>,
    // Entries where the destination profile already had its own data.
    // `copy_entry_missing` never overwrites, so the profile's data is
    // untouched; the root's original file is kept in place too (in addition
    // to the recovery backup) so a real conflict never loses data and stays
    // diagnosable instead of disappearing into `.migration-backups/`.
    conflicted_entries: Vec<PathBuf>,
}

fn migrate_legacy_root(root: &Path) -> Result<LegacyMigration, String> {
    let default_dir = profile_dir(root, DEFAULT_PROFILE_ID);
    fs::create_dir_all(&default_dir).map_err(|error| error.to_string())?;

    let backup_dir = root.join(MIGRATION_BACKUPS_DIR).join(format!(
        "legacy-{}-{}",
        now_ms(),
        nanoid::nanoid!(6)
    ));
    fs::create_dir_all(&backup_dir).map_err(|error| error.to_string())?;

    let mut migrated_entries = Vec::new();
    let mut conflicted_entries = Vec::new();
    for entry in fs::read_dir(root).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let name = entry.file_name();
        let name_str = name.to_string_lossy().into_owned();
        if !is_legacy_migration_entry(&name_str) {
            continue;
        }

        let source = entry.path();
        let destination = default_dir.join(&name);
        let already_owned = destination.exists();
        // Complete the recovery copy before touching the live profile. A
        // failure leaves every legacy source untouched and blocks commit.
        copy_entry_missing(&source, &backup_dir.join(&name))?;
        copy_entry_missing(&source, &destination)?;
        if already_owned {
            conflicted_entries.push(source);
        } else {
            migrated_entries.push(source);
        }
    }

    Ok(LegacyMigration {
        backup_dir,
        migrated_entries,
        conflicted_entries,
    })
}

fn cleanup_migrated_legacy_entries(migration: &LegacyMigration) {
    for source in &migration.migrated_entries {
        let result = if source.is_dir() {
            fs::remove_dir_all(source)
        } else {
            fs::remove_file(source)
        };
        if let Err(error) = result {
            eprintln!(
                "[profiles] Failed to remove migrated legacy entry at {}: {error}. Recovery copy: {}",
                source.display(),
                migration.backup_dir.display()
            );
        }
    }
    for source in &migration.conflicted_entries {
        eprintln!(
            "[profiles] Legacy entry at {} conflicts with existing profile data; left in place. Recovery copy: {}",
            source.display(),
            migration.backup_dir.display()
        );
    }
}

fn ensure_profiles_index_unlocked(root: &Path) -> Result<ProfilesIndex, String> {
    fs::create_dir_all(profiles_root_dir(root)).map_err(|error| error.to_string())?;
    let path = registry_path(root);
    if path.exists() {
        let index = load_index(root)?;
        ensure_profile_dirs(root, &index)?;
        // A registry can exist without ever having gone through migration —
        // e.g. an older Web backend wrote an empty/default registry
        // directly while `root/projects.json` from a pre-multi-profile
        // install was still sitting there. Without this, that install opens
        // empty forever even though its real data never moved.
        if legacy_payload_exists(root) {
            let migration = migrate_legacy_root(root)?;
            cleanup_migrated_legacy_entries(&migration);
        }
        return Ok(index);
    }

    let mut index = if let Some(existing) = discover_profiles(root)? {
        existing
    } else {
        default_profiles_index()
    };

    let migration = if legacy_payload_exists(root) {
        let migration = migrate_legacy_root(root)?;
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
        Some(migration)
    } else {
        None
    };

    ensure_profile_dirs(root, &index)?;
    write_profiles_index(root, &index)?;
    if let Some(migration) = migration.as_ref() {
        cleanup_migrated_legacy_entries(migration);
    }
    Ok(index)
}

pub fn ensure_profiles_index_at(root: &Path) -> Result<ProfilesIndex, String> {
    let _guard = profiles_mutex()
        .lock()
        .map_err(|_| "Profiles lock poisoned".to_string())?;
    ensure_profiles_index_unlocked(root)
}

pub(crate) fn with_profiles_index_at<T>(
    root: &Path,
    operation: impl FnOnce(&ProfilesIndex) -> Result<T, String>,
) -> Result<T, String> {
    let _guard = profiles_mutex()
        .lock()
        .map_err(|_| "Profiles lock poisoned".to_string())?;
    let index = ensure_profiles_index_unlocked(root)?;
    operation(&index)
}

pub fn active_profile_dir_at(root: &Path) -> Result<PathBuf, String> {
    with_profiles_index_at(root, |index| {
        Ok(profile_dir(root, &index.active_profile_id))
    })
}

pub fn ensure_profiles_index(app: &AppHandle) -> Result<ProfilesIndex, String> {
    ensure_profiles_index_at(&resolve_tauri_data_root(app)?)
}

pub fn list_profiles_state_at(root: &Path) -> Result<ProfilesState, String> {
    let _guard = profiles_mutex()
        .lock()
        .map_err(|_| "Profiles lock poisoned".to_string())?;
    Ok(profiles_state_from(&ensure_profiles_index_unlocked(root)?))
}

pub fn list_profiles_state(app: &AppHandle) -> Result<ProfilesState, String> {
    list_profiles_state_at(&resolve_tauri_data_root(app)?)
}

pub fn set_active_profile_id_at(root: &Path, profile_id: &str) -> Result<ProfilesState, String> {
    let _guard = profiles_mutex()
        .lock()
        .map_err(|_| "Profiles lock poisoned".to_string())?;
    let mut index = ensure_profiles_index_unlocked(root)?;
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
    ensure_profile_dirs(root, &index)?;
    write_profiles_index(root, &index)?;
    Ok(profiles_state_from(&index))
}

pub fn set_active_profile_id(app: &AppHandle, profile_id: &str) -> Result<ProfilesState, String> {
    set_active_profile_id_at(&resolve_tauri_data_root(app)?, profile_id)
}

pub fn create_profile_state_at(root: &Path, name: Option<String>) -> Result<ProfilesState, String> {
    let _guard = profiles_mutex()
        .lock()
        .map_err(|_| "Profiles lock poisoned".to_string())?;
    let mut index = ensure_profiles_index_unlocked(root)?;
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
    ensure_profile_dirs(root, &index)?;
    write_profiles_index(root, &index)?;
    Ok(profiles_state_from(&index))
}

pub fn create_profile_state(
    app: &AppHandle,
    name: Option<String>,
) -> Result<ProfilesState, String> {
    create_profile_state_at(&resolve_tauri_data_root(app)?, name)
}

pub fn rename_profile_state_at(
    root: &Path,
    profile_id: &str,
    name: String,
) -> Result<ProfilesState, String> {
    let _guard = profiles_mutex()
        .lock()
        .map_err(|_| "Profiles lock poisoned".to_string())?;
    let mut index = ensure_profiles_index_unlocked(root)?;
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
    ensure_profile_dirs(root, &index)?;
    write_profiles_index(root, &index)?;
    Ok(profiles_state_from(&index))
}

pub fn rename_profile_state(
    app: &AppHandle,
    profile_id: &str,
    name: String,
) -> Result<ProfilesState, String> {
    rename_profile_state_at(&resolve_tauri_data_root(app)?, profile_id, name)
}

pub fn delete_profile_state_at(root: &Path, profile_id: &str) -> Result<ProfilesState, String> {
    let _guard = profiles_mutex()
        .lock()
        .map_err(|_| "Profiles lock poisoned".to_string())?;
    let mut index = ensure_profiles_index_unlocked(root)?;
    if index.profiles.len() <= 1 {
        return Err("cannot delete the last local profile".to_string());
    }
    let target = index
        .profiles
        .iter()
        .find(|profile| profile.id == profile_id)
        .cloned()
        .ok_or_else(|| format!("profile not found: {profile_id}"))?;
    let target_dir = profile_dir(root, &target.id);
    let staged_dir =
        root.join(".profile-trash")
            .join(format!("{}-{}", target.id, nanoid::nanoid!(6)));
    let staged = if target_dir.exists() {
        if let Some(parent) = staged_dir.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        fs::rename(&target_dir, &staged_dir).map_err(|error| error.to_string())?;
        true
    } else {
        false
    };

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
    let commit_result =
        ensure_profile_dirs(root, &index).and_then(|_| write_profiles_index(root, &index));
    if let Err(error) = commit_result {
        if staged {
            let _ = fs::rename(&staged_dir, &target_dir);
        }
        return Err(error);
    }
    if staged {
        if let Err(error) = fs::remove_dir_all(&staged_dir) {
            eprintln!(
                "[profiles] Failed to remove staged profile data at {}: {error}",
                staged_dir.display()
            );
        }
    }
    Ok(profiles_state_from(&index))
}

pub fn delete_profile_state(app: &AppHandle, profile_id: &str) -> Result<ProfilesState, String> {
    delete_profile_state_at(&resolve_tauri_data_root(app)?, profile_id)
}

pub fn active_profile_state_at(root: &Path) -> Result<ProfileMeta, String> {
    let _guard = profiles_mutex()
        .lock()
        .map_err(|_| "Profiles lock poisoned".to_string())?;
    let index = ensure_profiles_index_unlocked(root)?;
    let active_profile_id = index.active_profile_id.clone();
    index
        .profiles
        .into_iter()
        .find(|profile| profile.id == active_profile_id)
        .ok_or_else(|| "active profile not found".to_string())
}

pub fn active_profile_state(app: &AppHandle) -> Result<ProfileMeta, String> {
    active_profile_state_at(&resolve_tauri_data_root(app)?)
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

#[tauri::command]
pub fn get_core_storage_identity(app: AppHandle) -> Result<CoreStorageIdentity, String> {
    let data_root = resolve_tauri_data_root(&app)?;
    Ok(CoreStorageIdentity {
        app_identifier: app.config().identifier.clone(),
        data_root_id: data_root_fingerprint(&data_root),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;
    use std::sync::Mutex as TestMutex;

    static ENV_MUTEX: TestMutex<()> = TestMutex::new(());

    struct EnvironmentSnapshot(Vec<(&'static str, Option<OsString>)>);

    impl EnvironmentSnapshot {
        fn capture(keys: &[&'static str]) -> Self {
            Self(
                keys.iter()
                    .map(|key| (*key, std::env::var_os(key)))
                    .collect(),
            )
        }
    }

    impl Drop for EnvironmentSnapshot {
        fn drop(&mut self) {
            for (key, value) in &self.0 {
                match value {
                    Some(value) => std::env::set_var(key, value),
                    None => std::env::remove_var(key),
                }
            }
        }
    }

    fn test_root(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "alethe-profiles-{label}-{}-{}-{}",
            std::process::id(),
            now_ms(),
            nanoid::nanoid!(6)
        ))
    }

    #[test]
    fn path_core_applies_the_same_profile_rules_as_tauri_commands() {
        let root = test_root("crud");
        let initial = list_profiles_state_at(&root).unwrap();
        assert_eq!(initial.active_profile_id, "default");

        let created = create_profile_state_at(&root, Some("Web".to_string())).unwrap();
        let web = created
            .profiles
            .iter()
            .find(|profile| profile.name == "Web")
            .unwrap();
        let web_id = web.id.clone();
        assert!(profile_data_dir_for_id_at(&root, &web_id).unwrap().is_dir());
        assert_eq!(
            create_profile_state_at(&root, Some("web".to_string())).unwrap_err(),
            "profile_name_exists"
        );

        let active = set_active_profile_id_at(&root, &web_id).unwrap();
        assert_eq!(active.active_profile_id, web_id);
        rename_profile_state_at(&root, &web_id, "Browser".to_string()).unwrap();
        delete_profile_state_at(&root, &web_id).unwrap();
        assert_eq!(list_profiles_state_at(&root).unwrap().profiles.len(), 1);
        assert!(delete_profile_state_at(&root, "default").is_err());

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn prepared_data_root_has_a_stable_fingerprint_on_first_use() {
        let root = test_root("identity");
        let before = prepare_data_root(root.clone()).unwrap();
        let first = data_root_fingerprint(&before);
        let second = data_root_fingerprint(&prepare_data_root(root.clone()).unwrap());

        assert!(root.is_dir());
        assert_eq!(first, second);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn legacy_migration_keeps_a_recovery_copy_before_cleanup() {
        let root = test_root("legacy-backup");
        let default_dir = root.join(PROFILES_DIR_NAME).join(DEFAULT_PROFILE_ID);
        fs::create_dir_all(&default_dir).unwrap();
        fs::write(root.join("projects.json"), r#"{"source":"legacy"}"#).unwrap();
        fs::write(
            default_dir.join("projects.json"),
            r#"{"source":"existing-profile"}"#,
        )
        .unwrap();

        let state = list_profiles_state_at(&root).unwrap();
        assert_eq!(state.active_profile_id, DEFAULT_PROFILE_ID);
        // The profile already owned different data under this name: a real
        // conflict, so both copies survive instead of the root original
        // being deleted — nothing is lost, and the conflict stays visible
        // on disk instead of only living inside `.migration-backups/`.
        assert_eq!(
            fs::read_to_string(root.join("projects.json")).unwrap(),
            r#"{"source":"legacy"}"#
        );
        assert_eq!(
            fs::read_to_string(default_dir.join("projects.json")).unwrap(),
            r#"{"source":"existing-profile"}"#
        );

        let backup_root = root.join(MIGRATION_BACKUPS_DIR);
        let backup_dir = fs::read_dir(&backup_root)
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        assert_eq!(
            fs::read_to_string(backup_dir.join("projects.json")).unwrap(),
            r#"{"source":"legacy"}"#
        );

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn legacy_migration_runs_even_when_the_registry_already_exists() {
        let root = test_root("legacy-with-existing-registry");
        // Simulate an older Web backend that already wrote a default/empty
        // registry, while the pre-multi-profile `root/projects.json` from a
        // real install was still sitting there, never migrated.
        ensure_profiles_index_at(&root).unwrap();
        assert!(registry_path(&root).exists());
        fs::write(
            root.join("projects.json"),
            r#"{"source":"legacy-after-registry"}"#,
        )
        .unwrap();

        let state = list_profiles_state_at(&root).unwrap();
        assert_eq!(state.active_profile_id, DEFAULT_PROFILE_ID);

        let default_dir = root.join(PROFILES_DIR_NAME).join(DEFAULT_PROFILE_ID);
        assert_eq!(
            fs::read_to_string(default_dir.join("projects.json")).unwrap(),
            r#"{"source":"legacy-after-registry"}"#
        );
        // No conflict here (the profile had no projects.json of its own
        // yet), so the merged root copy is cleaned up after the backup.
        assert!(!root.join("projects.json").exists());

        let backup_root = root.join(MIGRATION_BACKUPS_DIR);
        let backup_dir = fs::read_dir(&backup_root)
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        assert_eq!(
            fs::read_to_string(backup_dir.join("projects.json")).unwrap(),
            r#"{"source":"legacy-after-registry"}"#
        );

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn corrupt_registry_is_reported_without_being_replaced() {
        let root = test_root("corrupt");
        fs::create_dir_all(&root).unwrap();
        let registry = root.join(PROFILES_REGISTRY_FILE);
        fs::write(&registry, "{not-json").unwrap();

        assert!(list_profiles_state_at(&root).is_err());
        assert_eq!(fs::read_to_string(&registry).unwrap(), "{not-json");

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn invalid_active_profile_is_not_silently_reassigned() {
        let raw = serde_json::json!({
            "version": 1,
            "active_profile_id": "missing",
            "profiles": [{
                "id": "default",
                "name": "Default",
                "created_at_ms": 1,
                "last_used_at_ms": 1
            }]
        })
        .to_string();

        assert!(parse_profiles_index(&raw)
            .unwrap_err()
            .contains("active profile not found"));
    }

    #[test]
    fn standalone_data_root_override_has_precedence_and_requires_an_absolute_path() {
        let _lock = ENV_MUTEX.lock().unwrap();
        let _snapshot =
            EnvironmentSnapshot::capture(&["ALETHE_APP_DATA_DIR", "ALETHE_APP_IDENTIFIER"]);
        let root = test_root("explicit-root");

        std::env::set_var("ALETHE_APP_DATA_DIR", &root);
        std::env::set_var("ALETHE_APP_IDENTIFIER", "../invalid-identifier");
        assert_eq!(resolve_standalone_data_root().unwrap(), root);

        std::env::set_var("ALETHE_APP_DATA_DIR", PathBuf::from("relative-data-root"));
        assert_eq!(
            resolve_standalone_data_root().unwrap_err(),
            "ALETHE_APP_DATA_DIR must be an absolute path"
        );

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn standalone_identifier_rejects_path_components_and_tracks_build_mode() {
        let _lock = ENV_MUTEX.lock().unwrap();
        let _snapshot = EnvironmentSnapshot::capture(&["ALETHE_APP_IDENTIFIER"]);

        std::env::set_var("ALETHE_APP_IDENTIFIER", "../other-app");
        assert_eq!(
            resolve_standalone_identifier().unwrap_err(),
            "ALETHE_APP_IDENTIFIER must be a single safe path component"
        );

        std::env::remove_var("ALETHE_APP_IDENTIFIER");
        let expected = if cfg!(debug_assertions) {
            "com.kc1t.alethe.dev"
        } else {
            "com.kc1t.alethe"
        };
        assert_eq!(resolve_standalone_identifier().unwrap(), expected);
    }
}
