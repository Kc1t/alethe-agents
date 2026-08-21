/**
 * Generic navigation kit for real clicking/typing — explicit request from the
 * owner so we don't need to write a new function every time we want to
 * explore/click something in the UI. The usual rules still apply:
 * NEVER click "Browse" (triggers Windows' native folder picker,
 * which hangs WebDriver); every click takes a screenshot with a red marker
 * BEFORE clicking (`markScreenshotAndClick`); never use `window.__ALETHE_E2E__`
 * to trigger an action — hooks are only for READING state (see `projectUi.ts`).
 *
 * Difference from `projectUi.ts`: those helpers are SPECIFIC to already
 * mapped flows (create project, git init, etc.) with known exact selectors.
 * This file is GENERIC — for clicking on anything by visible text,
 * without needing to know the component's exact structure ahead of time. Use
 * `projectUi.ts` when the flow already has a dedicated helper (more precise,
 * already hardened against known collisions); use this file to explore
 * new screens or one-off cases.
 */
import { markScreenshotAndClick, captureScreenshot } from './screenshot'

let shotCounter = 0
function nextShotName(label: string): string {
  shotCounter += 1
  // The text of the clicked element becomes part of the file name (e.g.
  // `click-${text}`) — if the text has a "/" (common in model ids, like
  // "opencode/deepseek-v4-flash-free"), `captureScreenshot`'s `path.join`
  // interprets it as a directory separator and breaks with "directory doesn't
  // exist" (a real bug, confirmed live — nothing to do with the click itself,
  // which worked fine). Sanitizes any unsafe file-name character
  // before building the name.
  const safeLabel = label.replace(/[/\\:*?"<>|]/g, '_')
  return `uikit--${String(shotCounter).padStart(3, '0')}-${safeLabel}`
}

/**
 * Clicks on ANY clickable element (button, a, [role="button"]) whose
 * visible text contains `text` — with a marker screenshot before the click.
 * If there's more than one match, uses the FIRST one in the DOM by default (`index`
 * adjusts this) — prefer `scopeSelector` to avoid ambiguity instead of
 * relying on the index, especially on screens with repeated labels (has already
 * bitten this suite before: "OpenCode" appears in more than one place).
 */
export async function clickByText(
  text: string,
  opts: { index?: number; scopeSelector?: string; timeout?: number } = {},
): Promise<void> {
  const { index = 0, scopeSelector, timeout = 10_000 } = opts
  const base = scopeSelector ? await $(scopeSelector) : browser
  // WebdriverIO does NOT understand a comma-separated multi-selector the way
  // normal CSS does — you need to query each strategy separately and
  // merge the results (a real bug, confirmed live: a selector like
  // `button*=X, a*=X` turned into a SINGLE xpath, with the comma inside the searched
  // text, and always failed with "invalid selector"). Icon-only buttons
  // (e.g. "More actions") have no visible text, only `aria-label`/`title`.
  // `label` is on the list because the recorder (`e2e/support/recorder.ts`)
  // captures `<label>` text (e.g. a checkbox caption) as a valid click
  // target — without this, a recorded step clicking on a label would never
  // find anything on replay (a real bug, confirmed live: "Automatic
  // agent isolation..." is the caption of a checkbox, not a button).
  const strategies = [`button*=${text}`, `a*=${text}`, `[role="button"]*=${text}`, `label*=${text}`]
  const findCandidates = async (): Promise<WebdriverIO.Element[]> => {
    let found: WebdriverIO.Element[] = []
    for (const strategy of strategies) {
      found = found.concat(await base.$$(strategy).catch(() => []))
    }
    if (found.length === 0) {
      for (const strategy of [`[aria-label*="${text}"]`, `[title*="${text}"]`]) {
        found = found.concat(await base.$$(strategy).catch(() => []))
      }
    }
    return found
  }

  // Searching only once gave a false negative on text that only appears after
  // an async check resolves (e.g. the "Initialize Git repository"
  // banner only renders after `gitStatus()` responds — confirmed
  // live: `clickByText` failed immediately with "not found" even though the button
  // appeared half a second later). Short poll before giving up for good.
  let candidates = await findCandidates()
  const deadline = Date.now() + timeout
  while (candidates.length <= index && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 300))
    candidates = await findCandidates()
  }
  if (!candidates[index]) {
    throw new Error(
      `clickByText: no clickable element with text/aria-label/title "${text}" found${scopeSelector ? ` inside "${scopeSelector}"` : ''} (index ${index})`,
    )
  }
  // `waitForClickable` (WebDriver's overlap check) sometimes gives a
  // false negative on menus rendered via portal (`createPortal` straight
  // into `document.body`, e.g. `Dropdown.tsx`) — confirmed live: the screenshot
  // clearly showed the item visible and clickable, but the check never
  // passed. Tries waiting normally first; if it times out,
  // still attempts the actual click (WebDriver's `click()` command does its
  // own scroll-into-view and tends to work even when the
  // pre-check is overly conservative) instead of giving up right away.
  await candidates[index].waitForClickable({ timeout }).catch(() => {})

  // The layout can change BETWEEN attempts (e.g. a banner above the target disappears
  // after an async check resolves — confirmed live: clicking
  // "Initialize Git repository" reflowed the section right below, and an immediate
  // click on the next card targeted the OLD position, "element not
  // interactable", for ~30s of WebDriver's own automatic retry before
  // giving up). RE-QUERIES the element from scratch on every attempt — never
  // reuses the already-resolved reference — to always click at the current
  // position, not the one from when `findCandidates()` first ran.
  let lastError: unknown = null
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fresh = (await findCandidates())[index]
      if (!fresh) throw new Error(`clickByText: "${text}" disappeared from the screen between click attempts`)
      await markScreenshotAndClick(fresh, nextShotName(`click-${text.slice(0, 30)}`))
      return
    } catch (err) {
      lastError = err
      await new Promise((resolve) => setTimeout(resolve, 400))
    }
  }
  throw lastError
}

/**
 * Clicks the Nth `<button>` (default: first) inside the parent container of
 * a `<label>` found by text — for buttons whose OWN text changes
 * dynamically (e.g. the `ModelSearchablePicker` trigger, which shows the
 * currently selected model as text — recording a click by that trigger's
 * literal text won't replay correctly if the default model is different).
 * The neighboring `<label>` text (e.g. "Agent model (OPENCODE)") is much
 * more stable across runs.
 */
export async function clickNearLabel(labelText: string, nth = 0): Promise<void> {
  const label = await $(`label*=${labelText}`)
  await label.waitForDisplayed({ timeout: 10_000 })
  const container = await label.$('..')
  const buttons = await container.$$('button')
  const target = buttons[nth]
  if (!target) {
    throw new Error(
      `clickNearLabel: no <button> (index ${nth}) found near label "${labelText}"`,
    )
  }
  await markScreenshotAndClick(target, nextShotName(`click-near-label-${labelText.slice(0, 30)}`))
}

/**
 * Types into a field found by placeholder OR associated label — NEVER use it
 * for folder fields that have a "Browse" button next to them without confirming
 * first that it's safe (those always accept direct typing in this app, but
 * confirm by reading the component if it's a new/unknown field).
 */
export async function typeIntoByPlaceholder(placeholder: string, value: string): Promise<void> {
  const input = await $(
    `input[placeholder="${placeholder}"], textarea[placeholder="${placeholder}"]`,
  )
  await input.waitForDisplayed({ timeout: 10_000 })
  await input.setValue(value)
  const actual = await input.getValue()
  if (actual !== value) {
    throw new Error(
      `typeIntoByPlaceholder: field "${placeholder}" received "${actual}", expected "${value}"`,
    )
  }
}

export async function typeIntoBySelector(selector: string, value: string): Promise<void> {
  const input = await $(selector)
  await input.waitForDisplayed({ timeout: 10_000 })
  await input.setValue(value)
}

/**
 * NEVER click the "Browse" button next to a folder field — it opens
 * Windows' NATIVE folder picker, outside the webview, which WebDriver can't
 * see or close (hangs the session). Every folder field in this app accepts
 * direct typing into the `<input>` — this is the CANONICAL helper for
 * that, with an explicit name to make it obvious which path to use in any new
 * exploration. Under the hood it's the same `typeIntoByPlaceholder`, just with
 * the name shouting the intent.
 */
export async function typePath(placeholder: string, path: string): Promise<void> {
  await typeIntoByPlaceholder(placeholder, path)
}

/** Waits for a text to appear anywhere on screen — useful for confirming
 *  that an action took effect without needing to know the exact selector. */
export async function waitForText(text: string, timeout = 10_000): Promise<void> {
  await browser.waitUntil(async () => await $(`*=${text}`).isExisting(), {
    timeout,
    timeoutMsg: `text "${text}" never appeared on screen`,
  })
}

/** Confirms that a text is NO LONGER on screen — the counterpart of `waitForText`. */
export async function waitForTextGone(text: string, timeout = 10_000): Promise<void> {
  await browser.waitUntil(async () => !(await $(`*=${text}`).isExisting()), {
    timeout,
    timeoutMsg: `text "${text}" remained on screen longer than expected`,
  })
}

/** Named screenshot, no marker — for recording the screen state at some
 *  point during exploration, without being tied to a specific click. */
export async function snapshot(label: string): Promise<string> {
  return captureScreenshot(nextShotName(label))
}

/**
 * Drags the mouse in a precise, adjustable way — explicit request from the owner,
 * for things like resizing a panel by dragging the divider (the class of
 * desktop↔web resize sync bug that drove a good part of
 * this session) or any real drag that a simple click doesn't cover. Uses WebDriver's
 * W3C Actions API (`browser.action('pointer')`), not an instant "drop" —
 * the movement is split into `steps` increments, each with its
 * own duration, because some resize/drag handlers only fire
 * correctly with gradual movement (a single jump from A to B might not
 * emit the intermediate events the app listens for).
 *
 * `deltaX`/`deltaY` are relative to the CENTER of the element at `selector`
 * (positive = right/down, negative = left/up — maps directly to the
 * 4 directions the owner asked for). `repetitions` repeats the whole drag N
 * times, with a pause between each one (`repetitionPauseMs`) — useful for stress-testing
 * an incremental resize or confirming it always converges to the same place.
 */
export async function dragBy(
  selector: string,
  opts: {
    deltaX?: number
    deltaY?: number
    steps?: number
    stepDurationMs?: number
    repetitions?: number
    repetitionPauseMs?: number
  } = {},
): Promise<void> {
  const {
    deltaX = 0,
    deltaY = 0,
    steps = 5,
    stepDurationMs = 80,
    repetitions = 1,
    repetitionPauseMs = 200,
  } = opts

  for (let rep = 0; rep < repetitions; rep++) {
    const el = await $(selector)
    await el.waitForDisplayed({ timeout: 10_000 })
    const location = await el.getLocation()
    const size = await el.getSize()
    const startX = Math.round(location.x + size.width / 2)
    const startY = Math.round(location.y + size.height / 2)

    const action = browser.action('pointer', { parameters: { pointerType: 'mouse' } })
    action.move({ x: startX, y: startY }).down({ button: 0 })
    for (let step = 1; step <= steps; step++) {
      const x = Math.round(startX + (deltaX * step) / steps)
      const y = Math.round(startY + (deltaY * step) / steps)
      action.move({ duration: stepDurationMs, x, y })
    }
    action.up({ button: 0 })
    await action.perform()

    if (rep < repetitions - 1) {
      await new Promise((resolve) => setTimeout(resolve, repetitionPauseMs))
    }
  }
}

/**
 * Drags from one element to ANOTHER element (instead of a relative delta) —
 * useful when the final target is known (e.g. dropping onto a specific pane)
 * instead of a calculated distance.
 */
export async function dragFromTo(
  fromSelector: string,
  toSelector: string,
  opts: { steps?: number; stepDurationMs?: number } = {},
): Promise<void> {
  const { steps = 5, stepDurationMs = 80 } = opts
  const from = await $(fromSelector)
  const to = await $(toSelector)
  await from.waitForDisplayed({ timeout: 10_000 })
  await to.waitForDisplayed({ timeout: 10_000 })

  const fromLoc = await from.getLocation()
  const fromSize = await from.getSize()
  const toLoc = await to.getLocation()
  const toSize = await to.getSize()
  const startX = Math.round(fromLoc.x + fromSize.width / 2)
  const startY = Math.round(fromLoc.y + fromSize.height / 2)
  const endX = Math.round(toLoc.x + toSize.width / 2)
  const endY = Math.round(toLoc.y + toSize.height / 2)

  const action = browser.action('pointer', { parameters: { pointerType: 'mouse' } })
  action.move({ x: startX, y: startY }).down({ button: 0 })
  for (let step = 1; step <= steps; step++) {
    const x = Math.round(startX + ((endX - startX) * step) / steps)
    const y = Math.round(startY + ((endY - startY) * step) / steps)
    action.move({ duration: stepDurationMs, x, y })
  }
  action.up({ button: 0 })
  await action.perform()
}

/** Scrolls an element into the visible area — a thin wrapper over
 *  WebDriver's native command, useful before checking/clicking something that might
 *  be off screen (e.g. an option at the end of a long list, a panel with
 *  internal scroll like the Preferences tabs). */
export async function scrollIntoView(selector: string): Promise<void> {
  const el = await $(selector)
  await el.waitForExist({ timeout: 10_000 })
  await el.scrollIntoView({ block: 'center', inline: 'nearest' })
}

/**
 * Scrolls the page (or the element at `selector`, if given) by a
 * number of pixels — via the W3C wheel action (`browser.action('wheel')`),
 * which simulates real mouse scrolling, unlike setting
 * `scrollTop` directly via JS (which some components with virtualized scroll
 * or `wheel` listeners don't react to). Positive `deltaY` scrolls down,
 * negative scrolls up; positive `deltaX` scrolls right, negative scrolls left —
 * the same convention as the browser's native wheel events.
 */
export async function scrollBy(
  deltaX: number,
  deltaY: number,
  opts: { selector?: string; originX?: number; originY?: number } = {},
): Promise<void> {
  let originX = opts.originX ?? Math.round((await browser.getWindowSize()).width / 2)
  let originY = opts.originY ?? Math.round((await browser.getWindowSize()).height / 2)

  if (opts.selector) {
    const el = await $(opts.selector)
    await el.waitForDisplayed({ timeout: 10_000 })
    const location = await el.getLocation()
    const size = await el.getSize()
    originX = Math.round(location.x + size.width / 2)
    originY = Math.round(location.y + size.height / 2)
  }

  await browser
    .action('wheel')
    .scroll({ x: originX, y: originY, deltaX, deltaY, duration: 200 })
    .perform()
}

/**
 * Runs `fn()` and, if it hasn't resolved within `idleMs` (default 5s), takes an
 * automatic screenshot BEFORE continuing to wait — explicit request from the owner:
 * "when it's been 5 seconds with no interaction, take a screenshot, a moment
 * before failing". Doesn't cancel `fn()` or affect the result, just captures the
 * screen state at the moment something is taking longer than expected, to
 * diagnose failures without needing to guess ahead of time where to place
 * `snapshot()` manually.
 */
export async function withIdleScreenshot<T>(
  label: string,
  fn: () => Promise<T>,
  idleMs = 5_000,
): Promise<T> {
  let done = false
  const timer = setTimeout(() => {
    if (!done) void snapshot(`${label}-stalled-${idleMs}ms`).catch(() => {})
  }, idleMs)
  try {
    return await fn()
  } finally {
    done = true
    clearTimeout(timer)
  }
}

/**
 * Accepts a native `confirm()`/`alert()` if one appears within `timeout`
 * — doesn't fail if none appears (some flows only show the dialog
 * sometimes). Use after a `clickByText` that MAY trigger a confirmation.
 */
export async function acceptAlertIfPresent(timeout = 3_000): Promise<boolean> {
  const appeared = await browser
    .waitUntil(async () => (await browser.getAlertText().catch(() => null)) !== null, {
      timeout,
      interval: 250,
    })
    .catch(() => false)
  if (appeared) await browser.acceptAlert()
  return appeared
}
