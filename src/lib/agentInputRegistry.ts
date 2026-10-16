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
