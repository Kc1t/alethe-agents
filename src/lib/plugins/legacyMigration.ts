import { setPluginEnabled } from './host'

export const GIT_CONTROL_PLUGIN_ID = 'alethe.git-control'

let pendingGitFlag: boolean | undefined

/**
 * Records the pre-plugin `enabledFeatures.git` value seen while loading a
 * profile. Called during preference normalization, which runs before the
 * plugin host knows anything about this profile.
 */
export function recordLegacyGitFlag(value: boolean | undefined): void {
  if (value === undefined) return
  pendingGitFlag = value
}

/**
 * Carries the old Git feature toggle over to the plugin's enabled state, once
 * per profile load. Safe to call whenever hydration finishes.
 */
export async function applyLegacyPluginMigrations(): Promise<void> {
  const flag = pendingGitFlag
  pendingGitFlag = undefined
  if (flag === false) await setPluginEnabled(GIT_CONTROL_PLUGIN_ID, false)
}
