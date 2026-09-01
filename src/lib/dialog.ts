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

export async function pickDirectory(opts?: { defaultPath?: string }): Promise<string | null> {
  if (!isTauriEnv()) {
    return new Promise<string | null>((resolve) => {
      pendingFsResolver = resolve
      useUiStore.getState().openModal_('fsBrowser', {
        mode: 'folder',
        defaultPath: opts?.defaultPath,
      })
    })
  }
  const result = await open({
    directory: true,
    multiple: false,
    defaultPath: opts?.defaultPath,
  })
  if (typeof result === 'string') return result
  return null
}

export async function pickFile(opts?: {
  title?: string
  filters?: DialogFilter[]
  defaultPath?: string
}): Promise<string | null> {
  if (!isTauriEnv()) {
    return new Promise<string | null>((resolve) => {
      pendingFsResolver = resolve
      useUiStore.getState().openModal_('fsBrowser', {
        mode: 'file',
        title: opts?.title,
        defaultPath: opts?.defaultPath,
      })
    })
  }
  const result = await open({
    directory: false,
    multiple: false,
    title: opts?.title,
    filters: opts?.filters,
    defaultPath: opts?.defaultPath,
  })
  if (typeof result === 'string') return result
  return null
}

export async function saveFile(opts: {
  title?: string
  defaultPath?: string
  filters?: DialogFilter[]
}): Promise<string | null> {
  if (!isTauriEnv()) {
    return new Promise<string | null>((resolve) => {
      pendingFsResolver = resolve
      useUiStore.getState().openModal_('fsBrowser', {
        mode: 'file',
        title: opts.title,
        defaultPath: opts.defaultPath,
      })
    })
  }
  const result = await save({
    title: opts.title,
    defaultPath: opts.defaultPath,
    filters: opts.filters,
  })
  return result ?? null
}
