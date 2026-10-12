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

/** Where the reader was before a resync: their distance from the end and the text they were on. */
export type ViewportAnchor = { distance: number; top: number; text: string[] }

/** Lines from the top of the view that identify it; one alone repeats too often (blank, `}`). */
const ANCHOR_LINES = 3

export function captureViewportAnchor(terminal: Terminal): ViewportAnchor {
  const active = terminal.buffer.active
  const text: string[] = []
  for (let y = active.viewportY; y < active.viewportY + ANCHOR_LINES; y++) {
    const line = active.getLine(y)
    if (!line) break
    text.push(line.translateToString(true))
  }
  return { distance: viewportDistanceFromBottom(terminal), top: active.viewportY, text }
}

/**
 * Puts the reader back on the text they were reading once a resync rebuilt the buffer. Output that
 * arrived while the pane was hidden moved the end, not that text, so the distance from the end
 * would land them further down; a replay that dropped the oldest lines moved the text up. The
 * distance is the fallback when the text is gone, and a reader at the end keeps following it.
 */
export function restoreViewportAnchor(terminal: Terminal, anchor: ViewportAnchor): void {
  if (anchor.distance === 0) {
    terminal.scrollToBottom()
    return
  }
  const active = terminal.buffer.active
  const matches = (y: number) =>
    anchor.text.every((text, i) => active.getLine(y + i)?.translateToString(true) === text)
  if (anchor.text.some((text) => text.trim())) {
    // A replay that dropped many lines can leave the old index past the end of the new buffer.
    const center = Math.min(anchor.top, active.baseY)
    // ponytail: linear scan outward from the old line, once per resync; index the buffer if a
    // resync ever shows up in a profile.
    for (let offset = 0; offset <= active.baseY; offset++) {
      for (const y of [center - offset, center + offset]) {
        if (y >= 0 && y <= active.baseY && matches(y)) {
          terminal.scrollToLine(y)
          return
        }
      }
    }
  }
  restoreViewport(terminal, anchor.distance)
}
