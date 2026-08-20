import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

import { isTauriEnv, webApiFetch } from './transport'

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
  if (isTauriEnv()) return invoke<DirectoryListing>('list_directory', { path })
  return webApiFetch<DirectoryListing>(`/api/fs/list?path=${encodeURIComponent(path)}`)
}

export async function readTextFile(path: string): Promise<string> {
  if (isTauriEnv()) return invoke<string>('read_text_file', { path })
  return webApiFetch<string>(`/api/fs/read?path=${encodeURIComponent(path)}`)
}

export async function writeTextFile(path: string, content: string): Promise<void> {
  if (isTauriEnv()) return invoke('write_text_file', { path, content })
  await webApiFetch('/api/fs/write', { method: 'POST', body: JSON.stringify({ path, content }) })
}

export async function renameFilesystemEntry(path: string, newName: string): Promise<string> {
  if (isTauriEnv()) return invoke<string>('rename_filesystem_entry', { path, newName })
  return webApiFetch<string>('/api/fs/rename', {
    method: 'POST',
    body: JSON.stringify({ path, newName }),
  })
}

export async function deleteFilesystemEntry(path: string): Promise<void> {
  if (isTauriEnv()) return invoke('delete_filesystem_entry', { path })
  await webApiFetch('/api/fs/delete', { method: 'POST', body: JSON.stringify({ path }) })
}

export async function ensureTodoTemplate(directory: string): Promise<string> {
  if (isTauriEnv()) return invoke<string>('ensure_todo_template', { directory })
  return webApiFetch<string>('/api/fs/todo_template', {
    method: 'POST',
    body: JSON.stringify({ directory }),
  })
}

export async function writeProjectMarker(projectDir: string, content: string): Promise<void> {
  if (isTauriEnv()) return invoke('write_project_marker', { projectDir, content })
  await webApiFetch('/api/fs/write_marker', {
    method: 'POST',
    body: JSON.stringify({ projectDir, content }),
  })
}

export async function readProjectMarker(projectDir: string): Promise<string | null> {
  if (isTauriEnv()) return invoke<string | null>('read_project_marker', { projectDir })
  return webApiFetch<string | null>(
    `/api/fs/read_marker?projectDir=${encodeURIComponent(projectDir)}`,
  )
}

export async function watchFile(path: string): Promise<void> {
  if (isTauriEnv()) return invoke('watch_file', { path })
}

export async function unwatchFile(path: string): Promise<void> {
  if (isTauriEnv()) return invoke('unwatch_file', { path })
}

export function listenFileChanged(handler: (path: string) => void): Promise<UnlistenFn> {
  if (isTauriEnv()) {
    return listen<{ path: string }>('md://changed', (event) => handler(event.payload.path))
  }
  return Promise.resolve(() => {})
}

export async function openDataFolder(): Promise<void> {
  if (isTauriEnv()) return invoke('open_data_folder')
}

export async function openSpawnLog(): Promise<void> {
  if (isTauriEnv()) return invoke('open_spawn_log')
}

export async function openInFileExplorer(path: string): Promise<void> {
  if (isTauriEnv()) return invoke('open_in_file_explorer', { path })
}

export async function openInVscode(path: string): Promise<void> {
  if (isTauriEnv()) return invoke('open_in_vscode', { path })
}

export async function openInBrowser(target: string): Promise<void> {
  if (isTauriEnv()) return invoke('open_in_browser', { target })
  window.open(target, '_blank')
}

export async function openLogsFolder(): Promise<void> {
  if (isTauriEnv()) return invoke('open_logs_folder')
}

export async function exportLogs(targetPath: string): Promise<void> {
  if (isTauriEnv()) return invoke('export_logs', { targetPath })
}

export async function writeClipboardText(text: string): Promise<void> {
  if (isTauriEnv()) return invoke('write_clipboard_text', { text })
  await navigator.clipboard.writeText(text)
}

export async function readClipboardText(): Promise<string> {
  if (isTauriEnv()) return invoke<string>('read_clipboard_text')
  return navigator.clipboard.readText()
}

export type ClipboardPayload =
  | { kind: 'text'; text: string }
  | { kind: 'paths'; paths: string[] }
  | { kind: 'image'; path: string }
  | { kind: 'empty' }

export async function readClipboardPayload(): Promise<ClipboardPayload> {
  if (isTauriEnv()) return invoke<ClipboardPayload>('read_clipboard_payload')
  const text = await navigator.clipboard.readText()
  return text ? { kind: 'text', text } : { kind: 'empty' }
}
