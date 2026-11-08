import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useProjectsStore } from '../stores/projectsStore'
import { restartAgentTab } from './agentTabRestart'
import type { SubTab } from './types'

const mocks = vi.hoisted(() => ({
  relaunch: vi.fn(async (_args: Record<string, unknown>) => ({
    args: [] as string[],
    sessionId: undefined as string | undefined,
  })),
  sessions: {} as Record<string, unknown>,
  saveSession: vi.fn(),
  snapshotCodex: vi.fn(async (_cwd: string) => [] as { id: string }[]),
  setSubTabSessionId: vi.fn(),
}))
vi.mock('./agentRelaunch', () => ({ relaunchAgentPty: mocks.relaunch }))
vi.mock('./sessionResume', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getActiveSessions: () => mocks.sessions,
  saveSession: mocks.saveSession,
}))
vi.mock('./tauri', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getPtyCwd: vi.fn(async () => null),
  snapshotCodexSessions: mocks.snapshotCodex,
}))

const tab = (patch: Partial<SubTab>): SubTab =>
  ({ id: 'tab-1', type: 'claude', name: 'Claude', cwd: '/w', ptyId: 'pty-1', ...patch }) as SubTab

const restart = (patch: Partial<SubTab>) =>
  restartAgentTab({ projectId: 'p', terminalId: 't', terminalCwd: '/w', tab: tab(patch) })

describe('restartAgentTab', () => {
  const resized = vi.fn()
  const onResize = (event: Event) => resized((event as CustomEvent).detail)
  let before: ReturnType<typeof useProjectsStore.getState>['setSubTabSessionId']

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.sessions = {}
    mocks.relaunch.mockResolvedValue({ args: [], sessionId: undefined })
    before = useProjectsStore.getState().setSubTabSessionId
    useProjectsStore.setState({ setSubTabSessionId: mocks.setSubTabSessionId })
    window.addEventListener('alethe:terminal-resize-request', onResize)
  })
  afterEach(() => {
    useProjectsStore.setState({ setSubTabSessionId: before })
    window.removeEventListener('alethe:terminal-resize-request', onResize)
  })

  it('resumes the conversation of the tab, in the same pty, and asks for a resize', async () => {
    mocks.relaunch.mockResolvedValue({ args: [], sessionId: 'conv-1' })
    await restart({ sessionId: 'conv-1' })
    expect(mocks.relaunch.mock.calls[0][0]).toMatchObject({
      ptyId: 'pty-1',
      agent: 'claude',
      sessionId: 'conv-1',
      cwd: '/w',
    })
    // Same conversation: nothing to update on the tab, but the session is saved for next launch.
    expect(mocks.setSubTabSessionId).not.toHaveBeenCalled()
    expect(mocks.saveSession).toHaveBeenCalledWith(
      'tab-1',
      expect.objectContaining({ sessionId: 'pty-1', claudeSessionId: 'conv-1', cwd: '/w' }),
    )
    expect(resized).toHaveBeenCalledWith({ ptyId: 'pty-1' })
  })

  it('falls back to the saved session of the tab when it has no conversation id', async () => {
    mocks.sessions = {
      'tab-1': { sessionId: 'pty-1', claudeSessionId: 'saved-9', cwd: '/w', agent: 'claude' },
    }
    await restart({})
    expect(mocks.relaunch.mock.calls[0][0]).toMatchObject({ sessionId: 'saved-9' })
  })

  // The folder's latest Codex conversation may belong to another pane; a guess would move this one.
  it('does not guess a Codex conversation from the folder', async () => {
    mocks.snapshotCodex.mockResolvedValue([{ id: 'codex-1' }, { id: 'codex-0' }])
    await restart({ type: 'codex' })
    expect(mocks.snapshotCodex).not.toHaveBeenCalled()
    expect(mocks.relaunch.mock.calls[0][0]).toMatchObject({ agent: 'codex', sessionId: undefined })
  })

  it('passes the tab run-as-admin flag to the relaunch', async () => {
    await restart({ type: 'shell', runAsAdmin: true })
    expect(mocks.relaunch.mock.calls[0][0]).toMatchObject({ runAsAdmin: true })
  })

  it('records a new conversation id on the tab', async () => {
    mocks.relaunch.mockResolvedValue({ args: [], sessionId: 'conv-2' })
    await restart({ sessionId: 'conv-1' })
    expect(mocks.setSubTabSessionId).toHaveBeenCalledWith('p', 't', 'tab-1', 'conv-2')
  })

  it('throws when the relaunch fails, without saving anything', async () => {
    mocks.relaunch.mockRejectedValueOnce(new Error('spawn failed'))
    await expect(restart({ sessionId: 'conv-1' })).rejects.toThrow('spawn failed')
    expect(mocks.saveSession).not.toHaveBeenCalled()
    expect(resized).not.toHaveBeenCalled()
  })
})
