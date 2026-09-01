import { describe, expect, it } from 'vitest'

import { formatBrowserGrabMarkdown, resolveBrowserGrabTarget } from './browserGrab'
import type { Project, Terminal } from './types'

function agentTerminal(
  id: string,
  ptyId: string,
  type: 'claude' | 'codex' | 'shell' = 'claude',
): Terminal {
  return {
    id,
    name: id,
    cwd: '/tmp',
    activeTabId: `${id}-tab`,
    disabled: false,
    laneVisible: null,
    lastUsedAt: 0,
    tabs: [{ id: `${id}-tab`, type, cwd: '/tmp', ptyId, lastUsedAt: 0 }],
  }
}

describe('formatBrowserGrabMarkdown', () => {
  it('includes selector, text, and screenshot path', () => {
    const markdown = formatBrowserGrabMarkdown(
      {
        tagName: 'button',
        selector: 'form > button.save',
        textSnippet: 'Save',
        htmlSnippet: '<button class="save">Save</button>',
        href: null,
        ariaLabel: 'Save changes',
        pageUrl: 'https://example.test/edit',
        pageTitle: 'Edit',
        rect: { x: 1, y: 2, width: 40, height: 20 },
      },
      '/tmp/grab.png',
    )
    expect(markdown).toContain('## Browser element')
    expect(markdown).toContain('form > button.save')
    expect(markdown).toContain('Save changes')
    expect(markdown).toContain('/tmp/grab.png')
  })
})

describe('resolveBrowserGrabTarget', () => {
  it('prefers the active agent terminal with a live pty', () => {
    const projects: Project[] = [
      {
        id: 'p1',
        name: 'Demo',
        cwd: '/tmp',
        color: '#000',
        layoutMode: 'auto',
        terminals: [
          agentTerminal('t-shell', 'pty-shell', 'shell'),
          agentTerminal('t-claude', 'pty-1'),
        ],
        createdAt: 0,
      } as Project,
    ]
    const target = resolveBrowserGrabTarget({
      projects,
      activeTerminal: { projectId: 'p1', terminalId: 't-claude' },
    })
    expect(target?.ptyId).toBe('pty-1')
    expect(target?.terminalId).toBe('t-claude')
  })

  it('skips shell panes when choosing a fallback', () => {
    const projects: Project[] = [
      {
        id: 'p1',
        name: 'Demo',
        cwd: '/tmp',
        color: '#000',
        layoutMode: 'auto',
        terminals: [
          agentTerminal('t-shell', 'pty-shell', 'shell'),
          agentTerminal('t-codex', 'pty-9', 'codex'),
        ],
        createdAt: 0,
      } as Project,
    ]
    const target = resolveBrowserGrabTarget({ projects })
    expect(target?.terminalId).toBe('t-codex')
  })
})
