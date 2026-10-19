import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { EMPTY_PROJECTS_FILE } from '../../../../lib/types'
import { useProjectsStore } from '../../../../stores/projectsStore'
import { ProviderGrid } from './ProviderGrid'

const tauri = vi.hoisted(() => ({
  speechListModels: vi.fn(),
  speechModelStates: vi.fn(),
  voiceServersList: vi.fn().mockResolvedValue([]),
  onSpeechDownloadProgress: vi.fn().mockResolvedValue(() => undefined),
}))
vi.mock('../../../../lib/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../lib/tauri')>()),
  ...tauri,
  saveProjectsFile: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../../../lib/i18n', () => ({ useT: () => (key: string) => key }))

afterEach(cleanup)

describe('ProviderGrid', () => {
  beforeEach(() => {
    useProjectsStore.setState({ ...structuredClone(EMPTY_PROJECTS_FILE), hydrated: true })
    tauri.speechListModels.mockResolvedValue([
      { id: 'parakeet-tdt-0.6b-v3-int8', kind: 'download', capability: 'stt' },
    ])
    tauri.speechModelStates.mockResolvedValue([
      { id: 'parakeet-tdt-0.6b-v3-int8', status: 'ready' },
    ])
    useProjectsStore.getState().setPreferences({
      voiceProviders: {
        openai: { configured: true, invalid: false },
        gemini: { configured: true, invalid: true },
      },
    })
  })

  it('shows connection status per provider', async () => {
    render(<ProviderGrid onOpen={() => undefined} onOpenServer={() => undefined} />)
    const openai = await screen.findByRole('article', { name: 'voice.provider.openai' })
    expect(openai.textContent).toContain('prefs.voiceStatusConnected')
    const gemini = screen.getByRole('article', { name: 'voice.provider.gemini' })
    expect(gemini.textContent).toContain('prefs.voiceStatusInvalid')
    const eleven = screen.getByRole('article', { name: 'voice.provider.elevenlabs' })
    expect(eleven.textContent).toContain('prefs.voiceStatusDisconnected')
    await waitFor(() =>
      expect(screen.getByRole('article', { name: 'voice.provider.local' }).textContent).toContain(
        'prefs.voiceStatusConnected',
      ),
    )
  })

  it('is titled Accounts and models', () => {
    render(<ProviderGrid onOpen={() => undefined} onOpenServer={() => undefined} />)
    expect(screen.getByRole('heading', { name: 'prefs.voiceAccountsTitle' })).toBeTruthy()
    expect(screen.getByText('prefs.voiceAccountsDesc')).toBeTruthy()
  })

  it('filters by group and opens a provider', async () => {
    const onOpen = vi.fn()
    render(<ProviderGrid onOpen={onOpen} onOpenServer={() => undefined} />)
    fireEvent.click(screen.getByRole('radio', { name: 'prefs.voiceFilterCloud' }))
    expect(screen.queryByRole('article', { name: 'voice.provider.local' })).toBeNull()
    fireEvent.click(
      screen.getByRole('button', { name: 'prefs.voiceActionSetUpKey voice.provider.elevenlabs' }),
    )
    expect(onOpen).toHaveBeenCalledWith('elevenlabs')
  })

  it('offers to try again when the local models cannot be read', async () => {
    tauri.speechModelStates.mockRejectedValueOnce('speech states failed')
    render(<ProviderGrid onOpen={() => undefined} onOpenServer={() => undefined} />)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('prefs.voiceLoadFailed')
    fireEvent.click(screen.getByRole('button', { name: 'prefs.voiceRetry' }))
    await waitFor(() =>
      expect(screen.getByRole('article', { name: 'voice.provider.local' }).textContent).toContain(
        'prefs.voiceStatusConnected',
      ),
    )
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
