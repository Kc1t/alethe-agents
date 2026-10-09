import type { Terminal } from '@xterm/xterm'

/** How far the reader is from the newest line: 0 means the view is following the output. */
export function viewportDistanceFromBottom(terminal: Terminal): number {
  const active = terminal.buffer.active
  return Math.max(0, active.baseY - active.viewportY)
}

/**
 * Puts the view back where the reader had it. Restoring by distance from the bottom survives a
 * resize or a replayed buffer, where line indexes mean something else than they did before.
 */
export function restoreViewport(terminal: Terminal, distanceFromBottom: number): void {
  if (distanceFromBottom === 0) {
    terminal.scrollToBottom()
    return
  }
  terminal.scrollToLine(Math.max(0, terminal.buffer.active.baseY - distanceFromBottom))
}
