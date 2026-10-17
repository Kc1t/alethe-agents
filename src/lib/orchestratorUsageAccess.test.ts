import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue(null) }))

import { useProjectsStore } from '../stores/projectsStore'
import { useUiStore } from '../stores/uiStore'
import { enableOrchestratorFeature } from './orchestratorUsageAccess'
import { DEFAULT_PREFERENCES } from './types'

const preferences = () => useProjectsStore.getState().preferences

beforeEach(() => {
  useProjectsStore.setState({ preferences: DEFAULT_PREFERENCES })
  useUiStore.setState({ toasts: [], notifications: [] })
})

describe('enableOrchestratorFeature', () => {
  it('turns Claude and Codex usage reading on with the feature and says so', () => {
    enableOrchestratorFeature()

    expect(preferences().enabledFeatures.orchestrator).toBe(true)
    expect(preferences().usageAccess).toEqual({
      claude: true,
      codex: true,
      antigravity: false,
      kimi: false,
    })
    const [toast] = useUiStore.getState().toasts
    expect(toast.body).toContain('Claude Code, Codex')
  })

  it('names only the provider it had to turn on', () => {
    useProjectsStore.setState({
      preferences: {
        ...DEFAULT_PREFERENCES,
        usageAccess: { claude: true, codex: false, antigravity: false, kimi: false },
      },
    })
    enableOrchestratorFeature()

    const [toast] = useUiStore.getState().toasts
    expect(toast.body).toContain('Codex')
    expect(toast.body).not.toContain('Claude Code')
  })

  it('respects a reading turned off again while the feature stays on', () => {
    enableOrchestratorFeature()
    useProjectsStore.getState().setPreferences({
      usageAccess: { claude: false, codex: false, antigravity: false, kimi: false },
    })
    useUiStore.setState({ toasts: [] })

    enableOrchestratorFeature()

    expect(preferences().usageAccess).toEqual({
      claude: false,
      codex: false,
      antigravity: false,
      kimi: false,
    })
    expect(useUiStore.getState().toasts).toEqual([])
  })

  it('says nothing when both were already on', () => {
    useProjectsStore.setState({
      preferences: {
        ...DEFAULT_PREFERENCES,
        usageAccess: { claude: true, codex: true, antigravity: false, kimi: false },
      },
    })
    enableOrchestratorFeature()

    expect(preferences().enabledFeatures.orchestrator).toBe(true)
    expect(useUiStore.getState().toasts).toEqual([])
  })
})
