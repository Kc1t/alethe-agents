import type { Options } from '@wdio/types'

import { prepareIsolatedLaunch } from './support/launch'

// REAL BUG CONFIRMED IN THIS SESSION (running live): mutating `capabilities`
// inside `onPrepare` did NOT actually take effect — the app started with
// `application: "PLACEHOLDER_SET_IN_ON_PREPARE"` (a path that doesn't
// exist), and `@wdio/tauri-service` silently fell back to plain Edge
// instead of the real Tauri app (confirmed by the log: `Running: msedge` and
// `Tauri core.invoke not available after 5s timeout`) — and even so the
// smoke test "passed", because it only checked `title.length > 0`. Fixed by
// computing the isolated launch AT MODULE TIME (synchronous — `mkdtempSync`
// doesn't need any async hook) and writing the real values
// directly into the exported `capabilities` object, instead of trying to mutate it later.
const launch = prepareIsolatedLaunch()

export const config: Options.Testrunner = {
  runner: 'local',
  specs: ['./specs/smoke.spec.ts', './specs/onboarding.spec.ts', './specs/git-pipeline.spec.ts'],
  maxInstances: 1,
  logLevel: 'warn',
  framework: 'mocha',
  reporters: ['spec'],
  mochaOpts: {
    ui: 'bdd',
    // `_record.spec.ts` (the interactive recorder, `npm run replay:record`)
    // needs up to ~16min by default (`--minutes=N` can ask for more) — the
    // `this.timeout()` called INSIDE the test has no effect here: the
    // `@wdio/mocha-framework` wraps each `it()` with its OWN timeout
    // (confirmed live: it hung at exactly 300s even with
    // `this.timeout(16*60_000)` as the test's first line) — only the
    // global value here is actually respected. Generous enough to cover
    // `--minutes=30`; normal specs fail from their own internal timeouts
    // (10-15s per step) well before that, so it doesn't hang around pointlessly.
    timeout: 2_000_000,
  },
  services: [['@wdio/tauri-service', { driverProvider: 'tauri-driver' }]],
  capabilities: [
    {
      browserName: 'tauri',
      'tauri:options': {
        application: launch.applicationPath,
      },
      // Isolation env via the lib's documented option (arrives intact at the
      // final spawn) — never via a .cmd/.sh wrapper, which breaks the direct
      // spawn of @wdio/tauri-service on Windows (see comment in launch.ts).
      'wdio:tauriServiceOptions': {
        driverProvider: 'tauri-driver',
        env: launch.env,
      },
    } as WebdriverIO.Capabilities,
  ],

  // Setting the language CANNOT live here: confirmed live that config's
  // `before` hooks and `@wdio/tauri-service`'s own hooks (which attaches
  // `browser.tauri`) run in PARALLEL via `Promise.all`, not sequentially
  // — this hook would sometimes fire before `browser.tauri` existed,
  // throwing `Cannot read properties of undefined (reading 'execute')`
  // (silently swallowed by the runner, without failing the suite — another
  // false positive, unrelated to the original problem). Each spec applies the
  // language in its OWN mocha `before()` (see `e2e/support/locale.ts`),
  // which only runs after the WDIO session (and all framework hooks)
  // have actually finished.

  onComplete: () => {
    launch.cleanup()
  },
}
