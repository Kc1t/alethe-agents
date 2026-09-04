/**
 * Initial prompt delivery for OpenCode — extracted from `useXtermSession.ts`
 * (`sendInitialInput`) to be reusable outside the real app (e.g. the Merge
 * Center's e2e suite, which needs to send real work prompts to the same CLI
 * without duplicating/reinventing this logic). Behavior IDENTICAL to the
 * original — just parameterized (how to read the screen, how to write, how
 * to sleep, how to know if cancelled) so it works both over xterm.js's
 * rendered buffer (real app) and over the backend's raw scrollback, already
 * cleaned of ANSI (e2e).
 *
 * Every detail below was confirmed LIVE, repeatedly, against OpenCode's
 * actual behavior — these are not theoretical heuristics:
 * - scanning the raw byte stream breaks any string match (ANSI interleaved
 *   with the text) — so the source of truth is the already-rendered/clean
 *   screen, never the raw bytes;
 * - a single write with the whole prompt never shows up on screen — it
 *   needs to simulate real typing, in small chunks with a breath between
 *   each;
 * - the input box only shows the "Ask anything" placeholder when it's
 *   empty — used to decide whether it's safe to retype (nothing to
 *   duplicate);
 * - a single Enter sometimes doesn't trigger the send on its own — only
 *   resend if the screen stays EXACTLY the same (nothing happened), never
 *   use "the box emptied" as the stop criterion (the "esc interrupt"
 *   footer only shows up with text sitting in the box, not while
 *   processing anything).
 */
export type OpenCodePromptDeliveryIo = {
  /** Text of the screen ALREADY rendered/cleaned (no raw ANSI sequences).
   *  May be synchronous (xterm.js's local buffer, real app) or asynchronous
   *  (network round-trip to the backend, e2e) — always used with `await`. */
  readScreenText: () => string | Promise<string>
  write: (data: string) => Promise<void>
  sleep: (ms: number) => Promise<void>
  isCancelled: () => boolean
}

function normalizeForMatch(text: string): string {
  // Strips EVERYTHING that isn't a letter/digit — not just whitespace.
  // OpenCode's input box has a decorative border (vertical bar) at the
  // start of each drawn line; since it isn't whitespace, it leaked into the
  // middle of the read text whenever the prompt wrapped a line, breaking
  // any exact comparison. Normalizing both sides (screen and prompt) the
  // same way makes the border/punctuation/line-break disappear, leaving
  // only the "skeleton" of letters.
  return text.replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase()
}

const PLACEHOLDER_FINGERPRINT = normalizeForMatch('Ask anything')
const TYPE_CHUNK_SIZE = 6
const TYPE_CHUNK_DELAY_MS = 30
const CONFIRM_POLL_MS = 700
const CONFIRM_ROUND_BUDGET_MS = 8_000
const MAX_ENTER_ATTEMPTS = 4

/**
 * Types `prompt` into OpenCode and confirms it was actually delivered
 * (shows up on screen) before sending the Enter that confirms the send.
 * Returns `false` if `deadline` passes without ever confirming the text on
 * screen — the caller decides what to do (the real app gives up with a
 * warning; e2e should treat this as a real test failure, never a silent
 * success).
 */
export async function deliverOpenCodePrompt(
  prompt: string,
  deadline: number,
  io: OpenCodePromptDeliveryIo,
): Promise<boolean> {
  // Uses the END of the prompt as the fingerprint, not the start: the
  // prompt is long enough to fill the whole input box on its own, and the
  // start may no longer be visible (OpenCode's own line wrapping, or the
  // box's internal scroll) by the time typing finishes — the end is always
  // where the cursor just finished writing.
  const normalizedPrompt = normalizeForMatch(prompt)
  const fingerprintStart = normalizedPrompt.slice(0, 20)
  const fingerprintEnd = normalizedPrompt.slice(-20)
  // A fingerprint of the MIDDLE as well: confirming only start OR end let a prompt through that had
  // been cut in half, when a stretch of the middle was lost during chunked typing (a redraw of the
  // box, a write race). The start and end still matched while the actual content was truncated. The
  // middle is the only point that proves nothing vanished between the two ends.
  const midPoint = Math.floor(normalizedPrompt.length / 2)
  const fingerprintMid = normalizedPrompt.slice(
    Math.max(0, midPoint - 10),
    Math.max(0, midPoint - 10) + 20,
  )
  const boxLooksEmpty = async () => {
    const screenNorm = normalizeForMatch(await io.readScreenText())
    return (
      screenNorm.includes(PLACEHOLDER_FINGERPRINT) ||
      (!screenNorm.includes(fingerprintStart) && !screenNorm.includes(fingerprintEnd))
    )
  }

  const typePrompt = async () => {
    for (let index = 0; index < prompt.length; index += TYPE_CHUNK_SIZE) {
      await io.write(prompt.slice(index, index + TYPE_CHUNK_SIZE))
      await io.sleep(TYPE_CHUNK_DELAY_MS)
    }
  }

  // Each round only retypes if the box still looks empty — tested live,
  // Ctrl+U doesn't clear OpenCode's multi-line editor, so retyping over
  // text that already arrived (just not confirmed yet) stacks duplicate
  // copies in the box (visible spam). But if OpenCode simply ignored the
  // typing entirely (not ready to receive input yet), this next round
  // tries typing again.
  let confirmedOnScreen = false
  let firstRound = true
  for (let round = 0; !io.isCancelled() && !confirmedOnScreen && Date.now() < deadline; round++) {
    if (firstRound || (await boxLooksEmpty())) {
      firstRound = false
      await typePrompt()
    }
    const roundDeadline = Math.min(deadline, Date.now() + CONFIRM_ROUND_BUDGET_MS)
    while (!io.isCancelled() && Date.now() < roundDeadline) {
      const screenNorm = normalizeForMatch(await io.readScreenText())
      const endMatches = fingerprintEnd.length > 0 && screenNorm.includes(fingerprintEnd)
      const midMatches = fingerprintMid.length === 0 || screenNorm.includes(fingerprintMid)
      if (endMatches && midMatches) {
        confirmedOnScreen = true
        break
      }
      await io.sleep(CONFIRM_POLL_MS)
    }
  }
  if (!confirmedOnScreen) return false

  // Confirmed live: the text arrives perfectly in the box, but a single
  // Enter sometimes doesn't trigger the send on its own. "The box emptied"
  // doesn't work as a stop criterion here. Safer criterion: compare the
  // WHOLE screen before/after — only resend Enter if the screen stays
  // EXACTLY the same (nothing happened, the Enter didn't register). As soon
  // as the screen changes in any way — it sent, or the agent already
  // started writing the response — stop right there and never resend again.
  await io.sleep(150)
  let previousScreen = await io.readScreenText()
  for (
    let attempt = 0;
    attempt < MAX_ENTER_ATTEMPTS && !io.isCancelled() && Date.now() < deadline;
    attempt++
  ) {
    await io.write('\r')
    await io.sleep(1_500)
    const currentScreen = await io.readScreenText()
    if (currentScreen !== previousScreen) break
    previousScreen = currentScreen
  }
  return true
}
