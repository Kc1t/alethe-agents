import { invoke } from '@tauri-apps/api/core'
import { isTauriEnv } from './transport'

export type FolderTreeNode = {
  name: string
  path: string
  isDir: boolean
  sizeBytes: number
  children: FolderTreeNode[]
  isHeavy: boolean
}

export type BackupArchiveEntry = {
  filename: string
  path: string
  createdAt: number
  sizeBytes: number
  sha256: string
}

export async function scanProjectFolderTree(projectPath: string): Promise<FolderTreeNode[]> {
  if (!isTauriEnv()) {
    return [
      { name: 'src', path: 'src', isDir: true, sizeBytes: 0, children: [], isHeavy: false },
      { name: 'docs', path: 'docs', isDir: true, sizeBytes: 0, children: [], isHeavy: false },
      { name: 'node_modules', path: 'node_modules', isDir: true, sizeBytes: 0, children: [], isHeavy: true },
      { name: '.env', path: '.env', isDir: false, sizeBytes: 50, children: [], isHeavy: true },
    ]
  }
  return invoke<FolderTreeNode[]>('scan_project_folder_tree', { projectPath })
}

export async function setupProjectMeshIsolation(baseDir: string, projectName: string): Promise<string> {
  if (!isTauriEnv()) {
    return `${baseDir}/${projectName}`
  }
  return invoke<string>('setup_project_mesh_isolation', { baseDir, projectName })
}

export async function triggerProjectArchiveBackup(projectPath: string, projectName: string): Promise<BackupArchiveEntry> {
  if (!isTauriEnv()) {
    return {
      filename: `backup_${projectName}_${Date.now()}.bin`,
      path: `${projectPath}/.alethe/backups/archive/backup.bin`,
      createdAt: Math.floor(Date.now() / 1000),
      sizeBytes: 1024,
      sha256: 'mock-sha256',
    }
  }
  return invoke<BackupArchiveEntry>('trigger_project_archive_backup', { projectPath, projectName })
}

export async function purgeProjectBackupsSecured(projectPath: string, expectedName: string, confirmationName: string): Promise<number> {
  if (!isTauriEnv()) {
    return 1
  }
  return invoke<number>('purge_project_backups_secured', { projectPath, expectedName, confirmationName })
}
