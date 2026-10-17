/** Route clipboard input through bounded writes before xterm sends it whole through onData. */
export function captureTerminalPaste(
  container: HTMLElement,
  onPaste: (event: ClipboardEvent) => void,
): () => void {
  const handler = (event: ClipboardEvent) => {
    event.preventDefault()
    event.stopImmediatePropagation()
    onPaste(event)
  }
  container.addEventListener('paste', handler, true)
  return () => container.removeEventListener('paste', handler, true)
}
