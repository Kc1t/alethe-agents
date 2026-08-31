import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

import type { InstallToolchain } from '../agentInstall'
import type { WorktreeMode } from './git'

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

export async function remoteControlInfo(): Promise<RemoteControlInfo> {
  return invoke<RemoteControlInfo>('remote_control_info')
}

export async function remoteControlConnectedDevices(): Promise<number> {
  return invoke<number>('remote_control_connected_devices')
}

export async function remoteControlRevoke(): Promise<RemoteControlInfo> {
  return invoke<RemoteControlInfo>('remote_control_revoke')
}

export async function setRemoteControlEnabled(enabled: boolean): Promise<RemoteControlInfo> {
  return invoke<RemoteControlInfo>('remote_control_set_enabled', { enabled })
}

export async function setRemoteControlMaxDevices(maxDevices: number): Promise<RemoteControlInfo> {
  return invoke<RemoteControlInfo>('remote_control_set_max_devices', { maxDevices })
}

export async function setRemoteControlSessionExpiry(
  sessionExpirySecs: number,
): Promise<RemoteControlInfo> {
  return invoke<RemoteControlInfo>('remote_control_set_session_expiry', { sessionExpirySecs })
}

export async function revokeRemoteControlDevice(deviceId: number): Promise<RemoteControlInfo> {
  return invoke<RemoteControlInfo>('remote_control_revoke_device', { deviceId })
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
  return listen<RemoteMessageEvent>('remote://message', (event) => handler(event.payload))
}

export async function openRemoteControlPairing(): Promise<RemoteControlInfo> {
  return invoke<RemoteControlInfo>('remote_control_open_pairing')
}

export async function closeRemoteControlPairing(): Promise<RemoteControlInfo> {
  return invoke<RemoteControlInfo>('remote_control_close_pairing')
}

export async function setRemoteControlReadOnly(readOnly: boolean): Promise<RemoteControlInfo> {
  return invoke<RemoteControlInfo>('remote_control_set_read_only', { readOnly })
}

export async function setRemoteControlShellInput(allowed: boolean): Promise<RemoteControlInfo> {
  return invoke<RemoteControlInfo>('remote_control_set_shell_input', { allowed })
}

export async function loadProjectsFile(): Promise<string | null> {
  return invoke<string | null>('load_projects')
}

export async function saveProjectsFile(content: string, sequence: number): Promise<void> {
  await invoke('save_projects', { content, sequence })
}

export async function recordFrontendError(
  message: string,
  stack: string | null,
  kind: string,
): Promise<void> {
  try {
    await invoke('record_frontend_error', { message, stack, kind })
  } catch {
    /* logging best-effort */
  }
}

/** Records a non-sensitive lifecycle event for persistence diagnostics. */
export async function recordAppEvent(kind: string, message: string): Promise<void> {
  try {
    await invoke('record_app_event', { kind, message })
  } catch {
    /* logging best-effort */
  }
}

export async function setDiscordPresence(
  details: string,
  state: string,
  startedAt: number,
): Promise<void> {
  await invoke('set_discord_presence', { details, state, startedAt })
}

export async function clearDiscordPresence(): Promise<void> {
  await invoke('clear_discord_presence')
}

export async function findCliLauncher(agent: string): Promise<string | null> {
  return invoke<string | null>('find_cli_launcher', { agent })
}

export async function probeInstallToolchain(): Promise<InstallToolchain> {
  return invoke<InstallToolchain>('probe_install_toolchain')
}

export async function agentCliVersion(agent: string): Promise<string | null> {
  return invoke<string | null>('agent_cli_version', { agent })
}

export async function exportBackup(targetPath: string): Promise<void> {
  await invoke('export_backup', { targetPath })
}

export async function exportProfileBackup(profileId: string, targetPath: string): Promise<void> {
  await invoke('export_profile_backup', { profileId, targetPath })
}

export async function importBackup(sourcePath: string): Promise<void> {
  await invoke('import_backup', { sourcePath })
}

export type GithubSyncStatus = {
  connected: boolean
  login: string | null
  gist_id: string | null
  gist_url: string | null
  last_push_ms: number | null
  last_pull_ms: number | null
}

export async function githubSyncStatus(): Promise<GithubSyncStatus> {
  return invoke<GithubSyncStatus>('github_sync_status')
}

export async function githubSyncSetToken(token: string): Promise<GithubSyncStatus> {
  return invoke<GithubSyncStatus>('github_sync_set_token', { token })
}

export async function githubSyncLogout(): Promise<GithubSyncStatus> {
  return invoke<GithubSyncStatus>('github_sync_logout')
}

export async function githubSyncPush(): Promise<GithubSyncStatus> {
  return invoke<GithubSyncStatus>('github_sync_push')
}

export async function githubSyncPull(): Promise<GithubSyncStatus> {
  return invoke<GithubSyncStatus>('github_sync_pull')
}

// --- RFC-001 — Event Bus & Observabilidade ---

export type EventBusPayload = {
  event_type: string
  timestamp_ms: number
  correlation_id: string
  task_id: string | null
  agent_id: string | null
  data: Record<string, any>
}

export type MetricData = {
  count: number
  last_value: number
  sum: number
}

export async function publishEvent(event: EventBusPayload): Promise<void> {
  await invoke('publish_event', { event })
}

export async function getTelemetryMetrics(): Promise<Record<string, MetricData>> {
  return invoke<Record<string, MetricData>>('get_telemetry_metrics')
}

export async function getTelemetryTraces(correlationId?: string): Promise<EventBusPayload[]> {
  return invoke<EventBusPayload[]>('get_telemetry_traces', { correlationId })
}

export function listenEventBus(handler: (event: EventBusPayload) => void): Promise<UnlistenFn> {
  return listen<EventBusPayload>('event-bus-event', (event) => handler(event.payload))
}

// --- RFC-008 & RFC-005 — Validation & GSD Watcher ---

export type ValidationResult = {
  success: boolean
  stage: string
  output: string
}

export async function runValidation(cwd: string, commands: string[]): Promise<ValidationResult> {
  return invoke<ValidationResult>('run_validation', { cwd, commands })
}

export async function startGsdWatcher(projectId: string, repoPath: string): Promise<void> {
  await invoke('start_gsd_watcher', { projectId, repoPath })
}

export async function stopGsdWatcher(projectId: string, repoPath: string): Promise<void> {
  await invoke('stop_gsd_watcher', { projectId, repoPath })
}

export type PlanningStatus = {
  hasPlanning: boolean
  reportedComplete: boolean
  progress: number | null
  roadmapPendingCount: number | null
  roadmapTotalCount: number | null

  notes: string | null
}

export async function readPlanningStatus(repoPath: string): Promise<PlanningStatus> {
  return invoke<PlanningStatus>('read_planning_status', { repoPath })
}

export type PlanItem = {
  id: string
  projectId: string
  terminalId: string | null
  title: string
  filePath: string
  relativePath: string
  createdAtMs: number
  modifiedAtMs: number
  content?: string
}

export async function listProjectPlans(repoPath: string, projectId: string): Promise<PlanItem[]> {
  return invoke<PlanItem[]>('list_project_plans', { repoPath, projectId })
}

export async function gsdOpenCodePluginWrite(repo: string, modelChain: string[]): Promise<void> {
  await invoke('gsd_opencode_plugin_write', { repo, modelChain })
}

export async function readGsdChildSession(repoPath: string): Promise<string | null> {
  return invoke<string | null>('read_gsd_child_session', { repoPath })
}

export async function readGsdChildBusy(repoPath: string): Promise<boolean> {
  return invoke<boolean>('read_gsd_child_busy', { repoPath })
}

export async function readGsdChildError(repoPath: string): Promise<string | null> {
  return invoke<string | null>('read_gsd_child_error', { repoPath })
}

export type GsdChildState = {
  sessionId: string | null
  busy: boolean
  error: string | null
}

export async function readGsdChildState(repoPath: string): Promise<GsdChildState> {
  return invoke<GsdChildState>('read_gsd_child_state', { repoPath })
}

export type GsdProcedureStep = { description: string; category: string }

export async function readGsdProcedure(repoPath: string): Promise<GsdProcedureStep[]> {
  return invoke<GsdProcedureStep[]>('read_gsd_procedure', { repoPath })
}

// --- RFC-002 — Scheduler ---

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

export async function getSchedulerTasks(projectId: string): Promise<SchedulerTask[]> {
  return invoke<SchedulerTask[]>('get_scheduler_tasks', { projectId })
}

export async function triggerSchedulerTick(
  projectId: string,
  repoPath: string,
  worktreeMode?: WorktreeMode,
): Promise<void> {
  await invoke('trigger_scheduler_tick', { projectId, repoPath, worktreeMode })
}

export async function cancelTask(taskId: string): Promise<void> {
  await invoke('cancel_task', { taskId })
}

// --- RFC-005 — Auditoria GSD ---

export type PlanningCommit = {
  hash: string
  author: string
  timestampMs: number
  subject: string
  agentId: string | null
}

export async function planningAuditRecord(
  repoPath: string,
  agentId?: string,
  reason?: string,
  projectId?: string,
): Promise<PlanningCommit | null> {
  return invoke<PlanningCommit | null>('planning_audit_record', {
    repoPath,
    agentId,
    reason,
    projectId,
  })
}

export async function planningAuditHistory(
  repoPath: string,
  limit?: number,
): Promise<PlanningCommit[]> {
  return invoke<PlanningCommit[]>('planning_audit_history', { repoPath, limit })
}

export async function setPlanningAutocommit(enabled: boolean): Promise<void> {
  await invoke('set_planning_autocommit', { enabled })
}

export async function getPlanningAutocommit(): Promise<boolean> {
  return invoke<boolean>('get_planning_autocommit')
}

// --- Spotify ---

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

export type SpotifyCredentials = {
  clientId?: string
  clientSecret?: string
}

export function spotifyLogin(credentials: SpotifyCredentials): Promise<void> {
  return invoke('spotify_login', credentials)
}

export function spotifyLogout(): Promise<void> {
  return invoke('spotify_logout')
}

export function spotifyStatus(): Promise<boolean> {
  return invoke<boolean>('spotify_status')
}

export function spotifyGetCurrent(credentials: SpotifyCredentials): Promise<NowPlaying | null> {
  return invoke<NowPlaying | null>('spotify_get_current', credentials)
}
