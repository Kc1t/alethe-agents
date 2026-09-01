import { quickLogin } from '../support/onboardingFlow'
import { suppressWindowFocusTax } from '../support/perf'
import { listProcedures, runProcedure } from '../support/procedures'
import { attachRecorder } from '../support/recorder'

/**
 * Plays back a saved procedure — recorded via `npm run replay:record`
 * (`_record.spec.ts`) or written by hand in `procedures.json`. Useful for
 * confirming that a recorded procedure still works, without needing to
 * rediscover the steps from scratch every time.
 *
 * Run: npm run replay --name=procedureName
 */
const PROCEDURE_NAME = process.env.npm_config_name

describe('playing back a recorded procedure', () => {
  before(async () => {
    await suppressWindowFocusTax()
    await quickLogin(`E2E Replay ${Date.now()}`)
    // Procedures recorded via `npm run replay:record` may include
    // clicks on the `RecorderHelper` panel (e.g. "Recording shortcuts" →
    // "Create temporary project") — without this, that button doesn't even exist on screen
    // during replay, and the first step fails right away.
    await attachRecorder()
  })

  it(`plays back the "${PROCEDURE_NAME}" procedure`, async () => {
    if (!PROCEDURE_NAME) {
      throw new Error(
        `npm run replay needs --name=<name>. Saved procedures: ${listProcedures().join(', ') || 'none'}`,
      )
    }
    await runProcedure(PROCEDURE_NAME)
  })
})
