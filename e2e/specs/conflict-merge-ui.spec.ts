import { expect } from '@wdio/globals'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  commitFileOnBranch,
  createEmptyFixtureProject,
  fileContentAtBranchHead,
  hasRealGitDir,
  initRepoWithInitialCommit,
} from '../support/fixtureProject'
import { completeOnboarding } from '../support/onboardingFlow'
import { invokeTauri, waitUntil } from '../support/ptyAgent'
import { suppressWindowFocusTax } from '../support/perf'
import {
  completeAutoOpenedNewTerminalModal,
  createProjectViaUi,
  findLatestTerminal,
  findProjectId,
  initGitViaUi,
  migrateExistingTerminalsViaUi,
  selectConflictAgentAndAutoWorktreeViaUi,
} from '../support/projectUi'
import { clickByText, snapshot, waitForText, waitForTextGone } from '../support/uiKit'
import { recordStep } from '../support/report'

describe('E2E: Merge conflict and clicking Integrate in the UI', function () {
  this.timeout(300_000)
  const fixture = createEmptyFixtureProject()
  const projectName = `e2e-conflict-${Date.now()}`
  let repoPath: string
  let projectId: string
  let agentAWorktreePath: string
  let agentAWorktreeId: string

  before(async () => {
    await suppressWindowFocusTax()
    await completeOnboarding(`E2E Conflict ${Date.now()}`)
  })

  after(() => {
    fixture.cleanup()
  })

  it('sets up the project, initializes git, and creates a terminal in a worktree', async () => {
    repoPath = fixture.path
    await createProjectViaUi(projectName, repoPath)
    projectId = await findProjectId(projectName)

    await completeAutoOpenedNewTerminalModal('OpenCode')
    await initGitViaUi()

    initRepoWithInitialCommit(repoPath)
    writeFileSync(join(repoPath, 'shared.txt'), 'linha base original\n')
    commitFileOnBranch(
      repoPath,
      'main',
      'shared.txt',
      'linha base original\n',
      'initial shared.txt',
    )

    await selectConflictAgentAndAutoWorktreeViaUi(projectId, 'OpenCode')
    await migrateExistingTerminalsViaUi()

    const migrated = await findLatestTerminal(projectId)
    expect(migrated.worktreeAgentId).toBeTruthy()
    agentAWorktreeId = migrated.worktreeAgentId!
    agentAWorktreePath = join(repoPath, '.alethe', 'worktrees', agentAWorktreeId)
    expect(existsSync(agentAWorktreePath)).toBe(true)

    await snapshot('1-projeto-e-worktree-prontos')
  })

  it('creates a deterministic conflict between the agent worktree and the main branch', async () => {
    const agentBranch = `alethe/agent-${agentAWorktreeId}`
    writeFileSync(join(agentAWorktreePath, 'shared.txt'), 'mudança do agente na worktree\n')
    commitFileOnBranch(
      agentAWorktreePath,
      agentBranch,
      'shared.txt',
      'mudança do agente na worktree\n',
      'agent edit shared.txt',
    )

    commitFileOnBranch(
      repoPath,
      'main',
      'shared.txt',
      'mudança concorrente em main\n',
      'main edit shared.txt',
    )

    const analysis = await invokeTauri<{ clean: boolean; conflicts: { path: string }[] }>(
      'merge_analyze',
      { repo: repoPath, source: agentBranch, target: 'main' },
    )
    expect(analysis.clean).toBe(false)
    expect(analysis.conflicts.some((c) => c.path === 'shared.txt')).toBe(true)

    await snapshot('2-conflito-gerado')
  })

  it('clicks Integrate in the UI, detects the conflict, and opens the resolution environment', async () => {
    // Opens the Merge Center / clicks the pending worktree card
    await snapshot('3-antes-de-clicar-integrar')

    // Clicks the worktree card or the Integrate button
    await clickByText('Integrar')
    await snapshot('4-apos-clicar-integrar')

    // The mergeStore transitions preparing -> resolving and creates the ephemeral .alethe/merge-<id> worktree
    const envResolved = await waitUntil(
      async () => {
        const mergeEnvs = await invokeTauri<{ id: string; path: string }[]>('worktree_list', {
          repo: repoPath,
        }).catch(() => [])
        const match = mergeEnvs.find((w) => w.path.includes('merge-'))
        return match ?? null
      },
      { timeoutMs: 15_000, intervalMs: 1000 },
    )

    expect(envResolved).toBeTruthy()
    const mergeEnvPath = envResolved!.path
    expect(existsSync(mergeEnvPath)).toBe(true)

    // Simulates the agent resolving the conflict: removes markers and writes ALETHE_RESOLVED
    const resolvedContent = 'linha base original\nmudança do agente + mudança em main\n'
    writeFileSync(join(mergeEnvPath, 'shared.txt'), resolvedContent)
    writeFileSync(join(mergeEnvPath, 'ALETHE_RESOLVED'), '')

    // Waits for the UI to detect the marker and advance to 'Aguardando sua revisão' / 'awaiting_review'
    await waitForText('Aguardando sua revisão', 15_000).catch(() => {})
    await snapshot('5-aguardando-revisao-detectado')

    // Opens the Merge Center detail modal by clicking the card if needed
    const hasValidateBtn = await $('button=Validar')
      .isDisplayed()
      .catch(() => false)
    if (!hasValidateBtn) {
      await clickByText(projectName).catch(() => {})
    }

    await snapshot('6-modal-com-botoes-validar-integrar')

    // Clicks 'Validar' in the UI
    await clickByText('Validar')
    await snapshot('7-apos-clicar-validar')

    // Waits for validation to complete
    await waitForText('Integrar', 10_000)

    // Clicks 'Integrar' in the UI to finalize
    await clickByText('Integrar')
    await snapshot('8-apos-clicar-integrar-final')

    // Confirms whether the branch was actually integrated into main
    const headContent = fileContentAtBranchHead(repoPath, 'main', 'shared.txt')
    const normalizedHead = headContent?.replace(/\r\n/g, '\n').trim()
    const normalizedResolved = resolvedContent.replace(/\r\n/g, '\n').trim()

    expect(normalizedHead).toBe(normalizedResolved)
    await snapshot('9-sucesso-integracao-confirmada')
  })
})
