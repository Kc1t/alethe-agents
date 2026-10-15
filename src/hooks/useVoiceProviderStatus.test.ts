import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { EMPTY_PROJECTS_FILE } from '../lib/types'
import { useProjectsStore } from '../stores/projectsStore'
import { useVoiceProviderStatus } from './useVoiceProviderStatus'

const tauri = vi.hoisted(() => ({ voiceProvidersStatus: vi.fn() }))
vi.mock('../lib/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/tauri')>()),
  ...tauri,
  saveProjectsFile: vi.fn().mockResolvedValue(undefined),
}))

const prefs = () => useProjectsStore.getState().preferences

describe('useVoiceProviderStatus', () => {
  beforeEach(() => {
    useProjectsStore.setState({ ...structuredClone(EMPTY_PROJECTS_FILE), hydrated: true })
  })

  it('mirrors keychain flags and refreshes on profile switch', async () => {
    tauri.voiceProvidersStatus.mockResolvedValueOnce([{ provider: 'openai', configured: true }])
    const { rerender } = renderHook(({ profile }) => useVoiceProviderStatus(true, profile), {
      initialProps: { profile: 'a' },
    })
    await waitFor(() => expect(prefs().voiceProviders.openai?.configured).toBe(true))

    tauri.voiceProvidersStatus.mockResolvedValueOnce([{ provider: 'openai', configured: false }])
    rerender({ profile: 'b' })
    await waitFor(() => expect(prefs().voiceProviders.openai?.configured).toBe(false))
  })

  it('moves a use off a provider that lost its key', async () => {
    useProjectsStore.getState().setPreferences({
      voiceProviders: { gemini: { configured: true, invalid: false } },
      voiceStt: {
        dictation: { provider: 'gemini', model: 'gemini-2.5-flash', locale: null },
        conversation: { provider: 'local', model: 'parakeet-tdt-0.6b-v3-int8', locale: null },
      },
    })
    tauri.voiceProvidersStatus.mockResolvedValueOnce([{ provider: 'gemini', configured: false }])
    renderHook(() => useVoiceProviderStatus(true, 'a'))
    await waitFor(() => expect(prefs().voiceStt.dictation.provider).toBe('local'))
  })
})
