import type { Terminal } from '@xterm/xterm'

// Release the alternate screen and input modes left by a dead TUI.
const MODE_RESET_SEQUENCE =
  '\x1b[?1049l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1015l\x1b[?2004l\x1b[?1004l\x1b[?25h'

export function hasForeignTerminalModes(terminal: Terminal): boolean {
  return (
    terminal.buffer.active.type === 'alternate' ||
    terminal.modes.mouseTrackingMode !== 'none' ||
    terminal.modes.bracketedPasteMode ||
    terminal.modes.sendFocusMode
  )
}

// Reset only foreign modes and call onReset after xterm parses the reset.
export function resetTerminalModes(terminal: Terminal, onReset?: () => void): void {
  if (!hasForeignTerminalModes(terminal)) {
    onReset?.()
    return
  }
  terminal.write(MODE_RESET_SEQUENCE, onReset)
}
