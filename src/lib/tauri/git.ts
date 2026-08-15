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
}

                                                                             
                                                                            
                                                                         
export async function healthProbe(
  envPath: string,
  startCommand: string,
  path: string,
  timeoutMs: number,
): Promise<HealthProbeResult> {
  return invoke<HealthProbeResult>('health_probe', { envPath, startCommand, path, timeoutMs })
}
