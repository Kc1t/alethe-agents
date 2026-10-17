import { describe, expect, it, vi } from 'vitest'

import { captureTerminalPaste } from './terminalPaste'

describe('captureTerminalPaste', () => {
  it('delivers a paste once without reaching xterm or ancestor paste handlers', () => {
    const ancestor = document.createElement('div')
    const container = document.createElement('div')
    const textarea = document.createElement('textarea')
    ancestor.append(container)
    container.append(textarea)
    const xtermPaste = vi.fn()
    const ancestorPaste = vi.fn()
    const applicationPaste = vi.fn()
    textarea.addEventListener('paste', xtermPaste)
    ancestor.addEventListener('paste', ancestorPaste)
    const release = captureTerminalPaste(container, applicationPaste)
    const event = new Event('paste', { bubbles: true, cancelable: true })

    textarea.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
    expect(applicationPaste).toHaveBeenCalledTimes(1)
    expect(xtermPaste).not.toHaveBeenCalled()
    expect(ancestorPaste).not.toHaveBeenCalled()

    release()
    textarea.dispatchEvent(new Event('paste', { bubbles: true, cancelable: true }))
    expect(applicationPaste).toHaveBeenCalledTimes(1)
    expect(xtermPaste).toHaveBeenCalledTimes(1)
  })
})
