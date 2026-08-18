import { describe, expect, it } from 'vitest'

import agentCanvasUtilsSource from './agentCanvasUtils.ts?raw'
import experimentalAgentPolicySource from './experimentalAgentPolicy.ts?raw'
import agentSandboxStoreSource from '../stores/agentSandboxStore.ts?raw'
import {
  codexApprovalDenial,
  codexThreadStartParams,
  codexTurnStartParams,
  guardedExecArgsFor,
} from './experimentalAgentPolicy'

describe('experimental agent guarded defaults', () => {
  it('launches Claude without bypassing permission checks', () => {
    const args = guardedExecArgsFor('claude', 'do it')

    expect(args).toEqual(['-p', 'do it'])
    expect(args?.join(' ')).not.toContain('--dangerously-skip-permissions')
  })

  it('launches Codex with explicit guarded CLI policy', () => {
    const args = guardedExecArgsFor('codex', 'do it')

    expect(args).toEqual([
      '--ask-for-approval',
      'on-request',
      '--sandbox',
      'workspace-write',
      'exec',
      '--skip-git-repo-check',
      'do it',
    ])
    expect(args?.join(' ')).not.toContain('danger-full-access')
  })

  it('uses guarded app-server policy for threads and every turn', () => {
    expect(codexThreadStartParams('C:/repo')).toEqual({
      cwd: 'C:/repo',
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
    })
    expect(codexTurnStartParams('thread-1', 'do it')).toEqual({
      threadId: 'thread-1',
      input: [{ type: 'text', text: 'do it' }],
      approvalPolicy: 'on-request',
    })
  })

  it('declines command and file approval requests instead of accepting them', () => {
    expect(codexApprovalDenial('item/commandExecution/requestApproval')).toEqual({
      response: { decision: 'decline' },
      statusMessage: 'Command approval required; request denied and worker paused.',
    })
    expect(codexApprovalDenial('item/fileChange/requestApproval')).toEqual({
      response: { decision: 'decline' },
      statusMessage: 'File change approval required; request denied and worker paused.',
    })
    expect(codexApprovalDenial('turn/completed')).toBeNull()
  })

  it('keeps dangerous defaults and automatic acceptance out of both experimental modes', () => {
    const sources = [agentSandboxStoreSource, agentCanvasUtilsSource, experimentalAgentPolicySource]

    for (const source of sources) {
      expect(source).not.toContain('--dangerously-skip-permissions')
      expect(source).not.toMatch(/approvalPolicy\s*:\s*['"]never['"]/)
      expect(source).not.toContain('danger-full-access')
      expect(source).not.toMatch(/decision\s*:\s*['"]accept['"]/)
    }
  })
})
