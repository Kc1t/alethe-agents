import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

import { isTauriEnv, webApiFetch } from '../api/transport'

export type DirectoryEntry = {
  name: string
  path: string
  is_dir: boolean
  size_bytes?: number | null
}

export type DirectoryListing = {
  current_path: string
  parent_path: string | null
  home_path: string
  system_roots: string[]
  entries: DirectoryEntry[]
}

export async function listDirectory(path: string): Promise<DirectoryListing> {
  if (!isTauriEnv()) {
    return webApiFetch<DirectoryListing>(`/api/fs/list_directory?path=${encodeURIComponent(path)}`)
  }
  return invoke<DirectoryListing>('list_directory', { path })
}

export async function readTextFile(path: string): Promise<string> {
  if (!isTauriEnv()) {
    return webApiFetch<string>(`/api/fs/read_text?path=${encodeURIComponent(path)}`)
  }
  return invoke<string>('read_text_file', { path })
}

export async function writeTextFile(path: string, content: string): Promise<void> {
  if (!isTauriEnv()) {
    await webApiFetch('/api/fs/write_text', {
      method: 'POST',
      body: JSON.stringify({ path, content }),
    })
    return
  }
  await invoke('write_text_file', { path, content })
}

export async function renameFilesystemEntry(path: string, newName: string): Promise<string> {
  return invoke<string>('rename_filesystem_entry', { path, newName })
}

export async function deleteFilesystemEntry(path: string): Promise<void> {
  await invoke('delete_filesystem_entry', { path })
}

export async function ensureTodoTemplate(directory: string): Promise<string> {
  return invoke<string>('ensure_todo_template', { directory })
}

export async function writeProjectMarker(projectDir: string, content: string): Promise<void> {
  await invoke('write_project_marker', { projectDir, content })
}

export async function readProjectMarker(projectDir: string): Promise<string | null> {
  return invoke<string | null>('read_project_marker', { projectDir })
}

export async function watchFile(path: string): Promise<void> {
  await invoke('watch_file', { path })
}

export async function unwatchFile(path: string): Promise<void> {
  await invoke('unwatch_file', { path })
}

export function listenFileChanged(handler: (path: string) => void): Promise<UnlistenFn> {
  return listen<{ path: string }>('md://changed', (event) => handler(event.payload.path))
}

export async function openDataFolder(): Promise<void> {
  await invoke('open_data_folder')
}

export async function openSpawnLog(): Promise<void> {
  await invoke('open_spawn_log')
}

export async function openInFileExplorer(path: string): Promise<void> {
  await invoke('open_in_file_explorer', { path })
}

export async function openInVscode(path: string): Promise<void> {
  await invoke('open_in_vscode', { path })
}

export async function openInBrowser(target: string): Promise<void> {
  await invoke('open_in_browser', { target })
}

export async function openLogsFolder(): Promise<void> {
  await invoke('open_logs_folder')
}

export async function exportLogs(targetPath: string): Promise<void> {
  await invoke('export_logs', { targetPath })
}

export async function writeClipboardText(text: string): Promise<void> {
  await invoke('write_clipboard_text', { text })
}

export async function readClipboardText(): Promise<string> {
  return invoke<string>('read_clipboard_text')
}

export type ClipboardPayload =
  | { kind: 'text'; text: string }
  | { kind: 'paths'; paths: string[] }
  | { kind: 'image'; path: string }
  | { kind: 'empty' }

export async function readClipboardPayload(): Promise<ClipboardPayload> {
  return invoke<ClipboardPayload>('read_clipboard_payload')
}
