import { describe, expect, it } from 'vitest'

import type { Project } from '../types'
import { listClaudeTargets, resolveTarget, voiceTargetable } from './target'

const project = {
  id: 'p1',
  name: 'Billing',
  archived: false,
  terminals: [
    {
      id: 't1',
      name: 'Claude',
      kind: 'terminal',
      cwd: '/work/billing',
      activeTabId: 'a',
      tabs: [
        {
          id: 'a',
          type: 'claude',
          name: 'Claude',
          cwd: '/work/billing',
          ptyId: 'pty-1',
          sessionId: 's1',
        },
      ],
    },
    {
      id: 't2',
      name: 'Shell',
      kind: 'terminal',
      cwd: '/work/billing',
      activeTabId: 'b',
      tabs: [{ id: 'b', type: 'shell', name: 'Shell', cwd: '/work/billing', ptyId: 'pty-2' }],
    },
    {
      id: 't3',
      name: 'Claude 2',
      kind: 'terminal',
      cwd: '/work/billing/api',
      activeTabId: 'c',
      tabs: [{ id: 'c', type: 'claude', name: 'Claude', cwd: '', ptyId: 'pty-3' }],
    },
  ],
} as unknown as Project

describe('listClaudeTargets', () => {
  it('lists live Claude panes only, with their cwd and session', () => {
    const targets = listClaudeTargets([project], (id) => id !== 'pty-9')
    expect(targets.map((target) => target.ptyId)).toEqual(['pty-1', 'pty-3'])
    expect(targets[0]).toMatchObject({
      projectId: 'p1',
      terminalId: 't1',
      cwd: '/work/billing',
      sessionId: 's1',
      label: 'Billing · Claude',
    })
    expect(targets[1].cwd).toBe('/work/billing/api')
  })

  it('skips a Claude pane whose PTY is not alive', () => {
    expect(listClaudeTargets([project], (id) => id !== 'pty-1').map((t) => t.ptyId)).toEqual([
      'pty-3',
    ])
  })
})

describe('voiceTargetable', () => {
  const runtime = { 'pty-1': { alive: true }, 'pty-3': { alive: true }, 'pty-4': { alive: false } }

  // A Claude launched before voice was on has no PermissionRequest/Stop hooks.
  it('keeps only live panes launched with the voice hooks', () => {
    const usable = voiceTargetable(runtime, ['pty-1', 'pty-4'])
    expect(listClaudeTargets([project], usable).map((t) => t.ptyId)).toEqual(['pty-1'])
    expect(usable('pty-4')).toBe(false)
    expect(usable('pty-9')).toBe(false)
  })
})

describe('resolveTarget', () => {
  const targets = listClaudeTargets([project], () => true)

  it('prefers the pinned pane, then the active one, then the last Claude pane used', () => {
    expect(
      resolveTarget(targets, {
        pinnedPtyId: 'pty-3',
        activeTerminalId: 't1',
        lastClaudePtyId: null,
      })?.ptyId,
    ).toBe('pty-3')
    expect(
      resolveTarget(targets, {
        pinnedPtyId: null,
        activeTerminalId: 't1',
        lastClaudePtyId: 'pty-3',
      })?.ptyId,
    ).toBe('pty-1')
    expect(
      resolveTarget(targets, {
        pinnedPtyId: null,
        activeTerminalId: 't2',
        lastClaudePtyId: 'pty-3',
      })?.ptyId,
    ).toBe('pty-3')
  })

  it('falls back to the only Claude pane, and gives up when there are several and no hint', () => {
    expect(
      resolveTarget(targets.slice(0, 1), {
        pinnedPtyId: null,
        activeTerminalId: null,
        lastClaudePtyId: null,
      })?.ptyId,
    ).toBe('pty-1')
    expect(
      resolveTarget(targets, { pinnedPtyId: null, activeTerminalId: null, lastClaudePtyId: null }),
    ).toBeNull()
  })

  it('ignores a pinned or remembered pane that is gone', () => {
    expect(
      resolveTarget(targets, {
        pinnedPtyId: 'pty-9',
        activeTerminalId: 't1',
        lastClaudePtyId: null,
      })?.ptyId,
    ).toBe('pty-1')
  })
})
