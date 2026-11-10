import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const tauri = vi.hoisted(() => ({
  listClaudeSessions: vi.fn(),
  snapshotCodexSessions: vi.fn(),
}))

vi.mock('../../lib/tauri', () => tauri)

vi.mock('../../stores/projectsStore', () => ({
  useProjectsStore: (selector: (state: unknown) => unknown) =>
    selector({
      projects: [
        {
          id: 'project-1',
          defaultCwd: '/repo',
          terminals: [
            {
              id: 'terminal-1',
              cwd: '/repo',
              activeTabId: 'tab-1',
              tabs: [
                {
                  id: 'tab-1',
                  type: 'claude',
                  cwd: '/repo',
                  sessionId: 'current',
                  previousSessionIds: ['earlier'],
                },
              ],
            },
          ],
        },
      ],
      activeProjectId: 'project-1',
      createTerminal: vi.fn(),
      setSubTabSessionId: vi.fn(),
      preferences: { language: 'en' },
    }),
}))

vi.mock('../../stores/uiStore', () => ({
  useUiStore: (selector: (state: unknown) => unknown) =>
    selector({
      openModal: 'recentChats',
      modalContext: { projectId: 'project-1', terminalId: 'terminal-1', agent: 'claude' },
      activeTerminal: null,
      closeModal: vi.fn(),
      openModal_: vi.fn(),
    }),
}))

import { RecentChatsModal } from './RecentChatsModal'

function session(id: string, title: string, modifiedAtMs: number) {
  return {
    id,
    title,
    first_user_prompt: null,
    modified_at_ms: modifiedAtMs,
    message_count: 1,
    size_bytes: 10,
  }
}

afterEach(cleanup)

describe('RecentChatsModal', () => {
  it('lists the terminal chat first, then its earlier chats, each tagged', async () => {
    tauri.listClaudeSessions.mockResolvedValue([
      session('other', 'Other chat', 3),
      session('earlier', 'Earlier chat', 2),
      session('current', 'Current chat', 1),
    ])

    render(<RecentChatsModal />)

    await screen.findByText('Current chat')
    const titles = screen.getAllByText(/ chat$/).map((node) => node.textContent)
    expect(titles).toEqual(['Current chat', 'Earlier chat', 'Other chat'])
    expect(screen.getByText('This terminal')).toBeTruthy()
    expect(screen.getByText('Earlier in this terminal')).toBeTruthy()
  })
})
