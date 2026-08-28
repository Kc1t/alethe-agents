import { quickLogin } from '../support/onboardingFlow'
import { suppressWindowFocusTax } from '../support/perf'
import { listProcedures, saveProcedure } from '../support/procedures'
import { attachRecorder, collectRecordedSteps, pushRecordedStep } from '../support/recorder'

/**
 * Interactive recorder — explicit request from the owner: instead of always
 * having to manually rediscover selectors, he records a procedure by clicking on the
 * app's real window (never a video — the output is a FILE, `procedures.json`, in the
 * same format `runProcedure`/`npm run replay` already knows how to play back).
 *
 * Does NOT assert anything (it's not a regression test) — opens the isolated app (the
 * same always-empty e2e profile), goes through onboarding on its own (via
 * `quickLogin`, real clicks, doesn't count as part of the recorded procedure
 * because the recorder is only injected AFTERWARD), and hands over control: the owner
 * interacts with the window normally. Saves incrementally to
 * `procedures.json` every 2s (Ctrl+C in the terminal at any time is
 * safe — nothing is lost) and also when the maximum time is reached.
 *
 * Run: npm run replay:record --name=procedureName
 * (default name if `--name` isn't passed: `gravacao-<timestamp>`)
 * (default minutes 15, adjustable with `--minutes=30`)
 */
const PROCEDURE_NAME = process.env.npm_config_name || `gravacao-${Date.now()}`
const MAX_MINUTES = Number(process.env.npm_config_minutes) || 15

describe('interactive procedure recording', () => {
  before(async () => {
    await suppressWindowFocusTax()
    await quickLogin(`E2E Recorder ${Date.now()}`)
  })

  it(`records up to ${MAX_MINUTES}min of real interaction (name: "${PROCEDURE_NAME}")`, async function () {
    this.timeout((MAX_MINUTES + 1) * 60_000)
    await attachRecorder()

    // eslint-disable-next-line no-console
    console.log(
      `\n>>> Recording "${PROCEDURE_NAME}" — interact with the Alethe window normally.\n` +
        `>>> A "REC" button appears in the bottom-right corner with shortcuts (e.g. create\n` +
        `>>> a project in a temporary folder, without typing anything).\n` +
        `>>> Saves on its own every 2s — Ctrl+C here at any time is safe.\n` +
        `>>> Stops automatically after ${MAX_MINUTES} minute(s).\n`,
    )

    const deadline = Date.now() + MAX_MINUTES * 60_000
    while (Date.now() < deadline) {
      // A native `confirm()`/`alert()` blocks the page until answered —
      // detects and accepts it automatically (never cancels — same pattern already
      // used in `clickAndAcceptConfirm`), recording the step in the SAME
      // page buffer to keep the correct chronological order in the
      // saved procedure (otherwise an alert in the middle of a sequence of
      // clicks would end up out of order in the final JSON).
      const alertText = await browser.getAlertText().catch(() => null)
      if (alertText !== null) {
        await browser.acceptAlert()
        await pushRecordedStep({ action: 'acceptAlert' })
      }

      const steps = await collectRecordedSteps().catch(() => null)
      if (steps) saveProcedure(PROCEDURE_NAME, steps)

      await new Promise((resolve) => setTimeout(resolve, 2_000))
    }

    const finalSteps = await collectRecordedSteps()
    saveProcedure(PROCEDURE_NAME, finalSteps)
    // eslint-disable-next-line no-console
    console.log(
      `\n>>> Recording "${PROCEDURE_NAME}" saved with ${finalSteps.length} step(s) in e2e/support/procedures.json\n` +
        `>>> Saved procedures: ${listProcedures().join(', ')}\n` +
        `>>> Play back with: npm run replay --name=${PROCEDURE_NAME}\n`,
    )
  })
})
