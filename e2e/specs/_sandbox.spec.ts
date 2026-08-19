import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { createEmptyFixtureProject, initRepoWithInitialCommit } from '../support/fixtureProject'
import { quickLogin } from '../support/onboardingFlow'
import { sendOpenCodePrompt } from '../support/openCodePrompt'
import { suppressWindowFocusTax } from '../support/perf'
import { ensureAgentReady, waitForScrollbackStable } from '../support/ptyAgent'
import {
  cancelAutoOpenedNewTerminalModal,
  createProjectViaUi,
  findLatestTerminal,
  findProjectId,
  initGitViaUi,
  openAgentTerminalViaUi,
  selectConflictAgentAndAutoWorktreeViaUi,
  selectMergePostActionAndSaveViaUi,
} from '../support/projectUi'
import { saveProcedure } from '../support/procedures'
import { recordStep } from '../support/report'
import { clickByText, snapshot } from '../support/uiKit'

/**
 * Sandbox de exploração ad-hoc — NÃO é um teste de regressão, não afirma
 * nada sobre o app estar certo ou errado. Existe pra eu (Claude) conseguir
 * navegar rapidamente por uma tela nova via clique/digitação real, sem
 * precisar escrever um helper dedicado em `projectUi.ts` toda vez que
 * quiser só OLHAR o que uma tela faz. Edite o corpo do `it()` livremente
 * pra cada exploração — não fica versionado como "o" teste de nada
 * específico, é reescrito conforme a necessidade do momento.
 *
 * Rodar: npx wdio run e2e/wdio.conf.ts --spec e2e/specs/_sandbox.spec.ts
 */
const AGENT_LABEL = 'OpenCode'
const PROFILE_ID = 'default'

describe('sandbox: exploração ad-hoc', () => {
  before(async () => {
    await suppressWindowFocusTax()
    await quickLogin(`E2E Sandbox ${Date.now()}`)
  })

  it('dá uma tarefa pro OpenCode (worktree já isolada desde o início), integra, e confirma se o terminal volta', async () => {
    const fixture = createEmptyFixtureProject()
    const repoPath = fixture.path
    const projectName = `e2e-sandbox-${Date.now()}`
    try {
      // 1. Cria o projeto — CANCELA o "Novo terminal" que abre sozinho (não
      // completa ainda: git init + autoWorktree precisam vir ANTES de
      // qualquer terminal existir, pedido explícito do dono — assim o
      // terminal já nasce isolado, sem precisar de "Migrar terminais"
      // depois, e sem risco de mudanças não commitadas no caminho).
      await createProjectViaUi(projectName, repoPath)
      const projectId = await findProjectId(projectName)
      await cancelAutoOpenedNewTerminalModal()

      // 2. git init pela UI — banner existe de verdade agora, nenhum agente
      // rodou ainda nessa pasta.
      await initGitViaUi()
      initRepoWithInitialCommit(repoPath)

      // 3. Agente de resolução de conflitos = OpenCode, modelo GRÁTIS
      // explícito, autoWorktree ligado. NUNCA toca em Graphify MCP (pedido
      // explícito — fica desligado, o padrão).
      await selectConflictAgentAndAutoWorktreeViaUi(projectId, AGENT_LABEL, 'free')

      // 4. Ação pós-merge = "Criar nova branch e manter sessão" (pedido
      // explícito do dono — testar essa opção específica).
      await selectMergePostActionAndSaveViaUi('relocateKeepSession')

      // Guarda esse caminho (aba Merge → "manter sessão" → Salvar) como
      // procedimento nomeado — pedido explícito do dono ("lembra dessa
      // config"). Clica pelo TEXTO do <label> (que também alterna o rádio,
      // padrão HTML nativo), já que `procedures.json` só sabe clicar por
      // texto visível, não por seletor CSS de atributo.
      saveProcedure('abrirMergeTabEManterSessao', [
        { action: 'click', text: 'Mais ações' },
        { action: 'click', text: 'Configurações' },
        { action: 'click', text: 'Merge' },
        { action: 'click', text: 'Criar nova branch e manter sessão' },
        { action: 'click', text: 'Salvar' },
      ])

      // 5. SÓ AGORA abre o terminal — com autoWorktree já salvo, nasce
      // direto numa worktree isolada (sem passo de migração nenhum).
      await openAgentTerminalViaUi(AGENT_LABEL)
      const terminal = await findLatestTerminal(projectId)
      const worktreeAgentId = terminal.worktreeAgentId
      if (!worktreeAgentId) {
        throw new Error('terminal não nasceu com worktreeAgentId — autoWorktree não pegou?')
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

      // 6. Dá uma tarefa real e estruturada — verificável no disco.
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
        detail: fileExisted ? readFileSync(filePath, 'utf8') : 'arquivo não existe',
      })

      // 7. Integra pela UI real. A worktree pode ter mudanças de
      // inicialização do próprio OpenCode além do ola.txt — commita tudo
      // via git cru primeiro (setup de teste, não o que está sendo
      // testado) pra garantir que "Iniciar merge" não fique bloqueado.
      try {
        execFileSync('git', ['add', '-A'], { cwd: worktreePath })
        execFileSync('git', ['commit', '-m', 'e2e: trabalho do agente'], { cwd: worktreePath })
      } catch {
        // Sem nada novo pra commitar — segue em frente.
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

      // 8. Confirma via git real (fora do Alethe) se o merge realmente
      // aconteceu — nunca confiar só no que a UI relata.
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
        detail: mergedContent ?? 'main:ola.txt não existe — merge não aconteceu de verdade',
      })

      // 9. O ponto central: confirma se o terminal "volta" (post-merge
      // "manter sessão").
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
})
