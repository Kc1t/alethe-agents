import { GitBranch } from 'lucide-react'

import { useT } from '../../lib/i18n'
import type { Theme } from '../../lib/types'
import type { MergePhase } from '../../stores/mergeStore'
import { AgentIcon } from '../icons/AgentIcons'
import styles from './MergeTree.module.css'
import { deriveCardStatus, type GateResult, type PendingMergeCard } from './SidebarMergePanel'

type MergeTreeProps = {
  /** Already filtered by the parent: `visiblePendingMerges` for the active
   *  project — the tree swaps on its own when the user switches project in the sidebar. */
  items: PendingMergeCard[]
  gateStatus: Record<string, GateResult>
  mergePhase: MergePhase
  activeCardId: string | null
  terminalTheme: Theme
  /** true when there are pending items in OTHER projects besides the active
   *  one — used only for the empty-state text, the panel's global badge already shows the total. */
  hasOtherProjectsPending: boolean
  onSelect: (item: PendingMergeCard) => void
}

const TONE_CLASS: Record<'working' | 'waiting' | 'offline' | 'stopped', string> = {
  working: styles.toneWorking,
  waiting: styles.toneWaiting,
  offline: styles.toneOffline,
  stopped: styles.toneStopped,
}

/** Compact tree: a status dot + agent icon/name + short status per worktree,
 *  connected by a decorative line down to a fixed "main" node at the end —
 *  represents the active project's open terminals/worktrees, not real git
 *  topology (no ahead/behind). Clicking a row opens the usual detail popup
 *  (MergeCenterModal) with the full card. */
export function MergeTree({
  items,
  gateStatus,
  mergePhase,
  activeCardId,
  terminalTheme,
  hasOtherProjectsPending,
  onSelect,
}: MergeTreeProps) {
  const t = useT()

  if (items.length === 0) {
    return (
      <div className={styles.emptyState}>
        {hasOtherProjectsPending ? t('merge.treeEmptyForProject') : t('merge.panelEmpty')}
      </div>
    )
  }

  return (
    <div className={styles.tree}>
      <div className={styles.trunk} />
      {items.map((item) => {
        const status = deriveCardStatus(gateStatus[item.id], item.id === activeCardId, mergePhase)
        return (
          <button
            key={item.id}
            type="button"
            className={styles.node}
            onClick={() => onSelect(item)}
          >
            <span className={styles.connector} />
            <span className={`${styles.dot} ${TONE_CLASS[status.tone]}`} />
            <span className={styles.nodeContent}>
              <span className={styles.nodeIcon}>
                <AgentIcon type={item.agentType} size={14} theme={terminalTheme} />
              </span>
              <span className={styles.nodeText}>
                <span className={styles.nodeName}>{item.agentName}</span>
                <span className={styles.nodeStatus}>{t(status.key)}</span>
              </span>
            </span>
          </button>
        )
      })}
      <div className={styles.mainNode}>
        <span className={styles.mainDot} />
        <GitBranch size={11} />
        <span>{t('merge.treeMainNode')}</span>
      </div>
    </div>
  )
}
