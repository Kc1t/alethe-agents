import { quickLogin } from '../support/onboardingFlow'
import { suppressWindowFocusTax } from '../support/perf'
import { getProcedure } from '../support/procedures'
import { attachRecorder } from '../support/recorder'
import { clickByText, snapshot } from '../support/uiKit'

/**
 * Live diagnostic for the "OpenCode" click (the conflict resolution agent
 * card) that fails 100% of the time, always right after "Initialize
 * Git repository", but only when reproduced via a recorded procedure — never
 * when driven by the dedicated helper. Reproduces the steps up to that point via the
 * already-recorded "test3" procedure, and BEFORE the problematic click, inspects
 * the real DOM (elementFromPoint + getComputedStyle) to find the real root
 * cause, instead of continuing to guess.
 */
describe('diagnostic: non-interactive OpenCode click', () => {
  before(async () => {
    await suppressWindowFocusTax()
    await quickLogin(`E2E Diag ${Date.now()}`)
    await attachRecorder()
  })

  it('reproduces up to the problematic click and inspects the DOM', async () => {
    const steps = getProcedure('test3')
    if (!steps) throw new Error('procedure "test3" not found')

    // Runs everything UP TO (not including) the first click on "OpenCode" — same
    // exact sequence as test3.
    const openCodeIndex = steps.findIndex((s) => s.action === 'click' && s.text === 'OpenCode')
    if (openCodeIndex === -1) throw new Error('"OpenCode" step not found in test3')

    for (let i = 0; i < openCodeIndex; i++) {
      const step = steps[i]
      if (step.action === 'click') await clickByText(step.text)
      else if (step.action === 'scrollBy')
        await browser
          .action('wheel')
          .scroll({
            x: step.originX ?? 400,
            y: step.originY ?? 400,
            deltaX: step.deltaX,
            deltaY: step.deltaY,
            duration: 200,
          })
          .perform()
      else if (step.action === 'type') {
        const input = await $(
          `input[placeholder="${step.placeholder}"], textarea[placeholder="${step.placeholder}"]`,
        )
        await input.setValue(step.value)
      }
    }

    await snapshot('diag-antes-do-clique-openCode')

    // Finds the "OpenCode" element (same lookup as clickByText) and inspects it.
    const target = await $('button*=OpenCode')
    const location = await target.getLocation()
    const size = await target.getSize()
    const cx = Math.round(location.x + size.width / 2)
    const cy = Math.round(location.y + size.height / 2)

    const diag = await browser.execute(
      (x, y) => {
        const atPoint = document.elementFromPoint(x, y)
        const describe = (el: Element | null) => {
          if (!el) return null
          const cs = getComputedStyle(el)
          const rect = el.getBoundingClientRect()
          return {
            tag: el.tagName,
            id: el.id,
            className: el.className,
            text: (el.textContent || '').slice(0, 80),
            pointerEvents: cs.pointerEvents,
            zIndex: cs.zIndex,
            position: cs.position,
            opacity: cs.opacity,
            visibility: cs.visibility,
            display: cs.display,
            rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
          }
        }
        // Walks the ancestor chain from the point up to <body>, describing each
        // one — shows which layer is actually receiving the click.
        const chain: unknown[] = []
        let el: Element | null = atPoint
        let depth = 0
        while (el && depth < 8) {
          chain.push(describe(el))
          el = el.parentElement
          depth++
        }
        return { atPoint: describe(atPoint), chain }
      },
      cx,
      cy,
    )

    // eslint-disable-next-line no-console
    console.log(
      '\n>>> DIAGNOSTIC elementFromPoint(%d, %d):\n%s\n',
      cx,
      cy,
      JSON.stringify(diag, null, 2),
    )
    await snapshot('diag-resultado')
  })
})
