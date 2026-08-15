import { useEffect } from 'react'

import { computeVisibleFocusedPtyIds } from '../lib/ptyVisibility'
import {
  getMemoryStats,
  getRuntimeSnapshot,
  listenPtySuspended,
  type PtyRuntimeMeta,
  type ResourcePolicyInput,
  setResourcePolicy,
  updatePtyRuntimeMeta,
} from '../lib/tauri'
import { useProjectsStore } from '../stores/projectsStore'
import { useTerminalsStore } from '../stores/terminalsStore'
import { useUiStore } from '../stores/uiStore'

const SAMPLE_INTERVAL_MS = 5_000

function currentPolicy(): ResourcePolicyInput {
  const policy = useProjectsStore.getState().preferences.resourcePolicy
  return {
    mode: 'manual',
    memoryBudgetMb: policy.memoryBudgetMb,
    warningThresholdMb: policy.warningThresholdMb,
    recoveryTargetMb: policy.recoveryTargetMb,
    hiddenAgentIdleMinutes: policy.hiddenAgentIdleMinutes,
    hiddenShellIdleMinutes: policy.hiddenShellIdleMinutes,
    spawnGraceSeconds: policy.spawnGraceSeconds,
  }
}

function collectRuntimeMetas(): PtyRuntimeMeta[] {
  const projectsState = useProjectsStore.getState()
  const terminalsState = useTerminalsStore.getState()
  const ui = useUiStore.getState()
  const now = Date.now()
  const { visible: visiblePtys, focused: focusedPtys } = computeVisibleFocusedPtyIds()
  // Mounted tabs are one Ctrl+Tab away. Suspending them turns a switch back into a restart.
  const mountedPaneIds = new Set(ui.mountedPaneIds)
  const known = new Set<string>()
  const metas: PtyRuntimeMeta[] = []

  for (const project of projectsState.projects) {
    for (const terminal of project.terminals) {
      for (const tab of terminal.tabs) {
        if (!tab.ptyId) continue
        known.add(tab.ptyId)
        const runtime = terminalsState.byPtyId[tab.ptyId]
        const lastUsedAt = tab.lastUsedAt ?? terminal.lastUsedAt ?? project.createdAt
        const visible = visiblePtys.has(tab.ptyId)
        const focused = focusedPtys.has(tab.ptyId)
        metas.push({
          id: tab.ptyId,
          kind: tab.type,
          status: runtime?.status ?? 'waiting',
          visible,
          focused,
          protected: visible || focused || mountedPaneIds.has(terminal.id),
          lastIoAtMs: runtime?.lastIoAt ?? lastUsedAt,
          spawnedAtMs: runtime?.spawnedAt ?? now,
          lastUsedAtMs: lastUsedAt,
          reportedAtMs: now,
        })
      }
    }
  }

  const canvasId = ui.agentCanvasSession?.ptyId
  if (canvasId && !known.has(canvasId)) {
    const runtime = terminalsState.byPtyId[canvasId]
    const visible = ui.activeView === 'agentCanvas'
    metas.push({
      id: canvasId,
      kind: 'claude',
      status: runtime?.status ?? 'waiting',
      visible,
      focused: visible,
      protected: visible,
      lastIoAtMs: runtime?.lastIoAt ?? now,
      spawnedAtMs: runtime?.spawnedAt ?? now,
      lastUsedAtMs: runtime?.lastIoAt ?? now,
      reportedAtMs: now,
    })
    known.add(canvasId)
  }

  for (const runtime of Object.values(terminalsState.byPtyId)) {
    if (known.has(runtime.ptyId)) continue
    metas.push({
      id: runtime.ptyId,
      kind: 'agent',
      status: runtime.status,
      visible: false,
      focused: false,
      protected: false,
      lastIoAtMs: runtime.lastIoAt,
      spawnedAtMs: runtime.spawnedAt,
      lastUsedAtMs: runtime.lastIoAt,
      reportedAtMs: now,
    })
  }

  return metas
}

/** Keeps one resource sampler for the UI without suspending or blocking runtimes. */
export function useResourceSupervisor(hydrated: boolean): void {
  useEffect(() => {
    if (!hydrated) return

    let cancelled = false
    let running = false
    let nativeAvailable: boolean | null = null
    let lastPolicy = ''
    const unlisteners: Array<() => void> = []

    const onSuspended = (id: string) => {
      useTerminalsStore.getState().markSuspended(id)
    }

    const tick = async () => {
      if (running || cancelled) return
      running = true
      const policy = currentPolicy()
      try {
        const policyKey = JSON.stringify(policy)
        if (nativeAvailable !== false && policyKey !== lastPolicy) {
          await setResourcePolicy(policy)
          lastPolicy = policyKey
          nativeAvailable = true
        }

        if (nativeAvailable !== false) {
          await updatePtyRuntimeMeta(collectRuntimeMetas())
          const snapshot = await getRuntimeSnapshot()
          if (cancelled) return
          nativeAvailable = true
          useUiStore.getState().setRuntimeSnapshot(snapshot)
          useUiStore.getState().addMemorySample(snapshot.memory)
          useUiStore.getState().setRamMb(snapshot.effectiveTotalMb)
          return
        }
      } catch {
        nativeAvailable = false
      } finally {
        running = false
      }

      try {
        const stats = await getMemoryStats()
        if (cancelled) return
        useUiStore.getState().setRuntimeSnapshot(null)
        useUiStore.getState().addMemorySample(stats)
        useUiStore.getState().setRamMb(stats.total_mb)
      } catch {
                                                                          
      }
    }

    void listenPtySuspended((payload) => {
      if (cancelled) return
      onSuspended(payload.id)
    }).then((unlisten) => {
      if (cancelled) unlisten()
      else unlisteners.push(unlisten)
    })

    void tick()
    const interval = window.setInterval(() => void tick(), SAMPLE_INTERVAL_MS)
    return () => {
      cancelled = true
      window.clearInterval(interval)
      for (const unlisten of unlisteners) unlisten()
    }
  }, [hydrated])
}
