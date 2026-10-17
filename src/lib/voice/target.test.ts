import { describe, expect, it } from 'vitest'

import type { Group, Project } from '../types'
import {
  inSidebarOrder,
  listAgentTargets,
  resolveTarget,
  staleSessions,
  voiceRestartable,
  voiceTargetable,
} from './target'

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

describe('listAgentTargets', () => {
  it('lists live agent panes, never a shell, with their cwd and session', () => {
    const targets = listAgentTargets([project], (id) => id !== 'pty-9')
    expect(targets.map((target) => target.ptyId)).toEqual(['pty-1', 'pty-3'])
    expect(targets[0]).toMatchObject({
      agent: 'claude',
      projectId: 'p1',
      terminalId: 't1',
      cwd: '/work/billing',
      sessionId: 's1',
      label: 'Billing · Claude',
    })
    expect(targets[1].cwd).toBe('/work/billing/api')
  })

  it('skips a Claude pane whose PTY is not alive', () => {
    expect(listAgentTargets([project], (id) => id !== 'pty-1').map((t) => t.ptyId)).toEqual([
      'pty-3',
    ])
  })

  const tabbed = {
    id: 'p2',
    name: 'Web',
    archived: false,
    terminals: [
      {
        id: 'w1',
        name: 'Main',
        kind: 'terminal',
        cwd: '/work/web',
        activeTabId: 'shell',
        tabs: [
          { id: 'shell', type: 'shell', name: 'Shell', cwd: '/work/web', ptyId: 'pty-10' },
          { id: 'c1', type: 'claude', name: 'Claude', cwd: '/work/web', ptyId: 'pty-11' },
          { id: 'c2', type: 'claude', name: 'Claude', cwd: '/work/web/ui', ptyId: 'pty-12' },
          { id: 'cx', type: 'codex', name: 'Codex', cwd: '/work/web', ptyId: 'pty-13' },
          { id: 'c3', type: 'claude', name: 'Stopped', cwd: '/work/web', ptyId: 'pty-14' },
          { id: 'c4', type: 'claude', name: 'Never ran', cwd: '/work/web', ptyId: null },
        ],
      },
    ],
  } as unknown as Project

  // Picking a session in the HUD reaches an agent in any tab, not only the one in front.
  it('lists agents in inactive tabs too, telling same-pane sessions apart', () => {
    const targets = listAgentTargets([tabbed], (id) => id !== 'pty-14')
    expect(targets.map((item) => item.ptyId)).toEqual(['pty-11', 'pty-12', 'pty-13'])
    expect(targets[2]).toMatchObject({ agent: 'codex', label: 'Web · Main · Codex' })
    expect(targets[0]).toMatchObject({
      projectId: 'p2',
      terminalId: 'w1',
      tabId: 'c1',
      tabActive: false,
      cwd: '/work/web',
    })
    expect(targets[1].cwd).toBe('/work/web/ui')
    expect(new Set(targets.map((item) => item.label)).size).toBe(3)
    expect(targets.every((item) => item.label.startsWith('Web · Main'))).toBe(true)
  })

  it('names an unnamed same-pane session after its agent, never its raw type', () => {
    const unnamed = {
      ...tabbed,
      terminals: [
        {
          ...tabbed.terminals[0],
          tabs: [
            { id: 'u1', type: 'claude', name: '', cwd: '/w', ptyId: 'pty-21' },
            { id: 'u2', type: 'claude', name: ' ', cwd: '/w', ptyId: 'pty-22' },
          ],
        },
      ],
    } as unknown as Project
    expect(listAgentTargets([unnamed], () => true).map((item) => item.label)).toEqual([
      'Web · Main · Claude Code 1',
      'Web · Main · Claude Code 2',
    ])
  })

  it('keeps the plain "<project> · <terminal>" label for a single session in a pane', () => {
    expect(listAgentTargets([project], () => true)[0]).toMatchObject({
      label: 'Billing · Claude',
      tabId: 'a',
      tabActive: true,
    })
  })

  it('skips archived projects, stopped panes and shells', () => {
    const archived = { ...tabbed, id: 'p3', archived: true } as Project
    const targets = listAgentTargets([archived, tabbed], (id) => id !== 'pty-14')
    expect(targets.map((item) => item.projectId)).toEqual(['p2', 'p2', 'p2'])
    expect(targets.some((item) => item.ptyId === 'pty-10' || item.ptyId === 'pty-14')).toBe(false)
  })

  it('names the harness when the pane label does not', () => {
    const solo = {
      ...tabbed,
      terminals: [
        {
          ...tabbed.terminals[0],
          tabs: [{ id: 'o', type: 'opencode', name: 'OpenCode', cwd: '/w', ptyId: 'pty-31' }],
        },
      ],
    } as unknown as Project
    expect(listAgentTargets([solo], () => true)[0].label).toBe('Web · Main · OpenCode')
  })
})

describe('inSidebarOrder', () => {
  const p = (id: string, hidden = false) =>
    ({ id, name: id, hidden, terminals: [] }) as unknown as Project
  const g = (id: string, projectIds: string[], extra: Partial<Group> = {}) =>
    ({ id, name: id, projectIds, parentGroupId: null, ...extra }) as Group

  // Hidden projects and those of an archived group are not in the sidebar, so not in the picker.
  it('follows the sidebar: groups (sub-groups first), then ungrouped, then the rest', () => {
    const projects = [...['a', 'b', 'c', 'd', 'e', 'f'].map((id) => p(id)), p('h', true)]
    const groups = [
      g('g1', ['b', 'missing']),
      g('g1a', ['c'], { parentGroupId: 'g1' }),
      g('gx', ['f'], { archived: true }),
    ]
    expect(inSidebarOrder(projects, groups, ['e', 'h', 'a']).map((item) => item.id)).toEqual([
      'c',
      'b',
      'e',
      'a',
      'd',
    ])
  })

  it('treats a sub-group of an archived group as a root group', () => {
    const projects = ['a', 'b'].map((id) => p(id))
    const groups = [g('gx', ['a'], { archived: true }), g('child', ['b'], { parentGroupId: 'gx' })]
    expect(inSidebarOrder(projects, groups, []).map((item) => item.id)).toEqual(['b'])
  })
})

describe('voiceTargetable', () => {
  const runtime = { 'pty-1': { alive: true }, 'pty-3': { alive: true }, 'pty-4': { alive: false } }

  // A Claude launched before voice was on has no PermissionRequest/Stop hooks.
  it('keeps only live Claude panes launched with the voice hooks', () => {
    const usable = voiceTargetable(runtime, ['pty-1', 'pty-4'])
    expect(listAgentTargets([project], usable).map((t) => t.ptyId)).toEqual(['pty-1'])
    expect(usable('pty-4', 'claude')).toBe(false)
    expect(usable('pty-9', 'claude')).toBe(false)
  })

  // Other harnesses have no hooks to wait for: running is enough.
  it('keeps any live harness without hooks', () => {
    const usable = voiceTargetable(runtime, [])
    expect(usable('pty-3', 'codex')).toBe(true)
    expect(usable('pty-4', 'opencode')).toBe(false)
  })
})

describe('voiceRestartable', () => {
  const runtime = { 'pty-1': { alive: true }, 'pty-3': { alive: true }, 'pty-4': { alive: false } }

  // The other side of `voiceTargetable`: live, but launched without the voice hooks.
  it('keeps only live panes launched without the voice hooks', () => {
    const stale = voiceRestartable(runtime, ['pty-1'])
    expect(stale('pty-1', 'claude')).toBe(false)
    expect(stale('pty-3', 'claude')).toBe(true)
    expect(stale('pty-4', 'claude')).toBe(false)
    expect(stale('pty-9', 'claude')).toBe(false)
    // A restart adds hooks only Claude has.
    expect(stale('pty-3', 'codex')).toBe(false)
  })

  // Listing them never makes them a target: resolution only sees the hooked ones.
  it('never resolves a session without the hooks as the target, even pinned', () => {
    const usable = voiceTargetable(runtime, [])
    const picked = resolveTarget(listAgentTargets([project], usable), {
      pinnedPtyId: 'pty-1',
      activeTerminalId: 't1',
      lastAgentPtyId: 'pty-1',
    })
    expect(picked).toBeNull()
  })
})

describe('staleSessions', () => {
  // The picker, the toast and Restart now all use this list; a disabled pane's own restart
  // button is off, so its session is not offered either.
  it('lists live sessions without the hooks, leaving disabled panes out', () => {
    const runtime = { 'pty-1': { alive: true }, 'pty-3': { alive: true } }
    const ids = (projects: (typeof project)[]) =>
      staleSessions(projects as never, runtime, []).map((item) => item.ptyId)
    expect(ids([project])).toEqual(['pty-1', 'pty-3'])
    const disabled = {
      ...project,
      terminals: project.terminals.map((terminal) =>
        terminal.id === 't1' ? { ...terminal, disabled: true } : terminal,
      ),
    }
    expect(ids([disabled])).toEqual(['pty-3'])
    expect(staleSessions([project] as never, runtime, ['pty-1', 'pty-3'])).toEqual([])
  })
})

describe('resolveTarget', () => {
  const targets = listAgentTargets([project], () => true)

  it('prefers the pinned pane, then the active one, then the last Claude pane used', () => {
    expect(
      resolveTarget(targets, {
        pinnedPtyId: 'pty-3',
        activeTerminalId: 't1',
        lastAgentPtyId: null,
      })?.ptyId,
    ).toBe('pty-3')
    expect(
      resolveTarget(targets, {
        pinnedPtyId: null,
        activeTerminalId: 't1',
        lastAgentPtyId: 'pty-3',
      })?.ptyId,
    ).toBe('pty-1')
    expect(
      resolveTarget(targets, {
        pinnedPtyId: null,
        activeTerminalId: 't2',
        lastAgentPtyId: 'pty-3',
      })?.ptyId,
    ).toBe('pty-3')
  })

  it('falls back to the only Claude pane, and gives up when there are several and no hint', () => {
    expect(
      resolveTarget(targets.slice(0, 1), {
        pinnedPtyId: null,
        activeTerminalId: null,
        lastAgentPtyId: null,
      })?.ptyId,
    ).toBe('pty-1')
    expect(
      resolveTarget(targets, { pinnedPtyId: null, activeTerminalId: null, lastAgentPtyId: null }),
    ).toBeNull()
  })

  // A pane showing a shell in front is not "the active Claude pane", even with Claude in a tab.
  it('only takes the active pane when Claude is its tab in front', () => {
    const candidates = listAgentTargets([tabbed2()], () => true)
    expect(
      resolveTarget(candidates, {
        pinnedPtyId: null,
        activeTerminalId: 'w1',
        lastAgentPtyId: null,
      }),
    ).toBeNull()
    expect(
      resolveTarget(candidates, {
        pinnedPtyId: 'pty-12',
        activeTerminalId: 'w1',
        lastAgentPtyId: null,
      })?.ptyId,
    ).toBe('pty-12')
  })

  // Claude left in a background tab must not make the one in front ambiguous.
  it('falls back to the only Claude in front when others wait in background tabs', () => {
    const front = { ...tabbed2(), id: 'p4' } as Project
    front.terminals = [
      ...front.terminals,
      {
        ...front.terminals[0],
        id: 'w2',
        activeTabId: 'f1',
        tabs: [{ id: 'f1', type: 'claude', name: 'Claude', cwd: '/w', ptyId: 'pty-30' }],
      },
    ] as Project['terminals']
    const context = { pinnedPtyId: null, activeTerminalId: null, lastAgentPtyId: null }
    expect(
      resolveTarget(
        listAgentTargets([front], () => true),
        context,
      )?.ptyId,
    ).toBe('pty-30')
    expect(
      resolveTarget(
        listAgentTargets([tabbed2()], () => true),
        context,
      ),
    ).toBeNull()
  })

  it('ignores a pinned or remembered pane that is gone', () => {
    expect(
      resolveTarget(targets, {
        pinnedPtyId: 'pty-9',
        activeTerminalId: 't1',
        lastAgentPtyId: null,
      })?.ptyId,
    ).toBe('pty-1')
  })
})

function tabbed2(): Project {
  return {
    id: 'p2',
    name: 'Web',
    archived: false,
    terminals: [
      {
        id: 'w1',
        name: 'Main',
        kind: 'terminal',
        cwd: '/work/web',
        activeTabId: 'shell',
        tabs: [
          { id: 'shell', type: 'shell', name: 'Shell', cwd: '/work/web', ptyId: 'pty-10' },
          { id: 'c1', type: 'claude', name: 'Claude', cwd: '/work/web', ptyId: 'pty-11' },
          { id: 'c2', type: 'claude', name: 'Review', cwd: '/work/web', ptyId: 'pty-12' },
        ],
      },
    ],
  } as unknown as Project
}
