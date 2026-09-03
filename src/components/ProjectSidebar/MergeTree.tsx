import { AlertTriangle, GitBranch, X } from 'lucide-react'
import { useState } from 'react'

import { type MessageKey, useT } from '../../lib/i18n'
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
  // Which warning is expanded, if any. Local state: it is a transient detail view, not something
  // any other part of the app needs to know about.
  //
  // Declared before the early return below, not after it. Sitting after it, the hook was skipped on
  // every render where the list was empty — so the first render with items had one more hook than
  // the previous one, which React refuses outright and takes the panel down with. The list going
  // from empty to non-empty is the ordinary case here, not an edge one.
  const [openWarning, setOpenWarning] = useState<{
    item: PendingMergeCard
    gate: GateResult
    status: { key: MessageKey }
  } | null>(null)

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
        const gate = gateStatus[item.id]
        // Only a stage that actually went wrong gets the warning affordance. "ready" and the
        // in-progress stages are not problems, and marking them would make the icon meaningless.
        const warning = gate?.stage === 'failed' || gate?.stage === 'unverified' ? gate : null
        return (
          // A row, not a button: it holds two independent actions now, and a button inside a
          // button is invalid HTML that browsers resolve unpredictably.
          <div key={item.id} className={styles.node}>
            <button type="button" className={styles.nodeMain} onClick={() => onSelect(item)}>
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
            {warning ? (
              <button
                type="button"
                className={`${styles.nodeWarning} ${
                  warning.stage === 'failed' ? styles.nodeWarningFailed : ''
                }`}
                title={t(status.key)}
                aria-label={t(status.key)}
                onClick={() => setOpenWarning({ item, gate: warning, status })}
              >
                <AlertTriangle size={13} />
              </button>
            ) : null}
          </div>
        )
      })}
      {openWarning ? (
        <div className={styles.warningPopup} role="dialog" aria-modal="false">
          <div className={styles.warningHeader}>
            <AlertTriangle size={13} />
            <strong>{openWarning.item.agentName}</strong>
            <button
              type="button"
              className={styles.warningClose}
              onClick={() => setOpenWarning(null)}
              aria-label={t('common.close')}
            >
              <X size={12} />
            </button>
          </div>
          <span className={styles.warningStatus}>{t(openWarning.status.key)}</span>
          {/* `detail` is whatever the gate reported — the actual reason. Without it the popup
              would only repeat the label already visible in the row. */}
          {openWarning.gate.detail ? (
            <pre className={styles.warningDetail}>{openWarning.gate.detail}</pre>
          ) : (
            <span className={styles.warningEmpty}>{t('merge.gateNoDetail')}</span>
          )}
        </div>
      ) : null}
      <div className={styles.mainNode}>
        <span className={styles.mainDot} />
        <GitBranch size={11} />
        <span>{t('merge.treeMainNode')}</span>
      </div>
    </div>
  )
}
