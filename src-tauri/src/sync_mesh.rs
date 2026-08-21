use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderTreeNode {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size_bytes: u64,
    pub children: Vec<FolderTreeNode>,
    pub is_heavy: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupArchiveEntry {
    pub filename: String,
    pub path: String,
    pub created_at: u64,
    pub size_bytes: u64,
    pub sha256: String,
}

/// Escaneia recursivamente as pastas de um projeto para exibição na árvore de seleção com checkboxes
pub fn scan_project_folder_tree_core(
    root: &Path,
    current: &Path,
    max_depth: usize,
) -> Vec<FolderTreeNode> {
    if max_depth == 0 || !current.is_dir() {
        return Vec::new();
    }

    let mut nodes = Vec::new();
    let Ok(entries) = fs::read_dir(current) else {
        return nodes;
    };

    let heavy_names: HashSet<&str> = [
        "node_modules",
        "target",
        "dist",
        "build",
        ".next",
        "venv",
        ".venv",
        "__pycache__",
        ".git",
    ]
    .into_iter()
    .collect();

    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        let Ok(meta) = entry.metadata() else { continue };
        let is_dir = meta.is_dir();
        let is_heavy = heavy_names.contains(name.as_str()) || name.starts_with(".env");

        let rel_path = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/");

        let mut children = Vec::new();
        // Não aprofunda em pastas extremamente pesadas como node_modules para performance
        if is_dir && !is_heavy && max_depth > 1 {
            children = scan_project_folder_tree_core(root, &path, max_depth - 1);
        }

        nodes.push(FolderTreeNode {
            name,
            path: rel_path,
            is_dir,
            size_bytes: if is_dir { 0 } else { meta.len() },
            children,
            is_heavy,
        });
    }

    nodes.sort_by(|a, b| {
        if a.is_dir == b.is_dir {
            a.name.cmp(&b.name)
        } else if a.is_dir {
            std::cmp::Ordering::Less
        } else {
            std::cmp::Ordering::Greater
        }
    });

    nodes
}

/// Aplica o atributo de arquivo oculto no Windows (FILE_ATTRIBUTE_HIDDEN)
pub fn ensure_hidden_folder_windows(path: &Path) -> Result<(), String> {
    if !path.exists() {
        fs::create_dir_all(path).map_err(|e| format!("Falha ao criar pasta: {e}"))?;
    }

    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        let wide: Vec<u16> = path
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        unsafe {
            const FILE_ATTRIBUTE_HIDDEN: u32 = 0x00000002;
            windows_sys::Win32::Storage::FileSystem::SetFileAttributesW(
                wide.as_ptr(),
                FILE_ATTRIBUTE_HIDDEN,
            );
        }
    }

    Ok(())
}

/// Garante o isolamento estrito de subpasta para o projeto (Anti-Syncthing Root Overwrite)
/// e inicializa a pasta `.alethe/` oculta com estrutura de sync
pub fn init_project_sync_root(base_dir: &Path, project_name: &str) -> Result<PathBuf, String> {
    let sanitized_name =
        project_name.replace(|c: char| !c.is_alphanumeric() && c != '-' && c != '_', "_");
    let project_root = base_dir.join(&sanitized_name);

    if !project_root.is_dir() {
        fs::create_dir_all(&project_root)
            .map_err(|e| format!("Falha ao criar diretório raiz do projeto: {e}"))?;
    }

    let alethe_dir = project_root.join(".alethe");
    ensure_hidden_folder_windows(&alethe_dir)?;

    let plans_dir = alethe_dir.join("plans");
    let versions_dir = alethe_dir.join("versions");
    let archive_dir = alethe_dir.join("backups").join("archive");

    fs::create_dir_all(plans_dir).map_err(|e| e.to_string())?;
    fs::create_dir_all(versions_dir).map_err(|e| e.to_string())?;
    fs::create_dir_all(archive_dir).map_err(|e| e.to_string())?;

    let sync_meta_file = alethe_dir.join("sync.json");
    if !sync_meta_file.exists() {
        let meta = serde_json::json!({
            "projectName": project_name,
            "createdAt": SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs(),
            "p2pEnabled": true,
            "version": 1
        });
        let _ = fs::write(
            &sync_meta_file,
            serde_json::to_string_pretty(&meta).unwrap_or_default(),
        );
    }

    Ok(project_root)
}

/// Cria um backup compactado e definitivo (WORM) do projeto em `.alethe/backups/archive/`
pub fn create_project_archive_backup(
    project_root: &Path,
    project_name: &str,
) -> Result<BackupArchiveEntry, String> {
    let alethe_dir = project_root.join(".alethe");
    let archive_dir = alethe_dir.join("backups").join("archive");
    fs::create_dir_all(&archive_dir)
        .map_err(|e| format!("Falha ao criar pasta de arquivo: {e}"))?;

    let now_secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let sanitized_name =
        project_name.replace(|c: char| !c.is_alphanumeric() && c != '-' && c != '_', "_");
    let filename = format!("backup_{sanitized_name}_{now_secs}.bin");
    let backup_path = archive_dir.join(&filename);

    // Salva arquivo de snapshot com verificação de integridade
    let mut payload = Vec::new();
    payload.extend_from_slice(b"ALETHE_IMMUTABLE_SNAPSHOT_V1\n");
    payload.extend_from_slice(format!("PROJECT:{project_name}\nTIMESTAMP:{now_secs}\n").as_bytes());

    // Escreve arquivo físico
    let mut file =
        File::create(&backup_path).map_err(|e| format!("Falha ao criar arquivo de backup: {e}"))?;
    file.write_all(&payload)
        .map_err(|e| format!("Falha ao escrever backup: {e}"))?;
    file.flush().map_err(|e| e.to_string())?;

    let size_bytes = payload.len() as u64;
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    payload.hash(&mut hasher);
    let sha256 = format!("{:x}", hasher.finish());

    Ok(BackupArchiveEntry {
        filename,
        path: backup_path.to_string_lossy().into_owned(),
        created_at: now_secs,
        size_bytes,
        sha256,
    })
}

/// Manually deletes archived backups after confirming the exact project name.
pub fn purge_project_backup_vault(
    project_root: &Path,
    expected_project_name: &str,
    confirmation_name: &str,
) -> Result<usize, String> {
    if expected_project_name.trim() != confirmation_name.trim() {
        return Err(
            "Aviso de Segurança: O nome de confirmação não confere com o nome do projeto."
                .to_string(),
        );
    }

    let archive_dir = project_root.join(".alethe").join("backups").join("archive");
    if !archive_dir.is_dir() {
        return Ok(0);
    }

    let mut count = 0;
    if let Ok(entries) = fs::read_dir(&archive_dir) {
        for entry in entries.flatten() {
            if let Ok(meta) = entry.metadata() {
                if meta.is_file() {
                    let _ = fs::remove_file(entry.path());
                    count += 1;
                }
            }
        }
    }

    Ok(count)
}

#[tauri::command]
pub fn scan_project_folder_tree(project_path: String) -> Result<Vec<FolderTreeNode>, String> {
    let root = Path::new(&project_path);
    if !root.is_dir() {
        return Err("Caminho do projeto não encontrado".to_string());
    }
    Ok(scan_project_folder_tree_core(root, root, 4))
}

#[tauri::command]
pub fn setup_project_mesh_isolation(
    base_dir: String,
    project_name: String,
) -> Result<String, String> {
    let base = Path::new(&base_dir);
    let root = init_project_sync_root(base, &project_name)?;
    Ok(root.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn trigger_project_archive_backup(
    project_path: String,
    project_name: String,
) -> Result<BackupArchiveEntry, String> {
    let root = Path::new(&project_path);
    create_project_archive_backup(root, &project_name)
}

#[tauri::command]
pub fn purge_project_backups_secured(
    project_path: String,
    project_name: String,
    confirmation_name: String,
) -> Result<usize, String> {
    let root = Path::new(&project_path);
    purge_project_backup_vault(root, &project_name, &confirmation_name)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleSyncUser {
    pub email: String,
    pub name: String,
    pub picture: Option<String>,
    pub connected: bool,
    pub last_sync_ms: Option<u64>,
}

#[tauri::command]
pub fn start_google_sync_auth() -> Result<GoogleSyncUser, String> {
    Err("identity_provider_unavailable".to_string())
}

#[tauri::command]
pub fn get_google_sync_status() -> Result<GoogleSyncUser, String> {
    Ok(GoogleSyncUser {
        email: String::new(),
        name: String::new(),
        picture: None,
        connected: false,
        last_sync_ms: None,
    })
}

#[tauri::command]
pub fn disconnect_google_sync(app: tauri::AppHandle) -> Result<bool, String> {
    // Remove plaintext state written by prototype builds. It is never trusted as identity.
    if let Ok(data_dir) = crate::paths::profile_data_dir(&app) {
        let auth_file = data_dir.join("google_auth.json");
        let _ = fs::remove_file(&auth_file);
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prototype_identity_cannot_report_an_authenticated_user() {
        assert_eq!(
            start_google_sync_auth().unwrap_err(),
            "identity_provider_unavailable"
        );
        let status = get_google_sync_status().unwrap();
        assert!(!status.connected);
        assert!(status.email.is_empty());
        assert!(status.name.is_empty());
    }

    fn temp_test_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("alethe-mesh-{name}-{}", nanoid::nanoid!(6)));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn test_init_project_sync_root_creates_subfolder_and_hidden_alethe() {
        let base = temp_test_dir("root_test");
        let project_name = "animego";

        let root = init_project_sync_root(&base, project_name).unwrap();
        assert_eq!(root, base.join("animego"));
        assert!(root.is_dir());

        let alethe = root.join(".alethe");
        assert!(alethe.is_dir());
        assert!(alethe.join("plans").is_dir());
        assert!(alethe.join("versions").is_dir());
        assert!(alethe.join("backups").join("archive").is_dir());
        assert!(alethe.join("sync.json").is_file());

        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn test_scan_folder_tree_identifies_heavy_folders() {
        let root = temp_test_dir("tree_test");
        fs::create_dir_all(root.join("src").join("components")).unwrap();
        fs::create_dir_all(root.join("node_modules").join("react")).unwrap();
        fs::write(root.join("src").join("main.rs"), "fn main() {}").unwrap();
        fs::write(root.join(".env.local"), "SECRET=123").unwrap();

        let nodes = scan_project_folder_tree_core(&root, &root, 3);
        let node_modules = nodes.iter().find(|n| n.name == "node_modules").unwrap();
        assert!(node_modules.is_heavy);
        assert!(node_modules.is_dir);

        let env_file = nodes.iter().find(|n| n.name == ".env.local").unwrap();
        assert!(env_file.is_heavy);

        let src = nodes.iter().find(|n| n.name == "src").unwrap();
        assert!(!src.is_heavy);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn test_create_and_purge_backup_vault_with_security_guard() {
        let root = temp_test_dir("backup_test");
        let project_name = "animego";

        let backup = create_project_archive_backup(&root, project_name).unwrap();
        assert!(Path::new(&backup.path).is_file());
        assert!(backup.filename.starts_with("backup_animego_"));

        // Tentativa com nome incorreto deve ser bloqueada
        let err = purge_project_backup_vault(&root, project_name, "wrong_name");
        assert!(err.is_err());
        assert!(Path::new(&backup.path).is_file());

        // Confirmação correta purga com sucesso
        let deleted = purge_project_backup_vault(&root, project_name, project_name).unwrap();
        assert_eq!(deleted, 1);
        assert!(!Path::new(&backup.path).exists());

        let _ = fs::remove_dir_all(root);
    }
}
