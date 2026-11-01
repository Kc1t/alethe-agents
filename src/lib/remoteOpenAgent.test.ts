import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useProjectsStore } from '../stores/projectsStore'
import { openRemoteAgent } from './remoteOpenAgent'
import { saveProjectsFile } from './tauri'
import { EMPTY_PROJECTS_FILE } from './types'

vi.mock('./tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./tauri')>()),
  saveProjectsFile: vi.fn(async () => undefined),
}))
vi.mock('./terminalLifecycle', () => ({ cleanupPtys: vi.fn() }))

const request = { agent: 'codex' as const, deviceId: 1, deviceName: 'Phone' }

beforeEach(() => {
  useProjectsStore.setState({ ...structuredClone(EMPTY_PROJECTS_FILE), hydrated: true })
  vi.mocked(saveProjectsFile).mockClear()
})

describe('openRemoteAgent', () => {
  it('starts a shared terminal for the agent and saves right away', () => {
    const project = useProjectsStore
      .getState()
      .createProject({ name: 'Site', defaultCwd: 'C:/site' })
    vi.mocked(saveProjectsFile).mockClear()

    const terminalId = openRemoteAgent({ ...request, projectId: project.id })

    const terminal = useProjectsStore
      .getState()
      .projects.find((candidate) => candidate.id === project.id)
      ?.terminals.find((candidate) => candidate.id === terminalId)
    expect(terminal?.remoteShared).toBe(true)
    expect(terminal?.tabs[0]?.type).toBe('codex')
    expect(terminal?.cwd).toBe('C:/site')
    expect(saveProjectsFile).toHaveBeenCalledTimes(1)
  })

  it('ignores a project that no longer exists', () => {
    expect(openRemoteAgent({ ...request, projectId: 'gone' })).toBeNull()
    expect(saveProjectsFile).not.toHaveBeenCalled()
  })

  it('ignores an agent that is turned off on the desktop', () => {
    const store = useProjectsStore.getState()
    const project = store.createProject({ name: 'Site' })
    store.setPreferences({
      enabledAgents: { ...store.preferences.enabledAgents, codex: false },
    })

    expect(openRemoteAgent({ ...request, projectId: project.id })).toBeNull()
    expect(useProjectsStore.getState().projects[0]?.terminals).toHaveLength(0)
  })
})
