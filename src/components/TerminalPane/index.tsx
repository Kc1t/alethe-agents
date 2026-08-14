import { useDraggable, useDroppable } from '@dnd-kit/core'
import {
  GripVertical,
  Maximize2,
  Minimize2,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  Trash2,
  X,
} from 'lucide-react'
import { memo, useEffect, useMemo, useRef, useState } from 'react'

import { useGridResize } from '../../hooks/useGridResize'
import { restartAgentPty } from '../../lib/agentPtyRestart'
import { buildGhosttyCommand } from '../../lib/ghosttyCommand'
import { useT } from '../../lib/i18n'
import { shouldUseNativeBackend } from '../../lib/platform'
import { getActiveSessions, savedConversationIdFor } from '../../lib/sessionResume'
import { getPtyCwd, openInVscode, snapshotCodexSessions } from '../../lib/tauri'
import {
  type AgentType,
  type SubTab,
  type Terminal as TerminalEntry,
  type Theme,
} from '../../lib/types'
import { useProjectsStore } from '../../stores/projectsStore'
import { useTerminalsStore } from '../../stores/terminalsStore'
import { useUiStore } from '../../stores/uiStore'
import { GhosttySurface } from '../GhosttySurface'
import { AgentIcon, VSCodeIcon } from '../icons/AgentIcons'
import { SubTabsLane } from '../SubTabsLane'
import { XTermView } from '../XTermView'
import styles from './TerminalPane.module.css'

export type TerminalPaneProps = {
  projectId: string
  terminal: TerminalEntry
  /** Hide the pane drag affordance when the parent group has nothing to reorder. */
  paneDragEnabled?: boolean
  /** True quando renderizado dentro do FocusOverlay (mostra Minimize, esconde Focus). */
  inFocusOverlay?: boolean
  /** True quando renderizado na Home — esconde grip, actions, lane, grid resize. */
  preview?: boolean
}

export const TerminalPane = memo(function TerminalPane({
  projectId,
  terminal,
  paneDragEnabled = true,
  inFocusOverlay = false,
  preview = false,
}: TerminalPaneProps) {
  const t = useT()
  const [resumeNonce, setResumeNonce] = useState(0)
  const focusedTerminalId = useUiStore((s) => s.focusedTerminalId)
  const isFocusMode = inFocusOverlay || focusedTerminalId === terminal.id
  const canDragPane = paneDragEnabled && !isFocusMode && !preview
  // Drag-and-drop pra reordenar entre panes (igual canvas-agents focus mode).
  // Skip the focus overlay; a single pane cannot be reordered.
  const draggable = useDraggable({
    id: `pane:${terminal.id}`,
    disabled: !canDragPane,
  })
  const droppable = useDroppable({
    id: `pane:${terminal.id}`,
    disabled: !canDragPane,
  })
  const paneRef = useRef<HTMLDivElement | null>(null)
  const setRefs = (node: HTMLDivElement | null) => {
    paneRef.current = node
    draggable.setNodeRef(node)
    droppable.setNodeRef(node)
  }

  // Foco vindo da sidebar — scroll into view + foca o textarea do xterm.
  const focusReq = useUiStore((s) => s.focusRequest)
  useEffect(() => {
    if (!focusReq || focusReq.terminalId !== terminal.id) return
    const node = paneRef.current
    if (!node) return
    node.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' })
    const focusInput = () => {
      const textarea = node.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')
      textarea?.focus()
    }
    focusInput()
    const frame = window.requestAnimationFrame(focusInput)
    const shortRetry = window.setTimeout(focusInput, 120)
    const layoutRetry = window.setTimeout(focusInput, 420)
    return () => {
      window.cancelAnimationFrame(frame)
      window.clearTimeout(shortRetry)
      window.clearTimeout(layoutRetry)
    }
  }, [focusReq, terminal.id])

  const setActiveTab = useProjectsStore((s) => s.setActiveTab)
  const closeSubTab = useProjectsStore((s) => s.closeSubTab)
  const setLaneVisible = useProjectsStore((s) => s.setLaneVisible)
  const setTerminalDisabled = useProjectsStore((s) => s.setTerminalDisabled)
  const markTerminalUsed = useProjectsStore((s) => s.markTerminalUsed)
  const setSubTabPtyId = useProjectsStore((s) => s.setSubTabPtyId)
  const setSubTabSessionId = useProjectsStore((s) => s.setSubTabSessionId)
  const setSubTabInitialInput = useProjectsStore((s) => s.setSubTabInitialInput)
  const setSubTabSkipSessionClaim = useProjectsStore((s) => s.setSubTabSkipSessionClaim)
  const setSubTabCompletionUnread = useProjectsStore((s) => s.setSubTabCompletionUnread)
  const deleteTerminalWithWorktreeCleanup = useProjectsStore(
    (s) => s.deleteTerminalWithWorktreeCleanup,
  )
  const setProjectGridLayout = useProjectsStore((s) => s.setProjectGridLayout)
  const openModal = useUiStore((s) => s.openModal_)
  const setFocusedTerminal = useUiStore((s) => s.setFocusedTerminal)
  const setActiveTerminal = useUiStore((s) => s.setActiveTerminal)
  const selectPane = useUiStore((s) => s.selectPane)
  const clearPaneSelection = useUiStore((s) => s.clearPaneSelection)
  const groupPanes = useProjectsStore((s) => s.groupPanes)
  const requestPaneFocus = useUiStore((s) => s.requestPaneFocus)
  const pushToast = useUiStore((s) => s.pushToast)
  const terminalTheme = useProjectsStore(
    (s) => s.preferences.terminalTheme ?? s.preferences.uiTheme,
  )
  // Native Ghostty rendering is opt-in and macOS-only; other platforms use xterm.js.
  const nativeTerminalMacos = useProjectsStore((s) => s.preferences.nativeTerminalMacos ?? false)
  const useNativeBackend = shouldUseNativeBackend(nativeTerminalMacos)

  // RFC-004 — projeto com Graphify habilitado: cada spawn de agente recebe o
  // repo para injetar o MCP (o XTermView resolve o config/bootstrap).
  const graphifyRepo = useProjectsStore((s) => {
    const p = s.projects.find((p) => p.id === projectId)
    if (!p?.graphifyEnabled) return null
    return terminal.cwd || p.terminals[0]?.cwd || null
  })

  // Gate de Conclusão de Planejamento GSD: projeto com o monitoramento
  // ligado ganha o plugin OpenCode que mantém .planning/ sincronizado
  // sozinho (ver XTermView, gatilho condicionado a command === 'opencode').
  // NUNCA pro agente efêmero de resolução de conflito (`mergeStore.ts` —
  // "nasce, resolve, morre") — confirmado ao vivo: sem essa exclusão, o
  // plugin era instalado nele igual a qualquer worktree normal, criando uma
  // sessão-filha de verdade que ficava órfã assim que o agente descartável
  // era encerrado ao final do merge.
  const gsdWatcherEnabled = useProjectsStore((s) => {
    if (terminal.ephemeralConflictAgent) return false
    const p = s.projects.find((p) => p.id === projectId)
    return Boolean(p?.gsdWatcherEnabled)
  })

  // Resize de span no grid do PROJETO (quando project.layoutMode === 'grid').
  const projectGrid = useProjectsStore((s) => {
    const p = s.projects.find((p) => p.id === projectId)
    if (!p || p.layoutMode !== 'grid' || !p.gridLayout) return null
    return p.gridLayout
  })
  const showGridResize = Boolean(projectGrid) && !isFocusMode && !terminal.disabled && !preview
  const startGridResize = useGridResize(terminal.id, projectGrid, (layout) =>
    setProjectGridLayout(projectId, layout),
  )

  const activeTab: SubTab | undefined = useMemo(
    () => terminal.tabs.find((tab) => tab.id === terminal.activeTabId) ?? terminal.tabs[0],
    [terminal.tabs, terminal.activeTabId],
  )

  const effectiveLaneVisible = terminal.tabs.length > 1 ? true : terminal.laneVisible === true

  const ptyRuntime = useTerminalsStore((s) =>
    activeTab?.ptyId ? (s.byPtyId[activeTab.ptyId] ?? null) : null,
  )
  const ptyExited = ptyRuntime !== null && !ptyRuntime.alive
  const ptyParked = ptyRuntime?.parked === true

  const openVscode = async () => {
    let target = cwd
    if (!target && activeTab?.ptyId) {
      target = (await getPtyCwd(activeTab.ptyId).catch(() => null)) ?? ''
    }
    if (!target) return
    await openInVscode(target).catch((err) => {
      console.error('open vscode falhou', err)
    })
  }

  const onRestart = async () => {
    if (!activeTab?.ptyId || terminal.disabled) return
    if (ptyParked) {
      setResumeNonce((value) => value + 1)
      requestPaneFocus(terminal.id)
      return
    }
    const ptyId = activeTab.ptyId
    let restartCwd = (activeTab.cwd || terminal.cwd || '').trim()
    if (!restartCwd) {
      restartCwd = ((await getPtyCwd(ptyId).catch(() => null)) ?? '').trim()
    }
    const activeSessions = getActiveSessions()
    const savedSession = activeSessions[activeTab.id] ?? activeSessions[ptyId] ?? null
    let resumeSessionId =
      activeTab.sessionId ?? savedConversationIdFor(savedSession, activeTab.type, restartCwd)
    // A descoberta do ID do Codex ocorre depois do spawn. Se o usuário precisar
    // recuperar o PTY antes dela terminar, o rollout mais recente desse cwd é a
    // conversa que estava ativa e deve ser retomada, não uma sessão vazia.
    if (!resumeSessionId && activeTab.type === 'codex' && restartCwd) {
      resumeSessionId = (await snapshotCodexSessions(restartCwd).catch(() => []))[0]?.id
    }
    const areaEl = paneRef.current?.querySelector<HTMLElement>(`.${styles.terminalArea}`)
    let startCols: number | undefined
    let startRows: number | undefined
    if (areaEl) {
      const rect = areaEl.getBoundingClientRect()
      if (rect.width > 50 && rect.height > 30) {
        startCols = Math.max(40, Math.floor((rect.width - 14) / 8.4))
        startRows = Math.max(10, Math.floor((rect.height - 6) / 17))
      }
    }
    try {
      // XTermView usa a identidade estável da sub-tab (`activeTab.id`) como
      // chave de persistência; manter a mesma chave garante que remounts
      // posteriores (reload do app) consumam a sessão salva aqui.
      await restartAgentPty({
        ptyId,
        sessionPersistenceKey: activeTab.id,
        agent: activeTab.type,
        cwd: restartCwd,
        runtimeProfile: activeTab.runtimeProfile,
        extraArgs: activeTab.extraArgs ?? [],
        resumeId: resumeSessionId,
        cols: startCols,
        rows: startRows,
        onSessionId: (id) => setSubTabSessionId(projectId, terminal.id, activeTab.id, id),
      })
      setResumeNonce((value) => value + 1)
      window.dispatchEvent(new CustomEvent('alethe:terminal-resize-request', { detail: { ptyId } }))
      requestPaneFocus(terminal.id)
      window.setTimeout(() => requestPaneFocus(terminal.id), 160)
    } catch (err) {
      console.error('restart pty falhou', err)
      pushToast({ title: t('ui.terminal.restartFailed'), body: String(err) })
    }
  }

  useEffect(() => {
    const onRestartRequest = (event: Event) => {
      const detail = (event as CustomEvent<{ terminalId?: string; ptyId?: string }>).detail
      const matchesTerminal = detail?.terminalId === terminal.id
      const matchesPty = Boolean(detail?.ptyId && detail.ptyId === activeTab?.ptyId)
      if (matchesTerminal || matchesPty) void onRestart()
    }
    window.addEventListener('alethe:terminal-restart-request', onRestartRequest)
    return () => window.removeEventListener('alethe:terminal-restart-request', onRestartRequest)
  })

  const onDisable = () => setTerminalDisabled(projectId, terminal.id, !terminal.disabled)

  const onDelete = () => {
    if (!window.confirm(t('ui.sidebar.confirmDeleteTerminal', { name: terminal.name }))) return
    void deleteTerminalWithWorktreeCleanup(projectId, terminal.id)
    if (isFocusMode) setFocusedTerminal(null)
  }

  const onToggleLane = () => {
    if (terminal.tabs.length > 1) return
    setLaneVisible(projectId, terminal.id, !effectiveLaneVisible)
  }

  const cwd = activeTab?.cwd?.trim() || terminal.cwd?.trim() || ''

  const dropTarget = canDragPane && droppable.isOver
  const dragging = canDragPane && draggable.isDragging

  return (
    <div
      ref={setRefs}
      data-pane-box="1"
      onPointerDown={(event) => {
        markTerminalUsed(projectId, terminal.id)
        setActiveTerminal(projectId, terminal.id)
        const existing = useUiStore.getState().selectedPanes
        const extend = event.shiftKey && existing.every((pane) => pane.projectId === projectId)
        selectPane(projectId, terminal.id, extend)
        if (extend) {
          const selected = useUiStore.getState().selectedPanes
          if (selected.length >= 2) {
            groupPanes(
              projectId,
              selected.map((pane) => pane.terminalId),
            )
            clearPaneSelection()
          }
        }
      }}
      className={`${styles.pane} ${isFocusMode ? styles.paneFocus : ''} ${terminal.disabled ? styles.disabled : ''} ${dragging ? styles.dragging : ''} ${dropTarget ? styles.dropTarget : ''}`}
    >
      <header className={styles.header}>
        <div
          className={styles.headLeft}
          onDoubleClick={() => setFocusedTerminal(isFocusMode ? null : terminal.id)}
          title={
            isFocusMode ? t('ui.terminal.exitFocusModeEsc') : t('ui.terminal.focusModeFullscreen')
          }
        >
          {canDragPane ? (
            <button
              type="button"
              className={`${styles.action} ${styles.gripBtn}`}
              {...draggable.attributes}
              {...draggable.listeners}
              title={t('ui.terminal.dragToReorder')}
              aria-label={t('ui.terminal.dragToReorder')}
            >
              <GripVertical size={12} />
            </button>
          ) : null}
          <span className={styles.iconWrap}>
            {activeTab ? <AgentIcon type={activeTab.type} size={16} theme={terminalTheme} /> : null}
          </span>
          <div className={styles.identity}>
            <span className={styles.name} title={terminal.name}>
              {terminal.name}
            </span>
          </div>
        </div>

        {!preview ? (
          <div className={styles.headRight}>
            <div className={styles.actions}>
              <button
                type="button"
                className={styles.action}
                onClick={onToggleLane}
                title={
                  effectiveLaneVisible
                    ? t('ui.terminal.hideTabsLane')
                    : t('ui.terminal.showTabsLane')
                }
                aria-label={t('ui.terminal.toggleLane')}
                aria-pressed={effectiveLaneVisible}
                disabled={terminal.tabs.length > 1}
              >
                {effectiveLaneVisible ? <PanelLeftClose size={12} /> : <PanelLeftOpen size={12} />}
              </button>
              <button
                type="button"
                className={styles.action}
                onClick={() => void openVscode()}
                title={t('ui.terminal.openInVscode')}
                aria-label={t('ui.terminal.openInVscode')}
                disabled={!activeTab}
              >
                <VSCodeIcon size={12} />
              </button>
              <button
                type="button"
                className={styles.action}
                onClick={() => setFocusedTerminal(isFocusMode ? null : terminal.id)}
                title={
                  isFocusMode
                    ? t('ui.terminal.exitFocusModeEsc')
                    : t('ui.terminal.focusModeFullscreen')
                }
                aria-label={
                  isFocusMode ? t('ui.terminal.exitFocusMode') : t('ui.terminal.focusMode')
                }
              >
                {isFocusMode ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
              </button>
              {activeTab?.ptyId ? (
                <button
                  type="button"
                  className={styles.action}
                  onClick={() => void onRestart()}
                  title={ptyParked ? t('ui.terminal.resume') : t('ui.terminal.restart')}
                  aria-label={ptyParked ? t('ui.terminal.resume') : t('ui.terminal.restart')}
                  disabled={terminal.disabled}
                >
                  <RefreshCw size={12} />
                </button>
              ) : null}
              <button
                type="button"
                className={`${styles.action} ${styles.danger}`}
                onClick={onDelete}
                title={t('ui.sidebar.deleteTerminal')}
                aria-label={t('ui.sidebar.deleteTerminal')}
              >
                <Trash2 size={12} />
              </button>
            </div>
          </div>
        ) : null}
      </header>

      <div className={styles.body}>
        {effectiveLaneVisible && !preview ? (
          <SubTabsLane
            tabs={terminal.tabs}
            activeTabId={terminal.activeTabId}
            onActivate={(id) => setActiveTab(projectId, terminal.id, id)}
            onClose={(id) => closeSubTab(projectId, terminal.id, id)}
            onAdd={() => openModal('newSubTab', { projectId, terminalId: terminal.id })}
          />
        ) : null}

        <div className={styles.terminalArea}>
          {terminal.disabled ? (
            <DisabledOverlay
              terminalName={terminal.name}
              cwd={cwd}
              agentType={activeTab?.type ?? 'shell'}
              terminalTheme={terminalTheme}
              onReactivate={onDisable}
            />
          ) : activeTab ? (
            <>
              {useNativeBackend ? (
                <GhosttySurface
                  key={`${activeTab.id}:${resumeNonce}`}
                  surfaceId={activeTab.id}
                  cwd={activeTab.cwd?.trim() || terminal.cwd?.trim() || undefined}
                  command={buildGhosttyCommand(activeTab.type, activeTab.extraArgs)}
                  onSpawned={(id) => {
                    if (activeTab.ptyId !== id) {
                      setSubTabPtyId(projectId, terminal.id, activeTab.id, id)
                    }
                  }}
                />
              ) : (
                <XTermView
                  key={`${activeTab.id}:${resumeNonce}`}
                  projectId={projectId}
                  ptyId={activeTab.ptyId ?? activeTab.id}
                  sessionKey={activeTab.id}
                  command={activeTab.type === 'shell' ? null : activeTab.type}
                  cwd={activeTab.cwd || null}
                  extraArgs={activeTab.extraArgs}
                  initialInput={activeTab.initialInput}
                  runtimeProfile={activeTab.runtimeProfile}
                  sessionId={activeTab.sessionId}
                  skipSessionClaim={activeTab.skipSessionClaim}
                  onSessionClaimSkipped={() =>
                    setSubTabSkipSessionClaim(projectId, terminal.id, activeTab.id, false)
                  }
                  graphifyRepo={graphifyRepo}
                  gsdWatcherEnabled={gsdWatcherEnabled}
                  trustSessionId={terminal.gsdSyncViewer}
                  readOnly={terminal.gsdSyncViewer}
                  terminalTheme={terminalTheme}
                  onSpawned={(id) => {
                    if (activeTab.ptyId !== id) {
                      setSubTabPtyId(projectId, terminal.id, activeTab.id, id)
                    }
                  }}
                  onSessionId={(sessionId) => {
                    if (activeTab.sessionId !== sessionId) {
                      setSubTabSessionId(projectId, terminal.id, activeTab.id, sessionId)
                    }
                  }}
                  onInitialInputSent={() =>
                    setSubTabInitialInput(projectId, terminal.id, activeTab.id, undefined)
                  }
                  onAgentComplete={() =>
                    setSubTabCompletionUnread(projectId, terminal.id, activeTab.id, true)
                  }
                />
              )}
              {ptyExited && !useNativeBackend ? (
                <div className={styles.exitedOverlay}>
                  <RefreshCw size={24} style={{ opacity: 0.5 }} />
                  {!ptyParked ? (
                    <span className={styles.exitedLabel}>{t('ui.terminal.processEnded')}</span>
                  ) : null}
                  <button
                    type="button"
                    className={styles.restartBtn}
                    onClick={() => void onRestart()}
                  >
                    {ptyParked ? t('ui.terminal.resume') : t('ui.terminal.restart')}
                  </button>
                </div>
              ) : null}
            </>
          ) : (
            <div className={styles.empty}>
              <X size={20} />
              <span>{t('ui.terminal.noTab')}</span>
            </div>
          )}
        </div>
      </div>

      {showGridResize ? (
        <div
          className={styles.gridResize}
          onPointerDown={startGridResize}
          title={t('ui.terminal.dragToResizeSpan')}
        />
      ) : null}
    </div>
  )
})

function DisabledOverlay({
  terminalName,
  cwd,
  agentType,
  terminalTheme,
  onReactivate,
}: {
  terminalName: string
  cwd: string
  agentType: AgentType
  terminalTheme: Theme
  onReactivate: () => void
}) {
  const t = useT()
  return (
    <div className={styles.disabledOverlay}>
      <div className={styles.disabledIcon}>
        <AgentIcon type={agentType} size={56} theme={terminalTheme} />
      </div>
      <div className={styles.disabledName}>{terminalName}</div>
      {cwd ? <div className={styles.disabledCwd}>{cwd}</div> : null}
      <button type="button" className={styles.reactivateBtn} onClick={onReactivate}>
        {t('ui.sidebar.reactivate')}
      </button>
    </div>
  )
}
