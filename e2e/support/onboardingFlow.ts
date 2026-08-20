/**
 * Todo profile e2e nasce ISOLADO E VAZIO (pedido explícito do dono, depois
 * de pegar um teste rodando contra o perfil real dele) — por isso QUALQUER
 * spec que precise passar da tela inicial cai primeiro no onboarding, não
 * direto na tela que o spec quer testar. `onboarding.spec.ts` testa esse
 * fluxo em detalhe (com asserções próprias); este helper só EXISTE PRA
 * PASSAR por ele de forma real (clique/digitação, nunca hook) em specs que
 * têm outro foco — esquecer isso trava o spec bem no início, esperando um
 * campo que nunca aparece porque o onboarding ainda bloqueia a tela (bug
 * real visto ao vivo nesta sessão no primeiro rascunho do git-pipeline).
 */
import { markScreenshotAndClick } from './screenshot'

let step = 0
function nextShotName(label: string): string {
  step += 1
  return `onboarding-flow--${String(step).padStart(2, '0')}-${label}`
}

/**
 * Idempotente: se o onboarding já foi concluído (perfil reaproveitado entre
 * specs, ou uma sessão anterior já passou por aqui), o campo `#onboarding-name`
 * nunca aparece — detecta isso rápido (timeout curto) e retorna sem erro, em
 * vez de travar 15s esperando uma tela que não vai aparecer. Pedido explícito
 * do dono: "ferramenta simples que passe pelo login", sempre segura de
 * chamar no início de qualquer spec novo, sabendo ou não o estado do perfil.
 */
export async function completeOnboarding(displayName: string): Promise<void> {
  const nameInput = await $('#onboarding-name')
  const appeared = await nameInput.waitForDisplayed({ timeout: 15_000 }).catch(() => false)
  if (!appeared) return
  await nameInput.setValue(displayName)

  const ptButton = await $('button*=Português')
  await markScreenshotAndClick(ptButton, nextShotName('selecionar-pt-br'))

  const nextButtonFilled = await $('button[class*="buttonPrimary"]')
  await nextButtonFilled.waitForEnabled({ timeout: 5_000 })
  await markScreenshotAndClick(nextButtonFilled, nextShotName('proximo-perfil'))

  // Passo 1 (tema) e 2 (agentes) — "Próximo" sempre habilitado nesses.
  const step1Next = await $('button[class*="buttonPrimary"]')
  await step1Next.waitForClickable({ timeout: 10_000 })
  await markScreenshotAndClick(step1Next, nextShotName('proximo-tema'))

  const step2Next = await $('button[class*="buttonPrimary"]')
  await step2Next.waitForClickable({ timeout: 10_000 })
  await markScreenshotAndClick(step2Next, nextShotName('proximo-agentes'))

  // Passo 3 (features) — último passo, botão vira "Finalizar configuração".
  const finishButton = await $('button[class*="buttonPrimary"]')
  await finishButton.waitForClickable({ timeout: 10_000 })
  await markScreenshotAndClick(finishButton, nextShotName('finalizar-configuracao'))

  await browser.waitUntil(async () => !(await $('#onboarding-name').isExisting()), {
    timeout: 20_000,
    timeoutMsg: 'onboarding não fechou depois de "Finalizar configuração"',
  })
}

/** Nome mais direto pro mesmo comportamento — "entra no app, não importa o
 *  estado do perfil". Use este no início de specs de exploração ad-hoc. */
export const quickLogin = completeOnboarding
