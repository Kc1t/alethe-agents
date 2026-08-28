import { expect } from '@wdio/globals'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { verifyAgentSessionContinuity } from '../support/agentContinuity'
import {
  commitFileOnBranch,
  createEmptyFixtureProject,
  fileContentAtBranchHead,
  hasRealGitDir,
  initRepoWithInitialCommit,
} from '../support/fixtureProject'
import { completeOnboarding } from '../support/onboardingFlow'
import { getPtyGridSize, invokeTauri, killPty, spawnPty, waitUntil } from '../support/ptyAgent'
import { suppressWindowFocusTax } from '../support/perf'
import {
  completeAutoOpenedNewTerminalModal,
  createProjectViaUi,
  findLatestTerminal,
  findProjectId,
  initGitViaUi,
  migrateExistingTerminalsViaUi,
  selectConflictAgentAndAutoWorktreeViaUi,
  selectMergePostActionAndSaveViaUi,
} from '../support/projectUi'
import { recordStep } from '../support/report'

/**
 * Merge Center — end-to-end git pipeline, over a fixture project that
 * starts empty (not even `.git`) and is discarded at the
 * end. Uses OpenCode as the reference agent (free models, the highest
 * historical error rate on integration, confirmed by the project owner) — to
 * extend this suite to another agent, swap `AGENT_LABEL`/`AGENT_COMMAND`
 * below.
 *
 * SETUP (create project, initialize git, turn on automatic worktree, open the
 * agent terminal) is 100% real click/typing in the UI — an explicit request
 * from the owner after seeing two real bugs that hook-driven tests didn't catch:
 * (1) the folder "Browse" button opens Windows' native picker, which
 * hangs WebDriver; (2) selecting an agent by grid position/index instead
 * of by the card's text can confirm the WRONG agent with no error at all.
 * See `e2e/support/projectUi.ts` for the helpers and the full reasoning.
 *
 * THE MERGE PIPELINE (analyze/prepare/validate/finalize) still goes through
 * `invokeTauri()` directly — a DELIBERATE EXCEPTION, not an oversight: as soon as
 * `merge_prepare` detects a real conflict, the REAL Merge Center
 * (`mergeStore.ts`) spins up an ephemeral AI agent on its own to try to resolve
 * the conflict markers BEFORE "Validate"/"Integrate" become clickable
 * — going through those buttons via the UI would make the test non-deterministic and
 * slow (it depends on an LLM deciding how to resolve it), defeating the
 * original purpose of this suite (a forced, reproducible conflict, with a
 * deterministic resolution written by the test itself). `invokeTauri()` here calls the
 * SAME Rust commands the UI buttons call — it covers the same code,
 * just without depending on automatic AI resolution.
 *
 * Each step verifies the result INDEPENDENTLY of any Alethe API
 * whenever possible (a real file on disk via `fs`, raw `git log`/
 * `git show` via `child_process`) — the entire point of this suite is to not
 * repeat the mistake that motivated Part 1 of the plan: the app "saying it passed"
 * without actually having checked anything.
 */
const AGENT_LABEL = 'OpenCode'
const AGENT_COMMAND = 'opencode'
const PROFILE_ID = 'default'

describe('Merge Center: full git pipeline', function () {
  this.timeout(300_000)
  const fixture = createEmptyFixtureProject()
  const projectName = `e2e-git-pipeline-${Date.now()}`
  let repoPath: string
  let projectId: string
  let agentAWorktreePath: string
  let agentAPtyId: string
  let agentAWorktreeId: string

  before(async () => {
    await suppressWindowFocusTax()
    // Every e2e profile starts isolated and empty — without this, the rest of the spec
    // hangs waiting for the "Project name" field that never appears, because
    // onboarding is still blocking the screen (seen live in this session).
    await completeOnboarding(`E2E git-pipeline ${Date.now()}`)
  })

  after(() => {
    fixture.cleanup()
  })

  it(`creates the project via the UI and COMPLETES (doesn't cancel) the ${AGENT_LABEL} terminal that opens on its own`, async () => {
    repoPath = fixture.path
    expect(hasRealGitDir(repoPath)).toBe(false)

    // `completeOnboarding` already leaves the "New project" modal open on its own
    // (the same automatic chain from `OnboardingModal.tsx`'s `finish()`) —
    // `createProjectViaUi` reuses that screen, no need to reopen it.
    await createProjectViaUi(projectName, repoPath)
    projectId = await findProjectId(projectName)

    // Explicit request from the owner: the first terminal needs to really
    // exist (real history) BEFORE going to Settings — that's the only way
    // "Migrate existing terminals now" (later on) has something real
    // to migrate. Still without git/autoWorktree, so it's created in the
    // main folder itself (no worktreeAgentId) — exactly the state that the
    // migration needs to find afterward.
    await completeAutoOpenedNewTerminalModal(AGENT_LABEL)
    const firstTerminal = await findLatestTerminal(projectId)
    agentAPtyId = firstTerminal.ptyId
    expect(firstTerminal.worktreeAgentId).toBeFalsy()

    // The folder still has no .git — the UI creates the PROJECT, not the repository.
    expect(hasRealGitDir(repoPath)).toBe(false)
    recordStep({
      scenario: 'git-pipeline',
      step: 'projeto-criado-e-primeiro-terminal-pela-ui',
      status: 'pass',
      detail: `projectId=${projectId} repoPath=${repoPath} pty=${agentAPtyId}`,
    })
  })

  it('git init via the UI (real banner + native confirm()) correctly creates .git (verified directly on disk)', async () => {
    await initGitViaUi()
    // Node child_process, not the Alethe API — the real confirmation.
    expect(hasRealGitDir(repoPath)).toBe(true)

    // `git init` alone doesn't leave a resolvable HEAD (no commit yet) — the
    // rest of the pipeline (worktree/merge) needs a real HEAD. Running
    // `git init` again here is idempotent (git reinitializes on top of
    // what the UI already created) — it just guarantees branch=main and the author configs.
    initRepoWithInitialCommit(repoPath)
    writeFileSync(join(repoPath, 'shared.txt'), 'linha original\n')
    commitFileOnBranch(repoPath, 'main', 'shared.txt', 'linha original\n', 'add shared.txt')

    recordStep({ scenario: 'git-pipeline', step: 'git-init-pela-ui', status: 'pass' })
  })

  it('PHASE 1: selects the conflict resolution agent + turns on autoWorktree, and saves', async () => {
    await selectConflictAgentAndAutoWorktreeViaUi(projectId, AGENT_LABEL)
    recordStep({
      scenario: 'git-pipeline',
      step: 'fase1-agente-conflito-e-autoworktree',
      status: 'pass',
    })
  })

  it('PHASE 2: reopens Settings and migrates the existing terminal to an isolated worktree', async () => {
    await migrateExistingTerminalsViaUi()

    // Real verification: the SAME terminal (same ptyId) needs to have gained
    // a worktreeAgentId — not a new terminal, the same one that already had history.
    const migrated = await findLatestTerminal(projectId)
    expect(migrated.worktreeAgentId).toBeTruthy()
    agentAWorktreeId = migrated.worktreeAgentId!
    agentAWorktreePath = join(repoPath, '.alethe', 'worktrees', agentAWorktreeId)
    if (!existsSync(agentAWorktreePath)) {
      // Fallback: confirms the real path via the API in case the folder convention changes.
      const worktrees = await invokeTauri<{ path: string; agentId: string }[]>('worktree_list', {
        repo: repoPath,
      }).catch(() => [])
      const match = worktrees.find((w) => w.agentId === agentAWorktreeId)
      if (match) agentAWorktreePath = match.path
    }
    expect(existsSync(agentAWorktreePath)).toBe(true)

    // The migration suspends/restarts the PTY from scratch in the new folder (disruptive,
    // by design — no conversation continuity) — it needs a new ptyId.
    agentAPtyId = migrated.ptyId
    const alive = await waitUntil(
      async () => {
        const size = await getPtyGridSize(agentAPtyId, PROFILE_ID).catch(() => null)
        return size && size.cols > 0 ? true : null
      },
      { timeoutMs: 15_000, intervalMs: 1000 },
    )
    expect(alive).toBe(true)

    recordStep({
      scenario: 'git-pipeline',
      step: 'fase2-migrar-terminal-existente',
      status: 'pass',
      detail: `worktree=${agentAWorktreePath} pty=${agentAPtyId}`,
    })
  })

  it('PHASE 3: selects the agent post-merge action and saves', async () => {
    // "relocateToNewBranch" ("Create new branch and keep chat active") is the
    // option the owner confirmed/tested live first — the other 2 options
    // (relocateKeepSession/closeTerminal) get a separate dedicated test
    // that repeats the full cycle for each one (see the plan).
    await selectMergePostActionAndSaveViaUi('relocateToNewBranch')
    recordStep({ scenario: 'git-pipeline', step: 'fase3-acao-pos-merge', status: 'pass' })
  })

  it('1 terminal: the agent keeps real context across two prompts (creates file 2 following the rule from file 1)', async () => {
    const result = await verifyAgentSessionContinuity(agentAPtyId, agentAWorktreePath)
    recordStep({
      scenario: 'git-pipeline',
      step: 'continuidade-1-terminal',
      status: result.sessionLikelyContinuous ? 'pass' : 'fail',
      detail: JSON.stringify(result),
    })
    // If file 2 exists but doesn't follow the rule from file 1, the conclusion
    // is that it wasn't the same session — it started empty, without context from the
    // previous prompt (a criterion explicitly requested for this task).
    expect(result.file1Exists).toBe(true)
    expect(result.file2Exists).toBe(true)
    expect(result.file2FollowsRule).toBe(true)
  })

  it('generates a real git conflict (deterministic, doesn\'t depend on the agent "randomly" conflicting)', async () => {
    // Changes the SAME file on both sides — in the agent's worktree and directly
    // in main — guaranteeing a real, reproducible conflict, instead of
    // waiting for the agent to eventually run into a concurrent change.
    const agentBranch = `alethe/agent-${agentAWorktreeId}`
    writeFileSync(join(agentAWorktreePath, 'shared.txt'), 'mudança do agente A\n')
    commitFileOnBranch(
      agentAWorktreePath,
      agentBranch,
      'shared.txt',
      'mudança do agente A\n',
      'agent a: muda shared.txt',
    )
    commitFileOnBranch(
      repoPath,
      'main',
      'shared.txt',
      'mudança concorrente em main\n',
      'main: muda shared.txt concorrentemente',
    )

    const analysis = await invokeTauri<{ clean: boolean; conflicts: { path: string }[] }>(
      'merge_analyze',
      { repo: repoPath, source: agentBranch, target: 'main' },
    )
    expect(analysis.clean).toBe(false)
    expect(analysis.conflicts.some((c) => c.path === 'shared.txt')).toBe(true)

    recordStep({
      scenario: 'git-pipeline',
      step: 'conflito-real-detectado',
      status: 'pass',
      detail: JSON.stringify(analysis),
    })
  })

  it('resolves the conflict, integrates, and confirms via git log/show DIRECTLY on the repo (does not trust what the app reports)', async () => {
    const agentBranch = `alethe/agent-${agentAWorktreeId}`
    const env = await invokeTauri<{
      id: string
      path: string
      branch: string
      clean: boolean
    }>('merge_prepare', { repo: repoPath, source: agentBranch, target: 'main' })
    expect(env.clean).toBe(false)

    // "Resolves" the conflict deterministically — writes the final
    // content directly, without depending on the Merge Center's ephemeral
    // AI agent to decide how to reconcile it (the merge pipeline itself is what's
    // being tested here, not an LLM's resolution quality).
    const resolvedContent = 'linha original\nmudança do agente A + mudança concorrente em main\n'
    writeFileSync(join(env.path, 'shared.txt'), resolvedContent)

    const validated = await invokeTauri<{ stage: string; validationRan: boolean }>(
      'merge_validate',
      { repo: repoPath, envId: env.id, validationCommands: ['echo ok'] },
    )
    expect(validated.stage).toBe('validated')
    expect(validated.validationRan).toBe(true)

    const outcome = await invokeTauri<{ merged: boolean; stage: string; output: string }>(
      'merge_finalize',
      { repo: repoPath, envId: env.id, validationCommands: ['echo ok'] },
    )
    expect(outcome.merged).toBe(true)

    // The assertion that actually matters: ignores `outcome.merged` and reads
    // git directly. If the UI thought it had integrated but hadn't actually
    // integrated (the false-positive scenario that motivated this whole suite), this
    // is where it would be caught.
    const headContent = fileContentAtBranchHead(repoPath, 'main', 'shared.txt')
    const normalizedHead = headContent?.replace(/\r\n/g, '\n').trim()
    const normalizedResolved = resolvedContent.replace(/\r\n/g, '\n').trim()
    expect(normalizedHead).toBe(normalizedResolved)
    recordStep({
      scenario: 'git-pipeline',
      step: 'integracao-verificada-independente',
      status: normalizedHead === normalizedResolved ? 'pass' : 'fail',
      detail: `git show main:shared.txt confirms the integrated content (${headContent?.length ?? 0} bytes)`,
    })
  })

  it('terminal comes back up after the merge, in the now-updated project', async () => {
    await killPty(agentAPtyId, PROFILE_ID).catch(() => {})

    const newPtyId = await spawnPty({ cwd: repoPath, command: AGENT_COMMAND })
    const alive = await waitUntil(
      async () => {
        const size = await getPtyGridSize(newPtyId, PROFILE_ID).catch(() => null)
        return size && size.cols > 0 ? true : null
      },
      { timeoutMs: 15_000, intervalMs: 1000 },
    )
    expect(alive).toBe(true)

    // Same session-continuity criterion, now in a NEW session in the
    // already-updated main repo — confirms that reopening a terminal
    // after the merge leaves no broken/zombie state behind.
    const result = await verifyAgentSessionContinuity(newPtyId, repoPath)
    expect(result.file1Exists).toBe(true)
    expect(result.file2Exists).toBe(true)
    expect(result.file2FollowsRule).toBe(true)

    recordStep({
      scenario: 'git-pipeline',
      step: 'terminal-volta-apos-merge',
      status: result.sessionLikelyContinuous ? 'pass' : 'fail',
      detail: JSON.stringify(result),
    })
    await killPty(newPtyId, PROFILE_ID).catch(() => {})
  })

  it('repeats with 2 simultaneous terminals (concurrency)', async () => {
    const worktreeB = await invokeTauri<{ path: string; branch: string }>('worktree_provision', {
      repo: repoPath,
      agentId: 'b',
      mode: 'gitWorktree',
    })
    expect(existsSync(worktreeB.path)).toBe(true)

    const ptyC1 = await spawnPty({ cwd: worktreeB.path, command: AGENT_COMMAND })
    const ptyC2 = await spawnPty({ cwd: worktreeB.path, command: AGENT_COMMAND })

    for (const id of [ptyC1, ptyC2]) {
      const alive = await waitUntil(
        async () => {
          const size = await getPtyGridSize(id, PROFILE_ID).catch(() => null)
          return size && size.cols > 0 ? true : null
        },
        { timeoutMs: 15_000, intervalMs: 1000 },
      )
      expect(alive).toBe(true)
    }

    // Runs the continuity check for both sessions IN PARALLEL — it's exactly
    // the concurrency (two sessions writing/reading the PTY at the same time) that
    // can expose race conditions that a single terminal never reveals.
    const [resultC1, resultC2] = await Promise.all([
      verifyAgentSessionContinuity(ptyC1, worktreeB.path),
      verifyAgentSessionContinuity(ptyC2, worktreeB.path),
    ])

    expect(resultC1.file2FollowsRule).toBe(true)
    expect(resultC2.file2FollowsRule).toBe(true)

    recordStep({
      scenario: 'git-pipeline',
      step: 'dois-terminais-concorrentes',
      status:
        resultC1.sessionLikelyContinuous && resultC2.sessionLikelyContinuous ? 'pass' : 'fail',
      detail: JSON.stringify({ resultC1, resultC2 }),
    })

    await Promise.all([killPty(ptyC1, PROFILE_ID), killPty(ptyC2, PROFILE_ID)])
    await invokeTauri('worktree_remove', { repo: repoPath, agentId: 'b', force: true }).catch(
      () => {},
    )
  })
})
