import { setPluginEnabled } from './host'

export const GIT_CONTROL_PLUGIN_ID = 'alethe.git-control'
export const TODOS_PLUGIN_ID = 'alethe.todos'

let pendingGitFlag: boolean | undefined
let pendingTodosFlag: boolean | undefined

/**
 * Records the pre-plugin `enabledFeatures.git` value seen while loading a
 * profile. Called during preference normalization, which runs before the
 * plugin host knows anything about this profile.
 */
export function recordLegacyGitFlag(value: boolean | undefined): void {
  if (value === undefined) return
  pendingGitFlag = value
}

export function recordLegacyTodosFlag(value: boolean | undefined): void {
  if (value === undefined) return
  pendingTodosFlag = value
}

/**
 * Carries the old Git feature toggle over to the plugin's enabled state, once
 * per profile load. Safe to call whenever hydration finishes.
 */
export async function applyLegacyPluginMigrations(): Promise<void> {
  const gitFlag = pendingGitFlag
  const todosFlag = pendingTodosFlag
  pendingGitFlag = undefined
  pendingTodosFlag = undefined
  if (gitFlag === false) await setPluginEnabled(GIT_CONTROL_PLUGIN_ID, false)
  if (todosFlag === false) await setPluginEnabled(TODOS_PLUGIN_ID, false)
}
