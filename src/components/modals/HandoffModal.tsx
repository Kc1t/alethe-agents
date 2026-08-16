import { useEffect, useMemo, useState } from 'react'

import { useT } from '../../lib/i18n'
import {
  completeAgentHandoff,
  type HandoffDraft,
  type HandoffProvider,
  materializeAgentHandoff,
  prepareAgentHandoff,
} from '../../lib/tauri'
import { AGENT_TYPE_LABELS, UNRESTRICTED_FLAG } from '../../lib/types'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import styles from './HandoffModal.module.css'
import { Modal } from './Modal'

const MAX_HANDOFF_BYTES = 64 * 1024

function targetFor(source: HandoffProvider): HandoffProvider {
  return source === 'claude' ? 'codex' : 'claude'
}

export function HandoffModal() {
  const t = useT()
  const open = useUiStore((state) => state.openModal === 'handoff')
  const context = useUiStore((state) => state.modalContext)
  const closeModal = useUiStore((state) => state.closeModal)
  const setActiveTerminal = useUiStore((state) => state.setActiveTerminal)
  const requestPaneFocus = useUiStore((state) => state.requestPaneFocus)
  const projects = useProjectsStore((state) => state.projects)
  const createTerminal = useProjectsStore((state) => state.createTerminal)
  const unrestrictedDefault = useProjectsStore(
    (state) => state.preferences.alwaysStartUnrestricted,
  )

  const [draft, setDraft] = useState<HandoffDraft | null>(null)
  const [content, setContent] = useState('')
  const [unrestricted, setUnrestricted] = useState(unrestrictedDefault)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const source = context?.agent === 'codex' ? 'codex' : 'claude'
  const target = targetFor(source)
  const projectId = typeof context?.projectId === 'string' ? context.projectId : ''
  const terminalId = typeof context?.terminalId === 'string' ? context.terminalId : ''
  const requestedSessionId =
    typeof context?.sourceSessionId === 'string' ? context.sourceSessionId : undefined
  const project = projects.find((entry) => entry.id === projectId) ?? null
  const terminal = project?.terminals.find((entry) => entry.id === terminalId) ?? null
  const activeTab = terminal?.tabs.find((entry) => entry.id === terminal.activeTabId) ?? terminal?.tabs[0]
  const cwd = activeTab?.cwd || terminal?.cwd || project?.defaultCwd || ''
  const sourceSessionId = requestedSessionId || activeTab?.sessionId
  const byteCount = useMemo(() => new TextEncoder().encode(content).length, [content])
  const warnings = draft
    ? [
        t('handoff.lossPrivate'),
        ...(draft.usedFallback ? [t('handoff.fallbackNewest')] : []),
        ...(draft.omittedEventCount > 0
          ? [t('handoff.lossOmitted', { count: draft.omittedEventCount })]
          : []),
        ...(draft.redactionCount > 0
          ? [t('handoff.lossRedacted', { count: draft.redactionCount })]
          : []),
      ]
    : []

  useEffect(() => {
    if (!open || !cwd) return
    let cancelled = false
    setDraft(null)
    setContent('')
    setError(null)
    setUnrestricted(unrestrictedDefault)
    void prepareAgentHandoff({
      sourceProvider: source,
      targetProvider: target,
      sourceSessionId,
      cwd,
    })
      .then((result) => {
        if (cancelled) return
        setDraft(result)
        setContent(result.content)
      })
      .catch((cause) => {
        if (!cancelled) setError(String(cause))
      })
    return () => {
      cancelled = true
    }
  }, [open, cwd, source, target, sourceSessionId, unrestrictedDefault])

  const continueInTarget = async () => {
    if (!draft || !project || !content.trim() || byteCount > MAX_HANDOFF_BYTES) return
    setBusy(true)
    setError(null)
    let artifact: Awaited<ReturnType<typeof materializeAgentHandoff>> | null = null
    try {
      artifact = await materializeAgentHandoff(content)
      const permissionFlag = unrestricted ? UNRESTRICTED_FLAG[target] : null
      const initialInput = t('handoff.bootstrapPrompt', { path: artifact.contextPath })
      const created = createTerminal(project.id, {
        name: t('handoff.paneName', { agent: AGENT_TYPE_LABELS[target] }),
        cwd: draft.cwd,
        firstTab: {
          type: target,
          cwd: draft.cwd,
          extraArgs: permissionFlag ? [permissionFlag] : [],
          initialInput,
          handoff: {
            id: artifact.handoffId,
            contextDir: artifact.contextDir,
            contextPath: artifact.contextPath,
            sourceProvider: source,
            sourceSessionId: draft.sourceSessionId,
          },
        },
      })
      setActiveTerminal(project.id, created.id)
      requestPaneFocus(created.id)
      closeModal()
    } catch (cause) {
      if (artifact) await completeAgentHandoff(artifact.handoffId).catch(() => {})
      setError(String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={closeModal}
      title={t('handoff.title', { source: AGENT_TYPE_LABELS[source], target: AGENT_TYPE_LABELS[target] })}
      width={720}
      footer={
        <>
          <button type="button" className={styles.secondary} onClick={closeModal} disabled={busy}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className={styles.primary}
            onClick={() => void continueInTarget()}
            disabled={!draft || busy || !content.trim() || byteCount > MAX_HANDOFF_BYTES}
          >
            {busy ? t('handoff.starting') : t('handoff.continue', { agent: AGENT_TYPE_LABELS[target] })}
          </button>
        </>
      }
    >
      {!cwd ? <div className={styles.error}>{t('handoff.noCwd')}</div> : null}
      {error ? <div className={styles.error}>{error}</div> : null}
      {!draft && !error ? <div className={styles.loading}>{t('handoff.preparing')}</div> : null}
      {draft ? (
        <div className={styles.content}>
          <div className={styles.summary}>
            <span>{t('handoff.session', { id: draft.sourceSessionId.slice(0, 8) })}</span>
            <span>{t('handoff.included', { count: draft.includedEventCount })}</span>
            <span>{t('handoff.omitted', { count: draft.omittedEventCount })}</span>
            <span>{t('handoff.redacted', { count: draft.redactionCount })}</span>
          </div>
          {warnings.length ? (
            <ul className={styles.warnings}>
              {warnings.map((warning) => <li key={warning}>{warning}</li>)}
            </ul>
          ) : null}
          <label className={styles.label} htmlFor="handoff-content">
            {t('handoff.reviewLabel')}
          </label>
          <textarea
            id="handoff-content"
            className={styles.editor}
            value={content}
            onChange={(event) => setContent(event.target.value)}
            spellCheck={false}
          />
          <div className={`${styles.counter} ${byteCount > MAX_HANDOFF_BYTES ? styles.counterError : ''}`}>
            {t('handoff.size', { current: byteCount, max: MAX_HANDOFF_BYTES })}
          </div>
          <label className={styles.unrestricted}>
            <input
              type="checkbox"
              checked={unrestricted}
              onChange={(event) => setUnrestricted(event.target.checked)}
            />
            {t('handoff.unrestricted', { agent: AGENT_TYPE_LABELS[target] })}
          </label>
          <p className={styles.privacy}>{t('handoff.privacy')}</p>
        </div>
      ) : null}
    </Modal>
  )
}
