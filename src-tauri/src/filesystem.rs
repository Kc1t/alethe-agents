use notify::{Config, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

const TODO_TEMPLATE_FILE: &str = "alethe-todo.template.jsonc";
const TODO_TEMPLATE: &str = r#"// Alethe Todo template
// Copy this file to `todos.jsonc` when you want to iterate on an external Todo file.
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

/// Lê um arquivo de texto (UTF-8) do disco. Usado pelo Markdown Viewer.
#[tauri::command]
pub fn read_text_file(path: String) -> Result<String, String> {
    let file = PathBuf::from(path.trim());
    if !file.is_file() {
        return Err("file not found".to_string());
    }
    fs::read_to_string(&file).map_err(|error| error.to_string())
}

/// Escreve texto UTF-8 em um arquivo existente. Usado pelo editor Markdown.
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
    let marker = PathBuf::from(project_dir.trim()).join(".alethe").join("project.json");
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

/// Registro global de watchers de arquivo, chaveado pelo caminho absoluto.
/// Cada `RecommendedWatcher` precisa ficar vivo enquanto o pane estiver aberto.
#[derive(Default)]
pub struct FileWatchers(pub Arc<Mutex<HashMap<String, (RecommendedWatcher, usize)>>>);

/// Normaliza o caminho pra usar como chave/comparação (mesma forma que vem do front).
fn normalize(path: &str) -> String {
    path.trim().to_string()
}

/// Observa um arquivo .md e emite `md://changed { path }` quando ele muda no disco.
/// Observa o diretório-pai (não-recursivo) e filtra pelo arquivo — robusto contra
/// saves atômicos (editor regrava o arquivo) que quebram um watch direto.
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
    // Refcount: se outro pane já observa este caminho, só incrementa a contagem.
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

/// Para de observar um arquivo (chamado quando o pane é fechado/desmontado).
#[tauri::command]
pub fn unwatch_file(state: tauri::State<'_, FileWatchers>, path: String) -> Result<(), String> {
    let key = normalize(&path);
    let mut map = state.0.lock().map_err(|e| e.to_string())?;
    // Refcount: só solta o watcher quando o ÚLTIMO pane deste caminho fecha —
    // senão um pane sobrevivente pararia de receber md://changed em silêncio.
    if let Some(entry) = map.get_mut(&key) {
        if entry.1 <= 1 {
            map.remove(&key); // drop do watcher para o watch
        } else {
            entry.1 -= 1;
        }
    }
    Ok(())
}
