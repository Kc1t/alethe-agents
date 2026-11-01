import { describe, expect, it } from 'vitest'

import agentWorkersSource from '../components/AgentCanvasPOC/hooks/useAgentWorkers.ts?raw'
import sessionTerminalDockSource from '../components/AgentCanvasPOC/SessionTerminalDock.tsx?raw'
import agentSandboxStoreSource from '../stores/agentSandboxStore.ts?raw'
import agentCanvasUtilsSource from './agentCanvasUtils.ts?raw'
import {
  codexApprovalAnswer,
  codexThreadStartParams,
  codexTurnStartParams,
  DEFAULT_EXPERIMENTAL_AGENT_PERMISSION_MODE,
  interactivePermissionArgs,
  normalizeExperimentalAgentPermissionMode,
  oneShotArgs,
} from './experimentalAgentPolicy'
import cloudSyncSource from './sync/scopes/settings.ts?raw'
import type { AgentType } from './types'

const AGENTS: AgentType[] = ['claude', 'codex', 'opencode', 'shell']
const APPROVAL_METHODS = [
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
]
/** Anything that opens an agent up: none of it may appear in an ask-mode launch. */
const OPEN_MARKERS = [
  '--dangerously-skip-permissions',
  '--dangerously-bypass-approvals-and-sandbox',
  'danger-full-access',
  'never',
  'accept',
]

describe('permission mode', () => {
  it('defaults to ask', () => {
    expect(DEFAULT_EXPERIMENTAL_AGENT_PERMISSION_MODE).toBe('ask')
  })

  it('only an explicit bypass leaves ask', () => {
    expect(normalizeExperimentalAgentPermissionMode('bypass')).toBe('bypass')
    for (const value of [undefined, null, '', 'ask', 'BYPASS', 'never', true, 1, {}]) {
      expect(normalizeExperimentalAgentPermissionMode(value)).toBe('ask')
    }
  })
})

describe('ask mode', () => {
  it('launches Claude without bypassing permission checks', () => {
    expect(interactivePermissionArgs('claude', 'ask')).toEqual([])
    expect(oneShotArgs('claude', 'do it', 'ask')).toEqual(['-p', 'do it'])
  })

  it('launches Codex with an explicit approval policy and a workspace sandbox', () => {
    expect(interactivePermissionArgs('codex', 'ask')).toEqual([
      '--ask-for-approval',
      'on-request',
      '--sandbox',
      'workspace-write',
    ])
    expect(oneShotArgs('codex', 'do it', 'ask')).toEqual([
      '--ask-for-approval',
      'on-request',
      'exec',
      '--sandbox',
      'workspace-write',
      '--skip-git-repo-check',
      'do it',
    ])
  })

  it('uses the guarded app-server policy for the thread and every turn', () => {
    expect(codexThreadStartParams('C:/repo', 'ask')).toEqual({
      cwd: 'C:/repo',
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
    })
    expect(codexTurnStartParams('thread-1', 'do it', 'ask')).toEqual({
      threadId: 'thread-1',
      input: [{ type: 'text', text: 'do it' }],
      approvalPolicy: 'on-request',
    })
  })

  it('declines command and file approval requests instead of accepting them', () => {
    expect(codexApprovalAnswer('item/commandExecution/requestApproval', 'ask')).toEqual({
      kind: 'command',
      decision: 'decline',
    })
    expect(codexApprovalAnswer('item/fileChange/requestApproval', 'ask')).toEqual({
      kind: 'fileChange',
      decision: 'decline',
    })
  })

  it('never emits anything that opens the agent up, for any agent or launch', () => {
    const emitted: unknown[] = [
      codexThreadStartParams('/repo', 'ask'),
      codexTurnStartParams('thread-1', 'task', 'ask'),
      ...APPROVAL_METHODS.map((method) => codexApprovalAnswer(method, 'ask')),
    ]
    for (const agent of AGENTS) {
      emitted.push(interactivePermissionArgs(agent, 'ask'), oneShotArgs(agent, 'task', 'ask'))
    }

    const serialized = JSON.stringify(emitted)
    for (const marker of OPEN_MARKERS) expect(serialized).not.toContain(marker)
  })
})

describe('bypass mode', () => {
  it('launches Claude with permission checks skipped', () => {
    expect(interactivePermissionArgs('claude', 'bypass')).toEqual([
      '--dangerously-skip-permissions',
    ])
    expect(oneShotArgs('claude', 'do it', 'bypass')).toEqual([
      '-p',
      'do it',
      '--dangerously-skip-permissions',
    ])
  })

  it('launches Codex with approvals and sandbox off', () => {
    expect(interactivePermissionArgs('codex', 'bypass')).toEqual([
      '--dangerously-bypass-approvals-and-sandbox',
    ])
    expect(oneShotArgs('codex', 'do it', 'bypass')).toEqual([
      'exec',
      '--dangerously-bypass-approvals-and-sandbox',
      '--skip-git-repo-check',
      'do it',
    ])
  })

  it('never asks and runs unsandboxed on the app-server', () => {
    expect(codexThreadStartParams('C:/repo', 'bypass')).toEqual({
      cwd: 'C:/repo',
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
    })
    expect(codexTurnStartParams('thread-1', 'do it', 'bypass').approvalPolicy).toBe('never')
  })

  it('accepts an approval request that still arrives', () => {
    for (const method of APPROVAL_METHODS) {
      expect(codexApprovalAnswer(method, 'bypass')?.decision).toBe('accept')
    }
  })
})

describe('both modes', () => {
  it('ignores app-server methods that are not approval requests', () => {
    expect(codexApprovalAnswer('turn/completed', 'ask')).toBeNull()
    expect(codexApprovalAnswer('turn/completed', 'bypass')).toBeNull()
  })

  it('leaves agents without a known policy untouched', () => {
    for (const mode of ['ask', 'bypass'] as const) {
      expect(interactivePermissionArgs('opencode', mode)).toEqual([])
      expect(interactivePermissionArgs('shell', mode)).toEqual([])
      expect(oneShotArgs('opencode', 'do it', mode)).toEqual(['run', 'do it'])
      expect(oneShotArgs('shell', 'do it', mode)).toBeUndefined()
    }
  })
})

describe('launch sites', () => {
  it('hold no permission literal of their own, so every launch goes through the policy', () => {
    const sources = [
      agentCanvasUtilsSource,
      agentWorkersSource,
      sessionTerminalDockSource,
      agentSandboxStoreSource,
    ]

    for (const source of sources) {
      expect(source).not.toContain('--dangerously-skip-permissions')
      expect(source).not.toContain('--dangerously-bypass-approvals-and-sandbox')
      expect(source).not.toContain('--ask-for-approval')
      expect(source).not.toContain('danger-full-access')
      expect(source).not.toMatch(/approvalPolicy\s*:/)
      expect(source).not.toMatch(/decision\s*:\s*['"]accept['"]/)
    }
  })

  it('keeps the mode out of cloud sync: it is a per-machine choice', () => {
    expect(cloudSyncSource).not.toContain('experimentalAgentPermissionMode')
  })
})
