import { projectFingerprint } from '../projectSync'
import type { Preferences, Project } from '../types'
import { stableStringify } from './merge'
import { SYNCED_PREFERENCE_KEYS } from './scopes/settings'

export function syncedFingerprint(preferences: Preferences, projects: Project[]): string {
  const prefs: Record<string, unknown> = {}
  for (const key of SYNCED_PREFERENCE_KEYS) prefs[key] = preferences[key]
  return stableStringify([
    prefs,
    preferences.toolingManifest ?? null,
    projects.filter((p) => p.mode !== 'agentSandbox').map(projectFingerprint),
  ])
}
