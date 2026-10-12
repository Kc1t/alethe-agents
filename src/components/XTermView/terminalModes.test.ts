import { Terminal } from '@xterm/xterm'
import { describe, expect, it, vi } from 'vitest'

import { hasForeignTerminalModes, resetTerminalModes } from './terminalModes'

/** What a fullscreen TUI sends: alternate screen, mouse tracking, bracketed paste, focus events. */
const FULLSCREEN_APP_STREAM =
  '\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h\x1b[?2004h\x1b[?1004h\x1b[?25l'

describe('resetTerminalModes', () => {
  it('hands a pane back when the app that owned it died mid-screen', async () => {
    const terminal = new Terminal({ cols: 80, rows: 24 })
    terminal.write(`shell history${FULLSCREEN_APP_STREAM}`)
    await vi.waitFor(() => expect(terminal.buffer.active.type).toBe('alternate'))

    // `?1003h` is the last mouse mode in the stream, so the terminal reports it as `any`.
    expect(terminal.modes.mouseTrackingMode).toBe('any')
    expect(terminal.modes.bracketedPasteMode).toBe(true)
    expect(hasForeignTerminalModes(terminal)).toBe(true)

    const onReset = vi.fn()
    resetTerminalModes(terminal, onReset)
    await vi.waitFor(() => expect(terminal.buffer.active.type).toBe('normal'))

    expect(terminal.modes.mouseTrackingMode).toBe('none')
    expect(terminal.modes.bracketedPasteMode).toBe(false)
    expect(terminal.modes.sendFocusMode).toBe(false)
    expect(hasForeignTerminalModes(terminal)).toBe(false)
    // The caller scrolls in this callback, so it must run once the parse is done.
    await vi.waitFor(() => expect(onReset).toHaveBeenCalled())
    terminal.dispose()
  })

  it('leaves a pane that never saw a fullscreen app alone', async () => {
    const terminal = new Terminal({ cols: 80, rows: 24 })
    terminal.write('plain shell output')
    await vi.waitFor(() =>
      expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe('plain shell output'),
    )

    expect(hasForeignTerminalModes(terminal)).toBe(false)

    const onReset = vi.fn()
    resetTerminalModes(terminal, onReset)

    expect(onReset).toHaveBeenCalledTimes(1)
    expect(terminal.buffer.active.type).toBe('normal')
    terminal.dispose()
  })
})
