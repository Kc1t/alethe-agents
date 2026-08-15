import { Palette } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { useT } from '../../lib/i18n'
import {
  startGsdWatcher,
  stopGsdWatcher,
  worktreeList,
  worktreeProvision,
  worktreeRemove,
} from '../../lib/tauri'
import { type AgentType,GROUP_COLORS } from '../../lib/types'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import { ColorPalettePopover } from './ColorPalettePopover'
import controls from './controls.module.css'
import { EditProjectAgentSettings } from './EditProjectAgentSettings'
import styles from './EditProjectModal.module.css'
import { ImageInput } from './ImageInput'
import { Modal } from './Modal'

export function EditProjectModal() {
  const t = useT()
  const open = useUiStore((s) => s.openModal === 'editProject')
  const context = useUiStore((s) => s.modalContext) as { projectId?: string } | null
  const closeModal = useUiStore((s) => s.closeModal)
  const pushToast = useUiStore((s) => s.pushToast)

  const renameProject = useProjectsStore((s) => s.renameProject)
  const setProjectColor = useProjectsStore((s) => s.setProjectColor)
  const setProjectIconUrl = useProjectsStore((s) => s.setProjectIconUrl)
  const setWorktreeMode = useProjectsStore((s) => s.setWorktreeMode)
  const setValidationCommands = useProjectsStore((s) => s.setValidationCommands)
  const setGsdWatcherEnabled = useProjectsStore((s) => s.setGsdWatcherEnabled)
  const setConflictAgentProvider = useProjectsStore((s) => s.setConflictAgentProvider)
  const setConflictAgentModel = useProjectsStore((s) => s.setConflictAgentModel)
  const setGraphifyEnabled = useProjectsStore((s) => s.setGraphifyEnabled)
  const setAutoWorktree = useProjectsStore((s) => s.setAutoWorktree)
  const cleanupOrphanWorktrees = useProjectsStore((s) => s.cleanupOrphanWorktrees)
  const isCleaningOrphans = useProjectsStore((s) => s.isCleaningOrphans)

  const project = useProjectsStore((s) =>
    context?.projectId ? (s.projects.find((p) => p.id === context.projectId) ?? null) : null,
  )

  const [name, setName] = useState('')
  const [color, setColor] = useState<string>(GROUP_COLORS[0])
  const [isColorPopoverOpen, setIsColorPopoverOpen] = useState(false)
  const [iconUrl, setIconUrl] = useState('')
  const [worktreeMode, setWorktreeModeState] = useState<'gitWorktree' | 'localCopy'>('gitWorktree')
  const [validationCommandsStr, setValidationCommandsStr] = useState('')
  const [gsdWatcherEnabled, setGsdWatcherEnabledState] = useState(false)
  const [worktrees, setWorktrees] = useState<any[]>([])
  const [loadingWorktrees, setLoadingWorktrees] = useState(false)
  const [conflictProvider, setConflictProviderState] = useState<AgentType>('claude')
  const [conflictModel, setConflictModelState] = useState('')
  const [graphifyEnabled, setGraphifyEnabledState] = useState(false)
  const [autoWorktree, setAutoWorktreeState] = useState(false)
  const [newAgentName, setNewAgentName] = useState('')
  const [creatingAgent, setCreatingAgent] = useState(false)
  const [activeTab, setActiveTab] = useState<'focus' | 'agents' | 'worktrees'>('focus')

  const loadWorktrees = async (repoPath: string) => {
    setLoadingWorktrees(true)
    try {
      const list = await worktreeList(repoPath)
      setWorktrees(list)
    } catch (err) {
      console.error('Falha ao listar worktrees:', err)
    } finally {
      setLoadingWorktrees(false)
    }
  }

  // `project` vem de um seletor Zustand (`s.projects.find(...)`) — troca de
                                                                            
                                                                            
                                                                          
                                                                              
                                                                           
                                                                            
                                                                            
                                                                     
  // resetado de volta ao valor antigo. `seededForRef` faz a semeadura valer
                                                                          
                                              
  const seededForRef = useRef<string | null>(null)
  useEffect(() => {
    if (!open || !project) {
      seededForRef.current = null
      return
    }
    if (seededForRef.current === project.id) return
    seededForRef.current = project.id

    setName(project.name)
    setColor(project.color || GROUP_COLORS[0])
    setIconUrl(project.iconUrl ?? '')
    setWorktreeModeState(project.worktreeMode ?? 'gitWorktree')
    setValidationCommandsStr((project.validationCommands ?? []).join('\n'))
    setGsdWatcherEnabledState(project.gsdWatcherEnabled ?? false)

    setConflictProviderState(project.conflictAgentProvider ?? 'claude')
    setConflictModelState(project.conflictAgentModel ?? '')
    setGraphifyEnabledState(project.graphifyEnabled ?? false)
    setAutoWorktreeState(project.autoWorktree ?? false)
    setActiveTab('focus')
    setIsColorPopoverOpen(false)

    const repoPath = project.terminals[0]?.cwd
    if (repoPath) {
      void loadWorktrees(repoPath)
    } else {
      setWorktrees([])
    }
  }, [open, project])

  if (!project) return null

  const handleRemoveWorktree = async (agentId: string) => {
    const repoPath = project.terminals[0]?.cwd
    if (!repoPath) return
    if (confirm(`Tem certeza que deseja excluir o ambiente do agente "${agentId}"?`)) {
      try {
        await worktreeRemove(repoPath, agentId, true)
        void loadWorktrees(repoPath)
      } catch (err) {
        console.error('Falha ao excluir worktree:', err)
        alert('Erro ao excluir: ' + err)
      }
    }
  }

                                                                           
                                                                 
  const handleCreateAgentEnv = async () => {
    const repoPath = project?.terminals[0]?.cwd
    const name = newAgentName.trim().replace(/[^A-Za-z0-9_-]/g, '-')
    if (!project || !repoPath || !name) return
    setCreatingAgent(true)
    try {
      const info = await worktreeProvision(repoPath, name, project.worktreeMode ?? 'gitWorktree')
      useProjectsStore.getState().createTerminal(project.id, {
        name,
        cwd: info.path,
        firstTab: { type: project.conflictAgentProvider ?? 'claude', cwd: info.path },
      })
      setNewAgentName('')
      void loadWorktrees(repoPath)
    } catch (err) {
      console.error('Falha ao criar ambiente de agente:', err)
      alert(String(err))
    } finally {
      setCreatingAgent(false)
    }
  }

  const handleCleanupOrphans = async () => {
    const summary = await cleanupOrphanWorktrees(project.id)
    pushToast({
      title: t('multiAgent.orphanCleanupTitle'),
      body: t('multiAgent.orphanCleanupSummary', {
        cleaned: summary.cleaned,
        partial: summary.partial,
        waiting: summary.awaitingUnlock,
        failed: summary.failed,
      }),
    })
    const repoPath = project.terminals[0]?.cwd
    if (repoPath) void loadWorktrees(repoPath)
  }

  const submit = () => {
    const trimmed = name.trim()
    if (trimmed && trimmed !== project.name) renameProject(project.id, trimmed)
    if (color !== project.color) setProjectColor(project.id, color)
    const trimmedUrl = iconUrl.trim()
    const newIconUrl = trimmedUrl || undefined
    if (newIconUrl !== project.iconUrl) setProjectIconUrl(project.id, newIconUrl)

    // Save multi-agent settings.
    if (worktreeMode !== project.worktreeMode) {
      setWorktreeMode(project.id, worktreeMode)
    }

    const cmds = validationCommandsStr
      .split('\n')
      .map((c) => c.trim())
      .filter(Boolean)
    const originalCmds = project.validationCommands ?? []
    if (JSON.stringify(cmds) !== JSON.stringify(originalCmds)) {
      setValidationCommands(project.id, cmds)
    }

    if (conflictProvider !== (project.conflictAgentProvider ?? 'claude')) {
      setConflictAgentProvider(project.id, conflictProvider)
    }

    if (conflictModel !== (project.conflictAgentModel ?? '')) {
      setConflictAgentModel(project.id, conflictModel)
    }

    if (graphifyEnabled !== (project.graphifyEnabled ?? false)) {
      setGraphifyEnabled(project.id, graphifyEnabled)
    }

    if (autoWorktree !== (project.autoWorktree ?? false)) {
      setAutoWorktree(project.id, autoWorktree)
    }

    if (gsdWatcherEnabled !== project.gsdWatcherEnabled) {
      setGsdWatcherEnabled(project.id, gsdWatcherEnabled)
      const repoPath = project.terminals[0]?.cwd
      if (repoPath) {
        if (gsdWatcherEnabled) {
          startGsdWatcher(project.id, repoPath).catch(console.error)
        } else {
          stopGsdWatcher(project.id, repoPath).catch(console.error)
        }
      }
    }

    closeModal()
  }

  const previewIcon = iconUrl.trim()

  return (
    <Modal
      open={open}
      onClose={closeModal}
      title={t('crud.editProjectTitle')}
      width={620}
      footer={
        <>
          <button type="button" className={controls.btn} onClick={closeModal}>
            {t('crud.cancel')}
          </button>
          <button
            type="button"
            className={`${controls.btn} ${controls.btnPrimary}`}
            disabled={!name.trim()}
            onClick={submit}
          >
            {t('crud.save')}
          </button>
        </>
      }
    >
      <nav className={styles.tabs} aria-label={t('crud.editProjectSections')}>
        {(
          [
            ['focus', t('crud.editProjectFocus')],
            ['agents', t('crud.editProjectAgents')],
            ['worktrees', t('crud.editProjectWorktrees')],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={`${styles.tab} ${activeTab === id ? styles.tabActive : ''}`}
            onClick={() => setActiveTab(id)}
            aria-selected={activeTab === id}
          >
            {label}
          </button>
        ))}
      </nav>
      {activeTab === 'focus' ? (
        <div className={styles.panel}>
          <div className={controls.field}>
            <label className={controls.label}>{t('crud.nameLabel')}</label>
            <input
              className={controls.input}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
            />
          </div>

          <div className={controls.field}>
            <label className={controls.label}>{t('crud.projectColorLabel')}</label>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              {GROUP_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setColor(c)}
                  aria-label={t('crud.colorSwatch', { color: c })}
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: '50%',
                    background: c,
                    border: color === c ? '2px solid var(--fg)' : '2px solid transparent',
                    cursor: 'pointer',
                  }}
                />
              ))}

              {color && !GROUP_COLORS.some((preset) => preset === color) && (
                <button
                  type="button"
                  onClick={() => setIsColorPopoverOpen(true)}
                  title={color}
                  aria-label={t('crud.colorSwatch', { color })}
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: '50%',
                    background: color,
                    border: '2px solid var(--fg)',
                    boxShadow: '0 0 0 1px var(--bg)',
                    cursor: 'pointer',
                  }}
                />
              )}

              {/* Botão de Paleta Completa / Mais Cores */}
              <button
                type="button"
                onClick={() => setIsColorPopoverOpen(true)}
                title={t('crud.moreColors')}
                aria-label={t('crud.moreColors')}
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: '50%',
                  background: 'var(--panel-hover)',
                  border: '1px solid var(--border-strong)',
                  display: 'grid',
                  placeItems: 'center',
                  color: 'var(--fg-muted)',
                  cursor: 'pointer',
                }}
              >
                <Palette size={14} />
              </button>
            </div>
          </div>

          <ImageInput
            label={t('crud.iconLabel')}
            value={iconUrl}
            onChange={setIconUrl}
            onEnter={submit}
            previewColor={color}
            hint={t('crud.projectIconEditHint')}
          />

          <div
            style={{
              marginTop: 6,
              padding: '10px 12px',
              borderRadius: 'var(--radius-md)',
              border: `2px solid color-mix(in srgb, ${color} 50%, transparent)`,
              fontSize: 11,
              color: 'var(--fg-muted)',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            {previewIcon ? (
              <img
                src={previewIcon}
                alt=""
                style={{
                  width: 16,
                  height: 16,
                  borderRadius: 4,
                  objectFit: 'cover',
                  flexShrink: 0,
                }}
              />
            ) : (
              <span
                style={{
                  display: 'inline-block',
                  width: 9,
                  height: 9,
                  borderRadius: 2,
                  background: color,
                  flexShrink: 0,
                }}
              />
            )}
            {t('crud.projectColorPreview')}
          </div>
        </div>
      ) : null}

      {activeTab === 'agents' ? (
        <div className={styles.panel}>
          <EditProjectAgentSettings
            projectId={project.id}
            cwd={project.terminals[0]?.cwd ?? project.defaultCwd ?? ''}
            worktreeMode={worktreeMode}
            onWorktreeModeChange={setWorktreeModeState}
            validationCommandsStr={validationCommandsStr}
            onValidationCommandsChange={setValidationCommandsStr}
            conflictProvider={conflictProvider}
            onConflictProviderChange={setConflictProviderState}
            conflictModel={conflictModel}
            onConflictModelChange={setConflictModelState}
            autoWorktree={autoWorktree}
            onAutoWorktreeChange={setAutoWorktreeState}
            graphifyEnabled={graphifyEnabled}
            onGraphifyEnabledChange={setGraphifyEnabledState}
            gsdWatcherEnabled={gsdWatcherEnabled}
            onGsdWatcherEnabledChange={setGsdWatcherEnabledState}
          />
        </div>
      ) : null}

      {activeTab === 'worktrees' ? (
        <div className={styles.panel}>
          {/* --- RFC-003 Worktrees Ativos --- */}
          <hr
            style={{ margin: '20px 0 16px', border: 'none', borderTop: '1px solid var(--border)' }}
          />
          <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>
            Ambientes de Agentes Ativos (Worktrees)
          </h3>

          {loadingWorktrees ? (
            <div style={{ fontSize: 11, color: 'var(--fg-muted)' }}>Carregando worktrees...</div>
          ) : worktrees.length === 0 ? (
            <div style={{ fontSize: 11, color: 'var(--fg-muted)', fontStyle: 'italic' }}>
              No active worktrees or copies for this project.
            </div>
          ) : (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
                maxHeight: 150,
                overflowY: 'auto',
              }}
            >
              {worktrees.map((wt) => (
                <div
                  key={wt.agentId}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '6px 10px',
                    borderRadius: 'var(--radius-sm)',
                    background: 'var(--bg-active)',
                    border: '1px solid var(--border)',
                    fontSize: 11,
                  }}
                >
                  <div style={{ overflow: 'hidden', marginRight: 12 }}>
                    <div style={{ fontWeight: 600 }}>
                      Agent: {wt.agentId} ({wt.mode === 'gitWorktree' ? 'Worktree' : 'Copy'})
                    </div>
                    <div
                      style={{
                        fontSize: 10,
                        color: 'var(--fg-muted)',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                      title={wt.path}
                    >
                      Ramo: <span style={{ fontFamily: 'monospace' }}>{wt.branch}</span> | Path:{' '}
                      {wt.path}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleRemoveWorktree(wt.agentId)}
                    style={{
                      padding: '4px 8px',
                      fontSize: 10,
                      borderRadius: 'var(--radius-sm)',
                      background: 'var(--status-failed-bg, #4c1d1d)',
                      color: '#ff8888',
                      border: 'none',
                      cursor: 'pointer',
                      flexShrink: 0,
                    }}
                  >
                    Excluir
                  </button>
                </div>
              ))}
            </div>
          )}
          {(project.orphanWorktrees?.length ?? 0) > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
              {(project.orphanWorktrees ?? []).map((orphan) => (
                <div
                  key={orphan.path}
                  style={{
                    padding: '6px 10px',
                    borderRadius: 'var(--radius-sm)',
                    background: 'var(--bg-active)',
                    border: '1px solid var(--border)',
                    fontSize: 10,
                  }}
                >
                  <div
                    style={{
                      fontFamily: 'monospace',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      color: 'var(--fg-muted)',
                    }}
                    title={orphan.path}
                  >
                    {orphan.path}
                  </div>
                  {orphan.adminLockReason ? (
                    <div style={{ marginTop: 2, color: 'var(--status-stopped)' }}>
                      {t('multiAgent.orphanAdminLocked', { reason: orphan.adminLockReason })}
                    </div>
                  ) : (orphan.cleanAttempts ?? 0) >= 3 ? (
                    <div style={{ marginTop: 2, color: 'var(--status-stopped)' }}>
                      {t('multiAgent.orphanManualRemoval')}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          )}
          {(project.orphanWorktrees?.length ?? 0) > 0 && (
            <button
              type="button"
              onClick={() => void handleCleanupOrphans()}
              disabled={isCleaningOrphans}
              style={{
                marginTop: 8,
                padding: '4px 10px',
                fontSize: 11,
                borderRadius: 'var(--radius-sm)',
                background: 'var(--bg-active)',
                border: '1px solid var(--border)',
                cursor: isCleaningOrphans ? 'default' : 'pointer',
                opacity: isCleaningOrphans ? 0.6 : 1,
              }}
            >
              {isCleaningOrphans
                ? t('multiAgent.cleaningOrphans')
                : t('multiAgent.cleanOrphans', { count: project.orphanWorktrees?.length ?? 0 })}
            </button>
          )}

          {/* 2.7 — gatilho manual de worktree */}
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <input
              className={controls.input}
              style={{ flex: 1 }}
              placeholder={t('multiAgent.newEnvPlaceholder')}
              value={newAgentName}
              onChange={(e) => setNewAgentName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void handleCreateAgentEnv()}
            />
            <button
              type="button"
              className={`${controls.btn} ${controls.btnPrimary}`}
              disabled={!newAgentName.trim() || creatingAgent || !project.terminals[0]?.cwd}
              onClick={() => void handleCreateAgentEnv()}
            >
              {creatingAgent ? t('multiAgent.creatingEnv') : t('multiAgent.createEnv')}
            </button>
          </div>

        </div>
      ) : null}


      <ColorPalettePopover
        open={isColorPopoverOpen}
        onClose={() => setIsColorPopoverOpen(false)}
        onSelectColor={(selected) => setColor(selected)}
        selectedColor={color}
      />
    </Modal>
  )
}
