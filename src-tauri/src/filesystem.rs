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
pub async fn list_directory(path: String) -> Result<Vec<DirectoryEntry>, String> {
    tokio::task::spawn_blocking(move || list_directory_inner(path))
        .await
        .map_err(|error| format!("list_directory: blocking task failed: {error}"))?
}

fn list_directory_inner(path: String) -> Result<Vec<DirectoryEntry>, String> {
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowseDirectoryEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size_bytes: Option<u64>,
}

/// In-app folder/file browser used by `FsBrowserModal` as an alternative to
/// the native OS picker — separate from `list_directory`/`DirectoryEntry`
/// (used by the sidebar file explorer) since this returns navigation context
/// (parent/home/drive roots) that explorer callers don't need or expect.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryListing {
    pub current_path: String,
    pub parent_path: Option<String>,
    pub home_path: String,
    pub system_roots: Vec<String>,
    pub entries: Vec<BrowseDirectoryEntry>,
}

/// The home folder, so the terminal can resolve the `~` in paths it prints. `None` rather than a
/// guess when the platform reports none.
#[tauri::command]
pub fn home_directory() -> Option<String> {
    dirs_next::home_dir().map(|home| home.to_string_lossy().into_owned())
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
        for distro in crate::wsl::installed_distros() {
            roots.push(crate::wsl::distro_root_unc(&distro));
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

pub fn strip_extended_prefix(path: &str) -> String {
    path.strip_prefix(r"\\?\UNC\")
        .map(|rest| format!(r"\\{rest}"))
        .or_else(|| path.strip_prefix(r"\\?\").map(str::to_string))
        .unwrap_or_else(|| path.to_string())
}

#[tauri::command]
pub async fn browse_directory(path: String) -> Result<DirectoryListing, String> {
    tokio::task::spawn_blocking(move || browse_directory_inner(path))
        .await
        .map_err(|error| format!("browse_directory: blocking task failed: {error}"))?
}

fn browse_directory_inner(path: String) -> Result<DirectoryListing, String> {
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
    let clean_current_path = strip_extended_prefix(&current_path_str);

    let parent_path = canonical
        .parent()
        .map(|p| strip_extended_prefix(&p.to_string_lossy()));

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
                let clean_path = strip_extended_prefix(&entry.path().to_string_lossy());
                Some(BrowseDirectoryEntry {
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

    let home_path = strip_extended_prefix(&home.to_string_lossy());

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

#[tauri::command]
pub fn write_text_file(path: String, content: String) -> Result<(), String> {
    let file = PathBuf::from(path.trim());
    if !file.is_file() {
        return Err("file not found".to_string());
    }
    fs::write(&file, content).map_err(|error| error.to_string())
}

/// Writes the `.alethe/project.json` mirror inside the project's own folder
/// (not app data) — creates `.alethe/` if it doesn't exist yet. Unlike
/// `write_text_file`, this command can create the file from scratch (doesn't
/// require it to already exist), because the whole point is to initialize
/// the mirror the first time the project is saved.
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

/// Reads a folder's `.alethe/project.json`, if it exists — used to detect an
/// "already-configured project" when pointing a new project at that folder.
/// `None` (not an error) when the marker simply doesn't exist yet, which is
/// the normal case for any folder new to / never used by Alethe.
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

/// Where a relative path printed in a terminal really is. Agents often write
/// in another git worktree of the project while the pane stays in the main
/// checkout, so when the path is not under `cwd` it is looked up under every
/// worktree root, and under the worktree whose folder is the path's first
/// segment (`repo-feature/docs/x.md`). The most recently modified match wins.
#[tauri::command]
pub async fn find_relative_path(cwd: String, path: String) -> Option<String> {
    tokio::task::spawn_blocking(move || {
        find_relative_path_inner(Path::new(cwd.trim()), path.trim())
    })
    .await
    .ok()
    .flatten()
    .map(|found| found.to_string_lossy().into_owned())
}

fn find_relative_path_inner(cwd: &Path, relative: &str) -> Option<PathBuf> {
    let relative = Path::new(relative);
    if relative.as_os_str().is_empty() || relative.has_root() {
        return None;
    }
    // Collecting the components turns git's `C:/...` into native separators.
    let direct: PathBuf = cwd.join(relative).components().collect();
    if direct.exists() {
        return Some(direct);
    }

    let output = crate::git_control::git_command(cwd, &["worktree", "list", "--porcelain"]).ok()?;
    if !output.status.success() {
        return None;
    }
    let mut components = relative.components();
    let first = components.next()?.as_os_str().to_owned();
    let rest = components.as_path();
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| line.strip_prefix("worktree "))
        .map(PathBuf::from)
        .flat_map(|root| {
            let named = (root.file_name() == Some(first.as_os_str())).then(|| root.join(rest));
            [Some(root.join(relative)), named]
        })
        .flatten()
        .filter_map(|candidate| {
            let modified = fs::metadata(&candidate).ok()?.modified().ok()?;
            Some((modified, candidate.components().collect::<PathBuf>()))
        })
        .max_by_key(|(modified, _)| *modified)
        .map(|(_, candidate)| candidate)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git_control::checked_output;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn finds_a_relative_path_in_a_sibling_worktree() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let parent = std::env::temp_dir().join(format!("alethe-relative-path-{suffix}"));
        let main = parent.join("repo");
        fs::create_dir_all(&main).unwrap();
        checked_output(&main, &["init", "-b", "main"]).unwrap();
        checked_output(&main, &["config", "user.name", "Alethe Test"]).unwrap();
        checked_output(&main, &["config", "user.email", "alethe@example.invalid"]).unwrap();
        fs::write(main.join("a.txt"), "a\n").unwrap();
        checked_output(&main, &["add", "-A"]).unwrap();
        checked_output(&main, &["commit", "-m", "base"]).unwrap();
        // Two sibling worktrees holding the same report, so the newest one has to be picked.
        let add_report = |name: &str| {
            let worktree = parent.join(name);
            checked_output(
                &main,
                &[
                    "worktree",
                    "add",
                    "-b",
                    name,
                    worktree.to_str().unwrap(),
                    "HEAD",
                ],
            )
            .unwrap();
            fs::create_dir_all(worktree.join("docs")).unwrap();
            let report = worktree.join("docs").join("report.md");
            fs::write(&report, name).unwrap();
            report
        };
        let feature = add_report("repo-feature");
        let other = add_report("repo-other");
        let touch = |path: &Path, hours_ago: u64| {
            let at = SystemTime::now() - std::time::Duration::from_secs(hours_ago * 3600);
            let file = fs::File::options().write(true).open(path).unwrap();
            file.set_modified(at).unwrap();
        };

        // The temp folder has aliases git does not print (`/var` is `/private/var` on macOS, and
        // Windows may hand out an 8.3 short name), so a match is compared by the file it names.
        let found = |path: &str| {
            find_relative_path_inner(&main, path).map(|found| fs::canonicalize(found).unwrap())
        };
        let resolved = |path: &Path| Some(fs::canonicalize(path).unwrap());

        assert_eq!(found("a.txt"), resolved(&main.join("a.txt")));
        assert_eq!(found("repo-feature/docs/report.md"), resolved(&feature));
        assert_eq!(found("docs/missing.md"), None);
        touch(&other, 2);
        assert_eq!(found("docs/report.md"), resolved(&feature));
        touch(&feature, 3);
        assert_eq!(found("docs/report.md"), resolved(&other));

        for name in ["repo-feature", "repo-other"] {
            let worktree = parent.join(name);
            let _ = checked_output(
                &main,
                &["worktree", "remove", "--force", worktree.to_str().unwrap()],
            );
        }
        let _ = fs::remove_dir_all(&parent);
    }

    #[test]
    fn strips_the_extended_length_prefix_from_a_drive_path() {
        assert_eq!(
            strip_extended_prefix(r"\\?\C:\projects\app"),
            r"C:\projects\app"
        );
    }

    #[test]
    fn maps_an_extended_unc_path_back_to_its_double_backslash_form() {
        assert_eq!(
            strip_extended_prefix(r"\\?\UNC\wsl.localhost\Ubuntu\home\dev"),
            r"\\wsl.localhost\Ubuntu\home\dev"
        );
    }

    #[test]
    fn a_cleaned_wsl_path_is_still_parsed_as_a_wsl_path() {
        let cleaned = strip_extended_prefix(r"\\?\UNC\wsl.localhost\Ubuntu\home\dev");
        assert_eq!(
            crate::wsl::parse_wsl_unc(&cleaned).map(|target| target.distro),
            Some("Ubuntu".to_string())
        );
    }

    #[test]
    fn leaves_an_ordinary_path_untouched() {
        assert_eq!(
            strip_extended_prefix(r"C:\projects\app"),
            r"C:\projects\app"
        );
        assert_eq!(
            strip_extended_prefix(r"\\wsl.localhost\Ubuntu"),
            r"\\wsl.localhost\Ubuntu"
        );
    }
}
