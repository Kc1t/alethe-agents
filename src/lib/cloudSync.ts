import { pluginSetEnabled, pluginsList } from './tauri'
import type { Preferences } from './types'

export const CLOUD_PAYLOAD_FORMAT = 1

// Free-tier cloud sync covers identity, theme and UI preferences only.
// Keep this an include-list: `Preferences` also holds secrets (Spotify
// credentials) and machine-local state that must never leave the device.
const SYNCED_PREFERENCE_KEYS = [
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
  'topbarShowSync',
  'topbarShowProfile',
  'topbarShowMemory',
  'topbarShowRouter9',
  'enabledFeatures',
  'playwrightBrowserMode',
  'playwrightDedicatedHeadless',
  'mcpDefaultScope',
  'notifyOnLimitReset',
  'dictationEnabled',
  'spawnConcurrency',
  'nodeHeapProfile',
  'leftSidebarVisible',
  'rightSidebarVisible',
  'leftSidebarWidth',
  'rightSidebarWidth',
] as const satisfies readonly (keyof Preferences)[]

export type CloudPayload = {
  format: number
  preferences: Partial<Preferences>
  plugins: { enabled: string[]; disabled: string[] }
}

export async function buildCloudPayload(preferences: Preferences): Promise<CloudPayload> {
  const prefs: Record<string, unknown> = {}
  for (const key of SYNCED_PREFERENCE_KEYS) {
    const value = preferences[key]
    if (value !== undefined) prefs[key] = value
  }
  const plugins = await pluginsList()
  return {
    format: CLOUD_PAYLOAD_FORMAT,
    preferences: prefs as Partial<Preferences>,
    plugins: {
      enabled: plugins.filter((p) => p.enabled).map((p) => p.id),
      disabled: plugins.filter((p) => !p.enabled).map((p) => p.id),
    },
  }
}

export async function applyCloudPayload(
  raw: unknown,
  setPreferences: (patch: Partial<Preferences>) => void,
): Promise<boolean> {
  if (typeof raw !== 'object' || raw === null) return false
  const payload = raw as Partial<CloudPayload>
  if (typeof payload.format !== 'number') return false

  const remotePrefs =
    typeof payload.preferences === 'object' && payload.preferences !== null
      ? (payload.preferences as Record<string, unknown>)
      : {}
  const patch: Record<string, unknown> = {}
  for (const key of SYNCED_PREFERENCE_KEYS) {
    if (remotePrefs[key] !== undefined) patch[key] = remotePrefs[key]
  }
  if (Object.keys(patch).length > 0) setPreferences(patch as Partial<Preferences>)

  const enabled = new Set(Array.isArray(payload.plugins?.enabled) ? payload.plugins.enabled : [])
  const disabled = new Set(Array.isArray(payload.plugins?.disabled) ? payload.plugins.disabled : [])
  if (enabled.size > 0 || disabled.size > 0) {
    const installed = await pluginsList()
    for (const plugin of installed) {
      const shouldEnable = enabled.has(plugin.id) ? true : disabled.has(plugin.id) ? false : null
      if (shouldEnable !== null && shouldEnable !== plugin.enabled) {
        await pluginSetEnabled(plugin.id, shouldEnable)
      }
    }
  }
  return true
}
