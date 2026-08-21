import { useState } from 'react'
import {
  Play,
  Send,
  CheckCircle2,
  XCircle,
  Circle,
  FileCode,
  Layers,
  Wrench,
  ScanSearch,
  Activity,
  Loader2,
} from 'lucide-react'

import { useT, type MessageKey } from '../../lib/i18n'
import { Modal } from './Modal'
import controls from './controls.module.css'

export type ProcedureCategory = 'setup' | 'action' | 'verify'
export type TestingItem = { id: string; text: string; category?: string }
type FeedbackState = 'pending' | 'pass' | 'fail'

const CATEGORY_META: Record<
  ProcedureCategory,
  { icon: typeof Wrench; color: string; labelKey: MessageKey }
> = {
  setup: { icon: Wrench, color: 'var(--fg-faint)', labelKey: 'merge.testCategorySetup' },
  action: { icon: Play, color: 'var(--accent)', labelKey: 'merge.testCategoryAction' },
  verify: {
    icon: ScanSearch,
    color: 'var(--status-working)',
    labelKey: 'merge.testCategoryVerify',
  },
}

function isProcedureCategory(value: string | undefined): value is ProcedureCategory {
  return value === 'setup' || value === 'action' || value === 'verify'
}

export type BranchTestingModalProps = {
  open: boolean
  onClose: () => void
  branchName: string
  projectName: string
  changesSummary: Array<string | { path: string; status: string; additions?: number; deletions?: number }>
  /** Shield layer 4 — 'idle' when the project has no `healthCheckCommand`
   *  configured (the section shows only a hint, never triggers on its own). */
  healthState: 'idle' | 'loading' | 'ok' | 'warn'
  healthSummary: string[]
  testingItems: TestingItem[]
  onStartTesting: () => void
  /** Receives the already-formatted summary (passed/failed + notes) to send to the agent — confirming a fix is always a human decision, never automatic. */
  onSendFeedback: (summary: string) => void
}

export function BranchTestingModal({
  open,
  onClose,
  branchName,
  projectName,
  changesSummary,
  healthState,
  healthSummary,
  testingItems,
  onStartTesting,
  onSendFeedback,
}: BranchTestingModalProps) {
  const t = useT()
  const [feedback, setFeedback] = useState<Record<string, { state: FeedbackState; note: string }>>(
    {},
  )

  const setItemState = (id: string, state: FeedbackState) => {
    setFeedback((prev) => ({ ...prev, [id]: { state, note: prev[id]?.note ?? '' } }))
  }
  const setItemNote = (id: string, note: string) => {
    setFeedback((prev) => ({ ...prev, [id]: { state: prev[id]?.state ?? 'fail', note } }))
  }

  const hasAnyFeedback = testingItems.some(
    (item) => (feedback[item.id]?.state ?? 'pending') !== 'pending',
  )

  const buildFeedbackSummary = () => {
    const lines = testingItems.map((item) => {
      const entry = feedback[item.id]
      if (!entry || entry.state === 'pending')
        return `? ${item.text} (${t('merge.testFeedbackUnverified')})`
      if (entry.state === 'pass') return `✓ ${item.text}`
      return `✗ ${item.text}${entry.note.trim() ? ` — ${entry.note.trim()}` : ''}`
    })
    return `${t('merge.testFeedbackSummaryHeader', { branch: branchName })}\n${lines.join('\n')}`
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('merge.testModalTitle', { branch: branchName })}
      width={560}
      footer={
        <>
          <button type="button" className={controls.btn} onClick={onClose}>
            {t('merge.testModalClose')}
          </button>
          <button
            type="button"
            className={controls.btn}
            disabled={!hasAnyFeedback}
            onClick={() => onSendFeedback(buildFeedbackSummary())}
            title={t('merge.testSendFeedbackTooltip')}
          >
            <Send size={14} style={{ marginRight: 6 }} />
            {t('merge.testSendFeedback')}
          </button>
          <button
            type="button"
            className={`${controls.btn} ${controls.btnPrimary}`}
            onClick={() => {
              onStartTesting()
              onClose()
            }}
          >
            <Play size={14} style={{ marginRight: 6 }} />
            {t('merge.testModalStart')}
          </button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* Banner do Projeto e Ramo */}
        <div
          style={{
            padding: '10px 14px',
            borderRadius: 'var(--radius-md)',
            background: 'var(--bg-sunken)',
            border: '1px solid var(--border)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            fontSize: 12,
          }}
        >
          <div>
            <span style={{ color: 'var(--fg-muted)', marginRight: 6 }}>
              {t('merge.testModalProjectLabel')}
            </span>
            <strong style={{ color: 'var(--fg)' }}>{projectName}</strong>
          </div>
          <div>
            <span style={{ color: 'var(--fg-muted)', marginRight: 6 }}>
              {t('merge.testModalBranchLabel')}
            </span>
            <code style={{ color: 'var(--accent)', fontWeight: 600 }}>{branchName}</code>
          </div>
        </div>

        {/* Real change summary (git diff --name-status target...source) */}
        <div>
          <h4
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: 'var(--fg)',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              marginBottom: 8,
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
            }}
          >
            <FileCode size={14} color="var(--accent)" />
            {t('merge.testModalChangesTitle')}
          </h4>
          <ul
            style={{
              margin: 0,
              padding: 0,
              listStyle: 'none',
              fontSize: 12,
              color: 'var(--fg-muted)',
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
              maxHeight: 220,
              overflowY: 'auto',
            }}
          >
            {changesSummary.length > 0 ? (
              changesSummary.map((item, i) => {
                if (typeof item === 'string') {
                  const match = /^([AMDRC?])\s+(.+)$/.exec(item.trim())
                  const statusChar = match ? match[1] : ''
                  const filePath = match ? match[2] : item

                  let badgeColor = 'var(--fg-muted)'
                  let badgeBg = 'var(--bg-elevated)'
                  let badgeLabel = statusChar

                  if (statusChar === 'A' || statusChar === '?') {
                    badgeColor = 'var(--status-working, #10b981)'
                    badgeBg = 'rgba(16, 185, 129, 0.12)'
                    badgeLabel = '+ Added'
                  } else if (statusChar === 'D') {
                    badgeColor = 'var(--status-offline, #ef4444)'
                    badgeBg = 'rgba(239, 68, 68, 0.12)'
                    badgeLabel = '- Deleted'
                  } else if (statusChar === 'M') {
                    badgeColor = 'var(--accent, #38bdf8)'
                    badgeBg = 'rgba(56, 189, 248, 0.12)'
                    badgeLabel = '~ Modified'
                  } else if (statusChar === 'R') {
                    badgeColor = 'var(--status-paused, #f59e0b)'
                    badgeBg = 'rgba(245, 158, 11, 0.12)'
                    badgeLabel = '→ Renamed'
                  }

                  return (
                    <li
                      key={i}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        padding: '4px 8px',
                        background: 'var(--bg-sunken)',
                        borderRadius: 'var(--radius-sm)',
                        border: '1px solid var(--border)',
                        fontFamily: 'var(--font-mono)',
                        fontSize: 11,
                      }}
                    >
                      {statusChar ? (
                        <span
                          style={{
                            padding: '1px 6px',
                            borderRadius: 4,
                            fontWeight: 600,
                            fontSize: 10,
                            color: badgeColor,
                            background: badgeBg,
                            flexShrink: 0,
                          }}
                        >
                          {badgeLabel}
                        </span>
                      ) : null}
                      <span
                        style={{
                          color: 'var(--fg)',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          flex: 1,
                        }}
                        title={filePath}
                      >
                        {filePath}
                      </span>
                    </li>
                  )
                }

                const isAdded = item.status === 'A' || item.status === '?'
                const isDeleted = item.status === 'D'
                const isModified = item.status === 'M'
                const isRenamed = item.status === 'R'

                const badgeColor = isAdded
                  ? 'var(--status-working, #10b981)'
                  : isDeleted
                    ? 'var(--status-offline, #ef4444)'
                    : isModified
                      ? 'var(--accent, #38bdf8)'
                      : isRenamed
                        ? 'var(--status-paused, #f59e0b)'
                        : 'var(--fg-muted)'

                const badgeBg = isAdded
                  ? 'rgba(16, 185, 129, 0.12)'
                  : isDeleted
                    ? 'rgba(239, 68, 68, 0.12)'
                    : isModified
                      ? 'rgba(56, 189, 248, 0.12)'
                      : isRenamed
                        ? 'rgba(245, 158, 11, 0.12)'
                        : 'var(--bg-elevated)'

                const badgeLabel = isAdded
                  ? '+ Added'
                  : isDeleted
                    ? '- Deleted'
                    : isModified
                      ? '~ Modified'
                      : isRenamed
                        ? '→ Renamed'
                        : item.status

                return (
                  <li
                    key={i}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '4px 8px',
                      background: 'var(--bg-sunken)',
                      borderRadius: 'var(--radius-sm)',
                      border: '1px solid var(--border)',
                      fontFamily: 'var(--font-mono)',
                      fontSize: 11,
                    }}
                  >
                    <span
                      style={{
                        padding: '1px 6px',
                        borderRadius: 4,
                        fontWeight: 600,
                        fontSize: 10,
                        color: badgeColor,
                        background: badgeBg,
                        flexShrink: 0,
                      }}
                    >
                      {badgeLabel}
                    </span>
                    <span
                      style={{
                        color: 'var(--fg)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        flex: 1,
                      }}
                      title={item.path}
                    >
                      {item.path}
                    </span>
                    {(item.additions !== undefined || item.deletions !== undefined) && (
                      <span
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 6,
                          fontSize: 10,
                          fontWeight: 700,
                          fontFamily: 'var(--font-mono)',
                          flexShrink: 0,
                        }}
                      >
                        {item.additions !== undefined && item.additions > 0 ? (
                          <span style={{ color: 'var(--status-working, #10b981)' }}>
                            +{item.additions}
                          </span>
                        ) : null}
                        {item.deletions !== undefined && item.deletions > 0 ? (
                          <span style={{ color: 'var(--status-offline, #ef4444)' }}>
                            -{item.deletions}
                          </span>
                        ) : null}
                      </span>
                    )}
                  </li>
                )
              })
            ) : (
              <li style={{ padding: '8px 0', color: 'var(--fg-muted)' }}>
                {t('merge.testBriefingEmpty')}
              </li>
            )}
          </ul>
        </div>

        {/* Shield layer 4 — actually boots the app in an isolated environment
            (Test/Integrate) and shows the real result, not a promise. */}
        <div>
          <h4
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: 'var(--fg)',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              marginBottom: 8,
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
            }}
          >
            {healthState === 'loading' ? (
              <Loader2 size={14} color="var(--fg-muted)" />
            ) : (
              <Activity
                size={14}
                color={
                  healthState === 'ok'
                    ? 'var(--status-working)'
                    : healthState === 'warn'
                      ? 'var(--status-offline)'
                      : 'var(--fg-faint)'
                }
              />
            )}
            {t('merge.testHealthTitle')}
          </h4>
          <ul
            style={{
              margin: 0,
              paddingLeft: 18,
              fontSize: 12,
              color: 'var(--fg-muted)',
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
            }}
          >
            {healthSummary.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
        </div>

        {/* Test procedure — human confirmation checklist. The AI only
            describes what to test (never claims it works); pass/fail is
            always a user decision, marked here item by item. */}
        <div>
          <h4
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: 'var(--fg)',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              marginBottom: 8,
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
            }}
          >
            <Layers size={14} color="var(--status-working)" />
            {t('merge.testModalStepsTitle')}
          </h4>
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              padding: '10px 12px',
              borderRadius: 'var(--radius-md)',
              background: 'var(--bg-sunken)',
              border: '1px solid var(--border)',
            }}
          >
            {testingItems.length > 0 ? (
              testingItems.map((item) => {
                const entry = feedback[item.id]
                const state: FeedbackState = entry?.state ?? 'pending'
                return (
                  <div key={item.id} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <div
                      style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 12 }}
                    >
                      {state === 'pass' ? (
                        <CheckCircle2
                          size={15}
                          color="var(--status-working)"
                          style={{ marginTop: 2, flexShrink: 0 }}
                        />
                      ) : state === 'fail' ? (
                        <XCircle
                          size={15}
                          color="var(--status-offline)"
                          style={{ marginTop: 2, flexShrink: 0 }}
                        />
                      ) : (
                        <Circle
                          size={15}
                          color="var(--fg-faint)"
                          style={{ marginTop: 2, flexShrink: 0 }}
                        />
                      )}
                      {isProcedureCategory(item.category)
                        ? (() => {
                            const meta = CATEGORY_META[item.category as ProcedureCategory]
                            const CategoryIcon = meta.icon
                            return (
                              <span
                                title={t(meta.labelKey)}
                                style={{
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  width: 18,
                                  height: 18,
                                  borderRadius: 4,
                                  flexShrink: 0,
                                  marginTop: 1,
                                  background: 'var(--bg-elevated)',
                                  border: '1px solid var(--border)',
                                }}
                              >
                                <CategoryIcon size={11} color={meta.color} />
                              </span>
                            )
                          })()
                        : null}
                      <span style={{ color: 'var(--fg)', flex: 1 }}>{item.text}</span>
                      <button
                        type="button"
                        className={controls.btn}
                        style={{ padding: '2px 8px', fontSize: 11 }}
                        onClick={() => setItemState(item.id, 'pass')}
                        title={t('merge.testItemPass')}
                        aria-pressed={state === 'pass'}
                      >
                        {t('merge.testItemPass')}
                      </button>
                      <button
                        type="button"
                        className={controls.btn}
                        style={{ padding: '2px 8px', fontSize: 11 }}
                        onClick={() => setItemState(item.id, 'fail')}
                        title={t('merge.testItemFail')}
                        aria-pressed={state === 'fail'}
                      >
                        {t('merge.testItemFail')}
                      </button>
                    </div>
                    {state === 'fail' ? (
                      <input
                        type="text"
                        className={controls.input}
                        style={{ marginLeft: 23, fontSize: 11, padding: '4px 8px' }}
                        placeholder={t('merge.testItemNotePlaceholder')}
                        value={entry?.note ?? ''}
                        onChange={(e) => setItemNote(item.id, e.target.value)}
                      />
                    ) : null}
                  </div>
                )
              })
            ) : (
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 12 }}>
                <CheckCircle2
                  size={15}
                  color="var(--status-working)"
                  style={{ marginTop: 2, flexShrink: 0 }}
                />
                <span style={{ color: 'var(--fg)' }}>{t('merge.testBriefingNoCommands')}</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </Modal>
  )
}
