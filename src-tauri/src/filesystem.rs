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
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size_bytes: Option<u64>,
}

#[derive(Serialize)]
pub struct DirectoryListing {
    pub current_path: String,
    pub parent_path: Option<String>,
    pub home_path: String,
    pub system_roots: Vec<String>,
    pub entries: Vec<DirectoryEntry>,
}

fn get_home_dir() -> PathBuf {
    if let Ok(v) = std::env::var("USERPROFILE") {
        PathBuf::from(v)
    } else if let Ok(v) = std::env::var("HOME") {
        PathBuf::from(v)
    } else {
        PathBuf::from(".")
    }
}

fn get_system_roots() -> Vec<String> {
    let mut roots = Vec::new();
    #[cfg(target_os = "windows")]
    {
        for letter in b'A'..=b'Z' {
            let drive = format!("{}:\\", letter as char);
            if Path::new(&drive).exists() {
                roots.push(drive);
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        roots.push("/".to_string());
        if Path::new("/home").exists() {
            roots.push("/home".to_string());
        }
        if Path::new("/media").exists() {
            roots.push("/media".to_string());
        }
        if Path::new("/mnt").exists() {
            roots.push("/mnt".to_string());
        }
        if Path::new("/Volumes").exists() {
            roots.push("/Volumes".to_string());
        }
    }
    roots
}

#[tauri::command]
pub fn list_directory(path: String) -> Result<DirectoryListing, String> {
    let home = get_home_dir();
    let trimmed = path.trim();
    let directory = if trimmed.is_empty() || trimmed == "~" {
        home.clone()
    } else {
        let p = PathBuf::from(trimmed);
        if p.exists() {
            if p.is_file() {
                p.parent()
                    .map(|parent| parent.to_path_buf())
                    .unwrap_or(home.clone())
            } else {
                p
            }
        } else {
            home.clone()
        }
    };

    let canonical = directory
        .canonicalize()
        .unwrap_or_else(|_| directory.clone());
    let current_path_str = canonical.to_string_lossy().into_owned();
    let clean_current_path = current_path_str
        .strip_prefix(r"\\?\")
        .unwrap_or(&current_path_str)
        .to_string();

    let parent_path = canonical.parent().map(|p| {
        let s = p.to_string_lossy().into_owned();
        s.strip_prefix(r"\\?\").unwrap_or(&s).to_string()
    });

    let mut entries = match fs::read_dir(&canonical) {
        Ok(read_dir) => read_dir
            .filter_map(|entry| {
                let entry = entry.ok()?;
                let file_type = entry.file_type().ok()?;
                let metadata = entry.metadata().ok();
                let name = entry.file_name().to_string_lossy().into_owned();
                if name.starts_with('$') || name == "System Volume Information" {
                    return None;
                }
                let full_path = entry.path().to_string_lossy().into_owned();
                let clean_path = full_path
                    .strip_prefix(r"\\?\")
                    .unwrap_or(&full_path)
                    .to_string();
                Some(DirectoryEntry {
                    name,
                    path: clean_path,
                    is_dir: file_type.is_dir(),
                    size_bytes: metadata.map(|m| m.len()),
                })
            })
            .collect::<Vec<_>>(),
        Err(_) => Vec::new(),
    };

    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    let clean_home = home.to_string_lossy().into_owned();
    let home_path = clean_home
        .strip_prefix(r"\\?\")
        .unwrap_or(&clean_home)
        .to_string();

    Ok(DirectoryListing {
        current_path: clean_current_path,
        parent_path,
        home_path,
        system_roots: get_system_roots(),
        entries,
    })
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

/// Reads a file as raw bytes — used for turning a natively-dragged file path
/// (Tauri's `onDragDropEvent`, which only ever gives paths, never `File`
/// objects/bytes like the browser's own drag API) into an attachment the
/// same way a picked/pasted file already is. Capped at the same ceiling
/// `sync_chat::MAX_ATTACHMENT_BYTES` enforces server-side, so a huge file
/// dropped by mistake fails fast here instead of loading it fully into
/// memory just to have the upload reject it a moment later.
#[tauri::command]
pub fn read_binary_file(path: String) -> Result<Vec<u8>, String> {
    let file = PathBuf::from(path.trim());
    if !file.is_file() {
        return Err("file not found".to_string());
    }
    let metadata = fs::metadata(&file).map_err(|error| error.to_string())?;
    if metadata.len() as usize > crate::sync_chat::MAX_ATTACHMENT_BYTES {
        return Err("file too large".to_string());
    }
    fs::read(&file).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn write_text_file(path: String, content: String) -> Result<(), String> {
    let file = PathBuf::from(path.trim());
    if !file.is_file() {
        return Err("file not found".to_string());
    }
    fs::write(&file, content).map_err(|error| error.to_string())
}

/// Escreve o espelho `.alethe/project.json` dentro da própria pasta do
/// projeto (não no app data) — cria `.alethe/` se ainda não existir. Ao
/// contrário de `write_text_file`, este comando pode criar o arquivo do zero
/// (não exige que já exista), porque o objetivo é justamente inicializar o
/// espelho na primeira vez que o projeto é salvo.
#[tauri::command]
pub fn write_project_marker(project_dir: String, content: String) -> Result<(), String> {
    let dir = PathBuf::from(project_dir.trim());
    if !dir.is_dir() {
        return Err("directory not found".to_string());
    }
    let marker_dir = dir.join(".alethe");
    fs::create_dir_all(&marker_dir).map_err(|error| error.to_string())?;
    fs::write(marker_dir.join("project.json"), content).map_err(|error| error.to_string())
}

/// Lê `.alethe/project.json` de uma pasta, se existir — usado pela detecção
/// de "configuração já existente" ao criar um projeto novo apontando pra essa
/// pasta. `None` (não erro) quando o marcador simplesmente não existe ainda,
/// que é o caso normal pra qualquer pasta nova/nunca usada pelo Alethe.
#[tauri::command]
pub fn read_project_marker(project_dir: String) -> Option<String> {
    let marker = PathBuf::from(project_dir.trim())
        .join(".alethe")
        .join("project.json");
    fs::read_to_string(marker).ok()
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
