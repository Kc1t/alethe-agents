import { Maximize2 } from 'lucide-react'
import { type MutableRefObject } from 'react'

import type { CodexWorker } from '../../lib/agentCanvasUtils'
import { useT } from '../../lib/i18n'
import { CodexIcon } from '../icons/AgentIcons'
import styles from './AgentCanvasPOC.module.css'

type CodexWorkerCardProps = {
  worker: CodexWorker
  onOpen: (ptyId: string) => void
                                                                       
  cardRefs: MutableRefObject<Map<string, HTMLDivElement>>
}

/** Real Codex worker card; clicking expands the full terminal. */
export function CodexWorkerCard({ worker: w, onOpen, cardRefs }: CodexWorkerCardProps) {
  const t = useT()
  return (
    <div
      ref={(el) => {
        if (el) cardRefs.current.set(w.ptyId, el)
        else cardRefs.current.delete(w.ptyId)
      }}
      className={styles.codexCard}
      role="button"
      tabIndex={0}
      onClick={() => onOpen(w.ptyId)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onOpen(w.ptyId)
      }}
    >
      <div className={styles.cardHeader}>
        <span className={styles.codexType}>
          <CodexIcon size={15} /> codex
        </span>
        <span className={w.exitedCode !== null ? styles.statusDone : styles.statusRunning}>
          {w.exitedCode !== null ? `exit ${w.exitedCode}` : 'running'}
        </span>
      </div>
      <div className={styles.cardPrompt}>{w.title}</div>
      {w.result ? <div className={styles.codexResult}>{w.result}</div> : null}
      <div className={styles.codexCardFooter}>
        <span className={styles.cardId}>{w.ptyId}</span>
        <span className={styles.codexExpandHint}>
          <Maximize2 size={11} /> {t('ws.openTerminal')}
        </span>
      </div>
    </div>
  )
}
