import { useMemo, useSyncExternalStore } from 'react'

import { getPluginEntries, subscribePlugins } from './host'
import { sidebarTabContributions, useContributions } from './registry'
import type { PluginRuntimeEntry, SidebarSide, SidebarTabContribution } from './types'

export {
  getPluginEntries,
  initPluginHost,
  PLUGIN_API_VERSION,
  refreshLocalPlugins,
  setPluginEnabled,
  subscribePlugins,
} from './host'
export { commandLabel, sidebarTabLabel, sidebarTabPanelLabel } from './labels'
export {
  applyLegacyPluginMigrations,
  GIT_CONTROL_PLUGIN_ID,
  recordLegacyGitFlag,
} from './legacyMigration'
export { canInvoke, capabilityMatches, grants, isValidCapability } from './permissions'
export {
  commandContributions,
  ContributionList,
  paneContributions,
  sidebarTabContributions,
  themeContributions,
  useContributions,
} from './registry'
export type {
  CommandContribution,
  Disposable,
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

/** Tabs contributed to one sidebar, in display order. */
export function useSidebarTabs(side: SidebarSide): readonly SidebarTabContribution[] {
  const all = useContributions(sidebarTabContributions)
  return useMemo(
    () => all.filter((tab) => tab.side === side).sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
    [all, side],
  )
}
