import { en } from '../../src/lib/i18n/messages/en'
import { ptBR } from '../../src/lib/i18n/messages/pt-BR'
import { zhCN } from '../../src/lib/i18n/messages/zh-CN'
import { E2E_LOCALE } from '../support/locale'
import { completeOnboarding } from '../support/onboardingFlow'
import { captureScreenshot } from '../support/screenshot'

const messages = E2E_LOCALE === 'pt-BR' ? ptBR : E2E_LOCALE === 'zh-CN' ? zhCN : en

describe('Voice HUD window', () => {
  before(async () => {
    await completeOnboarding('Voice HUD tester')
  })

  it('renders only the HUD, without the workspace or plugins', async () => {
    const main = await browser.getWindowHandle()
    await browser.execute(() =>
      (
        window as unknown as {
          __TAURI_INTERNALS__: { invoke: (cmd: string, args: unknown) => Promise<unknown> }
        }
      ).__TAURI_INTERNALS__.invoke('voice_hud_show', {
        placement: { kind: 'preset', preset: 'bottom-center' },
      }),
    )
    await browser.waitUntil(async () => (await browser.getWindowHandles()).length > 1, {
      timeout: 15_000,
      timeoutMsg: 'the HUD window never opened',
    })
    const hud = (await browser.getWindowHandles()).find((handle) => handle !== main)!
    await browser.switchToWindow(hud)
    await $('[aria-label="' + messages['voice.conv.title'] + '"]').waitForExist({ timeout: 15_000 })
    expect(await $('#onboarding-name').isExisting()).toBe(false)
    expect(await $('[aria-label="' + messages['profile.preferences'] + '"]').isExisting()).toBe(
      false,
    )
    await captureScreenshot('voice-hud--placeholder')
    await browser.switchToWindow(main)
  })
})
