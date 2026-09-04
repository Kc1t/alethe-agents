import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

import type { InstallToolchain } from '../agentInstall'
import { withFallback } from '../resilience'
import type { WorktreeMode } from './git'
import type { ProfileMeta } from './profiles'
import { canUseSharedCoreTransport, isTauriEnv, webApiFetch } from './transport'

export type RemoteControlInfo = {
  enabled: boolean
  connected_devices: number
  online_devices: number
  max_devices: number
  session_expiry_secs: number
  read_only: boolean
  allow_shell_input: boolean
  pairing_open: boolean
  pairing_expires_in: number
  devices: Array<{
    id: number
    name: string
    address: string
    connected_at: number
    expires_at: number
    online: boolean
  }>
  pairing_url: string | null
  qr_svg: string | null
  http_url: string | null
  ws_url: string | null
}

export type GithubSyncStatus = {
  connected: boolean
  login: string | null
  gist_id: string | null
  gist_url: string | null
  last_push_ms: number | null
  last_pull_ms: number | null
}

export type EventBusPayload = {
  event_type: string
  timestamp_ms: number
  correlation_id: string
  task_id: string | null
  agent_id: string | null
  data: Record<string, any>
}

export type MetricData = { count: number; last_value: number; sum: number }
export type ValidationResult = {
  success: boolean
  stage: string
  output: string
  /** `false` quando não havia nenhum comando de validação configurado — nada foi executado. */
  ranAnyCommand: boolean
}

export type PlanningStatus = {
  hasPlanning: boolean
  reportedComplete: boolean
  progress: number | null
  roadmapPendingCount: number | null
  roadmapTotalCount: number | null
  notes: string | null
}

export type SchedulerTask = {
  id: string
  projectId: string
  title: string
  dependencies: string[]
  status: 'pending' | 'ready' | 'running' | 'completed' | 'failed' | 'blocked'
  assignedAgentId: string | null
  leaseResource: string | null
  worktreePath: string | null
  priority: number
}

export type PlanningCommit = {
  hash: string
  author: string
  timestampMs: number
  subject: string
  agentId: string | null
}

export type NowPlaying = {
  playing: boolean
  track: string
  artist: string
  album: string
  cover_url: string | null
  duration_ms: number
  progress_ms: number
  track_url: string | null
}

export type SpotifyCredentials = { clientId?: string; clientSecret?: string }

export async function remoteControlInfo(): Promise<RemoteControlInfo> {
  if (isTauriEnv()) return invoke<RemoteControlInfo>('remote_control_info')
  return webApiFetch<RemoteControlInfo>('/api/remote_control/info')
}

export async function remoteControlConnectedDevices(): Promise<number> {
  if (isTauriEnv()) return invoke<number>('remote_control_connected_devices')
  const info = await remoteControlInfo()
  return info.connected_devices
}

export type RemoteMessageEvent = {
  ptyId: string
  deviceId: number
  deviceName: string
  preview: string
}

export function listenRemoteMessages(
  handler: (event: RemoteMessageEvent) => void,
): Promise<UnlistenFn> {
  if (isTauriEnv())
    return listen<RemoteMessageEvent>('remote://message', (event) => handler(event.payload))
  return Promise.resolve(() => {})
}

export async function openRemoteControlPairing(): Promise<RemoteControlInfo> {
  if (isTauriEnv()) return invoke<RemoteControlInfo>('remote_control_open_pairing')
  return webApiFetch<RemoteControlInfo>('/api/remote_control/open_pairing', { method: 'POST' })
}

export async function closeRemoteControlPairing(): Promise<RemoteControlInfo> {
  if (isTauriEnv()) return invoke<RemoteControlInfo>('remote_control_close_pairing')
  return webApiFetch<RemoteControlInfo>('/api/remote_control/close_pairing', { method: 'POST' })
}

export async function setRemoteControlReadOnly(readOnly: boolean): Promise<RemoteControlInfo> {
  if (isTauriEnv()) return invoke<RemoteControlInfo>('remote_control_set_read_only', { readOnly })
  return webApiFetch<RemoteControlInfo>('/api/remote_control/set_read_only', {
    method: 'POST',
    body: JSON.stringify({ readOnly }),
  })
}

export async function setRemoteControlShellInput(allowed: boolean): Promise<RemoteControlInfo> {
  if (isTauriEnv()) return invoke<RemoteControlInfo>('remote_control_set_shell_input', { allowed })
  return webApiFetch<RemoteControlInfo>('/api/remote_control/set_shell_input', {
    method: 'POST',
    body: JSON.stringify({ allowed }),
  })
}

export async function remoteControlRevoke(): Promise<RemoteControlInfo> {
  if (isTauriEnv()) return invoke<RemoteControlInfo>('remote_control_revoke')
  return webApiFetch<RemoteControlInfo>('/api/remote_control/revoke', { method: 'POST' })
}

export async function setRemoteControlEnabled(enabled: boolean): Promise<RemoteControlInfo> {
  if (isTauriEnv()) return invoke<RemoteControlInfo>('remote_control_set_enabled', { enabled })
  return webApiFetch<RemoteControlInfo>('/api/remote_control/set_enabled', {
    method: 'POST',
    body: JSON.stringify({ enabled }),
  })
}

export async function setRemoteControlMaxDevices(maxDevices: number): Promise<RemoteControlInfo> {
  if (isTauriEnv())
    return invoke<RemoteControlInfo>('remote_control_set_max_devices', { maxDevices })
  return webApiFetch<RemoteControlInfo>('/api/remote_control/set_max_devices', {
    method: 'POST',
    body: JSON.stringify({ maxDevices }),
  })
}

export async function setRemoteControlSessionExpiry(
  sessionExpirySecs: number,
): Promise<RemoteControlInfo> {
  if (isTauriEnv())
    return invoke<RemoteControlInfo>('remote_control_set_session_expiry', { sessionExpirySecs })
  return webApiFetch<RemoteControlInfo>('/api/remote_control/set_session_expiry', {
    method: 'POST',
    body: JSON.stringify({ sessionExpirySecs }),
  })
}

export async function revokeRemoteControlDevice(deviceId: number): Promise<RemoteControlInfo> {
  if (isTauriEnv()) return invoke<RemoteControlInfo>('remote_control_revoke_device', { deviceId })
  return webApiFetch<RemoteControlInfo>('/api/remote_control/revoke_device', {
    method: 'POST',
    body: JSON.stringify({ deviceId }),
  })
}

export async function loadProjectsFile(): Promise<string | null> {
  if (isTauriEnv() && !(await canUseSharedCoreTransport())) {
    return invoke<string | null>('load_projects')
  }
  const res = await webApiFetch<unknown>('/api/projects/load')
  if (!res) return null
  if (typeof res === 'string') return res
  return JSON.stringify(res)
}

export type ProjectsBootstrap = {
  active_profile_id: string
  profiles: ProfileMeta[]
  content: string | null
  revision: string
}

export type SaveProjectsResult = {
  profile_id: string
  revision: string
}

export async function loadProjectsBootstrap(): Promise<ProjectsBootstrap> {
  if (isTauriEnv() && !(await canUseSharedCoreTransport())) {
    return invoke<ProjectsBootstrap>('load_projects_bootstrap')
  }
  return webApiFetch<ProjectsBootstrap>('/api/projects/bootstrap')
}

export async function saveProjectsForProfile(
  profileId: string,
  content: string,
  expectedRevision: string,
  keepalive = false,
): Promise<SaveProjectsResult> {
  if (isTauriEnv() && !(await canUseSharedCoreTransport())) {
    return invoke<SaveProjectsResult>('save_projects_for_profile', {
      profileId,
      content,
      expectedRevision,
    })
  }
  return webApiFetch<SaveProjectsResult>('/api/projects/save_for_profile', {
    method: 'POST',
    keepalive,
    body: JSON.stringify({ profileId, content, expectedRevision }),
  })
}

export async function saveProjectsFile(content: string, sequence: number): Promise<void> {
  if (isTauriEnv() && !(await canUseSharedCoreTransport())) {
    return invoke('save_projects', { content, sequence })
  }
  await webApiFetch('/api/projects/save', {
    method: 'POST',
    body: JSON.stringify({ content, sequence }),
  })
}

export async function recordFrontendError(
  message: string,
  stack: string | null,
  kind: string,
): Promise<void> {
  if (isTauriEnv()) {
    try {
      await invoke('record_frontend_error', { message, stack, kind })
    } catch {
      /* best-effort */
    }
    return
  }
}

/**
 * Mirrors a devtools console call to `logs/frontend.log` and into the unified decision stream.
 *
 * `corr` ties the line to the user gesture that produced it, so a frontend line and the backend
 * records it caused land on one timeline instead of in two files with no shared key.
 */
export async function recordConsoleLog(
  level: string,
  message: string,
  corr?: string | null,
): Promise<void> {
  if (!isTauriEnv()) return
  try {
    await invoke('record_console_log', { level, message, corr: corr ?? null })
  } catch {
    // Deliberately silent: this runs from inside the console wrapper, so reporting the failure
    // through `console.error` would recurse. The Rust side records its own write failures.
  }
}

/** Records a non-sensitive lifecycle event for persistence diagnostics. */
export async function recordAppEvent(kind: string, message: string): Promise<void> {
  if (!isTauriEnv()) return
  try {
    await invoke('record_app_event', { kind, message })
  } catch {
    /* best-effort */
  }
}

export async function setDiscordPresence(
  details: string,
  state: string,
  startedAt: number,
): Promise<void> {
  if (isTauriEnv()) return invoke('set_discord_presence', { details, state, startedAt })
}

export async function clearDiscordPresence(): Promise<void> {
  if (isTauriEnv()) return invoke('clear_discord_presence')
}

export async function findCliLauncher(agent: string): Promise<string | null> {
  if (isTauriEnv()) return invoke<string | null>('find_cli_launcher', { agent })
  const path = `/api/cli/find_cli_launcher?agent=${encodeURIComponent(agent)}`
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await webApiFetch<string | null>(path)
    } catch (error) {
      lastError = error
      if (attempt < 2) {
        await new Promise((resolve) => window.setTimeout(resolve, 250 * (attempt + 1)))
      }
    }
  }
  throw lastError
}

export async function probeInstallToolchain(): Promise<InstallToolchain> {
  if (isTauriEnv()) return invoke<InstallToolchain>('probe_install_toolchain')
  return webApiFetch<InstallToolchain>('/api/cli/probe_install_toolchain')
}

export async function agentCliVersion(agent: string): Promise<string | null> {
  if (isTauriEnv()) return invoke<string | null>('agent_cli_version', { agent })
  return webApiFetch<string | null>(
    `/api/cli/agent_cli_version?agent=${encodeURIComponent(agent)}`,
  ).catch(withFallback('encodeURIComponent', null))
}

export async function exportBackup(targetPath: string): Promise<void> {
  if (isTauriEnv()) return invoke('export_backup', { targetPath })
  await webApiFetch('/api/backup/export', { method: 'POST', body: JSON.stringify({ targetPath }) })
}

export async function exportProfileBackup(profileId: string, targetPath: string): Promise<void> {
  if (isTauriEnv()) return invoke('export_profile_backup', { profileId, targetPath })
  await webApiFetch('/api/backup/export_profile', {
    method: 'POST',
    body: JSON.stringify({ profileId, targetPath }),
  })
}

export async function importBackup(sourcePath: string): Promise<void> {
  if (isTauriEnv()) return invoke('import_backup', { sourcePath })
  await webApiFetch('/api/backup/import', { method: 'POST', body: JSON.stringify({ sourcePath }) })
}

export async function githubSyncStatus(): Promise<GithubSyncStatus> {
  if (isTauriEnv()) return invoke<GithubSyncStatus>('github_sync_status')
  return webApiFetch<GithubSyncStatus>('/api/github_sync/status')
}

export async function githubSyncSetToken(token: string): Promise<GithubSyncStatus> {
  if (isTauriEnv()) return invoke<GithubSyncStatus>('github_sync_set_token', { token })
  return webApiFetch<GithubSyncStatus>('/api/github_sync/token', {
    method: 'POST',
    body: JSON.stringify({ token }),
  })
}

export async function githubSyncLogout(): Promise<GithubSyncStatus> {
  if (isTauriEnv()) return invoke<GithubSyncStatus>('github_sync_logout')
  return webApiFetch<GithubSyncStatus>('/api/github_sync/logout', { method: 'POST' })
}

export async function githubSyncPush(): Promise<GithubSyncStatus> {
  if (isTauriEnv()) return invoke<GithubSyncStatus>('github_sync_push')
  return webApiFetch<GithubSyncStatus>('/api/github_sync/push', { method: 'POST' })
}

export async function githubSyncPull(): Promise<GithubSyncStatus> {
  if (isTauriEnv()) return invoke<GithubSyncStatus>('github_sync_pull')
  return webApiFetch<GithubSyncStatus>('/api/github_sync/pull', { method: 'POST' })
}

export async function publishEvent(event: EventBusPayload): Promise<void> {
  if (isTauriEnv()) return invoke('publish_event', { event })
  await webApiFetch('/api/event_bus/publish', { method: 'POST', body: JSON.stringify({ event }) })
}

export async function getTelemetryMetrics(): Promise<Record<string, MetricData>> {
  if (isTauriEnv()) return invoke<Record<string, MetricData>>('get_telemetry_metrics')
  return webApiFetch<Record<string, MetricData>>('/api/telemetry/metrics')
}

export async function getTelemetryTraces(correlationId?: string): Promise<EventBusPayload[]> {
  if (isTauriEnv()) return invoke<EventBusPayload[]>('get_telemetry_traces', { correlationId })
  return webApiFetch<EventBusPayload[]>(
    `/api/telemetry/traces${correlationId ? `?correlationId=${correlationId}` : ''}`,
  )
}

/** Name of the Tauri event `event_bus::publish` emits. Must stay identical to the literal in
 *  `src-tauri/src/event_bus.rs` — a mismatch here is silent, because a listener on a name nobody
 *  emits simply never fires. `eventBusName.contract.test.ts` fails if the two drift apart. */
export const EVENT_BUS_EVENT = 'alethe://event-bus'

export function listenEventBus(handler: (event: EventBusPayload) => void): Promise<UnlistenFn> {
  if (isTauriEnv())
    return listen<EventBusPayload>(EVENT_BUS_EVENT, (event) => handler(event.payload))
  // Web/Core mode has its own event stream (`/api/events/ws`, see `coreEvents.ts`); the event bus
  // is not bridged onto it, so there is nothing to subscribe to here.
  return Promise.resolve(() => {})
}

export async function runValidation(cwd: string, commands: string[]): Promise<ValidationResult> {
  if (isTauriEnv()) return invoke<ValidationResult>('run_validation', { cwd, commands })
  return webApiFetch<ValidationResult>('/api/validation/run', {
    method: 'POST',
    body: JSON.stringify({ cwd, commands }),
  })
}

/** Watches the project's `.planning/` folder. It is the only source of the `PlanningUpdated`
 *  event, which drives the scheduler's autotick and the planning autocommit — nothing else emits
 *  it, so a project with no watcher gets neither. Started for every project with a repository
 *  (see `App.tsx`), with no setting to turn it off. */
export async function startPlanningWatcher(projectId: string, repoPath: string): Promise<void> {
  if (isTauriEnv()) return invoke('start_planning_watcher', { projectId, repoPath })
  await webApiFetch('/api/planning/start_watcher', {
    method: 'POST',
    body: JSON.stringify({ projectId, repoPath }),
  })
}

export async function stopPlanningWatcher(projectId: string, repoPath: string): Promise<void> {
  if (isTauriEnv()) return invoke('stop_planning_watcher', { projectId, repoPath })
  await webApiFetch('/api/planning/stop_watcher', {
    method: 'POST',
    body: JSON.stringify({ projectId, repoPath }),
  })
}

/** Directory Alethe hands its agents as their configuration root, created on first use.
 *
 *  Passed to OpenCode as `XDG_CONFIG_HOME` at spawn, so an agent started from Alethe reads the
 *  configuration Alethe manages rather than whatever the machine happens to have. Only
 *  configuration is redirected: sessions, credentials and snapshots live in OpenCode's separate
 *  data directory and are untouched, so history and login survive. */
export async function agentConfigRoot(): Promise<string> {
  if (isTauriEnv()) return invoke<string>('agent_config_root')
  return webApiFetch<string>('/api/agent_config/root')
}

export async function readPlanningStatus(repoPath: string): Promise<PlanningStatus> {
  if (isTauriEnv()) return invoke<PlanningStatus>('read_planning_status', { repoPath })
  return webApiFetch<PlanningStatus>(
    `/api/planning/status?repoPath=${encodeURIComponent(repoPath)}`,
  )
}

export async function getSchedulerTasks(projectId: string): Promise<SchedulerTask[]> {
  if (isTauriEnv()) return invoke<SchedulerTask[]>('get_scheduler_tasks', { projectId })
  return webApiFetch<SchedulerTask[]>(
    `/api/scheduler/tasks?projectId=${encodeURIComponent(projectId)}`,
  )
}

export async function triggerSchedulerTick(
  projectId: string,
  repoPath: string,
  worktreeMode?: WorktreeMode,
): Promise<void> {
  if (isTauriEnv()) return invoke('trigger_scheduler_tick', { projectId, repoPath, worktreeMode })
  await webApiFetch('/api/scheduler/tick', {
    method: 'POST',
    body: JSON.stringify({ projectId, repoPath, worktreeMode }),
  })
}

export async function cancelTask(taskId: string): Promise<void> {
  if (isTauriEnv()) return invoke('cancel_task', { taskId })
  await webApiFetch('/api/scheduler/cancel_task', {
    method: 'POST',
    body: JSON.stringify({ taskId }),
  })
}

export async function planningAuditRecord(
  repoPath: string,
  agentId?: string,
  reason?: string,
  projectId?: string,
): Promise<PlanningCommit | null> {
  if (isTauriEnv())
    return invoke<PlanningCommit | null>('planning_audit_record', {
      repoPath,
      agentId,
      reason,
      projectId,
    })
  return webApiFetch<PlanningCommit | null>('/api/planning/audit_record', {
    method: 'POST',
    body: JSON.stringify({ repoPath, agentId, reason, projectId }),
  })
}

export type PlanItem = {
  id: string
  projectId: string
  terminalId?: string | null
  title: string
  filePath: string
  relativePath: string
  createdAtMs: number
  modifiedAtMs: number
  content?: string | null
}

export async function listProjectPlans(repoPath: string, projectId: string): Promise<PlanItem[]> {
  if (isTauriEnv()) return invoke<PlanItem[]>('list_project_plans', { repoPath, projectId })
  return webApiFetch<PlanItem[]>(
    `/api/planning/list_plans?repoPath=${encodeURIComponent(repoPath)}&projectId=${encodeURIComponent(projectId)}`,
  )
}

export async function saveProjectPlan(
  repoPath: string,
  projectId: string,
  terminalId: string | null | undefined,
  filename: string,
  content: string,
): Promise<PlanItem> {
  if (isTauriEnv())
    return invoke<PlanItem>('save_project_plan', {
      repoPath,
      projectId,
      terminalId,
      filename,
      content,
    })
  return webApiFetch<PlanItem>('/api/planning/save_plan', {
    method: 'POST',
    body: JSON.stringify({ repoPath, projectId, terminalId, filename, content }),
  })
}

export async function patchProjectPlan(
  filePath: string,
  targetContent: string,
  replacementContent: string,
): Promise<PlanItem> {
  if (isTauriEnv())
    return invoke<PlanItem>('patch_project_plan', {
      filePath,
      targetContent,
      replacementContent,
    })
  return webApiFetch<PlanItem>('/api/planning/patch_plan', {
    method: 'POST',
    body: JSON.stringify({ filePath, targetContent, replacementContent }),
  })
}

export async function appendPlanDiagram(
  filePath: string,
  title: string,
  mermaidCode: string,
): Promise<PlanItem> {
  if (isTauriEnv())
    return invoke<PlanItem>('append_plan_diagram', {
      filePath,
      title,
      mermaidCode,
    })
  return webApiFetch<PlanItem>('/api/planning/append_diagram', {
    method: 'POST',
    body: JSON.stringify({ filePath, title, mermaidCode }),
  })
}

export async function planningAuditHistory(
  repoPath: string,
  limit?: number,
): Promise<PlanningCommit[]> {
  if (isTauriEnv()) return invoke<PlanningCommit[]>('planning_audit_history', { repoPath, limit })
  return webApiFetch<PlanningCommit[]>(
    `/api/planning/audit_history?repoPath=${encodeURIComponent(repoPath)}${limit ? `&limit=${limit}` : ''}`,
  )
}

export async function setPlanningAutocommit(enabled: boolean): Promise<void> {
  if (isTauriEnv()) return invoke('set_planning_autocommit', { enabled })
  await webApiFetch('/api/planning/set_autocommit', {
    method: 'POST',
    body: JSON.stringify({ enabled }),
  })
}

export async function getPlanningAutocommit(): Promise<boolean> {
  if (isTauriEnv()) return invoke<boolean>('get_planning_autocommit')
  return webApiFetch<boolean>('/api/planning/autocommit')
}

export function spotifyLogin(credentials: SpotifyCredentials): Promise<void> {
  if (isTauriEnv()) return invoke('spotify_login', credentials)
  return Promise.resolve()
}

export function spotifyLogout(): Promise<void> {
  if (isTauriEnv()) return invoke('spotify_logout')
  return Promise.resolve()
}

export function spotifyStatus(): Promise<boolean> {
  if (isTauriEnv()) return invoke<boolean>('spotify_status')
  return Promise.resolve(false)
}

export function spotifyGetCurrent(credentials: SpotifyCredentials): Promise<NowPlaying | null> {
  if (isTauriEnv()) return invoke<NowPlaying | null>('spotify_get_current', credentials)
  return Promise.resolve(null)
}

/** Só usado pelo painel `RecorderHelper` (gravador de procedimentos e2e) —
 *  cria e devolve uma pasta temporária real, pra pular a digitação manual de
 *  um caminho ao gravar um procedimento do zero. Sem equivalente web: o
 *  gravador só roda contra o binário desktop Tauri. */
export function recorderScratchDir(): Promise<string> {
  if (isTauriEnv()) return invoke<string>('recorder_scratch_dir')
  return Promise.reject(new Error('recorderScratchDir: disponível só no app desktop (Tauri)'))
}
