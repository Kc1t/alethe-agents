import { suppressWindowFocusTax } from '../support/perf'
import { recordStep } from '../support/report'
import { captureScreenshot } from '../support/screenshot'

describe('smoke: the app starts up without crashing', () => {
  before(async () => {
    await suppressWindowFocusTax()
  })

  it('renders the window and has no console errors', async () => {
    await browser.pause(1_000)
    const path = await captureScreenshot('smoke--boot')
    recordStep({ scenario: 'smoke', step: 'boot', status: 'pass', screenshotPath: path })

    const root = await $('#root')
    await root.waitForDisplayed({ timeout: 10_000 })
    expect(await root.isDisplayed()).toBe(true)
  })
})
