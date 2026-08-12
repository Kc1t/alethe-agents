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

/** Inicializa um repositório Git na pasta (com commit inicial) — devolve a raiz do repo. Idempotente. */
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

/** Diff real (`--name-status`, three-dot) entre `source` e `target`, unido com o estado não
 * commitado da worktree quando `worktreePath` é informado (senão trabalho ainda não commitado
 * fica invisível) — alimenta o Briefing de Testes e o Gate de Verificação da Central de Merges. */
export async function gitDiffSummary(
  repoRoot: string,
  source: string,
  target: string,
  worktreePath?: string,
): Promise<DiffSummaryEntry[]> {
  return invoke<DiffSummaryEntry[]>('git_diff_summary', { repoRoot, source, target, worktreePath })
}

/** Um commit do histórico, pro gráfico de commits do painel de Controle de
 *  versão. O cálculo de raia/coluna (lane) é sempre feito no cliente — o
 *  próprio `git log` não devolve coordenadas de gráfico prontas. */
export type GitCommitEntry = {
  hash: string
  parents: string[]
  authorName: string
  authorEmail: string
  /** Segundos desde epoch (mesmo formato do `git log`). */
  timestamp: number
  subject: string
  refs: string[]
}

export async function gitLogGraph(repo: string, maxCount: number): Promise<GitCommitEntry[]> {
  return invoke<GitCommitEntry[]>('git_log_graph', { repo, maxCount })
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

/** LocalCopy: traz o branch do clone para o repo principal antes do merge. No-op em gitWorktree. */
export async function worktreeFetchBranch(repo: string, agentId: string): Promise<void> {
  await invoke('worktree_fetch_branch', { repo, agentId })
}

/** `git merge` só move commits — commita automaticamente o que estiver pendente
 *  (staged/unstaged/untracked) nessa worktree antes de integrar, pra um agente
 *  que esqueceu de commitar não virar "merge concluído" sem mover nada.
 *  Devolve `true` se um commit novo foi criado; `false` numa worktree já limpa. */
export async function worktreeCommitPending(repo: string, agentId: string): Promise<boolean> {
  return invoke<boolean>('worktree_commit_pending', { repo, agentId })
}

export type WorktreePendingChange = {
  path: string
  status: string
}

/** Lista o que está pendente (staged/unstaged/untracked) numa worktree de
 *  agente sem mexer em nada — usado pelo pop-up de confirmação antes de
 *  integrar, pra o usuário revisar e escrever a mensagem do commit. */
export async function worktreePendingChanges(
  repo: string,
  agentId: string,
): Promise<WorktreePendingChange[]> {
  return invoke<WorktreePendingChange[]>('worktree_pending_changes', { repo, agentId })
}

/** Como `worktreeCommitPending`, mas com a mensagem escolhida pelo usuário no
 *  pop-up de confirmação em vez do texto genérico. */
export async function worktreeCommitWorktree(
  repo: string,
  agentId: string,
  message: string,
): Promise<boolean> {
  return invoke<boolean>('worktree_commit_worktree', { repo, agentId, message })
}

/** Trava administrativamente um worktree (`git worktree lock`) — ver `adminLockReason` em `OrphanWorktree`. */
export async function worktreeLock(repo: string, agentId: string, reason?: string): Promise<void> {
  await invoke('worktree_lock', { repo, agentId, reason })
}

export async function worktreeUnlock(repo: string, agentId: string): Promise<void> {
  await invoke('worktree_unlock', { repo, agentId })
}

// --- RFC-006/007/008 — Ciclo de merge seguro ---

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

export type ConflictFile = {
  path: string
  class: ConflictClass
}

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
  /** Camada 3 do Escudo (aviso, nunca bloqueia): endpoints chamados pelo
   *  frontend sem rota de backend correspondente encontrada. */
  contractWarnings: ContractWarning[]
}

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

/** Só roda a Validation Pipeline (marcadores + testes/build), sem commitar
 *  nem integrar — gate manual antes de `mergeFinalize` tocar em git de
 *  verdade. */
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
): Promise<MergeOutcome> {
  return invoke<MergeOutcome>('merge_finalize', { repo, envId, validationCommands })
}

export async function mergeAbort(repo: string, envId: string): Promise<void> {
  await invoke('merge_abort', { repo, envId })
}

/** Abort preventivo no worktree EFÊMERO antes de um retry — no-op se nada em progresso. */
export async function mergePreflightAbort(repo: string, envId: string): Promise<void> {
  await invoke('merge_preflight_abort', { repo, envId })
}

/** Reconcilia a branch efêmera (já resolvida) com a ponta atual do alvo, quando `stage === 'branch_diverged'`. */
export async function mergeRebaseOntoTarget(repo: string, envId: string): Promise<MergeOutcome> {
  return invoke<MergeOutcome>('merge_rebase_onto_target', { repo, envId })
}

export type MergeForceCleanupResult = {
  deleted: boolean
  pruned: boolean
}

/** Limpeza bruta de um ambiente de merge irrecuperável (fase `terminal_error`). */
export async function mergeForceCleanup(
  repo: string,
  envId: string,
): Promise<MergeForceCleanupResult> {
  return invoke<MergeForceCleanupResult>('merge_force_cleanup', { repo, envId })
}

// --- Bloco 2 da Central de Merges — motor multi-stack, contrato de API, probe de saúde ---

export type ProjectStack = 'web' | 'cli' | 'desktop' | 'fullstack' | 'unknown'

export type StackDetection = {
  stack: ProjectStack
  hasFrontend: boolean
  hasBackend: boolean
  hasTauri: boolean
  suggestedCommands: string[]
}

/** Heurística por arquivo-marcador (sem AST) — só pra pré-preencher sugestão
 *  de comandos de validação, nunca roda sozinha nem substitui o que o
 *  usuário já escreveu. */
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

/** Camada de AVISO (nunca bloqueia sozinha): roda no ambiente efêmero de
 *  merge_prepare, nunca no worktree do usuário. */
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

/** Sobe `startCommand` no ambiente efêmero numa porta isolada e testa `path`
 *  até responder ou estourar `timeoutMs`. Mata a árvore de processo sempre,
 *  não importa o resultado. Camada de AVISO — nunca bloqueia sozinha. */
export async function healthProbe(
  envPath: string,
  startCommand: string,
  path: string,
  timeoutMs: number,
): Promise<HealthProbeResult> {
  return invoke<HealthProbeResult>('health_probe', { envPath, startCommand, path, timeoutMs })
}
