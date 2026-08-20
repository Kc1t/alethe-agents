/**
 * Registro de PROCEDIMENTOS nomeados — pedido explícito do dono: uma
 * ferramenta pra guardar um caminho de navegação já descoberto (ex. "abrir
 * Configurações → aba Agentes") e só REPETIR depois, sem precisar re-derivar
 * os seletores/passos toda vez que precisar voltar lá.
 *
 * Persistido em `procedures.json` (não `.ts`) — arquivo de dados simples,
 * legível, versionável no git, sobrevive entre execuções (cada `wdio run` é
 * um processo Node novo, então guardar só em memória não adiantaria).
 *
 * Cada passo é uma ação genérica de `uiKit.ts` — este arquivo só SEQUENCIA
 * chamadas que já existem, não inventa nenhuma interação nova.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  acceptAlertIfPresent,
  clickByText,
  clickNearLabel,
  dragBy,
  dragFromTo,
  scrollBy,
  scrollIntoView,
  snapshot,
  typeIntoByPlaceholder,
  waitForText,
  waitForTextGone,
} from './uiKit'

export type ProcedureStep =
  | { action: 'click'; text: string; index?: number; scopeSelector?: string }
  /** Pra botões cujo PRÓPRIO texto muda (ex. gatilho de dropdown que mostra
   *  o valor atualmente selecionado) — clica pelo texto de um `<label>`
   *  vizinho estável em vez do texto do botão em si. */
  | { action: 'clickNearLabel'; labelText: string; nth?: number }
  | { action: 'type'; placeholder: string; value: string }
  | { action: 'waitText'; text: string }
  | { action: 'waitTextGone'; text: string }
  | { action: 'acceptAlert' }
  | { action: 'snapshot'; label: string }
  | {
      action: 'drag'
      selector: string
      deltaX?: number
      deltaY?: number
      steps?: number
      stepDurationMs?: number
      repetitions?: number
      repetitionPauseMs?: number
    }
  | {
      action: 'dragTo'
      fromSelector: string
      toSelector: string
      steps?: number
      stepDurationMs?: number
    }
  | { action: 'scrollIntoView'; selector: string }
  | {
      action: 'scrollBy'
      deltaX: number
      deltaY: number
      selector?: string
      /** Coordenadas de origem cruas (px), gravadas automaticamente pelo
       *  gravador — ganham prioridade sobre `selector` quando ambos vierem
       *  preenchidos, já que apontam pro ponto exato onde o scroll real
       *  aconteceu (mais preciso que recalcular o centro de um elemento). */
      originX?: number
      originY?: number
    }

const STORE_PATH = fileURLToPath(new URL('./procedures.json', import.meta.url))

function loadStore(): Record<string, ProcedureStep[]> {
  if (!existsSync(STORE_PATH)) return {}
  try {
    return JSON.parse(readFileSync(STORE_PATH, 'utf8'))
  } catch {
    return {}
  }
}

function saveStore(store: Record<string, ProcedureStep[]>): void {
  mkdirSync(dirname(STORE_PATH), { recursive: true })
  writeFileSync(STORE_PATH, JSON.stringify(store, null, 2) + '\n', 'utf8')
}

/** Grava (ou sobrescreve) um procedimento nomeado — chamar depois de
 *  descobrir manualmente um caminho de navegação que vale a pena reusar. */
export function saveProcedure(name: string, steps: ProcedureStep[]): void {
  const store = loadStore()
  store[name] = steps
  saveStore(store)
}

/** Lê os passos de um procedimento salvo, ou `null` se nunca foi gravado. */
export function getProcedure(name: string): ProcedureStep[] | null {
  return loadStore()[name] ?? null
}

export function listProcedures(): string[] {
  return Object.keys(loadStore())
}

async function runStep(step: ProcedureStep): Promise<void> {
  switch (step.action) {
    case 'click': {
      await clickByText(step.text, { index: step.index, scopeSelector: step.scopeSelector })
      // Cliques que disparam `confirm()`/`alert()` nativo (ex. "Inicializar
      // repositório Git") nem sempre viram um passo `acceptAlert` explícito
      // gravado — se o dono clicar "OK" no diálogo real mais rápido que o
      // poll de 2s da gravação (`_record.spec.ts`), o alerta nunca chega a
      // ser detectado NA HORA de gravar, mas o clique que o dispara continua
      // no procedimento. Sem isso, o replay trava com o diálogo aberto pra
      // sempre, e todo clique seguinte falha "not interactable" (confirmado
      // ao vivo — nada a ver com o elemento do PRÓXIMO passo em si). Checa
      // depois de TODO clique, não só dos marcados — mais robusto do que
      // confiar na gravação ter pego o timing certo. 150ms (não 500ms):
      // `confirm()` bloqueia a JS thread na hora, então se existir já está
      // lá no primeiro check — timeout maior só soma espera morta em toda
      // gravação real sem nenhum confirm (medido ao vivo: dezenas de
      // cliques × 500ms perdidos à toa).
      await acceptAlertIfPresent(150)
      return
    }
    case 'clickNearLabel': {
      await clickNearLabel(step.labelText, step.nth)
      await acceptAlertIfPresent(150)
      return
    }
    case 'type':
      return typeIntoByPlaceholder(step.placeholder, step.value)
    case 'waitText':
      return waitForText(step.text)
    case 'waitTextGone':
      return waitForTextGone(step.text)
    case 'acceptAlert':
      await acceptAlertIfPresent()
      return
    case 'snapshot':
      await snapshot(step.label)
      return
    case 'drag':
      return dragBy(step.selector, {
        deltaX: step.deltaX,
        deltaY: step.deltaY,
        steps: step.steps,
        stepDurationMs: step.stepDurationMs,
        repetitions: step.repetitions,
        repetitionPauseMs: step.repetitionPauseMs,
      })
    case 'dragTo':
      return dragFromTo(step.fromSelector, step.toSelector, {
        steps: step.steps,
        stepDurationMs: step.stepDurationMs,
      })
    case 'scrollIntoView':
      return scrollIntoView(step.selector)
    case 'scrollBy':
      return scrollBy(step.deltaX, step.deltaY, {
        selector: step.selector,
        originX: step.originX,
        originY: step.originY,
      })
  }
}

/** Roda uma lista de passos direto (sem precisar ter salvo antes) — útil
 *  pra montar/testar um procedimento antes de gravá-lo com `saveProcedure`. */
export async function runSteps(steps: ProcedureStep[]): Promise<void> {
  for (const step of steps) {
    await runStep(step)
  }
}

/** Roda um procedimento já salvo pelo nome. Lança erro claro se nunca foi
 *  gravado — nunca falha silenciosamente fingindo que rodou algo. */
export async function runProcedure(name: string): Promise<void> {
  const steps = getProcedure(name)
  if (!steps) {
    throw new Error(
      `runProcedure: nenhum procedimento salvo com o nome "${name}" (salvos: ${listProcedures().join(', ') || 'nenhum'})`,
    )
  }
  await runSteps(steps)
}
