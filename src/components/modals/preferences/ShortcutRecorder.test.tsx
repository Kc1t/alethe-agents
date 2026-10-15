import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { voiceShortcutSet } from '../../../lib/tauri'
import {
  INITIAL_VOICE_CONVERSATION,
  useVoiceConversationStore,
} from '../../../stores/voiceConversationStore'
import { ShortcutRecorder } from './ShortcutRecorder'

const platform = vi.hoisted(() => ({ mac: true }))

vi.mock('../../../lib/tauri', () => ({
  voiceShortcutSet: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../../lib/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/platform')>()),
  isMacOS: () => platform.mac,
}))

const setShortcut = vi.mocked(voiceShortcutSet)
const recordingFlag = () => useVoiceConversationStore.getState().shortcutRecording
const RECORDING = 'Press the new shortcut… (Esc cancels)'
const NEEDS_MODIFIER = 'Add ⌘ or Ctrl (Shift alone works only with F1–F24).'

function setup(props: { value?: string; disabled?: boolean } = {}) {
  const onSaved = vi.fn()
  const view = render(
    <ShortcutRecorder
      value={props.value ?? 'CmdOrCtrl+Shift+Space'}
      onSaved={onSaved}
      disabled={props.disabled}
    />,
  )
  return { onSaved, ...view }
}

const startRecording = () => fireEvent.click(screen.getByRole('button', { name: 'Change' }))

describe('ShortcutRecorder', () => {
  beforeEach(() => {
    platform.mac = true
    setShortcut.mockReset()
    setShortcut.mockResolvedValue(undefined)
    useVoiceConversationStore.setState({ ...INITIAL_VOICE_CONVERSATION })
  })

  it('shows the current value as macOS key caps', () => {
    setup()
    expect(screen.getByText('⌘')).toBeTruthy()
    expect(screen.getByText('⇧')).toBeTruthy()
    expect(screen.getByText('Space')).toBeTruthy()
  })

  it('shows the current value with key names elsewhere', () => {
    platform.mac = false
    setup()
    expect(screen.getByText('Ctrl')).toBeTruthy()
    expect(screen.getByText('Shift')).toBeTruthy()
    expect(screen.getByText('Space')).toBeTruthy()
  })

  it('starts recording and releases the current global shortcut', () => {
    setup()
    startRecording()
    expect(recordingFlag()).toBe(true)
    expect(screen.getByText(RECORDING)).toBeTruthy()
    expect(setShortcut).toHaveBeenCalledWith(null)
  })

  it('shows the modifiers held while recording', () => {
    setup({ value: 'CmdOrCtrl+K' })
    startRecording()
    fireEvent.keyDown(window, { key: 'Shift', code: 'ShiftLeft', shiftKey: true })
    expect(screen.getByText('⇧')).toBeTruthy()
  })

  it('registers and saves a recorded shortcut', async () => {
    const { onSaved } = setup()
    startRecording()
    fireEvent.keyDown(window, { key: 'k', code: 'KeyK', metaKey: true })
    expect(setShortcut).toHaveBeenLastCalledWith('CmdOrCtrl+K')
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith('CmdOrCtrl+K'))
    expect(recordingFlag()).toBe(false)
    expect(screen.queryByText(RECORDING)).toBeNull()
    expect(setShortcut.mock.calls).toEqual([[null], ['CmdOrCtrl+K']])
  })

  it('restores the previous shortcut when the new one is taken', async () => {
    const { onSaved } = setup()
    startRecording()
    setShortcut.mockRejectedValueOnce(new Error('taken'))
    fireEvent.keyDown(window, { key: 'k', code: 'KeyK', metaKey: true })
    expect(
      await screen.findByText('That shortcut is taken by another app or by the system.'),
    ).toBeTruthy()
    expect(onSaved).not.toHaveBeenCalled()
    expect(setShortcut).toHaveBeenLastCalledWith('CmdOrCtrl+Shift+Space')
    expect(screen.queryByText(RECORDING)).toBeNull()
    expect(recordingFlag()).toBe(false)
  })

  it('refuses Alt and keeps recording', () => {
    setup()
    startRecording()
    fireEvent.keyDown(window, { key: 'k', code: 'KeyK', metaKey: true, altKey: true })
    expect(screen.getByText('Alt is used to send to Jev; pick a shortcut without it.')).toBeTruthy()
    expect(screen.getByText(RECORDING)).toBeTruthy()
    expect(recordingFlag()).toBe(true)
    expect(setShortcut.mock.calls).toEqual([[null]])
  })

  it('asks for a modifier when a plain key is pressed', () => {
    setup()
    startRecording()
    fireEvent.keyDown(window, { key: 'k', code: 'KeyK' })
    expect(screen.getByText(NEEDS_MODIFIER)).toBeTruthy()
    expect(screen.getByText(RECORDING)).toBeTruthy()
  })

  it('refuses Shift as the only modifier, and keeps recording', () => {
    const { onSaved } = setup()
    startRecording()
    fireEvent.keyDown(window, { key: 'K', code: 'KeyK', shiftKey: true })
    expect(screen.getByText(NEEDS_MODIFIER)).toBeTruthy()
    expect(screen.getByText(RECORDING)).toBeTruthy()
    expect(onSaved).not.toHaveBeenCalled()
  })

  it('rejects keys it cannot bind', () => {
    setup()
    startRecording()
    fireEvent.keyDown(window, { key: 'Enter', code: 'Enter', metaKey: true })
    expect(screen.getByText('Use a letter, a number, Space or F1–F24.')).toBeTruthy()
  })

  it('ends recording on Esc and restores the saved shortcut', () => {
    const { onSaved } = setup()
    startRecording()
    fireEvent.keyDown(window, { key: 'Escape', code: 'Escape' })
    expect(screen.queryByText(RECORDING)).toBeNull()
    expect(recordingFlag()).toBe(false)
    expect(onSaved).not.toHaveBeenCalled()
    expect(setShortcut.mock.calls).toEqual([[null], ['CmdOrCtrl+Shift+Space']])
  })

  it('stops the recorded keys from bubbling to the page', () => {
    setup()
    const bubbling = vi.fn()
    document.addEventListener('keydown', bubbling)
    startRecording()
    fireEvent.keyDown(document.body, { key: 'Escape', code: 'Escape' })
    document.removeEventListener('keydown', bubbling)
    expect(bubbling).not.toHaveBeenCalled()
  })

  // Window capture listeners registered earlier still run first; they stand down on the store flag.
  it('raises the store flag before earlier window listeners see a key', () => {
    const seen: boolean[] = []
    const earlier = () => seen.push(recordingFlag())
    window.addEventListener('keydown', earlier, true)
    setup()
    startRecording()
    fireEvent.keyDown(document.body, { key: 'k', code: 'KeyK', metaKey: true })
    window.removeEventListener('keydown', earlier, true)
    expect(seen).toEqual([true])
  })

  it('clears a refusal when recording is cancelled', () => {
    setup()
    startRecording()
    fireEvent.keyDown(window, { key: 'k', code: 'KeyK' })
    fireEvent.keyDown(window, { key: 'Escape', code: 'Escape' })
    expect(screen.queryByText('Add a modifier key (⌘, Ctrl or ⇧).')).toBeNull()
  })

  it('stops and restores the saved shortcut when the window loses focus', () => {
    const { onSaved } = setup()
    startRecording()
    fireEvent.blur(window)
    expect(screen.queryByText(RECORDING)).toBeNull()
    expect(recordingFlag()).toBe(false)
    expect(onSaved).not.toHaveBeenCalled()
    expect(setShortcut.mock.calls).toEqual([[null], ['CmdOrCtrl+Shift+Space']])
  })

  it('resets to the default shortcut by registering it first', async () => {
    const { onSaved } = setup({ value: 'CmdOrCtrl+K' })
    fireEvent.click(screen.getByRole('button', { name: 'Reset to default' }))
    expect(setShortcut).toHaveBeenCalledWith('CmdOrCtrl+Shift+Space')
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith('CmdOrCtrl+Shift+Space'))
  })

  it('restores the saved shortcut when it unmounts mid-recording', () => {
    const { unmount } = setup()
    startRecording()
    unmount()
    expect(recordingFlag()).toBe(false)
    expect(setShortcut).toHaveBeenLastCalledWith('CmdOrCtrl+Shift+Space')
  })

  it('stops without restoring when it is disabled mid-recording', () => {
    const { onSaved, rerender } = setup()
    startRecording()
    // Turning voice off disposes the controller, which resets the store flag on its own.
    act(() => useVoiceConversationStore.setState({ shortcutRecording: false }))
    expect(screen.getByText(RECORDING)).toBeTruthy()
    rerender(<ShortcutRecorder value="CmdOrCtrl+Shift+Space" onSaved={onSaved} disabled />)
    expect(screen.queryByText(RECORDING)).toBeNull()
    expect(recordingFlag()).toBe(false)
    fireEvent.keyDown(window, { key: 'k', code: 'KeyK', metaKey: true })
    expect(setShortcut.mock.calls).toEqual([[null]])
    expect(screen.getByRole('button', { name: 'Change' })).toHaveProperty('disabled', true)
  })
})
