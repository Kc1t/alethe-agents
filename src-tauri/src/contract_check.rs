//! Bloco 2.2 do plano da Central de Merges — Verificador de Contrato de API.
//!

//! frontend e rotas de Express/FastAPI/Axum do backend via regex simples

use regex::Regex;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiCallSite {
    pub file: String,
    pub line: usize,
    pub method: Option<String>,
    pub path_pattern: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiRouteSite {
    pub file: String,
    pub line: usize,
    pub method: Option<String>,
    pub path_pattern: String,
    pub framework: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContractWarning {
    pub call: ApiCallSite,
    pub reason: String,
}

const SKIP_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    "target",
    "dist",
    "build",
    ".next",
    ".venv",
    "venv",
    "__pycache__",
    ".alethe",
    "graphify-out",
];

fn walk_files(root: &Path, exts: &[&str], out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if SKIP_DIRS.contains(&name) {
                continue;
            }
            walk_files(&path, exts, out);
        } else if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
            if exts.contains(&ext) {
                out.push(path);
            }
        }
    }
}

fn relative_display(root: &Path, file: &Path) -> String {
    file.strip_prefix(root)
        .unwrap_or(file)
        .to_string_lossy()
        .replace('\\', "/")
}

fn normalize_path_pattern(raw: &str) -> String {
    static PARAM_RE: OnceLock<Regex> = OnceLock::new();
    let re = PARAM_RE.get_or_init(|| {
        Regex::new(r"(:[A-Za-z0-9_]+|\{[A-Za-z0-9_:]+\}|<[A-Za-z0-9_:]+>)").unwrap()
    });
    let normalized = re.replace_all(raw, ":param");
    let trimmed = normalized.trim_end_matches('/');
    if trimmed.is_empty() {
        "/".to_string()
    } else {
        trimmed.to_string()
    }
}

/// nunca seriam sinalizados, justamente o caso de versionamento divergente

/// diverge corretamente.
fn segment_prefix(path: &str, n: usize) -> Vec<&str> {
    path.trim_start_matches('/').split('/').take(n).collect()
}

fn paths_related(call: &str, route: &str) -> bool {
    if call.is_empty() || route.is_empty() {
        return false;
    }
    if call == route || call.starts_with(route) || route.starts_with(call) {
        return true;
    }
    let call_prefix = segment_prefix(call, 2);
    let route_prefix = segment_prefix(route, 2);
    !call_prefix.is_empty() && call_prefix == route_prefix
}

struct CallPattern {
    regex: Regex,

    method_group: Option<usize>,
    path_group: usize,
}

fn frontend_patterns() -> &'static [CallPattern] {
    static PATTERNS: OnceLock<Vec<CallPattern>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        vec![
            CallPattern {
                regex: Regex::new(r#"fetch\(\s*['"`]([^'"`]+)"#).unwrap(),
                method_group: None,
                path_group: 1,
            },
            CallPattern {
                regex: Regex::new(r#"axios\.(get|post|put|delete|patch)\(\s*['"`]([^'"`]+)"#)
                    .unwrap(),
                method_group: Some(1),
                path_group: 2,
            },
        ]
    })
}

fn backend_patterns() -> &'static [(CallPattern, &'static str)] {
    static PATTERNS: OnceLock<Vec<(CallPattern, &'static str)>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        vec![
            (
                CallPattern {
                    regex: Regex::new(
                        r#"(?:app|router)\.(get|post|put|delete|patch)\(\s*['"`]([^'"`]+)"#,
                    )
                    .unwrap(),
                    method_group: Some(1),
                    path_group: 2,
                },
                "express",
            ),
            (
                CallPattern {
                    regex: Regex::new(
                        r#"@(?:app|router)\.(get|post|put|delete|patch)\(\s*['"`]([^'"`]+)"#,
                    )
                    .unwrap(),
                    method_group: Some(1),
                    path_group: 2,
                },
                "fastapi",
            ),
            (
                CallPattern {
                    regex: Regex::new(r#"\.route\(\s*['"`]([^'"`]+)"#).unwrap(),
                    method_group: None,
                    path_group: 1,
                },
                "axum",
            ),
        ]
    })
}

fn extract_calls(files: &[PathBuf], root: &Path) -> Vec<ApiCallSite> {
    let mut calls = Vec::new();
    for file in files {
        let Ok(content) = std::fs::read_to_string(file) else {
            continue;
        };
        let display = relative_display(root, file);
        for (line_no, line) in content.lines().enumerate() {
            for pattern in frontend_patterns() {
                if let Some(caps) = pattern.regex.captures(line) {
                    let raw_path = caps
                        .get(pattern.path_group)
                        .map(|m| m.as_str())
                        .unwrap_or("");
                    if !raw_path.starts_with('/') {
                        continue;
                    }
                    let method = pattern
                        .method_group
                        .and_then(|g| caps.get(g))
                        .map(|m| m.as_str().to_uppercase());
                    calls.push(ApiCallSite {
                        file: display.clone(),
                        line: line_no + 1,
                        method,
                        path_pattern: normalize_path_pattern(raw_path),
                    });
                }
            }
        }
    }
    calls
}

fn extract_routes(files: &[PathBuf], root: &Path) -> Vec<ApiRouteSite> {
    let mut routes = Vec::new();
    for file in files {
        let Ok(content) = std::fs::read_to_string(file) else {
            continue;
        };
        let display = relative_display(root, file);
        for (line_no, line) in content.lines().enumerate() {
            for (pattern, framework) in backend_patterns() {
                if let Some(caps) = pattern.regex.captures(line) {
                    let raw_path = caps
                        .get(pattern.path_group)
                        .map(|m| m.as_str())
                        .unwrap_or("");
                    if !raw_path.starts_with('/') {
                        continue;
                    }
                    let method = pattern
                        .method_group
                        .and_then(|g| caps.get(g))
                        .map(|m| m.as_str().to_uppercase());
                    routes.push(ApiRouteSite {
                        file: display.clone(),
                        line: line_no + 1,
                        method,
                        path_pattern: normalize_path_pattern(raw_path),
                        framework: framework.to_string(),
                    });
                }
            }
        }
    }
    routes
}

#[tauri::command]
pub fn contract_check(env_path: String) -> Result<Vec<ContractWarning>, String> {
    let root = Path::new(&env_path);
    if !root.is_dir() {
        return Err("env_not_found".to_string());
    }

    let mut frontend_files = Vec::new();
    walk_files(root, &["ts", "tsx", "js", "jsx"], &mut frontend_files);
    let mut backend_files = Vec::new();
    walk_files(root, &["py", "js", "ts", "rs"], &mut backend_files);

    let calls = extract_calls(&frontend_files, root);
    let routes = extract_routes(&backend_files, root);
    if routes.is_empty() {
        return Ok(Vec::new());
    }

    let warnings = calls
        .into_iter()
        .filter(|call| {
            !routes
                .iter()
                .any(|route| paths_related(&call.path_pattern, &route.path_pattern))
        })
        .map(|call| ContractWarning {
            reason: format!(
                "Nenhuma rota de backend encontrada para \"{}\" (verifique se o endpoint existe)",
                call.path_pattern
            ),
            call,
        })
        .collect();

    Ok(warnings)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("alethe-contract-{name}-{}", nanoid::nanoid!(6)));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn flags_call_with_no_matching_route() {
        let root = temp_dir("mismatch");
        fs::write(
            root.join("api.ts"),
            "export function loadUsers() {\n  return fetch('/api/v2/users')\n}\n",
        )
        .unwrap();
        fs::write(
            root.join("server.js"),
            "app.get('/api/v1/users', (req, res) => res.json([]))\n",
        )
        .unwrap();
        let warnings = contract_check(root.to_string_lossy().into_owned()).unwrap();
        assert_eq!(warnings.len(), 1);
        assert_eq!(warnings[0].call.path_pattern, "/api/v2/users");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn does_not_flag_when_route_matches() {
        let root = temp_dir("match");
        fs::write(
            root.join("api.ts"),
            "fetch('/api/users/' + id)\naxios.get('/api/users')\n",
        )
        .unwrap();
        fs::write(
            root.join("server.js"),
            "app.get('/api/users/:id', handler)\nrouter.get('/api/users', handler)\n",
        )
        .unwrap();
        let warnings = contract_check(root.to_string_lossy().into_owned()).unwrap();
        assert!(
            warnings.is_empty(),
            "esperava zero avisos, veio: {warnings:?}"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn silent_when_no_backend_routes_found() {
        let root = temp_dir("nobackend");
        fs::write(root.join("api.ts"), "fetch('/whatever/not/real')\n").unwrap();
        let warnings = contract_check(root.to_string_lossy().into_owned()).unwrap();
        assert!(warnings.is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn ignores_absolute_external_urls() {
        let root = temp_dir("external");
        fs::write(
            root.join("api.ts"),
            "fetch('https://external.example.com/x')\n",
        )
        .unwrap();
        fs::write(root.join("server.js"), "app.get('/api/x', handler)\n").unwrap();
        let warnings = contract_check(root.to_string_lossy().into_owned()).unwrap();
        assert!(warnings.is_empty());
        fs::remove_dir_all(root).unwrap();
    }
}
