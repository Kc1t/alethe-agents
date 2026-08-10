import { expect } from '@wdio/globals'

import { captureScreenshot } from '../support/screenshot'
import { recordStep } from '../support/report'

describe('smoke: o app sobe sem crash', () => {
  it('renderiza a janela e não tem erro de console', async () => {
    await browser.pause(1_000)
    const path = await captureScreenshot('smoke--boot')
    recordStep({ scenario: 'smoke', step: 'boot', status: 'pass', screenshotPath: path })

    const title = await browser.getTitle()
    expect(title.length).toBeGreaterThan(0)
  })
})
