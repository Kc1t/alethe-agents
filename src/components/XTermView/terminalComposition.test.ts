import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { keepTerminalTextareaClean, TEXTAREA_IDLE_RESET_MS } from './terminalComposition'

describe('keepTerminalTextareaClean', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('empties stale text once typing has been idle', () => {
    const textarea = document.createElement('textarea')
    const release = keepTerminalTextareaClean(textarea)
    textarea.value = 'old~´ã'
    textarea.dispatchEvent(new Event('input'))

    vi.advanceTimersByTime(TEXTAREA_IDLE_RESET_MS - 1)
    expect(textarea.value).toBe('old~´ã')
    vi.advanceTimersByTime(1)
    expect(textarea.value).toBe('')
    release()
  })

  it('waits while the user keeps typing', () => {
    const textarea = document.createElement('textarea')
    const release = keepTerminalTextareaClean(textarea)
    textarea.value = 'ã'
    for (let i = 0; i < 5; i++) {
      textarea.dispatchEvent(new Event('keydown'))
      vi.advanceTimersByTime(TEXTAREA_IDLE_RESET_MS - 10)
    }
    expect(textarea.value).toBe('ã')
    release()
  })

  it('never clears during an open composition', () => {
    const textarea = document.createElement('textarea')
    const release = keepTerminalTextareaClean(textarea)
    textarea.dispatchEvent(new Event('compositionstart'))
    textarea.value = '~'
    vi.advanceTimersByTime(TEXTAREA_IDLE_RESET_MS * 3)
    expect(textarea.value).toBe('~')

    textarea.dispatchEvent(new Event('compositionend'))
    vi.advanceTimersByTime(TEXTAREA_IDLE_RESET_MS)
    expect(textarea.value).toBe('')
    release()
  })

  it('stops acting once released', () => {
    const textarea = document.createElement('textarea')
    const release = keepTerminalTextareaClean(textarea)
    textarea.dispatchEvent(new Event('input'))
    release()
    textarea.value = 'kept'
    vi.advanceTimersByTime(TEXTAREA_IDLE_RESET_MS * 2)
    expect(textarea.value).toBe('kept')
  })
})
