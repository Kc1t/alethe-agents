/**
 * Registry of named PROCEDURES — explicit request from the owner: a
 * tool for storing an already-discovered navigation path (e.g. "open
 * Settings → Agents tab") and just REPLAYING it later, without needing to re-derive
 * the selectors/steps every time you need to go back there.
 *
 * Persisted in `procedures.json` (not `.ts`) — a simple, readable, git-versionable
 * data file, that survives between runs (each `wdio run` is a
 * new Node process, so keeping it only in memory wouldn't help).
 *
 * Each step is a generic action from `uiKit.ts` — this file only SEQUENCES
 * calls that already exist, it doesn't invent any new interaction.
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
  /** For buttons whose OWN text changes (e.g. a dropdown trigger that shows
   *  the currently selected value) — clicks by the text of a stable neighboring
   *  `<label>` instead of the button's own text. */
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
      /** Raw origin coordinates (px), recorded automatically by the
       *  recorder — take priority over `selector` when both are
       *  filled in, since they point to the exact spot where the real scroll
       *  happened (more precise than recalculating an element's center). */
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

/** Saves (or overwrites) a named procedure — call after
 *  manually discovering a navigation path worth reusing. */
export function saveProcedure(name: string, steps: ProcedureStep[]): void {
  const store = loadStore()
  store[name] = steps
  saveStore(store)
}

/** Reads the steps of a saved procedure, or `null` if it was never recorded. */
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
      // Clicks that trigger a native `confirm()`/`alert()` (e.g. "Initialize
      // Git repository") don't always turn into an explicit `acceptAlert` step
      // recorded — if the owner clicks "OK" on the real dialog faster than the
      // recording's 2s poll (`_record.spec.ts`), the alert never gets
      // detected AT THE MOMENT of recording, but the click that triggers it stays
      // in the procedure. Without this, replay hangs with the dialog open
      // forever, and every following click fails with "not interactable" (confirmed
      // live — nothing to do with the element of the NEXT step itself). Checks
      // after EVERY click, not just the marked ones — more robust than
      // trusting that the recording caught the right timing. 150ms (not 500ms):
      // `confirm()` blocks the JS thread immediately, so if it exists it's already
      // there on the first check — a bigger timeout would just add dead wait time on every
      // real recording with no confirm at all (measured live: dozens of
      // clicks × 500ms wasted for nothing).
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

/** Runs a list of steps directly (without needing to have saved it before) — useful
 *  for building/testing a procedure before recording it with `saveProcedure`. */
export async function runSteps(steps: ProcedureStep[]): Promise<void> {
  for (const step of steps) {
    await runStep(step)
  }
}

/** Runs an already-saved procedure by name. Throws a clear error if it was never
 *  recorded — never fails silently pretending it ran something. */
export async function runProcedure(name: string): Promise<void> {
  const steps = getProcedure(name)
  if (!steps) {
    throw new Error(
      `runProcedure: no procedure saved with the name "${name}" (saved: ${listProcedures().join(', ') || 'none'})`,
    )
  }
  await runSteps(steps)
}
