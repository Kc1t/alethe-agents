import { create } from 'zustand'

import { getLocale, type Locale, translate } from '../lib/i18n'
import {
  type ConflictEnv,
  gitStatus,
  killPtyTree,
  listenFileChanged,
  listenPtyExit,
  mergeAbort,
  type MergeAnalysis,
  mergeAnalyze,
  mergeFinalize,
  mergeForceCleanup,
  type MergeOutcome,
  mergePreflightAbort,
  mergePrepare,
  mergeRebaseOntoTarget,
  mergeValidate,
  readTextFile,
  unwatchFile,
  watchFile,
  worktreeCommitPending,
  worktreeFetchBranch,
  worktreeRemove,
} from '../lib/tauri'
import type { Project } from '../lib/types'
import { useProjectsStore } from './projectsStore'
import { useUiStore } from './uiStore'

/**
 * RFC-006/007/008 — orchestration of the safe merge cycle on the frontend.
 *
 * `analyze → prepare → [conflict? spawns an ephemeral agent in a VISIBLE
 * project terminal] → agent signals "done" (awaiting_review) → manual click
 * on "Validate" → manual click on "Integrate" (commit + ff) → terminal teardown`.
 *
 * The ephemeral agent is the blueprint's only autonomous exception, but it
 * stays human-visible: it runs in a normal project Terminal (the user sees
 * it and can intervene). The provider comes from `project.conflictAgentProvider` (RFC-009).
 *
 * "Done" detection is triggered by 3 cascading layers, none of them
 * reliable on its own (see `beginResolvingWatch`): a file marker
 * (`ALETHE_RESOLVED`), the agent process exiting (`pty://exit`), and a
 * cheap fallback poll (only re-reads the marker, never calls the backend).
 * No layer validates, commits, or integrates anything on its own — they
 * only stop at `awaiting_review` and wait for human confirmation. Explicit
 * user request: the old trigger called `merge_finalize` (validate+commit+
 * integrate all together) on its own as soon as any layer fired, with no
 * human confirming whether the agent's resolution made sense — confirmed
 * live as reckless. Correctness is always decided by the backend
 * (`merge_validate`/`merge_finalize`, which sweep markers + run
 * validation), identical regardless of the provider/model quality — except
 * now they only run when the user clicks.
 */
export type MergePhase =
  | 'idle'
  | 'analyzing'
  | 'preparing'
  | 'resolving'
  /** Agent signaled "done" (ALETHE_RESOLVED marker, pty exited, or the
   *  fallback poll found the marker) — but NOTHING has been checked/
   *  validated/committed yet. Explicit user request: the old automatic
   *  3-layer trigger integrated on its own with no human confirming
   *  whether the resolution made sense (confirmed live as reckless). From
   *  here on, only a manual click on "Validate" and then "Integrate" advances the merge. */
  | 'awaiting_review'
  | 'finalizing_commit'
  | 'branch_diverged'
  | 'rebase_attempt'
  | 'merged'
  | 'failed'
  | 'terminal_error'

/** Phases in which a merge is already in progress — one integration at a
 *  time (see integrateWorktree). Exported so the UI (SidebarMergePanel) can
 *  disable other cards' actions while an integration is busy, without
 *  duplicating the list. */
export const MERGE_BUSY_PHASES: MergePhase[] = [
  'analyzing',
  'preparing',
  'resolving',
  'awaiting_review',
  'finalizing_commit',
  'branch_diverged',
  'rebase_attempt',
]

type MergeState = {
  phase: MergePhase
  projectId: string | null
  repo: string | null
  analysis: MergeAnalysis | null
  env: ConflictEnv | null
  outcome: MergeOutcome | null
  error: string | null
  /** Ephemeral terminal created for the conflict agent (for teardown/reopening). */
  agentTerminalId: string | null
  /** Source worktree ID, when the merge originated from integrateWorktree —
   *  lets the UI (SidebarMergePanel) know which card corresponds to the currently active merge. */
  worktreeAgentId: string | null
  /** Reentrancy lock: true during any finalize/retry/raw-abort call in progress. */
  isFinalizing: boolean
  /** "Manual Retry" attempts since the last success — resets on merged/idle. */
  retryCount: number
  /** Reason for git's administrative lock, when that's the cause of the `failed` phase. */
  adminLockReason: string | null

  analyze: (project: Project, repo: string, source: string, target: string) => Promise<void>
  start: (
    project: Project,
    repo: string,
    source: string,
    target: string,
    worktreeAgentId?: string,
  ) => Promise<void>
  /** Only runs the Validation Pipeline (markers + tests/build) — doesn't commit or integrate. Manual gate before `finalize`. */
  validate: () => Promise<void>
  /** Actually commits and integrates — always triggered by a manual click (Integrate), never automatically. */
  finalize: () => Promise<void>
  /** Re-runs the preventive abort on the ephemeral environment and calls finalize from the top. An administrative lock doesn't increment retryCount or become a TerminalError. */
  retry: () => Promise<void>
  abort: () => Promise<void>
  /**
   * RFC-003 Phase 3 — the worktree pane's "Integrate" button: (localCopy)
   * fetches the branch from the clone → merge cycle onto the current
   * branch → success destroys the worktree and the pane. ONE integration at a time (merge.busy).
   */
  integrateWorktree: (
    project: Project,
    repo: string,
    worktreeAgentId: string,
    paneTerminalId: string,
  ) => Promise<void>
  reset: () => void
}

/** Rules/step-by-step shared by both prompts (initial and retry) —
 *  agent-facing, so it stays outside UI i18n (its own messages, not sourced
 *  from `messages/*.ts`), but follows the app's CURRENT LANGUAGE
 *  (`getLocale()`) — explicit user request: Alethe already has two
 *  languages (en/pt-BR), so the conflict agent should speak the same
 *  language the user is currently using in the app, with an explicit
 *  instruction to that effect (the UI's language alone doesn't guarantee
 *  the model will respond in it on its own). Rewritten to be a genuine
 *  resolver, not just "read and resolve": reads EACH file in full (not
 *  just the markers) to understand the real intent on each side, and —
 *  explicit user request — asks BEFORE deciding alone when the choice
 *  between the two sides is genuinely ambiguous, instead of always
 *  resolving everything automatically. Also instructs it to create the
 *  `ALETHE_RESOLVED` marker when done: without this, completion detection
 *  never used the fastest layer (watchFile), only the 7s poll or the
 *  process dying — the agent never knew it was supposed to create that file. */
function conflictRules(locale: Locale): string {
  if (locale === 'en') {
    return (
      '## HIGH PRIORITY — never skip, no matter what\n' +
      '- Respond in English. This instruction is in English because the app is currently set to English.\n' +
      '- NEVER implement features or fix bugs unrelated to the listed conflicts. Scope is only what is in ALETHE_CONFLICT.md.\n' +
      '- NEVER commit.\n' +
      '- NEVER decide a genuinely ambiguous conflict alone (both sides changed the same thing in incompatible ways, with no obvious way to combine them) — STOP and ask the user here in the terminal how they want to proceed, explaining the conflict and the options.\n' +
      '- ALWAYS resolve ALL listed files, none left out.\n\n' +
      '## MEDIUM PRIORITY — how to resolve each file (resolution quality)\n' +
      '1. Read the WHOLE file (not just the conflict markers) to understand the real context on each side.\n' +
      '2. Understand the INTENT of each branch — what each one was actually trying to achieve, not just the literal text.\n' +
      '3. If the two changes are compatible, combine them preserving both intents (not ambiguous — resolve directly, no need to ask).\n' +
      '4. After resolving, confirm no conflict markers (<<<<<<<, =======, >>>>>>>) remain in the file.\n\n' +
      '## WHEN DONE — high priority\n' +
      '- Create an empty file named ALETHE_RESOLVED in this directory (this is the signal Alethe uses to know you finished).\n' +
      '- Announce that you are done.'
    )
  }
  return (
    '## PRIORIDADE ALTA — nunca ignore, não importa o quê\n' +
    '- Responda em português (pt-BR). Esta instrução está em português porque o app está com o idioma em português no momento.\n' +
    '- NUNCA implemente funcionalidades ou corrija bugs não relacionados aos conflitos listados. Escopo é só o que está em ALETHE_CONFLICT.md.\n' +
    '- NUNCA commite.\n' +
    '- NUNCA decida sozinho um conflito realmente ambíguo (os dois lados mudaram a mesma coisa de forma incompatível, sem um jeito óbvio de combinar) — PARE e pergunte ao usuário aqui no terminal como ele quer prosseguir, explicando o conflito e as opções.\n' +
    '- SEMPRE resolva TODOS os arquivos listados, nenhum a menos.\n\n' +
    '## PRIORIDADE MÉDIA — como resolver cada arquivo (qualidade da resolução)\n' +
    '1. Leia o arquivo INTEIRO (não só os marcadores de conflito) pra entender o contexto real de cada lado.\n' +
    '2. Entenda a INTENÇÃO de cada branch — o que cada uma estava tentando alcançar, não só o texto literal.\n' +
    '3. Se as duas mudanças forem compatíveis, combine preservando a intenção das duas (não é ambíguo — resolva direto, sem perguntar).\n' +
    '4. Depois de resolver, confirme que não sobrou nenhum marcador de conflito (<<<<<<<, =======, >>>>>>>) no arquivo.\n\n' +
    '## AO TERMINAR — prioridade alta\n' +
    '- Crie um arquivo vazio chamado ALETHE_RESOLVED neste diretório (é o sinal que o Alethe usa pra saber que você acabou).\n' +
    '- Avise que terminou.'
  )
}

/** Initial prompt for the ephemeral agent — scope locked, points to the context file. */
function conflictPrompt(locale: Locale): string {
  if (locale === 'en') {
    return (
      'Read the ALETHE_CONFLICT.md file in this directory — it lists every file in conflict.\n\n' +
      conflictRules(locale)
    )
  }
  return (
    'Leia o arquivo ALETHE_CONFLICT.md neste diretório — ele lista todos os arquivos em conflito.\n\n' +
    conflictRules(locale)
  )
}

/** Retry prompt — the new agent has no memory of the previous attempt, so the failure reason has to go into the prompt. */
function retryPrompt(failureContext: string, locale: Locale): string {
  if (locale === 'en') {
    return (
      'The previous attempt to resolve this conflict failed. Read the ALETHE_CONFLICT.md file ' +
      'in this directory again and fix the issue below.\n\n' +
      conflictRules(locale) +
      '\n\nReason the previous attempt failed:\n' +
      failureContext.slice(0, 2000)
    )
  }
  return (
    'A tentativa anterior de resolver este conflito falhou. Leia o arquivo ALETHE_CONFLICT.md ' +
    'neste diretório de novo e corrija o problema abaixo.\n\n' +
    conflictRules(locale) +
    '\n\nMotivo da falha anterior:\n' +
    failureContext.slice(0, 2000)
  )
}

/** Initial flags to open the CLI already with the right model — never the
 *  prompt here (that goes via `initialInput`, typed into the terminal after
 *  boot). OpenCode treats a loose positional argument as a FOLDER to open,
 *  not as an initial prompt — passing the conflict text via `extraArgs`
 *  made it try to `cd` into the prompt text itself concatenated to the real
 *  cwd (`Failed to change directory to <cwd>\<whole prompt>`, confirmed
 *  live). `initialInput` is the same mechanism already used by the Home
 *  quick prompt for any provider, including OpenCode — works for all four. */
function providerArgs(model?: string): string[] {
  return model ? ['--model', model] : []
}

function toast(title: string, body: string) {
  useUiStore.getState().pushToast({ title, body })
}

function t(key: Parameters<typeof translate>[1], params?: Record<string, string | number>) {
  return translate(getLocale(), key, params)
}

function adminLockReasonFrom(message: string): string | null {
  const match = message.match(/admin_locked:(.*)$/s)
  return match ? match[1] : null
}

/** Closes the old terminal (if any) and opens a new one pointing at the same cwd — there's no "resuming" a dead PTY, only recreating it (see the plan's design decision). */
function reopenAgentTerminal(
  set: (partial: Partial<MergeState>) => void,
  get: () => MergeState,
  failureContext: string,
) {
  const { projectId, agentTerminalId, env } = get()
  if (!projectId || !env) return
  const store = useProjectsStore.getState()
  const project = store.projects.find((p) => p.id === projectId)
  if (!project) return
  if (agentTerminalId) {
    store.deleteTerminal(projectId, agentTerminalId)
  }
  const provider = project.conflictAgentProvider ?? 'claude'
  const model = project.conflictAgentModel
  const terminal = store.createTerminal(projectId, {
    name: `merge ${env.id.slice(0, 6)}`,
    cwd: env.path,
    firstTab: {
      type: provider,
      cwd: env.path,
      extraArgs: providerArgs(model),
      initialInput: retryPrompt(failureContext, getLocale()),
    },
    ephemeralConflictAgent: true,
  })
  set({ agentTerminalId: terminal.id })
  beginResolvingWatch(env, terminal.id)
}

// --- Automatic "awaiting review" trigger (3 cascading layers) ---
//
// NO layer validates, commits, or integrates anything on its own — they
// only detect that the agent signaled "done" and stop, waiting for manual
// confirmation (Validate/Integrate buttons in the UI, `awaiting_review`
// phase). Explicit user request: the old trigger called merge_finalize
// (validate+commit+integrate all together) on its own as soon as any layer
// fired, with no human confirming whether the agent's resolution made
// sense — confirmed live as reckless (the agent merged incompatible
// content into a single file, without asking, and it was
// committed/integrated automatically).
//   1. watchFile on the ALETHE_RESOLVED marker (fastest, if the agent creates it).
//   2. pty://exit of the agent's terminal (process died — finished or
//      crashed; "Validate" shows which one it was, we don't decide here).
//   3. cheap periodic poll (fallback in case the OS's watchFile misses the
//      marker's creation event — only re-reads the file, never calls the backend).

const POLL_INTERVAL_MS = 7000

let activeWatch: { stop: () => void } | null = null

function stopResolvingWatch() {
  activeWatch?.stop()
  activeWatch = null
}

function beginResolvingWatch(env: ConflictEnv, agentTerminalId: string) {
  stopResolvingWatch()
  const markerPath = `${env.path.replace(/[\\/]+$/, '')}/ALETHE_RESOLVED`
  let stopped = false
  let pollTimer: ReturnType<typeof setInterval> | null = null
  let unlistenFile: (() => void) | null = null
  let unlistenExit: (() => void) | null = null

  const signal = () => {
    if (stopped) return
    activeWatch?.stop()
    if (useMergeStore.getState().phase === 'resolving') {
      useMergeStore.setState({ phase: 'awaiting_review' })
    }
  }

  void (async () => {
    try {
      await watchFile(markerPath)
      unlistenFile = await listenFileChanged((path) => {
        if (path === markerPath) signal()
      })
    } catch (err) {
      console.warn('[mergeStore] watchFile unavailable, continuing with only pty-exit/poll:', err)
    }
    try {
      unlistenExit = await listenPtyExit(agentTerminalId, () => signal())
    } catch (err) {
      console.warn('[mergeStore] listenPtyExit failed:', err)
    }
    pollTimer = setInterval(() => {
      readTextFile(markerPath)
        .then(() => signal())
        .catch(() => {
          /* marker doesn't exist yet — nothing to do, just wait for the next tick */
        })
    }, POLL_INTERVAL_MS)

    // Race: if we already left resolving while the async setup was
    // running, tear down right away instead of leaking listeners/timer.
    if (useMergeStore.getState().phase !== 'resolving' || stopped) {
      unlistenFile?.()
      unlistenExit?.()
      if (pollTimer) clearInterval(pollTimer)
      void unwatchFile(markerPath).catch(() => {})
    }
  })()

  activeWatch = {
    stop: () => {
      if (stopped) return
      stopped = true
      if (pollTimer) clearInterval(pollTimer)
      unlistenFile?.()
      unlistenExit?.()
      void unwatchFile(markerPath).catch(() => {})
    },
  }
}

export const useMergeStore = create<MergeState>((set, get) => ({
  phase: 'idle',
  projectId: null,
  repo: null,
  analysis: null,
  env: null,
  outcome: null,
  error: null,
  agentTerminalId: null,
  worktreeAgentId: null,
  isFinalizing: false,
  retryCount: 0,
  adminLockReason: null,

  analyze: async (project, repo, source, target) => {
    set({ phase: 'analyzing', projectId: project.id, repo, analysis: null, error: null })
    try {
      const analysis = await mergeAnalyze(repo, source, target, project.id)
      set({ phase: 'idle', analysis })
    } catch (err) {
      set({ phase: 'failed', error: String(err) })
    }
  },

  start: async (project, repo, source, target, worktreeAgentId) => {
    stopResolvingWatch()
    set({
      phase: 'preparing',
      projectId: project.id,
      repo,
      env: null,
      outcome: null,
      error: null,
      agentTerminalId: null,
      worktreeAgentId: worktreeAgentId ?? null,
      isFinalizing: false,
      retryCount: 0,
      adminLockReason: null,
    })
    try {
      const env = await mergePrepare(repo, source, target, project.id)
      set({ env })
      if (env.clean) {
        // No conflict: validate and integrate directly, no agent needed.
        await get().finalize()
        return
      }
      // Conflict: spawn the ephemeral agent in a visible project terminal.
      const provider = project.conflictAgentProvider ?? 'claude'
      const model = project.conflictAgentModel
      const terminal = useProjectsStore.getState().createTerminal(project.id, {
        name: `merge ${env.id.slice(0, 6)}`,
        cwd: env.path,
        firstTab: {
          type: provider,
          cwd: env.path,
          extraArgs: providerArgs(model),
          initialInput: conflictPrompt(getLocale()),
        },
        ephemeralConflictAgent: true,
      })
      set({ phase: 'resolving', agentTerminalId: terminal.id })
      beginResolvingWatch(env, terminal.id)
      toast(t('merge.conflictTitle'), t('merge.conflictBody', { count: env.conflicts.length }))
    } catch (err) {
      set({ phase: 'failed', error: String(err) })
    }
  },

  validate: async () => {
    const { repo, env, projectId, isFinalizing } = get()
    if (!repo || !env || isFinalizing) return
    set({ isFinalizing: true, outcome: null, error: null })
    try {
      const project = useProjectsStore.getState().projects.find((p) => p.id === projectId)
      const commands = project?.validationCommands ?? []
      const outcome = await mergeValidate(repo, env.id, commands)
      set({ outcome, isFinalizing: false })
      if (outcome.stage === 'validated') {
        if (outcome.validationRan) {
          toast(t('merge.validationPassedTitle'), t('merge.validationPassedBody'))
        } else {
          toast(t('merge.validationUnverifiedTitle'), t('merge.validationUnverifiedBody'))
        }
      } else {
        toast(t('merge.blockedTitle', { stage: outcome.stage }), outcome.output.slice(0, 300))
      }
    } catch (err) {
      set({ isFinalizing: false })
      toast(t('merge.blockedTitle', { stage: 'validate' }), String(err).slice(0, 300))
    }
  },

  finalize: async () => {
    const { repo, env, projectId, agentTerminalId, isFinalizing } = get()
    if (!repo || !env || isFinalizing) return

    stopResolvingWatch()
    set({ isFinalizing: true, outcome: null, error: null, phase: 'finalizing_commit' })

    // Kill the agent's process BEFORE calling the backend: if the merge
    // succeeds, `merge_finalize` (Rust) does `git worktree remove --force`
    // right away, in the SAME call — without this, the folder that's still
    // the agent process's cwd gets deleted while it's potentially still
    // alive in there (same root cause already fixed in Reject/
    // integrateWorktree: on Windows, deleting a folder with a live process
    // as its cwd fails/corrupts state — confirmed live: terminal
    // "restarted without a session" after the merge). `killPtyTree` really
    // waits for the tree to die, unlike the fire-and-forget `killPty` that `deleteTerminal` fires on its own.
    if (projectId && agentTerminalId) {
      const terminal = useProjectsStore
        .getState()
        .projects.find((p) => p.id === projectId)
        ?.terminals.find((term) => term.id === agentTerminalId)
      const ptyIds = (terminal?.tabs ?? [])
        .map((tab) => tab.ptyId)
        .filter((id): id is string => Boolean(id))
      await Promise.all(ptyIds.map((id) => killPtyTree(id).catch(() => [])))
    }

    try {
      const project = useProjectsStore.getState().projects.find((p) => p.id === projectId)
      const commands = project?.validationCommands ?? []
      const outcome = await mergeFinalize(
        repo,
        env.id,
        commands,
        project?.healthCheckCommand,
        project?.healthCheckPath,
      )

      if (outcome.merged) {
        stopResolvingWatch()
        // The ephemeral agent is DISPOSABLE by design ("spawns, resolves,
        // dies") — it never relocates to a new branch or tries to keep a
        // session (that's `mergePostAction`, an option for the REAL work
        // agent applied in `integrateWorktree`/`paneTerminalId`, not here).
        // Applying relocate to this disposable terminal already caused a
        // ghost card in the Merge Center (it got a real worktreeAgentId
        // without being a real agent worktree).
        if (projectId && agentTerminalId) {
          useProjectsStore.getState().deleteTerminal(projectId, agentTerminalId)
        }
        set({
          phase: 'merged',
          outcome,
          env: null,
          agentTerminalId: null,
          isFinalizing: false,
          retryCount: 0,
          adminLockReason: null,
        })
        toast(t('merge.mergedTitle'), outcome.output)
        // Post-merge honesty: auto-merging clean branches stays automatic
        // (deliberate decision), but it can't pretend to have checked
        // something it didn't — warns when it integrated with no
        // validation command configured.
        if (!outcome.validationRan) {
          toast(t('merge.mergedUnverifiedTitle'), t('merge.mergedUnverifiedBody'))
        }
        // Shield Layer 4 (warning, never blocked the merge above) — only
        // present if the project had `healthCheckCommand` configured.
        if (outcome.healthProbe) {
          const hp = outcome.healthProbe
          toast(
            hp.responded ? t('merge.healthProbePassedTitle') : t('merge.healthProbeFailedTitle'),
            hp.responded
              ? t('merge.healthProbePassedBody', {
                  ms: hp.elapsedMs,
                  status: String(hp.statusCode ?? '—'),
                })
              : t('merge.healthProbeFailedBody', {
                  ms: hp.elapsedMs,
                  output: hp.outputTail.slice(0, 240),
                }),
          )
        }
        // Shield Layer 3 (warning, never blocked the merge above) —
        // informs after integration, for the user's later review.
        if (outcome.contractWarnings.length > 0) {
          toast(
            t('merge.contractWarningsTitle', { count: outcome.contractWarnings.length }),
            outcome.contractWarnings
              .map((w) => `${w.call.pathPattern} (${w.call.file}:${w.call.line})`)
              .join('\n'),
          )
        }
        return
      }

      if (outcome.stage === 'nothing_to_integrate') {
        // Honest instead of faking success (real bug fixed in the backend,
        // see `conflict_resolution.rs`): the branch had no changes relative
        // to the target — nothing was committed, `main` doesn't advance.
        // It's not an error worth retrying (there's no "retry" that fixes
        // "nothing to do"), so it doesn't turn into `phase: 'failed'` — it
        // just informs and cleans up the ephemeral conflict agent (if that
        // was the case). The REAL agent's worktree/terminal
        // (`integrateWorktree` flow) stays intact — `phase` doesn't become
        // `'merged'`, so cleanup over there doesn't even run, leaving the
        // user to decide (the card stays visible for them to reject/investigate).
        stopResolvingWatch()
        if (projectId && agentTerminalId) {
          useProjectsStore.getState().deleteTerminal(projectId, agentTerminalId)
        }
        set({
          phase: 'idle',
          outcome,
          env: null,
          agentTerminalId: null,
          isFinalizing: false,
          retryCount: 0,
          adminLockReason: null,
        })
        toast(t('merge.nothingToIntegrateTitle'), t('merge.nothingToIntegrateBody'))
        return
      }

      if (outcome.stage === 'branch_diverged') {
        stopResolvingWatch()
        set({ phase: 'rebase_attempt', outcome, isFinalizing: true })
        try {
          const rebased = await mergeRebaseOntoTarget(repo, env.id)
          if (rebased.stage === 'rebase_ok') {
            set({ isFinalizing: false })
            await get().finalize()
            return
          }
          if (rebased.stage === 'rebase_conflict') {
            set({ phase: 'resolving', outcome: rebased, isFinalizing: false })
            reopenAgentTerminal(set, get, rebased.output)
            toast(t('merge.conflictTitle'), rebased.output.slice(0, 300))
            return
          }
          // rebase_failed — git execution error/full disk/etc.
          set({ phase: 'failed', outcome: rebased, error: rebased.output, isFinalizing: false })
          toast(t('merge.blockedTitle', { stage: rebased.stage }), rebased.output.slice(0, 300))
        } catch (err) {
          set({ phase: 'failed', error: String(err), isFinalizing: false })
        }
        return
      }

      const verificationFailedStages = new Set(['conflict_markers', 'unmerged'])
      if (verificationFailedStages.has(outcome.stage) || outcome.stage.startsWith('validation:')) {
        set({ phase: 'resolving', outcome, isFinalizing: false })
        reopenAgentTerminal(set, get, outcome.output)
        toast(t('merge.blockedTitle', { stage: outcome.stage }), outcome.output.slice(0, 300))
        return
      }

      // target_not_checked_out, integration (non-divergence), and any
      // other unmapped stage: a hard error recoverable via Manual Retry.
      stopResolvingWatch()
      set({ phase: 'failed', outcome, isFinalizing: false })
      toast(t('merge.blockedTitle', { stage: outcome.stage }), outcome.output.slice(0, 300))
    } catch (err) {
      const message = String(err)
      const adminLockReason = adminLockReasonFrom(message)
      stopResolvingWatch()
      set({
        phase: 'failed',
        error: message,
        isFinalizing: false,
        adminLockReason,
      })
      toast(t('merge.blockedTitle', { stage: 'finalize' }), message.slice(0, 300))
    }
  },

  retry: async () => {
    const { repo, env, isFinalizing, phase } = get()
    if (!repo || !env || isFinalizing || phase !== 'failed') return
    set({ isFinalizing: true, error: null })
    try {
      await mergePreflightAbort(repo, env.id)
    } catch (err) {
      const message = String(err)
      const adminLockReason = adminLockReasonFrom(message)
      if (adminLockReason) {
        // Administrative lock detected during the preventive abort — go
        // back to Failed with the reason, does NOT increment retryCount, does NOT become a TerminalError.
        set({ phase: 'failed', isFinalizing: false, error: message, adminLockReason })
      } else {
        // Generic error in the preventive abort = real environment corruption.
        set({ phase: 'terminal_error', isFinalizing: false, error: message })
      }
      return
    }
    set({ retryCount: get().retryCount + 1, adminLockReason: null, isFinalizing: false })
    await get().finalize()
  },

  integrateWorktree: async (project, repo, worktreeAgentId, paneTerminalId) => {
    if (MERGE_BUSY_PHASES.includes(get().phase)) {
      toast(t('merge.busyTitle'), t('merge.busy'))
      return
    }
    try {
      // git merge only moves commits — if the agent wrote files and never
      // committed, its branch has nothing new relative to the target and
      // the whole integration turns into a silent no-op (reports
      // "complete" without moving anything — real bug, confirmed live).
      // Automatically commits whatever is pending before proceeding; a no-op on an already-clean worktree.
      await worktreeCommitPending(repo, worktreeAgentId)
      // LocalCopy: the branch lives in the clone — bring it into the main repo first.
      // (In gitWorktree mode this is a no-op on the backend.)
      await worktreeFetchBranch(repo, worktreeAgentId)
      const target = (await gitStatus(repo)).branch
      const source = `alethe/agent-${worktreeAgentId}`
      await get().start(project, repo, source, target, worktreeAgentId)
      const { phase } = get()
      if (phase === 'merged') {
        // Cleanly integrated: kill the agent's process BEFORE trying to
        // remove the worktree — same root cause as the "Reject" bug
        // already fixed (on Windows, deleting a folder that's still a live
        // process's cwd fails). Really waits for the process tree to die.
        const projectAtCleanup = useProjectsStore
          .getState()
          .projects.find((p) => p.id === project.id)
        const terminal = projectAtCleanup?.terminals.find((term) => term.id === paneTerminalId)
        // The GSD Sync child session's "viewer" terminal (if it exists) is
        // a SEPARATE entity, matched only by `cwd` — killing just the main
        // pane here and leaving `deleteTerminal` (further below) to kill
        // the viewer last isn't enough: `worktreeRemove`, right after,
        // already deletes the folder from disk while the viewer's process
        // may still be alive in it (confirmed live: "ENOENT: no such file
        // or directory, lstat <worktree>" in an orphaned GSD Sync
        // terminal). Kill both together now, before any disk removal.
        const gsdViewer = projectAtCleanup?.terminals.find(
          (term) => term.gsdSyncViewer && term.cwd === terminal?.cwd,
        )
        const ptyIds = [...(terminal?.tabs ?? []), ...(gsdViewer?.tabs ?? [])]
          .map((tab) => tab.ptyId)
          .filter((id): id is string => Boolean(id))
        await Promise.all(ptyIds.map((id) => killPtyTree(id).catch(() => [])))

        try {
          await worktreeRemove(repo, worktreeAgentId, true)
        } catch (err) {
          // "worktree_not_found" = it had already been removed, harmless.
          // A real failure can never just vanish into a console.warn — it
          // becomes a tracked orphan (same safety net as abort()/Reject),
          // otherwise the folder stays stuck on disk forever, with no
          // trace in the UI — and the already-shown "Merge complete" toast
          // ends up looking like a lie to the user (real bug, confirmed
          // live: the worktree survived and nothing warned about it). Now it warns too.
          if (!String(err).includes('worktree_not_found')) {
            useProjectsStore.getState().addOrphanWorktree(project.id, {
              path: terminal?.cwd ?? '',
              mode: 'gitWorktree',
            })
            toast(t('merge.worktreeRemoveFailedTitle'), String(err).slice(0, 300))
          }
          console.warn('[mergeStore] worktree already removed?', err)
        }

        // Agent post-merge action (project config) — real bug fixed:
        // `relocateMergeAgentTerminal` already existed, ready and tested,
        // but was never called; the terminal was always closed
        // unconditionally here, ignoring the user-configured "Create a new
        // branch and keep chat active"/"...keep session" settings.
        const postAction = project.mergePostAction ?? 'closeTerminal'
        if (postAction === 'closeTerminal') {
          useProjectsStore.getState().deleteTerminal(project.id, paneTerminalId)
        } else {
          const relocated = await useProjectsStore
            .getState()
            .relocateMergeAgentTerminal(project.id, paneTerminalId, {
              keepSession: postAction === 'relocateKeepSession',
            })
          if (!relocated.ok) {
            // Doesn't leave the terminal stuck pointing at a folder that
            // was just removed — falls back to closing it as a last resort.
            toast(t('merge.relocateFailedTitle'), relocated.error ?? '')
            useProjectsStore.getState().deleteTerminal(project.id, paneTerminalId)
          }
        }
      }
      // On conflict, the normal flow continues (ephemeral agent +
      // Finalize); the original worktree/pane stay intact until the merge completes.
    } catch (err) {
      set({ phase: 'failed', error: String(err) })
      toast(t('merge.blockedTitle', { stage: 'integrate' }), String(err).slice(0, 300))
    }
  },

  abort: async () => {
    const { repo, env, projectId, agentTerminalId, phase, isFinalizing } = get()
    if (isFinalizing) {
      // Validate/Integrate (manual click) is already in progress — if the
      // click on "Abort" landed right in the middle of that call, the
      // reentrancy guard used to ignore the click with no warning at all,
      // making it look like the button simply did nothing (confirmed
      // live: it only worked on the second click, with no explanation).
      toast(t('merge.abortBusyTitle'), t('merge.abortBusy'))
      return
    }

    if (phase === 'terminal_error') {
      set({ isFinalizing: true })
      stopResolvingWatch()
      if (repo && env && projectId) {
        try {
          const result = await mergeForceCleanup(repo, env.id)
          if (result.deleted && !result.pruned) {
            useProjectsStore.getState().addOrphanWorktree(projectId, {
              path: env.path,
              mode: 'gitWorktree',
              pruneOnly: true,
              cleanAttempts: 0,
            })
          } else if (!result.deleted) {
            useProjectsStore.getState().addOrphanWorktree(projectId, {
              path: env.path,
              mode: 'gitWorktree',
              requiresRawDeletion: true,
            })
          }
          // deleted && pruned: fully cleaned up, nothing to track.
        } catch (err) {
          console.error('[mergeStore] raw cleanup failed:', err)
          useProjectsStore.getState().addOrphanWorktree(projectId, {
            path: env.path,
            mode: 'gitWorktree',
            requiresRawDeletion: true,
          })
        }
      }
      if (projectId && agentTerminalId) {
        useProjectsStore.getState().deleteTerminal(projectId, agentTerminalId)
      }
      set({
        phase: 'idle',
        env: null,
        outcome: null,
        agentTerminalId: null,
        worktreeAgentId: null,
        error: null,
        isFinalizing: false,
        retryCount: 0,
        adminLockReason: null,
      })
      return
    }

    stopResolvingWatch()
    if (repo && env) {
      try {
        await mergeAbort(repo, env.id)
      } catch (err) {
        console.error('[mergeStore] Failed to abort merge:', err)
      }
    }
    if (projectId && agentTerminalId) {
      useProjectsStore.getState().deleteTerminal(projectId, agentTerminalId)
    }
    set({
      phase: 'idle',
      env: null,
      outcome: null,
      agentTerminalId: null,
      worktreeAgentId: null,
      error: null,
      retryCount: 0,
      adminLockReason: null,
    })
  },

  reset: () => {
    stopResolvingWatch()
    set({
      phase: 'idle',
      analysis: null,
      env: null,
      outcome: null,
      error: null,
      agentTerminalId: null,
      worktreeAgentId: null,
      isFinalizing: false,
      retryCount: 0,
      adminLockReason: null,
    })
  },
}))
