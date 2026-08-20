import { createEmptyFixtureProject } from '../support/fixtureProject'
import { completeOnboarding } from '../support/onboardingFlow'
import { suppressWindowFocusTax } from '../support/perf'
import { recordStep } from '../support/report'
import { captureScreenshot, markScreenshotAndClick } from '../support/screenshot'

/**
 * Testa o fluxo de onboarding (criação do primeiro perfil) INTERAGINDO DE
 * VERDADE com a UI — digitando no campo de nome, clicando nos botões de
 * idioma e "Próximo"/"Finish setup" via seletores reais do WebDriver — ao
 * invés de contornar via `window.__ALETHE_E2E__` (que só chama ações do
 * store direto, sem provar que a TELA em si funciona).
 *
 * Motivo de existir como spec separada: o dono observou ao vivo a janela do
 * onboarding "sem nada acontecer" enquanto rodava outros specs — que só
 * inspecionavam `window`/chamavam hooks, nunca clicavam em nada da tela.
 * Este spec é o primeiro a de fato exercitar essa UI.
 */
async function readPreferences(): Promise<{
  displayName: string
  language: string
  onboardingDone: boolean
}> {
  const result = await browser.execute(() => {
    const store = (
      window as unknown as {
        __ALETHE_E2E_STORE_DEBUG__?: () => {
          displayName: string
          language: string
          onboardingDone: boolean
        }
      }
    ).__ALETHE_E2E_STORE_DEBUG__
    if (!store) throw new Error('__ALETHE_E2E_STORE_DEBUG__ não está pronto ainda')
    return store()
  })
  return result as unknown as { displayName: string; language: string; onboardingDone: boolean }
}

describe('onboarding: criação do primeiro perfil', () => {
  before(async () => {
    await suppressWindowFocusTax()
  })

  it('bloqueia avançar sem nome, aceita idioma e nome digitados, e persiste os dois de verdade', async () => {
    const nameInput = await $('#onboarding-name')
    await nameInput.waitForDisplayed({ timeout: 15_000 })

    // Passo 0 sem nome: o botão "Next" deve estar DESABILITADO — é
    // literalmente o comportamento que o dono suspeitava estar quebrado.
    const nextButtonEmpty = await $('button*=Next')
    expect(await nextButtonEmpty.isEnabled()).toBe(false)
    recordStep({
      scenario: 'onboarding',
      step: 'next-desabilitado-sem-nome',
      status: (await nextButtonEmpty.isEnabled()) === false ? 'pass' : 'fail',
    })

    const testName = `E2E Tester ${Date.now()}`
    await captureScreenshot('onboarding--step0-empty')

    // O helper compartilhado (`completeOnboarding`) faz o resto do fluxo —
    // aqui mantém as asserções PRÓPRIAS deste spec (idioma pt-BR explícito,
    // fechamento do modal), já que testar o onboarding em si é o objetivo.
    await completeOnboarding(testName)

    // `onboardingDone` é setado antes de `renameProfile`/`flushPersistence`
    // terminarem (ver `OnboardingModal.tsx`'s `finish()`) — dá pra existir uma
    // janela curta onde o store ainda não assentou. Faz polling em vez de ler
    // uma vez só: se nunca assentar dentro do timeout, É um bug real (não um
    // falso negativo de timing do teste).
    let prefs: { displayName: string; language: string; onboardingDone: boolean } | null = null
    await browser.waitUntil(
      async () => {
        prefs = await readPreferences()
        return prefs.onboardingDone && prefs.displayName === testName && prefs.language === 'pt-BR'
      },
      { timeout: 5_000, interval: 250, timeoutMsg: 'preferences nunca assentaram pós-onboarding' },
    )
    recordStep({
      scenario: 'onboarding',
      step: 'perfil-persistido',
      status: 'pass',
      detail: JSON.stringify(prefs),
    })
    expect(prefs!.onboardingDone).toBe(true)
    expect(prefs!.displayName).toBe(testName)
    expect(prefs!.language).toBe('pt-BR')
  })

  it('cria o primeiro projeto digitando a pasta (sem clicar em "Procurar") e abre um terminal', async () => {
    // `OnboardingModal.tsx`'s `finish()` abre "Novo projeto" automaticamente
    // (setTimeout 0) logo depois do onboarding fechar — é o próximo passo
    // real que o usuário vê, não algo que este teste precisa disparar.
    const nameInput = await $('input[placeholder="Ex: Site novo, Cliente X..."]')
    await nameInput.waitForDisplayed({ timeout: 15_000 })

    const fixture = createEmptyFixtureProject()
    const projectName = `e2e-project-${Date.now()}`
    try {
      await nameInput.setValue(projectName)

      // Clicar em "Procurar" abriria o seletor de pasta NATIVO do Windows —
      // fora do webview, o WebDriver não enxerga nem consegue fechar essa
      // janela (é o que travava a sessão antes). O campo ao lado aceita
      // digitação direta (`onChange` normal, não é somente leitura) — usa
      // esse caminho, nunca o botão "Procurar".
      const pathInput = await $('input[placeholder="Escolha a pasta do projeto"]')
      await pathInput.setValue(fixture.path)
      expect(await pathInput.getValue()).toBe(fixture.path)

      const createButton = await $('button*=Criar projeto e abrir terminal')
      await createButton.waitForClickable({ timeout: 5_000 })
      await markScreenshotAndClick(createButton, 'onboarding--click-criar-projeto')

      // Prova real: o projeto aparece na sidebar esquerda com o nome digitado
      // — não só que o modal fechou sem erro.
      const sidebarEntry = await $(`span[title="${projectName}"]`)
      await sidebarEntry.waitForDisplayed({ timeout: 10_000 })
      recordStep({ scenario: 'onboarding', step: 'projeto-criado-na-sidebar', status: 'pass' })

      // Modo padrão sem GitHub URL abre "Novo terminal" em seguida — escolhe
      // Shell (não depende de nenhum CLI de agente externo instalado).
      const shellCard = await $('button*=Shell')
      await shellCard.waitForClickable({ timeout: 10_000 })
      await markScreenshotAndClick(shellCard, 'onboarding--click-selecionar-shell')

      const openButton = await $('button*=Abrir Shell')
      await openButton.waitForClickable({ timeout: 5_000 })
      await markScreenshotAndClick(openButton, 'onboarding--click-abrir-shell')

      // Prova real: o modal "Novo terminal" some — o terminal foi de fato
      // aberto, não travou esperando algo que o WebDriver não consegue clicar.
      await browser.waitUntil(async () => !(await $('button*=Abrir Shell').isExisting()), {
        timeout: 15_000,
        timeoutMsg: 'modal "Novo terminal" nunca fechou depois de "Abrir Shell"',
      })

      // O modal sumir NÃO prova que o terminal embaixo realmente renderizou
      // (é o mesmo tipo de falso positivo raso que motivou toda essa suíte)
      // — `.xterm` é a classe própria do xterm.js (não hasheada pelo CSS
      // Modules do app), confirma que a instância real montou na tela.
      await captureScreenshot('onboarding--logo-apos-modal-fechar')
      const xtermSurface = await $('.xterm')
      try {
        await xtermSurface.waitForExist({ timeout: 15_000 })
      } catch (err) {
        await captureScreenshot('onboarding--FALHA-terminal-nao-renderizou')
        throw err
      }
      await captureScreenshot('onboarding--terminal-shell-renderizado')
      recordStep({
        scenario: 'onboarding',
        step: 'terminal-aberto',
        status: 'pass',
        detail: '.xterm confirmado no DOM depois do modal fechar',
      })
    } finally {
      fixture.cleanup()
    }
  })
})
