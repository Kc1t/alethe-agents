import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { EMPTY_PROJECTS_FILE } from '../../../../lib/types'
import { useProjectsStore } from '../../../../stores/projectsStore'
import { useVoiceConversationStore } from '../../../../stores/voiceConversationStore'
import { BuiltInProviderView } from './BuiltInProviderView'

const tauri = vi.hoisted(() => ({
  speechNativeLocales: vi.fn(),
  speechModelStates: vi.fn(),
  ttsVoices: vi.fn(),
  ttsSpeak: vi.fn(),
}))
vi.mock('../../../../lib/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../lib/tauri')>()),
  ...tauri,
  saveProjectsFile: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../../../lib/i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../lib/i18n')>()),
  useT: () => (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
}))

afterEach(cleanup)

beforeEach(() => {
  useProjectsStore.setState({ ...structuredClone(EMPTY_PROJECTS_FILE), hydrated: true })
  tauri.speechNativeLocales.mockReset().mockResolvedValue([])
  tauri.speechModelStates.mockReset().mockResolvedValue([])
  tauri.ttsVoices.mockReset().mockResolvedValue([])
  tauri.ttsSpeak.mockReset().mockResolvedValue(1)
})

describe('BuiltInProviderView (Apple Speech)', () => {
  it('splits installed and installable languages and explains a denied permission', async () => {
    tauri.speechNativeLocales.mockResolvedValue([
      { id: 'pt_BR', name: 'Portuguese (Brazil)', installed: false },
      { id: 'en_US', name: 'English (US)', installed: true },
      { id: 'ja_JP', name: 'Japanese', installed: false },
      { id: 'fr_FR', name: 'French', installed: true },
    ])
    tauri.speechModelStates.mockResolvedValue([
      { id: 'parakeet-tdt-0.6b-v3-int8', status: 'ready' },
      { id: 'apple-speech', status: 'denied' },
    ])
    render(<BuiltInProviderView id="apple" />)
    const items = (name: string) =>
      within(screen.getByRole('list', { name }))
        .getAllByRole('listitem')
        .map((item) => item.textContent)
    await screen.findByRole('list', { name: 'prefs.voiceAppleInstalled' })
    expect(items('prefs.voiceAppleInstalled')).toEqual(['English (US)', 'French'])
    expect(items('prefs.voiceAppleAvailable')).toEqual(['Portuguese (Brazil)', 'Japanese'])
    expect((await screen.findByRole('alert')).textContent).toBe('prefs.dictationNativeDenied')
    expect(screen.getByText('prefs.voiceApplePermission').parentElement?.textContent).toContain(
      'prefs.voiceApplePermissionDenied',
    )
    // The settings link would need a non-http opener, which the app does not have.
    expect(screen.queryByRole('button')).toBeNull()
    expect(tauri.speechModelStates).toHaveBeenCalledTimes(1)
    expect(tauri.speechModelStates.mock.calls[0][0] ?? null).toBeNull()
    expect(tauri.ttsVoices).not.toHaveBeenCalled()
  })

  it.each([
    ['ready', 'prefs.voiceApplePermissionGranted'],
    ['needs-locale', 'prefs.voiceApplePermissionGranted'],
    ['not-installed', 'prefs.voiceApplePermissionGranted'],
    ['unavailable', 'prefs.voiceApplePermissionUnavailable'],
  ])('shows the permission state for a %s engine', async (status, key) => {
    tauri.speechModelStates.mockResolvedValue([{ id: 'apple-speech', status }])
    render(<BuiltInProviderView id="apple" />)
    const label = await screen.findByText('prefs.voiceApplePermission')
    await waitFor(() => expect(label.parentElement?.textContent).toContain(key))
  })

  it('omits a list with nothing in it', async () => {
    tauri.speechNativeLocales.mockResolvedValue([
      { id: 'en_US', name: 'English (US)', installed: true },
    ])
    render(<BuiltInProviderView id="apple" />)
    expect(await screen.findByRole('list', { name: 'prefs.voiceAppleInstalled' })).toBeTruthy()
    expect(screen.queryByRole('list', { name: 'prefs.voiceAppleAvailable' })).toBeNull()
  })

  it('shows no permission message when recognition is allowed', async () => {
    tauri.speechNativeLocales.mockResolvedValue([
      { id: 'en_US', name: 'English (US)', installed: true },
    ])
    tauri.speechModelStates.mockResolvedValue([{ id: 'apple-speech', status: 'needs-locale' }])
    render(<BuiltInProviderView id="apple" />)
    await screen.findByText('English (US)')
    await waitFor(() => expect(tauri.speechModelStates).toHaveBeenCalled())
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByText('prefs.dictationNativeDenied')).toBeNull()
  })

  it('says so when this Mac has no on-device language', async () => {
    tauri.speechNativeLocales.mockResolvedValue([])
    render(<BuiltInProviderView id="apple" />)
    expect(await screen.findByText('prefs.dictationNativeNoLocales')).toBeTruthy()
    expect(screen.queryByRole('listitem')).toBeNull()
  })

  it('says the languages could not be loaded when the request fails', async () => {
    tauri.speechNativeLocales.mockRejectedValue(new Error('bridge down'))
    render(<BuiltInProviderView id="apple" />)
    expect(await screen.findByText('prefs.voiceLoadFailed')).toBeTruthy()
    expect(screen.queryByText('prefs.dictationNativeNoLocales')).toBeNull()
    expect(screen.queryByRole('listitem')).toBeNull()
  })
})

describe('BuiltInProviderView (System voice)', () => {
  it('counts the system voices per language, app language first', async () => {
    tauri.ttsVoices.mockResolvedValue([
      { id: 'com.apple.voice.Luciana', name: 'Luciana', language: 'pt_BR' },
      { id: 'com.apple.voice.Samantha', name: 'Samantha', language: 'en_US' },
      { id: 'com.apple.voice.Joana', name: 'Joana', language: 'pt-PT' },
      { id: 'com.apple.voice.Alex', name: 'Alex', language: 'en-US' },
      { id: 'com.apple.voice.Felipe', name: 'Felipe', language: 'pt_BR' },
      { id: 'mystery', name: 'Mystery', language: '' },
    ])
    render(<BuiltInProviderView id="system" />)
    const list = await screen.findByRole('list', { name: 'prefs.voiceSystemVoicesByLanguage' })
    const rows = within(list)
      .getAllByRole('listitem')
      .map((item) => [...item.children].map((child) => child.textContent))
    expect(rows).toEqual([
      ['English (United States)', '2'],
      ['prefs.voiceLangMulti', '1'],
      ['Portuguese (Brazil)', '2'],
      ['Portuguese (Portugal)', '1'],
    ])
    expect(tauri.ttsVoices).toHaveBeenCalledWith('system')
    expect(tauri.speechNativeLocales).not.toHaveBeenCalled()
  })

  it('disables Test while the narration is paused, and says why', () => {
    useVoiceConversationStore.setState({ narrationPaused: true })
    try {
      render(<BuiltInProviderView id="system" />)
      const button = screen.getByRole('button', { name: 'prefs.voiceSystemTest' })
      expect((button as HTMLButtonElement).disabled).toBe(true)
      expect(button.getAttribute('title')).toBe('prefs.voiceTestPausedHint')
      expect(screen.getByText('prefs.voiceTestPausedHint')).toBeTruthy()
      fireEvent.click(button)
      expect(tauri.ttsSpeak).not.toHaveBeenCalled()
    } finally {
      useVoiceConversationStore.setState({ narrationPaused: false })
    }
  })

  it('Test speaks the test sentence with the system voice', async () => {
    render(<BuiltInProviderView id="system" />)
    fireEvent.click(screen.getByRole('button', { name: 'prefs.voiceSystemTest' }))
    await waitFor(() => expect(tauri.ttsSpeak).toHaveBeenCalledTimes(1))
    expect(tauri.ttsSpeak).toHaveBeenCalledWith('prefs.voiceTestSentence', {
      provider: 'system',
      model: '',
      voice: null,
      rate: 1,
    })
  })

  it('says the voices could not be loaded when the request fails', async () => {
    tauri.ttsVoices.mockRejectedValue(new Error('bridge down'))
    render(<BuiltInProviderView id="system" />)
    expect(await screen.findByText('prefs.voiceLoadFailed')).toBeTruthy()
    expect(screen.queryByText('—')).toBeNull()
    expect(screen.queryByRole('listitem')).toBeNull()
  })

  it('shows an error line when the test voice cannot play, and clears it on retry', async () => {
    tauri.ttsSpeak.mockRejectedValueOnce(new Error('no audio')).mockResolvedValueOnce(2)
    render(<BuiltInProviderView id="system" />)
    const button = screen.getByRole('button', { name: 'prefs.voiceSystemTest' })
    fireEvent.click(button)
    expect((await screen.findByRole('status')).textContent).toBe('prefs.voiceTestSpeakFailed')
    fireEvent.click(button)
    await waitFor(() => expect(tauri.ttsSpeak).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull())
  })

  it('shows "—" when the system lists no voices', async () => {
    tauri.ttsVoices.mockResolvedValue([])
    render(<BuiltInProviderView id="system" />)
    await waitFor(() => expect(tauri.ttsVoices).toHaveBeenCalled())
    expect(await screen.findByText('—')).toBeTruthy()
    expect(screen.queryByRole('listitem')).toBeNull()
  })
})
