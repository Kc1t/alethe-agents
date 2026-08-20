/**
 * Pedido explícito: os testes rodam isolados em dois perfis de idioma — en
 * (padrão) ou pt-BR via `ALETHE_E2E_LOCALE=pt-BR` (ver scripts
 * `test:e2e:pt-br`/`test:e2e:git-pipeline:pt-br` no package.json).
 *
 * Aplicado dentro do `before()` de CADA spec (mocha), nunca no `before` da
 * config do WDIO — confirmado ao vivo que os hooks de framework (o próprio
 * `@wdio/tauri-service`, que anexa `browser.tauri`) e um `before` de config
 * rodam em paralelo via `Promise.all`, não em sequência, então chamar
 * `browser.tauri.execute` de lá era uma corrida que às vezes disparava
 * antes de `browser.tauri` existir. O `before()` de um spec, por outro
 * lado, só roda depois que a sessão inteira (com todos os hooks de
 * framework) já terminou — mocha garante isso.
 */
export const E2E_LOCALE: 'en' | 'pt-BR' = process.env.ALETHE_E2E_LOCALE === 'pt-BR' ? 'pt-BR' : 'en'

export async function applyE2eLocale(): Promise<void> {
  await browser.execute((locale) => {
    window.__ALETHE_E2E__?.setLanguage(locale as 'en' | 'pt-BR')
  }, E2E_LOCALE)
}
