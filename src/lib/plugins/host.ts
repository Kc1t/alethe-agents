import type { ComponentType } from 'react'

import { BUNDLED_PLUGINS } from '../../plugins'
import { agentProviderContributions } from '../agentProviders'
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
import { PLUGIN_API_VERSION } from './constants'
import { pluginIcon } from './icons'
import { loadLocalPlugin } from './localTransport'
import { canInvoke, grants, isValidCapability } from './permissions'
import {
  commandContributions,
  modalContributions,
  paneContributions,
  sidebarTabContributions,
  themeContributions,
} from './registry'
import { createPluginStorage } from './storage'
import type {
  Disposable,
  PluginContext,
  PluginModule,
  PluginRuntimeEntry,
  PluginSource,
  SidebarTabProps,
} from './types'

const STARTUP_EVENT = 'onStartupFinished'
const VIEW_EVENT = 'onView:'
const COMMAND_EVENT = 'onCommand:'

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
  /** Manifest-declared contributions, registered without loading any code. */
  declarations: Disposable[]
  activating: Promise<void> | null
}

const records = new Map<string, PluginRecord>()
const viewImplementations = new Map<string, ComponentType<SidebarTabProps>>()
const commandImplementations = new Map<string, () => void | Promise<void>>()
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

export function activationEvents(manifest: PluginManifest): string[] {
  const declared = manifest.activation ?? []
  return declared.length > 0 ? declared : [STARTUP_EVENT]
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
    storage: createPluginStorage(manifest.id),
    contributes: {
      theme: (definition) => {
        require('ui.theme')
        return track(themeContributions.add(manifest.id, definition))
      },
      pane: (definition) => {
        require('ui.pane')
        return track(paneContributions.add(manifest.id, definition))
      },
      modal: (definition) => {
        require('ui.modal')
        return track(modalContributions.add(manifest.id, definition))
      },
      agentProvider: (definition) => {
        require('agent.provider')
        return track(agentProviderContributions.add(manifest.id, definition))
      },
    },
    registerView: (viewId, component) => {
      const declared = sidebarTabContributions.get(viewId)
      if (!declared || declared.pluginId !== manifest.id) {
        throw new Error(`undeclared_view:${manifest.id}:${viewId}`)
      }
      viewImplementations.set(viewId, component)
      sidebarTabContributions.update(manifest.id, viewId, { ...declared, component })
      return track({
        dispose: () => {
          viewImplementations.delete(viewId)
          const current = sidebarTabContributions.get(viewId)
          if (current) {
            sidebarTabContributions.update(manifest.id, viewId, { ...current, component: null })
          }
        },
      })
    },
    registerCommand: (commandId, run) => {
      const declared = commandContributions.get(commandId)
      if (!declared || declared.pluginId !== manifest.id) {
        throw new Error(`undeclared_command:${manifest.id}:${commandId}`)
      }
      commandImplementations.set(commandId, run)
      return track({ dispose: () => commandImplementations.delete(commandId) })
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

  const views = manifest.contributes?.views ?? []
  const commands = manifest.contributes?.commands ?? []
  if (views.length > 0 && !grants(manifest.capabilities, 'ui.sidebarTab')) {
    return `capability_denied:${manifest.id}:ui.sidebarTab`
  }
  if (commands.length > 0 && !grants(manifest.capabilities, 'ui.command')) {
    return `capability_denied:${manifest.id}:ui.command`
  }

  const viewIds = new Set(views.map((view) => view.id))
  const commandIds = new Set(commands.map((command) => command.id))
  for (const event of activationEvents(manifest)) {
    if (event === STARTUP_EVENT) continue
    if (event.startsWith(VIEW_EVENT)) {
      if (!viewIds.has(event.slice(VIEW_EVENT.length))) return `unknown_activation_target:${event}`
      continue
    }
    if (event.startsWith(COMMAND_EVENT)) {
      if (!commandIds.has(event.slice(COMMAND_EVENT.length))) {
        return `unknown_activation_target:${event}`
      }
      continue
    }
    return `unknown_activation_event:${event}`
  }
  return null
}

/**
 * Registers what the manifest announces, without loading the plugin. This is
 * what lets a sidebar tab exist before its code does.
 */
function declareContributions(record: PluginRecord) {
  const { manifest } = record
  for (const view of manifest.contributes?.views ?? []) {
    record.declarations.push(
      sidebarTabContributions.add(manifest.id, {
        id: view.id,
        pluginId: manifest.id,
        side: view.container === 'rightSidebar' ? 'right' : 'left',
        icon: pluginIcon(view.icon),
        label: view.title,
        labelKey: view.titleKey ?? undefined,
        panelLabelKey: view.panelTitleKey ?? undefined,
        order: view.order ?? undefined,
        component: viewImplementations.get(view.id) ?? null,
      }),
    )
  }
  for (const command of manifest.contributes?.commands ?? []) {
    record.declarations.push(
      commandContributions.add(manifest.id, {
        id: command.id,
        pluginId: manifest.id,
        label: command.title,
        labelKey: command.titleKey ?? undefined,
        icon: command.icon ? pluginIcon(command.icon) : undefined,
        keywords: command.keywords ?? undefined,
        run: () => runCommand(command.id),
      }),
    )
  }
}

function undeclareContributions(record: PluginRecord) {
  for (let i = record.declarations.length - 1; i >= 0; i -= 1) {
    record.declarations[i].dispose()
  }
  record.declarations.length = 0
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

/** Loads and activates a plugin on demand, coalescing concurrent callers. */
export async function ensureActivated(pluginId: string): Promise<void> {
  const record = records.get(pluginId)
  if (!record || !record.enabled || record.active) return
  if (record.activating) return record.activating

  record.activating = activate(record).finally(() => {
    record.activating = null
  })
  await record.activating
  refresh()
}

/** Activates whichever plugin owns a declared view. */
export async function activateForView(viewId: string): Promise<void> {
  const pluginId = sidebarTabContributions.ownerOf(viewId)
  if (pluginId) await ensureActivated(pluginId)
}

export async function runCommand(commandId: string): Promise<void> {
  const pluginId = commandContributions.ownerOf(commandId)
  if (!pluginId) return
  await ensureActivated(pluginId)
  await commandImplementations.get(commandId)?.()
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
    declarations: [],
    activating: null,
  }
  records.set(manifest.id, record)
  return record
}

function declareIfValid(record: PluginRecord) {
  if (!record.enabled || record.declarations.length > 0) return
  const problem = validateManifest(record.manifest)
  if (problem) {
    record.error = problem
    return
  }
  record.error = null
  declareContributions(record)
}

/**
 * Discovers bundled and locally installed plugins, registers what their
 * manifests declare, and activates only those asking for it at startup.
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

  for (const record of records.values()) declareIfValid(record)
  refresh()

  await Promise.all(
    [...records.values()]
      .filter((record) => activationEvents(record.manifest).includes(STARTUP_EVENT))
      .map((record) => ensureActivated(record.manifest.id)),
  )
  refresh()
}

/**
 * Re-reads the plugins directory, adopting newly installed plugins and
 * dropping uninstalled ones. Bundled records are never touched.
 */
export async function refreshLocalPlugins(): Promise<void> {
  const removed = await scanLocalPlugins()
  for (const record of removed) {
    await deactivate(record)
    undeclareContributions(record)
  }
  for (const record of records.values()) declareIfValid(record)
  refresh()

  await Promise.all(
    [...records.values()]
      .filter((record) => activationEvents(record.manifest).includes(STARTUP_EVENT))
      .map((record) => ensureActivated(record.manifest.id)),
  )
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
    // A local plugin without an `entry` is manifest-only: its declarations
    // still apply, there is simply no code to run.
    const loader = plugin.entry ? () => loadLocalPlugin(plugin) : null
    upsert(plugin, 'local', loader, plugin.enabled)
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

  if (enabled) {
    declareIfValid(record)
    refresh()
    if (activationEvents(record.manifest).includes(STARTUP_EVENT)) {
      await ensureActivated(id)
    }
  } else {
    await deactivate(record)
    undeclareContributions(record)
  }
  refresh()
}

/** Test seam: drops every record without touching disk. */
export async function resetPluginHostForTests(): Promise<void> {
  for (const record of records.values()) {
    await deactivate(record)
    undeclareContributions(record)
  }
  records.clear()
  viewImplementations.clear()
  commandImplementations.clear()
  initialized = false
  refresh()
}
