import { invoke } from '@tauri-apps/api/core'

export async function listWslDistros(): Promise<string[]> {
  return invoke<string[]>('list_wsl_distros')
}

export async function findWslCli(
  distro: string,
  command: string,
  refresh = false,
): Promise<string | null> {
  return invoke<string | null>('find_wsl_cli', { distro, command, refresh })
}

export async function wslDistroHome(distro: string): Promise<string | null> {
  return invoke<string | null>('wsl_distro_home', { distro })
}

export async function setWslIntegrationEnabled(enabled: boolean): Promise<void> {
  return invoke<void>('set_wsl_integration_enabled', { enabled })
}
