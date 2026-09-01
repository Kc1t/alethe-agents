/** Collect a bounded plain-text transcript from an xterm-like buffer. */
export function collectTerminalContextText(
  terminal: {
    hasSelection: () => boolean
    getSelection: () => string
    buffer: {
      active: {
        length: number
        getLine: (
          index: number,
        ) => { translateToString: (trimRight?: boolean) => string } | undefined
      }
    }
  },
  maxLines = 200,
): string {
  if (terminal.hasSelection()) {
    const selection = terminal.getSelection().trimEnd()
    if (selection) return selection
  }
  const buffer = terminal.buffer.active
  const end = buffer.length
  const start = Math.max(0, end - maxLines)
  const lines: string[] = []
  for (let i = start; i < end; i += 1) {
    lines.push(buffer.getLine(i)?.translateToString(true) ?? '')
  }
  return lines.join('\n').replace(/\s+$/u, '')
}
