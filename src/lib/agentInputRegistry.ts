/**
 * How code outside a pane types into its agent. `useXtermSession` registers each agent PTY with
 * a submit that knows the terminal's bracketed-paste mode and arms its completion monitor, which a
 * bare `writePty` cannot do.
 */
export type AgentInput = {
  submit: (text: string) => Promise<void>
  interrupt: () => Promise<void>
  /** The recent terminal text (scrollback tail and screen), for agents with no transcript. */
  readScreen: () => string
}

const inputs = new Map<string, AgentInput>()

export function registerAgentInput(ptyId: string, input: AgentInput): () => void {
  inputs.set(ptyId, input)
  return () => {
    if (inputs.get(ptyId) === input) inputs.delete(ptyId)
  }
}

export function agentInputFor(ptyId: string): AgentInput | null {
  return inputs.get(ptyId) ?? null
}

/** How long a pane brought to front gets to mount its terminal before a send gives up. */
const INPUT_WAIT_MS = 2_000
const INPUT_POLL_MS = 100
/** A terminal that just mounted replays its screen; the choice-menu guard reads it after this. */
const INPUT_SETTLE_MS = 300

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * The input of a pane just brought to front, once its terminal mounts and settles; null when it
 * does not within `INPUT_WAIT_MS`, or `current` turns false meanwhile.
 */
export async function waitForAgentInput(
  ptyId: string,
  current: () => boolean = () => true,
  lookup: (ptyId: string) => AgentInput | null = agentInputFor,
): Promise<AgentInput | null> {
  for (let waited = 0; waited < INPUT_WAIT_MS; waited += INPUT_POLL_MS) {
    await sleep(INPUT_POLL_MS)
    if (!current()) return null
    if (!lookup(ptyId)) continue
    await sleep(INPUT_SETTLE_MS)
    return current() ? lookup(ptyId) : null
  }
  return null
}
