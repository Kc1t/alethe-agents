import { createEmptyFixtureProject } from '../support/fixtureProject'
import { completeOnboarding } from '../support/onboardingFlow'
import { suppressWindowFocusTax } from '../support/perf'
import { recordStep } from '../support/report'
import { captureScreenshot, markScreenshotAndClick } from '../support/screenshot'

/**
 * Tests the onboarding flow (creating the first profile) by REALLY
 * interacting with the UI — typing in the name field, clicking the
 * language and "Next"/"Finish setup" buttons via real WebDriver selectors — instead
 * of bypassing it via `window.__ALETHE_E2E__` (which only calls store
 * actions directly, without proving the SCREEN itself works).
 *
 * Why it exists as a separate spec: the owner observed live the onboarding
 * window "with nothing happening" while running other specs — which only
 * inspected `window`/called hooks, never clicked anything on screen.
 * This spec is the first to actually exercise that UI.
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
    if (!store) throw new Error('__ALETHE_E2E_STORE_DEBUG__ is not ready yet')
    return store()
  })
  return result as unknown as { displayName: string; language: string; onboardingDone: boolean }
}

describe('onboarding: creating the first profile', () => {
  before(async () => {
    await suppressWindowFocusTax()
  })

  it('blocks advancing without a name, accepts typed language and name, and truly persists both', async () => {
    const nameInput = await $('#onboarding-name')
    await nameInput.waitForDisplayed({ timeout: 15_000 })

    // Step 0 with no name: the "Next" button must be DISABLED — this is
    // literally the behavior the owner suspected was broken.
    const nextButtonEmpty = await $('button*=Next')
    expect(await nextButtonEmpty.isEnabled()).toBe(false)
    recordStep({
      scenario: 'onboarding',
      step: 'next-desabilitado-sem-nome',
      status: (await nextButtonEmpty.isEnabled()) === false ? 'pass' : 'fail',
    })

    const testName = `E2E Tester ${Date.now()}`
    await captureScreenshot('onboarding--step0-empty')

    // The shared helper (`completeOnboarding`) does the rest of the flow —
    // here it keeps this spec's OWN assertions (explicit pt-BR language,
    // modal closing), since testing onboarding itself is the goal.
    await completeOnboarding(testName)

    // `onboardingDone` is set before `renameProfile`/`flushPersistence`
    // finish (see `OnboardingModal.tsx`'s `finish()`) — there can be a short
    // window where the store hasn't settled yet. Polls instead of reading
    // once: if it never settles within the timeout, that IS a real bug (not a
    // false negative from test timing).
    let prefs: { displayName: string; language: string; onboardingDone: boolean } | null = null
    await browser.waitUntil(
      async () => {
        prefs = await readPreferences()
        return prefs.onboardingDone && prefs.displayName === testName && prefs.language === 'pt-BR'
      },
      { timeout: 5_000, interval: 250, timeoutMsg: 'preferences never settled after onboarding' },
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

  it('creates the first project by typing the folder (without clicking "Browse") and opens a terminal', async () => {
    // `OnboardingModal.tsx`'s `finish()` opens "New project" automatically
    // (setTimeout 0) right after onboarding closes — it's the next real
    // step the user sees, not something this test needs to trigger.
    const nameInput = await $('input[placeholder="Ex: Site novo, Cliente X..."]')
    await nameInput.waitForDisplayed({ timeout: 15_000 })

    const fixture = createEmptyFixtureProject()
    const projectName = `e2e-project-${Date.now()}`
    try {
      await nameInput.setValue(projectName)

      // Clicking "Browse" would open Windows' NATIVE folder picker —
      // outside the webview, WebDriver can't see or close that
      // window (that's what used to hang the session). The field next to it accepts
      // direct typing (a normal `onChange`, not read-only) — use
      // that path, never the "Browse" button.
      const pathInput = await $('input[placeholder="Escolha a pasta do projeto"]')
      await pathInput.setValue(fixture.path)
      expect(await pathInput.getValue()).toBe(fixture.path)

      const createButton = await $('button*=Criar projeto e abrir terminal')
      await createButton.waitForClickable({ timeout: 5_000 })
      await markScreenshotAndClick(createButton, 'onboarding--click-criar-projeto')

      // Real proof: the project shows up in the left sidebar with the typed name
      // — not just that the modal closed without error.
      const sidebarEntry = await $(`span[title="${projectName}"]`)
      await sidebarEntry.waitForDisplayed({ timeout: 10_000 })
      recordStep({ scenario: 'onboarding', step: 'projeto-criado-na-sidebar', status: 'pass' })

      // Default mode without a GitHub URL opens "New terminal" next — picks
      // Shell (doesn't depend on any external agent CLI being installed).
      const shellCard = await $('button*=Shell')
      await shellCard.waitForClickable({ timeout: 10_000 })
      await markScreenshotAndClick(shellCard, 'onboarding--click-selecionar-shell')

      const openButton = await $('button*=Abrir Shell')
      await openButton.waitForClickable({ timeout: 5_000 })
      await markScreenshotAndClick(openButton, 'onboarding--click-abrir-shell')

      // Real proof: the "New terminal" modal disappears — the terminal was actually
      // opened, it didn't hang waiting for something WebDriver can't click.
      await browser.waitUntil(async () => !(await $('button*=Abrir Shell').isExisting()), {
        timeout: 15_000,
        timeoutMsg: '"New terminal" modal never closed after "Open Shell"',
      })

      // The modal disappearing does NOT prove the terminal underneath actually rendered
      // (it's the same kind of shallow false positive that motivated this whole suite)
      // — `.xterm` is xterm.js's own class (not hashed by the app's CSS
      // Modules), confirming the real instance mounted on screen.
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
        detail: '.xterm confirmed in the DOM after the modal closed',
      })
    } finally {
      fixture.cleanup()
    }
  })
})
