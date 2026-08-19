/**
 * Gravação de procedimento a partir de cliques/digitação REAIS do usuário —
 * pedido explícito do dono: em vez de sempre precisar redescobrir seletores
 * manualmente, o dono pode gravar um procedimento clicando na janela de
 * verdade, e o resultado sai pronto no mesmo formato de `procedures.ts`
 * (reproduzível depois via `runProcedure`/`npm run replay`).
 *
 * Limitações conhecidas (v1, documentar em vez de fingir que não existem):
 * - `type` só grava campos com `placeholder` (mesmo requisito de
 *   `typeIntoByPlaceholder`, o único jeito que `procedures.ts` sabe digitar
 *   hoje). Campo de texto sem placeholder não é gravado — adicione o passo
 *   manualmente no procedimento salvo depois, se precisar. Captura por
 *   evento `input` (cada tecla), não `change` (só ao perder foco) — mais
 *   confiável em campos controlados por React, que às vezes nunca disparam
 *   `change` se o fluxo seguir direto pra outro clique sem a página nunca
 *   tirar o foco do campo de verdade.
 * - Checkbox/radio clicado direto no `<input>` (sem passar por um `<label>`
 *   com texto visível) não é gravado — nesta app eles sempre têm label
 *   clicável ao lado, mas se algum dia não tiver, precisa de passo manual.
 * - Arraste (`drag`) não é gravado — adicione à mão no JSON salvo se o
 *   procedimento precisar disso. Rolagem (`scrollBy`) É gravada (evento
 *   `wheel`, acumulado e debatido — ver `attachRecorder`).
 * - `confirm()`/`alert()` nativo é detectado e SEMPRE aceito automaticamente
 *   (nunca cancelado) — mesmo comportamento padrão já usado em
 *   `clickAndAcceptConfirm` (projectUi.ts). O motor de replay
 *   (`procedures.ts`) TAMBÉM checa e aceita depois de todo clique, mesmo os
 *   não marcados — cobre o caso comum de o dono clicar "OK" no diálogo mais
 *   rápido que o poll de gravação (2s) consegue detectar.
 */
import type { ProcedureStep } from './procedures'

/** Injeta os listeners de clique/digitação na página real (idempotente —
 *  seguro chamar de novo, ex. depois de uma navegação). */
export async function attachRecorder(): Promise<void> {
  await browser.execute(() => {
    const w = window as unknown as {
      __ALETHE_RECORDED_STEPS__?: unknown[]
      __ALETHE_RECORDER_ATTACHED__?: boolean
      __ALETHE_RECORDER_ACTIVE__?: boolean
    }
    if (w.__ALETHE_RECORDER_ATTACHED__) return
    w.__ALETHE_RECORDER_ATTACHED__ = true
    w.__ALETHE_RECORDED_STEPS__ = []
    // Liga o painel `RecorderHelper` (atalho "criar projeto temporário") —
    // só ele lê esta flag; nunca fica ligada fora de uma sessão de gravação.
    w.__ALETHE_RECORDER_ACTIVE__ = true

    const push = (step: unknown) => w.__ALETHE_RECORDED_STEPS__!.push(step)

    function resolveLabel(target: Element): string | null {
      // Linhas de lista (opção de dropdown, item de sidebar) às vezes NÃO
      // são `<button>`/`<label>` de verdade — só `<div onClick>` — fazendo
      // `closest('button,...')` pular a linha certa e cair num container
      // maior com VÁRIAS linhas concatenadas sem separador (bug real,
      // confirmado repetidas vezes ao vivo: "DeepSeek R1
      // (Raciocínio)deepseek/deepseek-r1DeepSeek V3deeps" — duas linhas
      // diferentes coladas). Tenta primeiro por marcadores comuns de "linha
      // de lista" (mais específico), só cai pro genérico se não achar.
      const row = target.closest(
        '[role="option"], li, [data-value], [data-agent-type], [data-id], button, a, [role="button"], label',
      ) as HTMLElement | null
      const el = row ?? (target as HTMLElement)
      const aria = el.getAttribute('aria-label')
      if (aria && aria.trim()) return aria.trim()
      const title = el.getAttribute('title')
      if (title && title.trim()) return title.trim()
      // `textContent` cru gruda o texto de elementos-irmãos adjacentes sem
      // nenhum espaço entre eles (ex. `<span>OpenCode</span><span>Falhou
      // verificação</span>` vira "OpenCodeFalhou verificação" — bug real,
      // confirmado ao vivo). Junta o texto de cada nó folha com espaço.
      const parts: string[] = []
      const walk = (node: Node) => {
        if (node.nodeType === Node.TEXT_NODE) {
          const t = (node.textContent || '').trim()
          if (t) parts.push(t)
        } else {
          node.childNodes.forEach(walk)
        }
      }
      walk(el)
      const text = parts.join(' ').replace(/\s+/g, ' ').trim()
      if (text) return text.slice(0, 60)
      return null
    }

    document.addEventListener(
      'click',
      (ev) => {
        const target = ev.target as Element | null
        if (!target) return
        if (target.closest('input, textarea, select')) return
        const label = resolveLabel(target)
        if (!label) return
        push({ action: 'click', text: label })
      },
      true,
    )

    // `input` (cada tecla) em vez de `change` (só no blur) — atualiza o
    // ÚLTIMO passo gravado no lugar em vez de empilhar um por tecla, desde
    // que ainda seja o mesmo campo (mesmo `placeholder`) sem nenhuma outra
    // ação no meio. Assim o JSON final fica com o VALOR FINAL digitado, não
    // uma sequência de valores parciais.
    document.addEventListener(
      'input',
      (ev) => {
        const target = ev.target as HTMLInputElement | HTMLTextAreaElement | null
        if (!target || !('value' in target)) return
        const inputType = (target as HTMLInputElement).type
        if (inputType === 'checkbox' || inputType === 'radio') return
        const placeholder = target.getAttribute('placeholder')
        if (!placeholder) {
          console.warn('[alethe-recorder] campo sem placeholder ignorado:', target)
          return
        }
        const steps = w.__ALETHE_RECORDED_STEPS__!
        const last = steps[steps.length - 1] as { action?: string; placeholder?: string } | undefined
        if (last && last.action === 'type' && last.placeholder === placeholder) {
          ;(last as { value: string }).value = target.value
        } else {
          push({ action: 'type', placeholder, value: target.value })
        }
      },
      true,
    )

    // Rolagem real via roda do mouse — acumula delta e só grava o passo
    // quando o gesto "termina" (300ms sem novo evento `wheel` no mesmo
    // ponto), pra não empilhar dezenas de micro-passos por segundo de
    // rolagem. Usa as coordenadas CRUAS do evento como origem — mais
    // preciso do que recalcular um seletor de container depois.
    let wheelAcc: { x: number; y: number; dx: number; dy: number } | null = null
    let wheelTimer: number | null = null
    document.addEventListener(
      'wheel',
      (ev) => {
        if (!wheelAcc) wheelAcc = { x: ev.clientX, y: ev.clientY, dx: 0, dy: 0 }
        wheelAcc.dx += ev.deltaX
        wheelAcc.dy += ev.deltaY
        if (wheelTimer) window.clearTimeout(wheelTimer)
        wheelTimer = window.setTimeout(() => {
          if (wheelAcc && (wheelAcc.dx !== 0 || wheelAcc.dy !== 0)) {
            push({
              action: 'scrollBy',
              deltaX: Math.round(wheelAcc.dx),
              deltaY: Math.round(wheelAcc.dy),
              originX: Math.round(wheelAcc.x),
              originY: Math.round(wheelAcc.y),
            })
          }
          wheelAcc = null
          wheelTimer = null
        }, 300)
      },
      { passive: true },
    )
  })
}

/** Lê o buffer gravado até agora (não limpa — chame só quando quiser
 *  persistir o estado atual). */
export async function collectRecordedSteps(): Promise<ProcedureStep[]> {
  const steps = await browser.execute(() => {
    const w = window as unknown as { __ALETHE_RECORDED_STEPS__?: unknown[] }
    return w.__ALETHE_RECORDED_STEPS__ ?? []
  })
  return steps as ProcedureStep[]
}

/** Registra um passo extra direto no mesmo buffer da página — usado pro
 *  `acceptAlert`, que é detectado do lado de fora (Node), não por um
 *  listener de DOM, mas precisa entrar na mesma lista pra manter a ordem
 *  cronológica certa no procedimento salvo. */
export async function pushRecordedStep(step: ProcedureStep): Promise<void> {
  await browser.execute((s) => {
    const w = window as unknown as { __ALETHE_RECORDED_STEPS__?: unknown[] }
    if (!w.__ALETHE_RECORDED_STEPS__) w.__ALETHE_RECORDED_STEPS__ = []
    w.__ALETHE_RECORDED_STEPS__.push(s)
  }, step)
}
