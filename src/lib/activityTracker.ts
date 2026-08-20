import { AgentCompletionMonitor } from './agentCompletionMonitor'
import { normalizeCwd } from './platform'
import {
  listenOpenCodeBridgeStatus,
  listenPtyActivity,
  listenPtyData,
  recordActivitySamples,
  type ActivityAgentSample,
  type ActivitySample,
  type OpenCodeBridgeStatus,
} from './tauri'
import type { AgentType } from './types'
import { useProjectsStore } from '../stores/projectsStore'
import { useTerminalsStore } from '../stores/terminalsStore'
import { useUiStore } from '../stores/uiStore'

const SAMPLE_MS = 5_000
const FLUSH_MS = 30_000
const IDLE_MS = 5 * 60_000
const MAX_DELTA_MS = 15_000

type AgentMeta = {
  agent: Exclude<AgentType, 'shell'>
  projectId: string | null
  terminalId: string | null
  cwd: string
}

type TrackedAgent = AgentMeta & {
  monitor: AgentCompletionMonitor
  unlisten: (() => void) | null
  unlistenActivity: (() => void) | null
}

const tracked = new Map<string, TrackedAgent>()
let pending: ActivitySample[] = []
let flushChain: Promise<void> = Promise.resolve()
let started = false
let lastInteractionAt = Date.now()
let lastSampleAt = Date.now()

const bridgeActivePtyIds = new Set<string>()

function applyOpenCodeBridgeStatus({ directory, state }: OpenCodeBridgeStatus): void {
  const normalized = normalizeCwd(directory)
  const status = state === 'working' ? 'working' : 'waiting'
  for (const [ptyId, entry] of tracked) {
    if (entry.agent !== 'opencode') continue
    if (normalizeCwd(entry.cwd) !== normalized) continue
    bridgeActivePtyIds.add(ptyId)
    useTerminalsStore.getState().setStatus(ptyId, status)
  }
}

function localDate(timestamp = Date.now()): string {
  const date = new Date(timestamp)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function agentMetadata(): Map<string, AgentMeta> {
  const result = new Map<string, AgentMeta>()
  for (const project of useProjectsStore.getState().projects) {
    for (const terminal of project.terminals) {
      for (const tab of terminal.tabs) {
        if (!tab.ptyId || tab.type === 'shell') continue
        result.set(tab.ptyId, {
          agent: tab.type,
          projectId: project.id,
          terminalId: terminal.id,
          cwd: tab.cwd,
        })
      }
    }
  }
  const canvas = useUiStore.getState().agentCanvasSession
  if (canvas && !result.has(canvas.ptyId)) {
    result.set(canvas.ptyId, {
      agent: 'claude',
      projectId: '__agent_canvas__',
      terminalId: null,
      cwd: canvas.folder,
    })
  }
  return result
}

function syncTrackedAgents(): void {
  const metadata = agentMetadata()
  const runtimes = useTerminalsStore.getState().byPtyId
  for (const [ptyId, meta] of metadata) {
    if (!runtimes[ptyId]?.alive) continue
    const existing = tracked.get(ptyId)
    if (existing) {
      existing.projectId = meta.projectId
      existing.terminalId = meta.terminalId
      existing.cwd = meta.cwd
      continue
    }
    const monitor = new AgentCompletionMonitor({
      ptyId,
      agent: meta.agent,
      cwd: meta.cwd,
      notifyOnComplete: false,
      onStatusChange: (status) => {
        if (bridgeActivePtyIds.has(ptyId)) return
        useTerminalsStore.getState().setStatus(ptyId, status)
      },
    })
    const entry: TrackedAgent = { ...meta, monitor, unlisten: null, unlistenActivity: null }
    tracked.set(ptyId, entry)
    void listenPtyData(ptyId, (chunk) => monitor.handleOutput(chunk))
      .then((unlisten) => {
        if (tracked.get(ptyId) !== entry) unlisten()
        else entry.unlisten = unlisten
      })
      .catch(() => tracked.delete(ptyId))
    // O backend para de emitir `pty:

    void listenPtyActivity(ptyId, (chunk) => monitor.handleOutput(chunk))
      .then((unlisten) => {
        if (tracked.get(ptyId) !== entry) unlisten()
        else entry.unlistenActivity = unlisten
      })
      .catch(() => {})
  }
  for (const [ptyId, entry] of tracked) {
    if (!metadata.has(ptyId) || !runtimes[ptyId]?.alive) {
      entry.unlisten?.()
      entry.unlistenActivity?.()
      entry.monitor.dispose()
      tracked.delete(ptyId)
      bridgeActivePtyIds.delete(ptyId)
    }
  }
}

let syncDebounceTimer: number | null = null
function scheduleSyncTrackedAgents(): void {
  if (syncDebounceTimer !== null) return
  syncDebounceTimer = window.setTimeout(() => {
    syncDebounceTimer = null
    syncTrackedAgents()
  }, 300)
}

export function recordAgentActivityInput(ptyId: string, data: string): void {
  tracked.get(ptyId)?.monitor.handleInput(data)
}

function currentAgents(): ActivityAgentSample[] {
  const runtimes = useTerminalsStore.getState().byPtyId
  return [...tracked.entries()].flatMap(([ptyId, meta]) => {
    const runtime = runtimes[ptyId]
    if (!runtime?.alive) return []
    return [
      {
        agent: meta.agent,
        projectId: meta.projectId,
        terminalId: meta.terminalId,
        state: runtime.status === 'working' ? ('working' as const) : ('waiting' as const),
      },
    ]
  })
}

function sample(): void {
  syncTrackedAgents()
  const now = Date.now()
  const durationMs = Math.min(MAX_DELTA_MS, Math.max(0, now - lastSampleAt))
  lastSampleAt = now
  if (durationMs === 0) return
  const ui = useUiStore.getState()
  const projects = useProjectsStore.getState()
  pending.push({
    date: localDate(now),
    durationMs,
    appFocused: document.hasFocus() && document.visibilityState === 'visible',
    userActive: now - lastInteractionAt < IDLE_MS,
    activeProjectId:
      ui.activeView === 'workspace'
        ? projects.activeProjectId
        : ui.activeView === 'agentCanvas'
          ? '__agent_canvas__'
          : null,
    activeTerminalId:
      ui.activeView === 'workspace' ? (ui.activeTerminal?.terminalId ?? null) : null,
    agents: currentAgents(),
  })
}

async function flush(): Promise<void> {
  if (pending.length === 0) return flushChain
  const batch = pending
  pending = []
  flushChain = flushChain.then(async () => {
    try {
      await recordActivitySamples(batch)
    } catch (error) {
      pending = [...batch, ...pending].slice(-360)
      console.error('Failed to persist activity metrics', error)
    }
  })
  return flushChain
}

export async function flushActivityTracker(): Promise<void> {
  sample()
  await flush()
}

export function startActivityTracker(): () => void {
  if (started) return () => undefined
  started = true
  const markInteraction = () => {
    lastInteractionAt = Date.now()
  }
  const events: (keyof WindowEventMap)[] = [
    'keydown',
    'pointerdown',
    'pointermove',
    'wheel',
    'touchstart',
  ]
  events.forEach((event) =>
    window.addEventListener(event, markInteraction, { passive: true, capture: true }),
  )
  const sampleTimer = window.setInterval(sample, SAMPLE_MS)
  const flushTimer = window.setInterval(() => void flush(), FLUSH_MS)
  const unsubTerminals = useTerminalsStore.subscribe(scheduleSyncTrackedAgents)
  const unsubProjects = useProjectsStore.subscribe(scheduleSyncTrackedAgents)
  const unsubUi = useUiStore.subscribe(scheduleSyncTrackedAgents)
  syncTrackedAgents()

  let unlistenBridge: (() => void) | null = null
  let bridgeDisposed = false
  void listenOpenCodeBridgeStatus(applyOpenCodeBridgeStatus)
    .then((unlisten) => {
      if (bridgeDisposed) unlisten()
      else unlistenBridge = unlisten
    })
    .catch(() => {})

  const flushOnHide = () => {
    sample()
    void flush()
  }
  window.addEventListener('blur', flushOnHide)
  window.addEventListener('beforeunload', flushOnHide)
  document.addEventListener('visibilitychange', flushOnHide)

  return () => {
    sample()
    void flush()
    started = false
    if (syncDebounceTimer !== null) {
      window.clearTimeout(syncDebounceTimer)
      syncDebounceTimer = null
    }
    window.clearInterval(sampleTimer)
    window.clearInterval(flushTimer)
    events.forEach((event) => window.removeEventListener(event, markInteraction, true))
    window.removeEventListener('blur', flushOnHide)
    window.removeEventListener('beforeunload', flushOnHide)
    document.removeEventListener('visibilitychange', flushOnHide)
    unsubTerminals()
    unsubProjects()
    unsubUi()
    bridgeDisposed = true
    unlistenBridge?.()
    for (const entry of tracked.values()) {
      entry.unlisten?.()
      entry.unlistenActivity?.()
      entry.monitor.dispose()
    }
    tracked.clear()
    bridgeActivePtyIds.clear()
  }
}
