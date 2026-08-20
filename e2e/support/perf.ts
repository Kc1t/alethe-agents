/**
 * Suprime a penalidade de ~5s por comando e timeouts de executeAsync do @wdio/tauri-service.
 *
 * Causa raiz confirmada por medição direta:
 * 1. `@wdio/tauri-service` roda `ensureActiveWindowFocus()` como `beforeCommand`
 *    hook ANTES de todo comando `$`/`$$`/`click`/`getTitle`/`findElement`. Essa
 *    função chama `browser.tauri.execute(...)` pra descobrir o estado das janelas,
 *    e `browser.tauri.execute()` sofre timeout de 5s no modo embedded.
 *    Chamar `browser.switchToWindow(handles[0])` aciona o `afterCommand` do service
 *    que popula o `userSwitchedWindowCache`, suprimindo a checagem cara pro resto da sessão.
 * 2. `@wdio/tauri-service` substitui `browser.execute` por `patchedExecute` que usa
 *    `executeAsync` no WebView2, sofrendo timeout de 30s. Remover a propriedade própria
 *    restaura o `execute` nativo W3C síncrono do WebdriverIO.
 */
export async function suppressWindowFocusTax(): Promise<void> {
  try {
    const handles = await browser.getWindowHandles()
    if (handles && handles.length > 0) {
      await browser.switchToWindow(handles[0])
    }
    await browser.maximizeWindow().catch(() => {})
  } catch {
    // Best-effort — se falhar, não quebra o teste.
  }
}
