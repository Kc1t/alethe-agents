import { Folder, FolderCheck, Zap } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { useUiStore } from '../../stores/uiStore'
import { useProjectsStore } from '../../stores/projectsStore'
import { pickDirectory } from '../../lib/dialog'
import { UNRESTRICTED_FLAG, type AgentRuntimeProfile, type AgentType } from '../../lib/types'
import { AgentIcon } from '../icons/AgentIcons'
import { useT } from '../../lib/i18n'
import { Modal } from './Modal'
import controls from './controls.module.css'
import picker from './agentPicker.module.css'

const AGENTS: { type: AgentType; label: string }[] = [
  { type: 'shell', label: 'Shell' },
  { type: 'claude', label: 'Claude' },
  { type: 'codex', label: 'Codex' },
  { type: 'copilot', label: 'GitHub Copilot' },
  { type: 'antigravity', label: 'Antigravity' },
  { type: 'opencode', label: 'OpenCode' },
  { type: 'freebuff', label: 'Freebuff' },
  { type: 'mimo', label: 'Mimo' },
]

export function NewSubTabModal() {
  const t = useT()
  const open = useUiStore((s) => s.openModal === 'newSubTab')
  const context = useUiStore((s) => s.modalContext) as {
    projectId?: string
    terminalId?: string
  } | null
  const closeModal = useUiStore((s) => s.closeModal)
  const createSubTab = useProjectsStore((s) => s.createSubTab)
  const enabled = useProjectsStore((s) => s.preferences.enabledAgents)
  const terminalTheme = useProjectsStore(
    (s) => s.preferences.terminalTheme ?? s.preferences.uiTheme,
  )
  const terminal = useProjectsStore((s) => {
    if (!context?.projectId || !context?.terminalId) return null
    const project = s.projects.find((p) => p.id === context.projectId)
    return project?.terminals.find((item) => item.id === context.terminalId) ?? null
  })

  const [type, setType] = useState<AgentType>('shell')
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
  const inheritedCwd = useMemo(() => {
    const activeTab =
      terminal?.tabs.find((item) => item.id === terminal.activeTabId) ?? terminal?.tabs[0]
    return activeTab?.cwd?.trim() || terminal?.cwd?.trim() || ''
  }, [terminal])

  useEffect(() => {
    if (!open) return
    setCwd(inheritedCwd)
  }, [open, context?.projectId, context?.terminalId, inheritedCwd])

  const reset = () => {
    setType('shell')
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

  const submit = () => {
    if (!context?.projectId || !context?.terminalId) return
    const flag = UNRESTRICTED_FLAG[type]
    const extraArgs = unrestricted[type] && flag ? [flag] : undefined
    createSubTab(context.projectId, context.terminalId, {
      type,
      cwd: cwd.trim() || inheritedCwd,
      extraArgs,
      runtimeProfile,
    })
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
      title={t('term.newSubTabTitle')}
      footer={
        <>
          <button type="button" className={controls.btn} onClick={closeModal}>
            {t('term.cancel')}
          </button>
          <button
            type="button"
            className={`${controls.btn} ${controls.btnPrimary}`}
            onClick={submit}
            disabled={!context?.terminalId}
          >
            {t('term.add')}
          </button>
        </>
      }
    >
      <div className={controls.field}>
        <label className={controls.label}>{t('term.type')}</label>
        <div className={picker.list}>
          {visibleAgents.map((a) => {
            const active = type === a.type
            return (
              <button
                key={a.type}
                type="button"
                className={`${picker.row} ${active ? picker.rowActive : ''}`}
                onClick={() => setType(a.type)}
              >
                <span className={picker.rowIcon}>
                  <AgentIcon type={a.type} size={18} theme={terminalTheme} />
                </span>
                <span className={picker.rowLabel}>{a.label}</span>
                <span className={picker.rowEnd}>
                  {UNRESTRICTED_FLAG[a.type] ? (
                    <button
                      type="button"
                      className={`${picker.cwdBtn} ${unrestricted[a.type] ? picker.boltActive : ''}`}
                      onClick={(e) => {
                        e.stopPropagation()
                        setType(a.type)
                        setUnrestricted((u) => ({ ...u, [a.type]: !u[a.type] }))
                      }}
                      title={
                        unrestricted[a.type]
                          ? t('term.unrestrictedActive', { flag: UNRESTRICTED_FLAG[a.type] ?? '' })
                          : t('term.unrestrictedEnable')
                      }
                      aria-label={t('term.unrestricted')}
                    >
                      <Zap size={14} className={unrestricted[a.type] ? picker.bolt : ''} />
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className={`${picker.cwdBtn} ${active && (cwd || inheritedCwd) ? picker.set : ''}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      setType(a.type)
                      void browse()
                    }}
                    title={
                      active && (cwd || inheritedCwd) ? cwd || inheritedCwd : t('term.chooseFolder')
                    }
                    aria-label={t('term.chooseFolder')}
                  >
                    {active && (cwd || inheritedCwd) ? (
                      <FolderCheck size={14} />
                    ) : (
                      <Folder size={14} />
                    )}
                  </button>
                </span>
              </button>
            )
          })}
        </div>
      </div>
      {type !== 'shell' ? (
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
            {type === 'opencode'
              ? t('term.runtimeProfile.opencodeNote')
              : t(`term.runtimeProfile.${runtimeProfile}.desc`)}
          </span>
        </div>
      ) : null}
      <div className={controls.field}>
        <label className={controls.label}>{t('term.folderCwd')}</label>
        <div className={controls.cwdRow}>
          <input
            className={controls.input}
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            placeholder={inheritedCwd || t('term.defaultPlaceholder')}
          />
          <button
            type="button"
            className={controls.btn}
            onClick={browse}
            aria-label={t('term.chooseFolder')}
            title={t('term.chooseFolder')}
          >
            <Folder size={14} />
          </button>
        </div>
      </div>
    </Modal>
  )
}
