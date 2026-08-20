import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT_DIR = fileURLToPath(new URL('../__screenshots__', import.meta.url))

/** Salva um PNG em e2e/__screenshots__/<nome>.png e retorna o caminho salvo.
 *  Aceita uma sessão explícita (ex. a sessão web de um teste de sync com
 *  duas sessões abertas ao mesmo tempo) — sem argumento, usa a sessão
 *  global `browser` de sempre. */
export async function captureScreenshot(
  name: string,
  session: { saveScreenshot: (path: string) => Promise<unknown> } = browser,
): Promise<string> {
  mkdirSync(OUT_DIR, { recursive: true })
  const path = join(OUT_DIR, `${name}.png`)
  await session.saveScreenshot(path)
  return path
}

/**
 * Marca visualmente (ponto vermelho) o elemento que o teste está prestes a
 * clicar, tira o print, e SÓ DEPOIS clica de verdade — pedido explícito do
 * dono depois de ver um teste selecionar o card errado (Mimo em vez de
 * OpenCode) sem nenhum sinal visual de qual elemento tinha sido resolvido
 * pelo seletor. Isso prova, print a print, qual elemento o WebDriver
 * realmente encontrou — não só o que o código do teste PRETENDIA clicar.
 * O marcador é um `<div>` fixo injetado via `getBoundingClientRect()`
 * (posição real na tela, não a leitura própria do WebDriver, que pode ter
 * offset em drivers embarcados) e removido logo depois do print — não
 * sobra rastro na página nem afeta o clique em si.
 */
export async function markAndScreenshot(
  element: WebdriverIO.Element,
  name: string,
): Promise<string> {
  // NUNCA passar o elemento em si pro `execute()` — `@wdio/tauri-service`
  // troca `browser.execute` por uma versão que resolve referências de
  // elemento via `executeAsync`, sofrendo o MESMO timeout de 30s documentado
  // em `perf.ts` (o comentário lá descreve a correção, mas o código daquele
  // arquivo nunca chegou a implementá-la — confirmado ao vivo: travava sem
  // salvar nenhum print). `getLocation()`/`getSize()` são comandos W3C
  // nativos (não passam por `execute()`), e só números primitivos entram no
  // `execute()` que desenha o marcador — evita o caminho lento inteiro.
  const [location, size] = await Promise.all([element.getLocation(), element.getSize()])

  await browser.execute(
    (x, y, w, h) => {
      const dot = document.createElement('div')
      dot.id = '__e2e_click_marker__'
      dot.style.position = 'fixed'
      dot.style.left = `${x + w / 2 - 9}px`
      dot.style.top = `${y + h / 2 - 9}px`
      dot.style.width = '18px'
      dot.style.height = '18px'
      dot.style.borderRadius = '50%'
      dot.style.background = 'red'
      dot.style.border = '3px solid white'
      dot.style.boxShadow = '0 0 0 2px red'
      dot.style.zIndex = '2147483647'
      dot.style.pointerEvents = 'none'
      document.body.appendChild(dot)
    },
    location.x,
    location.y,
    size.width,
    size.height,
  )

  const path = await captureScreenshot(name)

  await browser.execute(() => {
    document.getElementById('__e2e_click_marker__')?.remove()
  })

  return path
}

/** Marca + printa + clica, nessa ordem — junta `markAndScreenshot` com o
 *  clique de verdade, pra todo clique "importante" de um spec deixar prova
 *  visual de qual elemento foi resolvido antes de agir sobre ele. */
export async function markScreenshotAndClick(
  element: WebdriverIO.Element,
  name: string,
): Promise<string> {
  const path = await markAndScreenshot(element, name)
  await element.click()
  return path
}
