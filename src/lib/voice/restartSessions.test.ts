import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useProjectsStore } from '../../stores/projectsStore'
import { useTerminalsStore } from '../../stores/terminalsStore'
import { useUiStore } from '../../stores/uiStore'
import {
  INITIAL_VOICE_CONVERSATION,
  useVoiceConversationStore,
} from '../../stores/voiceConversationStore'
import { EMPTY_PROJECTS_FILE, type Project } from '../types'
import { offerVoiceRestart, restartVoiceSession } from './restartSessions'

const mocks = vi.hoisted(() => ({
  relaunch: vi.fn(async (_args: Record<string, unknown>) => ({
    args: [] as string[],
    sessionId: undefined as string | undefined,
  })),
  hooked: vi.fn(async (): Promise<string[]> => []),
}))
vi.mock('../agentRelaunch', () => ({ relaunchAgentPty: mocks.relaunch }))
vi.mock('../tauri', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  agentVoiceHookedPtys: mocks.hooked,
  getPtyCwd: vi.fn(async () => null),
}))

const tab = (id: string, ptyId: string, sessionId?: string) => ({
  id,
  type: 'claude',
  name: 'Claude',
  cwd: '/w',
  ptyId,
  ...(sessionId ? { sessionId } : {}),
})

function workspace() {
  useProjectsStore.setState({
    ...structuredClone(EMPTY_PROJECTS_FILE),
    hydrated: true,
    projects: [
      {
        id: 'p',
        name: 'Billing',
        terminals: [
          {
            id: 't',
            name: 'Claude',
            kind: 'terminal',
            cwd: '/w',
            activeTabId: 'a',
            tabs: [tab('a', 'pty-old', 'conv-1'), tab('b', 'pty-hooked'), tab('c', 'pty-old-2')],
          },
        ],
      },
    ] as unknown as Project[],
  })
  useTerminalsStore.setState({
    byPtyId: {
      'pty-old': { alive: true },
      'pty-hooked': { alive: true },
      'pty-old-2': { alive: true },
    } as never,
  })
}

describe('restartSessions', () => {
  beforeEach(() => {
    mocks.relaunch.mockClear()
    mocks.hooked.mockReset()
    mocks.hooked.mockResolvedValue(['pty-hooked'])
    workspace()
    useVoiceConversationStore.setState({
      ...INITIAL_VOICE_CONVERSATION,
      voiceHookedPtyIds: ['pty-hooked'],
    })
    useUiStore.setState({ toasts: [], notifications: [] })
  })
  afterEach(() => {
    useTerminalsStore.setState({ byPtyId: {} })
  })

  // The same relaunch the pane's restart button runs: the conversation resumes, now with hooks.
  it('restarts a session resuming its conversation and refreshes the hooked list', async () => {
    mocks.hooked.mockResolvedValueOnce(['pty-hooked'])
    mocks.hooked.mockResolvedValue(['pty-hooked', 'pty-old'])
    expect(await restartVoiceSession('pty-old')).toBe(true)
    expect(mocks.relaunch).toHaveBeenCalledTimes(1)
    expect(mocks.relaunch.mock.calls[0][0]).toMatchObject({
      ptyId: 'pty-old',
      agent: 'claude',
      sessionId: 'conv-1',
      cwd: '/w',
    })
    expect(useVoiceConversationStore.getState().voiceHookedPtyIds).toEqual([
      'pty-hooked',
      'pty-old',
    ])
  })

  // A Restart clicked on a stale picker: the session got its hooks meanwhile (or exited).
  it('does nothing for a session that already has the hooks or is no longer running', async () => {
    mocks.hooked.mockResolvedValue(['pty-hooked', 'pty-old'])
    expect(await restartVoiceSession('pty-old')).toBe(false)
    expect(await restartVoiceSession('pty-hooked')).toBe(false)
    useTerminalsStore.setState({ byPtyId: { 'pty-old-2': { alive: false } } as never })
    expect(await restartVoiceSession('pty-old-2')).toBe(false)
    expect(mocks.relaunch).not.toHaveBeenCalled()
  })

  // The pane's own restart button is off on a disabled pane.
  it('does not restart a session in a disabled pane', async () => {
    const { projects } = useProjectsStore.getState()
    useProjectsStore.setState({
      projects: projects.map((project) => ({
        ...project,
        terminals: project.terminals.map((terminal) => ({ ...terminal, disabled: true })),
      })),
    })
    expect(await restartVoiceSession('pty-old')).toBe(false)
    expect(mocks.relaunch).not.toHaveBeenCalled()
  })

  it('does nothing for a session it cannot find', async () => {
    expect(await restartVoiceSession('pty-gone')).toBe(false)
    expect(mocks.relaunch).not.toHaveBeenCalled()
  })

  it('says so when the restart fails', async () => {
    mocks.relaunch.mockRejectedValueOnce(new Error('spawn failed'))
    expect(await restartVoiceSession('pty-old')).toBe(false)
    expect(useUiStore.getState().toasts.map((toast) => toast.title)).toEqual([
      'Failed to restart terminal',
    ])
  })

  it('offers to restart the running sessions without voice hooks, all at once', async () => {
    await offerVoiceRestart()
    const toasts = useUiStore.getState().toasts
    expect(toasts).toHaveLength(1)
    expect(toasts[0].title).toBe('2 Claude sessions need a restart to use voice')
    expect(toasts[0].actions?.map((action) => action.label)).toEqual(['Restart now'])
    toasts[0].actions?.[0].run()
    await vi.waitFor(() => expect(mocks.relaunch).toHaveBeenCalledTimes(2))
    expect(mocks.relaunch.mock.calls.map((call) => call[0].ptyId)).toEqual(['pty-old', 'pty-old-2'])
  })

  // The list is read again on the click: a session restarted from the picker meanwhile is skipped.
  it('restarts only the sessions still without hooks when Restart now is clicked', async () => {
    await offerVoiceRestart()
    mocks.hooked.mockResolvedValue(['pty-hooked', 'pty-old'])
    useUiStore.getState().toasts[0].actions?.[0].run()
    await vi.waitFor(() => expect(mocks.relaunch).toHaveBeenCalledTimes(1))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(mocks.relaunch.mock.calls.map((call) => call[0].ptyId)).toEqual(['pty-old-2'])
  })

  it('says "session" for a single one', async () => {
    mocks.hooked.mockResolvedValue(['pty-hooked', 'pty-old'])
    await offerVoiceRestart()
    expect(useUiStore.getState().toasts[0].title).toBe(
      '1 Claude session needs a restart to use voice',
    )
  })

  it('offers nothing when every running session has the hooks', async () => {
    mocks.hooked.mockResolvedValue(['pty-hooked', 'pty-old', 'pty-old-2'])
    await offerVoiceRestart()
    expect(useUiStore.getState().toasts).toEqual([])
  })
})
