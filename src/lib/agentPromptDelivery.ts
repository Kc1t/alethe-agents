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
      if (
        (fingerprintStart.length > 0 && screenNorm.includes(fingerprintStart)) ||
        (fingerprintEnd.length > 0 && screenNorm.includes(fingerprintEnd))
      ) {
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

export const SUBMIT_SETTLE_MS = 150

export type PromptSubmitIo = {
  writeChunked: (text: string) => Promise<void>
  write: (data: string) => Promise<void>
  sleep: (ms: number) => Promise<void>
  /** Runs right before the Enter; throwing leaves the pasted text unsent. */
  beforeEnter?: () => void
}

/** Pastes a prompt and submits it with one Enter, after the TUI has taken the paste in. */
export async function pasteAndSubmit(text: string, io: PromptSubmitIo): Promise<void> {
  await io.writeChunked(text)
  await io.sleep(SUBMIT_SETTLE_MS)
  io.beforeEnter?.()
  await io.write('\r')
}

/** Claude Code's permission and trust menus: "❯ 1. Yes", optionally inside a box border. */
const CHOICE_PROMPT_LINE = /^\s*│?\s*[❯›>]?\s*1\.\s+Yes\b/

/**
 * True when the screen shows one of Claude Code's own choice menus. A submit's Enter there would
 * pick the highlighted option, i.e. approve a tool call nobody approved.
 */
export function looksLikeChoicePrompt(screen: string): boolean {
  return screen.split('\n').some((line) => CHOICE_PROMPT_LINE.test(line))
}

/** The parts of an xterm.js `IBuffer` the screen read needs. */
export type ScreenBuffer = {
  /** First row of the live screen; rows above it are scrollback. */
  baseY: number
  /** Cursor row, relative to `baseY`. */
  cursorY: number
  length: number
  getLine: (y: number) => { translateToString: (trimRight?: boolean) => string } | undefined
}

/**
 * The live screen (`rows` lines from `baseY`, and down to the cursor), as rendered text. Not the
 * last N lines: Claude Code draws inline from the top, so in a tall pane its menu can sit far
 * above the bottom row.
 */
export function readLiveScreen(buffer: ScreenBuffer, rows: number): string {
  const end = Math.min(
    buffer.length,
    Math.max(buffer.baseY + rows, buffer.baseY + buffer.cursorY + 1),
  )
  const lines: string[] = []
  for (let y = Math.max(0, buffer.baseY); y < end; y++) {
    const line = buffer.getLine(y)
    if (line) lines.push(line.translateToString(true))
  }
  return lines.join('\n')
}

/** A submit refused because the terminal shows a choice menu (see `looksLikeChoicePrompt`). */
export class TerminalPromptOpenError extends Error {
  constructor() {
    super('The terminal is showing a choice prompt')
    this.name = 'TerminalPromptOpenError'
  }
}

/**
 * A submit refused because the pane is out of view: Rust streams no output to a hidden pane, so
 * its screen is stale and the choice-menu check above cannot be trusted.
 */
export class PaneHiddenError extends Error {
  constructor() {
    super('The terminal pane is not visible')
    this.name = 'PaneHiddenError'
  }
}
