import { en } from '../../src/lib/i18n/messages/en'
import { ptBR } from '../../src/lib/i18n/messages/pt-BR'
import { zhCN } from '../../src/lib/i18n/messages/zh-CN'
import { applyE2eLocale, E2E_LOCALE } from '../support/locale'
import { completeOnboarding } from '../support/onboardingFlow'
import { suppressWindowFocusTax } from '../support/perf'
import { captureScreenshot } from '../support/screenshot'

const messages = E2E_LOCALE === 'pt-BR' ? ptBR : E2E_LOCALE === 'zh-CN' ? zhCN : en
const button = (label: string) => $('button=' + label)

async function closeOpenDialogs() {
  await browser.waitUntil(
    async () => {
      if (!(await $('[role="dialog"]').isExisting())) return true
      await browser.keys('Escape')
      return false
    },
    { timeout: 15_000, interval: 500, timeoutMsg: 'a dialog stayed open after onboarding' },
  )
}

describe('Voice resource preferences', () => {
  before(async () => {
    await suppressWindowFocusTax()
    const onboarding = await $('#onboarding-name')
    if (await onboarding.waitForExist({ timeout: 15_000 }).catch(() => false)) {
      await completeOnboarding('Voice preferences tester')
    }
    await closeOpenDialogs()
    await applyE2eLocale()
  })

  it('opens provider setup and local models, and rejects an invalid custom server', async () => {
    await $('[aria-label="' + messages['profile.preferences'] + '"]').click()
    await $('nav').$('button*=' + messages['prefs.categoryVoice']).click()
    await $('[data-setting-id="voice-providers"]').waitForDisplayed()
    await $(
      '[aria-label="' +
        messages['prefs.voiceActionSetUpKey'] +
        ' ' +
        messages['voice.provider.openai'] +
        '"]',
    ).click()
    await $('input[type="password"]').waitForDisplayed()
    expect(await button(messages['prefs.voiceKeySave']).isEnabled()).toBe(false)
    await button(messages['prefs.voiceAccountsTitle']).click()
    await $(
      '[aria-label="' +
        messages['prefs.voiceActionManageModels'] +
        ' ' +
        messages['voice.provider.local'] +
        '"]',
    ).click()
    await $('table').waitForDisplayed()
    await button(messages['prefs.voiceLocalModeSearch']).click()
    await $('input[type="search"]').waitForDisplayed()
    await button(messages['prefs.voiceAccountsTitle']).click()
    await button(messages['prefs.voiceServerAdd']).click()
    const inputs = await $$('main input:not([type])')
    await inputs[0].setValue('Invalid E2E server')
    await inputs[1].setValue('file:///invalid')
    await button(messages['prefs.voiceServerSave']).click()
    await browser.waitUntil(async () => {
      const feedback = await $('main [role="status"]')
      return (
        (await feedback.isExisting()) &&
        [
          messages['prefs.voiceServerError.policy'],
          messages['prefs.voiceServerError.invalidUrl'],
        ].includes(await feedback.getText())
      )
    })
    expect(await $('main input[type="password"]').getValue()).toBe('')
    await captureScreenshot('voice-preferences--server-validation')
  })
})
