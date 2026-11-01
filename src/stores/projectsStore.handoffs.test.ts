import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { loadProjectsFile, pruneAgentHandoffs } from '../lib/tauri'
import { EMPTY_PROJECTS_FILE } from '../lib/types'
import { setProjectsReadOnly, useProjectsStore } from './projectsStore'

vi.mock('../lib/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/tauri')>()),
  listProfiles: vi.fn(async () => ({ active_profile_id: 'default', profiles: [] })),
  loadProjectsFile: vi.fn(),
  pruneAgentHandoffs: vi.fn(async () => undefined),
  recordAppEvent: vi.fn(async () => undefined),
  saveProjectsFile: vi.fn(async () => undefined),
}))
vi.mock('../lib/terminalLifecycle', () => ({ cleanupPtys: vi.fn() }))

function projectsFileWithHandoff(): string {
  useProjectsStore.setState({ ...structuredClone(EMPTY_PROJECTS_FILE), hydrated: true })
  const { createProject, createTerminal } = useProjectsStore.getState()
  const project = createProject({ name: 'App' })
  createTerminal(project.id, {
    name: 'Codex',
    cwd: 'D:/app',
    firstTab: {
      type: 'codex',
      cwd: 'D:/app',
      handoff: {
        id: 'liveHandoff00001',
        contextDir: 'C:/handoffs/liveHandoff00001',
        contextPath: 'C:/handoffs/liveHandoff00001/context.md',
        sourceProvider: 'claude',
        sourceSessionId: 'session-1',
      },
    },
  })
  createTerminal(project.id, {
    name: 'Shell',
    cwd: 'D:/app',
    firstTab: { type: 'shell', cwd: 'D:/app' },
  })
  return JSON.stringify({ ...EMPTY_PROJECTS_FILE, projects: useProjectsStore.getState().projects })
}

beforeEach(() => {
  vi.mocked(pruneAgentHandoffs).mockClear()
  vi.mocked(loadProjectsFile).mockResolvedValue(projectsFileWithHandoff())
})

afterEach(() => {
  setProjectsReadOnly(false)
})

describe('handoff packets on load', () => {
  it('keeps only the packets an open pane still uses', async () => {
    await useProjectsStore.getState().hydrate()

    expect(pruneAgentHandoffs).toHaveBeenCalledWith(['liveHandoff00001'])
  })

  it('leaves the packets alone in a read-only board window', async () => {
    setProjectsReadOnly(true)

    await useProjectsStore.getState().hydrate()

    expect(pruneAgentHandoffs).not.toHaveBeenCalled()
  })
})
