import { useEffect, useRef, useState } from 'react'

import { pickDirectory } from '../../lib/dialog'
import { useT } from '../../lib/i18n'
import { listWslDistros, wslDistroHome } from '../../lib/tauri'
import { wslDistroRootUnc } from '../../lib/wsl'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import styles from './WslPathPicker.module.css'

type WslPathPickerProps = {
  onPick: (path: string) => void
  compact?: boolean
}

export function WslPathPicker({ onPick, compact = false }: WslPathPickerProps) {
  const t = useT()
  const pushToast = useUiStore((s) => s.pushToast)
  const wslEnabled = useProjectsStore((s) => s.preferences.enabledFeatures.wsl)
  const [distros, setDistros] = useState<string[]>([])
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!wslEnabled) return
    let alive = true
    void listWslDistros()
      .then((list) => {
        if (alive) setDistros(list)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [wslEnabled])

  useEffect(() => {
    if (!open) return
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
    }
    document.addEventListener('pointerdown', closeOnOutsidePointer)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [open])

  if (!wslEnabled || distros.length === 0) return null

  const choose = async (distro: string) => {
    setOpen(false)
    setBusy(true)
    try {
      let start: string | null
      try {
        start = (await wslDistroHome(distro)) ?? wslDistroRootUnc(distro)
      } catch {
        start = wslDistroRootUnc(distro)
        pushToast({ title: t('term.wslPickFailed'), body: t('term.wslPickFailedBody', { distro }) })
      }
      if (!start) return
      const picked = await pickDirectory({ defaultPath: start }).catch(() => null)
      if (picked) onPick(picked)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={styles.root} ref={rootRef}>
      <button
        type="button"
        className={`${styles.trigger} ${compact ? styles.triggerCompact : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title={t('term.wslPickTitle')}
        disabled={busy}
        onClick={() => setOpen((current) => !current)}
      >
        {t('term.wslPick')}
      </button>
      {open ? (
        <div className={styles.menu} role="menu" aria-label={t('term.wslPickTitle')}>
          {distros.map((distro) => (
            <button
              key={distro}
              type="button"
              role="menuitem"
              className={styles.item}
              onClick={() => void choose(distro)}
            >
              {distro}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
