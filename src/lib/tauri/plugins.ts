import { invoke } from '@tauri-apps/api/core'

export type PluginKind = 'agentType' | 'skill' | 'validationPipeline' | 'ui' | 'theme'

export type PluginManifest = {
  id: string
  name: string
  version: string
  kind: PluginKind
  apiVersion: number
  description: string
  /** Script asset relative to the plugin directory. Absent for bundled plugins. */
  entry?: string | null
  styles?: string | null
  capabilities: string[]
  spec: Record<string, unknown>
}

export type InstalledPlugin = PluginManifest & {
  enabled: boolean
  path: string
}

export async function pluginsList(kind?: PluginKind): Promise<InstalledPlugin[]> {
  return invoke<InstalledPlugin[]>('plugins_list', { kind })
}

/** Disabled ids across every plugin, bundled ones included. */
export async function pluginsDisabled(): Promise<string[]> {
  return invoke<string[]>('plugins_disabled')
}

export async function pluginsDir(): Promise<string> {
  return invoke<string>('plugins_dir')
}

export async function pluginInstall(manifest: PluginManifest): Promise<void> {
  await invoke('plugin_install', { manifest })
}

export async function pluginUninstall(id: string): Promise<void> {
  await invoke('plugin_uninstall', { id })
}

export async function pluginSetEnabled(id: string, enabled: boolean): Promise<void> {
  await invoke('plugin_set_enabled', { id, enabled })
}

/**
 * Generic bridge for the plugin host. Every call is gated by the caller against
 * the plugin's declared capabilities before it reaches this function.
 */
export async function pluginInvoke<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  return invoke<T>(command, args)
}
