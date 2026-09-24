import {
  Focus,
  Maximize2,
  MessageCircle,
  Play,
  Plus,
  RotateCcw,
  Send,
  Square,
  Terminal,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { useT } from '../../lib/i18n'
import { useProjectsStore } from '../../stores/projectsStore'
import { useAgentSandboxStore } from '../../stores/agentSandboxStore'
import { useUiStore } from '../../stores/uiStore'
import { XTermView } from '../XTermView'
import styles from './AgentSandbox.module.css'
import { Dropdown } from '../ui/Dropdown'

export function AgentSandbox() {
  const t = useT()
  const statusLabel = (status: 'starting' | 'idle' | 'working' | 'done' | 'error') => {
    switch (status) {
      case 'starting':
        return t('sandbox.statusStarting')
      case 'idle':
        return t('sandbox.statusIdle')
      case 'working':
        return t('sandbox.statusWorking')
      case 'done':
        return t('sandbox.statusDone')
      case 'error':
        return t('sandbox.statusError')
    }
  }
  const activeProjectId = useProjectsStore((state) => state.activeProjectId)
  const projects = useProjectsStore((state) => state.projects)
  const setActiveProject = useProjectsStore((state) => state.setActiveProject)
  const terminalTheme = useProjectsStore(
    (state) => state.preferences.terminalTheme ?? state.preferences.uiTheme,
  )
  const setActiveView = useUiStore((state) => state.setActiveView)
  const project =
    projects.find((item) => item.id === activeProjectId && item.mode === 'agentSandbox') ??
    projects.find((item) => item.mode === 'agentSandbox' && !item.archived)
  const active = useAgentSandboxStore((state) => state.active)
  const nodes = useAgentSandboxStore((state) => state.nodes)
  const messages = useAgentSandboxStore((state) => state.messages)
  const groups = useAgentSandboxStore((state) => state.groups)
  const runningDemo = useAgentSandboxStore((state) => state.runningDemo)
  const sandboxCwd = useAgentSandboxStore((state) => state.cwd)
  const startDemo = useAgentSandboxStore((state) => state.startDemo)
  const stop = useAgentSandboxStore((state) => state.stop)
  const moveNode = useAgentSandboxStore((state) => state.moveNode)
  const resizeNode = useAgentSandboxStore((state) => state.resizeNode)
  const clearInitialInput = useAgentSandboxStore((state) => state.clearInitialInput)
  const sendMessage = useAgentSandboxStore((state) => state.sendMessage)
  const syncProjectTerminals = useAgentSandboxStore((state) => state.syncProjectTerminals)
  const groupNodes = useAgentSandboxStore((state) => state.groupNodes)
  const ungroupNodes = useAgentSandboxStore((state) => state.ungroupNodes)
  const [drag, setDrag] = useState<{ id: string; dx: number; dy: number } | null>(null)
  const [resize, setResize] = useState<{
    id: string
    width: number
    height: number
    x: number
    y: number
  } | null>(null)
  const [from, setFrom] = useState('lead')
  const [to, setTo] = useState('')
  const [text, setText] = useState('')
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>(['lead'])
  const [focused, setFocused] = useState(false)
  const previousLayoutRef = useRef<Map<
    string,
    { x: number; y: number; width: number; height: number }
  > | null>(null)
  const canvasRef = useRef<HTMLDivElement>(null)
  const startedProjectRef = useRef<string | null>(null)

  useEffect(() => {
    if (project && project.id !== activeProjectId) setActiveProject(project.id)
  }, [activeProjectId, project, setActiveProject])

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      if (!drag || !canvasRef.current) return
      const rect = canvasRef.current.getBoundingClientRect()
      moveNode(
        drag.id,
        Math.max(16, event.clientX - rect.left - drag.dx),
        Math.max(72, event.clientY - rect.top - drag.dy),
      )
    }
    const onResize = (event: PointerEvent) => {
      if (!resize) return
      resizeNode(
        resize.id,
        resize.width + event.clientX - resize.x,
        resize.height + event.clientY - resize.y,
      )
    }
    const onUp = () => {
      setDrag(null)
      setResize(null)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointermove', onResize)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointermove', onResize)
      window.removeEventListener('pointerup', onUp)
    }
  }, [drag, moveNode, resize, resizeNode])

  useEffect(() => {
    if (!project?.id || !project.defaultCwd || startedProjectRef.current === project.id) return
    const sameSession =
      active &&
      sandboxCwd &&
      sandboxCwd.replace(/[\\/]+$/, '').toLowerCase() ===
        project.defaultCwd.replace(/[\\/]+$/, '').toLowerCase()
    if (sameSession) {
      startedProjectRef.current = project.id
      return
    }
    startedProjectRef.current = project.id
    void startDemo(project.defaultCwd).catch(() => {
      startedProjectRef.current = null
    })
  }, [active, project?.defaultCwd, project?.id, sandboxCwd, startDemo])

  useEffect(() => {
    syncProjectTerminals(
      (project?.terminals ?? [])
        .filter((terminal) => !terminal.kind || terminal.kind === 'terminal')
        .map((terminal) => {
          const tab =
            terminal.tabs.find((item) => item.id === terminal.activeTabId) ?? terminal.tabs[0]
          const command = tab?.type
          const sandboxCommand =
            command === 'claude'
              ? 'claude'
              : command === 'codex'
                ? 'codex'
                : command === 'opencode'
                  ? 'opencode'
                  : 'shell'
          return {
            id: terminal.id,
            label: terminal.name,
            command: sandboxCommand,
            ptyId: tab?.ptyId ?? null,
            cwd: tab?.cwd ?? terminal.cwd,
          }
        }),
    )
  }, [active, project, syncProjectTerminals])

  useEffect(() => {
    if (!nodes.some((node) => node.id === from)) setFrom(nodes[0]?.id ?? '')
    if (!nodes.some((node) => node.id === to) || to === from) {
      setTo(nodes.find((node) => node.id !== from)?.id ?? '')
    }
  }, [from, nodes, to])

  const nodeMap = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes])
  const groupBoxes = groups.map((group) => {
    const groupNodes = group.nodeIds
      .map((id) => nodeMap.get(id))
      .filter((node) => node !== undefined)
    if (groupNodes.length < 2) return null
    const left = Math.min(...groupNodes.map((node) => node!.x)) - 14
    const top = Math.min(...groupNodes.map((node) => node!.y)) - 28
    const right = Math.max(...groupNodes.map((node) => node!.x + node!.width)) + 14
    const bottom = Math.max(...groupNodes.map((node) => node!.y + node!.height)) + 14
    return (
      <div
        key={group.id}
        className={styles.groupBox}
        style={{ left, top, width: right - left, height: bottom - top }}
      >
        <span>{group.label}</span>
        <button type="button" onClick={() => ungroupNodes(group.id)}>
          ×
        </button>
      </div>
    )
  })
  const edges = messages.map((message) => {
    const source = nodeMap.get(message.from)
    const target = nodeMap.get(message.to)
    if (!source || !target) return null
    return (
      <line
        key={message.id}
        className={`${styles.edge} ${message.state === 'sending' ? styles.edgeActive : ''}`}
        x1={source.x + source.width / 2}
        y1={source.y + source.height / 2}
        x2={target.x + target.width / 2}
        y2={target.y + target.height / 2}
      />
    )
  })
  const hierarchyEdges = nodes.map((node) => {
    if (!node.parentId) return null
    const parent = nodeMap.get(node.parentId)
    if (!parent) return null
    return (
      <line
        key={`hierarchy-${node.id}`}
        className={styles.hierarchyEdge}
        x1={parent.x + parent.width / 2}
        y1={parent.y + parent.height / 2}
        x2={node.x + node.width / 2}
        y2={node.y + node.height / 2}
      />
    )
  })

  const start = () => {
    if (project?.defaultCwd) void startDemo(project.defaultCwd)
  }

  const send = () => {
    if (!text.trim() || !to || from === to) return
    void sendMessage(from, to, text)
    setText('')
  }

  const toggleFocus = () => {
    if (!canvasRef.current || nodes.length === 0) return
    if (focused) {
      const previous = previousLayoutRef.current
      if (previous) {
        nodes.forEach((node) => {
          const layout = previous.get(node.id)
          if (!layout) return
          moveNode(node.id, layout.x, layout.y)
          resizeNode(node.id, layout.width, layout.height)
        })
      }
      previousLayoutRef.current = null
      setFocused(false)
      return
    }

    const rect = canvasRef.current.getBoundingClientRect()
    previousLayoutRef.current = new Map(
      nodes.map((node) => [
        node.id,
        { x: node.x, y: node.y, width: node.width, height: node.height },
      ]),
    )
    const padding = 28
    const gap = 14
    const columns = 2
    const rows = Math.ceil(nodes.length / columns)
    const width = Math.max(280, Math.floor((rect.width - padding * 2 - gap) / columns))
    const height = Math.max(
      180,
      Math.floor((rect.height - padding * 2 - gap * (rows - 1) - 32) / rows),
    )
    nodes.forEach((node, index) => {
      moveNode(
        node.id,
        padding + (index % columns) * (width + gap),
        padding + Math.floor(index / columns) * (height + gap),
      )
      resizeNode(node.id, width, height)
    })
    setFocused(true)
  }

  return (
    <section className={styles.shell} aria-label={t('sandbox.title')}>
      <header className={styles.header}>
        <div>
          <div className={styles.eyebrow}>{t('sandbox.eyebrow')}</div>
          <h1>{t('sandbox.title')}</h1>
          <p>{t('sandbox.subtitle')}</p>
        </div>
        <div className={styles.headerActions}>
          <button
            type="button"
            className={styles.secondaryButton}
            onClick={() => setActiveView('workspace')}
          >
            <X size={14} /> {t('sandbox.close')}
          </button>
          <button
            type="button"
            className={styles.secondaryButton}
            onClick={() => groupNodes(selectedNodeIds)}
            disabled={selectedNodeIds.length < 2}
          >
            <Plus size={14} /> {t('sandbox.groupSelected')}
          </button>
          <button
            type="button"
            className={styles.secondaryButton}
            onClick={toggleFocus}
            disabled={!active}
          >
            <Focus size={14} /> {focused ? t('sandbox.exitFocus') : t('sandbox.focus')}
          </button>
          <button
            type="button"
            className={styles.primaryButton}
            onClick={start}
            disabled={!project || runningDemo}
          >
            <Play size={14} /> {active ? t('sandbox.restart') : t('sandbox.start')}
          </button>
        </div>
      </header>

      <div ref={canvasRef} className={`${styles.canvas} ${focused ? styles.focusMode : ''}`}>
        <div className={styles.grid} aria-hidden="true" />
        {!active && nodes.length === 0 ? (
          <div className={styles.emptyState}>
            <div className={styles.emptyIcon}>
              <Plus size={18} />
            </div>
            <strong>{t('sandbox.emptyTitle')}</strong>
            <span>{project ? t('sandbox.emptyBody') : t('sandbox.noProject')}</span>
            <button
              type="button"
              className={styles.primaryButton}
              onClick={start}
              disabled={!project}
            >
              <Play size={14} /> {t('sandbox.startDemo')}
            </button>
          </div>
        ) : (
          <>
            <svg className={styles.edges} aria-hidden="true">
              {hierarchyEdges}
              {edges}
            </svg>
            {groupBoxes}
            {nodes.map((node) => (
              <article
                key={node.id}
                className={`${styles.node} ${node.id === 'lead' ? styles.leadNode : ''} ${selectedNodeIds.includes(node.id) ? styles.selectedNode : ''}`}
                style={{ left: node.x, top: node.y, width: node.width, height: node.height }}
                onPointerDown={(event) => {
                  if ((event.target as HTMLElement).closest(`.${styles.terminalSurface}`)) return
                  const rect = event.currentTarget.getBoundingClientRect()
                  setDrag({
                    id: node.id,
                    dx: event.clientX - rect.left,
                    dy: event.clientY - rect.top,
                  })
                }}
                onClick={(event) => {
                  setSelectedNodeIds((current) =>
                    event.shiftKey
                      ? current.includes(node.id)
                        ? current.filter((id) => id !== node.id)
                        : [...current, node.id]
                      : [node.id],
                  )
                  if (node.id !== from) setTo(node.id)
                }}
              >
                <div className={styles.nodeHeader}>
                  <Terminal size={13} className={styles.terminalIcon} />
                  <span className={styles.statusDot} style={{ background: node.color }} />
                  <strong>{node.label}</strong>
                  <span className={styles.nodeRole}>{node.role}</span>
                  <span className={`${styles.status} ${styles[`status_${node.status}`]}`}>
                    {statusLabel(node.status)}
                  </span>
                </div>
                <div className={styles.nodeMeta}>
                  <span>
                    {node.transport === 'app-server'
                      ? t('sandbox.protocol')
                      : t('sandbox.terminal')}
                  </span>
                  {node.jobId && (
                    <span>
                      {t('sandbox.job')} {node.jobId.slice(-8)}
                    </span>
                  )}
                  {node.threadId && (
                    <span>
                      {t('sandbox.thread')} {node.threadId.slice(0, 8)}
                    </span>
                  )}
                </div>
                <div className={styles.terminalSurface}>
                  {node.transport === 'app-server' ? (
                    <pre className={styles.protocolTerminal}>
                      {node.output || t('sandbox.starting')}
                    </pre>
                  ) : node.ptyId && project?.defaultCwd ? (
                    <XTermView
                      ptyId={node.ptyId}
                      cwd={node.cwd ?? project.defaultCwd}
                      command={node.command === 'shell' ? null : node.command}
                      extraArgs={node.extraArgs}
                      initialInput={node.initialInput}
                      onInitialInputSent={() => clearInitialInput(node.id)}
                      terminalTheme={terminalTheme}
                    />
                  ) : (
                    <span>{node.ptyId ? t('sandbox.starting') : t('sandbox.starting')}</span>
                  )}
                </div>
                <button
                  type="button"
                  className={styles.resizeHandle}
                  aria-label={t('sandbox.resizeTerminal')}
                  title={t('sandbox.resizeTerminal')}
                  onPointerDown={(event) => {
                    event.stopPropagation()
                    setResize({
                      id: node.id,
                      width: node.width,
                      height: node.height,
                      x: event.clientX,
                      y: event.clientY,
                    })
                  }}
                >
                  <Maximize2 size={11} />
                </button>
              </article>
            ))}
          </>
        )}
        <div className={styles.zoomBadge}>
          {nodes.length} {t('sandbox.agents')}
        </div>
      </div>

      <footer className={styles.composer}>
        <MessageCircle size={15} />
        <Dropdown
          value={from}
          onChange={setFrom}
          disabled={!active}
          ariaLabel="Message source agent"
          options={nodes.map((node) => ({ value: node.id, label: node.label }))}
        />
        <span className={styles.arrow}>→</span>
        <Dropdown
          value={to}
          onChange={setTo}
          disabled={!active}
          ariaLabel="Message target agent"
          options={nodes.map((node) => ({ value: node.id, label: node.label }))}
        />
        <input
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') send()
          }}
          placeholder={t('sandbox.messagePlaceholder')}
          disabled={!active || !to || from === to}
        />
        <button
          type="button"
          className={styles.iconButton}
          onClick={send}
          disabled={!active || !to || from === to || !text.trim()}
          title={t('sandbox.send')}
        >
          <Send size={14} />
        </button>
        <button
          type="button"
          className={styles.iconButton}
          onClick={() => void startDemo(project?.defaultCwd ?? '')}
          disabled={!project}
          title={t('sandbox.reset')}
        >
          <RotateCcw size={14} />
        </button>
        <button
          type="button"
          className={`${styles.iconButton} ${styles.dangerButton}`}
          onClick={stop}
          disabled={!active}
          title={t('sandbox.stop')}
        >
          <Square size={13} />
        </button>
      </footer>
    </section>
  )
}
