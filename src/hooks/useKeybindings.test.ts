import { fireEvent, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

import { useUiStore } from '../stores/uiStore'
import { useVoiceConversationStore } from '../stores/voiceConversationStore'
import { useKeybindings } from './useKeybindings'

const pressEscape = () => fireEvent.keyDown(window, { key: 'Escape', code: 'Escape' })
const pressCloseTab = () => fireEvent.keyDown(window, { key: 'w', code: 'KeyW', metaKey: true })

describe('useKeybindings', () => {
  beforeEach(() => {
    useUiStore.setState({ openModal: 'preferences', modalContext: null })
    useVoiceConversationStore.setState({ shortcutRecording: false })
  })

  it('closes the open modal on Esc and claims Cmd+W', () => {
    renderHook(() => useKeybindings())
    expect(pressCloseTab()).toBe(false)
    pressEscape()
    expect(useUiStore.getState().openModal).toBeNull()
  })

  it('stands down while the voice shortcut recorder is capturing', () => {
    useVoiceConversationStore.setState({ shortcutRecording: true })
    renderHook(() => useKeybindings())
    expect(pressCloseTab()).toBe(true)
    pressEscape()
    expect(useUiStore.getState().openModal).toBe('preferences')
  })
})
