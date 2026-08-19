import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { createEmptyFixtureProject } from '../support/fixtureProject'
import { completeOnboarding } from '../support/onboardingFlow'
import { suppressWindowFocusTax } from '../support/perf'
import { cancelAutoOpenedNewTerminalModal, createProjectViaUi } from '../support/projectUi'
import { captureScreenshot } from '../support/screenshot'
import { clickByText, snapshot } from '../support/uiKit'

/**
 * Diagnóstico visual do Gráfico de Commits (`GitGraph.tsx`/`GitGraphList.tsx`)
 * — não é uma suíte de regressão com asserções, é uma ferramenta pra tirar um
 * screenshot REAL do painel sobre um repositório com topologia conhecida
 * (branch divergindo de main + merge de volta), pra diagnosticar bugs
 * visuais reportados sem depender de prints recortados pelo usuário.
 *
 * Roda FORA da suíte padrão (não está em `wdio.conf.ts`'s `specs`) — invocar
 * explícito via `--spec e2e/specs/git-graph-screenshot.spec.ts`.
 */
function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, encoding: 'utf8' })
}

describe('diagnóstico visual: gráfico de commits', function () {
  this.timeout(180_000)
  const fixture = createEmptyFixtureProject()
  const projectName = `e2e-git-graph-${Date.now()}`

  before(async () => {
    await suppressWindowFocusTax()

    // Topologia conhecida: main com 2 commits, uma branch de feature que
    // diverge entre eles e tem 2 commits próprios, mergeada de volta (merge
    // commit de verdade, --no-ff) — o mínimo pra ver raia principal + raia
    // de branch + curva de divergência + curva de merge, tudo na mesma tela.
    const repoPath = fixture.path
    git(repoPath, ['init', '--initial-branch', 'main'])
    git(repoPath, ['config', 'user.email', 'e2e@alethe.test'])
    git(repoPath, ['config', 'user.name', 'Alethe E2E'])
    writeFileSync(join(repoPath, 'main.txt'), 'main v1\n')
    git(repoPath, ['add', 'main.txt'])
    git(repoPath, ['commit', '-m', 'main: commit inicial'])

    git(repoPath, ['checkout', '-b', 'feature/graph-colors'])
    writeFileSync(join(repoPath, 'feature.txt'), 'feature v1\n')
    git(repoPath, ['add', 'feature.txt'])
    git(repoPath, ['commit', '-m', 'feature: primeiro commit'])
    writeFileSync(join(repoPath, 'feature.txt'), 'feature v2\n')
    git(repoPath, ['add', 'feature.txt'])
    git(repoPath, ['commit', '-m', 'feature: segundo commit'])

    git(repoPath, ['checkout', 'main'])
    writeFileSync(join(repoPath, 'main.txt'), 'main v2\n')
    git(repoPath, ['add', 'main.txt'])
    git(repoPath, ['commit', '-m', 'main: segundo commit'])

    git(repoPath, ['merge', '--no-ff', 'feature/graph-colors', '-m', "Merge branch 'feature/graph-colors'"])

    // Várias branches curtas (1 commit, merge imediato) em sequência — é
    // exatamente o padrão que expôs a colisão de cor `--agent-shell` ==
    // `--status-working` (raia secundária ficava com a MESMA cor da raia
    // principal, parecendo uma única linha "ziguezagueando" em vez de raias
    // distintas convergindo). Reproduz o cenário do print do dono.
    for (let i = 1; i <= 4; i++) {
      const branch = `hotfix/${i}`
      git(repoPath, ['checkout', '-b', branch])
      writeFileSync(join(repoPath, `hotfix-${i}.txt`), `hotfix ${i}\n`)
      git(repoPath, ['add', `hotfix-${i}.txt`])
      git(repoPath, ['commit', '-m', `hotfix ${i}: commit único`])
      git(repoPath, ['checkout', 'main'])
      git(repoPath, ['merge', '--no-ff', branch, '-m', `Merge branch '${branch}'`])
    }

    await completeOnboarding(`E2E git-graph ${Date.now()}`)
  })

  after(() => {
    fixture.cleanup()
  })

  // Sempre tira um print no estado em que o teste ficou quando falha —
  // sem isso, um `waitForText` que estoura o timeout não deixa nenhuma
  // prova visual de qual tela realmente ficou aberta no fim.
  afterEach(async function () {
    if (this.currentTest?.state === 'failed') {
      await snapshot('estado-na-falha').catch(() => {})
    }
  })

  it('abre o painel Gráfico de Commits e tira um screenshot real', async () => {
    await createProjectViaUi(projectName, fixture.path)
    // Sem agente nenhum aqui de propósito — só precisamos do projeto
    // apontando pro repo com histórico real, nada de terminal.
    await cancelAutoOpenedNewTerminalModal()

    // Diagnóstico ANTES do clique — se "Controle Git" não estiver clicável,
    // isso mostra exatamente que tela ficou aberta (modal ainda por cima?
    // sidebar em outra aba? layout diferente do esperado?).
    await snapshot('antes-de-abrir-controle-git')

    // `completeOnboarding` seleciona "Português" como parte do próprio
    // fluxo — o app fica em pt-BR, não no default 'en' do E2E_LOCALE (que só
    // valeria se algo chamasse `applyE2eLocale()` depois, o que não fazemos
    // aqui). Textos daqui pra frente seguem pt-BR.
    await clickByText('Controle Git')
    // SEMPRE captura o estado pós-clique, mesmo que o texto esperado nunca
    // apareça — sem isso, uma falha no waitForText não deixa nenhuma prova
    // visual de qual tela realmente ficou aberta.
    await browser.pause(800)
    await snapshot('depois-de-abrir-controle-git')

    // `waitForText` (seletor XPath `*=texto` do WebdriverIO) se mostrou
    // consistentemente flaky contra este WebView2/tauri-service — em mais de
    // uma execução ele deu timeout mesmo com "main: commit inicial" já
    // visível na tela no instante exato da falha (confirmado comparando o
    // screenshot automático de falha do `afterEach` contra o log). Como o
    // objetivo real deste spec é só CAPTURAR o estado visual pra diagnóstico
    // manual (não fazer asserção de passa/falha), uma pausa fixa generosa é
    // mais confiável aqui do que um matcher de texto que não é de confiança
    // neste ambiente — o carregamento real do `git log` + primeira
    // renderização do grafo bate perto de 20s neste binário de debug
    // isolado.
    await browser.pause(25_000)
    const path = await captureScreenshot('git-graph--diagnostico')
    console.log(`[git-graph diagnóstico] screenshot salvo em: ${path}`)
  })
})
