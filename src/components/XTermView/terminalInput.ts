type WheelLike = {
  deltaMode: number
  deltaY: number
}

const DOM_DELTA_PIXEL = 0
const DOM_DELTA_LINE = 1
const PAGE_SCROLL_LINES = 10
export function getTerminalScrollbackRows(options?: {
  agent?: boolean
  memoryBudgetMb?: number
}): number {
  if (!options) return 10_000
  const budget = options.memoryBudgetMb ?? 1536
  if (budget <= 1536) return options.agent ? 6_000 : 3_000
  if (budget <= 3072) return options.agent ? 8_000 : 5_000
  return options.agent ? 10_000 : 6_000
}

export function shouldScrollHostScrollback(
  bufferType: 'normal' | 'alternate',
  shiftKey: boolean,
): boolean {
  if (shiftKey) return true
  return bufferType !== 'alternate'
}

export function normalizePastedText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/\n/g, '\r')
}

export function formatDroppedPaths(paths: string[]): string {
  const formatted = paths
    .filter(Boolean)
    .map((p) => (/\s/.test(p) ? `"${p}"` : p))
    .join(' ')
  return formatted ? `${formatted} ` : ''
}

export type WheelScrollStep = { lines: number; remainderPx: number }

/**
 * Converts one wheel event into whole lines. Pixel deltas below a line are carried in
 * `remainderPx` instead of being rounded up: a macOS trackpad sends many tiny momentum deltas,
 * and rounding each one up to a line scrolled several times too fast. Line and page deltas
 * (mouse wheels that report notches) are used as they come and drop any carried remainder.
 */
export function getWheelScrollStep(
  event: WheelLike,
  lineHeight: number,
  remainderPx = 0,
): WheelScrollStep {
  if (event.deltaY === 0) return { lines: 0, remainderPx }

  if (event.deltaMode === DOM_DELTA_LINE) {
    return { lines: Math.trunc(event.deltaY), remainderPx: 0 }
  }

  if (event.deltaMode !== DOM_DELTA_PIXEL) {
    return { lines: Math.sign(event.deltaY) * PAGE_SCROLL_LINES, remainderPx: 0 }
  }

  const safeLineHeight = Number.isFinite(lineHeight) && lineHeight > 0 ? lineHeight : 18
  // Reversing direction starts over, so a swipe back never has to burn the old remainder first.
  const carried = Math.sign(remainderPx) === -Math.sign(event.deltaY) ? 0 : remainderPx
  const totalPx = carried + event.deltaY
  // `|| 0` folds the -0 that a small upward delta truncates to.
  const lines = Math.trunc(totalPx / safeLineHeight) || 0
  return { lines, remainderPx: totalPx - lines * safeLineHeight }
}

/** Per-terminal wheel state: keeps the sub-line pixel remainder between events. */
export function createWheelScrollAccumulator() {
  let remainderPx = 0
  return {
    next(event: WheelLike, lineHeight: number): number {
      const step = getWheelScrollStep(event, lineHeight, remainderPx)
      remainderPx = step.remainderPx
      return step.lines
    },
  }
}
