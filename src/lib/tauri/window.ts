import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

export async function setWindowOpacity(opacity: number): Promise<void> {
  await invoke('set_window_opacity', { opacity })
}

export async function quitApp(): Promise<void> {
  await invoke('quit_app')
}

export async function resetAppData(): Promise<void> {
  await invoke('reset_app_data')
}

export async function wipeAllAppData(): Promise<void> {
  await invoke('wipe_all_app_data')
}

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

export async function getResourceMetrics(): Promise<ResourceMetrics> {
  return invoke<ResourceMetrics>('get_resource_metrics')
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

export async function getMemoryStats(): Promise<MemoryStats> {
  return invoke<MemoryStats>('get_memory_stats')
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

export async function getRuntimeSnapshot(): Promise<RuntimeSnapshot> {
  return invoke<RuntimeSnapshot>('get_runtime_snapshot')
}

export async function setResourcePolicy(policy: ResourcePolicyInput): Promise<void> {
  await invoke('set_resource_policy', { policy })
}

export async function updatePtyRuntimeMeta(metas: PtyRuntimeMeta[]): Promise<void> {
  await invoke('update_pty_runtime_meta', { metas })
}

export async function suspendPty(id: string): Promise<boolean> {
  return invoke<boolean>('suspend_pty', { id })
}

export function listenResourcePressure(
  handler: (payload: ResourcePressurePayload) => void,
): Promise<UnlistenFn> {
  return listen<ResourcePressurePayload>('resource://pressure', (event) => handler(event.payload))
}

/**
 * Relief requests the resource manager raises as free memory falls.
 *
 * `drop-caches` was emitted as `resource::drop-caches` and matched no listener, so the most severe
 * level was the one that did nothing.
 */
export const MEMORY_RELIEF_EVENTS = {
  low: 'resource://hibernate-idle',
  medium: 'resource://webview-low-memory',
  high: 'resource://reduce-pool',
  critical: 'resource://drop-caches',
} as const

export type MemoryReliefLevel = keyof typeof MEMORY_RELIEF_EVENTS

export async function listenMemoryRelief(
  handler: (level: MemoryReliefLevel) => void,
): Promise<UnlistenFn> {
  const unlisteners = await Promise.all(
    (Object.keys(MEMORY_RELIEF_EVENTS) as MemoryReliefLevel[]).map((level) =>
      listen(MEMORY_RELIEF_EVENTS[level], () => handler(level)),
    ),
  )
  return () => {
    for (const unlisten of unlisteners) unlisten()
  }
}

export function listenPtySuspended(
  handler: (payload: PtySuspendedPayload) => void,
): Promise<UnlistenFn> {
  return listen<PtySuspendedPayload>('resource://pty-suspended', (event) => handler(event.payload))
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

export async function getLastCrashReport(): Promise<CrashReport | null> {
  return invoke<CrashReport | null>('get_last_crash_report')
}

export async function getJobGuardStatus(): Promise<boolean> {
  return invoke<boolean>('get_job_guard_status')
}
