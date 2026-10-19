import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { EMPTY_PROJECTS_FILE } from '../lib/types'
import { useProjectsStore } from '../stores/projectsStore'
import { useSpeechEngineDefault } from './useSpeechEngineDefault'

const PARAKEET = 'parakeet-tdt-0.6b-v3-int8'

const tauri = vi.hoisted(() => ({
  speechListModels: vi.fn(),
  speechModelStates: vi.fn(),
}))
vi.mock('../lib/tauri', () => ({
  APPLE_SPEECH_MODEL_ID: 'apple-speech',
  speechListModels: tauri.speechListModels,
  speechModelStates: tauri.speechModelStates,
}))

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
const prefs = () => useProjectsStore.getState().preferences

function setup(options: {
  native: boolean
  parakeet: 'ready' | 'not-downloaded'
  migrated?: boolean
}) {
  useProjectsStore.setState({ ...structuredClone(EMPTY_PROJECTS_FILE), hydrated: false })
  useProjectsStore.getState().setPreferences({
    voiceStt: {
      dictation: { provider: 'local', model: PARAKEET, locale: null },
      conversation: { provider: 'local', model: PARAKEET, locale: null },
    },
    speechEngineMigrated: options.migrated ?? false,
  })
  tauri.speechListModels.mockResolvedValue(
    options.native ? [{ id: 'apple-speech' }, { id: PARAKEET }] : [{ id: PARAKEET }],
  )
  tauri.speechModelStates.mockResolvedValue([{ id: PARAKEET, status: options.parakeet }])
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useSpeechEngineDefault', () => {
  it('moves an untouched default to the Apple engine once', async () => {
    setup({ native: true, parakeet: 'not-downloaded' })
    renderHook(() => useSpeechEngineDefault(true, 'p'))
    await waitFor(() => expect(prefs().speechEngineMigrated).toBe(true))
    expect(prefs().voiceStt.dictation.model).toBe('apple-speech')
  })

  it('keeps Parakeet when it is already downloaded', async () => {
    setup({ native: true, parakeet: 'ready' })
    renderHook(() => useSpeechEngineDefault(true, 'p'))
    await waitFor(() => expect(prefs().speechEngineMigrated).toBe(true))
    expect(prefs().voiceStt.dictation.model).toBe(PARAKEET)
  })

  it('does nothing once migrated', async () => {
    setup({ native: true, parakeet: 'not-downloaded', migrated: true })
    renderHook(() => useSpeechEngineDefault(true, 'p'))
    await settle()
    expect(tauri.speechListModels).not.toHaveBeenCalled()
    expect(tauri.speechModelStates).not.toHaveBeenCalled()
    expect(prefs().voiceStt.dictation.model).toBe(PARAKEET)
  })

  it('keeps the model when the catalog has no native engine', async () => {
    setup({ native: false, parakeet: 'not-downloaded' })
    renderHook(() => useSpeechEngineDefault(true, 'p'))
    await waitFor(() => expect(prefs().speechEngineMigrated).toBe(true))
    expect(prefs().voiceStt.dictation.model).toBe(PARAKEET)
  })

  it('leaves preferences untouched when a call rejects', async () => {
    setup({ native: true, parakeet: 'not-downloaded' })
    tauri.speechModelStates.mockRejectedValue(new Error('boom'))
    renderHook(() => useSpeechEngineDefault(true, 'p'))
    await waitFor(() => expect(tauri.speechModelStates).toHaveBeenCalled())
    await settle()
    expect(prefs().speechEngineMigrated).toBe(false)
    expect(prefs().voiceStt.dictation.model).toBe(PARAKEET)
  })

  it('waits for the store to hydrate before deciding', async () => {
    setup({ native: true, parakeet: 'not-downloaded' })
    const { rerender } = renderHook(({ hydrated }) => useSpeechEngineDefault(hydrated, 'p'), {
      initialProps: { hydrated: false },
    })
    await settle()
    expect(tauri.speechListModels).not.toHaveBeenCalled()
    expect(prefs().speechEngineMigrated).toBe(false)
    rerender({ hydrated: true })
    await waitFor(() => expect(prefs().speechEngineMigrated).toBe(true))
    expect(prefs().voiceStt.dictation.model).toBe('apple-speech')
  })
})
