import { useOnEscape } from '../../hooks/useOnEscape'
import { useUiStore } from '../../stores/uiStore'
import styles from './FocusOverlay.module.css'

export function FocusOverlay() {
  const focusedTerminalId = useUiStore((s) => s.focusedTerminalId)
  const setFocusedTerminal = useUiStore((s) => s.setFocusedTerminal)

  useOnEscape(
    (e) => {
      e.preventDefault()
      setFocusedTerminal(null)
    },
    Boolean(focusedTerminalId),
    { capture: true },
  )

  if (!focusedTerminalId) return null

  return <div className={styles.backdrop} onClick={() => setFocusedTerminal(null)} />
}
