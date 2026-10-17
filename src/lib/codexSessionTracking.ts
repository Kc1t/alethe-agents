import { useProjectsStore } from '../stores/projectsStore'
import { useTerminalsStore } from '../stores/terminalsStore'
import { shortSessionId } from './claudeSessionTracking'
import { normalizeCwd } from './platform'
import { isSessionClaimed, registerSessionClaim, releaseSessionClaim } from './sessionDiscovery'
import { saveSession } from './sessionResume'
import { recordAppEvent } from './tauri/misc'

export type CodexRollout = {
  id: string
  cwd: string
  source?: string | null
  started_at?: string | null
}

export type CodexPane = {
  projectId: string
  terminalId: string
  tabId: string
  ptyId: string
  cwd: string
  sessionId?: string
  alive: boolean
  spawnedAt: number
  lastSubmitAt?: number
  expectsNew: boolean
}

const SUBMIT_WINDOW_MS = 15_000
const SPAWN_SLACK_MS = 2_000
const NEW_CONVERSATION_COMMANDS = new Set(['/new', '/clear'])

const paneInput = new Map<string, { lastSubmitAt: number; expectsNew: boolean }>()
const adoptionListeners = new Set<(ptyId: string, sessionId: string) => void>()

export function noteCodexPaneInput(ptyId: string, line?: string): void {
  const previous = paneInput.get(ptyId)
  paneInput.set(ptyId, {
    lastSubmitAt: Date.now(),
    expectsNew: previous?.expectsNew === true || NEW_CONVERSATION_COMMANDS.has(line ?? ''),
  })
}

export function forgetCodexPaneInput(ptyId: string): void {
  paneInput.delete(ptyId)
}

export function onCodexSessionAdopted(
  listener: (ptyId: string, sessionId: string) => void,
): () => void {
  adoptionListeners.add(listener)
  return () => {
    adoptionListeners.delete(listener)
  }
}

function latestSubmit(panes: readonly CodexPane[]): CodexPane | undefined {
  return [...panes].sort((a, b) => (b.lastSubmitAt ?? 0) - (a.lastSubmitAt ?? 0))[0]
}

export function pickCodexPaneForRollout(
  panes: readonly CodexPane[],
  rollout: CodexRollout,
  now: number,
): CodexPane | undefined {
  if (rollout.source !== 'cli') return undefined
  if (panes.some((pane) => pane.sessionId === rollout.id)) return undefined

  const cwd = normalizeCwd(rollout.cwd)
  const startedAt = rollout.started_at ? Date.parse(rollout.started_at) : Number.NaN
  const eligible = panes.filter(
    (pane) =>
      pane.alive &&
      normalizeCwd(pane.cwd) === cwd &&
      (Number.isNaN(startedAt) || startedAt >= pane.spawnedAt - SPAWN_SLACK_MS),
  )
  const expecting = eligible.filter((pane) => !pane.sessionId || pane.expectsNew)
  const submittedRecently = (pane: CodexPane) =>
    pane.lastSubmitAt !== undefined && now - pane.lastSubmitAt <= SUBMIT_WINDOW_MS

  return (
    latestSubmit(expecting.filter(submittedRecently)) ??
    latestSubmit(eligible.filter(submittedRecently)) ??
    (expecting.length === 1 ? expecting[0] : undefined)
  )
}

function codexPanes(): CodexPane[] {
  const runtimes = useTerminalsStore.getState().byPtyId
  const panes: CodexPane[] = []
  for (const project of useProjectsStore.getState().projects) {
    for (const terminal of project.terminals) {
      if (terminal.gsdSyncViewer) continue
      for (const tab of terminal.tabs) {
        if (tab.type !== 'codex') continue
        const ptyId = tab.ptyId ?? tab.id
        const runtime = runtimes[ptyId]
        const input = paneInput.get(ptyId)
        panes.push({
          projectId: project.id,
          terminalId: terminal.id,
          tabId: tab.id,
          ptyId,
          cwd: tab.cwd || terminal.cwd || '',
          sessionId: tab.sessionId,
          alive: runtime?.alive === true,
          spawnedAt: runtime?.spawnedAt ?? 0,
          lastSubmitAt: input?.lastSubmitAt,
          expectsNew: input?.expectsNew === true,
        })
      }
    }
  }
  return panes
}

export function trackCodexRollout(rollout: CodexRollout): void {
  if (!rollout.id || !rollout.cwd) return
  if (isSessionClaimed('codex', rollout.cwd, rollout.id)) return
  const panes = codexPanes()
  const pane = pickCodexPaneForRollout(panes, rollout, Date.now())
  if (!pane) {
    const cwd = normalizeCwd(rollout.cwd)
    const sameCwd = panes.filter((item) => item.alive && normalizeCwd(item.cwd) === cwd)
    if (rollout.source === 'cli' && sameCwd.length > 1) {
      const expecting = sameCwd.filter((item) => !item.sessionId || item.expectsNew).length
      void recordAppEvent(
        'session.ambiguous',
        `agent=codex panes=${sameCwd.length} expecting=${expecting}`,
      )
    }
    return
  }

  releaseSessionClaim(pane.tabId)
  releaseSessionClaim(pane.ptyId)
  registerSessionClaim('codex', pane.cwd, rollout.id, pane.tabId)
  registerSessionClaim('codex', pane.cwd, rollout.id, pane.ptyId)
  saveSession(pane.tabId, {
    sessionId: pane.ptyId,
    codexSessionId: rollout.id,
    agent: 'codex',
    cwd: pane.cwd,
    timestamp: Date.now(),
  })
  const input = paneInput.get(pane.ptyId)
  if (input) paneInput.set(pane.ptyId, { ...input, expectsNew: false })
  useProjectsStore
    .getState()
    .setSubTabSessionId(pane.projectId, pane.terminalId, pane.tabId, rollout.id)
  void recordAppEvent(
    'session.adopt',
    `agent=codex via=watcher from=${shortSessionId(pane.sessionId)} to=${shortSessionId(rollout.id)}`,
  )
  for (const listener of adoptionListeners) listener(pane.ptyId, rollout.id)
}

export function resetCodexSessionTrackingForTests(): void {
  paneInput.clear()
  adoptionListeners.clear()
}
