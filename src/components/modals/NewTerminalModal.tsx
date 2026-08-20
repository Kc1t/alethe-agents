import { CircleCheck, Folder, Info, Zap } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { useAgentCreationForm } from '../../hooks/useAgentCreationForm'
import { AGENT_OPTIONS, unrestrictedArgsForAgent } from '../../lib/agentCreation'
import { pickDirectory } from '../../lib/dialog'
import { useT } from '../../lib/i18n'
import { basename } from '../../lib/paths'
import { UNRESTRICTED_FLAG } from '../../lib/types'
import {
  getProjectDefaultCwd,
  getProjectRepoRoot,
  useProjectsStore,
} from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import { AgentIcon } from '../icons/AgentIcons'
import controls from './controls.module.css'
import { Modal } from './Modal'
import styles from './NewTerminalModal.module.css'
import { RuntimeProfileField } from './RuntimeProfileField'

export function NewTerminalModal() {
  const t = useT()
  const open = useUiStore((s) => s.openModal === 'newTerminal')
  const context = useUiStore((s) => s.modalContext) as { projectId?: string } | null
  const closeModal = useUiStore((s) => s.closeModal)
  const createAgentTerminal = useProjectsStore((s) => s.createAgentTerminal)
  const setActiveProjectOnly = useProjectsStore((s) => s.setActiveProjectOnly)
  const focusWorkspaceTerminal = useProjectsStore((s) => s.focusWorkspaceTerminal)
  const setActiveView = useUiStore((s) => s.setActiveView)
  const setActiveTerminal = useUiStore((s) => s.setActiveTerminal)
  const requestPaneFocus = useUiStore((s) => s.requestPaneFocus)
  const alwaysStartUnrestricted = useProjectsStore((s) => s.preferences.alwaysStartUnrestricted)
  const setPreferences = useProjectsStore((s) => s.setPreferences)
  const project = useProjectsStore((s) =>
    context?.projectId ? (s.projects.find((p) => p.id === context.projectId) ?? null) : null,
  )
  const projects = useProjectsStore((s) => s.projects)
  const enabled = useProjectsStore((s) => s.preferences.enabledAgents)
  const terminalTheme = useProjectsStore(
    (s) => s.preferences.terminalTheme ?? s.preferences.uiTheme,
  )

  const [cwd, setCwd] = useState('')
  const {
    resetAgentCreation,
    runtimeProfile,
    setRuntimeProfile,
    setType,
    toggleUnrestricted,
    type,
    unrestricted,
  } = useAgentCreationForm('claude')

  const visibleAgents = AGENT_OPTIONS.filter((agent) => enabled[agent.type])
  const defaultType =
    visibleAgents.find((agent) => agent.type === 'claude')?.type ??
    visibleAgents[0]?.type ??
    'shell'
  const selectedAgent = AGENT_OPTIONS.find((agent) => agent.type === type) ?? AGENT_OPTIONS[0]
  // Prefer the repository root because the most recently used terminal may belong to an
  // isolated agent worktree. This mirrors createAgentTerminal's fallback order.
  const inheritedCwd = useMemo(
    () => getProjectRepoRoot(project) || getProjectDefaultCwd(project, projects),
    [project, projects],
  )
  const recentFolders = useMemo(() => {
    const folders = new Map<string, { path: string; lastUsedAt: number }>()
    for (const candidate of projects) {
      // Agent worktrees are not useful shortcuts for starting a regular project terminal.
      for (const terminal of candidate.terminals) {
        if (terminal.worktreeAgentId || terminal.gsdSyncViewer) continue
        const paths = [terminal.cwd, ...terminal.tabs.map((tab) => tab.cwd)]
        for (const path of paths) {
          const trimmed = path?.trim()
          if (!trimmed) continue
          const key = trimmed.replace(/[\\/]+$/, '').toLowerCase()
          const lastUsedAt = terminal.lastUsedAt ?? 0
          const previous = folders.get(key)
          if (!previous || lastUsedAt > previous.lastUsedAt) {
            folders.set(key, { path: trimmed, lastUsedAt })
          }
        }
      }
    }
    return [...folders.values()].sort((a, b) => b.lastUsedAt - a.lastUsedAt).slice(0, 4)
  }, [projects])

  useEffect(() => {
    if (!open) return
    setCwd(inheritedCwd)
    resetAgentCreation(defaultType, alwaysStartUnrestricted)
  }, [
    open,
    context?.projectId,
    inheritedCwd,
    defaultType,
    alwaysStartUnrestricted,
    resetAgentCreation,
  ])

  const reset = () => {
    setCwd('')
    resetAgentCreation(defaultType)
  }

  const submit = async () => {
    if (!context?.projectId) return
    const finalName = selectedAgent.label
    const finalCwd = cwd.trim() || inheritedCwd
    const extraArgs = unrestrictedArgsForAgent(type, unrestricted)
    const creation = {
      name: finalName,
      cwd: finalCwd,
      firstTab: { type, cwd: finalCwd, extraArgs, runtimeProfile },
    }
    const terminal = await createAgentTerminal(context.projectId, creation)
    setPreferences({ lastTerminalCreation: creation })
    // Creation only persists the terminal; explicitly navigate and focus it so the xterm mounts.
    setActiveProjectOnly(context.projectId)
    focusWorkspaceTerminal(context.projectId, terminal.id)
    setActiveTerminal(context.projectId, terminal.id)
    requestPaneFocus(terminal.id)
    setActiveView('workspace')
    reset()
    closeModal()
  }

  const browse = async () => {
    const dir = await pickDirectory({ defaultPath: cwd || inheritedCwd || undefined })
    if (dir) setCwd(dir)
  }

  return (
    <Modal
      open={open}
      onClose={() => {
        reset()
        closeModal()
      }}
      title={t('term.newTerminalTitle')}
      width={560}
      footer={
        <>
          <button type="button" className={controls.btn} onClick={closeModal}>
            {t('term.cancel')}
          </button>
          <button
            type="button"
            className={`${controls.btn} ${controls.btnPrimary}`}
            onClick={() => void submit()}
            disabled={!context?.projectId}
          >
            {t('term.openAgent', { agent: selectedAgent.label })}
          </button>
        </>
      }
    >
      <p className={styles.description}>{t('term.newTerminalDescription')}</p>

      <section className={styles.section}>
        <h3 className={styles.stepTitle}>{t('term.stepTerminal')}</h3>
        <div className={styles.agentGrid}>
          {visibleAgents.map((a) => {
            const active = type === a.type
            return (
              <button
                key={a.type}
                type="button"
                className={`${styles.agentCard} ${active ? styles.agentCardActive : ''}`}
                onClick={() => setType(a.type)}
                aria-pressed={active}
              >
                <span className={styles.agentIcon}>
                  <AgentIcon type={a.type} size={22} theme={terminalTheme} />
                </span>
                <span className={styles.agentLabel}>{a.label}</span>
                {active ? <CircleCheck size={17} className={styles.selectedIcon} /> : null}
              </button>
            )
          })}
        </div>
        {UNRESTRICTED_FLAG[type] ? (
          <button
            type="button"
            className={`${styles.permissionToggle} ${unrestricted[type] ? styles.permissionToggleActive : ''}`}
            onClick={() => toggleUnrestricted(type)}
            aria-pressed={unrestricted[type]}
          >
            <span className={styles.permissionToggleIcon}>
              <Zap size={17} />
            </span>
            <span className={styles.permissionToggleCopy}>
              <span className={styles.permissionToggleTitle}>{t('term.unrestrictedShort')}</span>
              <span className={styles.permissionToggleDescription}>
                {t('term.unrestrictedDescription')}
              </span>
            </span>
            <span className={styles.permissionToggleState}>
              {unrestricted[type] ? t('term.unrestrictedOn') : t('term.unrestrictedOff')}
            </span>
          </button>
        ) : null}
        {UNRESTRICTED_FLAG[type] ? (
          <label className={styles.alwaysUnrestricted}>
            <input
              type="checkbox"
              checked={alwaysStartUnrestricted}
              onChange={(event) =>
                setPreferences({ alwaysStartUnrestricted: event.target.checked })
              }
            />
            <span>{t('term.alwaysUnrestricted')}</span>
          </label>
        ) : null}
      </section>

      <section className={styles.section}>
        <h3 className={styles.stepTitle}>{t('term.stepFolder')}</h3>
        <div className={styles.folderRow}>
          <Folder size={16} className={styles.folderIcon} />
          <input
            className={styles.folderInput}
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            placeholder={inheritedCwd || t('term.shellDefaultPlaceholder')}
          />
          <button type="button" className={styles.browseButton} onClick={browse}>
            {t('term.browse')}
          </button>
        </div>

        {recentFolders.length > 0 ? (
          <div className={styles.recentBlock}>
            <span className={styles.recentLabel}>{t('term.recentFolders')}</span>
            <div className={styles.recentFolders}>
              {recentFolders.map((folder) => {
                const label = basename(folder.path) || folder.path
                return (
                  <button
                    key={folder.path}
                    type="button"
                    className={styles.folderChip}
                    title={folder.path}
                    onClick={() => setCwd(folder.path)}
                  >
                    {label}
                  </button>
                )
              })}
            </div>
          </div>
        ) : null}
      </section>

      <div className={styles.autoNameHint}>
        <Info size={13} />
        <span>{t('term.autoNameHint')}</span>
      </div>

      {type !== 'shell' ? (
        <details className={styles.advanced}>
          <summary>{t('term.advancedOptions')}</summary>
          <div className={styles.advancedBody}>
            <RuntimeProfileField
              agentType={type}
              value={runtimeProfile}
              onChange={setRuntimeProfile}
            />
          </div>
        </details>
      ) : null}
    </Modal>
  )
}
