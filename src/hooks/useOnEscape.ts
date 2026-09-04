import { useEffect, useRef } from 'react'

export function useOnEscape(
  handler: (event: KeyboardEvent) => void,
  enabled = true,
  options: { capture?: boolean } = {},
): void {
  const { capture = false } = options
  const savedHandler = useRef(handler)
  savedHandler.current = handler

  useEffect(() => {
    if (!enabled) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') savedHandler.current(event)
    }
    document.addEventListener('keydown', onKeyDown, capture)
    return () => document.removeEventListener('keydown', onKeyDown, capture)
  }, [enabled, capture])
}
