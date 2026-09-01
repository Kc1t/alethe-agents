/**
 * Entrega do prompt inicial pro OpenCode — extraído de `useXtermSession.ts`
 * (`sendInitialInput`) pra ser reutilizável fora do app real (ex.: a suíte
 * e2e da Central de Merges, que precisa mandar prompts de trabalho de
 * verdade pro mesmo CLI sem duplicar/reinventar essa lógica). Comportamento
 * IDÊNTICO ao original — só parametrizado (como ler a tela, como escrever,
 * como dormir, como saber se foi cancelado) pra funcionar tanto sobre o
 * buffer renderizado do xterm.js (app real) quanto sobre o scrollback bruto
 * do backend, já limpo de ANSI (e2e).
 *
 * Cada detalhe abaixo já foi confirmado AO VIVO, repetidas vezes, contra o
 * comportamento real do OpenCode — não são heurísticas teóricas:
 * - vasculhar o stream cru de bytes quebra qualquer match de string (ANSI
 *   intercalado com o texto) — por isso a fonte da verdade é a tela já
 *   renderizada/limpa, nunca os bytes crus;
 * - uma escrita única com o prompt inteiro nunca aparece na tela — precisa
 *   simular digitação de verdade, em pedaços pequenos com um respiro entre
 *   cada;
 * - a caixa de entrada só mostra o placeholder "Ask anything" quando está
 *   vazia — usado pra decidir se é seguro redigitar (nada a duplicar);
 * - um único Enter às vezes não dispara o envio sozinho — só reenvia se a
 *   tela ficar EXATAMENTE igual (nada aconteceu), nunca usa "caixa
 *   esvaziou" como critério de parada (o rodapé "esc interrupt" aparece só
 *   com texto parado na caixa, sem estar processando nada).
 */
export type OpenCodePromptDeliveryIo = {
  /** Texto da tela JÁ renderizada/limpa (sem sequências ANSI cruas). Pode
   *  ser síncrono (buffer local do xterm.js, app real) ou assíncrono
   *  (round-trip de rede até o backend, e2e) — sempre usado com `await`. */
  readScreenText: () => string | Promise<string>
  write: (data: string) => Promise<void>
  sleep: (ms: number) => Promise<void>
  isCancelled: () => boolean
}

function normalizeForMatch(text: string): string {
  // Remove TUDO que não for letra/dígito — não só espaço. A caixa de
  // entrada do OpenCode tem uma borda decorativa (barra vertical) no início
  // de cada linha desenhada; como não é espaço em branco, sobrava no meio
  // do texto lido sempre que o prompt quebrava linha, quebrando qualquer
  // comparação exata. Normalizando os dois lados (tela e prompt) do mesmo
  // jeito, borda/pontuação/quebra de linha somem e só sobra o "esqueleto"
  // de letras.
  return text.replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase()
}

const PLACEHOLDER_FINGERPRINT = normalizeForMatch('Ask anything')
const TYPE_CHUNK_SIZE = 6
const TYPE_CHUNK_DELAY_MS = 30
const CONFIRM_POLL_MS = 700
const CONFIRM_ROUND_BUDGET_MS = 8_000
const MAX_ENTER_ATTEMPTS = 4

/**
 * Digita `prompt` no OpenCode e confirma que ele foi entregue de verdade
 * (aparece na tela) antes de mandar o Enter que confirma o envio. Devolve
 * `false` se `deadline` vencer sem nunca confirmar o texto na tela — quem
 * chama decide o que fazer (o app real desiste com um warning; o e2e deve
 * tratar isso como falha real do teste, nunca como sucesso silencioso).
 */
export async function deliverOpenCodePrompt(
  prompt: string,
  deadline: number,
  io: OpenCodePromptDeliveryIo,
): Promise<boolean> {
  // Usa o FINAL do prompt como impressão digital, não o começo: o prompt é
  // longo o bastante pra ocupar a caixa de entrada inteira sozinho, e o
  // começo pode já não estar mais visível (quebra de linha própria do
  // OpenCode, ou scroll interno da caixa) na hora em que a digitação
  // termina — o final é sempre onde o cursor acabou de escrever.
  const normalizedPrompt = normalizeForMatch(prompt)
  const fingerprintStart = normalizedPrompt.slice(0, 20)
  const fingerprintEnd = normalizedPrompt.slice(-20)
  // Impressão digital do MEIO do prompt também: confirmar só start OU end
  // deixava passar um prompt cortado pela metade se um trecho do meio se
  // perdesse durante a digitação em pedaços (redraw da caixa, race de
  // escrita) — o início e o fim ainda batiam, mas o conteúdo real estava
  // truncado. O meio é o único ponto que garante que nada sumiu entre as
  // duas pontas.
  const midPoint = Math.floor(normalizedPrompt.length / 2)
  const fingerprintMid = normalizedPrompt.slice(
    Math.max(0, midPoint - 10),
    Math.max(0, midPoint - 10) + 20,
  )
  const boxLooksEmpty = async () => {
    const screenNorm = normalizeForMatch(await io.readScreenText())
    return (
      screenNorm.includes(PLACEHOLDER_FINGERPRINT) ||
      (!screenNorm.includes(fingerprintStart) && !screenNorm.includes(fingerprintEnd))
    )
  }

  const typePrompt = async () => {
    for (let index = 0; index < prompt.length; index += TYPE_CHUNK_SIZE) {
      await io.write(prompt.slice(index, index + TYPE_CHUNK_SIZE))
      await io.sleep(TYPE_CHUNK_DELAY_MS)
    }
  }

  // Cada rodada só redigita se a caixa ainda parecer vazia — testado ao
  // vivo, Ctrl+U não limpa o editor multi-linha do OpenCode, então
  // redigitar em cima de texto que já chegou (só não confirmado ainda)
  // empilha cópias duplicadas na caixa (spam visível). Mas se o OpenCode
  // simplesmente ignorou a digitação inteira (ainda não pronto pra receber
  // input), essa rodada seguinte tenta digitar de novo.
  let confirmedOnScreen = false
  let firstRound = true
  for (let round = 0; !io.isCancelled() && !confirmedOnScreen && Date.now() < deadline; round++) {
    if (firstRound || (await boxLooksEmpty())) {
      firstRound = false
      await typePrompt()
    }
    const roundDeadline = Math.min(deadline, Date.now() + CONFIRM_ROUND_BUDGET_MS)
    while (!io.isCancelled() && Date.now() < roundDeadline) {
      const screenNorm = normalizeForMatch(await io.readScreenText())
      // O fim sozinho não basta pra provar que o prompt inteiro chegou — só
      // que a digitação terminou de escrever ALGO. Exige também o meio
      // (quando existir, fingerprintMid vazio pra prompts curtos demais pra
      // ter um meio distinto) antes de considerar confirmado, pra pegar o
      // caso de truncamento no meio que passava batido antes.
      const endMatches = fingerprintEnd.length > 0 && screenNorm.includes(fingerprintEnd)
      const midMatches = fingerprintMid.length === 0 || screenNorm.includes(fingerprintMid)
      if (endMatches && midMatches) {
        confirmedOnScreen = true
        break
      }
      await io.sleep(CONFIRM_POLL_MS)
    }
  }
  if (!confirmedOnScreen) return false

  // Confirmado ao vivo: o texto chega perfeito na caixa, mas um único Enter
  // às vezes não dispara o envio sozinho. "A caixa esvaziou" não serve de
  // critério de parada aqui. Critério mais seguro: comparar a tela INTEIRA
  // antes/depois — só reenvia Enter se a tela ficar EXATAMENTE igual (nada
  // aconteceu, o Enter não registrou). Assim que a tela mudar de qualquer
  // jeito — enviou, ou o agente já começou a escrever a resposta — para na
  // hora e nunca mais reenvia.
  await io.sleep(150)
  let previousScreen = await io.readScreenText()
  for (
    let attempt = 0;
    attempt < MAX_ENTER_ATTEMPTS && !io.isCancelled() && Date.now() < deadline;
    attempt++
  ) {
    await io.write('\r')
    await io.sleep(1_500)
    const currentScreen = await io.readScreenText()
    if (currentScreen !== previousScreen) break
    previousScreen = currentScreen
  }
  return true
}
