import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { EMPTY_PROJECTS_FILE, type ProjectsFile } from '../lib/types'

const api = vi.hoisted(() => ({
  loadProjectsBootstrap: vi.fn(),
  saveProjectsForProfile: vi.fn(),
}))

vi.mock('../lib/tauri', () => ({
  CORE_IDENTITY_MISMATCH: 'alethe_core_identity_mismatch',
  isTauriEnv: () => true,
  killPty: vi.fn(),
  listenPtyData: vi.fn(async () => () => undefined),
  loadProjectsBootstrap: api.loadProjectsBootstrap,
  saveProjectsForProfile: api.saveProjectsForProfile,
  writeProjectMarker: vi.fn(async () => undefined),
}))

import { useProjectsStore } from './projectsStore'

function documentWithName(displayName: string): ProjectsFile {
  return {
    ...structuredClone(EMPTY_PROJECTS_FILE),
    preferences: {
      ...structuredClone(EMPTY_PROJECTS_FILE.preferences),
      displayName,
    },
  }
}

function bootstrap(profileId: string, displayName?: string) {
  return {
    active_profile_id: profileId,
    profiles: [
      {
        id: profileId,
        name: profileId,
        created_at_ms: 1,
        last_used_at_ms: 1,
      },
    ],
    content: displayName ? JSON.stringify(documentWithName(displayName)) : null,
    revision: displayName ? `revision-${displayName}` : 'missing',
  }
}

beforeEach(() => {
  api.loadProjectsBootstrap.mockReset()
  api.saveProjectsForProfile.mockReset()
  useProjectsStore.setState({
    ...structuredClone(EMPTY_PROJECTS_FILE),
    activeProfileId: 'default',
    profiles: [],
    projectsRevision: 'missing',
    persistenceDirty: false,
    persistenceError: null,
    hydrated: false,
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('projectsStore persistence', () => {
  it('fully clears the previous document when the next profile has no projects file', async () => {
    api.loadProjectsBootstrap
      .mockResolvedValueOnce(bootstrap('profile-a', 'Alice'))
      .mockResolvedValueOnce(bootstrap('profile-b'))

    await useProjectsStore.getState().hydrate()
    expect(useProjectsStore.getState().preferences.displayName).toBe('Alice')

    await useProjectsStore.getState().hydrate()
    const state = useProjectsStore.getState()
    expect(state.activeProfileId).toBe('profile-b')
    expect(state.preferences.displayName).toBe(EMPTY_PROJECTS_FILE.preferences.displayName)
    expect(state.projects).toEqual([])
  })

  it('ignores a stale bootstrap response after a newer hydration completes', async () => {
    let resolveOld: ((value: ReturnType<typeof bootstrap>) => void) | undefined
    api.loadProjectsBootstrap
      .mockImplementationOnce(
        () =>
          new Promise<ReturnType<typeof bootstrap>>((resolve) => {
            resolveOld = resolve
          }),
      )
      .mockResolvedValueOnce(bootstrap('profile-b', 'Bob'))

    const oldHydration = useProjectsStore.getState().hydrate()
    const newHydration = useProjectsStore.getState().hydrate()
    await newHydration
    resolveOld?.(bootstrap('profile-a', 'Alice'))
    await oldHydration

    expect(useProjectsStore.getState().activeProfileId).toBe('profile-b')
    expect(useProjectsStore.getState().preferences.displayName).toBe('Bob')
  })

  it('preserves the last known-good document when a re-hydrate fails after initial success', async () => {
    api.loadProjectsBootstrap
      .mockResolvedValueOnce(bootstrap('profile-a', 'Alice'))
      .mockRejectedValueOnce(new Error('core unavailable'))

    await useProjectsStore.getState().hydrate()
    expect(useProjectsStore.getState().preferences.displayName).toBe('Alice')

    // A sync-event-triggered re-hydrate that fails transiently must never
    // wipe the already-loaded document back to empty.
    await useProjectsStore.getState().hydrate()
    const state = useProjectsStore.getState()
    expect(state.activeProfileId).toBe('profile-a')
    expect(state.preferences.displayName).toBe('Alice')
    expect(state.persistenceError).toBe('write')
  })

  it('never saves against a guessed profile namespace after bootstrap fails', async () => {
    api.loadProjectsBootstrap.mockRejectedValue(new Error('core unavailable'))

    await useProjectsStore.getState().hydrate()
    useProjectsStore.getState().setPreferences({ displayName: 'Temporary edit' })

    expect(useProjectsStore.getState().persistenceError).toBe('write')
    expect(useProjectsStore.getState().persistenceDirty).toBe(false)
    expect(api.saveProjectsForProfile).not.toHaveBeenCalled()
  })

  it('captures the originating profile for an in-flight save', async () => {
    api.loadProjectsBootstrap.mockResolvedValue(bootstrap('profile-a', 'Alice'))
    api.saveProjectsForProfile.mockResolvedValue({
      profile_id: 'profile-a',
      revision: 'revision-saved',
    })

    await useProjectsStore.getState().hydrate()
    useProjectsStore.getState().setPreferences({ displayName: 'Updated' })
    const flush = useProjectsStore.getState().flushPersistence()
    useProjectsStore.setState({ activeProfileId: 'profile-b' })
    await flush

    expect(api.saveProjectsForProfile).toHaveBeenCalledWith(
      'profile-a',
      expect.stringContaining('Updated'),
      'revision-Alice',
      false,
    )
  })

  it('keeps local state dirty when the backend rejects a stale revision', async () => {
    api.loadProjectsBootstrap.mockResolvedValue(bootstrap('profile-conflict', 'Local'))
    api.saveProjectsForProfile.mockRejectedValue(
      new Error('HTTP 409: projects_revision_conflict:backup_created'),
    )

    await useProjectsStore.getState().hydrate()
    useProjectsStore.getState().setPreferences({ displayName: 'Unsaved' })

    await expect(useProjectsStore.getState().flushPersistence()).rejects.toThrow(
      'projects_revision_conflict',
    )
    expect(useProjectsStore.getState().persistenceDirty).toBe(true)
    expect(useProjectsStore.getState().persistenceError).toBe('conflict')
    expect(useProjectsStore.getState().preferences.displayName).toBe('Unsaved')
    await expect(useProjectsStore.getState().flushPersistence()).rejects.toThrow(
      'pending_resolution',
    )
    expect(api.saveProjectsForProfile).toHaveBeenCalledTimes(1)
  })

  it('retries a transient write failure and clears the dirty state after acknowledgement', async () => {
    vi.useFakeTimers()
    api.loadProjectsBootstrap.mockResolvedValue(bootstrap('profile-retry', 'Initial'))
    api.saveProjectsForProfile
      .mockRejectedValueOnce(new Error('connection unavailable'))
      .mockResolvedValueOnce({
        profile_id: 'profile-retry',
        revision: 'revision-retried',
      })

    await useProjectsStore.getState().hydrate()
    useProjectsStore.getState().setPreferences({ displayName: 'Retry me' })
    await expect(useProjectsStore.getState().flushPersistence()).rejects.toThrow(
      'connection unavailable',
    )

    await vi.advanceTimersByTimeAsync(1000)

    expect(api.saveProjectsForProfile).toHaveBeenCalledTimes(2)
    expect(useProjectsStore.getState().persistenceDirty).toBe(false)
    expect(useProjectsStore.getState().persistenceError).toBeNull()
    expect(useProjectsStore.getState().projectsRevision).toBe('revision-retried')
  })

  it('preserves the newest local snapshot when an older in-flight save conflicts', async () => {
    let rejectFirst: ((reason: Error) => void) | undefined
    api.loadProjectsBootstrap.mockResolvedValue(bootstrap('profile-race', 'Initial'))
    api.saveProjectsForProfile
      .mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            rejectFirst = reject
          }),
      )
      .mockRejectedValueOnce(new Error('projects_revision_conflict:backup_created'))

    await useProjectsStore.getState().hydrate()
    useProjectsStore.getState().setPreferences({ displayName: 'First edit' })
    const firstFlush = useProjectsStore.getState().flushPersistence()
    await vi.waitFor(() => expect(rejectFirst).toBeTypeOf('function'))
    useProjectsStore.getState().setPreferences({ displayName: 'Newest edit' })
    rejectFirst?.(new Error('projects_revision_conflict:backup_created'))
    await expect(firstFlush).rejects.toThrow('projects_revision_conflict')
    await vi.waitFor(() => expect(api.saveProjectsForProfile).toHaveBeenCalledTimes(2))

    expect(api.saveProjectsForProfile.mock.calls[1]?.[1]).toContain('Newest edit')
    expect(useProjectsStore.getState().persistenceError).toBe('conflict')
  })
})
