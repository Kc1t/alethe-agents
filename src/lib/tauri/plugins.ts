import { invoke } from '@tauri-apps/api/core'

export type PluginKind = 'agentType' | 'skill' | 'validationPipeline' | 'ui' | 'theme'

export type ViewContainer = 'leftSidebar' | 'rightSidebar'

/** A view announced by the manifest, so the shell can draw its tab unloaded. */
export type ManifestView = {
  id: string
  container: ViewContainer
  title: string
  titleKey?: string | null
  panelTitleKey?: string | null
  icon?: string | null
  order?: number | null
}

export type ManifestCommand = {
  id: string
  title: string
  titleKey?: string | null
  icon?: string | null
  keywords?: string | null
}

export type ManifestContributes = {
  views?: ManifestView[]
  commands?: ManifestCommand[]
}

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
  /** Activation events. Empty means `onStartupFinished`. */
  activation?: string[]
  contributes?: ManifestContributes
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

/** Copies a plugin directory the user picked. The plugin arrives disabled. */
export async function pluginImportDir(source: string): Promise<PluginManifest> {
  return invoke<PluginManifest>('plugin_import_dir', { source })
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

export async function pluginStorageRead(id: string): Promise<string | null> {
  return invoke<string | null>('plugin_storage_read', { id })
}

export async function pluginStorageWrite(id: string, body: string | null): Promise<void> {
  await invoke('plugin_storage_write', { id, body })
}

export type CatalogPackage = {
  /** The zip that is fetched, unlike `downloadUrl`, which is a page for a human. */
  url: string
  /** Pins the bytes to what the index was reviewed against. */
  sha256: string
}

export type CatalogPlugin = {
  id: string
  name: string
  description: string
  author: string
  repo: string
  downloadUrl: string
  version: string
  minApiVersion: number
  capabilities: string[]
  /** Present when the plugin can be installed from inside the app. */
  package?: CatalogPackage
}

export type CatalogSnapshot = {
  plugins: CatalogPlugin[]
  fetchedAt: number
  /** True when the network failed and this came from disk. */
  stale: boolean
}

export async function pluginCatalog(
  apiVersion: number,
  refresh = false,
): Promise<CatalogSnapshot> {
  return invoke<CatalogSnapshot>('plugin_catalog', { apiVersion, refresh })
}

/** Opens a catalogue listing in the browser. Refused unless the catalogue offers it. */
export async function pluginCatalogOpen(apiVersion: number, url: string): Promise<void> {
  await invoke('plugin_catalog_open', { apiVersion, url })
}

/**
 * Downloads and unpacks a plugin the catalogue offers. Only the id crosses the
 * boundary: the URL and the hash are read from the cached index in Rust, so a
 * caller cannot point this at something the catalogue never listed. The plugin
 * arrives disabled.
 */
export async function pluginInstallFromCatalog(
  apiVersion: number,
  id: string,
): Promise<PluginManifest> {
  return invoke<PluginManifest>('plugin_install_from_catalog', { apiVersion, id })
}
