import { useEffect } from 'react'

import { isTauriEnv } from '../lib/api/transport'
import {
  getMemoryStats,
  getRuntimeSnapshot,
  listenPtySuspended,
  listenResourcePressure,
  setResourcePolicy,
  updatePtyRuntimeMeta,
  type PtyRuntimeMeta,
  type ResourcePolicyInput,
} from '../lib/tauri'
import { getLocale, translate } from '../lib/i18n'
import { computeVisibleFocusedPtyIds } from '../lib/ptyVisibility'
import { ensureSpawnQueueProgress, setSpawnPressureBlocked } from '../lib/spawnQueue'
import { useProjectsStore } from '../stores/projectsStore'
import { useTerminalsStore } from '../stores/terminalsStore'
import { useUiStore } from '../stores/uiStore'

const SAMPLE_INTERVAL_MS = 5_000

function currentPolicy(): ResourcePolicyInput {
  const policy = useProjectsStore.getState().preferences.resourcePolicy
  return {
    // Hydrated stores created before automaticParkingOptIn existed can remain
    // alive across HMR. Treat them as monitor-only immediately as well.
    mode:
      policy.automaticParkingOptIn === true && policy.mode === 'smart-lru' ? 'smart-lru' : 'manual',
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
          protected: visible || focused,
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

function notifyPressure(level: 'normal' | 'warning' | 'critical', totalMb: number): void {
  const locale = getLocale()
  const pushToast = useUiStore.getState().pushToast
  if (level === 'normal') {
    pushToast({
      title: translate(locale, 'resource.normal.title'),
      body: translate(locale, 'resource.normal.body'),
    })
    return
  }
  pushToast({
    title: translate(locale, `resource.${level}.title`),
    body: translate(locale, `resource.${level}.body`, { total: Math.round(totalMb) }),
  })
}

/**
 * Mantém uma única coleta de recursos para toda a UI. Em uma instância antiga
 * do backend (HMR sem restart), cai para a métrica legada e apenas bloqueia
 * crescimento acima do orçamento; o supervisor nativo entra no próximo boot.
 */
export function useResourceSupervisor(hydrated: boolean): void {
  useEffect(() => {
    if (!hydrated) return

    let cancelled = false
    let running = false
    let nativeAvailable: boolean | null = null
    let lastPolicy = ''
    let lastLevel: 'normal' | 'warning' | 'critical' | null = null
    let lastSuspendedId: string | null = null
    const unlisteners: Array<() => void> = []

    const onLevel = (level: 'normal' | 'warning' | 'critical', totalMb: number) => {
      if (level !== lastLevel) {
        if (lastLevel !== null || level !== 'normal') notifyPressure(level, totalMb)
        lastLevel = level
      }
    }

    const tick = async () => {
      // A pressão pode nunca chegar ao recovery target quando todos os PTYs são
      // visíveis/protegidos. Libera progresso controlado após espera excessiva.
      ensureSpawnQueueProgress()
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
          setSpawnPressureBlocked(
            snapshot.pressure.spawnBlocked,
            snapshot.pressure.spawnBlocked ? 'memory-pressure' : null,
          )
          onLevel(snapshot.pressure.level, snapshot.effectiveTotalMb)
          return
        }
      } catch {
        // O fallback abaixo (`getMemoryStats`) só existe pra cobrir uma
        // instância antiga do backend Tauri sobrevivendo a HMR sem restart
        // — um cenário específico do desktop via IPC legado. No navegador
        // não existe esse conceito: a única via real é sempre o HTTP core
        // compartilhado, e o stub de `getMemoryStats` ali é zerado. Travar
        // `nativeAvailable` em `false` permanentemente faria uma única falha
        // transitória de rede (ex. 503 enquanto o core sobe) degradar a UI
        // web pro resto da sessão — então só fixa o fallback legado quando o
        // ambiente é de fato o desktop; no web, tenta de novo no próximo tick.
        if (isTauriEnv()) nativeAvailable = false
      } finally {
        running = false
      }

      try {
        const stats = await getMemoryStats()
        if (cancelled) return
        // Mesmo no modo manual, não deixe criar novos PTYs quando o orçamento
        // crítico já foi atingido. Manual controla o estacionamento automático,
        // não a segurança contra uma nova explosão de memória.
        const blocked = stats.total_mb >= policy.memoryBudgetMb
        useUiStore.getState().setRuntimeSnapshot(null)
        useUiStore.getState().addMemorySample(stats)
        setSpawnPressureBlocked(blocked, blocked ? 'memory-pressure' : null)
        const level =
          stats.total_mb >= policy.memoryBudgetMb
            ? 'critical'
            : stats.total_mb >= policy.warningThresholdMb
              ? 'warning'
              : 'normal'
        onLevel(level, stats.total_mb)
      } catch {
        // Coleta best-effort: falhar aqui nunca deve afetar os terminais.
      }
    }

    void listenResourcePressure((payload) => {
      if (cancelled) return
      setSpawnPressureBlocked(payload.spawnBlocked, payload.spawnBlocked ? 'memory-pressure' : null)
      onLevel(payload.level, payload.totalMb)
      if (payload.suspendedId && payload.suspendedId !== lastSuspendedId) {
        lastSuspendedId = payload.suspendedId
      }
    }).then((unlisten) => {
      if (cancelled) unlisten()
      else unlisteners.push(unlisten)
    })

    void listenPtySuspended((payload) => {
      if (cancelled) return
      useTerminalsStore.getState().markSuspended(payload.id)
      if (payload.id === lastSuspendedId) return
      lastSuspendedId = payload.id
      const locale = getLocale()
      useUiStore.getState().pushToast({
        title: translate(locale, 'resource.suspended.title'),
        body: translate(locale, 'resource.suspended.body'),
      })
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
      setSpawnPressureBlocked(false)
    }
  }, [hydrated])
}
