import { beforeEach, describe, expect, it, vi } from 'vitest'

const { writePty } = vi.hoisted(() => ({ writePty: vi.fn() }))

vi.mock('../../lib/storageNamespace', () => ({ readScopedStorage: vi.fn(() => null) }))
vi.mock('../../lib/tauri', () => ({ writePty }))

import {
  applyPromptHistoryInput,
  MAX_TRACKED_PROMPT_LENGTH,
  PASTE_CHUNK_SIZE,
  PTY_WRITE_TIMEOUT_MS,
  writePtyChunked,
  writePtyWithTimeout,
} from './terminalWrite'

describe('applyPromptHistoryInput', () => {
  it('persists multiple submitted lines with one batched change signal', () => {
    const state = { currentLine: '', overflow: false, history: [] as string[] }

    const changed = applyPromptHistoryInput(state, 'first\rsecond\r')

    expect(changed).toBe(true)
    expect(state.history).toEqual(['first', 'second'])
  })

  it('does not retain oversized pasted documents as prompt history', () => {
    const state = { currentLine: 'prefix', overflow: false, history: ['existing'] }

    const changed = applyPromptHistoryInput(state, 'x'.repeat(MAX_TRACKED_PROMPT_LENGTH + 1))

    expect(changed).toBe(false)
    expect(state).toEqual({ currentLine: '', overflow: true, history: ['existing'] })
  })

  it('reports an exact submitted slash command across input chunks', () => {
    const state = { currentLine: '', overflow: false, history: [] as string[] }
    const submitted: string[] = []

    applyPromptHistoryInput(state, '/ne', (line) => submitted.push(line))
    applyPromptHistoryInput(state, 'w\r', (line) => submitted.push(line))

    expect(submitted).toEqual(['/new'])
    expect(state.currentLine).toBe('')
  })

  it('tracks slash commands correctly after clearing the current input line', () => {
    const state = { currentLine: 'old text', overflow: false, history: [] as string[] }
    const submitted: string[] = []

    applyPromptHistoryInput(state, '\x15/new\r', (line) => submitted.push(line))

    expect(submitted).toEqual(['/new'])
  })

  it('handles ten thousand fragmented new-session commands without retaining unbounded history', () => {
    const state = { currentLine: '', overflow: false, history: [] as string[] }
    let newSessionCount = 0

    for (let index = 0; index < 10_000; index += 1) {
      applyPromptHistoryInput(state, '/ne', (line) => {
        if (line === '/new') newSessionCount += 1
      })
      applyPromptHistoryInput(state, 'w\r', (line) => {
        if (line === '/new') newSessionCount += 1
      })
      applyPromptHistoryInput(state, `task-${index}\r`)
    }

    expect(newSessionCount).toBe(10_000)
    expect(state.currentLine).toBe('')
    expect(state.history).toHaveLength(50)
    expect(state.history.at(-1)).toBe('task-9999')
  })
})

describe('writePtyChunked', () => {
  beforeEach(() => {
    writePty.mockReset().mockResolvedValue(undefined)
  })

  it('sends small bracketed pastes in one IPC call', async () => {
    await writePtyChunked('pty-1', 'hello', true)

    expect(writePty).toHaveBeenCalledWith('pty-1', '\x1b[200~hello\x1b[201~')
  })

  it('chunks large pastes without splitting Unicode surrogate pairs', async () => {
    const text = `${'a'.repeat(PASTE_CHUNK_SIZE - 1)}😀tail`

    await writePtyChunked('pty-1', text, false)

    const written = writePty.mock.calls.map((call) => call[1]).join('')
    expect(written).toBe(text)
    expect(writePty.mock.calls.every((call) => !String(call[1]).includes('\ufffd'))).toBe(true)
  })

  it('sends a one-megabyte paste with a bounded number of IPC calls', async () => {
    await writePtyChunked('pty-1', 'x'.repeat(1024 * 1024), true)

    expect(writePty).toHaveBeenCalledTimes(18)
  })

  it('closes bracketed-paste mode even when a data chunk fails', async () => {
    const error = new Error('write failed')
    writePty
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce(undefined)

    await expect(writePtyChunked('pty-1', 'x'.repeat(PASTE_CHUNK_SIZE + 1), true)).rejects.toBe(
      error,
    )

    expect(writePty.mock.calls.at(-1)).toEqual(['pty-1', '\x1b[201~'])
  })
})

describe('writePtyWithTimeout', () => {
  beforeEach(() => {
    vi.useRealTimers()
    writePty.mockReset()
  })

  it('rejects when a native PTY write never settles', async () => {
    vi.useFakeTimers()
    writePty.mockReturnValue(new Promise(() => {}))

    const result = expect(writePtyWithTimeout('pty-1', 'a')).rejects.toThrow('PTY write timed out')
    await vi.advanceTimersByTimeAsync(PTY_WRITE_TIMEOUT_MS)

    await result
    vi.useRealTimers()
  })
})
