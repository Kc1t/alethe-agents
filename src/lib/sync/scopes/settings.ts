import type { Preferences } from '../../types'
import { isRecord, type SettingsPayload, SYNC_FORMAT } from '../contract'
import { checkFormat, type ScopeAdapter } from '../host'
import { mergeFields, sameValue } from '../merge'

// Include-list on purpose: Preferences also holds API keys and machine-local state.
export const SYNCED_PREFERENCE_KEYS = [
  'language',
  'uiTheme',
  'visualStyle',
  'motionPreference',
  'appIconTheme',
  'uiZoom',
  'windowOpacity',
  'terminalTheme',
  'enabledAgents',
  'workspaceFlat',
  'displayName',
  'profileImageUrl',
  'alwaysStartOnHome',
  'alwaysStartUnrestricted',
  'topbarStyle',
  'viewPlacements',
  'discordRichPresenceEnabled',
  'topbarShowClaudeUsage',
  'topbarShowCodexUsage',
  'topbarShowAntigravityUsage',
  'topbarShowKimiUsage',
  'topbarShowSync',
  'topbarShowProfile',
  'topbarShowMemory',
  'topbarShowRouter9',
  'enabledFeatures',
  'playwrightBrowserMode',
  'playwrightDedicatedHeadless',
  'mcpDefaultScope',
  'notifyOnLimitReset',
  'spawnConcurrency',
  'nodeHeapProfile',
  'leftSidebarVisible',
  'rightSidebarVisible',
  'leftSidebarWidth',
  'rightSidebarWidth',
  'customAgents',
  'orchestration',
  'workerRuleSets',
  'orchestratorShortcuts',
] as const satisfies readonly (keyof Preferences)[]

const pickPreferences = (preferences: Preferences | Record<string, unknown>) => {
  const source = preferences as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of SYNCED_PREFERENCE_KEYS) {
    if (source[key] !== undefined) out[key] = source[key]
  }
  return out
}

export const settingsScope: ScopeAdapter<SettingsPayload> = {
  scope: 'settings',

  empty: () => ({ format: SYNC_FORMAT, preferences: {}, plugins: {} }),

  parse(raw) {
    if (!isRecord(raw) || !checkFormat(raw.format, SYNC_FORMAT)) return null
    const plugins: Record<string, boolean> = {}
    if (isRecord(raw.plugins)) {
      for (const [id, enabled] of Object.entries(raw.plugins)) {
        if (typeof enabled === 'boolean') plugins[id] = enabled
      }
    }
    return {
      format: SYNC_FORMAT,
      preferences: isRecord(raw.preferences) ? pickPreferences(raw.preferences) : {},
      plugins,
    }
  },

  async collect(ctx) {
    const plugins: Record<string, boolean> = {}
    for (const plugin of await ctx.host.plugins()) plugins[plugin.id] = plugin.enabled
    return {
      format: SYNC_FORMAT,
      preferences: pickPreferences(ctx.host.preferences()),
      plugins,
    }
  },

  merge(base, local, remote) {
    return {
      format: SYNC_FORMAT,
      preferences: mergeFields(base?.preferences ?? null, local.preferences, remote.preferences, {
        absentIsNoOpinion: true,
      }),
      plugins: mergeFields(base?.plugins ?? null, local.plugins, remote.plugins, {
        absentIsNoOpinion: true,
      }),
    }
  },

  async apply(ctx, merged, local) {
    const patch: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(merged.preferences)) {
      if (!sameValue(value, local.preferences[key])) patch[key] = value
    }
    const preferences = Object.keys(patch).length
    if (preferences > 0) ctx.host.setPreferences(patch as Partial<Preferences>)

    let plugins = 0
    for (const [id, enabled] of Object.entries(merged.plugins)) {
      if (id in local.plugins && local.plugins[id] !== enabled) {
        await ctx.host.setPluginEnabled(id, enabled)
        plugins += 1
      }
    }
    return { changed: preferences + plugins > 0, preferences, plugins }
  },
}
