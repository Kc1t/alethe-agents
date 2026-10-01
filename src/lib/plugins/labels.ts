import type { MessageKey, TFunction } from '../i18n'
import type { CommandContribution, SidebarTabContribution } from './types'

function resolve(t: TFunction, key: string | undefined, fallback: string): string {
  if (!key) return fallback
  const message = t(key as MessageKey)
  return message === key ? fallback : message
}

export function sidebarTabLabel(t: TFunction, tab: SidebarTabContribution): string {
  return resolve(t, tab.labelKey, tab.label)
}

/** Header above the panel. Falls back to the tab label. */
export function sidebarTabPanelLabel(t: TFunction, tab: SidebarTabContribution): string {
  return resolve(t, tab.panelLabelKey, sidebarTabLabel(t, tab))
}

export function commandLabel(t: TFunction, command: CommandContribution): string {
  return resolve(t, command.labelKey, command.label)
}
