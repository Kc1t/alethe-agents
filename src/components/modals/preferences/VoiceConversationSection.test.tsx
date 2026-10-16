import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { EMPTY_PROJECTS_FILE } from '../../../lib/types'
import { useProjectsStore } from '../../../stores/projectsStore'
import { VoiceConversationSection } from './VoiceConversationSection'

vi.mock('../../../lib/tauri', () => ({
  voiceShortcutSet: vi.fn().mockResolvedValue(undefined),
}))
const offerVoiceRestart = vi.hoisted(() => vi.fn(async () => undefined))
vi.mock('../../../lib/voice/restartSessions', () => ({ offerVoiceRestart }))

const prefs = () => useProjectsStore.getState().preferences
// The section heading toggle shares the dropdown's name.
const hudDropdown = () =>
  screen
    .getAllByRole('button', { name: 'HUD position' })
    .find((button) => button.getAttribute('aria-haspopup') === 'listbox')!

describe('VoiceConversationSection', () => {
  beforeEach(() => {
    useProjectsStore.setState({ ...structuredClone(EMPTY_PROJECTS_FILE), hydrated: true })
  })

  it('turns the feature on', () => {
    render(<VoiceConversationSection />)
    fireEvent.click(screen.getByRole('button', { name: 'On' }))
    expect(prefs().voiceConversationEnabled).toBe(true)
  })

  // Claude sessions already running were launched without the voice hooks.
  it('offers to restart the running sessions when voice is turned on, once', () => {
    offerVoiceRestart.mockClear()
    render(<VoiceConversationSection />)
    fireEvent.click(screen.getByRole('button', { name: 'On' }))
    expect(offerVoiceRestart).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'On' }))
    fireEvent.click(screen.getByRole('button', { name: 'Off' }))
    expect(offerVoiceRestart).toHaveBeenCalledTimes(1)
  })

  it('records the shortcut instead of typing it', () => {
    useProjectsStore.getState().setPreferences({ voiceConversationEnabled: true })
    render(<VoiceConversationSection />)
    expect(screen.queryByLabelText('Shortcut')).toBeNull()
    expect(screen.getByRole('button', { name: 'Change' })).toBeTruthy()
    expect(screen.getByText('Space')).toBeTruthy()
    expect(
      screen.getByText(
        'Hold it to talk, or press it to start and stop in toggle mode. Works system-wide; hold Alt with it to send to Jev.',
      ),
    ).toBeTruthy()
  })

  it('lists the six HUD positions and saves the picked one', () => {
    useProjectsStore.getState().setPreferences({ voiceConversationEnabled: true })
    render(<VoiceConversationSection />)
    fireEvent.click(hudDropdown())
    const options = screen.getAllByRole('option').map((option) => option.textContent)
    expect(options).toEqual([
      'Bottom center',
      'Bottom left',
      'Bottom right',
      'Top center',
      'Top left',
      'Top right',
    ])
    const topLeft = screen.getByRole('option', { name: 'Top left' })
    fireEvent.pointerDown(topLeft)
    fireEvent.click(topLeft)
    expect(prefs().voiceHudPosition).toBe('top-left')
  })

  it('shows a dragged HUD as custom and resets it to the default position', () => {
    useProjectsStore.getState().setPreferences({
      voiceConversationEnabled: true,
      voiceHudPosition: 'custom',
      voiceHudCustomPosition: { monitor: 'DELL', x: 0.2, y: 0.3 },
    })
    render(<VoiceConversationSection />)
    expect(hudDropdown().textContent).toContain('Custom (where you dragged it)')
    fireEvent.click(screen.getByRole('button', { name: 'Reset to default position' }))
    expect(prefs().voiceHudPosition).toBe('bottom-center')
    expect(prefs().voiceHudCustomPosition).toBeNull()
  })

  it('hides the position reset unless the HUD was dragged', () => {
    useProjectsStore.getState().setPreferences({ voiceConversationEnabled: true })
    render(<VoiceConversationSection />)
    expect(screen.queryByRole('button', { name: 'Reset to default position' })).toBeNull()
  })

  it('keeps narration settings out of the conversation section', () => {
    render(<VoiceConversationSection />)
    expect(screen.queryByRole('button', { name: '2×' })).toBeNull()
    expect(screen.queryByText('Narration')).toBeNull()
  })

  it('drops multi-word interrupt entries', () => {
    useProjectsStore.getState().setPreferences({ voiceConversationEnabled: true })
    render(<VoiceConversationSection />)
    const input = screen.getByLabelText('Interrupt words')
    fireEvent.change(input, { target: { value: 'Stop, hold on, wait' } })
    fireEvent.blur(input)
    expect(prefs().voiceInterruptWords).toEqual(['stop', 'wait'])
  })

  it('shows the canonical words after blur and dedupes', () => {
    useProjectsStore.getState().setPreferences({ voiceConversationEnabled: true })
    render(<VoiceConversationSection />)
    const input = screen.getByLabelText('Interrupt words') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'Stop, hold on, wait, stop' } })
    fireEvent.blur(input)
    expect(input.value).toBe('stop, wait')
  })

  it('resets a blank trigger draft to the stored value on blur', () => {
    useProjectsStore.getState().setPreferences({ voiceConversationEnabled: true })
    render(<VoiceConversationSection />)
    const input = screen.getByLabelText('Jev trigger word') as HTMLInputElement
    fireEvent.change(input, { target: { value: '  ' } })
    fireEvent.blur(input)
    expect(input.value).toBe('alethe')
  })

  it('follows store changes made from outside', () => {
    useProjectsStore.getState().setPreferences({ voiceConversationEnabled: true })
    render(<VoiceConversationSection />)
    act(() => {
      useProjectsStore.getState().setPreferences({
        voiceShortcut: 'CmdOrCtrl+Alt+K',
        voiceInterruptWords: ['halt'],
        voiceJevTrigger: 'jev',
      })
    })
    expect(screen.getByText('K')).toBeTruthy()
    expect((screen.getByLabelText('Interrupt words') as HTMLInputElement).value).toBe('halt')
    expect((screen.getByLabelText('Jev trigger word') as HTMLInputElement).value).toBe('jev')
  })
})
