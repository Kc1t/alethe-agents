/**
 * Every e2e profile is born ISOLATED AND EMPTY (explicit request from the owner, after
 * catching a test running against his real profile) — that's why ANY
 * spec that needs to get past the initial screen lands on onboarding first, not
 * directly on the screen the spec wants to test. `onboarding.spec.ts` tests this
 * flow in detail (with its own assertions); this helper only EXISTS TO
 * GET THROUGH it in a real way (click/typing, never a hook) in specs that
 * have a different focus — forgetting this hangs the spec right at the start, waiting for a
 * field that never appears because onboarding is still blocking the screen (a
 * real bug seen live in this session, in the first draft of git-pipeline).
 */
import { markScreenshotAndClick } from './screenshot'

let step = 0
function nextShotName(label: string): string {
  step += 1
  return `onboarding-flow--${String(step).padStart(2, '0')}-${label}`
}

/**
 * Idempotent: if onboarding was already completed (profile reused between
 * specs, or a previous session already went through here), the `#onboarding-name` field
 * never appears — detects this quickly (short timeout) and returns without error, instead
 * of hanging for 15s waiting for a screen that won't show up. Explicit request
 * from the owner: "a simple tool that gets through login", always safe to
 * call at the start of any new spec, whether or not the profile's state is known.
 */
export async function completeOnboarding(displayName: string): Promise<void> {
  const nameInput = await $('#onboarding-name')
  const appeared = await nameInput.waitForDisplayed({ timeout: 15_000 }).catch(() => false)
  if (!appeared) return
  await nameInput.setValue(displayName)

  const ptButton = await $('[role="dialog"]').$('button=PT')
  if (await ptButton.isExisting()) {
    await markScreenshotAndClick(ptButton, nextShotName('select-pt-br'))
  }

  for (let index = 0; index < 10; index += 1) {
    const next = await $('[role="dialog"] button[class*="buttonPrimary"]')
    if (!(await next.isExisting())) break
    await next.waitForClickable({ timeout: 10_000 })
    await markScreenshotAndClick(next, nextShotName('next-step-' + (index + 1)))
    await browser.pause(300)
  }

  await browser.waitUntil(
    async () => !(await $('[role="dialog"] button[class*="buttonPrimary"]').isExisting()),
    { timeout: 20_000, timeoutMsg: 'onboarding did not close after its last step' },
  )
}

/** A more direct name for the same behavior — "get into the app, regardless of the
 *  profile's state". Use this at the start of ad-hoc exploration specs. */
export const quickLogin = completeOnboarding
