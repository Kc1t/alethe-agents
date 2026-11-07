import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { EMPTY_PROJECTS_FILE } from '../../../../lib/types'
import { useProjectsStore } from '../../../../stores/projectsStore'
import { useVoiceCatalog } from './useVoiceCatalog'

const tauri = vi.hoisted(() => ({ voiceProviderCatalog: vi.fn(), voiceOpenrouterModels: vi.fn() }))
vi.mock('../../../../lib/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../lib/tauri')>()),
  ...tauri,
}))

const curated = [
  {
    provider: 'openrouter',
    keyUrl: 'https://x',
    models: [
      { id: 'c', label: 'C', capability: 'stt' },
      { id: 'google/curated-tts', label: 'T', capability: 'tts' },
    ],
    voices: [],
  },
  { provider: 'openai', keyUrl: 'https://y', models: [], voices: [] },
]

beforeEach(() => {
  tauri.voiceProviderCatalog.mockReset().mockResolvedValue(curated)
  tauri.voiceOpenrouterModels.mockReset()
  useProjectsStore.setState({ ...structuredClone(EMPTY_PROJECTS_FILE), hydrated: true })
})
afterEach(() => vi.clearAllMocks())

describe('useVoiceCatalog', () => {
  it('does not fetch catalogs before a cloud provider is opened', () => {
    renderHook(() => useVoiceCatalog(false))
    expect(tauri.voiceProviderCatalog).not.toHaveBeenCalled()
    expect(tauri.voiceOpenrouterModels).not.toHaveBeenCalled()
  })

  it('does not fetch OpenRouter models while another provider is open', async () => {
    const { result } = renderHook(() => useVoiceCatalog(true, false))
    await waitFor(() => expect(result.current.catalog).toEqual(curated))
    expect(tauri.voiceOpenrouterModels).not.toHaveBeenCalled()
  })
  it('lists the live OpenRouter models without a key', async () => {
    tauri.voiceOpenrouterModels.mockImplementation(async (kind: string) => [
      {
        id: `live-${kind}`,
        label: kind,
        capability: kind,
        voices: kind === 'tts' ? ['af_bella'] : [],
      },
    ])
    const { result } = renderHook(() => useVoiceCatalog())
    await waitFor(() =>
      expect(
        result.current.catalog.find((e) => e.provider === 'openrouter')?.models.map((m) => m.id),
      ).toEqual(['live-stt', 'live-tts']),
    )
    expect(
      result.current.catalog.find((e) => e.provider === 'openrouter')?.models[1].voices,
    ).toEqual(['af_bella'])
  })

  it('swaps in the live OpenRouter list when a key exists', async () => {
    useProjectsStore.setState((s) => ({
      preferences: { ...s.preferences, voiceProviders: { openrouter: { configured: true } } },
    }))
    tauri.voiceOpenrouterModels.mockImplementation(async (kind: string) => [
      { id: `live-${kind}`, label: kind, capability: kind },
    ])
    const { result } = renderHook(() => useVoiceCatalog())
    await waitFor(() =>
      expect(result.current.catalog.find((e) => e.provider === 'openrouter')?.models).toHaveLength(
        2,
      ),
    )
  })
  it('swaps each kind in only when its live list is not empty', async () => {
    useProjectsStore.setState((s) => ({
      preferences: { ...s.preferences, voiceProviders: { openrouter: { configured: true } } },
    }))
    tauri.voiceOpenrouterModels.mockImplementation(async (kind: string) =>
      kind === 'stt' ? [{ id: 'live-stt', label: 'L', capability: 'stt' }] : [],
    )
    const { result } = renderHook(() => useVoiceCatalog())
    await waitFor(() =>
      expect(
        result.current.catalog.find((e) => e.provider === 'openrouter')?.models.map((m) => m.id),
      ).toEqual(['live-stt', 'google/curated-tts']),
    )
  })

  it('keeps the curated list when the live request fails', async () => {
    useProjectsStore.setState((s) => ({
      preferences: { ...s.preferences, voiceProviders: { openrouter: { configured: true } } },
    }))
    tauri.voiceOpenrouterModels.mockRejectedValue(new Error('down'))
    const { result } = renderHook(() => useVoiceCatalog())
    await waitFor(() => expect(tauri.voiceOpenrouterModels).toHaveBeenCalled())
    expect(result.current.catalog.find((e) => e.provider === 'openrouter')?.models[0].id).toBe('c')
  })
})
