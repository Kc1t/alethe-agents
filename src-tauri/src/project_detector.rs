use serde::Serialize;
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ProjectStack {
    Web,
    Cli,
    Desktop,
    Fullstack,
    Unknown,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StackDetection {
    pub stack: ProjectStack,
    pub has_frontend: bool,
    pub has_backend: bool,
    pub has_tauri: bool,
    pub suggested_commands: Vec<String>,
}

fn has_file(root: &Path, name: &str) -> bool {
    root.join(name).is_file()
}

fn has_tauri_conf(root: &Path) -> bool {
    has_file(root, "tauri.conf.json") || root.join("src-tauri").join("tauri.conf.json").is_file()
}

fn package_json_has_frontend_signal(root: &Path) -> bool {
    let Ok(content) = std::fs::read_to_string(root.join("package.json")) else {
        return false;
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&content) else {
        return false;
    };
    let has_script = value
        .get("scripts")
        .and_then(|s| s.as_object())
        .map(|scripts| {
            scripts.contains_key("dev")
                || scripts.contains_key("build")
                || scripts.contains_key("start")
        })
        .unwrap_or(false);
    const FRONTEND_DEPS: &[&str] = &["react", "vue", "svelte", "next", "vite", "@angular/core"];
    let has_frontend_dep = FRONTEND_DEPS.iter().any(|dep| {
        value
            .get("dependencies")
            .and_then(|deps| deps.get(dep))
            .is_some()
            || value
                .get("devDependencies")
                .and_then(|deps| deps.get(dep))
                .is_some()
    });
    has_script || has_frontend_dep
}

fn has_rust_backend_bin(root: &Path) -> bool {
    has_file(root, "Cargo.toml") && !has_tauri_conf(root)
}

fn has_backend_marker(root: &Path) -> bool {
    has_file(root, "requirements.txt")
        || has_file(root, "pyproject.toml")
        || has_file(root, "go.mod")
        || has_rust_backend_bin(root)
}

#[tauri::command]
pub fn detect_project_stack(repo: String) -> Result<StackDetection, String> {
    let root = Path::new(&repo);
    if !root.is_dir() {
        return Err("repo_not_found".to_string());
    }

    let has_tauri = has_tauri_conf(root);
    let has_frontend = has_file(root, "package.json") && package_json_has_frontend_signal(root);
    let has_backend = has_backend_marker(root);

    let stack = if has_tauri {
        ProjectStack::Desktop
    } else if has_frontend && has_backend {
        ProjectStack::Fullstack
    } else if has_frontend {
        ProjectStack::Web
    } else if has_backend {
        ProjectStack::Cli
    } else {
        ProjectStack::Unknown
    };

    let mut suggested_commands = Vec::new();
    match stack {
        ProjectStack::Desktop => {
            suggested_commands.push("npm run build".to_string());
            suggested_commands.push("cargo check --manifest-path src-tauri/Cargo.toml".to_string());
        }
        ProjectStack::Web => {
            suggested_commands.push("npm run build".to_string());
        }
        ProjectStack::Fullstack => {
            suggested_commands.push("npm run build".to_string());
            if has_file(root, "requirements.txt") || has_file(root, "pyproject.toml") {
                suggested_commands.push("python -m py_compile .".to_string());
            }
            if has_file(root, "Cargo.toml") {
                suggested_commands.push("cargo check".to_string());
            }
            if has_file(root, "go.mod") {
                suggested_commands.push("go build ./...".to_string());
            }
        }
        ProjectStack::Cli => {
            if has_file(root, "Cargo.toml") {
                suggested_commands.push("cargo check".to_string());
            }
            if has_file(root, "go.mod") {
                suggested_commands.push("go build ./...".to_string());
            }
            if has_file(root, "requirements.txt") || has_file(root, "pyproject.toml") {
                suggested_commands.push("python -m py_compile .".to_string());
            }
        }
        ProjectStack::Unknown => {}
    }

    Ok(StackDetection {
        stack,
        has_frontend,
        has_backend,
        has_tauri,
        suggested_commands,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_repo(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("alethe-detect-{name}-{}", nanoid::nanoid!(6)));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn detects_tauri_desktop_by_conf_presence() {
        let root = temp_repo("desktop");
        fs::create_dir_all(root.join("src-tauri")).unwrap();
        fs::write(root.join("src-tauri").join("tauri.conf.json"), "{}").unwrap();
        fs::write(root.join("package.json"), r#"{"scripts":{"dev":"vite"}}"#).unwrap();
        let detection = detect_project_stack(root.to_string_lossy().into_owned()).unwrap();
        assert_eq!(detection.stack, ProjectStack::Desktop);
        assert!(detection.has_tauri);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn detects_plain_node_web_project() {
        let root = temp_repo("web");
        fs::write(
            root.join("package.json"),
            r#"{"scripts":{"dev":"vite","build":"vite build"},"dependencies":{"react":"18.0.0"}}"#,
        )
        .unwrap();
        let detection = detect_project_stack(root.to_string_lossy().into_owned()).unwrap();
        assert_eq!(detection.stack, ProjectStack::Web);
        assert!(detection.has_frontend);
        assert!(!detection.has_backend);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn detects_python_backend_as_cli() {
        let root = temp_repo("python");
        fs::write(root.join("requirements.txt"), "fastapi\n").unwrap();
        let detection = detect_project_stack(root.to_string_lossy().into_owned()).unwrap();
        assert_eq!(detection.stack, ProjectStack::Cli);
        assert!(detection.has_backend);
        assert!(!detection.has_frontend);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn detects_fullstack_when_both_present() {
        let root = temp_repo("fullstack");
        fs::write(
            root.join("package.json"),
            r#"{"scripts":{"dev":"vite"},"dependencies":{"react":"18.0.0"}}"#,
        )
        .unwrap();
        fs::write(root.join("pyproject.toml"), "[project]\nname = \"x\"\n").unwrap();
        let detection = detect_project_stack(root.to_string_lossy().into_owned()).unwrap();
        assert_eq!(detection.stack, ProjectStack::Fullstack);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn unknown_when_nothing_recognized() {
        let root = temp_repo("unknown");
        fs::write(root.join("README.md"), "hello\n").unwrap();
        let detection = detect_project_stack(root.to_string_lossy().into_owned()).unwrap();
        assert_eq!(detection.stack, ProjectStack::Unknown);
        assert!(detection.suggested_commands.is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn missing_repo_errors() {
        assert!(detect_project_stack("D:/definitely-not-a-real-path-xyz".to_string()).is_err());
    }
}
