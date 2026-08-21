/**
 * Procedure recording from REAL user clicks/typing —
 * explicit request from the owner: instead of always having to rediscover selectors
 * manually, the owner can record a procedure by clicking in the real
 * window, and the result comes out ready in the same format as `procedures.ts`
 * (replayable later via `runProcedure`/`npm run replay`).
 *
 * Known limitations (v1, document rather than pretend they don't exist):
 * - `type` only records fields with a `placeholder` (same requirement as
 *   `typeIntoByPlaceholder`, the only way `procedures.ts` knows how to type
 *   today). A text field without a placeholder isn't recorded — add the step
 *   manually to the saved procedure afterward, if needed. Captures via the
 *   `input` event (each keystroke), not `change` (only on blur) — more
 *   reliable on React-controlled fields, which sometimes never fire
 *   `change` if the flow goes straight to another click without the page ever
 *   losing focus on the actual field.
 * - A checkbox/radio clicked directly on the `<input>` (without going through a
 *   `<label>` with visible text) isn't recorded — in this app they always have a
 *   clickable label next to them, but if that's ever not the case, a manual step is needed.
 * - Dragging (`drag`) isn't recorded — add it by hand to the saved JSON if the
 *   procedure needs it. Scrolling (`scrollBy`) IS recorded (`wheel`
 *   event, accumulated and debounced — see `attachRecorder`).
 * - A native `confirm()`/`alert()` is detected and ALWAYS accepted automatically
 *   (never cancelled) — the same default behavior already used in
 *   `clickAndAcceptConfirm` (projectUi.ts). The replay engine
 *   (`procedures.ts`) ALSO checks and accepts after every click, even the
 *   unmarked ones — covers the common case of the owner clicking "OK" on the dialog
 *   faster than the recording poll (2s) can detect.
 */
import type { ProcedureStep } from './procedures'

/** Injects the click/typing listeners into the real page (idempotent —
 *  safe to call again, e.g. after a navigation). */
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
    // Turns on the `RecorderHelper` panel (the "create temporary project" shortcut) —
    // only it reads this flag; it's never left on outside of a recording session.
    w.__ALETHE_RECORDER_ACTIVE__ = true

    const push = (step: unknown) => w.__ALETHE_RECORDED_STEPS__!.push(step)

    function resolveLabel(target: Element): string | null {
      // List rows (dropdown option, sidebar item) are sometimes NOT
      // real `<button>`/`<label>` elements — just `<div onClick>` — making
      // `closest('button,...')` skip the right row and land on a bigger
      // container with SEVERAL rows concatenated with no separator (a real bug,
      // confirmed repeatedly live: "DeepSeek R1
      // (Raciocínio)deepseek/deepseek-r1DeepSeek V3deeps" — two different
      // rows glued together). Tries common "list row" markers first
      // (more specific), only falls back to the generic one if none is found.
      const row = target.closest(
        '[role="option"], li, [data-value], [data-agent-type], [data-id], button, a, [role="button"], label',
      ) as HTMLElement | null
      const el = row ?? (target as HTMLElement)
      const aria = el.getAttribute('aria-label')
      if (aria && aria.trim()) return aria.trim()
      const title = el.getAttribute('title')
      if (title && title.trim()) return title.trim()
      // Raw `textContent` glues the text of adjacent sibling elements together with
      // no space between them (e.g. `<span>OpenCode</span><span>Falhou
      // verificação</span>` becomes "OpenCodeFalhou verificação" — a real bug,
      // confirmed live). Joins the text of each leaf node with a space.
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

    // `input` (every keystroke) instead of `change` (only on blur) — updates the
    // LAST recorded step in place instead of pushing one per keystroke, as long as
    // it's still the same field (same `placeholder`) with no other
    // action in between. This way the final JSON ends up with the FINAL VALUE typed, not
    // a sequence of partial values.
    document.addEventListener(
      'input',
      (ev) => {
        const target = ev.target as HTMLInputElement | HTMLTextAreaElement | null
        if (!target || !('value' in target)) return
        const inputType = (target as HTMLInputElement).type
        if (inputType === 'checkbox' || inputType === 'radio') return
        const placeholder = target.getAttribute('placeholder')
        if (!placeholder) {
          console.warn('[alethe-recorder] field with no placeholder ignored:', target)
          return
        }
        const steps = w.__ALETHE_RECORDED_STEPS__!
        const last = steps[steps.length - 1] as
          { action?: string; placeholder?: string } | undefined
        if (last && last.action === 'type' && last.placeholder === placeholder) {
          ;(last as { value: string }).value = target.value
        } else {
          push({ action: 'type', placeholder, value: target.value })
        }
      },
      true,
    )

    // Real scrolling via the mouse wheel — accumulates the delta and only records the step
    // when the gesture "ends" (300ms with no new `wheel` event at the
    // same point), so as not to stack up dozens of micro-steps per second of
    // scrolling. Uses the event's RAW coordinates as the origin — more
    // accurate than recalculating a container selector afterward.
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

/** Reads the buffer recorded so far (doesn't clear it — call it only when you want to
 *  persist the current state). */
export async function collectRecordedSteps(): Promise<ProcedureStep[]> {
  const steps = await browser.execute(() => {
    const w = window as unknown as { __ALETHE_RECORDED_STEPS__?: unknown[] }
    return w.__ALETHE_RECORDED_STEPS__ ?? []
  })
  return steps as ProcedureStep[]
}

/** Records an extra step directly into the same page buffer — used for
 *  `acceptAlert`, which is detected from the outside (Node), not by a
 *  DOM listener, but needs to enter the same list to keep the correct
 *  chronological order in the saved procedure. */
export async function pushRecordedStep(step: ProcedureStep): Promise<void> {
  await browser.execute((s) => {
    const w = window as unknown as { __ALETHE_RECORDED_STEPS__?: unknown[] }
    if (!w.__ALETHE_RECORDED_STEPS__) w.__ALETHE_RECORDED_STEPS__ = []
    w.__ALETHE_RECORDED_STEPS__.push(s)
  }, step)
}
