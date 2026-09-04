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

/** What a wheel event should do, given what the terminal and the running app are doing. */
export type WheelAction =
  /** Scroll the host's own scrollback. */
  | 'host'
  /** Hand the event to xterm, which forwards it to an app that asked for mouse events. */
  | 'app'
  /** Swallow it. See `decideWheelAction`. */
  | 'ignore'

/**
 * Decides what a wheel turn means.
 *
 * The `ignore` case is the one worth explaining, because it looks like doing nothing and is in fact
 * a fix. When a full-screen app is running and has NOT asked for mouse events, xterm's default is to
 * convert the wheel into cursor-key sequences and send them to the app — there is no scrollback in
 * the alternate buffer, so it offers the next best thing.
 *
 * For an app that reads arrows as "scroll", that is helpful. For one that reads them as input it is
 * silent typing: scrolling in Claude Code moved through its prompt history instead of the view.
 * Confirmed from the recorded PTY streams on this machine — Claude Code enters the alternate screen
 * seven times in one session and never once enables mouse tracking, while OpenCode enables it nine
 * times and therefore scrolls correctly on its own.
 *
 * So: forward to an app that asked for the mouse, and otherwise swallow the event rather than turn a
 * scroll gesture into keystrokes the user never typed. Shift always forces host scrollback, the
 * iTerm2 / Windows Terminal convention.
 */
export function decideWheelAction(options: {
  bufferType: 'normal' | 'alternate'
  shiftKey: boolean
  mouseTrackingActive: boolean
}): WheelAction {
  if (options.shiftKey) return 'host'
  if (options.bufferType !== 'alternate') return 'host'
  return options.mouseTrackingActive ? 'app' : 'ignore'
}

export function normalizePastedText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/\n/g, '\r')
}

export function formatDroppedPaths(paths: string[]): string {
  const formatted = paths
    .filter(Boolean)
    .map((p) => (/\s|\\/.test(p) && !p.startsWith('"') ? `"${p}"` : p))
    .join(' ')
  return formatted ? `${formatted} ` : ''
}

export function getWheelScrollLines(event: WheelLike, lineHeight: number): number {
  if (event.deltaY === 0) return 0

  if (event.deltaMode === DOM_DELTA_LINE) {
    return Math.trunc(event.deltaY)
  }

  if (event.deltaMode !== DOM_DELTA_PIXEL) {
    return Math.sign(event.deltaY) * PAGE_SCROLL_LINES
  }

  const safeLineHeight = Number.isFinite(lineHeight) && lineHeight > 0 ? lineHeight : 18
  const lines = Math.ceil(Math.abs(event.deltaY) / safeLineHeight)
  return Math.sign(event.deltaY) * Math.max(1, lines)
}
