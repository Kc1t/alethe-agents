// The OSC branch (`\x1b]...`) requires an explicit terminator (BEL or ESC-backslash/ST) and never
// crosses a bare ESC — an unterminated OSC sequence (e.g. one split across two PTY data chunks, or
// using a terminator this pattern doesn't recognize) is deliberately left unmatched rather than
// greedily consuming the rest of the log, which an earlier, unbounded version of this pattern did.
const ANSI_ESCAPE_PATTERN = /\x1b(?:\[[0-9;?]*[a-zA-Z]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[()][A-Z0-9])/g

/**
 * Turns raw PTY output (as captured by `listenPtyData`, before any real terminal renders it) into
 * plain, readable text for a small non-interactive log box: strips ANSI escape/color codes, and
 * collapses carriage-return redraws (an animated `npm`/`wrangler` progress line writes the same
 * line many times separated by `\r` — keeping only the text after each line's last `\r` shows its
 * final state instead of every intermediate frame concatenated together).
 */
export function plainTextFromPtyLog(raw: string): string {
  const withoutAnsi = raw.replace(ANSI_ESCAPE_PATTERN, '')
  return withoutAnsi
    .split('\n')
    .map((line) => {
      const lastCr = line.lastIndexOf('\r')
      return lastCr === -1 ? line : line.slice(lastCr + 1)
    })
    .join('\n')
}
