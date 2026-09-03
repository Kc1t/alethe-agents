import type { ComponentType, ReactNode } from 'react'

import type { Locale } from '../i18n'
import type { PluginManifest } from '../tauri'
import type { Terminal } from '../types'

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
  side: SidebarSide
  /** Any icon component taking a `size` prop — lucide icons fit directly. */
  icon: ComponentType<{ size?: number | string }>
  /** Fallback label. `labelKey` wins when its message resolves. */
  label: string
  labelKey?: string
  /** Header shown above the panel. Defaults to the tab label. */
  panelLabelKey?: string
  order?: number
  component: ComponentType<SidebarTabProps>
}

export type CommandContribution = {
  id: string
  /** Fallback label. `labelKey` wins when its message resolves. */
  label: string
  labelKey?: string
  icon?: ComponentType<{ size?: number | string }>
  /** Extra words the command palette matches on, beyond the label. */
  keywords?: string
  run: () => void | Promise<void>
}

export type PluginContributions = {
  theme: (definition: ThemeContribution) => Disposable
  pane: (definition: PaneContribution) => Disposable
  sidebarTab: (definition: SidebarTabContribution) => Disposable
  command: (definition: CommandContribution) => Disposable
}

export type PluginContext = {
  readonly id: string
  readonly manifest: PluginManifest
  /** Disposed on deactivate. Push anything the plugin must undo. */
  readonly subscriptions: Disposable[]
  readonly contributes: PluginContributions
  /** Registers messages under `plugin.<id>.` — the prefix is added for you. */
  registerMessages: (locale: Locale, messages: Record<string, string>) => Disposable
  /** Translates one of this plugin's own keys, without the prefix. */
  t: (key: string, params?: Record<string, string | number>) => string
  /** Rejects any command the manifest does not declare a capability for. */
  invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T>
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
