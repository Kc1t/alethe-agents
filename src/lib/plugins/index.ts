import { useSyncExternalStore } from 'react'

import { getPluginEntries, subscribePlugins } from './host'
import type { PluginRuntimeEntry } from './types'

export { PLUGIN_API_VERSION } from './constants'
export {
  activateForView,
  activationEvents,
  ensureActivated,
  getPluginEntries,
  initPluginHost,
  refreshLocalPlugins,
  runCommand,
  setPluginEnabled,
  subscribePlugins,
} from './host'
export { isKnownPluginIcon, pluginIcon } from './icons'
export { commandLabel, sidebarTabLabel, sidebarTabPanelLabel } from './labels'
export {
  applyLegacyPluginMigrations,
  GIT_CONTROL_PLUGIN_ID,
  recordLegacyGitFlag,
  recordLegacyTodosFlag,
  TODOS_PLUGIN_ID,
} from './legacyMigration'
export type { AletheGlobal } from './localTransport'
export { canInvoke, capabilityMatches, grants, isValidCapability } from './permissions'
export {
  commandContributions,
  ContributionList,
  modalContributions,
  paneContributions,
  sidebarTabContributions,
  themeContributions,
  useContributions,
} from './registry'
export type { PluginStorage } from './storage'
export type {
  CommandContribution,
  Disposable,
  ModalContribution,
  PaneContribution,
  PaneProps,
  PluginContext,
  PluginModule,
  PluginRuntimeEntry,
  PluginSource,
  SidebarSide,
  SidebarTabContribution,
  SidebarTabProps,
  ThemeContribution,
} from './types'

export function usePlugins(): readonly PluginRuntimeEntry[] {
  return useSyncExternalStore(subscribePlugins, getPluginEntries, getPluginEntries)
}
