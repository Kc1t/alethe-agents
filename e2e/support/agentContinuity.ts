import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { ensureAgentReady, readPtyScrollback, sendPtyLine, waitUntil } from './ptyAgent'
import { sendOpenCodePrompt } from './openCodePrompt'

const RULE_PREFIX = 'ALETHE_E2E_RULE: '

export type ContinuityResult = {
  file1Path: string
  file2Path: string
  file1Exists: boolean
  file2Exists: boolean
  file2FollowsRule: boolean
  /**
   * True only when both files exist AND the second one followed the rule
   * from the first without it being repeated in the second prompt — proof that the
   * SAME agent session kept real context across the two turns, not
   * just that the CLI can touch a file. If file 2 exists but doesn't
   * follow the rule, the conclusion is that it wasn't the same session — it "was born
   * empty" and just created a new file with no memory of what came before.
   */
  sessionLikelyContinuous: boolean
}

/**
 * Session continuity scenario explicitly requested for this task:
 * prompt 1 tells the agent to create a file with an explicit rule; prompt 2
 * asks for a SECOND file "following the same rule" without repeating it. The system
 * verifies both facts directly on disk (never trusting what the agent
 * *says* it did): file 1 exists, file 2 exists, and the content of
 * file 2 really obeys file 1's rule.
 *
 * Reused across three scenarios in the plan: 1 terminal (baseline), 2
 * simultaneous terminals (concurrency), and "terminal comes back up after the
 * merge" (runs again in a new session, in the already-integrated project).
 */
export async function verifyAgentSessionContinuity(
  ptyId: string,
  worktreePath: string,
  opts: { timeoutMs?: number } = {},
): Promise<ContinuityResult> {
  const timeoutMs = opts.timeoutMs ?? 120_000

  // Defensive pre-check: answers any trust/permission dialog
  // (seen live in Antigravity — "Do you trust the contents of
  // this project?") BEFORE sending any work prompt. The actual prompt
  // delivery (`sendOpenCodePrompt`, below) already reuses the app's real
  // typing/confirmation logic (`agentPromptDelivery.ts`), which
  // already tolerates the CLI still loading on its own — this here only covers the
  // screen BEFORE the prompt box, which that logic doesn't know about.
  await ensureAgentReady(ptyId, { timeoutMs: 60_000 })

  const tag = Math.random().toString(36).slice(2, 8)
  const file1Name = `alethe-e2e-file1-${tag}.txt`
  const file2Name = `alethe-e2e-file2-${tag}.txt`
  const file1Path = join(worktreePath, file1Name)
  const file2Path = join(worktreePath, file2Name)

  const prompt1 =
    `Create a file named "${file1Name}" in the current working directory with exactly 3 lines of ` +
    `plain text. Every single line MUST start with the exact literal prefix "${RULE_PREFIX}" ` +
    `followed by any short unique text of your choice. Do not create any other files, do not add ` +
    'explanation — just create that one file with that exact rule.'
  const delivered1 = await sendOpenCodePrompt(ptyId, prompt1, { timeoutMs })
  if (!delivered1) {
    throw new Error(
      `verifyAgentSessionContinuity: prompt 1 was not confirmed on the OpenCode screen (pty=${ptyId})`,
    )
  }

  await waitUntil(
    async () => {
      if (existsSync(file1Path)) return true
      const screen = await readPtyScrollback(ptyId).catch(() => '')
      if (
        /(allow|approve|permission|do you want to|trust|confirm|accept|\[y\/n\]|\[y\/N\]|\[Y\/n\])/i.test(
          screen,
        )
      ) {
        await sendPtyLine(ptyId, 'y')
      } else if (/(press enter|to continue)/i.test(screen)) {
        await sendPtyLine(ptyId, '')
      }
      return null
    },
    {
      timeoutMs,
      intervalMs: 1000,
    },
  )

  const prompt2 =
    `Now create a second file named "${file2Name}" in the current working directory, with exactly ` +
    '2 lines, following the EXACT SAME rule as the file you just created for me. Do not restate or ' +
    're-explain the rule back to me — you already know it from what you just did. Just apply it.'
  const delivered2 = await sendOpenCodePrompt(ptyId, prompt2, { timeoutMs })
  if (!delivered2) {
    throw new Error(
      `verifyAgentSessionContinuity: prompt 2 was not confirmed on the OpenCode screen (pty=${ptyId})`,
    )
  }

  await waitUntil(
    async () => {
      if (existsSync(file2Path)) return true
      const screen = await readPtyScrollback(ptyId).catch(() => '')
      if (
        /(allow|approve|permission|do you want to|trust|confirm|accept|\[y\/n\]|\[y\/N\]|\[Y\/n\])/i.test(
          screen,
        )
      ) {
        await sendPtyLine(ptyId, 'y')
      } else if (/(press enter|to continue)/i.test(screen)) {
        await sendPtyLine(ptyId, '')
      }
      return null
    },
    {
      timeoutMs,
      intervalMs: 1000,
    },
  )

  const file1Exists = existsSync(file1Path)
  const file2Exists = existsSync(file2Path)
  const file2Lines = file2Exists
    ? readFileSync(file2Path, 'utf8')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
    : []
  const file2FollowsRule =
    file2Lines.length > 0 && file2Lines.every((line) => line.startsWith(RULE_PREFIX))

  return {
    file1Path,
    file2Path,
    file1Exists,
    file2Exists,
    file2FollowsRule,
    sessionLikelyContinuous: file1Exists && file2Exists && file2FollowsRule,
  }
}
