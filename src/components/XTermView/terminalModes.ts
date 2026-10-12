import type { Terminal } from '@xterm/xterm'

/**
 * A fullscreen TUI that dies without undoing the modes it turned on — Claude Code in fullscreen
 * rendering, `less`, `htop` — leaves the pane on the alternate screen with mouse tracking,
 * bracketed paste and focus reporting still on, and the cursor hidden. Alethe then forwards the
 * wheel to the app instead of scrolling the pane, and the app is gone, so nothing moves.
 */
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

/**
 * Undoes the modes a dead TUI left behind and runs `onReset` once the terminal has parsed it, so a
 * caller can scroll the buffer it restores. A no-op on a terminal that never had them.
 */
export function resetTerminalModes(terminal: Terminal, onReset?: () => void): void {
  if (!hasForeignTerminalModes(terminal)) {
    onReset?.()
    return
  }
  terminal.write(MODE_RESET_SEQUENCE, onReset)
}
