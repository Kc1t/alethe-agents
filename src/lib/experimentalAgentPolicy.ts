import type { AgentType } from './types'

export const CODEX_APPROVAL_POLICY = 'on-request' as const
export const CODEX_SANDBOX = 'workspace-write' as const

const CODEX_GUARDED_CLI_ARGS = [
  '--ask-for-approval',
  CODEX_APPROVAL_POLICY,
  '--sandbox',
  CODEX_SANDBOX,
] as const

export function guardedCodexCliArgs(): string[] {
  return [...CODEX_GUARDED_CLI_ARGS]
}

export function guardedExecArgsFor(agent: AgentType, task: string): string[] | undefined {
  switch (agent) {
    case 'codex':
      return [...guardedCodexCliArgs(), 'exec', '--skip-git-repo-check', task]
    case 'claude':
      return ['-p', task]
    case 'opencode':
      return ['run', task]
    default:
      return undefined
  }
}

export function codexThreadStartParams(cwd: string) {
  return {
    cwd,
    approvalPolicy: CODEX_APPROVAL_POLICY,
    sandbox: CODEX_SANDBOX,
  }
}

export function codexTurnStartParams(threadId: string, text: string) {
  return {
    threadId,
    input: [{ type: 'text' as const, text }],
    approvalPolicy: CODEX_APPROVAL_POLICY,
  }
}

type ApprovalDenial = {
  response: { decision: 'decline' }
  statusMessage: string
}

export function codexApprovalDenial(method: string): ApprovalDenial | null {
  if (method === 'item/commandExecution/requestApproval') {
    return {
      response: { decision: 'decline' },
      statusMessage: 'Command approval required; request denied and worker paused.',
    }
  }
  if (method === 'item/fileChange/requestApproval') {
    return {
      response: { decision: 'decline' },
      statusMessage: 'File change approval required; request denied and worker paused.',
    }
  }
  return null
}
