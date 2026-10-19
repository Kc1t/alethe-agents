import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { EMPTY_PROJECTS_FILE } from '../../../../lib/types'
import { useProjectsStore } from '../../../../stores/projectsStore'
import { CloudKeyForm } from './CloudKeyForm'

const tauri = vi.hoisted(() => ({
  voiceProviderSetKey: vi.fn().mockResolvedValue(undefined),
  voiceProviderDeleteKey: vi.fn().mockResolvedValue(undefined),
  voiceProviderTest: vi.fn(),
  openInBrowser: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../../../lib/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../lib/tauri')>()),
  ...tauri,
  saveProjectsFile: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../../../lib/i18n', () => ({
  useT: () => (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
}))

const prefs = () => useProjectsStore.getState().preferences

afterEach(cleanup)

describe('CloudKeyForm', () => {
  beforeEach(() =>
    useProjectsStore.setState({ ...structuredClone(EMPTY_PROJECTS_FILE), hydrated: true }),
  )

  it('saves, tests and marks the provider connected without keeping the key', async () => {
    tauri.voiceProviderTest.mockResolvedValue({ ok: true, reason: null })
    render(<CloudKeyForm provider="openai" keyUrl="https://platform.openai.com/api-keys" />)
    fireEvent.change(screen.getByLabelText('prefs.voiceKeyLabel'), { target: { value: ' sk-1 ' } })
    fireEvent.click(screen.getByRole('button', { name: 'prefs.voiceKeySave' }))
    await waitFor(() =>
      expect(prefs().voiceProviders.openai).toEqual({ configured: true, invalid: false }),
    )
    expect(tauri.voiceProviderSetKey).toHaveBeenCalledWith('openai', 'sk-1')
    expect((screen.getByLabelText('prefs.voiceKeyLabel') as HTMLInputElement).value).toBe('')
    expect(JSON.stringify(prefs())).not.toContain('sk-1')
  })

  it('marks a rejected key invalid', async () => {
    tauri.voiceProviderTest.mockResolvedValue({ ok: false, reason: 'auth' })
    render(<CloudKeyForm provider="gemini" keyUrl="https://aistudio.google.com/apikey" />)
    fireEvent.change(screen.getByLabelText('prefs.voiceKeyLabel'), { target: { value: 'bad' } })
    fireEvent.click(screen.getByRole('button', { name: 'prefs.voiceKeySave' }))
    await waitFor(() =>
      expect(prefs().voiceProviders.gemini).toEqual({ configured: true, invalid: true }),
    )
    expect(screen.getByRole('status').textContent).toContain('prefs.voiceTestFailed.auth')
  })

  // OpenRouter accepts a provisioning key on its key endpoint, but no model answers it.
  it('says why an OpenRouter provisioning key cannot be used', async () => {
    tauri.voiceProviderTest.mockResolvedValue({
      ok: false,
      reason: 'auth',
      hint: 'provisioningKey',
    })
    render(<CloudKeyForm provider="openrouter" keyUrl="https://openrouter.ai/settings/keys" />)
    fireEvent.change(screen.getByLabelText('prefs.voiceKeyLabel'), {
      target: { value: 'sk-or-v1-x' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'prefs.voiceKeySave' }))
    await waitFor(() =>
      expect(prefs().voiceProviders.openrouter).toEqual({ configured: true, invalid: true }),
    )
    expect(screen.getByRole('status').textContent).toContain('prefs.voiceKeyProvisioning')
  })

  // Only the provider can say a key is bad; an unreachable provider says nothing about it.
  it('keeps an invalid key invalid when the connection test cannot reach the provider', async () => {
    useProjectsStore.getState().setPreferences({
      voiceProviders: { gemini: { configured: true, invalid: true } },
    })
    tauri.voiceProviderTest.mockResolvedValue({ ok: false, reason: 'network' })
    render(<CloudKeyForm provider="gemini" keyUrl="https://aistudio.google.com/apikey" />)
    fireEvent.click(screen.getByRole('button', { name: 'prefs.voiceKeyTest' }))
    await waitFor(() => expect(tauri.voiceProviderTest).toHaveBeenCalled())
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toContain('prefs.voiceTestFailed.network'),
    )
    expect(prefs().voiceProviders.gemini).toEqual({ configured: true, invalid: true })
  })

  it('removing the key moves its uses back to local', async () => {
    useProjectsStore.getState().setPreferences({
      voiceProviders: { openai: { configured: true, invalid: false } },
      voiceTts: { provider: 'openai', model: 'gpt-4o-mini-tts', voice: 'nova', rate: 1 },
    })
    render(<CloudKeyForm provider="openai" keyUrl="https://platform.openai.com/api-keys" />)
    fireEvent.click(screen.getByRole('button', { name: 'prefs.voiceKeyRemove' }))
    await waitFor(() => expect(prefs().voiceTts.provider).toBe('system'))
    expect(prefs().voiceProviders.openai?.configured).toBe(false)
  })

  const typeKey = (value: string) =>
    fireEvent.change(screen.getByLabelText('prefs.voiceKeyLabel'), { target: { value } })

  it('keeps flags and shows feedback when removing the key fails', async () => {
    useProjectsStore.getState().setPreferences({
      voiceProviders: { openai: { configured: true, invalid: false } },
    })
    tauri.voiceProviderDeleteKey.mockRejectedValueOnce(new Error('keychain'))
    render(<CloudKeyForm provider="openai" keyUrl="https://platform.openai.com/api-keys" />)
    fireEvent.click(screen.getByRole('button', { name: 'prefs.voiceKeyRemove' }))
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toContain('prefs.voiceKeyRemoveFailed'),
    )
    expect(prefs().voiceProviders.openai).toEqual({ configured: true, invalid: false })
    expect(
      (screen.getByRole('button', { name: 'prefs.voiceKeyRemove' }) as HTMLButtonElement).disabled,
    ).toBe(false)
  })

  it('keeps the draft when saving the key fails', async () => {
    tauri.voiceProviderSetKey.mockRejectedValueOnce(new Error('bad'))
    render(<CloudKeyForm provider="openai" keyUrl="https://platform.openai.com/api-keys" />)
    typeKey('sk-2')
    fireEvent.click(screen.getByRole('button', { name: 'prefs.voiceKeySave' }))
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toContain('prefs.voiceKeyRejected'),
    )
    expect((screen.getByLabelText('prefs.voiceKeyLabel') as HTMLInputElement).value).toBe('sk-2')
  })

  it('shows the generic failure when the connection test throws', async () => {
    tauri.voiceProviderTest.mockRejectedValueOnce(new Error('boom'))
    render(<CloudKeyForm provider="openai" keyUrl="https://platform.openai.com/api-keys" />)
    typeKey('sk-3')
    fireEvent.click(screen.getByRole('button', { name: 'prefs.voiceKeySave' }))
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toContain('prefs.voiceTestFailed.other'),
    )
  })
})
