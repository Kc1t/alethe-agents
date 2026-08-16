use notify::{Config, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

const TODO_TEMPLATE_FILE: &str = "alethe-todo.template.jsonc";
const TODO_TEMPLATE: &str = r#"// Alethe Todo template
                                                                                     
// For now, the app stores Todo items in its local profile; this template documents
// the structure expected by the importer/sync layer.
{
  // Schema version for future migrations.
  "version": 1,

  // Global personal task list. Order in this array is the visible order.
  "todos": [
    {
      // Stable id. Any unique string is accepted.
      "id": "task-example-1",

      // Text shown in the Todo sidebar.
      "title": "Example task",

      // false = Active, true = Completed.
      "completed": false
    }
  ]
}
"#;

#[derive(Serialize)]
pub struct DirectoryEntry {
    name: String,
    path: String,
    is_dir: bool,
    size: Option<u64>,
}

#[tauri::command]
pub fn list_directory(path: String) -> Result<Vec<DirectoryEntry>, String> {
    let directory = PathBuf::from(path.trim());
    if !directory.is_dir() {
        return Err("directory not found".to_string());
    }

    let mut entries = fs::read_dir(&directory)
        .map_err(|error| error.to_string())?
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let file_type = entry.file_type().ok()?;
            Some(DirectoryEntry {
                name: entry.file_name().to_string_lossy().into_owned(),
                path: entry.path().to_string_lossy().into_owned(),
                is_dir: file_type.is_dir(),
                size: entry
                    .metadata()
                    .ok()
                    .filter(|_| file_type.is_file())
                    .map(|value| value.len()),
            })
        })
        .collect::<Vec<_>>();

    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

fn existing_entry(path: &str) -> Result<PathBuf, String> {
    let target = PathBuf::from(path.trim());
    if target.as_os_str().is_empty() || !target.exists() {
        return Err("entry not found".to_string());
    }
    if target.parent().is_none() {
        return Err("filesystem roots cannot be modified".to_string());
    }
    Ok(target)
}

#[tauri::command]
pub fn rename_filesystem_entry(path: String, new_name: String) -> Result<String, String> {
    let target = existing_entry(&path)?;
    let trimmed_name = new_name.trim();
    let name_path = Path::new(trimmed_name);
    if trimmed_name.is_empty()
        || name_path.components().count() != 1
        || matches!(trimmed_name, "." | "..")
    {
        return Err("invalid entry name".to_string());
    }
    let parent = target
        .parent()
        .ok_or_else(|| "filesystem roots cannot be renamed".to_string())?;
    let destination = parent.join(name_path);
    if destination.exists() {
        return Err("an entry with this name already exists".to_string());
    }
    fs::rename(&target, &destination).map_err(|error| error.to_string())?;
    Ok(destination.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn delete_filesystem_entry(path: String) -> Result<(), String> {
    let target = existing_entry(&path)?;
    let metadata = fs::symlink_metadata(&target).map_err(|error| error.to_string())?;
    if metadata.file_type().is_symlink() || metadata.is_file() {
        fs::remove_file(&target).map_err(|error| error.to_string())
    } else if metadata.is_dir() {
        fs::remove_dir_all(&target).map_err(|error| error.to_string())
    } else {
        Err("unsupported filesystem entry".to_string())
    }
}

#[tauri::command]
pub fn read_text_file(path: String) -> Result<String, String> {
    let file = PathBuf::from(path.trim());
    if !file.is_file() {
        return Err("file not found".to_string());
    }
    fs::read_to_string(&file).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn write_text_file(path: String, content: String) -> Result<(), String> {
    let file = PathBuf::from(path.trim());
    if !file.is_file() {
        return Err("file not found".to_string());
    }
    fs::write(&file, content).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn ensure_todo_template(directory: String) -> Result<String, String> {
    let dir = PathBuf::from(directory.trim());
    if dir.as_os_str().is_empty() {
        return Err("empty directory".to_string());
    }
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    if !dir.is_dir() {
        return Err("directory not found".to_string());
    }
    let template_path = dir.join(TODO_TEMPLATE_FILE);
    if !template_path.exists() {
        fs::write(&template_path, TODO_TEMPLATE).map_err(|error| error.to_string())?;
    }
    Ok(template_path.to_string_lossy().into_owned())
}

#[derive(Default)]
pub struct FileWatchers(pub Arc<Mutex<HashMap<String, (RecommendedWatcher, usize)>>>);

fn normalize(path: &str) -> String {
    path.trim().to_string()
}

#[tauri::command]
pub fn watch_file(
    app: AppHandle,
    state: tauri::State<'_, FileWatchers>,
    path: String,
) -> Result<(), String> {
    let key = normalize(&path);
    let target = PathBuf::from(&key);
    let parent = target
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "invalid path".to_string())?;

    let mut map = state.0.lock().map_err(|e| e.to_string())?;

    if let Some(entry) = map.get_mut(&key) {
        entry.1 += 1;
        return Ok(());
    }

    let emit_path = key.clone();
    let watched = target.clone();
    let mut watcher = RecommendedWatcher::new(
        move |res: notify::Result<notify::Event>| {
            let Ok(event) = res else { return };
            if !matches!(event.kind, EventKind::Modify(_) | EventKind::Create(_)) {
                return;
            }
            if event.paths.iter().any(|p| p == &watched) {
                let _ = app.emit("md://changed", serde_json::json!({ "path": emit_path }));
            }
        },
        Config::default(),
    )
    .map_err(|e| e.to_string())?;

    watcher
        .watch(&parent, RecursiveMode::NonRecursive)
        .map_err(|e| e.to_string())?;
    map.insert(key, (watcher, 1));
    Ok(())
}

#[tauri::command]
pub fn unwatch_file(state: tauri::State<'_, FileWatchers>, path: String) -> Result<(), String> {
    let key = normalize(&path);
    let mut map = state.0.lock().map_err(|e| e.to_string())?;

    if let Some(entry) = map.get_mut(&key) {
        if entry.1 <= 1 {
            map.remove(&key); // drop do watcher para o watch
        } else {
            entry.1 -= 1;
        }
    }
    Ok(())
}
