import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { EMPTY_PROJECTS_FILE } from '../../../lib/types'
import { useProjectsStore } from '../../../stores/projectsStore'
import { VoiceDictationSection } from './VoiceDictationSection'

const tauri = vi.hoisted(() => ({ speechListInputDevices: vi.fn() }))

vi.mock('../../../lib/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/tauri')>()),
  ...tauri,
  saveProjectsFile: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../../lib/i18n', () => ({
  useT: () => (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
  getLocale: () => 'en',
  intlLocale: () => 'en-US',
}))

const prefs = () => useProjectsStore.getState().preferences

describe('VoiceDictationSection', () => {
  beforeEach(() => {
    useProjectsStore.setState({ ...structuredClone(EMPTY_PROJECTS_FILE), hydrated: true })
    tauri.speechListInputDevices.mockResolvedValue([
      { deviceId: 'mic-1', label: 'USB mic', isDefault: false },
    ])
  })
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('turns dictation on and off', async () => {
    render(<VoiceDictationSection />)
    fireEvent.click(screen.getByRole('button', { name: 'prefs.dictationOn' }))
    await waitFor(() => expect(prefs().dictationEnabled).toBe(true))
    fireEvent.click(screen.getByRole('button', { name: 'prefs.dictationOff' }))
    expect(prefs().dictationEnabled).toBe(false)
  })

  it('switches between toggle and hold', async () => {
    useProjectsStore.getState().setPreferences({ dictationEnabled: true })
    render(<VoiceDictationSection />)
    fireEvent.click(screen.getByRole('button', { name: 'prefs.dictationModeHold' }))
    expect(prefs().dictationMode).toBe('hold')
  })

  it('saves the chosen microphone', async () => {
    useProjectsStore.getState().setPreferences({ dictationEnabled: true })
    render(<VoiceDictationSection />)
    await waitFor(() => expect(tauri.speechListInputDevices).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('button', { name: 'prefs.dictationMic', expanded: false }))
    const option = await screen.findByRole('option', { name: 'USB mic' })
    fireEvent.pointerDown(option)
    fireEvent.click(option)
    expect(prefs().dictationMicrophoneId).toBe('mic-1')
  })
})
