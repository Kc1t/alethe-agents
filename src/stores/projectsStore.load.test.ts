import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const tauri = vi.hoisted(() => ({
  listProfiles: vi.fn(async () => ({ active_profile_id: 'default', profiles: [] })),
  loadProjectsFile: vi.fn(async (): Promise<string | null> => null),
  saveProjectsFile: vi.fn(async () => undefined),
  recordAppEvent: vi.fn(async () => undefined),
  recordFrontendError: vi.fn(async () => undefined),
}))

vi.mock('../lib/tauri', () => tauri)
vi.mock('../lib/terminalLifecycle', () => ({ cleanupPtys: vi.fn() }))

import { EMPTY_PROJECTS_FILE } from '../lib/types'
import { flushProjectsState, useProjectsStore } from './projectsStore'

describe('loading the saved workspace', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  it('never saves over a document it could not read', async () => {
    tauri.loadProjectsFile.mockResolvedValueOnce('{ this is not json')
    await useProjectsStore.getState().hydrate()

    expect(useProjectsStore.getState().loadFailed).toBe(true)
    useProjectsStore.getState().setPreferences({ displayName: 'someone' })
    await vi.advanceTimersByTimeAsync(5_000)
    await flushProjectsState()
    expect(tauri.saveProjectsFile).not.toHaveBeenCalled()
  })

  it('never saves a workspace it had to stand in a setting for', async () => {
    tauri.loadProjectsFile.mockResolvedValueOnce(
      JSON.stringify({
        ...structuredClone(EMPTY_PROJECTS_FILE),
        // A number where the name is trimmed: the settings cannot be read as saved.
        preferences: {
          ...EMPTY_PROJECTS_FILE.preferences,
          displayName: 12,
          onboardingDone: true,
          accountCreated: true,
        },
      }),
    )
    await useProjectsStore.getState().hydrate()

    const state = useProjectsStore.getState()
    expect(state.loadFailed).toBe(true)
    // The person is still who they were, not someone who has to go through onboarding again.
    expect(state.preferences.onboardingDone).toBe(true)
    state.setPreferences({ displayName: 'someone' })
    await vi.advanceTimersByTimeAsync(5_000)
    await flushProjectsState()
    expect(tauri.saveProjectsFile).not.toHaveBeenCalled()
  })

  it('saves again once a later load succeeds', async () => {
    tauri.loadProjectsFile.mockResolvedValueOnce('{ this is not json')
    await useProjectsStore.getState().hydrate()
    tauri.loadProjectsFile.mockResolvedValueOnce(null)
    await useProjectsStore.getState().hydrate()

    expect(useProjectsStore.getState().loadFailed).toBe(false)
    useProjectsStore.getState().setPreferences({ displayName: 'someone' })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(tauri.saveProjectsFile).toHaveBeenCalledTimes(1)
  })
})
