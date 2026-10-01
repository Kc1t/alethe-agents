import { quickLogin } from '../support/onboardingFlow'
import { suppressWindowFocusTax } from '../support/perf'
import { clickByText, snapshot, waitForText, waitForTextGone } from '../support/uiKit'

/**
 * Ad-hoc exploration sandbox — see header note in git history for the full convention.
 * Current exploration: verify the Settings (Preferences) modal after a UX/consistency cleanup
 * pass on Multi-Agent & Telemetry and About — no leaked Portuguese strings in English mode, no
 * leaked English in pt-BR mode, and no unstyled inline-look elements.
 *
 * Run: npx wdio run e2e/wdio.conf.ts --spec e2e/specs/_sandbox.spec.ts
 */
describe('sandbox: ad-hoc exploration', () => {
  before(async () => {
    await suppressWindowFocusTax()
    await quickLogin(`E2E Sandbox ${Date.now()}`)
  })

  it('gives OpenCode a task (worktree already isolated from the start), integrates, and confirms whether the terminal comes back', async () => {
    const fixture = createEmptyFixtureProject()
    const repoPath = fixture.path
    const projectName = `e2e-sandbox-${Date.now()}`
    try {
      // 1. Creates the project — CANCELS the "New terminal" that opens on its own (doesn't
      // complete it yet: git init + autoWorktree need to come BEFORE
      // any terminal exists, an explicit request from the owner — this way the
      // terminal is already born isolated, with no need for "Migrate terminals"
      // afterward, and no risk of uncommitted changes along the way).
      await createProjectViaUi(projectName, repoPath)
      const projectId = await findProjectId(projectName)
      await cancelAutoOpenedNewTerminalModal()

      // 2. git init via the UI — the banner really exists now, no agent has
      // run in this folder yet.
      await initGitViaUi()
      initRepoWithInitialCommit(repoPath)

      // 3. Conflict resolution agent = OpenCode, explicit FREE model,
      // autoWorktree turned on. NEVER touches Graphify MCP (explicit
      // request — it stays off, the default).
      await selectConflictAgentAndAutoWorktreeViaUi(projectId, AGENT_LABEL, 'free')

      // 4. Post-merge action = "Create new branch and keep session" (explicit
      // request from the owner — test this specific option).
      await selectMergePostActionAndSaveViaUi('relocateKeepSession')

      // Saves this path (Merge tab → "keep session" → Save) as a
      // named procedure — explicit request from the owner ("remember this
      // config"). Clicks by the <label> TEXT (which also toggles the radio,
      // native HTML default), since `procedures.json` only knows how to click by
      // visible text, not by CSS attribute selector.
      saveProcedure('abrirMergeTabEManterSessao', [
        { action: 'click', text: 'Mais ações' },
        { action: 'click', text: 'Configurações' },
        { action: 'click', text: 'Merge' },
        { action: 'click', text: 'Criar nova branch e manter sessão' },
        { action: 'click', text: 'Salvar' },
      ])

      // 5. ONLY NOW opens the terminal — with autoWorktree already saved, it's born
      // directly in an isolated worktree (no migration step at all).
      await openAgentTerminalViaUi(AGENT_LABEL)
      const terminal = await findLatestTerminal(projectId)
      const worktreeAgentId = terminal.worktreeAgentId
      if (!worktreeAgentId) {
        throw new Error(
          'terminal was not born with a worktreeAgentId — did autoWorktree not take effect?',
        )
      }
      const worktreePath = join(repoPath, '.alethe', 'worktrees', worktreeAgentId)
      const ptyId = terminal.ptyId

      await ensureAgentReady(ptyId, { timeoutMs: 60_000 })
      await snapshot('agente-pronto-na-worktree')
      recordStep({
        scenario: 'sandbox',
        step: 'terminal-nasceu-isolado',
        status: existsSync(worktreePath) ? 'pass' : 'fail',
        detail: `worktreePath=${worktreePath} pty=${ptyId}`,
      })

      // 6. Gives it a real, structured task — verifiable on disk.
      const delivered = await sendOpenCodePrompt(
        ptyId,
        "Crie um arquivo chamado ola.txt na raiz do projeto com o texto exato 'primeira sessao' (sem aspas, sem texto extra).",
        { timeoutMs: 120_000 },
      )
      recordStep({
        scenario: 'sandbox',
        step: 'prompt-entregue',
        status: delivered ? 'pass' : 'fail',
      })
      await waitForScrollbackStable(ptyId, { timeoutMs: 90_000, stableForMs: 3000 })
      await snapshot('opencode-terminou-tarefa')

      const filePath = join(worktreePath, 'ola.txt')
      const fileExisted = existsSync(filePath)
      recordStep({
        scenario: 'sandbox',
        step: 'arquivo-criado-pelo-agente',
        status: fileExisted ? 'pass' : 'fail',
        detail: fileExisted ? readFileSync(filePath, 'utf8') : 'file does not exist',
      })

      // 7. Integrates via the real UI. The worktree may have initialization
      // changes from OpenCode itself besides ola.txt — commits everything
      // via raw git first (test setup, not what's being
      // tested) to make sure "Start merge" isn't blocked.
      try {
        execFileSync('git', ['add', '-A'], { cwd: worktreePath })
        execFileSync('git', ['commit', '-m', 'e2e: trabalho do agente'], { cwd: worktreePath })
      } catch {
        // Nothing new to commit — moves on.
      }

      const mergeTab = await $('button*=Merge')
      if (await mergeTab.isExisting()) {
        await clickByText('Merge')
        await snapshot('aba-merge-reaberta')
      } else {
        await clickByText('Mais ações')
        await clickByText('Configurações')
        await clickByText('Merge')
        await snapshot('aba-merge-reaberta')
      }

      const analyzeButton = await $('button*=Analisar')
      if (await analyzeButton.isExisting()) {
        await clickByText('Analisar')
        await snapshot('merge-analisado')
      }

      const startMergeButton = await $('button*=Iniciar merge')
      if (await startMergeButton.isExisting()) {
        await clickByText('Iniciar merge')
        await snapshot('merge-iniciado')
      } else {
        recordStep({
          scenario: 'sandbox',
          step: 'botao-iniciar-merge-nao-encontrado',
          status: 'fail',
        })
      }

      // 8. Confirms via real git (outside Alethe) whether the merge actually
      // happened — never trust only what the UI reports.
      await new Promise((resolve) => setTimeout(resolve, 3000))
      let mergedContent: string | null = null
      try {
        mergedContent = execFileSync('git', ['show', 'main:ola.txt'], {
          cwd: repoPath,
          encoding: 'utf8',
        }).trim()
      } catch {
        mergedContent = null
      }
      recordStep({
        scenario: 'sandbox',
        step: 'merge-verificado-independente',
        status: mergedContent ? 'pass' : 'fail',
        detail: mergedContent ?? 'main:ola.txt does not exist — the merge did not actually happen',
      })

      // 9. The central point: confirms whether the terminal "comes back" (post-merge
      // "keep session").
      await new Promise((resolve) => setTimeout(resolve, 5000))
      await snapshot('estado-apos-merge')
      const afterMerge = await findLatestTerminal(projectId)
      recordStep({
        scenario: 'sandbox',
        step: 'terminal-apos-merge',
        status: 'pass',
        detail: JSON.stringify({
          ptyIdAntes: ptyId,
          ptyIdDepois: afterMerge.ptyId,
          worktreeAgentIdDepois: afterMerge.worktreeAgentId,
          mudouDeTerminal: afterMerge.ptyId !== ptyId,
        }),
      })
    } finally {
      fixture.cleanup()
    }
  })

  it('Settings modal renders Multi-Agent & Telemetry / About cleanly in EN and pt-BR', async () => {
    await clickByText('Menu')
    await clickByText('Preferences')
    await waitForText('Multi-Agent & Telemetry')
    await snapshot('settings-open-en')

    await clickByText('Multi-Agent & Telemetry')
    await waitForText('Scheduler & task queue')
    await snapshot('multiagent-tab-en')

    const pageSourceEn = await browser.getPageSource()
    const leakedPt = [
      'Carregando',
      'Alocado para',
      'Desinstalar',
      'Depende de',
      'Nenhum plugin',
      'Nenhuma tarefa',
    ].filter((needle) => pageSourceEn.includes(needle))

    await clickByText('About')
    await waitForText('Alethe')
    await snapshot('about-tab-en')

    await clickByText('Account')
    await waitForText('Display name')
    await clickByText('Português')
    await waitForText('Perfil')
    await snapshot('language-switched-pt-br')

    await clickByText('Multiagente e Telemetria')
    await waitForText('Agendador e fila de tarefas')
    await snapshot('multiagent-tab-pt-br')

    const pageSourcePt = await browser.getPageSource()
    const leakedEn = [
      'Loading metrics',
      'Assigned to',
      'Uninstall',
      'Depends on',
      'No plugins installed',
      'No tasks found',
      'Install plugin',
    ].filter((needle) => pageSourcePt.includes(needle))

    await clickByText('Sobre')
    await waitForText('Alethe')
    await snapshot('about-tab-pt-br')

    await clickByText('Fechar', { scopeSelector: '[role="dialog"]' })
    await waitForTextGone('Multiagente e Telemetria')

    console.log('LEAKED_PT_STRINGS_IN_EN_MODE:', JSON.stringify(leakedPt))
    console.log('LEAKED_EN_STRINGS_IN_PT_MODE:', JSON.stringify(leakedEn))
  })
})
