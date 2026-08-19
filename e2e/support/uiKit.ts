/**
 * Kit genérico de navegação por clique/digitação real — pedido explícito do
 * dono pra não precisar escrever uma função nova toda vez que quiser
 * explorar/clicar em algo na UI. Regras de sempre continuam valendo:
 * NUNCA clicar em "Procurar" (dispara o seletor de pasta nativo do Windows,
 * que trava o WebDriver); todo clique tira print com marcador vermelho
 * ANTES de clicar (`markScreenshotAndClick`); nunca usar `window.__ALETHE_E2E__`
 * pra disparar ação — hooks só servem pra LER estado (ver `projectUi.ts`).
 *
 * Diferença pra `projectUi.ts`: aqueles helpers são ESPECÍFICOS de fluxos já
 * mapeados (criar projeto, git init, etc.) com seletores exatos conhecidos.
 * Este arquivo é GENÉRICO — pra clicar em qualquer coisa por texto visível,
 * sem precisar saber de antemão a estrutura exata do componente. Use
 * `projectUi.ts` quando o fluxo já tiver um helper dedicado (mais preciso,
 * já blindado contra colisões conhecidas); use este arquivo pra explorar
 * telas novas ou casos avulsos.
 */
import { markScreenshotAndClick, captureScreenshot } from './screenshot'

let shotCounter = 0
function nextShotName(label: string): string {
  shotCounter += 1
  // Texto de elemento clicado vira parte do nome do arquivo (ex.
  // `click-${text}`) — se o texto tiver "/" (comum em ids de modelo, tipo
  // "opencode/deepseek-v4-flash-free"), o `path.join` de `captureScreenshot`
  // interpreta como separador de diretório e quebra com "directory doesn't
  // exist" (bug real, confirmado ao vivo — nada a ver com o clique em si,
  // que funcionava certinho). Sanitiza qualquer caractere inseguro de nome
  // de arquivo antes de montar o nome.
  const safeLabel = label.replace(/[/\\:*?"<>|]/g, '_')
  return `uikit--${String(shotCounter).padStart(3, '0')}-${safeLabel}`
}

/**
 * Clica em QUALQUER elemento clicável (button, a, [role="button"]) cujo
 * texto visível contenha `text` — com print do marcador antes do clique.
 * Se houver mais de um match, usa o PRIMEIRO do DOM por padrão (`index`
 * ajusta isso) — prefira `scopeSelector` pra evitar ambiguidade em vez de
 * confiar no índice, especialmente em telas com rótulos repetidos (já
 * mordeu esta suíte antes: "OpenCode" aparece em mais de um lugar).
 */
export async function clickByText(
  text: string,
  opts: { index?: number; scopeSelector?: string; timeout?: number } = {},
): Promise<void> {
  const { index = 0, scopeSelector, timeout = 10_000 } = opts
  const base = scopeSelector ? await $(scopeSelector) : browser
  // WebdriverIO NÃO entende seletor múltiplo separado por vírgula do jeito
  // que CSS normal entende — precisa consultar cada estratégia separada e
  // juntar os resultados (bug real, confirmado ao vivo: um selector tipo
  // `button*=X, a*=X` virava UM xpath só, com a vírgula dentro do texto
  // procurado, e sempre falhava com "invalid selector"). Botões só-ícone
  // (ex. "Mais ações") não têm texto visível, só `aria-label`/`title`.
  // `label` entra na lista porque o gravador (`e2e/support/recorder.ts`)
  // captura texto de `<label>` (ex. legenda de checkbox) como alvo de
  // clique válido — sem isso, um passo gravado clicando num label nunca
  // encontrava nada no replay (bug real, confirmado ao vivo: "Isolamento
  // automático de agentes..." é a legenda de um checkbox, não um botão).
  const strategies = [`button*=${text}`, `a*=${text}`, `[role="button"]*=${text}`, `label*=${text}`]
  const findCandidates = async (): Promise<WebdriverIO.Element[]> => {
    let found: WebdriverIO.Element[] = []
    for (const strategy of strategies) {
      found = found.concat(await base.$$(strategy).catch(() => []))
    }
    if (found.length === 0) {
      for (const strategy of [`[aria-label*="${text}"]`, `[title*="${text}"]`]) {
        found = found.concat(await base.$$(strategy).catch(() => []))
      }
    }
    return found
  }

  // Busca UMA vez só dava falso negativo em texto que só aparece depois de
  // um check assíncrono resolver (ex. o banner "Inicializar repositório
  // Git" só renderiza depois de `gitStatus()` responder — confirmado ao
  // vivo: `clickByText` falhava na hora com "não encontrado" mesmo o botão
  // aparecendo meio segundo depois). Poll curto antes de desistir de vez.
  let candidates = await findCandidates()
  const deadline = Date.now() + timeout
  while (candidates.length <= index && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 300))
    candidates = await findCandidates()
  }
  if (!candidates[index]) {
    throw new Error(
      `clickByText: nenhum elemento clicável com texto/aria-label/title "${text}" encontrado${scopeSelector ? ` dentro de "${scopeSelector}"` : ''} (índice ${index})`,
    )
  }
  // `waitForClickable` (checagem de sobreposição do WebDriver) às vezes dá
  // falso negativo em menus renderizados via portal (`createPortal` direto
  // em `document.body`, ex. `Dropdown.tsx`) — confirmado ao vivo: o print
  // mostrava o item claramente visível e clicável, mas o check nunca
  // liberava. Tenta esperar normalmente primeiro; se estourar o timeout,
  // ainda tenta o clique de verdade (o comando `click()` do WebDriver faz
  // seu próprio scroll-into-view e costuma funcionar mesmo quando o
  // pré-check é excessivamente conservador) em vez de desistir na hora.
  await candidates[index].waitForClickable({ timeout }).catch(() => {})

  // Layout pode mudar ENTRE tentativas (ex. um banner acima do alvo some
  // depois de um check assíncrono resolver — confirmado ao vivo: clicar
  // "Inicializar repositório Git" reflowava a seção logo abaixo, e um clique
  // imediato no card seguinte mirava a posição ANTIGA, "element not
  // interactable", por ~30s de retry automático do próprio WebDriver antes
  // de desistir). RECONSULTA o elemento do zero em cada tentativa — nunca
  // reusa a referência já resolvida — pra sempre clicar na posição atual,
  // não na de quando `findCandidates()` rodou pela primeira vez.
  let lastError: unknown = null
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fresh = (await findCandidates())[index]
      if (!fresh) throw new Error(`clickByText: "${text}" sumiu da tela entre tentativas de clique`)
      await markScreenshotAndClick(fresh, nextShotName(`click-${text.slice(0, 30)}`))
      return
    } catch (err) {
      lastError = err
      await new Promise((resolve) => setTimeout(resolve, 400))
    }
  }
  throw lastError
}

/**
 * Clica o N-ésimo `<button>` (padrão: primeiro) dentro do container-pai de
 * um `<label>` achado por texto — pra botões cujo PRÓPRIO texto muda
 * dinamicamente (ex. o gatilho do `ModelSearchablePicker`, que mostra o
 * modelo atualmente selecionado como texto — gravar um clique pelo texto
 * literal desse gatilho não reproduz depois se o modelo padrão for outro).
 * O texto do `<label>` vizinho (ex. "Modelo do agente (OPENCODE)") é bem
 * mais estável entre execuções.
 */
export async function clickNearLabel(labelText: string, nth = 0): Promise<void> {
  const label = await $(`label*=${labelText}`)
  await label.waitForDisplayed({ timeout: 10_000 })
  const container = await label.$('..')
  const buttons = await container.$$('button')
  const target = buttons[nth]
  if (!target) {
    throw new Error(
      `clickNearLabel: nenhum <button> (índice ${nth}) encontrado perto do label "${labelText}"`,
    )
  }
  await markScreenshotAndClick(target, nextShotName(`click-near-label-${labelText.slice(0, 30)}`))
}

/**
 * Digita num campo achado por placeholder OU label associado — NUNCA usar
 * pra campos de pasta que tenham botão "Procurar" ao lado sem confirmar
 * antes que é seguro (esses sempre aceitam digitação direta nesta app, mas
 * confirme lendo o componente se for um campo novo/desconhecido).
 */
export async function typeIntoByPlaceholder(placeholder: string, value: string): Promise<void> {
  const input = await $(`input[placeholder="${placeholder}"], textarea[placeholder="${placeholder}"]`)
  await input.waitForDisplayed({ timeout: 10_000 })
  await input.setValue(value)
  const actual = await input.getValue()
  if (actual !== value) {
    throw new Error(
      `typeIntoByPlaceholder: campo "${placeholder}" recebeu "${actual}", esperava "${value}"`,
    )
  }
}

export async function typeIntoBySelector(selector: string, value: string): Promise<void> {
  const input = await $(selector);
  await input.waitForDisplayed({ timeout: 10_000 })
  await input.setValue(value)
}

/**
 * NUNCA clicar no botão "Procurar" ao lado de um campo de pasta — abre o
 * seletor de pasta NATIVO do Windows, fora do webview, que o WebDriver não
 * enxerga nem consegue fechar (trava a sessão). Todo campo de pasta desta
 * app aceita digitação direta no `<input>` — este é o helper CANÔNICO pra
 * isso, com nome explícito pra deixar óbvio qual caminho usar em qualquer
 * exploração nova. Por baixo é o mesmo `typeIntoByPlaceholder`, só com o
 * nome gritando a intenção.
 */
export async function typePath(placeholder: string, path: string): Promise<void> {
  await typeIntoByPlaceholder(placeholder, path)
}

/** Espera um texto aparecer em qualquer lugar da tela — útil pra confirmar
 *  que uma ação surtiu efeito sem precisar saber o seletor exato. */
export async function waitForText(text: string, timeout = 10_000): Promise<void> {
  await browser.waitUntil(async () => (await $(`*=${text}`).isExisting()), {
    timeout,
    timeoutMsg: `texto "${text}" nunca apareceu na tela`,
  })
}

/** Confirma que um texto NÃO está mais na tela — o par de `waitForText`. */
export async function waitForTextGone(text: string, timeout = 10_000): Promise<void> {
  await browser.waitUntil(async () => !(await $(`*=${text}`).isExisting()), {
    timeout,
    timeoutMsg: `texto "${text}" continuou na tela além do esperado`,
  })
}

/** Print nomeado, sem marcador — pra registrar o estado da tela num ponto
 *  qualquer da exploração, sem estar ligado a um clique específico. */
export async function snapshot(label: string): Promise<string> {
  return captureScreenshot(nextShotName(label))
}

/**
 * Arrasta o mouse de forma precisa e ajustável — pedido explícito do dono,
 * pra coisas como redimensionar um painel arrastando o divisor (a classe de
 * bug de sincronização de resize desktop↔web que motivou boa parte desta
 * sessão) ou qualquer drag real que um clique simples não cobre. Usa a W3C
 * Actions API do WebDriver (`browser.action('pointer')`), não um "drop"
 * instantâneo — o movimento é dividido em `steps` incrementos, cada um com
 * sua própria duração, porque alguns handlers de resize/drag só disparam
 * corretamente com movimento gradual (um salto único de A pra B pode não
 * emitir os eventos intermediários que o app escuta).
 *
 * `deltaX`/`deltaY` são relativos ao CENTRO do elemento em `selector`
 * (positivo = direita/baixo, negativo = esquerda/cima — mapeia direto os
 * 4 sentidos que o dono pediu). `repetitions` repete o arrasto inteiro N
 * vezes, com uma pausa entre cada (`repetitionPauseMs`) — útil pra estressar
 * um resize incremental ou confirmar que ele converge sempre pro mesmo lugar.
 */
export async function dragBy(
  selector: string,
  opts: {
    deltaX?: number
    deltaY?: number
    steps?: number
    stepDurationMs?: number
    repetitions?: number
    repetitionPauseMs?: number
  } = {},
): Promise<void> {
  const {
    deltaX = 0,
    deltaY = 0,
    steps = 5,
    stepDurationMs = 80,
    repetitions = 1,
    repetitionPauseMs = 200,
  } = opts

  for (let rep = 0; rep < repetitions; rep++) {
    const el = await $(selector)
    await el.waitForDisplayed({ timeout: 10_000 })
    const location = await el.getLocation()
    const size = await el.getSize()
    const startX = Math.round(location.x + size.width / 2)
    const startY = Math.round(location.y + size.height / 2)

    const action = browser.action('pointer', { parameters: { pointerType: 'mouse' } })
    action.move({ x: startX, y: startY }).down({ button: 0 })
    for (let step = 1; step <= steps; step++) {
      const x = Math.round(startX + (deltaX * step) / steps)
      const y = Math.round(startY + (deltaY * step) / steps)
      action.move({ duration: stepDurationMs, x, y })
    }
    action.up({ button: 0 })
    await action.perform()

    if (rep < repetitions - 1) {
      await new Promise((resolve) => setTimeout(resolve, repetitionPauseMs))
    }
  }
}

/**
 * Arrasta de um elemento até OUTRO elemento (em vez de um delta relativo) —
 * útil quando o alvo final é conhecido (ex. soltar num pane específico) em
 * vez de uma distância calculada.
 */
export async function dragFromTo(
  fromSelector: string,
  toSelector: string,
  opts: { steps?: number; stepDurationMs?: number } = {},
): Promise<void> {
  const { steps = 5, stepDurationMs = 80 } = opts
  const from = await $(fromSelector)
  const to = await $(toSelector)
  await from.waitForDisplayed({ timeout: 10_000 })
  await to.waitForDisplayed({ timeout: 10_000 })

  const fromLoc = await from.getLocation()
  const fromSize = await from.getSize()
  const toLoc = await to.getLocation()
  const toSize = await to.getSize()
  const startX = Math.round(fromLoc.x + fromSize.width / 2)
  const startY = Math.round(fromLoc.y + fromSize.height / 2)
  const endX = Math.round(toLoc.x + toSize.width / 2)
  const endY = Math.round(toLoc.y + toSize.height / 2)

  const action = browser.action('pointer', { parameters: { pointerType: 'mouse' } })
  action.move({ x: startX, y: startY }).down({ button: 0 })
  for (let step = 1; step <= steps; step++) {
    const x = Math.round(startX + ((endX - startX) * step) / steps)
    const y = Math.round(startY + ((endY - startY) * step) / steps)
    action.move({ duration: stepDurationMs, x, y })
  }
  action.up({ button: 0 })
  await action.perform()
}

/** Rola um elemento pra dentro da área visível — wrapper fino sobre o
 *  comando nativo do WebDriver, útil antes de checar/clicar algo que pode
 *  estar fora da tela (ex. opção no fim de uma lista longa, painel com
 *  scroll interno como as abas de Preferências). */
export async function scrollIntoView(selector: string): Promise<void> {
  const el = await $(selector)
  await el.waitForExist({ timeout: 10_000 })
  await el.scrollIntoView({ block: 'center', inline: 'nearest' })
}

/**
 * Rola a página (ou o elemento em `selector`, se passado) por uma
 * quantidade de pixels — via W3C wheel action (`browser.action('wheel')`),
 * que simula rolagem de mouse de verdade, diferente de setar
 * `scrollTop` direto via JS (que alguns componentes com scroll virtualizado
 * ou listeners de `wheel` não reagem a). `deltaY` positivo rola pra baixo,
 * negativo pra cima; `deltaX` positivo pra direita, negativo pra esquerda —
 * mesma convenção de eventos de wheel nativos do navegador.
 */
export async function scrollBy(
  deltaX: number,
  deltaY: number,
  opts: { selector?: string; originX?: number; originY?: number } = {},
): Promise<void> {
  let originX = opts.originX ?? Math.round((await browser.getWindowSize()).width / 2)
  let originY = opts.originY ?? Math.round((await browser.getWindowSize()).height / 2)

  if (opts.selector) {
    const el = await $(opts.selector)
    await el.waitForDisplayed({ timeout: 10_000 })
    const location = await el.getLocation()
    const size = await el.getSize()
    originX = Math.round(location.x + size.width / 2)
    originY = Math.round(location.y + size.height / 2)
  }

  await browser
    .action('wheel')
    .scroll({ x: originX, y: originY, deltaX, deltaY, duration: 200 })
    .perform()
}

/**
 * Roda `fn()` e, se ela não resolver dentro de `idleMs` (padrão 5s), tira um
 * print automático ANTES de continuar esperando — pedido explícito do dono:
 * "quando ficar 5 segundos sem interação, tirar uma print, um momento antes
 * de falhar". Não cancela `fn()` nem afeta o resultado, só captura o estado
 * da tela no momento em que algo está demorando mais que o esperado, pra
 * diagnosticar falhas sem precisar adivinhar de antemão onde colocar
 * `snapshot()` manualmente.
 */
export async function withIdleScreenshot<T>(
  label: string,
  fn: () => Promise<T>,
  idleMs = 5_000,
): Promise<T> {
  let done = false
  const timer = setTimeout(() => {
    if (!done) void snapshot(`${label}-parado-${idleMs}ms`).catch(() => {})
  }, idleMs)
  try {
    return await fn()
  } finally {
    done = true
    clearTimeout(timer)
  }
}

/**
 * Aceita um `confirm()`/`alert()` nativo se um aparecer dentro de `timeout`
 * — não falha se nenhum aparecer (alguns fluxos só mostram o diálogo às
 * vezes). Use depois de um `clickByText` que PODE disparar confirmação.
 */
export async function acceptAlertIfPresent(timeout = 3_000): Promise<boolean> {
  const appeared = await browser
    .waitUntil(async () => (await browser.getAlertText().catch(() => null)) !== null, {
      timeout,
      interval: 250,
    })
    .catch(() => false)
  if (appeared) await browser.acceptAlert()
  return appeared
}
