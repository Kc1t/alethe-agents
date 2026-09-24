import { invoke } from '@tauri-apps/api/core'

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

export async function gitInit(path: string): Promise<string> {
  return invoke<string>('git_init', { path })
}

export async function gitStage(repoRoot: string, paths: string[]): Promise<void> {
  return invoke('git_stage', { repoRoot, paths })
}

export async function gitDiff(repoRoot: string, path: string, staged: boolean): Promise<string> {
  return invoke<string>('git_diff', { repoRoot, path, staged })
}

export async function gitUnstage(repoRoot: string, paths: string[]): Promise<void> {
  return invoke('git_unstage', { repoRoot, paths })
}

export async function gitDiscard(
  repoRoot: string,
  paths: string[],
  untracked: boolean,
): Promise<void> {
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

export async function gitListBranches(repoRoot: string): Promise<string[]> {
  return invoke<string[]>('git_list_branches', { repoRoot })
}

export async function cloneGithubRepo(url: string, targetDir: string): Promise<string> {
  return invoke<string>('clone_github_repo', { url, targetDir })
}

export type DiffSummaryEntry = { path: string; status: string }

export async function gitDiffSummary(
  repoRoot: string,
  source: string,
  target: string,
  worktreePath?: string,
): Promise<DiffSummaryEntry[]> {
  return invoke<DiffSummaryEntry[]>('git_diff_summary', { repoRoot, source, target, worktreePath })
}

// --- RFC-003 — Worktrees ---

export type WorktreeMode = 'gitWorktree' | 'localCopy'

export type WorktreeInfo = {
  agentId: string
  path: string
  branch: string
  mode: WorktreeMode
  createdAt: number
}

export async function worktreeProvision(
  repo: string,
  agentId: string,
  mode: WorktreeMode,
): Promise<WorktreeInfo> {
  return invoke<WorktreeInfo>('worktree_provision', { repo, agentId, mode })
}

export async function worktreeList(repo: string): Promise<WorktreeInfo[]> {
  return invoke<WorktreeInfo[]>('worktree_list', { repo })
}

export async function worktreeRemove(repo: string, agentId: string, force: boolean): Promise<void> {
  await invoke('worktree_remove', { repo, agentId, force })
}

export async function worktreeCleanup(repo: string): Promise<void> {
  await invoke('worktree_cleanup', { repo })
}

export async function worktreeFetchBranch(repo: string, agentId: string): Promise<void> {
  await invoke('worktree_fetch_branch', { repo, agentId })
}

/** Trava administrativamente um worktree (`git worktree lock`) — ver `adminLockReason` em `OrphanWorktree`. */
export async function worktreeLock(repo: string, agentId: string, reason?: string): Promise<void> {
  await invoke('worktree_lock', { repo, agentId, reason })
}

export async function worktreeUnlock(repo: string, agentId: string): Promise<void> {
  await invoke('worktree_unlock', { repo, agentId })
}

export type WorktreePendingChange = { path: string; status: string }

export async function worktreeCommitPending(repo: string, agentId: string): Promise<boolean> {
  return invoke<boolean>('worktree_commit_pending', { repo, agentId })
}

export async function worktreePendingChanges(
  repo: string,
  agentId: string,
): Promise<WorktreePendingChange[]> {
  return invoke<WorktreePendingChange[]>('worktree_pending_changes', { repo, agentId })
}

export async function worktreeCommitWorktree(
  repo: string,
  agentId: string,
  message: string,
): Promise<boolean> {
  return invoke<boolean>('worktree_commit_worktree', { repo, agentId, message })
}

// --- Git graph ---

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

export async function gitLogGraph(repo: string, maxCount: number): Promise<GitCommitEntry[]> {
  return invoke<GitCommitEntry[]>('git_log_graph', { repo, maxCount })
}

export async function gitShowCommitFiles(repo: string, hash: string): Promise<GitFileChange[]> {
  return invoke<GitFileChange[]>('git_show_commit_files', { repo, hash })
}

export async function gitShowCommitMessage(repo: string, hash: string): Promise<string> {
  return invoke<string>('git_show_commit_message', { repo, hash })
}

export async function gitCreateBranchFromCommit(
  repo: string,
  hash: string,
  branchName: string,
): Promise<void> {
  await invoke('git_create_branch_from_commit', { repo, hash, branchName })
}

export async function gitCherryPickCommit(repo: string, hash: string): Promise<string> {
  return invoke<string>('git_cherry_pick_commit', { repo, hash })
}

export async function gitRevertCommit(repo: string, hash: string): Promise<string> {
  return invoke<string>('git_revert_commit', { repo, hash })
}

export async function gitResetToCommit(
  repo: string,
  hash: string,
  mode: GitResetMode,
): Promise<void> {
  await invoke('git_reset_to_commit', { repo, hash, mode })
}

export async function gitIncomingOutgoing(repo: string): Promise<IncomingOutgoing> {
  return invoke<IncomingOutgoing>('git_incoming_outgoing', { repo })
}

// --- Merge / conflict resolution ---

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
  /** `false` when the project had no `validationCommands` configured — nothing was checked. */
  validationRan: boolean
  /** Shield layer 4 (a warning, never blocking) — only present if `healthCheckCommand` was configured. */
  healthProbe: HealthProbeResult | null
}

export type MergeForceCleanupResult = { deleted: boolean; pruned: boolean }

export async function mergeAnalyze(
  repo: string,
  source: string,
  target: string,
  projectId?: string,
): Promise<MergeAnalysis> {
  return invoke<MergeAnalysis>('merge_analyze', { repo, source, target, projectId })
}

export async function mergePrepare(
  repo: string,
  source: string,
  target: string,
  projectId?: string,
): Promise<ConflictEnv> {
  return invoke<ConflictEnv>('merge_prepare', { repo, source, target, projectId })
}

export async function mergeValidate(
  repo: string,
  envId: string,
  validationCommands: string[],
): Promise<MergeOutcome> {
  return invoke<MergeOutcome>('merge_validate', { repo, envId, validationCommands })
}

export async function mergeFinalize(
  repo: string,
  envId: string,
  validationCommands: string[],
  healthCheckCommand?: string,
  healthCheckPath?: string,
): Promise<MergeOutcome> {
  return invoke<MergeOutcome>('merge_finalize', {
    repo,
    envId,
    validationCommands,
    healthCheckCommand,
    healthCheckPath,
  })
}

export async function mergeAbort(repo: string, envId: string): Promise<void> {
  await invoke('merge_abort', { repo, envId })
}

export async function mergePreflightAbort(repo: string, envId: string): Promise<void> {
  await invoke('merge_preflight_abort', { repo, envId })
}

export async function mergeRebaseOntoTarget(repo: string, envId: string): Promise<MergeOutcome> {
  return invoke<MergeOutcome>('merge_rebase_onto_target', { repo, envId })
}

export async function mergeForceCleanup(
  repo: string,
  envId: string,
): Promise<MergeForceCleanupResult> {
  return invoke<MergeForceCleanupResult>('merge_force_cleanup', { repo, envId })
}

export type ProjectStack = 'web' | 'cli' | 'desktop' | 'fullstack' | 'unknown'

export type StackDetection = {
  stack: ProjectStack
  hasFrontend: boolean
  hasBackend: boolean
  hasTauri: boolean
  suggestedCommands: string[]
}

export async function detectProjectStack(repo: string): Promise<StackDetection> {
  return invoke<StackDetection>('detect_project_stack', { repo })
}

export type ApiCallSite = {
  file: string
  line: number
  method: string | null
  pathPattern: string
}

export type ContractWarning = {
  call: ApiCallSite
  reason: string
}

export async function contractCheck(envPath: string): Promise<ContractWarning[]> {
  return invoke<ContractWarning[]>('contract_check', { envPath })
}

export type HealthProbeResult = {
  started: boolean
  responded: boolean
  statusCode: number | null
  elapsedMs: number
  outputTail: string
  terminalVerified: boolean | null
}

export async function healthProbe(
  envPath: string,
  startCommand: string,
  path: string,
  timeoutMs: number,
): Promise<HealthProbeResult> {
  return invoke<HealthProbeResult>('health_probe', { envPath, startCommand, path, timeoutMs })
}
