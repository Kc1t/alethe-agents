import { BUNDLED_PLUGINS } from '../../plugins'
import {
  getLocale,
  type Locale,
  registerMessages as registerCoreMessages,
  translateDynamic,
} from '../i18n'
import {
  pluginInvoke,
  type PluginManifest,
  pluginsDisabled,
  pluginSetEnabled,
  pluginsList,
} from '../tauri'
import { canInvoke, grants, isValidCapability } from './permissions'
import {
  commandContributions,
  paneContributions,
  sidebarTabContributions,
  themeContributions,
} from './registry'
import type {
  Disposable,
  PluginContext,
  PluginModule,
  PluginRuntimeEntry,
  PluginSource,
} from './types'

export const PLUGIN_API_VERSION = 1

type PluginLoader = () => Promise<PluginModule>

type PluginRecord = {
  manifest: PluginManifest
  source: PluginSource
  loader: PluginLoader | null
  enabled: boolean
  active: boolean
  error: string | null
  context: PluginContext | null
  module: PluginModule | null
}

const records = new Map<string, PluginRecord>()
const listeners = new Set<() => void>()
let snapshot: readonly PluginRuntimeEntry[] = []
let initialized = false

function refresh() {
  snapshot = [...records.values()]
    .map((record) => ({
      manifest: record.manifest,
      source: record.source,
      enabled: record.enabled,
      active: record.active,
      error: record.error,
    }))
    .sort((a, b) => a.manifest.id.localeCompare(b.manifest.id))
  for (const listener of listeners) listener()
}

export function subscribePlugins(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getPluginEntries(): readonly PluginRuntimeEntry[] {
  return snapshot
}

function createContext(manifest: PluginManifest): PluginContext {
  const subscriptions: Disposable[] = []
  const prefix = `plugin.${manifest.id}.`

  const track = (disposable: Disposable): Disposable => {
    subscriptions.push(disposable)
    return disposable
  }

  const namespaced = (key: string) => (key.startsWith(prefix) ? key : `${prefix}${key}`)

  const require = (capability: string) => {
    if (!grants(manifest.capabilities, capability)) {
      throw new Error(`capability_denied:${manifest.id}:${capability}`)
    }
  }

  return {
    id: manifest.id,
    manifest,
    subscriptions,
    contributes: {
      theme: (definition) => {
        require('ui.theme')
        return track(themeContributions.add(manifest.id, definition))
      },
      pane: (definition) => {
        require('ui.pane')
        return track(paneContributions.add(manifest.id, definition))
      },
      sidebarTab: (definition) => {
        require('ui.sidebarTab')
        return track(sidebarTabContributions.add(manifest.id, definition))
      },
      command: (definition) => {
        require('ui.command')
        return track(commandContributions.add(manifest.id, definition))
      },
    },
    registerMessages: (locale: Locale, messages) => {
      const prefixed: Record<string, string> = {}
      for (const [key, value] of Object.entries(messages)) prefixed[namespaced(key)] = value
      const undo = registerCoreMessages(locale, prefixed)
      return track({ dispose: undo })
    },
    t: (key, params) => translateDynamic(getLocale(), namespaced(key), params),
    invoke: async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
      if (!canInvoke(manifest.capabilities, command)) {
        throw new Error(`capability_denied:${manifest.id}:invoke:${command}`)
      }
      return pluginInvoke<T>(command, args)
    },
  }
}

function validateManifest(manifest: PluginManifest): string | null {
  if (manifest.apiVersion !== PLUGIN_API_VERSION) {
    return `unsupported_api_version:${manifest.apiVersion}`
  }
  const invalid = manifest.capabilities.filter((capability) => !isValidCapability(capability))
  if (invalid.length > 0) return `invalid_capability:${invalid.join(',')}`
  return null
}

async function activate(record: PluginRecord): Promise<void> {
  if (record.active || !record.enabled) return

  const problem = validateManifest(record.manifest)
  if (problem) {
    record.error = problem
    return
  }
  if (!record.loader) {
    // A manifest-only plugin (theme spec, agent type, skill) has nothing to run.
    record.active = true
    record.error = null
    return
  }

  const context = createContext(record.manifest)
  record.context = context
  try {
    const module = await record.loader()
    record.module = module
    await module.activate?.(context)
    record.active = true
    record.error = null
  } catch (error) {
    disposeContext(context)
    record.context = null
    record.module = null
    record.active = false
    record.error = error instanceof Error ? error.message : String(error)
    if (import.meta.env.DEV) console.error(`[Alethe][plugin:${record.manifest.id}]`, error)
  }
}

function disposeContext(context: PluginContext) {
  for (let i = context.subscriptions.length - 1; i >= 0; i -= 1) {
    try {
      context.subscriptions[i].dispose()
    } catch (error) {
      if (import.meta.env.DEV) console.error('[Alethe][plugin dispose]', error)
    }
  }
  context.subscriptions.length = 0
}

async function deactivate(record: PluginRecord): Promise<void> {
  if (!record.active) return
  const { context, module } = record
  try {
    if (context) await module?.deactivate?.(context)
  } catch (error) {
    if (import.meta.env.DEV) console.error(`[Alethe][plugin:${record.manifest.id}]`, error)
  }
  if (context) disposeContext(context)
  record.context = null
  record.module = null
  record.active = false
}

function upsert(
  manifest: PluginManifest,
  source: PluginSource,
  loader: PluginLoader | null,
  enabled: boolean,
) {
  const existing = records.get(manifest.id)
  if (existing) {
    existing.manifest = manifest
    existing.enabled = enabled
    return existing
  }
  const record: PluginRecord = {
    manifest,
    source,
    loader,
    enabled,
    active: false,
    error: null,
    context: null,
    module: null,
  }
  records.set(manifest.id, record)
  return record
}

/**
 * Discovers bundled and locally installed plugins and activates the enabled
 * ones. Safe to call once per app start; later calls are ignored.
 */
export async function initPluginHost(): Promise<void> {
  if (initialized) return
  initialized = true

  let disabled: Set<string>
  try {
    disabled = new Set(await pluginsDisabled())
  } catch (error) {
    if (import.meta.env.DEV) console.error('[Alethe][plugin host]', error)
    disabled = new Set()
  }

  for (const bundled of BUNDLED_PLUGINS) {
    upsert(bundled.manifest, 'bundled', bundled.load, !disabled.has(bundled.manifest.id))
  }

  await scanLocalPlugins()

  refresh()
  await Promise.all([...records.values()].map((record) => activate(record)))
  refresh()
}

/**
 * Re-reads the plugins directory, adopting newly installed plugins and
 * dropping uninstalled ones. Bundled records are never touched.
 */
export async function refreshLocalPlugins(): Promise<void> {
  const removed = await scanLocalPlugins()
  await Promise.all(removed.map((record) => deactivate(record)))
  refresh()
  await Promise.all([...records.values()].map((record) => activate(record)))
  refresh()
}

async function scanLocalPlugins(): Promise<PluginRecord[]> {
  let installed
  try {
    installed = await pluginsList()
  } catch (error) {
    if (import.meta.env.DEV) console.error('[Alethe][plugin host]', error)
    return []
  }

  const seen = new Set<string>()
  for (const plugin of installed) {
    seen.add(plugin.id)
    if (records.get(plugin.id)?.source === 'bundled') continue
    // Local plugins carry no loader yet; script assets arrive with the local
    // plugin transport. Their manifest contributions still apply.
    upsert(plugin, 'local', null, plugin.enabled)
  }

  const removed: PluginRecord[] = []
  for (const [id, record] of records) {
    if (record.source !== 'local' || seen.has(id)) continue
    removed.push(record)
    records.delete(id)
  }
  return removed
}

export async function setPluginEnabled(id: string, enabled: boolean): Promise<void> {
  const record = records.get(id)
  if (!record || record.enabled === enabled) return

  record.enabled = enabled
  refresh()
  try {
    await pluginSetEnabled(id, enabled)
  } catch (error) {
    record.enabled = !enabled
    record.error = error instanceof Error ? error.message : String(error)
    refresh()
    return
  }

  if (enabled) await activate(record)
  else await deactivate(record)
  refresh()
}

/** Test seam: drops every record without touching disk. */
export async function resetPluginHostForTests(): Promise<void> {
  await Promise.all([...records.values()].map((record) => deactivate(record)))
  records.clear()
  initialized = false
  refresh()
}
