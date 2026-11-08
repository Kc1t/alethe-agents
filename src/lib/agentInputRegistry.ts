export type AgentInput = {
  submit: (text: string) => Promise<void>
  interrupt: () => Promise<void>
  readScreen: (lines: number) => string
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

const INPUT_WAIT_MS = 2_000
const INPUT_POLL_MS = 100
// a terminal that just mounted replays its screen before the choice-menu guard can read it
const INPUT_SETTLE_MS = 300

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export async function waitForAgentInput(
  ptyId: string,
  lookup: (ptyId: string) => AgentInput | null = agentInputFor,
): Promise<AgentInput | null> {
  for (let waited = 0; waited < INPUT_WAIT_MS; waited += INPUT_POLL_MS) {
    await sleep(INPUT_POLL_MS)
    if (!lookup(ptyId)) continue
    await sleep(INPUT_SETTLE_MS)
    return lookup(ptyId)
  }
  return null
}
