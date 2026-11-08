import { cleanup, fireEvent, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { suspendKeybindings } from '../lib/keybindingSuspension'
import { useUiStore } from '../stores/uiStore'
import { useKeybindings } from './useKeybindings'

afterEach(() => {
  cleanup()
  useUiStore.getState().closeModal()
})

describe('plugin keybinding suspension', () => {
  it('lets a shortcut recorder receive Escape and restores app shortcuts after release', () => {
    useUiStore.getState().openModal_('preferences')
    renderHook(() => useKeybindings())
    const release = suspendKeybindings()
    try {
      fireEvent.keyDown(window, { key: 'Escape' })
      expect(useUiStore.getState().openModal).toBe('preferences')
    } finally {
      release()
    }
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(useUiStore.getState().openModal).toBeNull()
  })
})
