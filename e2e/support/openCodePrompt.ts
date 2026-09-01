import { deliverOpenCodePrompt } from '../../src/lib/agentPromptDelivery'
import { readPtyScrollback, writePtyData, DEFAULT_PROFILE_ID } from './ptyAgent'

/**
 * Pattern for stripping ANSI sequences (same format used by the
 * `ansi-regex`/`strip-ansi` package, rewritten here via `RegExp` + explicit
 * unicode escapes — never literal control characters embedded in the source —
 * instead of depending on a transitive package not declared directly in
 * `package.json`). Necessary because `attach_pty` returns the RAW scrollback
 * from the backend (ANSI still embedded) — quite different from the already-rendered
 * buffer the real app reads from xterm.js (see the large comment in
 * `agentPromptDelivery.ts` about why this matters for the matching
 * to work).
 */
const ANSI_PATTERN = new RegExp(
  [
    '[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\\d/#&.:=?%@~_]+)*|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d/#&.:=?%@~_]*)*)?\\u0007)',
    '(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-ntqry=><~]))',
  ].join('|'),
  'g',
)

function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '')
}

/**
 * Sends a work prompt to OpenCode reusing EXACTLY the same
 * typing/confirmation logic as the real app (`deliverOpenCodePrompt`,
 * `src/lib/agentPromptDelivery.ts`) — it only swaps "reading the screen" (the
 * xterm.js buffer in the app; the backend scrollback, stripped of ANSI, here) and "writing"
 * (the app's writePty; `write_pty` via Tauri here). Explicit request: don't
 * reinvent a new heuristic for something that has already been tested and approved
 * live — just fit it into the test environment.
 */
export async function sendOpenCodePrompt(
  ptyId: string,
  prompt: string,
  opts: { timeoutMs?: number; profileId?: string } = {},
): Promise<boolean> {
  const profileId = opts.profileId ?? DEFAULT_PROFILE_ID
  const deadline = Date.now() + (opts.timeoutMs ?? 120_000)
  return deliverOpenCodePrompt(prompt, deadline, {
    readScreenText: async () => stripAnsi(await readPtyScrollback(ptyId, 65536, profileId)),
    write: (data) => writePtyData(ptyId, data, profileId),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    isCancelled: () => false,
  })
}
