import { CircleCheck, Folder, Info, Zap } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { pickDirectory } from '../../lib/dialog'
import { useT } from '../../lib/i18n'
import { basename } from '../../lib/paths'
import { AGENT_TYPE_LABELS, type AgentRuntimeProfile, type AgentType,ALL_AGENT_TYPES, UNRESTRICTED_FLAG } from '../../lib/types'
import { getProjectDefaultCwd, useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import { AgentIcon } from '../icons/AgentIcons'
import controls from './controls.module.css'
import { Modal } from './Modal'
import styles from './NewTerminalModal.module.css'

const AGENTS: { type: AgentType; label: string }[] = ALL_AGENT_TYPES.map((type) => ({
  type,
  label: AGENT_TYPE_LABELS[type],
}))

export function NewTerminalModal() {
  const t = useT()
  const open = useUiStore((s) => s.openModal === 'newTerminal')
  const context = useUiStore((s) => s.modalContext) as { projectId?: string } | null
  const closeModal = useUiStore((s) => s.closeModal)
  const createAgentTerminal = useProjectsStore((s) => s.createAgentTerminal)
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

  const [type, setType] = useState<AgentType>('claude')
  const [runtimeProfile, setRuntimeProfile] = useState<AgentRuntimeProfile>('lean')
  const [cwd, setCwd] = useState('')
  const [unrestricted, setUnrestricted] = useState<Record<AgentType, boolean>>({
    shell: false,
    claude: false,
    codex: false,
    copilot: false,
    antigravity: false,
    opencode: false,
    freebuff: false,
    mimo: false,
  })

  const visibleAgents = AGENTS.filter((a) => enabled[a.type])
  const defaultType =
    visibleAgents.find((agent) => agent.type === 'claude')?.type ??
    visibleAgents[0]?.type ??
    'shell'
  const selectedAgent = AGENTS.find((agent) => agent.type === type) ?? AGENTS[0]
  const inheritedCwd = useMemo(() => getProjectDefaultCwd(project, projects), [project, projects])
  const recentFolders = useMemo(() => {
    const folders = new Map<string, { path: string; lastUsedAt: number }>()
    for (const candidate of projects) {
      for (const terminal of candidate.terminals) {
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
    setType(defaultType)
    setUnrestricted({
      shell: alwaysStartUnrestricted,
      claude: alwaysStartUnrestricted,
      codex: alwaysStartUnrestricted,
      copilot: alwaysStartUnrestricted,
      antigravity: alwaysStartUnrestricted,
      opencode: alwaysStartUnrestricted,
      freebuff: alwaysStartUnrestricted,
      mimo: alwaysStartUnrestricted,
    })
  }, [open, context?.projectId, inheritedCwd, defaultType, alwaysStartUnrestricted])

  const reset = () => {
    setType(defaultType)
    setRuntimeProfile('lean')
    setCwd('')
    setUnrestricted({
      shell: false,
      claude: false,
      codex: false,
      copilot: false,
      antigravity: false,
      opencode: false,
      freebuff: false,
      mimo: false,
    })
  }

  const submit = async () => {
    if (!context?.projectId) return
    const finalName = selectedAgent.label
    const finalCwd = cwd.trim() || inheritedCwd
    const flag = UNRESTRICTED_FLAG[type]
    const extraArgs = unrestricted[type] && flag ? [flag] : undefined
    const creation = {
      name: finalName,
      cwd: finalCwd,
      firstTab: { type, cwd: finalCwd, extraArgs, runtimeProfile },
    }
    await createAgentTerminal(context.projectId, creation)
    setPreferences({ lastTerminalCreation: creation })
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
            onClick={() => setUnrestricted((value) => ({ ...value, [type]: !value[type] }))}
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
            <div className={controls.field}>
              <label className={controls.label}>{t('term.runtimeProfile')}</label>
              <div className={controls.pillRow}>
                {(['full', 'lean', 'diagnostic'] as const).map((profile) => (
                  <button
                    key={profile}
                    type="button"
                    className={`${controls.pill} ${runtimeProfile === profile ? controls.pillActive : ''}`}
                    onClick={() => setRuntimeProfile(profile)}
                    title={t(`term.runtimeProfile.${profile}.desc`)}
                  >
                    {t(`term.runtimeProfile.${profile}`)}
                  </button>
                ))}
              </div>
              <span className={controls.hint}>
                {t(`term.runtimeProfile.${runtimeProfile}.desc`)}
              </span>
            </div>
          </div>
        </details>
      ) : null}
    </Modal>
  )
}
