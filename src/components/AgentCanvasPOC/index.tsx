import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDndMonitor,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import { listen } from '@tauri-apps/api/event'
import { Bot, ClipboardCopy, Link2, Plus, X } from 'lucide-react'
import {
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'

import { useOnClickOutside } from '../../hooks/useOnClickOutside'
import { useOnEscape } from '../../hooks/useOnEscape'
import { COST_POLL_MS, TEST_PROMPT } from '../../lib/agentCanvasConfig'
import {
  colorFor,
  costClassFor,
  type Edge,
  estimateRoutingSavings,
  formatReset,
  personaIconFor,
} from '../../lib/agentCanvasUtils'
import { AGENT_LIBRARY } from '../../lib/agentLibrary'
import { fmtTokens, fmtUsd, shortModel } from '../../lib/costFormat'
import { useT } from '../../lib/i18n'
import { normalizeCwd } from '../../lib/platform'
import {
  agentHooksEndpoint,
  agentHooksSettingsPath,
  getModelPricing,
  killPty,
  type ModelRate,
  writeClipboardText,
} from '../../lib/tauri'
import {
  type AgentHookPayload,
  type AgentNode,
  useAgentCanvasStore,
} from '../../stores/agentCanvasStore'
import { useAgentCostStore } from '../../stores/agentCostStore'
import { selectNodeCostTotals, useNodeCostStore } from '../../stores/nodeCostStore'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import styles from './AgentCanvasPOC.module.css'
import { AgentChip } from './AgentChip'
import { AgentLibraryPalette } from './AgentLibraryPalette'
import { AgentModal } from './AgentModal'
import { AgentNodeCard } from './AgentNodeCard'
import { CanvasTopBar } from './CanvasTopBar'
import { CodexTerminalOverlay } from './CodexTerminalOverlay'
import { CodexWorkerCard } from './CodexWorkerCard'
import { useAgentWorkers } from './hooks/useAgentWorkers'
import { useCanvasZoom } from './hooks/useCanvasZoom'
import { useInstalledAgents } from './hooks/useInstalledAgents'
import { useUsagePolling } from './hooks/useUsagePolling'
import { SessionTerminalDock } from './SessionTerminalDock'
import { TasksLayer } from './TasksLayer'
import { type UsageTab } from './UsageDropdown'

/** Agent canvas view for embedded agent sessions and team activity. */

export function AgentCanvasPOC() {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }))
  const [draggingAgent, setDraggingAgent] = useState<string | null>(null)
  return (
    <DndContext
      sensors={sensors}
      onDragStart={(e) => setDraggingAgent(String(e.active.id).replace(/^lib:/, ''))}
      onDragEnd={() => setDraggingAgent(null)}
      onDragCancel={() => setDraggingAgent(null)}
    >
      <AgentCanvasInner />
      <DragOverlay dropAnimation={null}>
        {draggingAgent ? (
          <AgentChip
            name={draggingAgent}
            cost={AGENT_LIBRARY.find((t) => t.name === draggingAgent)?.cost}
            summary={AGENT_LIBRARY.find((t) => t.name === draggingAgent)?.summary}
            ghost
            action={<Link2 size={13} />}
          />
        ) : null}
      </DragOverlay>
    </DndContext>
  )
}

function AgentCanvasInner() {
  const t = useT()
  const setActiveView = useUiStore((s) => s.setActiveView)
  const session = useUiStore((s) => s.agentCanvasSession)
  const terminalTheme = useProjectsStore(
    (s) => s.preferences.terminalTheme ?? s.preferences.uiTheme,
  )
  const uiTheme = useProjectsStore((s) => s.preferences.uiTheme)
  const nodes = useAgentCanvasStore((s) => s.nodes)
  const tasks = useAgentCanvasStore((s) => s.tasks)
  const teamName = useAgentCanvasStore((s) => s.teamName)
  const lastEventAt = useAgentCanvasStore((s) => s.lastEventAt)
  const select = useAgentCanvasStore((s) => s.select)
  const clearStore = useAgentCanvasStore((s) => s.clear)

                                                                                   
  const nodeCosts = useNodeCostStore((s) => s.byNodeId)
  const leadCost = useAgentCostStore((s) =>
    session ? (s.byPtyId[session.ptyId]?.cost ?? null) : null,
  )
  const budgetUsd = useUiStore((s) => s.agentCanvasBudgetUsd)
  const setBudget = useUiStore((s) => s.setAgentCanvasBudget)
  const [pricing, setPricing] = useState<ModelRate[]>([])

  const [edges, setEdges] = useState<Edge[]>([])
  const [hooksSettingsPath, setHooksSettingsPath] = useState<string | null>(null)
  const [hooksEndpoint, setHooksEndpoint] = useState<string | null>(null)
  const [hooksError, setHooksError] = useState<string | null>(null)
  const [hooksRetryNonce, setHooksRetryNonce] = useState(0)
  const [claudeExited, setClaudeExited] = useState<number | null>(null)
  const [copied, setCopied] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [palettePosition, setPalettePosition] = useState({ x: 16, y: 58 })
  const [usageOpen, setUsageOpen] = useState(false)
  const [usageTab, setUsageTab] = useState<UsageTab>('claude')

                                                                          
  const sessionRef = useRef(session)
  useEffect(() => {
    sessionRef.current = session
  }, [session])

  const { setNodeRef: setDropRef, isOver: dragOver } = useDroppable({ id: 'agent-canvas-drop' })
  const { setNodeRef: setPlaneDropRef, isOver: planeDragOver } = useDroppable({
    id: 'agent-control-plane',
  })

  const containerRef = useRef<HTMLDivElement | null>(null)
  const stageRef = useRef<HTMLDivElement | null>(null)
  const usageAnchorRef = useRef<HTMLDivElement | null>(null)
  const planeRef = useRef<HTMLDivElement | null>(null)
  const cardRefs = useRef(new Map<string, HTMLDivElement>())
  const taskRefs = useRef(new Map<string, HTMLDivElement>())

  // Workers reais (PTYs claude/codex/opencode) + fallback/uso + zoom/pan +
                                                            
  const {
    codexWorkers,
    setCodexWorkers,
    expandedCodexId,
    setExpandedCodexId,
    spawnCodexWorker,
    killCodexWorker,
    killAllWorkers,
  } = useAgentWorkers(sessionRef)
  const { usage, codexUsage, fallbackActive, activateFallback } = useUsagePolling(
    session,
    sessionRef,
    hooksEndpoint,
  )
  const { zoom, pan, panning, zoomBy, fitZoom, onCanvasPointerDown, onCanvasPointerMove, endPan } =
    useCanvasZoom(containerRef, stageRef)
  const {
    installed,
    coreAgentsReady,
    economyOn,
    restartHint,
    setRestartHint,
    toggleEconomy,
    installAgent,
    uninstallAgent,
  } = useInstalledAgents(session)

  const startPaletteDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return
    const target = event.target as HTMLElement
    if (target.closest('button') && target !== event.currentTarget) return
    const originX = event.clientX
    const originY = event.clientY
    const start = palettePosition
    event.currentTarget.setPointerCapture(event.pointerId)

    const onMove = (moveEvent: PointerEvent) => {
      setPalettePosition({
        x: Math.max(8, start.x + moveEvent.clientX - originX),
        y: Math.max(48, start.y + moveEvent.clientY - originY),
      })
    }
    const onEnd = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onEnd)
      window.removeEventListener('pointercancel', onEnd)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onEnd)
    window.addEventListener('pointercancel', onEnd)
  }

                                                                            
                                                                   
  useEffect(() => {
    setHooksError(null)
    Promise.all([agentHooksEndpoint(), agentHooksSettingsPath()])
      .then(([endpoint, path]) => {
        console.log('[AgentCanvasPOC] hooks endpoint:', endpoint)
        console.log('[AgentCanvasPOC] hooks settings pronto em:', path)
        setHooksEndpoint(endpoint)
        setHooksSettingsPath(path)
      })
      .catch((err) => {
                                                                       
                                                                          
        // de tentar de novo.
        console.error('[AgentCanvasPOC] falha gerando hooks settings:', err)
        setHooksError(String(err))
      })
  }, [hooksRetryNonce])

                                                                     
  useEffect(() => {
    getModelPricing()
      .then(setPricing)
      .catch(() => {})
  }, [])

  const restartClaude = () => {
    if (!session) return
    console.log('[AgentCanvasPOC] reiniciando claude — matando PTY', session.ptyId)
    void killPty(session.ptyId).catch(() => {
                                   
    })
    setClaudeExited(null)
    setRestartHint(false)
                                                                          
                                                          
    useUiStore.getState().setAgentCanvasSession({
      folder: session.folder,
      ptyId: `agent-canvas-${Date.now()}`,
    })
  }

  // Drop da biblioteca no canvas → instala.
  useDndMonitor({
    onDragEnd: (e) => {
      const activeId = String(e.active.id)
      if (
        (e.over?.id === 'agent-canvas-drop' || e.over?.id === 'agent-control-plane') &&
        activeId.startsWith('lib:')
      ) {
        const name = activeId.slice(4)
        console.log('[AgentCanvasPOC] drop da biblioteca:', name)
        installAgent(name)
      }
    },
  })

  useEffect(() => {
    const unlistenPromise = listen<AgentHookPayload>('agent-hook', (event) => {
                                                                            
                                                                  
      const cwd = (event.payload as { cwd?: string }).cwd
      if (session && cwd && normalizeCwd(cwd) !== normalizeCwd(session.folder)) {
        console.log('[AgentCanvasPOC] evento de outra sessão ignorado (cwd):', cwd)
        return
      }
      console.log('[AgentCanvasPOC] agent-hook:', event.payload.hook_event_name, event.payload)
      useAgentCanvasStore.getState().ingest(event.payload)
    })
    return () => {
      void unlistenPromise.then((unlisten) => unlisten())
    }
  }, [session])

                                                           
  useOnClickOutside(usageAnchorRef, () => setUsageOpen(false), usageOpen)
  useOnEscape(() => setUsageOpen(false), usageOpen)
                                             
  useOnEscape(() => setPaletteOpen(false))

                                                                            
  useLayoutEffect(() => {
    const recompute = () => {
      const container = containerRef.current
      const plane = planeRef.current
      const stage = stageRef.current
      if (!container || !plane || !stage) return
                                                                               
                                                                          
                                                                                 
      const sRect = stage.getBoundingClientRect()
      const k = zoom || 1
      const pRect = plane.getBoundingClientRect()
      const x1 = (pRect.left + pRect.width / 2 - sRect.left) / k
      const y1 = (pRect.bottom - sRect.top) / k
                                                                             
                                                                              
                                                                  
      const subs = nodes.filter((n) => n.kind === 'subagent')
      const groupTypes = [...new Set(subs.map((n) => n.agentType))]
      const targets = [
        ...nodes
          .filter((n) => n.kind === 'teammate')
          .map((n) => ({ id: n.id, done: n.status === 'done' })),
        ...codexWorkers.map((w) => ({ id: w.ptyId, done: w.exitedCode !== null })),
        ...groupTypes.map((type) => ({
          id: `group:${type}`,
          done: !subs.some((n) => n.agentType === type && n.status === 'running'),
        })),
      ]
                                                    
      const nodeEdges: Edge[] = targets.flatMap((target) => {
        const el = cardRefs.current.get(target.id)
        if (!el) return []
        const r = el.getBoundingClientRect()
        return [
          {
            id: target.id,
            x1,
            y1,
            x2: (r.left + r.width / 2 - sRect.left) / k,
            y2: (r.top - sRect.top) / k,
            done: target.done,
          },
        ]
      })
                                                                                   
                                                                               
      const taskEdges: Edge[] = Object.values(tasks).flatMap((task) => {
        const taskEl = taskRefs.current.get(task.id)
        if (!taskEl) return []
        const tr = taskEl.getBoundingClientRect()
        const ownerEl = task.owner ? cardRefs.current.get(`teammate:${task.owner}`) : null
        const srcRect = ownerEl ? ownerEl.getBoundingClientRect() : pRect
        return [
          {
            id: `task:${task.id}`,
            x1: (srcRect.left + srcRect.width / 2 - sRect.left) / k,
            y1: (srcRect.bottom - sRect.top) / k,
            x2: (tr.left + tr.width / 2 - sRect.left) / k,
            y2: (tr.top - sRect.top) / k,
            done: task.status === 'completed',
          },
        ]
      })
      setEdges([...nodeEdges, ...taskEdges])
    }
    recompute()
                                                                           
                                                                                 
    const raf = requestAnimationFrame(() => requestAnimationFrame(recompute))
    const observer = new ResizeObserver(recompute)
    const container = containerRef.current
    if (container) {
      observer.observe(container)
                                                                             
                                                        
      cardRefs.current.forEach((el) => observer.observe(el))
      taskRefs.current.forEach((el) => observer.observe(el))
      container.addEventListener('scroll', recompute, { passive: true })
    }
    return () => {
      cancelAnimationFrame(raf)
      observer.disconnect()
      container?.removeEventListener('scroll', recompute)
    }
  }, [nodes, codexWorkers, tasks, zoom])

                                                                                 
                                                                              
                                                                              
                                   
  useEffect(() => {
    if (!session) return
    const tick = () => {
      void useNodeCostStore.getState().refresh(useAgentCanvasStore.getState().nodes)
      void useAgentCostStore.getState().refresh()
    }
    tick()
    const timer = window.setInterval(tick, COST_POLL_MS)
    return () => window.clearInterval(timer)
  }, [session])

  const exitCanvas = () => {
    if (session) {
      console.log('[AgentCanvasPOC] saindo — matando PTY', session.ptyId)
      void killPty(session.ptyId).catch(() => {
                                     
      })
    }
                                                                       
    killAllWorkers()
                                                                             
                                                            
    clearStore()
    useNodeCostStore.getState().clear()
    useUiStore.getState().setAgentCanvasBudget(null)
    useUiStore.getState().setAgentCanvasSession(null)
    setActiveView('home')
  }

                                                                              
                                                                            
                                                                                  
  const exitCanvasRef = useRef(exitCanvas)
  exitCanvasRef.current = exitCanvas
  useEffect(() => {
    const handler = () => exitCanvasRef.current()
    window.addEventListener('alethe:agent-canvas-exit', handler)
    return () => window.removeEventListener('alethe:agent-canvas-exit', handler)
  }, [])

  const clearCanvas = () => {
    // Mata os workers reais (PTYs claude/codex = processos pesados) — assim o
                                                             
    killAllWorkers()
    setCodexWorkers([])
    setExpandedCodexId(null)
    clearStore()
    useNodeCostStore.getState().clear()
  }

  const copyTestPrompt = () => {
    void writeClipboardText(TEST_PROMPT)
      .then(() => {
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1500)
      })
      .catch(() => navigator.clipboard?.writeText(TEST_PROMPT))
  }

  const teammates = nodes.filter((n) => n.kind === 'teammate')
  const subagents = nodes.filter((n) => n.kind === 'subagent')
  const running = nodes.filter((n) => n.status === 'running').length
  const done = nodes.filter((n) => n.status === 'done').length
  const taskList = Object.values(tasks)

                                                                              
                                                                       
  const subagentGroups: Array<[string, AgentNode[]]> = (() => {
    const map = new Map<string, AgentNode[]>()
    for (const n of subagents) {
      const arr = map.get(n.agentType)
      if (arr) arr.push(n)
      else map.set(n.agentType, [n])
    }
    return [...map]
  })()

                                                                               
  const nodeTotals = selectNodeCostTotals(nodeCosts)
  const sessionCostUsd = nodeTotals.costUsd + (leadCost?.cost_usd ?? 0)
  const sessionTokens = nodeTotals.totalTokens + (leadCost?.total_tokens ?? 0)
  const hasCost = sessionTokens > 0

                                                                          
  const routingSavings = estimateRoutingSavings(nodeCosts, leadCost?.model ?? null, pricing)

                                                               
  const budgetRatio = budgetUsd && budgetUsd > 0 ? sessionCostUsd / budgetUsd : 0
  const budgetWarn = budgetUsd != null && budgetUsd > 0 && budgetRatio >= 0.8
  const budgetCrit = budgetUsd != null && budgetUsd > 0 && sessionCostUsd >= budgetUsd

  const expandedWorker = codexWorkers.find((x) => x.ptyId === expandedCodexId) ?? null

  return (
    <div className={styles.layout}>
      <div className={styles.main}>
        <div
          className={[
            styles.canvas,
            dragOver ? styles.canvasDragOver : '',
            panning ? styles.canvasPanning : '',
          ]
            .filter(Boolean)
            .join(' ')}
          ref={(el) => {
            containerRef.current = el
            setDropRef(el)
          }}
          onPointerDown={onCanvasPointerDown}
          onPointerMove={onCanvasPointerMove}
          onPointerUp={endPan}
          onPointerCancel={endPan}
        >
          <CanvasTopBar
            onBack={exitCanvas}
            zoom={zoom}
            zoomBy={zoomBy}
            fitZoom={fitZoom}
            usage={usage}
            codexUsage={codexUsage}
            fallbackActive={fallbackActive}
            usageOpen={usageOpen}
            setUsageOpen={setUsageOpen}
            usageTab={usageTab}
            onUsageTab={setUsageTab}
            usageAnchorRef={usageAnchorRef}
            onForceFallback={() => {
              activateFallback(usage, true)
              setUsageOpen(false)
            }}
            hasCost={hasCost}
            sessionTokens={sessionTokens}
            sessionCostUsd={sessionCostUsd}
            routingSavings={routingSavings}
            budgetUsd={budgetUsd}
            onBudget={setBudget}
            running={running}
            done={done}
            lastEventAt={lastEventAt}
            hooksEndpoint={hooksEndpoint}
            onOpenCodexWorker={() => spawnCodexWorker(t('ws.workerManual'), { open: true })}
            onClear={clearCanvas}
            clearDisabled={nodes.length === 0 && taskList.length === 0}
          />

          <AgentLibraryPalette
            open={paletteOpen}
            setOpen={setPaletteOpen}
            position={palettePosition}
            onDragStart={startPaletteDrag}
            installed={installed}
            onInstall={installAgent}
          />

          {fallbackActive && usage ? (
            <div className={styles.fallbackBanner}>
              <span className={styles.fallbackDot} />
              <span className={styles.fallbackText}>
                {t('ws.fallbackBanner', {
                  pct: Math.round(usage.five_hour.utilization),
                  reset: formatReset(usage.five_hour.resets_at, t('ws.now')),
                })}
              </span>
              <button
                type="button"
                className={styles.bannerButton}
                onClick={() => spawnCodexWorker(t('ws.workerFallbackManual'), { open: true })}
              >
                <Plus size={12} /> codex
              </button>
            </div>
          ) : null}

          {budgetWarn && budgetUsd != null ? (
            <div
              className={
                budgetCrit
                  ? `${styles.fallbackBanner} ${styles.budgetBannerCrit}`
                  : styles.fallbackBanner
              }
            >
              <span className={styles.fallbackDot} />
              <span className={styles.fallbackText}>
                {t('ws.budgetBanner', {
                  spent: fmtUsd(sessionCostUsd),
                  cap: fmtUsd(budgetUsd),
                  pct: Math.round(budgetRatio * 100),
                })}
              </span>
            </div>
          ) : null}

          <div
            className={styles.stage}
            ref={stageRef}
            style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
          >
            <svg className={styles.edges}>
              {edges.map((e) => (
                <path
                  key={e.id}
                  d={`M ${e.x1} ${e.y1} C ${e.x1} ${e.y1 + 48}, ${e.x2} ${e.y2 - 48}, ${e.x2} ${e.y2}`}
                  className={e.done ? styles.edgeDone : styles.edgeRunning}
                />
              ))}
            </svg>

            <div
              className={planeDragOver ? `${styles.plane} ${styles.planeDropTarget}` : styles.plane}
              ref={(el) => {
                planeRef.current = el
                setPlaneDropRef(el)
              }}
            >
              <Bot size={18} />
              <div>
                <div className={styles.planeTitle}>
                  {teamName ? t('ws.leadTeam', { team: teamName }) : t('ws.controlPlane')}
                </div>
                <div className={styles.planeSubtitle}>
                  {session ? session.folder : t('ws.claudeMainSession')}
                </div>
                {leadCost ? (
                  <div className={styles.cardCost}>
                    {shortModel(leadCost.model) ? (
                      <span className={styles.cardCostModel}>{shortModel(leadCost.model)}</span>
                    ) : null}
                    <span className={styles.cardCostTokens}>
                      {fmtTokens(leadCost.total_tokens)} {t('ws.tokens')}
                    </span>
                    {leadCost.cost_usd != null ? (
                      <span
                        className={`${styles.cardCostUsd} ${costClassFor(leadCost.cost_usd, styles)}`}
                      >
                        {fmtUsd(leadCost.cost_usd)}
                      </span>
                    ) : null}
                  </div>
                ) : null}
              </div>
              <span className={running > 0 ? styles.planeDotActive : styles.planeDot} />
            </div>

            {/* agents instalados no projeto (idle até o claude delegar) */}
            {installed.length > 0 ? (
              <div className={styles.installedRow}>
                {installed.map((agent) => (
                  <AgentChip
                    key={agent.name}
                    name={agent.name}
                    installed
                    foreign={!agent.from_alethe}
                    action={
                      <button
                        type="button"
                        className={styles.chipAction}
                        title={t('ws.removeFromProject')}
                        onClick={() => uninstallAgent(agent)}
                        aria-label={t('ws.removeAgent', { name: agent.name })}
                      >
                        <X size={13} />
                      </button>
                    }
                  />
                ))}
              </div>
            ) : null}

            {/* codex workers — terminais codex reais, clicar expande */}
            {codexWorkers.length > 0 ? (
              <div className={styles.codexRow}>
                {codexWorkers.map((w) => (
                  <CodexWorkerCard
                    key={w.ptyId}
                    worker={w}
                    onOpen={setExpandedCodexId}
                    cardRefs={cardRefs}
                  />
                ))}
              </div>
            ) : null}

            {teammates.length > 0 ? (
              <div className={styles.teammatesArea}>
                {teammates.map((node) => (
                  <AgentNodeCard
                    key={node.id}
                    node={node}
                    cost={nodeCosts[node.id]}
                    onSelect={select}
                    cardRefs={cardRefs}
                  />
                ))}
              </div>
            ) : null}

            <div className={styles.cardsArea}>
              {nodes.length === 0 ? (
                <div className={styles.empty}>
                  <div>{t('ws.noSubagentYet')}</div>
                  <div className={styles.testPrompt}>
                    <code>{TEST_PROMPT}</code>
                    <button type="button" className={styles.clearButton} onClick={copyTestPrompt}>
                      <ClipboardCopy size={13} />
                      {copied ? t('ws.copied') : t('ws.copy')}
                    </button>
                  </div>
                </div>
              ) : (
                subagentGroups.map(([type, cards]) => {
                  const Icon = personaIconFor(type)
                  return (
                    <div
                      key={type}
                      className={styles.agentGroup}
                      style={{ ['--agent-color' as string]: colorFor(type) }}
                    >
                      <div
                        className={styles.agentGroupHeader}
                        ref={(el) => {
                          if (el) cardRefs.current.set(`group:${type}`, el)
                          else cardRefs.current.delete(`group:${type}`)
                        }}
                      >
                        <Icon size={13} />
                        <span className={styles.agentGroupName}>{type}</span>
                        <span className={styles.agentGroupCount}>{cards.length}</span>
                      </div>
                      <div className={styles.agentGroupCards}>
                        {cards.map((node) => (
                          <AgentNodeCard
                            key={node.id}
                            node={node}
                            cost={nodeCosts[node.id]}
                            onSelect={select}
                            cardRefs={cardRefs}
                          />
                        ))}
                      </div>
                    </div>
                  )
                })
              )}
            </div>

            {/* camada de tasks do time como DAG — cada task liga ao teammate dono */}
            {taskList.length > 0 ? (
              <TasksLayer tasks={taskList} teamName={teamName} taskRefs={taskRefs} />
            ) : null}
          </div>
        </div>
      </div>

      {session ? (
        <SessionTerminalDock
          session={session}
          restartHint={restartHint}
          claudeExited={claudeExited}
          economyOn={economyOn}
          onToggleEconomy={toggleEconomy}
          onRestart={restartClaude}
          hooksSettingsPath={hooksSettingsPath}
          hooksEndpoint={hooksEndpoint}
          hooksError={hooksError}
          onRetryHooks={() => setHooksRetryNonce((n) => n + 1)}
          coreAgentsReady={coreAgentsReady}
          terminalTheme={terminalTheme}
          budgetUsd={budgetUsd}
          onClaudeExit={setClaudeExited}
        />
      ) : null}

      {expandedWorker ? (
        <CodexTerminalOverlay
          worker={expandedWorker}
          uiTheme={uiTheme}
          terminalTheme={terminalTheme}
          onClose={() => setExpandedCodexId(null)}
          onKill={killCodexWorker}
          onExit={(ptyId, code) =>
            setCodexWorkers((prev) =>
              prev.map((x) => (x.ptyId === ptyId ? { ...x, exitedCode: code } : x)),
            )
          }
        />
      ) : null}

      <AgentModal />
    </div>
  )
}
