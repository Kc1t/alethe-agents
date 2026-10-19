/** Larger payloads are dropped: no selection a person makes comes close. */
export const OSC52_MAX_BYTES = 1_000_000

/**
 * The text of an OSC 52 clipboard write (`Pc;Pd`, `Pd` in base64), as TUIs that draw their own
 * selection (mouse mode) send it when text is selected. Null for a clipboard query (`?`), which is
 * never answered, and for anything that is not valid base64 UTF-8.
 */
export function decodeOsc52(data: string): string | null {
  const separator = data.indexOf(';')
  if (separator < 0) return null
  const payload = data.slice(separator + 1).trim()
  if (!payload || payload === '?' || payload.length > (OSC52_MAX_BYTES * 4) / 3 + 4) return null
  try {
    const binary = atob(payload)
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}
