import {
  Check,
  ChevronLeft,
  ChevronRight,
  MessageSquare,
  Play,
  RefreshCw,
  ShieldCheck,
  X,
} from 'lucide-react'
import { useEffect, useState } from 'react'

import { useT } from '../../lib/i18n'
import type { MergeOutcome } from '../../lib/tauri'
import type { Theme } from '../../lib/types'
import type { MergePhase } from '../../stores/mergeStore'
import { AgentIcon } from '../icons/AgentIcons'
import {
  deriveCardStatus,
  type GateResult,
  type PendingMergeCard,
} from '../ProjectSidebar/SidebarMergePanel'
import panelStyles from '../ProjectSidebar/SidebarMergePanel.module.css'
import controls from './controls.module.css'
import styles from './MergeCenterModal.module.css'
import { Modal } from './Modal'

export type MergeCenterModalProps = {
  open: boolean
  onClose: () => void
  /** All VISIBLE pendingMerges (every project, same order as the sidebar)
   *  — pagination crosses projects even when the tree that opened the popup
   *  only shows the active project. */
  items: PendingMergeCard[]
  initialIndex: number
  gateStatus: Record<string, GateResult>
  terminalTheme: Theme

  mergePhase: MergePhase
  mergeProjectId: string | null
  mergeWorktreeAgentId: string | null
  mergeError: string | null
  mergeOutcome: MergeOutcome | null
  mergeIsFinalizing: boolean
  isMergeBusy: boolean
  onValidateResolution: () => void
  onFinalizeResolution: () => void
  onAbortMerge: () => void

  reviewInputId: string | null
  reviewFeedback: string
  onReviewFeedbackChange: (value: string) => void
  onCancelReview: () => void
  onToggleReview: (item: PendingMergeCard) => void
  onSendReview: (item: PendingMergeCard) => void

  onAccept: (item: PendingMergeCard) => void
  onReject: (item: PendingMergeCard) => void
  onValidate: (item: PendingMergeCard) => void
  validatingId: string | null
  onOpenTest: (item: PendingMergeCard) => void
  onRecheckGate: (item: PendingMergeCard) => void
}

/** Merge Center detail popup — opened from a row in the compact tree
 *  (MergeTree). Shows the same full card (description + 5 actions) that used
 *  to live directly in the sidebar, with pagination across ALL pending
 *  worktrees of ALL projects. No new logic: state and handlers still live
 *  in SidebarMergePanel.tsx, passed down via props. */
export function MergeCenterModal({
  open,
  onClose,
  items,
  initialIndex,
  gateStatus,
  terminalTheme,
  mergePhase,
  mergeProjectId,
  mergeWorktreeAgentId,
  mergeError,
  mergeOutcome,
  mergeIsFinalizing,
  isMergeBusy,
  onValidateResolution,
  onFinalizeResolution,
  onAbortMerge,
  reviewInputId,
  reviewFeedback,
  onReviewFeedbackChange,
  onCancelReview,
  onToggleReview,
  onSendReview,
  onAccept,
  onReject,
  onValidate,
  validatingId,
  onOpenTest,
  onRecheckGate,
}: MergeCenterModalProps) {
  const t = useT()
  const [index, setIndex] = useState(() => Math.min(initialIndex, Math.max(items.length - 1, 0)))

  // Always reopens on the clicked item (or reopened by a nested modal).
  useEffect(() => {
    if (open) setIndex(Math.min(initialIndex, Math.max(items.length - 1, 0)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialIndex])

  // If the current item disappears from the list (integrated/rejected while
  // the popup is open), clamp to the last valid one; if the whole list
  // empties out, close the popup on its own — there's nothing left to page through.
  useEffect(() => {
    if (!open) return
    if (items.length === 0) {
      onClose()
      return
    }
    if (index >= items.length) setIndex(items.length - 1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.length, open])

  const total = items.length
  const item = items[index] ?? null
  if (!item) return null

  const goPrev = () => setIndex((i) => (i - 1 + total) % total)
  const goNext = () => setIndex((i) => (i + 1) % total)

  const isCardActive =
    item.projectId === mergeProjectId && item.worktreeAgentId === mergeWorktreeAgentId
  const showStatusPanel = isCardActive && mergePhase !== 'idle'
  const buttonsDisabled = !isCardActive && isMergeBusy
  const gate = gateStatus[item.id]
  const status = deriveCardStatus(gate, isCardActive, mergePhase)
  const statusToneClass =
    status.tone === 'working'
      ? panelStyles.statusWorking
      : status.tone === 'waiting'
        ? panelStyles.statusWaiting
        : status.tone === 'offline'
          ? panelStyles.statusOffline
          : panelStyles.statusStopped

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={
        <span className={styles.titleRow}>
          <AgentIcon type={item.agentType} size={16} theme={terminalTheme} />
          <span>
            {item.agentName} ({item.projectName})
          </span>
        </span>
      }
      width={480}
      footer={
        <div className={styles.footerRow}>
          <button
            type="button"
            className={controls.iconBtn}
            onClick={goPrev}
            disabled={total <= 1}
            aria-label={t('merge.centerPrev')}
          >
            <ChevronLeft size={14} />
          </button>
          <span className={styles.pagerLabel}>
            {t('merge.centerPagerLabel', { index: index + 1, total })}
          </span>
          <button
            type="button"
            className={controls.iconBtn}
            onClick={goNext}
            disabled={total <= 1}
            aria-label={t('merge.centerNext')}
          >
            <ChevronRight size={14} />
          </button>
        </div>
      }
    >
      <span className={`${panelStyles.statusTag} ${statusToneClass} ${styles.standaloneTag}`}>
        {t(status.key)}
      </span>

      {!showStatusPanel && gate?.stage === 'failed' ? (
        <div className={panelStyles.statusPanel}>
          {gate.detail ? <p className={panelStyles.statusDetail}>{gate.detail}</p> : null}
          <button type="button" className={styles.recheckBtn} onClick={() => onRecheckGate(item)}>
            <RefreshCw size={12} />
            {t('merge.gateRecheck')}
          </button>
        </div>
      ) : null}

      {!showStatusPanel && gate?.stage === 'unverified' ? (
        <div className={panelStyles.statusPanel}>
          <p className={panelStyles.statusDetail}>{t('merge.gateUnverifiedHint')}</p>
        </div>
      ) : null}

      {showStatusPanel ? (
        <div className={panelStyles.statusPanel}>
          {(mergePhase === 'failed' || mergePhase === 'terminal_error') &&
          (mergeError || mergeOutcome?.output) ? (
            <p className={panelStyles.statusDetail}>
              {(mergeError ?? mergeOutcome?.output ?? '').slice(0, 240)}
            </p>
          ) : null}
          {mergePhase === 'resolving' ? (
            <p className={panelStyles.statusDetail}>{t('merge.resolvingHint')}</p>
          ) : null}
          {mergePhase === 'awaiting_review' ? (
            <>
              <p className={panelStyles.statusDetail}>{t('merge.awaitingReviewHint')}</p>
              {mergeOutcome && mergeOutcome.stage !== 'validated' ? (
                <p className={panelStyles.statusDetail}>{mergeOutcome.output.slice(0, 240)}</p>
              ) : null}
              <div className={panelStyles.actionsGrid}>
                <button
                  type="button"
                  className={`${panelStyles.actionBtn} ${panelStyles.btnValidate}`}
                  disabled={mergeIsFinalizing}
                  onClick={onValidateResolution}
                >
                  <ShieldCheck size={12} />
                  <span className={panelStyles.actionBtnLabel}>
                    {mergeIsFinalizing ? t('merge.validating') : t('merge.validate')}
                  </span>
                </button>
                <button
                  type="button"
                  className={`${panelStyles.actionBtn} ${panelStyles.btnAccept}`}
                  disabled={mergeIsFinalizing || mergeOutcome?.stage !== 'validated'}
                  onClick={onFinalizeResolution}
                  title={
                    mergeOutcome?.stage !== 'validated'
                      ? t('merge.validateBeforeIntegrateHint')
                      : undefined
                  }
                >
                  <Check size={12} />
                  <span className={panelStyles.actionBtnLabel}>{t('merge.integrate')}</span>
                </button>
              </div>
            </>
          ) : null}
          {mergePhase !== 'merged' ? (
            <button
              type="button"
              className={`${panelStyles.actionBtn} ${panelStyles.btnAbort}`}
              onClick={onAbortMerge}
            >
              <X size={12} />
              {t('merge.abort')}
            </button>
          ) : null}
        </div>
      ) : reviewInputId === item.id ? (
        <div className={panelStyles.reviewBox}>
          <textarea
            className={panelStyles.reviewTextarea}
            placeholder={t('merge.reviewFeedbackPlaceholder')}
            value={reviewFeedback}
            onChange={(e) => onReviewFeedbackChange(e.target.value)}
          />
          <div className={panelStyles.reviewActions}>
            <button type="button" className={panelStyles.actionBtn} onClick={onCancelReview}>
              {t('merge.reviewFeedbackCancel')}
            </button>
            <button
              type="button"
              className={`${panelStyles.actionBtn} ${panelStyles.btnValidate}`}
              onClick={() => onSendReview(item)}
            >
              {t('merge.reviewFeedbackSend')}
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className={panelStyles.actionsGrid}>
            <button
              type="button"
              className={`${panelStyles.actionBtn} ${panelStyles.btnAccept}`}
              disabled={buttonsDisabled}
              onClick={() => onAccept(item)}
              title={t('merge.integrateTooltip')}
            >
              <Check size={12} />
              <span className={panelStyles.actionBtnLabel}>{t('merge.integrate')}</span>
            </button>

            <button
              type="button"
              className={`${panelStyles.actionBtn} ${panelStyles.btnReject}`}
              disabled={buttonsDisabled}
              onClick={() => onReject(item)}
              title={t('merge.rejectTooltip')}
            >
              <X size={12} />
              <span className={panelStyles.actionBtnLabel}>{t('merge.reject')}</span>
            </button>

            <button
              type="button"
              className={`${panelStyles.actionBtn} ${panelStyles.btnValidate}`}
              disabled={buttonsDisabled || validatingId === item.id}
              onClick={() => onValidate(item)}
              title={t('merge.validateTooltip')}
            >
              <ShieldCheck size={12} />
              <span className={panelStyles.actionBtnLabel}>
                {validatingId === item.id ? t('merge.validating') : t('merge.validate')}
              </span>
            </button>
          </div>

          <div className={styles.secondaryGrid}>
            <button
              type="button"
              className={`${panelStyles.actionBtn} ${panelStyles.btnTest}`}
              disabled={buttonsDisabled}
              onClick={() => onOpenTest(item)}
              title={t('merge.testTooltip')}
            >
              <Play size={12} />
              <span className={panelStyles.actionBtnLabel}>{t('merge.test')}</span>
            </button>

            <button
              type="button"
              className={`${panelStyles.actionBtn} ${panelStyles.btnReview}`}
              disabled={buttonsDisabled}
              onClick={() => onToggleReview(item)}
              title={t('merge.reviewTooltip')}
            >
              <MessageSquare size={12} />
              <span className={panelStyles.actionBtnLabel}>{t('merge.review')}</span>
            </button>
          </div>
        </>
      )}
    </Modal>
  )
}
