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
 * Central de Merges — pipeline de git de ponta a ponta, sobre um
 * projeto-fixture que começa vazio (sem nem `.git`) e é jogado fora ao
 * final. Usa OpenCode como agente de referência (modelos grátis, maior taxa
 * histórica de erro na integração, confirmado pelo dono do projeto) — pra
 * estender esta suíte a outro agente, troque `AGENT_LABEL`/`AGENT_COMMAND`
 * abaixo.
 *
 * SETUP (criar projeto, inicializar git, ligar worktree automática, abrir o
 * terminal do agente) é 100% clique/digitação real na UI — pedido explícito
 * do dono depois de ver dois bugs reais que testes hook-driven não pegavam:
 * (1) o botão "Procurar" da pasta abre o seletor nativo do Windows, que
 * trava o WebDriver; (2) selecionar um agente por posição/índice do grid em
 * vez de pelo texto do card pode confirmar o agente ERRADO sem erro nenhum.
 * Ver `e2e/support/projectUi.ts` pros helpers e o raciocínio completo.
 *
 * O PIPELINE DE MERGE (analyze/prepare/validate/finalize) continua via
 * `invokeTauri()` direto — EXCEÇÃO DELIBERADA, não esquecimento: assim que
 * `merge_prepare` detecta um conflito de verdade, a Central de Merges REAL
 * (`mergeStore.ts`) sobe sozinha um agente de IA efêmero pra tentar resolver
 * os marcadores de conflito ANTES que "Validar"/"Integrar" fiquem clicáveis
 * — passar por esses botões via UI tornaria o teste não-determinístico e
 * lento (depende de um LLM decidir como resolver), contrariando o objetivo
 * original desta suíte (conflito forçado e reproduzível, resolução
 * determinística escrita pelo próprio teste). `invokeTauri()` aqui chama os
 * MESMOS comandos Rust que os botões da UI chamam — cobre o mesmo código,
 * só sem depender da resolução automática por IA.
 *
 * Cada passo verifica o resultado de forma INDEPENDENTE de qualquer API do
 * Alethe sempre que possível (arquivo real no disco via `fs`, `git log`/
 * `git show` crus via `child_process`) — o ponto inteiro desta suíte é não
 * repetir o erro que motivou a Parte 1 do plano: o app "dizendo que passou"
 * sem ter checado nada de verdade.
 */
const AGENT_LABEL = 'OpenCode'
const AGENT_COMMAND = 'opencode'
const PROFILE_ID = 'default'

describe('Central de Merges: pipeline de git completo', function () {
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
    // Todo profile e2e nasce isolado e vazio — sem isto, o resto do spec
    // trava esperando o campo "Nome do projeto" que nunca aparece, porque
    // o onboarding ainda está bloqueando a tela (visto ao vivo nesta sessão).
    await completeOnboarding(`E2E git-pipeline ${Date.now()}`)
  })

  after(() => {
    fixture.cleanup()
  })

  it(`cria o projeto pela UI e COMPLETA (não cancela) o terminal ${AGENT_LABEL} que abre sozinho`, async () => {
    repoPath = fixture.path
    expect(hasRealGitDir(repoPath)).toBe(false)

    // `completeOnboarding` já deixa o modal "Novo projeto" aberto sozinho
    // (a mesma cadeia automática de `OnboardingModal.tsx`'s `finish()`) —
    // `createProjectViaUi` reaproveita essa tela, sem precisar reabri-la.
    await createProjectViaUi(projectName, repoPath)
    projectId = await findProjectId(projectName)

    // Pedido explícito do dono: o primeiro terminal precisa existir de
    // verdade (histórico real) ANTES de ir pras Configurações — só assim
    // "Migrar terminais existentes agora" (mais adiante) tem algo de
    // verdade pra migrar. Ainda sem git/autoWorktree, então nasce na pasta
    // principal mesmo (sem worktreeAgentId) — exatamente o estado que a
    // migração precisa encontrar depois.
    await completeAutoOpenedNewTerminalModal(AGENT_LABEL)
    const firstTerminal = await findLatestTerminal(projectId)
    agentAPtyId = firstTerminal.ptyId
    expect(firstTerminal.worktreeAgentId).toBeFalsy()

    // A pasta ainda não tem .git — a UI cria o PROJETO, não o repositório.
    expect(hasRealGitDir(repoPath)).toBe(false)
    recordStep({
      scenario: 'git-pipeline',
      step: 'projeto-criado-e-primeiro-terminal-pela-ui',
      status: 'pass',
      detail: `projectId=${projectId} repoPath=${repoPath} pty=${agentAPtyId}`,
    })
  })

  it('git init pela UI (banner real + confirm() nativo) cria o .git corretamente (verificado direto no disco)', async () => {
    await initGitViaUi()
    // Node child_process, não a API do Alethe — a confirmação de verdade.
    expect(hasRealGitDir(repoPath)).toBe(true)

    // `git init` sozinho não deixa HEAD resolvível (sem commit ainda) — o
    // resto do pipeline (worktree/merge) precisa de um HEAD real. Rodar
    // `git init` de novo aqui é idempotente (git reinicializa em cima do
    // que a UI já criou) — só garante branch=main e as configs de autor.
    initRepoWithInitialCommit(repoPath)
    writeFileSync(join(repoPath, 'shared.txt'), 'linha original\n')
    commitFileOnBranch(repoPath, 'main', 'shared.txt', 'linha original\n', 'add shared.txt')

    recordStep({ scenario: 'git-pipeline', step: 'git-init-pela-ui', status: 'pass' })
  })

  it('FASE 1: seleciona o agente de resolução de conflitos + liga autoWorktree, e salva', async () => {
    await selectConflictAgentAndAutoWorktreeViaUi(projectId, AGENT_LABEL)
    recordStep({ scenario: 'git-pipeline', step: 'fase1-agente-conflito-e-autoworktree', status: 'pass' })
  })

  it('FASE 2: reabre Configurações e migra o terminal existente pra uma worktree isolada', async () => {
    await migrateExistingTerminalsViaUi()

    // Verificação real: o MESMO terminal (ptyId igual) precisa ter ganhado
    // worktreeAgentId — não um terminal novo, o mesmo que já tinha histórico.
    const migrated = await findLatestTerminal(projectId)
    expect(migrated.worktreeAgentId).toBeTruthy()
    agentAWorktreeId = migrated.worktreeAgentId!
    agentAWorktreePath = join(repoPath, '.alethe', 'worktrees', agentAWorktreeId)
    if (!existsSync(agentAWorktreePath)) {
      // Fallback: confirma o path real via API caso a convenção de pasta mude.
      const worktrees = await invokeTauri<{ path: string; agentId: string }[]>(
        'worktree_list',
        { repo: repoPath },
      ).catch(() => [])
      const match = worktrees.find((w) => w.agentId === agentAWorktreeId)
      if (match) agentAWorktreePath = match.path
    }
    expect(existsSync(agentAWorktreePath)).toBe(true)

    // A migração suspende/reinicia o PTY do zero na pasta nova (disruptivo,
    // por design — sem continuidade de conversa) — precisa de um novo ptyId.
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

  it('FASE 3: seleciona a ação pós-merge do agente e salva', async () => {
    // "relocateToNewBranch" ("Criar nova branch e manter chat ativo") é a
    // opção que o dono confirmou/testou ao vivo primeiro — as outras 2
    // (relocateKeepSession/closeTerminal) entram num teste dedicado separado
    // que repete o ciclo completo pra cada uma (ver plano).
    await selectMergePostActionAndSaveViaUi('relocateToNewBranch')
    recordStep({ scenario: 'git-pipeline', step: 'fase3-acao-pos-merge', status: 'pass' })
  })

  it('1 terminal: o agente mantém contexto real entre dois prompts (cria arquivo 2 seguindo a regra do arquivo 1)', async () => {
    const result = await verifyAgentSessionContinuity(agentAPtyId, agentAWorktreePath)
    recordStep({
      scenario: 'git-pipeline',
      step: 'continuidade-1-terminal',
      status: result.sessionLikelyContinuous ? 'pass' : 'fail',
      detail: JSON.stringify(result),
    })
    // Se o arquivo 2 existe mas não segue a regra do arquivo 1, a conclusão
    // é que não era a mesma sessão — nasceu vazia, sem contexto do prompt
    // anterior (critério pedido explicitamente nesta tarefa).
    expect(result.file1Exists).toBe(true)
    expect(result.file2Exists).toBe(true)
    expect(result.file2FollowsRule).toBe(true)
  })

  it('gera um conflito real de git (determinístico, não depende do agente "por acaso" conflitar)', async () => {
    // Muda o MESMO arquivo nos dois lados — no worktree do agente e direto
    // em main — garantindo conflito real e reproduzível, ao invés de
    // esperar o agente eventualmente esbarrar numa mudança concorrente.
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

  it('resolve o conflito, integra, e confirma via git log/show DIRETO no repo (não confia no que o app relata)', async () => {
    const agentBranch = `alethe/agent-${agentAWorktreeId}`
    const env = await invokeTauri<{
      id: string
      path: string
      branch: string
      clean: boolean
    }>('merge_prepare', { repo: repoPath, source: agentBranch, target: 'main' })
    expect(env.clean).toBe(false)

    // "Resolve" o conflito de forma determinística — escreve o conteúdo
    // final direto, sem depender do agente-de-IA-efêmero da Central de
    // Merges decidir como reconciliar (o pipeline de merge em si é o que
    // está sendo testado aqui, não a qualidade de resolução de um LLM).
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

    // A asserção que importa de verdade: ignora `outcome.merged` e vai ler o
    // git de verdade. Se a UI achasse que integrou mas não tivesse integrado
    // (o cenário de falso positivo que motivou toda essa suíte), é AQUI que
    // isso seria pego.
    const headContent = fileContentAtBranchHead(repoPath, 'main', 'shared.txt')
    const normalizedHead = headContent?.replace(/\r\n/g, '\n').trim()
    const normalizedResolved = resolvedContent.replace(/\r\n/g, '\n').trim()
    expect(normalizedHead).toBe(normalizedResolved)
    recordStep({
      scenario: 'git-pipeline',
      step: 'integracao-verificada-independente',
      status: normalizedHead === normalizedResolved ? 'pass' : 'fail',
      detail: `git show main:shared.txt confirma o conteúdo integrado (${headContent?.length ?? 0} bytes)`,
    })
  })

  it('terminal volta a subir depois do merge, no projeto agora atualizado', async () => {
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

    // Mesmo critério de continuidade de sessão, agora numa sessão NOVA no
    // repo principal já atualizado — confirma que reabrir um terminal
    // depois do merge não deixa nenhum estado quebrado/zumbi pra trás.
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

  it('repete com 2 terminais simultâneos (concorrência)', async () => {
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

    // Roda a continuidade das duas sessões EM PARALELO — é justamente a
    // concorrência (duas sessões escrevendo/lendo PTY ao mesmo tempo) que
    // pode expor race conditions que um terminal sozinho nunca revela.
    const [resultC1, resultC2] = await Promise.all([
      verifyAgentSessionContinuity(ptyC1, worktreeB.path),
      verifyAgentSessionContinuity(ptyC2, worktreeB.path),
    ])

    expect(resultC1.file2FollowsRule).toBe(true)
    expect(resultC2.file2FollowsRule).toBe(true)

    recordStep({
      scenario: 'git-pipeline',
      step: 'dois-terminais-concorrentes',
      status: resultC1.sessionLikelyContinuous && resultC2.sessionLikelyContinuous ? 'pass' : 'fail',
      detail: JSON.stringify({ resultC1, resultC2 }),
    })

    await Promise.all([killPty(ptyC1, PROFILE_ID), killPty(ptyC2, PROFILE_ID)])
    await invokeTauri('worktree_remove', { repo: repoPath, agentId: 'b', force: true }).catch(
      () => {},
    )
  })
})
