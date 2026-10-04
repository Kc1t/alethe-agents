import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const tauri = vi.hoisted(() => ({
  orchestratorSetCliPath: vi.fn(async () => undefined),
  orchestratorSetConcurrency: vi.fn(async () => undefined),
  orchestratorSetPlannerRouting: vi.fn(async () => undefined),
  orchestratorSetPolicy: vi.fn(async () => undefined),
  orchestratorSetWorkerDefaults: vi.fn(async () => undefined),
}))

const quota = vi.hoisted(() => ({ release: vi.fn(), acquireQuotaPolling: vi.fn() }))

const state = vi.hoisted(() => ({
  cliPaths: {} as Record<string, string>,
  projects: [] as unknown[],
  preferences: {
    enabledFeatures: { orchestrator: false },
    agentDefaults: undefined as unknown,
    orchestratorMaxWorkers: undefined as number | undefined,
    orchestratorPolicy: undefined as unknown,
  },
}))

vi.mock('../lib/tauri', () => tauri)
vi.mock('../lib/orchestratorQuota', () => ({ acquireQuotaPolling: quota.acquireQuotaPolling }))
vi.mock('../stores/projectsStore', () => ({
  useProjectsStore: (selector: (value: unknown) => unknown) => selector(state),
}))

import { DEFAULT_ORCHESTRATOR_ROUTING } from '../lib/types'
import { useOrchestratorSettingsSync } from './useOrchestratorSettingsSync'

describe('useOrchestratorSettingsSync', () => {
  afterEach(() => {
    vi.clearAllMocks()
    state.preferences.agentDefaults = undefined
    state.preferences.orchestratorMaxWorkers = undefined
    state.preferences.orchestratorPolicy = undefined
    state.cliPaths = {}
    state.projects = []
    state.preferences.enabledFeatures.orchestrator = false
  })

  it('keeps the planner quota reading fresh only while the orchestrator is on', () => {
    quota.acquireQuotaPolling.mockReturnValue(quota.release)

    const off = renderHook(() => useOrchestratorSettingsSync(true))
    expect(quota.acquireQuotaPolling).not.toHaveBeenCalled()
    off.unmount()

    state.preferences.enabledFeatures.orchestrator = true
    const on = renderHook(() => useOrchestratorSettingsSync(true))
    expect(quota.acquireQuotaPolling).toHaveBeenCalledTimes(1)
    on.unmount()
    expect(quota.release).toHaveBeenCalledTimes(1)
  })

  it('hands workers the CLI paths set in Preferences, skipping one that points elsewhere', () => {
    state.cliPaths = { claude: '/opt/bin/claude', codex: '/opt/bin/not-codex' }

    renderHook(() => useOrchestratorSettingsSync(true))

    expect(tauri.orchestratorSetCliPath).toHaveBeenCalledWith('claude', '/opt/bin/claude')
    expect(tauri.orchestratorSetCliPath).toHaveBeenCalledWith('codex', null)
  })

  it('waits for the persisted preferences before telling the backend anything', () => {
    renderHook(() => useOrchestratorSettingsSync(false))

    expect(tauri.orchestratorSetWorkerDefaults).not.toHaveBeenCalled()
    expect(tauri.orchestratorSetConcurrency).not.toHaveBeenCalled()
    expect(tauri.orchestratorSetPolicy).not.toHaveBeenCalled()
  })

  it('pushes the worker rules, falling back to the defaults for anything unrecognised', () => {
    state.preferences.orchestratorPolicy = {
      defaultAgent: 'claude',
      timeoutMinutes: 30,
      approvals: 'always',
      isolation: 'sometimes',
    }

    renderHook(() => useOrchestratorSettingsSync(true))

    expect(tauri.orchestratorSetPolicy).toHaveBeenCalledWith({
      defaultAgent: 'claude',
      timeoutMinutes: 30,
      approvals: 'always',
      isolation: 'planner',
      webSearch: 'planner',
      keepFinished: 4,
      codexSandbox: 'workspace-write',
      routing: DEFAULT_ORCHESTRATOR_ROUTING,
    })
  })

  it('pushes the worker model and effort for each worker CLI, role first', () => {
    state.preferences.agentDefaults = {
      providers: { claude: { model: 'sonnet', effort: 'medium' }, codex: { model: 'gpt-5.6-sol' } },
      planner: { claude: { model: 'opus' } },
      worker: { claude: { effort: 'low' } },
    }
    state.preferences.orchestratorMaxWorkers = 6

    renderHook(() => useOrchestratorSettingsSync(true))

    expect(tauri.orchestratorSetWorkerDefaults).toHaveBeenCalledWith('claude', {
      model: 'sonnet',
      effort: 'low',
    })
    expect(tauri.orchestratorSetWorkerDefaults).toHaveBeenCalledWith('codex', {
      model: 'gpt-5.6-sol',
    })
    expect(tauri.orchestratorSetConcurrency).toHaveBeenCalledWith(6)
  })

  it('clears the backend defaults when nothing is configured', () => {
    renderHook(() => useOrchestratorSettingsSync(true))

    expect(tauri.orchestratorSetWorkerDefaults).toHaveBeenCalledWith('claude', {})
    expect(tauri.orchestratorSetWorkerDefaults).toHaveBeenCalledWith('codex', {})
    expect(tauri.orchestratorSetConcurrency).toHaveBeenCalledWith(4)
  })

  it('gives the planners of a project with its own profile that profile, and takes it back', () => {
    const planner = { orchestrationRole: 'planner', ptyId: 'pty-1' }
    const project = (preset?: string) => ({
      orchestratorRoutingPreset: preset,
      terminals: [{ tabs: [planner, { ptyId: 'pty-2' }] }],
    })
    state.projects = [project('economy')]
    const { rerender } = renderHook(() => useOrchestratorSettingsSync(true))

    expect(tauri.orchestratorSetPlannerRouting).toHaveBeenCalledTimes(1)
    expect(tauri.orchestratorSetPlannerRouting).toHaveBeenCalledWith(
      'pty-1',
      expect.objectContaining({ preset: 'economy' }),
    )

    state.projects = [project(undefined)]
    rerender()
    expect(tauri.orchestratorSetPlannerRouting).toHaveBeenLastCalledWith('pty-1', null)
  })
})
