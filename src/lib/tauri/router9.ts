import { invoke } from '@tauri-apps/api/core'

import type { Router9Source } from '../types'

export type Router9Install = {
  installed: boolean
  version: string | null
  path: string | null
}

export type Router9Status = {
  managed: Router9Install
  external: Router9Install
  running: boolean
  portInUse: boolean
  port: number
  installDir: string
  dataDir: string
  logPath: string
  dashboardUrl: string
  pinnedVersion: string
}

export async function router9Status(port?: number): Promise<Router9Status> {
  return invoke<Router9Status>('router9_status', { port: port ?? null })
}

export async function router9InstallCommand(): Promise<string> {
  return invoke<string>('router9_install_command')
}

export async function router9UninstallCommand(): Promise<string> {
  return invoke<string>('router9_uninstall_command')
}

export async function router9Start(port?: number, source?: Router9Source): Promise<void> {
  await invoke('router9_start', { port: port ?? null, source: source ?? null })
}

export async function router9Stop(): Promise<void> {
  await invoke('router9_stop')
}
