import { Bot, GitBranch, GitMerge, Palette } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { useT } from '../../lib/i18n'
import {
  detectProjectStack,
  gitListBranches,
  startGsdWatcher,
  stopGsdWatcher,
  worktreeList,
  worktreeProvision,
  worktreeRemove,
} from '../../lib/tauri'
import { type AgentType, GROUP_COLORS } from '../../lib/types'
import { getProjectRepoRoot, useProjectsStore } from '../../stores/projectsStore'
import { useMergeStore } from '../../stores/mergeStore'
import { useUiStore } from '../../stores/uiStore'
import { Dropdown } from '../ui/Dropdown'
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
  const setHealthCheckCommand = useProjectsStore((s) => s.setHealthCheckCommand)
  const setHealthCheckPath = useProjectsStore((s) => s.setHealthCheckPath)
  const setGsdWatcherEnabled = useProjectsStore((s) => s.setGsdWatcherEnabled)
  const setConflictAgentProvider = useProjectsStore((s) => s.setConflictAgentProvider)
  const setConflictAgentModel = useProjectsStore((s) => s.setConflictAgentModel)
  const setGraphifyEnabled = useProjectsStore((s) => s.setGraphifyEnabled)
  const setAutoWorktree = useProjectsStore((s) => s.setAutoWorktree)
  const cleanupOrphanWorktrees = useProjectsStore((s) => s.cleanupOrphanWorktrees)
  const isCleaningOrphans = useProjectsStore((s) => s.isCleaningOrphans)
  const merge = useMergeStore()

  const project = useProjectsStore((s) =>
    context?.projectId ? (s.projects.find((p) => p.id === context.projectId) ?? null) : null,
  )

  const [name, setName] = useState('')
  const [color, setColor] = useState<string>(GROUP_COLORS[0])
  const [isColorPopoverOpen, setIsColorPopoverOpen] = useState(false)
  const [iconUrl, setIconUrl] = useState('')
  const [worktreeMode, setWorktreeModeState] = useState<'gitWorktree' | 'localCopy'>('gitWorktree')
  const [validationCommandsStr, setValidationCommandsStr] = useState('')
  const [healthCheckCommand, setHealthCheckCommandState] = useState('')
  const [healthCheckPath, setHealthCheckPathState] = useState('')
  const [gsdWatcherEnabled, setGsdWatcherEnabledState] = useState(false)
  const [worktrees, setWorktrees] = useState<any[]>([])
  const [loadingWorktrees, setLoadingWorktrees] = useState(false)
  const [conflictProvider, setConflictProviderState] = useState<AgentType>('claude')
  const [conflictModel, setConflictModelState] = useState('')
  const [graphifyEnabled, setGraphifyEnabledState] = useState(false)
  const [autoWorktree, setAutoWorktreeState] = useState(false)
  const [mergePostAction, setMergePostActionState] = useState<
    'relocateToNewBranch' | 'relocateKeepSession' | 'closeTerminal'
  >('relocateToNewBranch')
  const [branches, setBranches] = useState<string[]>([])
  const [mergeSource, setMergeSource] = useState('')
  const [mergeTarget, setMergeTarget] = useState('')
  const [newAgentName, setNewAgentName] = useState('')
  const [creatingAgent, setCreatingAgent] = useState(false)
  const [activeTab, setActiveTab] = useState<'focus' | 'agents' | 'worktrees' | 'merge'>('focus')

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
    setHealthCheckCommandState(project.healthCheckCommand ?? '')
    setHealthCheckPathState(project.healthCheckPath ?? '')
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
      gitListBranches(repoPath)
        .then((list) => {
          setBranches(list)
          // Defaults sensatos: target = branch "principal" se existir.
          const main = list.find((b) => b === 'main' || b === 'master') ?? list[0] ?? ''
          setMergeTarget((prev) => prev || main)
          setMergeSource((prev) => prev || (list.find((b) => b !== main) ?? ''))
        })
        .catch(() => setBranches([]))

      // Suggests ready-made validation commands when the field is empty —
      // without this, `validationCommands` stays empty forever (nobody fills
      // it in by hand) and the verification gate never actually runs
      // anything. Only pre-fills, never overwrites what the user already
      // typed; the `openedProjectId` guard avoids applying the suggestion
      // after the modal has already closed or reopened on another project
      // while the promise was running.
      if ((project.validationCommands ?? []).length === 0) {
        const openedProjectId = project.id
        detectProjectStack(repoPath)
          .then((detection) => {
            if (
              seededForRef.current !== openedProjectId ||
              detection.suggestedCommands.length === 0
            ) {
              return
            }
            setValidationCommandsStr((prev) =>
              prev.trim() ? prev : detection.suggestedCommands.join('\n'),
            )
          })
          .catch(() => {})
      }
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

    const trimmedHealthCommand = healthCheckCommand.trim()
    if (trimmedHealthCommand !== (project.healthCheckCommand ?? '')) {
      setHealthCheckCommand(project.id, trimmedHealthCommand)
    }
    const trimmedHealthPath = healthCheckPath.trim()
    if (trimmedHealthPath !== (project.healthCheckPath ?? '')) {
      setHealthCheckPath(project.id, trimmedHealthPath)
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
      width={760}
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
      <div className={styles.layout}>
        <nav className={styles.nav} aria-label={t('crud.editProjectSections')}>
          {(
            [
              ['focus', t('crud.editProjectFocus'), Palette],
              ['agents', t('crud.editProjectAgents'), Bot],
              ['worktrees', t('crud.editProjectWorktrees'), GitBranch],
              ['merge', t('crud.editProjectMerge'), GitMerge],
            ] as const
          ).map(([id, label, Icon]) => (
            <button
              key={id}
              type="button"
              className={`${styles.navItem} ${activeTab === id ? styles.navItemActive : ''}`}
              onClick={() => setActiveTab(id)}
              aria-current={activeTab === id ? 'page' : undefined}
            >
              <Icon size={15} />
              <span>{label}</span>
            </button>
          ))}
        </nav>
        <div className={styles.panel}>
          {activeTab === 'focus' ? (
            <div>
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

                  {/* Active custom color (if not in the GROUP_COLORS presets and not rainbow) */}
                  {color && !GROUP_COLORS.includes(color as any) && color !== 'rgb-rainbow' && (
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

                  {/* Full Palette / More Colors button */}
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

                  <button
                    type="button"
                    onClick={() => setColor('rgb-rainbow')}
                    title={t('crud.colorRainbow')}
                    aria-label={t('crud.colorRainbow')}
                    className="swatch-rgb-rainbow"
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: '50%',
                      border:
                        color === 'rgb-rainbow' ? '2px solid var(--fg)' : '2px solid transparent',
                      cursor: 'pointer',
                    }}
                  />
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
            <div>
              <EditProjectAgentSettings
                projectId={project.id}
                cwd={project.terminals[0]?.cwd ?? project.defaultCwd ?? ''}
                worktreeMode={worktreeMode}
                onWorktreeModeChange={setWorktreeModeState}
                validationCommandsStr={validationCommandsStr}
                onValidationCommandsChange={setValidationCommandsStr}
                healthCheckCommand={healthCheckCommand}
                onHealthCheckCommandChange={setHealthCheckCommandState}
                healthCheckPath={healthCheckPath}
                onHealthCheckPathChange={setHealthCheckPathState}
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
            <div>
              {/* --- RFC-003 Worktrees Ativos --- */}
              <hr
                style={{
                  margin: '20px 0 16px',
                  border: 'none',
                  borderTop: '1px solid var(--border)',
                }}
              />
              <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>
                Ambientes de Agentes Ativos (Worktrees)
              </h3>

              {loadingWorktrees ? (
                <div style={{ fontSize: 11, color: 'var(--fg-muted)' }}>
                  Carregando worktrees...
                </div>
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

              {/* --- RFC-006/007/008 — Ciclo de merge seguro --- */}
            </div>
          ) : null}

          {activeTab === 'merge' ? (
            <div>
              <hr
                style={{
                  margin: '20px 0 16px',
                  border: 'none',
                  borderTop: '1px solid var(--border)',
                }}
              />
              <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>
                {t('merge.sectionTitle')}
              </h3>

              {branches.length < 2 ? (
                <div style={{ fontSize: 11, color: 'var(--fg-muted)', fontStyle: 'italic' }}>
                  {t('merge.needBranches')}
                </div>
              ) : (
                <>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
                    <div className={controls.field} style={{ flex: 1 }}>
                      <label className={controls.label}>{t('merge.sourceLabel')}</label>
                      <Dropdown
                        className={controls.input}
                        value={mergeSource}
                        onChange={setMergeSource}
                        ariaLabel={t('merge.sourceLabel')}
                        options={branches.map((b) => ({ value: b, label: b }))}
                      />
                    </div>
                    <div className={controls.field} style={{ flex: 1 }}>
                      <label className={controls.label}>{t('merge.targetLabel')}</label>
                      <Dropdown
                        className={controls.input}
                        value={mergeTarget}
                        onChange={setMergeTarget}
                        ariaLabel={t('merge.targetLabel')}
                        options={branches.map((b) => ({ value: b, label: b }))}
                      />
                    </div>
                  </div>

                  <div className={controls.field} style={{ marginTop: 8 }}>
                    <label className={controls.label}>{t('merge.postActionLabel')}</label>
                    <div style={{ display: 'flex', gap: 16, marginTop: 4, flexWrap: 'wrap' }}>
                      <label
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 6,
                          fontSize: 12,
                          cursor: 'pointer',
                        }}
                      >
                        <input
                          type="radio"
                          name="mergePostAction"
                          value="relocateToNewBranch"
                          checked={mergePostAction === 'relocateToNewBranch'}
                          onChange={() => setMergePostActionState('relocateToNewBranch')}
                        />
                        {t('merge.postActionRelocateChat')}
                      </label>
                      <label
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 6,
                          fontSize: 12,
                          cursor: 'not-allowed',
                          opacity: 0.6,
                        }}
                        title={t('merge.postActionRelocateSessionDisabledHint')}
                      >
                        <input
                          type="radio"
                          name="mergePostAction"
                          value="relocateKeepSession"
                          checked={mergePostAction === 'relocateKeepSession'}
                          disabled
                          onChange={() => {}}
                        />
                        {t('merge.postActionRelocateSession')}
                      </label>
                      <label
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 6,
                          fontSize: 12,
                          cursor: 'pointer',
                        }}
                      >
                        <input
                          type="radio"
                          name="mergePostAction"
                          value="closeTerminal"
                          checked={mergePostAction === 'closeTerminal'}
                          onChange={() => setMergePostActionState('closeTerminal')}
                        />
                        {t('merge.postActionClose')}
                      </label>
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--fg-muted)', marginTop: 6 }}>
                      {t('merge.postActionHint')}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--status-waiting)', marginTop: 4 }}>
                      {t('merge.postActionRelocateSessionDisabledHint')}
                    </div>
                  </div>

                  <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                    <button
                      type="button"
                      className={controls.btn}
                      disabled={
                        !mergeSource ||
                        !mergeTarget ||
                        mergeSource === mergeTarget ||
                        merge.phase === 'analyzing'
                      }
                      onClick={() => {
                        const repoPath = getProjectRepoRoot(project)
                        if (repoPath)
                          void merge.analyze(project, repoPath, mergeSource, mergeTarget)
                      }}
                    >
                      {merge.phase === 'analyzing' ? t('merge.analyzing') : t('merge.analyze')}
                    </button>
                    <button
                      type="button"
                      className={`${controls.btn} ${controls.btnPrimary}`}
                      disabled={
                        !mergeSource ||
                        !mergeTarget ||
                        mergeSource === mergeTarget ||
                        merge.phase === 'preparing' ||
                        merge.phase === 'resolving' ||
                        merge.phase === 'finalizing_commit' ||
                        merge.phase === 'branch_diverged' ||
                        merge.phase === 'rebase_attempt'
                      }
                      onClick={() => {
                        const repoPath = getProjectRepoRoot(project)
                        if (repoPath) void merge.start(project, repoPath, mergeSource, mergeTarget)
                      }}
                    >
                      {t('merge.start')}
                    </button>
                    {merge.phase === 'resolving' && (
                      <>
                        <button
                          type="button"
                          className={controls.btn}
                          disabled={merge.isFinalizing}
                          onClick={() => void merge.finalize()}
                        >
                          {merge.isFinalizing ? t('merge.finalizing') : t('merge.finalize')}
                        </button>
                        <button
                          type="button"
                          className={controls.btn}
                          disabled={merge.isFinalizing}
                          onClick={() => void merge.abort()}
                        >
                          {t('merge.abort')}
                        </button>
                      </>
                    )}
                    {merge.phase === 'failed' && (
                      <>
                        <button
                          type="button"
                          className={controls.btn}
                          disabled={merge.isFinalizing}
                          onClick={() => void merge.retry()}
                        >
                          {merge.isFinalizing
                            ? t('merge.finalizing')
                            : t('merge.retry', { count: merge.retryCount })}
                        </button>
                        <button
                          type="button"
                          className={controls.btn}
                          disabled={merge.isFinalizing}
                          onClick={() => void merge.abort()}
                        >
                          {t('merge.abort')}
                        </button>
                      </>
                    )}
                    {(merge.phase === 'finalizing_commit' ||
                      merge.phase === 'branch_diverged' ||
                      merge.phase === 'rebase_attempt') && (
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          fontSize: 11,
                          color: 'var(--fg-muted)',
                        }}
                      >
                        {t('merge.finalizing')}
                      </div>
                    )}
                    {merge.phase === 'terminal_error' && (
                      <button
                        type="button"
                        className={controls.btn}
                        disabled={merge.isFinalizing}
                        onClick={() => void merge.abort()}
                      >
                        {merge.isFinalizing ? t('merge.cleaningUp') : t('merge.forceCleanup')}
                      </button>
                    )}
                  </div>

                  {merge.analysis && (
                    <div style={{ marginTop: 8, fontSize: 11, color: 'var(--fg-muted)' }}>
                      {merge.analysis.clean
                        ? t('merge.analysisClean')
                        : t('merge.analysisConflicts', { count: merge.analysis.conflicts.length })}
                      {!merge.analysis.clean && (
                        <div style={{ marginTop: 4, fontFamily: 'monospace', fontSize: 10 }}>
                          {merge.analysis.conflicts.slice(0, 8).map((c) => (
                            <div key={c.path}>
                              {c.path} · {c.class}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {merge.phase === 'resolving' && (
                    <div
                      style={{
                        marginTop: 8,
                        fontSize: 11,
                        color: 'var(--status-working, var(--fg-muted))',
                      }}
                    >
                      {t('merge.resolvingHint')}
                    </div>
                  )}
                  {merge.outcome && !merge.outcome.merged && (
                    <div style={{ marginTop: 8, fontSize: 11, color: 'var(--status-stopped)' }}>
                      {t('merge.blockedTitle', { stage: merge.outcome.stage })}
                    </div>
                  )}
                  {merge.phase === 'merged' && (
                    <div
                      style={{
                        marginTop: 8,
                        fontSize: 11,
                        color: 'var(--status-active, var(--fg))',
                      }}
                    >
                      {t('merge.mergedTitle')}
                    </div>
                  )}
                  {merge.phase === 'terminal_error' && (
                    <div style={{ marginTop: 8, fontSize: 11, color: 'var(--status-stopped)' }}>
                      {t('merge.terminalErrorHint')}
                    </div>
                  )}
                  {merge.phase === 'failed' && merge.adminLockReason && (
                    <div style={{ marginTop: 8, fontSize: 11, color: 'var(--status-stopped)' }}>
                      {t('merge.adminLockedReason', { reason: merge.adminLockReason })}
                    </div>
                  )}
                  {merge.error && (
                    <div style={{ marginTop: 8, fontSize: 11, color: 'var(--status-stopped)' }}>
                      {merge.error}
                    </div>
                  )}
                </>
              )}
            </div>
          ) : null}
        </div>
      </div>

      <ColorPalettePopover
        open={isColorPopoverOpen}
        onClose={() => setIsColorPopoverOpen(false)}
        onSelectColor={(selected) => setColor(selected)}
        selectedColor={color}
      />
    </Modal>
  )
}
