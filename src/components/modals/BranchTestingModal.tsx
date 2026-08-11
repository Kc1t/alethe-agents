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
  changesSummary: string[]
  testingItems: TestingItem[]
  onStartTesting: () => void
  /** Recebe o resumo já formatado (passou/falhou + notas) pra mandar ao agente — a confirmação de correção é sempre humana, nunca automática. */
  onSendFeedback: (summary: string) => void
}

export function BranchTestingModal({
  open,
  onClose,
  branchName,
  projectName,
  changesSummary,
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
      if (!entry || entry.state === 'pending') return `? ${item.text} (não verificado)`
      if (entry.state === 'pass') return `✓ ${item.text}`
      return `✗ ${item.text}${entry.note.trim() ? ` — ${entry.note.trim()}` : ''}`
    })
    return `Feedback de teste da branch "${branchName}":\n${lines.join('\n')}`
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

        {/* Resumo real das alterações (git diff --name-status target...source) */}
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
              paddingLeft: 18,
              fontSize: 12,
              color: 'var(--fg-muted)',
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
            }}
          >
            {changesSummary.length > 0 ? (
              changesSummary.map((item, i) => <li key={i}>{item}</li>)
            ) : (
              <li>{t('merge.testBriefingEmpty')}</li>
            )}
          </ul>
        </div>

        {/* Procedimento de teste — checklist de confirmação humana. A IA só
            descreve o que testar (nunca afirma que funciona); passou/falhou
            é sempre uma decisão do usuário, marcada aqui item a item. */}
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
