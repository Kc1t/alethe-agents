import { invoke } from '@tauri-apps/api/core'

import { isTauriEnv, webApiFetch } from './transport'

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

export type DiffSummaryEntry = {
  path: string
  status: string
  additions?: number
  deletions?: number
}

export type GitCommitEntry = {
  hash: string
  parents: string[]
  authorName: string
  authorEmail: string
  timestamp: number
  subject: string
  refs: string[]
}

export type GitResetMode = 'soft' | 'mixed' | 'hard'

export type IncomingOutgoing = {
  incoming: GitFileChange[]
  outgoing: GitFileChange[]
  hasUpstream: boolean
}

export type WorktreeMode = 'gitWorktree' | 'localCopy'

export type WorktreeInfo = {
  agentId: string
  path: string
  branch: string
  mode: WorktreeMode
  createdAt: number
}

export type WorktreePendingChange = { path: string; status: string }

export type ConflictClass =
  | 'rust'
  | 'typeScript'
  | 'ui'
  | 'cargo'
  | 'package'
  | 'json'
  | 'config'
  | 'asset'
  | 'planning'
  | 'sentinel'
  | 'graph'
  | 'other'

export type ConflictFile = { path: string; class: ConflictClass }

export type MergeAnalysis = {
  clean: boolean
  source: string
  target: string
  conflicts: ConflictFile[]
  classes: ConflictClass[]
}

export type ConflictEnv = {
  id: string
  path: string
  branch: string
  clean: boolean
  conflicts: ConflictFile[]
  promptPath?: string
}

export type MergeOutcome = {
  merged: boolean
  stage: string
  output: string
  contractWarnings: ContractWarning[]
  /** `false` quando o projeto não tinha `validationCommands` configurado — nada foi checado. */
  validationRan: boolean
  /** Camada 4 do Escudo (aviso, nunca bloqueia): só presente se `healthCheckCommand` estava configurado. */
  healthProbe: HealthProbeResult | null
}

export type MergeForceCleanupResult = { deleted: boolean; pruned: boolean }

export type ProjectStack = 'web' | 'cli' | 'desktop' | 'fullstack' | 'unknown'

export type StackDetection = {
  stack: ProjectStack
  hasFrontend: boolean
  hasBackend: boolean
  hasTauri: boolean
  suggestedCommands: string[]
}

export type ApiCallSite = { file: string; line: number; method: string | null; pathPattern: string }
export type ContractWarning = { call: ApiCallSite; reason: string }
export type HealthProbeResult = {
  started: boolean
  responded: boolean
  statusCode: number | null
  elapsedMs: number
  outputTail: string
  /** `null` = não é um core do Alethe (nada de terminal pra verificar). */
  terminalVerified: boolean | null
}

export async function gitStatus(path: string): Promise<GitRepositoryStatus> {
  if (isTauriEnv()) return invoke<GitRepositoryStatus>('git_status', { path })
  return webApiFetch<GitRepositoryStatus>(`/api/git/status?path=${encodeURIComponent(path)}`)
}

export async function gitInit(path: string): Promise<string> {
  if (isTauriEnv()) return invoke<string>('git_init', { path })
  return webApiFetch<string>('/api/git/init', { method: 'POST', body: JSON.stringify({ path }) })
}

export async function gitStage(repoRoot: string, paths: string[]): Promise<void> {
  if (isTauriEnv()) return invoke('git_stage', { repoRoot, paths })
  await webApiFetch('/api/git/stage', { method: 'POST', body: JSON.stringify({ repoRoot, paths }) })
}

export async function gitDiff(repoRoot: string, path: string, staged: boolean): Promise<string> {
  if (isTauriEnv()) return invoke<string>('git_diff', { repoRoot, path, staged })
  return webApiFetch<string>('/api/git/diff', {
    method: 'POST',
    body: JSON.stringify({ repoRoot, path, staged }),
  })
}

export async function gitUnstage(repoRoot: string, paths: string[]): Promise<void> {
  if (isTauriEnv()) return invoke('git_unstage', { repoRoot, paths })
  await webApiFetch('/api/git/unstage', {
    method: 'POST',
    body: JSON.stringify({ repoRoot, paths }),
  })
}

export async function gitDiscard(
  repoRoot: string,
  paths: string[],
  untracked: boolean,
): Promise<void> {
  if (isTauriEnv()) return invoke('git_discard', { repoRoot, paths, untracked })
  await webApiFetch('/api/git/discard', {
    method: 'POST',
    body: JSON.stringify({ repoRoot, paths, untracked }),
  })
}

export async function gitCommit(repoRoot: string, message: string): Promise<string> {
  if (isTauriEnv()) return invoke<string>('git_commit', { repoRoot, message })
  return webApiFetch<string>('/api/git/commit', {
    method: 'POST',
    body: JSON.stringify({ repoRoot, message }),
  })
}

export async function gitPush(repoRoot: string): Promise<string> {
  if (isTauriEnv()) return invoke<string>('git_push', { repoRoot })
  return webApiFetch<string>('/api/git/push', {
    method: 'POST',
    body: JSON.stringify({ repoRoot }),
  })
}

export async function gitPull(repoRoot: string): Promise<string> {
  if (isTauriEnv()) return invoke<string>('git_pull', { repoRoot })
  return webApiFetch<string>('/api/git/pull', {
    method: 'POST',
    body: JSON.stringify({ repoRoot }),
  })
}

export async function gitListBranches(repoRoot: string): Promise<string[]> {
  if (isTauriEnv()) return invoke<string[]>('git_list_branches', { repoRoot })
  return webApiFetch<string[]>(`/api/git/branches?repoRoot=${encodeURIComponent(repoRoot)}`)
}

export async function cloneGithubRepo(url: string, targetDir: string): Promise<string> {
  if (isTauriEnv()) return invoke<string>('clone_github_repo', { url, targetDir })
  return webApiFetch<string>('/api/git/clone', {
    method: 'POST',
    body: JSON.stringify({ url, targetDir }),
  })
}

export async function gitDiffSummary(
  repoRoot: string,
  source: string,
  target: string,
  worktreePath?: string,
): Promise<DiffSummaryEntry[]> {
  if (isTauriEnv())
    return invoke<DiffSummaryEntry[]>('git_diff_summary', {
      repoRoot,
      source,
      target,
      worktreePath,
    })
  return webApiFetch<DiffSummaryEntry[]>('/api/git/diff_summary', {
    method: 'POST',
    body: JSON.stringify({ repoRoot, source, target, worktreePath }),
  })
}

export async function gitLogGraph(repo: string, maxCount: number): Promise<GitCommitEntry[]> {
  if (isTauriEnv()) return invoke<GitCommitEntry[]>('git_log_graph', { repo, maxCount })
  return webApiFetch<GitCommitEntry[]>(
    `/api/git/log_graph?repo=${encodeURIComponent(repo)}&maxCount=${maxCount}`,
  )
}

export async function gitShowCommitFiles(repo: string, hash: string): Promise<GitFileChange[]> {
  if (isTauriEnv()) return invoke<GitFileChange[]>('git_show_commit_files', { repo, hash })
  return webApiFetch<GitFileChange[]>(
    `/api/git/commit_files?repo=${encodeURIComponent(repo)}&hash=${encodeURIComponent(hash)}`,
  )
}

/** Per-file added/removed line counts for one commit — the changed-file list alone only says
 *  *that* a file changed, not how much. `additions`/`deletions` are absent for binary files,
 *  which have no line counts to report. */
export async function gitShowCommitStats(repo: string, hash: string): Promise<DiffSummaryEntry[]> {
  if (isTauriEnv()) return invoke<DiffSummaryEntry[]>('git_show_commit_stats', { repo, hash })
  return webApiFetch<DiffSummaryEntry[]>(
    `/api/git/commit_stats?repo=${encodeURIComponent(repo)}&hash=${encodeURIComponent(hash)}`,
  )
}

/** Mensagem COMPLETA do commit (subject + corpo) — `git_log_graph` só traz o
 *  subject; alimenta a tela de detalhe do commit no gráfico. */
export async function gitShowCommitMessage(repo: string, hash: string): Promise<string> {
  if (isTauriEnv()) return invoke<string>('git_show_commit_message', { repo, hash })
  return webApiFetch<string>(
    `/api/git/commit_message?repo=${encodeURIComponent(repo)}&hash=${encodeURIComponent(hash)}`,
  )
}

export async function gitCreateBranchFromCommit(
  repo: string,
  hash: string,
  branchName: string,
): Promise<void> {
  if (isTauriEnv()) return invoke('git_create_branch_from_commit', { repo, hash, branchName })
  await webApiFetch('/api/git/create_branch', {
    method: 'POST',
    body: JSON.stringify({ repo, hash, branchName }),
  })
}

export async function gitCherryPickCommit(repo: string, hash: string): Promise<string> {
  if (isTauriEnv()) return invoke<string>('git_cherry_pick_commit', { repo, hash })
  return webApiFetch<string>('/api/git/cherry_pick', {
    method: 'POST',
    body: JSON.stringify({ repo, hash }),
  })
}

export async function gitRevertCommit(repo: string, hash: string): Promise<string> {
  if (isTauriEnv()) return invoke<string>('git_revert_commit', { repo, hash })
  return webApiFetch<string>('/api/git/revert', {
    method: 'POST',
    body: JSON.stringify({ repo, hash }),
  })
}

export async function gitResetToCommit(
  repo: string,
  hash: string,
  mode: GitResetMode,
): Promise<void> {
  if (isTauriEnv()) return invoke('git_reset_to_commit', { repo, hash, mode })
  await webApiFetch('/api/git/reset', {
    method: 'POST',
    body: JSON.stringify({ repo, hash, mode }),
  })
}

export async function gitIncomingOutgoing(repo: string): Promise<IncomingOutgoing> {
  if (isTauriEnv()) return invoke<IncomingOutgoing>('git_incoming_outgoing', { repo })
  return webApiFetch<IncomingOutgoing>(
    `/api/git/incoming_outgoing?repo=${encodeURIComponent(repo)}`,
  )
}

export async function worktreeProvision(
  repo: string,
  agentId: string,
  mode: WorktreeMode,
): Promise<WorktreeInfo> {
  if (isTauriEnv()) return invoke<WorktreeInfo>('worktree_provision', { repo, agentId, mode })
  return webApiFetch<WorktreeInfo>('/api/worktree/provision', {
    method: 'POST',
    body: JSON.stringify({ repo, agentId, mode }),
  })
}

export async function worktreeList(repo: string): Promise<WorktreeInfo[]> {
  if (isTauriEnv()) return invoke<WorktreeInfo[]>('worktree_list', { repo })
  return webApiFetch<WorktreeInfo[]>(`/api/worktree/list?repo=${encodeURIComponent(repo)}`)
}

export async function worktreeRemove(repo: string, agentId: string, force: boolean): Promise<void> {
  if (isTauriEnv()) return invoke('worktree_remove', { repo, agentId, force })
  await webApiFetch('/api/worktree/remove', {
    method: 'POST',
    body: JSON.stringify({ repo, agentId, force }),
  })
}

export async function worktreeCleanup(repo: string): Promise<void> {
  if (isTauriEnv()) return invoke('worktree_cleanup', { repo })
  await webApiFetch('/api/worktree/cleanup', { method: 'POST', body: JSON.stringify({ repo }) })
}

export async function worktreeFetchBranch(repo: string, agentId: string): Promise<void> {
  if (isTauriEnv()) return invoke('worktree_fetch_branch', { repo, agentId })
  await webApiFetch('/api/worktree/fetch_branch', {
    method: 'POST',
    body: JSON.stringify({ repo, agentId }),
  })
}

export async function worktreeCommitPending(repo: string, agentId: string): Promise<boolean> {
  if (isTauriEnv()) return invoke<boolean>('worktree_commit_pending', { repo, agentId })
  return webApiFetch<boolean>('/api/worktree/commit_pending', {
    method: 'POST',
    body: JSON.stringify({ repo, agentId }),
  })
}

export async function worktreePendingChanges(
  repo: string,
  agentId: string,
): Promise<WorktreePendingChange[]> {
  if (isTauriEnv())
    return invoke<WorktreePendingChange[]>('worktree_pending_changes', { repo, agentId })
  return webApiFetch<WorktreePendingChange[]>(
    `/api/worktree/pending_changes?repo=${encodeURIComponent(repo)}&agentId=${encodeURIComponent(agentId)}`,
  )
}

export async function worktreeCommitWorktree(
  repo: string,
  agentId: string,
  message: string,
): Promise<boolean> {
  if (isTauriEnv()) return invoke<boolean>('worktree_commit_worktree', { repo, agentId, message })
  return webApiFetch<boolean>('/api/worktree/commit_worktree', {
    method: 'POST',
    body: JSON.stringify({ repo, agentId, message }),
  })
}

export async function worktreeLock(repo: string, agentId: string, reason?: string): Promise<void> {
  if (isTauriEnv()) return invoke('worktree_lock', { repo, agentId, reason })
  await webApiFetch('/api/worktree/lock', {
    method: 'POST',
    body: JSON.stringify({ repo, agentId, reason }),
  })
}

export async function worktreeUnlock(repo: string, agentId: string): Promise<void> {
  if (isTauriEnv()) return invoke('worktree_unlock', { repo, agentId })
  await webApiFetch('/api/worktree/unlock', {
    method: 'POST',
    body: JSON.stringify({ repo, agentId }),
  })
}

export async function mergeAnalyze(
  repo: string,
  source: string,
  target: string,
  projectId?: string,
): Promise<MergeAnalysis> {
  if (isTauriEnv())
    return invoke<MergeAnalysis>('merge_analyze', { repo, source, target, projectId })
  return webApiFetch<MergeAnalysis>('/api/merge/analyze', {
    method: 'POST',
    body: JSON.stringify({ repo, source, target, projectId }),
  })
}

export async function mergePrepare(
  repo: string,
  source: string,
  target: string,
  projectId?: string,
): Promise<ConflictEnv> {
  if (isTauriEnv()) return invoke<ConflictEnv>('merge_prepare', { repo, source, target, projectId })
  return webApiFetch<ConflictEnv>('/api/merge/prepare', {
    method: 'POST',
    body: JSON.stringify({ repo, source, target, projectId }),
  })
}

export async function mergeValidate(
  repo: string,
  envId: string,
  validationCommands: string[],
): Promise<MergeOutcome> {
  if (isTauriEnv())
    return invoke<MergeOutcome>('merge_validate', { repo, envId, validationCommands })
  return webApiFetch<MergeOutcome>('/api/merge/validate', {
    method: 'POST',
    body: JSON.stringify({ repo, envId, validationCommands }),
  })
}

export async function mergeFinalize(
  repo: string,
  envId: string,
  validationCommands: string[],
  healthCheckCommand?: string,
  healthCheckPath?: string,
): Promise<MergeOutcome> {
  if (isTauriEnv())
    return invoke<MergeOutcome>('merge_finalize', {
      repo,
      envId,
      validationCommands,
      healthCheckCommand,
      healthCheckPath,
    })
  return webApiFetch<MergeOutcome>('/api/merge/finalize', {
    method: 'POST',
    body: JSON.stringify({ repo, envId, validationCommands, healthCheckCommand, healthCheckPath }),
  })
}

export async function mergeAbort(repo: string, envId: string): Promise<void> {
  if (isTauriEnv()) return invoke('merge_abort', { repo, envId })
  await webApiFetch('/api/merge/abort', { method: 'POST', body: JSON.stringify({ repo, envId }) })
}

export async function mergePreflightAbort(repo: string, envId: string): Promise<void> {
  if (isTauriEnv()) return invoke('merge_preflight_abort', { repo, envId })
  await webApiFetch('/api/merge/preflight_abort', {
    method: 'POST',
    body: JSON.stringify({ repo, envId }),
  })
}

export async function mergeRebaseOntoTarget(repo: string, envId: string): Promise<MergeOutcome> {
  if (isTauriEnv()) return invoke<MergeOutcome>('merge_rebase_onto_target', { repo, envId })
  return webApiFetch<MergeOutcome>('/api/merge/rebase', {
    method: 'POST',
    body: JSON.stringify({ repo, envId }),
  })
}

export async function mergeForceCleanup(
  repo: string,
  envId: string,
): Promise<MergeForceCleanupResult> {
  if (isTauriEnv()) return invoke<MergeForceCleanupResult>('merge_force_cleanup', { repo, envId })
  return webApiFetch<MergeForceCleanupResult>('/api/merge/force_cleanup', {
    method: 'POST',
    body: JSON.stringify({ repo, envId }),
  })
}

export async function detectProjectStack(repo: string): Promise<StackDetection> {
  if (isTauriEnv()) return invoke<StackDetection>('detect_project_stack', { repo })
  return webApiFetch<StackDetection>(`/api/git/detect_stack?repo=${encodeURIComponent(repo)}`)
}

export async function contractCheck(envPath: string): Promise<ContractWarning[]> {
  if (isTauriEnv()) return invoke<ContractWarning[]>('contract_check', { envPath })
  return webApiFetch<ContractWarning[]>(
    `/api/git/contract_check?envPath=${encodeURIComponent(envPath)}`,
  )
}

export async function healthProbe(
  envPath: string,
  startCommand: string,
  path: string,
  timeoutMs: number,
): Promise<HealthProbeResult> {
  if (isTauriEnv())
    return invoke<HealthProbeResult>('health_probe', { envPath, startCommand, path, timeoutMs })
  return webApiFetch<HealthProbeResult>('/api/git/health_probe', {
    method: 'POST',
    body: JSON.stringify({ envPath, startCommand, path, timeoutMs }),
  })
}
