import { invoke } from '@tauri-apps/api/core'

import { isTauriEnv } from './transport'

export type FolderTreeNode = {
  name: string
  path: string
  isDir: boolean
  sizeBytes: number
  children: FolderTreeNode[]
  isHeavy: boolean
  isEssential?: boolean
  category?: string
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
    throw new Error('mesh_unavailable_in_browser')
  }
  return invoke<FolderTreeNode[]>('scan_project_folder_tree', { projectPath })
}

export async function setupProjectMeshIsolation(
  baseDir: string,
  projectName: string,
): Promise<string> {
  if (!isTauriEnv()) {
    throw new Error('mesh_unavailable_in_browser')
  }
  return invoke<string>('setup_project_mesh_isolation', { baseDir, projectName })
}

export async function triggerProjectArchiveBackup(
  projectPath: string,
  projectName: string,
): Promise<BackupArchiveEntry> {
  if (!isTauriEnv()) {
    throw new Error('mesh_unavailable_in_browser')
  }
  return invoke<BackupArchiveEntry>('trigger_project_archive_backup', { projectPath, projectName })
}

export async function listProjectBackups(projectPath: string): Promise<BackupArchiveEntry[]> {
  if (!isTauriEnv()) {
    throw new Error('mesh_unavailable_in_browser')
  }
  return invoke<BackupArchiveEntry[]>('list_project_backups', { projectPath })
}

export async function purgeProjectBackupsSecured(
  projectPath: string,
  projectName: string,
  confirmationName: string,
): Promise<number> {
  if (!isTauriEnv()) {
    throw new Error('mesh_unavailable_in_browser')
  }
  return invoke<number>('purge_project_backups_secured', {
    projectPath,
    projectName,
    confirmationName,
  })
}

export type GoogleSyncUser = {
  email: string
  name: string
  picture?: string
  connected: boolean
  configured: boolean
  lastSyncMs?: number
}

export async function startGoogleSyncAuth(): Promise<GoogleSyncUser> {
  if (!isTauriEnv()) {
    throw new Error('identity_provider_unavailable')
  }
  return invoke<GoogleSyncUser>('start_google_sync_auth')
}

/**
 * `clientSecret` is optional in the general OAuth sense, but Google's "Desktop app" client type
 * has a real quirk: its token endpoint still validates a client secret even though PKCE is also
 * used. Leaving it empty clears any previously stored one, so switching to a client that does not
 * need it never silently keeps sending a stale secret for the new client ID.
 */
export async function configureGoogleSync(
  clientId: string,
  clientSecret?: string,
): Promise<boolean> {
  if (!isTauriEnv()) {
    throw new Error('identity_provider_unavailable')
  }
  return invoke<boolean>('configure_google_sync', { clientId, clientSecret })
}

export async function getGoogleSyncStatus(): Promise<GoogleSyncUser> {
  if (!isTauriEnv()) {
    return {
      email: '',
      name: '',
      connected: false,
      configured: false,
    }
  }
  return invoke<GoogleSyncUser>('get_google_sync_status')
}

export async function disconnectGoogleSync(): Promise<boolean> {
  if (!isTauriEnv()) {
    return true
  }
  return invoke<boolean>('disconnect_google_sync')
}
