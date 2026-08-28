import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { createEmptyFixtureProject } from '../support/fixtureProject'
import { completeOnboarding } from '../support/onboardingFlow'
import { suppressWindowFocusTax } from '../support/perf'
import { cancelAutoOpenedNewTerminalModal, createProjectViaUi } from '../support/projectUi'
import { captureScreenshot } from '../support/screenshot'
import { clickByText, snapshot } from '../support/uiKit'

/**
 * Visual diagnostic for the Commit Graph (`GitGraph.tsx`/`GitGraphList.tsx`)
 * — this is not an assertion-based regression suite, it's a tool for taking a
 * REAL screenshot of the panel against a repository with known topology
 * (a branch diverging from main + merging back), to diagnose reported
 * visual bugs without depending on screenshots cropped by the user.
 *
 * Runs OUTSIDE the default suite (it's not in `wdio.conf.ts`'s `specs`) — invoke it
 * explicitly via `--spec e2e/specs/git-graph-screenshot.spec.ts`.
 */
function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, encoding: 'utf8' })
}

describe('visual diagnostic: commit graph', function () {
  this.timeout(180_000)
  const fixture = createEmptyFixtureProject()
  const projectName = `e2e-git-graph-${Date.now()}`

  before(async () => {
    await suppressWindowFocusTax()

    // Known topology: main with 2 commits, a feature branch that
    // diverges between them and has 2 of its own commits, merged back (a real
    // merge commit, --no-ff) — the minimum needed to see the main lane + branch
    // lane + divergence curve + merge curve, all on the same screen.
    const repoPath = fixture.path
    git(repoPath, ['init', '--initial-branch', 'main'])
    git(repoPath, ['config', 'user.email', 'e2e@alethe.test'])
    git(repoPath, ['config', 'user.name', 'Alethe E2E'])
    writeFileSync(join(repoPath, 'main.txt'), 'main v1\n')
    git(repoPath, ['add', 'main.txt'])
    git(repoPath, ['commit', '-m', 'main: commit inicial'])

    git(repoPath, ['checkout', '-b', 'feature/graph-colors'])
    writeFileSync(join(repoPath, 'feature.txt'), 'feature v1\n')
    git(repoPath, ['add', 'feature.txt'])
    git(repoPath, ['commit', '-m', 'feature: primeiro commit'])
    writeFileSync(join(repoPath, 'feature.txt'), 'feature v2\n')
    git(repoPath, ['add', 'feature.txt'])
    git(repoPath, ['commit', '-m', 'feature: segundo commit'])

    git(repoPath, ['checkout', 'main'])
    writeFileSync(join(repoPath, 'main.txt'), 'main v2\n')
    git(repoPath, ['add', 'main.txt'])
    git(repoPath, ['commit', '-m', 'main: segundo commit'])

    git(repoPath, [
      'merge',
      '--no-ff',
      'feature/graph-colors',
      '-m',
      "Merge branch 'feature/graph-colors'",
    ])

    // Several short branches (1 commit, immediate merge) in sequence — this is
    // exactly the pattern that exposed the `--agent-shell` == `--status-working`
    // color collision (the secondary lane ended up with the SAME color as the
    // main lane, looking like a single "zigzagging" line instead of distinct
    // lanes converging). Reproduces the scenario from the owner's screenshot.
    for (let i = 1; i <= 4; i++) {
      const branch = `hotfix/${i}`
      git(repoPath, ['checkout', '-b', branch])
      writeFileSync(join(repoPath, `hotfix-${i}.txt`), `hotfix ${i}\n`)
      git(repoPath, ['add', `hotfix-${i}.txt`])
      git(repoPath, ['commit', '-m', `hotfix ${i}: commit único`])
      git(repoPath, ['checkout', 'main'])
      git(repoPath, ['merge', '--no-ff', branch, '-m', `Merge branch '${branch}'`])
    }

    await completeOnboarding(`E2E git-graph ${Date.now()}`)
  })

  after(() => {
    fixture.cleanup()
  })

  // Always takes a screenshot of the state the test was in when it failed —
  // without this, a `waitForText` that times out leaves no visual proof
  // of which screen was actually open at the end.
  afterEach(async function () {
    if (this.currentTest?.state === 'failed') {
      await snapshot('estado-na-falha').catch(() => {})
    }
  })

  it('opens the Commit Graph panel and takes a real screenshot', async () => {
    await createProjectViaUi(projectName, fixture.path)
    // No agent here on purpose — we only need the project pointing
    // at the repo with real history, no terminal needed.
    await cancelAutoOpenedNewTerminalModal()

    // Diagnostic BEFORE the click — if "Controle Git" isn't clickable,
    // this shows exactly which screen was left open (modal still on top?
    // sidebar on another tab? layout different than expected?).
    await snapshot('antes-de-abrir-controle-git')

    // `completeOnboarding` selects "Português" as part of its own
    // flow — the app ends up in pt-BR, not the E2E_LOCALE default 'en' (which
    // would only apply if something called `applyE2eLocale()` afterward, which we
    // don't do here). Text from this point on follows pt-BR.
    await clickByText('Controle Git')
    // ALWAYS captures the post-click state, even if the expected text never
    // shows up — without this, a failure in waitForText leaves no visual
    // proof of which screen was actually open.
    await browser.pause(800)
    await snapshot('depois-de-abrir-controle-git')

    // `waitForText` (WebdriverIO's `*=text` XPath selector) has proven
    // consistently flaky against this WebView2/tauri-service — in more than
    // one run it timed out even with "main: commit inicial" already
    // visible on screen at the exact instant of the failure (confirmed by comparing the
    // `afterEach` automatic failure screenshot against the log). Since the
    // real goal of this spec is just to CAPTURE the visual state for manual
    // diagnosis (not to make a pass/fail assertion), a generous fixed pause is
    // more reliable here than a text matcher that isn't trustworthy in this
    // environment — the real `git log` load + first graph render lands
    // around 20s on this isolated debug
    // binary.
    await browser.pause(25_000)
    const path = await captureScreenshot('git-graph--diagnostico')
    console.log(`[git-graph diagnostic] screenshot saved at: ${path}`)
  })
})
