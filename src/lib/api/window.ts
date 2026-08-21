import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

import { canUseSharedCoreTransport, isTauriEnv, webApiFetch } from './transport'

export type MemoryPressureLevel = 'Ok' | 'Low' | 'Medium' | 'High' | 'Critical'

export type ResourceMetrics = {
  memory_pressure: MemoryPressureLevel
  system_available_mb: number
  system_total_mb: number
  app_mb: number
  webview_mb: number
  ptys_mb: number
  process_count: number
  policy_trigger_count: number
}

export type MemoryStats = {
  total_mb: number
  app_mb: number
  webview_mb: number
  ptys_mb: number
  process_count: number
  system_total_mb: number
  system_available_mb: number
}

export type ResourcePolicyInput = {
  mode: 'smart-lru' | 'manual'
  memoryBudgetMb: number
  warningThresholdMb: number
  recoveryTargetMb: number
  hiddenAgentIdleMinutes: number
  hiddenShellIdleMinutes: number
  spawnGraceSeconds: number
}

export type PtyRuntimeMeta = {
  id: string
  kind: string
  status: string
  visible: boolean
  focused: boolean
  protected: boolean
  lastIoAtMs: number
  spawnedAtMs: number
  lastUsedAtMs: number
  reportedAtMs: number
}

export type RuntimeProcess = {
  pid: number
  parentPid: number | null
  name: string
  workingSetMb: number
  privateCommitMb: number
  cpuPercent: number
}

export type PtyResourceStats = {
  id: string
  rootPid: number | null
  command: string | null
  cwd: string | null
  processCount: number
  workingSetMb: number
  privateCommitMb: number
  effectiveMemoryMb: number
  processes: RuntimeProcess[]
}

export type ResourcePressureState = {
  level: 'normal' | 'warning' | 'critical'
  spawnBlocked: boolean
  automatic: boolean
  candidateCount: number
  lastSuspendedId: string | null
}

export type RuntimeSnapshot = {
  sampledAtMs: number
  memory: MemoryStats
  privateCommitMb: number
  effectiveTotalMb: number
  ptys: PtyResourceStats[]
  pressure: ResourcePressureState
}

export type ResourcePressurePayload = {
  level: ResourcePressureState['level']
  totalMb: number
  budgetMb: number
  spawnBlocked: boolean
  candidateCount: number
  suspendedId: string | null
}

export type PtySuspendedPayload = {
  id: string
  reason: 'memory-pressure' | string
}

export type CrashSession = {
  started_at_ms: number
  clean_exit: boolean
  app_version: string
  last_heartbeat_ms: number
  total_mb: number
  ptys_mb: number
  webview_mb: number
  process_count: number
  job_guard_active: boolean
}

export type CrashReport = {
  session: CrashSession
  orphans_reaped: number
}

export async function setWindowOpacity(opacity: number): Promise<void> {
  if (isTauriEnv()) return invoke('set_window_opacity', { opacity })
}

export async function quitApp(): Promise<void> {
  if (isTauriEnv()) return invoke('quit_app')
  window.close()
}

export async function resetAppData(): Promise<void> {
  if (isTauriEnv()) return invoke('reset_app_data')
  throw new Error('desktop_capability_required')
}

export async function wipeAllAppData(): Promise<void> {
  if (isTauriEnv()) return invoke('wipe_all_app_data')
  throw new Error('desktop_capability_required')
}

export async function getResourceMetrics(): Promise<ResourceMetrics> {
  if (isTauriEnv() && !(await canUseSharedCoreTransport())) {
    return invoke<ResourceMetrics>('get_resource_metrics')
  }
  return webApiFetch<ResourceMetrics>('/api/window/resource_metrics')
}

export async function getMemoryStats(): Promise<MemoryStats> {
  if (isTauriEnv()) return invoke<MemoryStats>('get_memory_stats')
  // Sem comando IPC equivalente no web — `runtime_snapshot` já traz o mesmo
  // `MemoryStats` calculado no servidor (ver `getRuntimeSnapshot` abaixo).
  // Rede de segurança: se algum chamador cair neste fallback, o número
  // continua real em vez de um stub zerado (que derrubava a pill de RAM pra
  // "crítico"/vermelho — ver `MemoryPillButton`).
  const snapshot = await getRuntimeSnapshot()
  return snapshot.memory
}

export async function getRuntimeSnapshot(): Promise<RuntimeSnapshot> {
  if (isTauriEnv() && !(await canUseSharedCoreTransport())) {
    return invoke<RuntimeSnapshot>('get_runtime_snapshot')
  }
  return webApiFetch<RuntimeSnapshot>('/api/window/runtime_snapshot')
}

export async function setResourcePolicy(policy: ResourcePolicyInput): Promise<void> {
  if (isTauriEnv()) return invoke('set_resource_policy', { policy })
}

export async function updatePtyRuntimeMeta(metas: PtyRuntimeMeta[]): Promise<void> {
  if (isTauriEnv()) return invoke('update_pty_runtime_meta', { metas })
}

export async function suspendPty(id: string): Promise<boolean> {
  if (isTauriEnv() && !(await canUseSharedCoreTransport())) {
    return invoke<boolean>('suspend_pty', { id })
  }
  return webApiFetch<boolean>('/api/window/suspend_pty', {
    method: 'POST',
    body: JSON.stringify({ id }),
  })
}

export function listenResourcePressure(
  handler: (payload: ResourcePressurePayload) => void,
): Promise<UnlistenFn> {
  if (isTauriEnv())
    return listen<ResourcePressurePayload>('resource://pressure', (event) => handler(event.payload))
  return Promise.resolve(() => {})
}

export function listenPtySuspended(
  handler: (payload: PtySuspendedPayload) => void,
): Promise<UnlistenFn> {
  if (isTauriEnv())
    return listen<PtySuspendedPayload>('resource://pty-suspended', (event) =>
      handler(event.payload),
    )
  return Promise.resolve(() => {})
}

export async function getLastCrashReport(): Promise<CrashReport | null> {
  if (isTauriEnv()) return invoke<CrashReport | null>('get_last_crash_report')
  return null
}

export async function getJobGuardStatus(): Promise<boolean> {
  if (isTauriEnv()) return invoke<boolean>('get_job_guard_status')
  return webApiFetch<boolean>('/api/window/job_guard_status')
}
