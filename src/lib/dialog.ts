import { open, save, type DialogFilter } from '@tauri-apps/plugin-dialog'
import { isTauriEnv } from './api/transport'

export async function pickDirectory(opts?: { defaultPath?: string }): Promise<string | null> {
  if (!isTauriEnv()) {
    const result = window.prompt('Digite o caminho do diretório:', opts?.defaultPath || '')
    return result?.trim() || null
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
    const result = window.prompt(
      opts?.title || 'Digite o caminho do executável ou arquivo:',
      opts?.defaultPath || '',
    )
    return result?.trim() || null
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
    const result = window.prompt(opts.title || 'Salvar como:', opts.defaultPath || '')
    return result?.trim() || null
  }
  const result = await save({
    title: opts.title,
    defaultPath: opts.defaultPath,
    filters: opts.filters,
  })
  return result ?? null
}
