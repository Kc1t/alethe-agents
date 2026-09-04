import { Grip, Library, X } from 'lucide-react'
import { type PointerEvent as ReactPointerEvent } from 'react'

import { AGENT_LIBRARY } from '../../lib/agentLibrary'
import { useT } from '../../lib/i18n'
import type { InstalledAgent } from '../../lib/tauri'
import styles from './AgentCanvasPOC.module.css'
import { LibraryItem } from './LibraryItem'

type AgentLibraryPaletteProps = {
  open: boolean
  setOpen: (open: boolean) => void
  position: { x: number; y: number }
  onDragStart: (event: ReactPointerEvent<HTMLElement>) => void
  installed: InstalledAgent[]
  onInstall: (name: string) => void
}

export function AgentLibraryPalette({
  open,
  setOpen,
  position,
  onDragStart,
  installed,
  onInstall,
}: AgentLibraryPaletteProps) {
  const t = useT()
  return (
    <div
      className={open ? styles.agentPalette : styles.agentPaletteCollapsed}
      data-no-pan
      style={{ left: position.x, top: position.y }}
    >
      {open ? (
        <>
          <div className={styles.paletteHeader} onPointerDown={onDragStart}>
            <span className={styles.libraryTitle}>
              <Grip size={13} /> {t('ws.library')}
            </span>
            <span className={styles.paletteCount}>{AGENT_LIBRARY.length}</span>
            <button
              type="button"
              className={styles.chipAction}
              onClick={() => setOpen(false)}
              title={t('ws.collapseLibrary')}
              aria-label={t('ws.collapseLibrary')}
            >
              <X size={13} />
            </button>
          </div>
          <div className={styles.libraryHint}>{t('ws.libraryHint')}</div>
          <div className={styles.paletteGrid}>
            {AGENT_LIBRARY.map((tpl) => (
              <LibraryItem
                key={tpl.name}
                template={tpl}
                installed={installed.some((a) => a.name === tpl.name)}
                onInstall={() => onInstall(tpl.name)}
              />
            ))}
          </div>
        </>
      ) : (
        <button
          type="button"
          className={styles.paletteLauncher}
          onClick={() => setOpen(true)}
          onPointerDown={onDragStart}
          title={t('ws.openAgentLibrary')}
        >
          <Library size={14} />
          {t('ws.library')}
          <span className={styles.paletteCount}>{AGENT_LIBRARY.length}</span>
        </button>
      )}
    </div>
  )
}
