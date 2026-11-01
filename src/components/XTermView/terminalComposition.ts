export const TEXTAREA_IDLE_RESET_MS = 150

/**
 * xterm's CompositionHelper diffs its hidden textarea to find what a dead key or IME committed, and
 * never empties it. Stale text left there can be re-sent as input later (`açãão`, old text
 * reappearing), notably on WebKitGTK. Empty it once typing has been idle for longer than xterm's own
 * 0 ms timers, and never while a composition is open.
 */
export function keepTerminalTextareaClean(
  textarea: HTMLTextAreaElement,
  idleMs: number = TEXTAREA_IDLE_RESET_MS,
): () => void {
  let composing = false
  let timer: number | null = null

  const schedule = () => {
    if (timer !== null) window.clearTimeout(timer)
    timer = window.setTimeout(() => {
      timer = null
      if (!composing && textarea.value !== '') textarea.value = ''
    }, idleMs)
  }
  const onCompositionStart = () => {
    composing = true
    schedule()
  }
  const onCompositionEnd = () => {
    composing = false
    schedule()
  }

  const events = ['keydown', 'input', 'compositionupdate'] as const
  textarea.addEventListener('compositionstart', onCompositionStart)
  textarea.addEventListener('compositionend', onCompositionEnd)
  for (const name of events) textarea.addEventListener(name, schedule)

  return () => {
    if (timer !== null) window.clearTimeout(timer)
    textarea.removeEventListener('compositionstart', onCompositionStart)
    textarea.removeEventListener('compositionend', onCompositionEnd)
    for (const name of events) textarea.removeEventListener(name, schedule)
  }
}
