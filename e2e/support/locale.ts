/**
 * Explicit request: tests run isolated in two language profiles — en
 * (default) or pt-BR via `ALETHE_E2E_LOCALE=pt-BR` (see the
 * `test:e2e:pt-br`/`test:e2e:git-pipeline:pt-br` scripts in package.json).
 *
 * Applied inside the `before()` of EACH spec (mocha), never in the WDIO
 * config's `before` — confirmed live that framework hooks (`@wdio/tauri-service`
 * itself, which attaches `browser.tauri`) and a config `before`
 * run in parallel via `Promise.all`, not in sequence, so calling
 * `browser.tauri.execute` from there was a race that sometimes fired
 * before `browser.tauri` existed. A spec's `before()`, on the other
 * hand, only runs after the entire session (with all framework
 * hooks) has already finished — mocha guarantees this.
 */
export const E2E_LOCALE: 'en' | 'pt-BR' = process.env.ALETHE_E2E_LOCALE === 'pt-BR' ? 'pt-BR' : 'en'

export async function applyE2eLocale(): Promise<void> {
  await browser.execute((locale) => {
    window.__ALETHE_E2E__?.setLanguage(locale as 'en' | 'pt-BR')
  }, E2E_LOCALE)
}
