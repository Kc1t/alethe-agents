import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { EMPTY_PROJECTS_FILE } from '../lib/types'
import { useProjectsStore } from '../stores/projectsStore'
import { useUiStore } from '../stores/uiStore'
import { useVoiceFallbackToasts } from './useVoiceFallbackToasts'

const captured = vi.hoisted(() => ({ handler: null as null | ((event: unknown) => void) }))
vi.mock('../lib/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/tauri')>()),
  onVoiceFallback: vi.fn(async (handler: (event: unknown) => void) => {
    captured.handler = handler
    return () => undefined
  }),
  saveProjectsFile: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../lib/i18n', () => ({
  useT: () => (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
}))

describe('useVoiceFallbackToasts', () => {
  beforeEach(() => {
    useProjectsStore.setState({ ...structuredClone(EMPTY_PROJECTS_FILE), hydrated: true })
    useProjectsStore
      .getState()
      .setPreferences({ voiceProviders: { openai: { configured: true, invalid: false } } })
  })

  it('toasts the reason and marks a rejected key invalid', async () => {
    const pushToast = vi.spyOn(useUiStore.getState(), 'pushToast')
    renderHook(() => useVoiceFallbackToasts())
    await vi.waitFor(() => expect(captured.handler).not.toBeNull())
    captured.handler!({
      usage: 'dictation',
      provider: 'openai',
      reason: 'auth',
      fallback: 'apple-speech',
    })
    expect(pushToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: expect.stringContaining('voice.fallback.title') }),
    )
    expect(useProjectsStore.getState().preferences.voiceProviders.openai?.invalid).toBe(true)
  })

  // Rust reports a missing key as auth too; that provider has no key to flag.
  it('does not mark a provider without a key as configured', async () => {
    renderHook(() => useVoiceFallbackToasts())
    await vi.waitFor(() => expect(captured.handler).not.toBeNull())
    captured.handler!({
      usage: 'dictation',
      provider: 'gemini',
      reason: 'auth',
      fallback: 'apple-speech',
    })
    const gemini = useProjectsStore.getState().preferences.voiceProviders.gemini
    expect(gemini?.configured ?? false).toBe(false)
    expect(gemini?.invalid ?? false).toBe(false)
  })
})
