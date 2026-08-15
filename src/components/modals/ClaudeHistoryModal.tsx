import { useEffect, useState } from 'react'

import { intlLocale, useT, type Locale, type TFunction } from '../../lib/i18n'
import { listClaudeSessions, restartPty, type ClaudeSessionMeta } from '../../lib/tauri'
import { agentCliCommand, type AgentType } from '../../lib/types'
import { useProjectsStore } from '../../stores/projectsStore'
import { Modal } from './Modal'
import styles from './ClaudeHistoryModal.module.css'

type Props = {
  open: boolean
  onClose: () => void
  projectId: string
  terminalId: string
  tabId: string
  ptyId: string | null
  cwd: string
  agentType: AgentType
  extraArgs?: string[]
}

function formatRelative(ms: number, t: TFunction, language: Locale): string {
  const diff = Date.now() - ms
  if (diff < 60_000) return t('mod.justNow')
  if (diff < 3_600_000) return t('mod.minutesAgo', { count: Math.floor(diff / 60_000) })
  if (diff < 86_400_000) return t('mod.hoursAgo', { count: Math.floor(diff / 3_600_000) })
  const days = Math.floor(diff / 86_400_000)
  if (days < 30) return t('mod.daysAgo', { count: days })
  return new Date(ms).toLocaleDateString(intlLocale(language))
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function ClaudeHistoryModal({
  open,
  onClose,
  projectId,
  terminalId,
  tabId,
  ptyId,
  cwd,
  agentType,
  extraArgs,
}: Props) {
  const t = useT()
  const language = useProjectsStore((s) => s.preferences.language)
  const [sessions, setSessions] = useState<ClaudeSessionMeta[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [filter, setFilter] = useState('')

  useEffect(() => {
    if (!open || !cwd) return
    let cancelled = false
    setError(null)
    setSessions(null)
    listClaudeSessions(cwd)
      .then((result) => {
        if (cancelled) return
        setSessions(result)
      })
      .catch((err) => {
        if (cancelled) return
        setError(String(err))
        setSessions([])
      })
    return () => {
      cancelled = true
    }
  }, [open, cwd])

  const resumeHere = async (sessionId: string) => {
    if (!ptyId) return
    setBusyId(sessionId)
    try {
                                                                        
      // remove --resume <id> antigo e adiciona o novo.
      const old = extraArgs ?? []
      const filtered: string[] = []
      for (let i = 0; i < old.length; i++) {
        if (old[i] === '--resume') {
          i++ // pula o sessionId antigo
          continue
        }
        filtered.push(old[i])
      }
      const newExtraArgs = [...filtered, '--resume', sessionId]

      await restartPty({
        id: ptyId,
        cols: 80,
        rows: 24,
        command: agentCliCommand(agentType),
        cwd,
        extraArgs: newExtraArgs,
      })
      window.dispatchEvent(new CustomEvent('alethe:terminal-resize-request', { detail: { ptyId } }))

                                                                                       
      useProjectsStore.getState().setSubTabSessionId(projectId, terminalId, tabId, sessionId)

      onClose()
    } catch (err) {
      setError(t('mod.resumeFailed', { error: String(err) }))
    } finally {
      setBusyId(null)
    }
  }

  const filtered = sessions?.filter((s) => {
    if (!filter.trim()) return true
    const needle = filter.toLowerCase()
    return (
      (s.title ?? '').toLowerCase().includes(needle) ||
      (s.first_user_prompt ?? '').toLowerCase().includes(needle) ||
      s.id.toLowerCase().includes(needle)
    )
  })

  return (
    <Modal open={open} onClose={onClose} title={t('mod.sessionHistory')} width={520}>
      <div className={styles.cwd}>{cwd || t('mod.noCwd')}</div>

      <input
        type="text"
        className={styles.search}
        placeholder={t('mod.filterPlaceholder')}
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        data-autofocus
      />

      {error ? <div className={styles.error}>{error}</div> : null}

      <div className={styles.list}>
        {sessions === null ? (
          <div className={styles.empty}>{t('mod.loadingSessions')}</div>
        ) : filtered && filtered.length === 0 ? (
          <div className={styles.empty}>
            {sessions.length === 0 ? t('mod.noSessionsForCwd') : t('mod.noSessionsMatchFilter')}
          </div>
        ) : (
          filtered?.map((session) => {
            const titleText =
              session.title ||
              session.first_user_prompt ||
              t('mod.sessionFallback', { id: session.id.slice(0, 8) })
            return (
              <div key={session.id} className={styles.item}>
                <div className={styles.itemMain}>
                  <div className={styles.itemTitle} title={titleText}>
                    {titleText}
                  </div>
                  {session.first_user_prompt && session.title ? (
                    <div className={styles.itemPrompt} title={session.first_user_prompt}>
                      {session.first_user_prompt}
                    </div>
                  ) : null}
                  <div className={styles.itemMeta}>
                    <span>{formatRelative(session.modified_at_ms, t, language)}</span>
                    <span>·</span>
                    <span>{t('mod.msgsCount', { count: session.message_count })}</span>
                    <span>·</span>
                    <span>{formatSize(session.size_bytes)}</span>
                  </div>
                </div>
                <div className={styles.itemActions}>
                  <button
                    type="button"
                    className={styles.actionBtn}
                    disabled={busyId !== null}
                    onClick={() => void resumeHere(session.id)}
                    title={t('mod.resumeHereTooltip')}
                  >
                    {busyId === session.id ? '…' : t('mod.resumeHere')}
                  </button>
                </div>
              </div>
            )
          })
        )}
      </div>
    </Modal>
  )
}
