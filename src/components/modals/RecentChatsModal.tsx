import { useEffect, useMemo, useState } from 'react'

import { intlLocale, type Locale, type TFunction,useT } from '../../lib/i18n'
import { buildAgentLaunch } from '../../lib/sessionLaunch'
import {
  type ClaudeSessionMeta,
  listClaudeSessions,
  restartPty,
  snapshotCodexSessions,
} from '../../lib/tauri'
import { agentCliCommand, UNRESTRICTED_FLAG } from '../../lib/types'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import { ClaudeIcon, CodexIcon } from '../icons/AgentIcons'
import { Modal } from './Modal'
import styles from './RecentChatsModal.module.css'

type ChatEntry = {
  id: string
  title: string | null
  prompt: string | null
  modifiedAtMs: number
  messageCount: number | null
  sizeBytes: number
}

const AGENTS = [
  { type: 'claude', labelKey: 'ui.titlebar.itemClaude' },
  { type: 'codex', labelKey: 'ui.titlebar.itemCodex' },
] as const

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

function toEntries(sessions: ClaudeSessionMeta[]): ChatEntry[] {
  return sessions.map((session) => ({
    id: session.id,
    title: session.title,
    prompt: session.first_user_prompt,
    modifiedAtMs: session.modified_at_ms,
    messageCount: session.message_count,
    sizeBytes: session.size_bytes,
  }))
}

export function RecentChatsModal() {
  const t = useT()
  const open = useUiStore((s) => s.openModal === 'recentChats')
  const closeModal = useUiStore((s) => s.closeModal)
  const openModal = useUiStore((s) => s.openModal_)
  const modalContext = useUiStore((s) => s.modalContext)
  const activeTerminalRef = useUiStore((s) => s.activeTerminal)
  const language = useProjectsStore((s) => s.preferences.language)
  const projects = useProjectsStore((s) => s.projects)
  const activeProjectId = useProjectsStore((s) => s.activeProjectId)
  const createTerminal = useProjectsStore((s) => s.createTerminal)
  const setSubTabSessionId = useProjectsStore((s) => s.setSubTabSessionId)

  const [agent, setAgent] = useState<'claude' | 'codex'>('claude')
  const [unrestricted, setUnrestricted] = useState(true)
  const [entries, setEntries] = useState<ChatEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [filter, setFilter] = useState('')

  // The panel is opened from a pane toolbar, so the pane that asked for it is
  // the target. Falling back to the selected pane keeps it usable elsewhere.
  const contextProjectId = typeof modalContext?.projectId === 'string' ? modalContext.projectId : null
  const contextTerminalId =
    typeof modalContext?.terminalId === 'string' ? modalContext.terminalId : null
  const contextAgent = modalContext?.agent === 'codex' ? 'codex' : 'claude'

  const project = useMemo(
    () =>
      projects.find((item) => item.id === (contextProjectId ?? activeProjectId)) ??
      projects[0] ??
      null,
    [projects, contextProjectId, activeProjectId],
  )

  const targetTerminal = useMemo(() => {
    if (!project) return null
    const wantedId =
      contextTerminalId ??
      (activeTerminalRef?.projectId === project.id ? activeTerminalRef.terminalId : null)
    if (!wantedId) return null
    return project.terminals.find((item) => item.id === wantedId) ?? null
  }, [activeTerminalRef, contextTerminalId, project])

  const targetTab =
    targetTerminal?.tabs.find((item) => item.id === targetTerminal.activeTabId) ?? null
  const cwd = targetTab?.cwd || targetTerminal?.cwd || project?.defaultCwd || ''

  useEffect(() => {
    if (open) setAgent(contextAgent)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    if (!open || !cwd) return
    let cancelled = false
    setError(null)
    setEntries(null)
    const load = async () => {
      if (agent === 'claude') return toEntries(await listClaudeSessions(cwd))
      const sessions = await snapshotCodexSessions(cwd)
      return sessions.map((session) => ({
        id: session.id,
        title: null,
        prompt: null,
        modifiedAtMs: session.modified_at_ms,
        messageCount: null,
        sizeBytes: session.size_bytes,
      }))
    }
    load()
      .then((result) => {
        if (!cancelled) setEntries(result)
      })
      .catch((err) => {
        if (cancelled) return
        setError(String(err))
        setEntries([])
      })
    return () => {
      cancelled = true
    }
  }, [open, cwd, agent])

  const extraArgsFor = (type: 'claude' | 'codex'): string[] => {
    const flag = unrestricted ? UNRESTRICTED_FLAG[type] : null
    return flag ? [flag] : []
  }

  const openInNewPane = (entry: ChatEntry) => {
    if (!project) return
    setBusyId(entry.id)
    try {
      const created = createTerminal(project.id, {
        name: entry.title?.slice(0, 32) || t('recentChats.paneName', { id: entry.id.slice(0, 8) }),
        cwd,
        firstTab: { type: agent, cwd, extraArgs: extraArgsFor(agent) },
      })
      setSubTabSessionId(project.id, created.id, created.activeTabId, entry.id)
      closeModal()
    } catch (err) {
      setError(String(err))
    } finally {
      setBusyId(null)
    }
  }

  const openHere = async (entry: ChatEntry) => {
    if (!project || !targetTerminal) return
    const tab = targetTab
    if (!tab?.ptyId) return
    setBusyId(entry.id)
    try {
      const launch = buildAgentLaunch(agent, extraArgsFor(agent), entry.id)
      await restartPty({
        id: tab.ptyId,
        cols: 80,
        rows: 24,
        command: agentCliCommand(agent),
        cwd: tab.cwd || cwd || undefined,
        extraArgs: launch.args,
      })
      window.dispatchEvent(
        new CustomEvent('alethe:terminal-resize-request', { detail: { ptyId: tab.ptyId } }),
      )
      setSubTabSessionId(project.id, targetTerminal.id, tab.id, entry.id)
      closeModal()
    } catch (err) {
      setError(t('mod.resumeFailed', { error: String(err) }))
    } finally {
      setBusyId(null)
    }
  }

  const visible = entries?.filter((entry) => {
    if (!filter.trim()) return true
    const needle = filter.toLowerCase()
    return (
      (entry.title ?? '').toLowerCase().includes(needle) ||
      (entry.prompt ?? '').toLowerCase().includes(needle) ||
      entry.id.toLowerCase().includes(needle)
    )
  })

  return (
    <Modal open={open} onClose={closeModal} title={t('recentChats.title')} width={560}>
      <div className={styles.header}>
        <div className={styles.agentTabs}>
          {AGENTS.map((option) => (
            <button
              key={option.type}
              type="button"
              className={`${styles.agentTab} ${agent === option.type ? styles.agentTabActive : ''}`}
              onClick={() => setAgent(option.type)}
              aria-pressed={agent === option.type}
            >
              {option.type === 'claude' ? <ClaudeIcon size={12} /> : <CodexIcon size={12} />}
              {t(option.labelKey)}
            </button>
          ))}
        </div>
        {UNRESTRICTED_FLAG[agent] ? (
          <label className={styles.unrestricted}>
            <input
              type="checkbox"
              checked={unrestricted}
              onChange={(event) => setUnrestricted(event.target.checked)}
            />
            {t('recentChats.unrestricted')}
          </label>
        ) : null}
      </div>

      <div className={styles.cwd}>{cwd || t('mod.noCwd')}</div>

      <input
        type="text"
        className={styles.search}
        placeholder={t('mod.filterPlaceholder')}
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
        data-autofocus
      />

      {error ? <div className={styles.error}>{error}</div> : null}

      <div className={styles.list}>
        {entries === null ? (
          <div className={styles.empty}>{t('mod.loadingSessions')}</div>
        ) : visible && visible.length === 0 ? (
          <div className={styles.empty}>
            {entries.length === 0 ? t('mod.noSessionsForCwd') : t('mod.noSessionsMatchFilter')}
          </div>
        ) : (
          visible?.map((entry) => {
            const titleText =
              entry.title || entry.prompt || t('mod.sessionFallback', { id: entry.id.slice(0, 8) })
            return (
              <div key={entry.id} className={styles.item}>
                <div className={styles.itemMain}>
                  <div className={styles.itemTitle} title={titleText}>
                    {titleText}
                  </div>
                  {entry.prompt && entry.title ? (
                    <div className={styles.itemPrompt} title={entry.prompt}>
                      {entry.prompt}
                    </div>
                  ) : null}
                  <div className={styles.itemMeta}>
                    <span>{formatRelative(entry.modifiedAtMs, t, language)}</span>
                    {entry.messageCount !== null ? (
                      <>
                        <span>·</span>
                        <span>{t('mod.msgsCount', { count: entry.messageCount })}</span>
                      </>
                    ) : null}
                    <span>·</span>
                    <span>{formatSize(entry.sizeBytes)}</span>
                  </div>
                </div>
                <div className={styles.itemActions}>
                  <button
                    type="button"
                    className={styles.actionBtn}
                    disabled={busyId !== null || !project || !targetTerminal}
                    onClick={() =>
                      openModal('handoff', {
                        projectId: project?.id,
                        terminalId: targetTerminal?.id,
                        agent,
                        sourceSessionId: entry.id,
                      })
                    }
                    title={t('recentChats.handoffTooltip')}
                  >
                    {t('recentChats.handoff', {
                      agent: agent === 'claude' ? 'Codex' : 'Claude Code',
                    })}
                  </button>
                  <button
                    type="button"
                    className={styles.actionBtn}
                    disabled={busyId !== null || !project}
                    onClick={() => openInNewPane(entry)}
                    title={t('recentChats.openInNewPaneTooltip')}
                  >
                    {t('recentChats.openInNewPane')}
                  </button>
                  <button
                    type="button"
                    className={styles.actionBtn}
                    disabled={busyId !== null || !targetTerminal}
                    onClick={() => void openHere(entry)}
                    title={
                      targetTerminal
                        ? t('recentChats.openHereTooltip')
                        : t('recentChats.openHereDisabled')
                    }
                  >
                    {busyId === entry.id ? '…' : t('recentChats.openHere')}
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
