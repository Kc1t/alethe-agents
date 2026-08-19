import { quickLogin } from '../support/onboardingFlow'
import { suppressWindowFocusTax } from '../support/perf'
import { getProcedure } from '../support/procedures'
import { attachRecorder } from '../support/recorder'
import { clickByText, snapshot } from '../support/uiKit'

/**
 * Diagnóstico ao vivo do clique "OpenCode" (card de agente de resolução de
 * conflitos) que falha 100% das vezes, sempre logo depois de "Inicializar
 * repositório Git", só quando reproduzido via procedimento gravado — nunca
 * quando dirigido pelo helper dedicado. Reproduz os passos até ali via o
 * procedimento "test3" já gravado, e ANTES do clique problemático, inspeciona
 * o DOM de verdade (elementFromPoint + getComputedStyle) pra achar a causa
 * raiz real, em vez de continuar adivinhando.
 */
describe('diagnóstico: clique OpenCode não interativo', () => {
  before(async () => {
    await suppressWindowFocusTax()
    await quickLogin(`E2E Diag ${Date.now()}`)
    await attachRecorder()
  })

  it('reproduz até o clique problemático e inspeciona o DOM', async () => {
    const steps = getProcedure('test3')
    if (!steps) throw new Error('procedimento "test3" não encontrado')

    // Roda tudo ATÉ (sem incluir) o primeiro clique em "OpenCode" — mesma
    // sequência exata do test3.
    const openCodeIndex = steps.findIndex((s) => s.action === 'click' && s.text === 'OpenCode')
    if (openCodeIndex === -1) throw new Error('passo "OpenCode" não encontrado no test3')

    for (let i = 0; i < openCodeIndex; i++) {
      const step = steps[i]
      if (step.action === 'click') await clickByText(step.text)
      else if (step.action === 'scrollBy')
        await browser
          .action('wheel')
          .scroll({ x: step.originX ?? 400, y: step.originY ?? 400, deltaX: step.deltaX, deltaY: step.deltaY, duration: 200 })
          .perform()
      else if (step.action === 'type') {
        const input = await $(`input[placeholder="${step.placeholder}"], textarea[placeholder="${step.placeholder}"]`)
        await input.setValue(step.value)
      }
    }

    await snapshot('diag-antes-do-clique-openCode')

    // Acha o elemento "OpenCode" (mesma busca do clickByText) e inspeciona.
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
        // Sobe a cadeia de ancestrais do ponto até <body>, descrevendo cada
        // um — mostra qual camada está de fato recebendo o clique.
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
    console.log('\n>>> DIAGNÓSTICO elementFromPoint(%d, %d):\n%s\n', cx, cy, JSON.stringify(diag, null, 2))
    await snapshot('diag-resultado')
  })
})
