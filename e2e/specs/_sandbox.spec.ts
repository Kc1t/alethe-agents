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
