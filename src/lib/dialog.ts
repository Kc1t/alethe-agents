import { open, save, type DialogFilter } from '@tauri-apps/plugin-dialog'

import { useUiStore } from '../stores/uiStore'

function isTauriEnv(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

export type FsBrowserCallback = (path: string | null) => void

let pendingFsResolver: FsBrowserCallback | null = null

export function resolvePendingFsBrowser(path: string | null) {
  if (pendingFsResolver) {
    pendingFsResolver(path)
    pendingFsResolver = null
  }
}

/** In-app picker for non-Tauri (browser) and as a last-resort fallback. */
function openInAppFsBrowser(opts: {
  mode: 'folder' | 'file'
  title?: string
  defaultPath?: string
}): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    pendingFsResolver = resolve
    useUiStore.getState().openFsBrowser({
      mode: opts.mode,
      title: opts.title,
      defaultPath: opts.defaultPath,
    })
  })
}

export async function pickDirectory(opts?: { defaultPath?: string }): Promise<string | null> {
  if (!isTauriEnv()) {
    return openInAppFsBrowser({ mode: 'folder', defaultPath: opts?.defaultPath })
  }
  try {
    const result = await open({
      directory: true,
      multiple: false,
      defaultPath: opts?.defaultPath,
    })
    if (typeof result === 'string') return result
    return null
  } catch {
    return openInAppFsBrowser({ mode: 'folder', defaultPath: opts?.defaultPath })
  }
}

export async function pickFile(opts?: {
  title?: string
  filters?: DialogFilter[]
  defaultPath?: string
}): Promise<string | null> {
  if (!isTauriEnv()) {
    return openInAppFsBrowser({
      mode: 'file',
      title: opts?.title,
      defaultPath: opts?.defaultPath,
    })
  }
  try {
    const result = await open({
      directory: false,
      multiple: false,
      title: opts?.title,
      filters: opts?.filters,
      defaultPath: opts?.defaultPath,
    })
    if (typeof result === 'string') return result
    return null
  } catch {
    return openInAppFsBrowser({
      mode: 'file',
      title: opts?.title,
      defaultPath: opts?.defaultPath,
    })
  }
}

export async function saveFile(opts: {
  title?: string
  defaultPath?: string
  filters?: DialogFilter[]
}): Promise<string | null> {
  if (!isTauriEnv()) {
    return openInAppFsBrowser({
      mode: 'file',
      title: opts.title,
      defaultPath: opts.defaultPath,
    })
  }
  try {
    const result = await save({
      title: opts.title,
      defaultPath: opts.defaultPath,
      filters: opts.filters,
    })
    return result ?? null
  } catch {
    return openInAppFsBrowser({
      mode: 'file',
      title: opts.title,
      defaultPath: opts.defaultPath,
    })
  }
}
