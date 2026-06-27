import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

export async function loadProjectsFile(): Promise<string | null> {
  return invoke<string | null>('load_projects')
}

export async function saveProjectsFile(content: string): Promise<void> {
  await invoke('save_projects', { content })
}

export type ProfileMeta = {
  id: string
  name: string
  created_at_ms: number
  last_used_at_ms: number
}

export type ProfilesState = {
  active_profile_id: string
  profiles: ProfileMeta[]
}

export async function listProfiles(): Promise<ProfilesState> {
  return invoke<ProfilesState>('list_profiles')
}

export async function getActiveProfile(): Promise<ProfileMeta> {
  return invoke<ProfileMeta>('get_active_profile')
}

export async function setActiveProfile(profileId: string): Promise<ProfilesState> {
  return invoke<ProfilesState>('set_active_profile', { profileId })
}

export async function createProfile(name?: string): Promise<ProfilesState> {
  return invoke<ProfilesState>('create_profile', { name })
}

export async function renameProfile(profileId: string, name: string): Promise<ProfilesState> {
  return invoke<ProfilesState>('rename_profile', { profileId, name })
}

export async function deleteProfile(profileId: string): Promise<ProfilesState> {
  return invoke<ProfilesState>('delete_profile', { profileId })
}

export type SpawnPtyArgs = {
  cols: number
  rows: number
  id?: string
  command?: string
  cwd?: string
  extraArgs?: string[]
  /** Path absoluto pro launcher (override do auto-detect). */
  launcherOverride?: string
  /** Env extra só deste PTY (não vaza pra outros terminais). */
  env?: Record<string, string>
}

export async function spawnPty(args: SpawnPtyArgs): Promise<{ id: string }> {
  return invoke<{ id: string }>('spawn_pty', {
    cols: args.cols,
    rows: args.rows,
    id: args.id,
    command: args.command,
    cwd: args.cwd,
    extraArgs: args.extraArgs,
    launcherOverride: args.launcherOverride,
    env: args.env,
  })
}

export async function attachPty(id: string, maxBytes = 512 * 1024): Promise<string> {
  return invoke<string>('attach_pty', { id, maxBytes })
}

export async function writePty(id: string, data: string): Promise<void> {
  await invoke('write_pty', { id, data })
}

export async function resizePty(id: string, cols: number, rows: number): Promise<void> {
  await invoke('resize_pty', { id, cols, rows })
}

export async function killPty(id: string): Promise<void> {
  await invoke('kill_pty', { id })
}

export async function restartPty(args: SpawnPtyArgs & { id: string }): Promise<{ id: string }> {
  return invoke<{ id: string }>('restart_pty', {
    id: args.id,
    command: args.command,
    cwd: args.cwd,
    extraArgs: args.extraArgs,
  })
}

export async function getPtyCwd(id: string): Promise<string | null> {
  return invoke<string | null>('get_pty_cwd', { id })
}

export type PtyProcessSnapshot = {
  id: string
  pid: number | null
  command: string | null
  cwd: string | null
  process_name: string | null
  cmdline: string | null
  memory_mb: number
  alive: boolean
}

export async function listPtyProcesses(): Promise<PtyProcessSnapshot[]> {
  return invoke<PtyProcessSnapshot[]>('list_pty_processes')
}

export type DirectoryEntry = {
  name: string
  path: string
  is_dir: boolean
}

export async function listDirectory(path: string): Promise<DirectoryEntry[]> {
  return invoke<DirectoryEntry[]>('list_directory', { path })
}

export type GitFileChange = {
  path: string
  originalPath: string | null
  status: string
}

export type GitRepositoryStatus = {
  repoRoot: string
  branch: string
  detached: boolean
  ahead: number
  behind: number
  staged: GitFileChange[]
  changes: GitFileChange[]
  untracked: GitFileChange[]
  conflicts: GitFileChange[]
}

export async function gitStatus(path: string): Promise<GitRepositoryStatus> {
  return invoke<GitRepositoryStatus>('git_status', { path })
}

export async function gitStage(repoRoot: string, paths: string[]): Promise<void> {
  return invoke('git_stage', { repoRoot, paths })
}

export async function gitUnstage(repoRoot: string, paths: string[]): Promise<void> {
  return invoke('git_unstage', { repoRoot, paths })
}

export async function gitDiscard(repoRoot: string, paths: string[], untracked: boolean): Promise<void> {
  return invoke('git_discard', { repoRoot, paths, untracked })
}

export async function gitCommit(repoRoot: string, message: string): Promise<string> {
  return invoke<string>('git_commit', { repoRoot, message })
}

export async function gitPush(repoRoot: string): Promise<string> {
  return invoke<string>('git_push', { repoRoot })
}

export async function gitPull(repoRoot: string): Promise<string> {
  return invoke<string>('git_pull', { repoRoot })
}

export async function readTextFile(path: string): Promise<string> {
  return invoke<string>('read_text_file', { path })
}

export async function watchFile(path: string): Promise<void> {
  await invoke('watch_file', { path })
}

export async function unwatchFile(path: string): Promise<void> {
  await invoke('unwatch_file', { path })
}

/** Acorda quando um arquivo observado por `watchFile` muda no disco. */
export function listenFileChanged(handler: (path: string) => void): Promise<UnlistenFn> {
  return listen<{ path: string }>('md://changed', (event) => handler(event.payload.path))
}

export function listenPtyData(
  id: string,
  handler: (chunk: string) => void,
): Promise<UnlistenFn> {
  return listen<string>(`pty://data/${id}`, (event) => handler(event.payload))
}

export function listenPtyExit(
  id: string,
  handler: (code: number | null) => void,
): Promise<UnlistenFn> {
  return listen<{ code: number | null }>(`pty://exit/${id}`, (event) =>
    handler(event.payload.code),
  )
}

export type MemoryStats = {
  total_mb: number
  app_mb: number
  webview_mb: number
  ptys_mb: number
  process_count: number
}

export async function getMemoryStats(): Promise<MemoryStats> {
  return invoke<MemoryStats>('get_memory_stats')
}

/** Estado da sessão anterior, se ela não saiu limpa (provável crash/OOM/kill). */
export type CrashReport = {
  started_at_ms: number
  clean_exit: boolean
  app_version: string
  last_heartbeat_ms: number
  total_mb: number
  ptys_mb: number
  webview_mb: number
  process_count: number
}

/** null se a sessão anterior saiu limpa (ou é o primeiro boot). */
export async function getLastCrashReport(): Promise<CrashReport | null> {
  return invoke<CrashReport | null>('get_last_crash_report')
}

export async function openDataFolder(): Promise<void> {
  await invoke('open_data_folder')
}

export async function openSpawnLog(): Promise<void> {
  await invoke('open_spawn_log')
}

export async function openInFileExplorer(path: string): Promise<void> {
  await invoke('open_in_file_explorer', { path })
}

export async function openInVscode(path: string): Promise<void> {
  await invoke('open_in_vscode', { path })
}

export async function openInBrowser(target: string): Promise<void> {
  await invoke('open_in_browser', { target })
}

export async function openLogsFolder(): Promise<void> {
  await invoke('open_logs_folder')
}

export async function exportLogs(targetPath: string): Promise<void> {
  await invoke('export_logs', { targetPath })
}

/** Persiste um erro do frontend no log de crash. Nunca lança (logging não pode quebrar o caller). */
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

export async function writeClipboardText(text: string): Promise<void> {
  await invoke('write_clipboard_text', { text })
}

export async function readClipboardText(): Promise<string> {
  return invoke<string>('read_clipboard_text')
}

export async function resetAppData(): Promise<void> {
  await invoke('reset_app_data')
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

export async function exportBackup(targetPath: string): Promise<void> {
  await invoke('export_backup', { targetPath })
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

export type ClaudeUsageWindow = {
  utilization: number
  resets_at: string
}

export type ClaudeUsage = {
  five_hour: ClaudeUsageWindow
  seven_day: ClaudeUsageWindow
  seven_day_opus: ClaudeUsageWindow
}

export async function getClaudeUsage(): Promise<ClaudeUsage> {
  return invoke<ClaudeUsage>('get_claude_usage')
}

export type CodexUsageWindow = {
  used_percent: number
  window_minutes: number
  /** Epoch em milissegundos (0 = desconhecido). */
  resets_at_ms: number
}

export type CodexUsage = {
  primary: CodexUsageWindow
  secondary: CodexUsageWindow
  plan: string
  rate_limited: boolean
  reset_credits: number
}

export async function getCodexUsage(): Promise<CodexUsage> {
  return invoke<CodexUsage>('get_codex_usage')
}

/** Custo por modelo dentro de uma sessão (tokens + USD). */
export type ModelCost = {
  model: string
  input: number
  output: number
  cache_read: number
  cache_write_5m: number
  cache_write_1h: number
  /** null se o modelo não está na tabela de preço (ex.: GPT do Codex). */
  cost_usd: number | null
}

/** Custo real de uma sessão, parseado do JSONL (Claude/Codex). */
export type SessionCost = {
  session_id: string
  agent: string
  input: number
  output: number
  cache_read: number
  cache_write_5m: number
  cache_write_1h: number
  total_tokens: number
  cost_usd: number | null
  model: string | null
  by_model: ModelCost[]
}

export async function getSessionCost(
  agent: string,
  cwd: string,
  sessionId: string,
): Promise<SessionCost> {
  return invoke<SessionCost>('get_session_cost', { agent, cwd, sessionId })
}

/** Custo de um transcript JSONL do Claude por path — pros nós do agent canvas. */
export async function getTranscriptCost(path: string): Promise<SessionCost> {
  return invoke<SessionCost>('get_transcript_cost', { path })
}

/** Preço por 1M de tokens por família de modelo (opus/sonnet/haiku). */
export type ModelRate = {
  family: string
  input: number
  output: number
  cache_write_5m: number
  cache_write_1h: number
  cache_read: number
}

/** Tabela de preço (do backend) pra estimar economia por roteamento no front. */
export async function getModelPricing(): Promise<ModelRate[]> {
  return invoke<ModelRate[]>('get_model_pricing')
}

export type ClaudeSessionMeta = {
  id: string
  title: string | null
  first_user_prompt: string | null
  message_count: number
  modified_at_ms: number
  size_bytes: number
}

export type ClaudeSessionSnapshot = {
  id: string
  modified_at_ms: number
  size_bytes: number
}

export type CodexSessionSnapshot = {
  id: string
  cwd: string
  modified_at_ms: number
  size_bytes: number
}

export async function snapshotClaudeSessions(cwd: string): Promise<ClaudeSessionSnapshot[]> {
  return invoke<ClaudeSessionSnapshot[]>('snapshot_claude_sessions', { cwd })
}

export async function snapshotCodexSessions(cwd: string): Promise<CodexSessionSnapshot[]> {
  return invoke<CodexSessionSnapshot[]>('snapshot_codex_sessions', { cwd })
}

export async function listClaudeSessions(cwd: string): Promise<ClaudeSessionMeta[]> {
  return invoke<ClaudeSessionMeta[]>('list_claude_sessions', { cwd })
}

export type ActivityDay = {
  /** Data UTC YYYY-MM-DD */
  date: string
  /** Mensagens (user + assistant) registradas no dia */
  count: number
}

export async function getClaudeActivity(days: number): Promise<ActivityDay[]> {
  return invoke<ActivityDay[]>('get_claude_activity', { days })
}

export type ActivityAgentSample = {
  agent: Exclude<import('./types').AgentType, 'shell'>
  projectId: string | null
  terminalId: string | null
  state: 'working' | 'waiting'
}

export type ActivitySample = {
  date: string
  durationMs: number
  appFocused: boolean
  userActive: boolean
  activeProjectId: string | null
  activeTerminalId: string | null
  agents: ActivityAgentSample[]
}

export type ActivityTimeTotals = {
  appOpenMs: number
  appFocusedMs: number
  userActiveMs: number
  userIdleMs: number
  agentWallMs: number
  agentSumMs: number
  agentBackgroundMs: number
  parallelMs: number
  peakConcurrent: number
}

export type AgentTimeStats = {
  workingMs: number
  waitingMs: number
  focusedMs: number
  backgroundMs: number
}

export type ProjectTimeStats = {
  focusedMs: number
  activeMs: number
  idleMs: number
  agentWallMs: number
  agentSumMs: number
  agentBackgroundMs: number
  parallelMs: number
}

export type ActivitySummary = {
  totals: ActivityTimeTotals
  agents: Record<string, AgentTimeStats>
  projects: Record<string, ProjectTimeStats>
}

export async function recordActivitySamples(samples: ActivitySample[]): Promise<void> {
  await invoke('record_activity_samples', { samples })
}

export async function getActivitySummary(dates: string[] = []): Promise<ActivitySummary> {
  return invoke<ActivitySummary>('get_activity_summary', { dates })
}

export async function clearActivityStats(): Promise<void> {
  await invoke('clear_activity_stats')
}
