import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RuleSet } from '../../../lib/types'

const store = vi.hoisted(() => {
  const listeners = new Set<() => void>()
  const state = {
    projects: [] as { id: string; name: string; terminals: { cwd: string }[] }[],
    preferences: {
      language: 'en',
      orchestratorShortcuts: null as unknown,
      workerRuleSets: null as RuleSet[] | null,
    },
    setPreferences: (patch: { workerRuleSets?: RuleSet[] | null }) => {
      state.preferences = { ...state.preferences, ...patch }
      for (const listener of listeners) listener()
    },
  }
  return {
    state,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
})

const defaultRuleSets = vi.hoisted(() => vi.fn())

vi.mock('../../../stores/projectsStore', async () => {
  const react = await import('react')
  return {
    useProjectsStore: (selector: (state: typeof store.state) => unknown) =>
      react.useSyncExternalStore(
        store.subscribe,
        () => selector(store.state),
        () => selector(store.state),
      ),
  }
})

vi.mock('../../../stores/uiStore', () => ({
  useUiStore: (selector: (state: { pushToast: () => void }) => unknown) =>
    selector({ pushToast: vi.fn() }),
}))

vi.mock('../../../stores/schedulerStore', () => ({
  useSchedulerStore: () => ({
    tasks: [],
    loading: false,
    initListener: () => () => {},
    loadTasks: vi.fn(),
    tick: vi.fn(),
    cancel: vi.fn(),
  }),
}))

vi.mock('../../../lib/tauri', () => ({
  getPlanningAutocommit: vi.fn(async () => false),
  getTelemetryMetrics: vi.fn(async () => ({})),
  getTelemetryTraces: vi.fn(async () => []),
  orchestratorDefaultRuleSets: defaultRuleSets,
  planningAuditHistory: vi.fn(async () => []),
  setPlanningAutocommit: vi.fn(async () => {}),
}))

import { MultiagentPage } from './MultiagentPage'

const ours: RuleSet[] = [
  { id: 'general', name: 'General', text: 'general rules' },
  { id: 'backend', name: 'Backend', text: 'backend rules' },
]

let uuid = 0

beforeEach(() => {
  uuid = 0
  vi.stubGlobal('crypto', { randomUUID: () => `uuid-${++uuid}` })
  store.state.preferences = {
    language: 'en',
    orchestratorShortcuts: null,
    workerRuleSets: null,
  }
  defaultRuleSets.mockReset()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const setName = () => screen.getAllByLabelText('Set name')
const addButton = () => screen.getByRole('button', { name: 'Add set' })

describe('rule sets when Alethe’s own could not be loaded', () => {
  it('says so instead of claiming the person chose to have none, and refuses to add a set', async () => {
    // An empty editor here would be a lie: the core never received a list, so it is still serving
    // ours — and a set added now would be stored as a list with no General in it at all.
    defaultRuleSets.mockRejectedValue(new Error('ipc down'))
    render(<MultiagentPage />)

    expect(await screen.findByText(/could not be loaded/i)).toBeInTheDocument()
    expect(screen.queryByText('No rules are sent with delegated work.')).not.toBeInTheDocument()
    expect(addButton()).toBeDisabled()
    expect(store.state.preferences.workerRuleSets).toBeNull()
  })

  it('offers a retry that brings the editor back without reopening Preferences', async () => {
    defaultRuleSets.mockRejectedValueOnce(new Error('ipc down')).mockResolvedValue(ours)
    render(<MultiagentPage />)

    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }))

    await waitFor(() => expect(setName()).toHaveLength(2))
    expect(addButton()).toBeEnabled()
  })

  it('leaves the editor fully usable when the person already has a list of their own', async () => {
    store.state.preferences.workerRuleSets = ours
    defaultRuleSets.mockRejectedValue(new Error('ipc down'))
    render(<MultiagentPage />)

    await waitFor(() => expect(addButton()).toBeEnabled())
    expect(screen.queryByText(/could not be loaded/i)).not.toBeInTheDocument()
  })
})

describe('rule set names stay unique', () => {
  it('names a newly added set so it never collides with an existing one', async () => {
    store.state.preferences.workerRuleSets = ours
    defaultRuleSets.mockResolvedValue(ours)
    render(<MultiagentPage />)

    fireEvent.click(addButton())
    fireEvent.click(addButton())

    const stored = store.state.preferences.workerRuleSets as RuleSet[]
    expect(stored.map((set) => set.name)).toEqual(['General', 'Backend', 'New set', 'New set 2'])
  })

  it('refuses a duplicate name, restores the previous one and explains why', async () => {
    // The core's find_set returns the first match, so a second set under the same name could never
    // be delivered — it must not be storable in the first place.
    store.state.preferences.workerRuleSets = ours
    defaultRuleSets.mockResolvedValue(ours)
    render(<MultiagentPage />)

    const backend = setName()[1]
    fireEvent.change(backend, { target: { value: 'general' } })
    expect(backend).toHaveAttribute('aria-invalid', 'true')

    fireEvent.blur(backend)

    expect(backend).toHaveValue('Backend')
    expect(screen.getByText(/already taken/i)).toBeInTheDocument()
    const stored = store.state.preferences.workerRuleSets as RuleSet[]
    expect(stored.map((set) => set.name)).toEqual(['General', 'Backend'])
  })

  it('commits a free name, including a re-cased version of its own', async () => {
    store.state.preferences.workerRuleSets = ours
    defaultRuleSets.mockResolvedValue(ours)
    render(<MultiagentPage />)

    const backend = setName()[1]
    fireEvent.change(backend, { target: { value: 'BACKEND' } })
    expect(backend).not.toHaveAttribute('aria-invalid')
    fireEvent.blur(backend)
    expect((store.state.preferences.workerRuleSets as RuleSet[])[1].name).toBe('BACKEND')

    fireEvent.change(backend, { target: { value: 'Infra' } })
    fireEvent.blur(backend)
    expect((store.state.preferences.workerRuleSets as RuleSet[])[1].name).toBe('Infra')
  })
})
