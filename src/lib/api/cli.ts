import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

import { isTauriEnv, webApiFetch } from './transport'

const OPEN_PATH_EVENT = 'alethe://open-path'

export type CliShimStatus = {
  supported: boolean
  installed: boolean
  stale: boolean
  path: string | null
  binDir: string | null
  onPath: boolean
}

type RawCliShimStatus = {
  supported: boolean
  installed: boolean
  stale: boolean
  path: string | null
  bin_dir: string | null
  on_path: boolean
}

function toCliShimStatus(raw: RawCliShimStatus): CliShimStatus {
  return {
    supported: raw.supported,
    installed: raw.installed,
    stale: raw.stale,
    path: raw.path,
    binDir: raw.bin_dir,
    onPath: raw.on_path,
  }
}

export async function cliTakePendingOpen(): Promise<string | null> {
  if (isTauriEnv()) return invoke<string | null>('cli_take_pending_open')
  return null
}

export async function cliShimStatus(): Promise<CliShimStatus> {
  if (isTauriEnv()) return toCliShimStatus(await invoke<RawCliShimStatus>('cli_shim_status'))
  const raw = await webApiFetch<RawCliShimStatus>('/api/cli/shim_status')
  return toCliShimStatus(raw)
}

export async function cliShimInstall(): Promise<CliShimStatus> {
  if (isTauriEnv()) return toCliShimStatus(await invoke<RawCliShimStatus>('cli_shim_install'))
  const raw = await webApiFetch<RawCliShimStatus>('/api/cli/shim_install', { method: 'POST' })
  return toCliShimStatus(raw)
}

export async function cliShimUninstall(): Promise<CliShimStatus> {
  if (isTauriEnv()) return toCliShimStatus(await invoke<RawCliShimStatus>('cli_shim_uninstall'))
  const raw = await webApiFetch<RawCliShimStatus>('/api/cli/shim_uninstall', { method: 'POST' })
  return toCliShimStatus(raw)
}

export function listenCliOpenPath(handler: (path: string) => void): Promise<UnlistenFn> {
  if (isTauriEnv()) {
    return listen<string>(OPEN_PATH_EVENT, (event) => handler(event.payload))
  }
  return Promise.resolve(() => {})
}
