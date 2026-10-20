import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useProjectsStore } from '../stores/projectsStore'
import { useUiStore } from '../stores/uiStore'
import { useKeybindings } from './useKeybindings'

const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15'
const WINDOWS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'

function mount(userAgent: string) {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(userAgent)
  return renderHook(() => useKeybindings())
}

/** Dispatches a keydown from a terminal-like textarea, as xterm's helper textarea does. */
function pressInTerminal(init: KeyboardEventInit): KeyboardEvent {
  const textarea = document.createElement('textarea')
  document.body.appendChild(textarea)
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  textarea.dispatchEvent(event)
  textarea.remove()
  return event
}

function press(init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  document.body.dispatchEvent(event)
  return event
}

afterEach(() => {
  vi.restoreAllMocks()
  useUiStore.getState().closeModal()
})

describe('useKeybindings on macOS', () => {
  it('leaves physical Ctrl chords to the terminal', () => {
    const { unmount } = mount(MAC_UA)
    for (const key of ['p', 'w', 't', 'b', '1']) {
      const event = pressInTerminal({ key, ctrlKey: true })
      expect(event.defaultPrevented, `Ctrl+${key}`).toBe(false)
    }
    expect(useUiStore.getState().openModal).toBeNull()
    unmount()
  })

  it('runs app shortcuts on Cmd', () => {
    const { unmount } = mount(MAC_UA)
    const event = pressInTerminal({ key: 'p', metaKey: true })
    expect(event.defaultPrevented).toBe(true)
    expect(useUiStore.getState().openModal).toBe('findJump')
    unmount()
  })

  it('toggles the sidebar with Cmd+B, not Ctrl+B', () => {
    const { unmount } = mount(MAC_UA)
    const before = useProjectsStore.getState().preferences.leftSidebarVisible
    press({ key: 'b', ctrlKey: true })
    expect(useProjectsStore.getState().preferences.leftSidebarVisible).toBe(before)
    press({ key: 'b', metaKey: true })
    expect(useProjectsStore.getState().preferences.leftSidebarVisible).toBe(!before)
    press({ key: 'b', metaKey: true })
    unmount()
  })

  it('keeps Ctrl+Tab on the physical Ctrl key, even from inside a terminal', () => {
    const { unmount } = mount(MAC_UA)
    expect(pressInTerminal({ key: 'Tab', ctrlKey: true }).defaultPrevented).toBe(true)
    expect(pressInTerminal({ key: 'Tab', ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(
      true,
    )
    unmount()
  })

  it('does not restart a terminal on Ctrl+R outside an editable field', () => {
    const { unmount } = mount(MAC_UA)
    const listener = vi.fn()
    window.addEventListener('alethe:terminal-restart-request', listener)
    press({ key: 'r', ctrlKey: true })
    window.removeEventListener('alethe:terminal-restart-request', listener)
    expect(listener).not.toHaveBeenCalled()
    unmount()
  })
})

describe('useKeybindings on Windows', () => {
  it('runs app shortcuts on Ctrl, from inside a terminal too', () => {
    const { unmount } = mount(WINDOWS_UA)
    const event = pressInTerminal({ key: 'p', ctrlKey: true })
    expect(event.defaultPrevented).toBe(true)
    expect(useUiStore.getState().openModal).toBe('findJump')
    unmount()
  })

  it('switches tabs with Ctrl+Tab', () => {
    const { unmount } = mount(WINDOWS_UA)
    expect(pressInTerminal({ key: 'Tab', ctrlKey: true }).defaultPrevented).toBe(true)
    unmount()
  })
})
