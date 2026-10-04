import type { Preferences, Project } from './types'

/**
 * The fixed test user of the development build. A profile that has never been set up - a new one,
 * or one that was wiped - starts as this user instead of at onboarding, with the repository open
 * as a project, so restarting the dev app never means setting it up again. A release build never
 * runs this: the check on `import.meta.env.DEV` removes it at build time.
 */
export const DEV_TEST_USER = {
  displayName: 'Dev Tester',
  projectName: 'Alethe',
} as const

type DevSeedState = {
  preferences: Preferences
  projects: Project[]
  createProject: (args: { name: string; defaultCwd?: string }) => Project
}

export function seedDevTestUser(
  get: () => DevSeedState,
  set: (patch: { preferences: Preferences }) => void,
): void {
  // Tests run in a dev-mode build too, and must see the store exactly as they left it.
  if (!import.meta.env.DEV || import.meta.env.MODE === 'test') return
  const state = get()
  // Only a profile nobody has used. Anything the person did in dev is theirs and stays.
  if (state.preferences.onboardingDone || state.projects.length > 0) return
  set({
    preferences: {
      ...state.preferences,
      onboardingDone: true,
      accountCreated: true,
      displayName: DEV_TEST_USER.displayName,
      firstLaunchAt: state.preferences.firstLaunchAt ?? Date.now(),
      mcpOnboardingSeen: true,
      setupWalkthroughHidden: true,
      enabledFeatures: { ...state.preferences.enabledFeatures, orchestrator: true },
    },
  })
  get().createProject({
    name: DEV_TEST_USER.projectName,
    defaultCwd: __ALETHE_DEV_ROOT__ || undefined,
  })
}
