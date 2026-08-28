import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT_DIR = fileURLToPath(new URL('../__screenshots__', import.meta.url))

/** Saves a PNG at e2e/__screenshots__/<name>.png and returns the saved path.
 *  Accepts an explicit session (e.g. the web session of a sync test with
 *  two sessions open at the same time) — with no argument, uses the usual
 *  global `browser` session. */
export async function captureScreenshot(
  name: string,
  session: { saveScreenshot: (path: string) => Promise<unknown> } = browser,
): Promise<string> {
  mkdirSync(OUT_DIR, { recursive: true })
  const path = join(OUT_DIR, `${name}.png`)
  await session.saveScreenshot(path)
  return path
}

/**
 * Visually marks (red dot) the element the test is about to
 * click, takes the screenshot, and ONLY THEN actually clicks — explicit request
 * from the owner after seeing a test select the wrong card (Mimo instead of
 * OpenCode) with no visual sign of which element the selector had actually
 * resolved to. This proves, screenshot by screenshot, which element WebDriver
 * really found — not just what the test code INTENDED to click.
 * The marker is a fixed `<div>` positioned via `getBoundingClientRect()`
 * (the real position on screen, not WebDriver's own reading, which can have an
 * offset on embedded drivers) and removed right after the screenshot — no
 * trace is left on the page and it doesn't affect the click itself.
 */
export async function markAndScreenshot(
  element: WebdriverIO.Element,
  name: string,
): Promise<string> {
  // NEVER pass the element itself to `execute()` — `@wdio/tauri-service`
  // swaps `browser.execute` for a version that resolves element
  // references via `executeAsync`, suffering the SAME 30s timeout documented
  // in `perf.ts` (the comment there describes the fix, but that file's
  // code never actually got around to implementing it — confirmed live: it hung without
  // saving any screenshot). `getLocation()`/`getSize()` are native W3C
  // commands (they don't go through `execute()`), and only primitive numbers go into the
  // `execute()` that draws the marker — avoids the whole slow path.
  const [location, size] = await Promise.all([element.getLocation(), element.getSize()])

  await browser.execute(
    (x, y, w, h) => {
      const dot = document.createElement('div')
      dot.id = '__e2e_click_marker__'
      dot.style.position = 'fixed'
      dot.style.left = `${x + w / 2 - 9}px`
      dot.style.top = `${y + h / 2 - 9}px`
      dot.style.width = '18px'
      dot.style.height = '18px'
      dot.style.borderRadius = '50%'
      dot.style.background = 'red'
      dot.style.border = '3px solid white'
      dot.style.boxShadow = '0 0 0 2px red'
      dot.style.zIndex = '2147483647'
      dot.style.pointerEvents = 'none'
      document.body.appendChild(dot)
    },
    location.x,
    location.y,
    size.width,
    size.height,
  )

  const path = await captureScreenshot(name)

  await browser.execute(() => {
    document.getElementById('__e2e_click_marker__')?.remove()
  })

  return path
}

/** Marks + screenshots + clicks, in that order — combines `markAndScreenshot` with the
 *  actual click, so every "important" click in a spec leaves visual
 *  proof of which element was resolved before acting on it. */
export async function markScreenshotAndClick(
  element: WebdriverIO.Element,
  name: string,
): Promise<string> {
  const path = await markAndScreenshot(element, name)
  await element.click()
  return path
}
