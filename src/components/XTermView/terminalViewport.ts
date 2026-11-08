import type { Terminal } from '@xterm/xterm'

/** How far the reader is from the newest line: 0 means the view is following the output. */
export function viewportDistanceFromBottom(terminal: Terminal): number {
  const active = terminal.buffer.active
  return Math.max(0, active.baseY - active.viewportY)
}

// Restore distance from the bottom across buffer rebuilds and resizes.
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

// Prefer the old visible text after replay, falling back to distance when it is gone.
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
    // Search outward from the old line; resyncs are infrequent.
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
