import type { ComponentType, ReactNode } from 'react'

import type { AgentProviderContribution } from '../agentProviders'
import type { Locale } from '../i18n'
import type { PluginManifest } from '../tauri'
import type { Terminal } from '../types'
import type { PluginStorage } from './storage'

export type Disposable = { dispose: () => void }

export type ThemeContribution = {
  id: string
  /** Fallback label. A `theme.<id>.label` message, when registered, wins. */
  label: string
  description?: string
  /** Background, accent and foreground, in that order — the picker swatch. */
  swatch: [string, string, string]
  /** Overrides the luminance guess made from the swatch background. */
  light?: boolean
  /** CSS custom properties. Names must carry the leading `--`. */
  tokens: Record<string, string>
  /** xterm palette merged over the built-in fallback for this theme's mode. */
  terminal?: Record<string, string>
}

export type PaneProps = {
  projectId: string
  terminal: Terminal
  paneDragEnabled?: boolean
}

export type PaneContribution = {
  /** Matches `Terminal.kind`. */
  id: string
  component: ComponentType<PaneProps>
  /** Shown while a lazily loaded component resolves. */
  fallback?: ReactNode
}

/**
 * A modal a plugin owns. The shell renders it when `openModal` matches the id,
 * so a plugin does not have to reach into the UI store to mount itself.
 */
export type ModalContribution = {
  id: string
  component: ComponentType
}

export type SidebarSide = 'left' | 'right'

/**
 * What a sidebar tab is given about the surface it renders next to. Every field
 * is null when the workspace has no usable terminal yet; the tab renders its own
 * empty state in that case.
 */
export type SidebarTabProps = {
  projectId: string | null
  cwd: string | null
  ptyId: string | null
  terminalName: string | null
}

export type SidebarTabContribution = {
  id: string
  pluginId: string
  /** Container the manifest declares. A user placement override can move it. */
  side: SidebarSide
  /** Any icon component taking a `size` prop — lucide icons fit directly. */
  icon: ComponentType<{ size?: number | string }>
  /** Fallback label. `labelKey` wins when its message resolves. */
  label: string
  labelKey?: string
  /** Header shown above the panel. Defaults to the tab label. */
  panelLabelKey?: string
  order?: number
  /** Null until the owning plugin activates and supplies the implementation. */
  component: ComponentType<SidebarTabProps> | null
}

export type CommandContribution = {
  id: string
  pluginId: string
  /** Fallback label. `labelKey` wins when its message resolves. */
  label: string
  labelKey?: string
  icon?: ComponentType<{ size?: number | string }>
  /** Extra words the command palette matches on, beyond the label. */
  keywords?: string
  /** Activates the owning plugin, then runs its handler. */
  run: () => Promise<void>
}

/**
 * Contributions a plugin registers imperatively. Views and commands are not
 * here: those are announced in the manifest so the shell can draw them before
 * the plugin's code loads, and only their implementation is registered.
 */
export type PluginContributions = {
  theme: (definition: ThemeContribution) => Disposable
  pane: (definition: PaneContribution) => Disposable
  modal: (definition: ModalContribution) => Disposable
  agentProvider: (definition: AgentProviderContribution) => Disposable
}

export type PluginContext = {
  readonly id: string
  readonly manifest: PluginManifest
  /** Disposed on deactivate. Push anything the plugin must undo. */
  readonly subscriptions: Disposable[]
  readonly contributes: PluginContributions
  /** Supplies the component for a view this plugin's manifest declares. */
  registerView: (viewId: string, component: ComponentType<SidebarTabProps>) => Disposable
  /** Supplies the handler for a command this plugin's manifest declares. */
  registerCommand: (commandId: string, run: () => void | Promise<void>) => Disposable
  /** Registers messages under `plugin.<id>.` — the prefix is added for you. */
  registerMessages: (locale: Locale, messages: Record<string, string>) => Disposable
  /** Translates one of this plugin's own keys, without the prefix. */
  t: (key: string, params?: Record<string, string | number>) => string
  /** Rejects any command the manifest does not declare a capability for. */
  invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T>
  /** The plugin's own persisted record, kept outside its served directory. */
  readonly storage: PluginStorage
}

export type PluginModule = {
  activate?: (context: PluginContext) => void | Promise<void>
  deactivate?: (context: PluginContext) => void | Promise<void>
}

export type PluginSource = 'bundled' | 'local'

export type PluginRuntimeEntry = {
  manifest: PluginManifest
  source: PluginSource
  enabled: boolean
  active: boolean
  error: string | null
}
