import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { orchestratorCodexModels } from '../../../lib/tauri/orchestrator'
import {
  DEFAULT_ROUTER9_PREFERENCES,
  EMPTY_PROJECTS_FILE,
  type OrchestrationRole,
} from '../../../lib/types'
import { useProjectsStore } from '../../../stores/projectsStore'
import { OrchestrationPage } from './OrchestrationPage'

vi.mock('../../../lib/tauri/orchestrator', () => ({
  orchestratorCodexModels: vi.fn(async () => [
    { model: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', defaultEffort: 'low', efforts: ['low', 'ultra'] },
    { model: 'gpt-6-astra', name: 'GPT-6 Astra', defaultEffort: 'medium', efforts: ['medium'] },
  ]),
}))

const reviewer: OrchestrationRole = {
  name: 'reviewer',
  agent: 'codex',
  model: 'gpt-6.1-sol',
  effort: 'low',
  readOnly: true,
  timeoutSeconds: 600,
}

const orchestration = () => useProjectsStore.getState().preferences.orchestration

function withRoles(roles: OrchestrationRole[]) {
  useProjectsStore.setState({ ...structuredClone(EMPTY_PROJECTS_FILE), hydrated: true })
  const { preferences, setPreferences } = useProjectsStore.getState()
  setPreferences({ orchestration: { ...preferences.orchestration, roles } })
}

function choose(control: string, option: string) {
  fireEvent.click(screen.getByRole('button', { name: control }))
  fireEvent.click(screen.getByRole('option', { name: option }))
}

beforeEach(() => withRoles([]))

// The Orchestration category of Preferences (#254).
describe('OrchestrationPage', { timeout: 20_000 }, () => {
  it('saves the bundled skill backend, strategy, and provider switching policy', () => {
    render(<OrchestrationPage />)

    choose('Preferred backend', 'Local skill only')
    choose('Default strategy', 'Economy')
    choose('Provider to conserve', 'Claude Code')
    choose('When that provider is selected', 'Switch automatically')
    choose('Preferred local provider', 'Kimi Code')

    expect(orchestration().skill).toEqual({
      backend: 'skill',
      defaultStrategy: 'economy',
      providerSwitch: 'automatic',
      conserveProvider: 'claude',
      preferredProvider: 'kimi',
    })
  })

  it('previews the selected strategy and shows 9router only for the default route', () => {
    render(<OrchestrationPage />)

    choose('Default strategy', 'Quality')
    expect(screen.getByRole('region', { name: 'Strategy architecture' })).toBeTruthy()
    expect(screen.getByText('Worker 2 · review')).toBeTruthy()
    expect(screen.queryByText('9router')).toBeNull()

    act(() => {
      useProjectsStore.getState().setPreferences({
        router9: { ...DEFAULT_ROUTER9_PREFERENCES, enabled: true, defaultForNewAgents: true },
      })
    })
    expect(screen.getByText('9router')).toBeTruthy()
  })

  it('adds a role that the orchestrator can run as soon as it appears', () => {
    render(<OrchestrationPage />)

    fireEvent.click(screen.getByRole('button', { name: 'Add role' }))

    expect(orchestration().roles).toEqual([
      {
        name: 'role-1',
        agent: 'codex',
        model: null,
        effort: null,
        readOnly: false,
        timeoutSeconds: null,
      },
    ])
  })

  it('offers the models Codex reports and the efforts the chosen one accepts', async () => {
    withRoles([reviewer])
    render(<OrchestrationPage />)
    // Let the model list Codex reports arrive.
    await act(async () => {})

    choose('Model for reviewer', 'GPT-6 Astra')
    // The effort it had is not one the new model accepts.
    expect(orchestration().roles[0]).toMatchObject({ model: 'gpt-6-astra', effort: null })

    fireEvent.click(screen.getByRole('button', { name: 'Effort for reviewer' }))
    expect(screen.queryByRole('option', { name: 'ultra' })).toBeNull()
    fireEvent.click(screen.getByRole('option', { name: 'medium' }))
    expect(orchestration().roles[0]).toMatchObject({ effort: 'medium' })
  })

  it('still offers the Codex efforts when Codex does not list its models', async () => {
    vi.mocked(orchestratorCodexModels).mockRejectedValueOnce(
      new Error('codex did not list its models in time'),
    )
    withRoles([{ ...reviewer, effort: null }])
    render(<OrchestrationPage />)
    await act(async () => {})

    fireEvent.click(screen.getByRole('button', { name: 'Effort for reviewer' }))
    expect(screen.getByRole('option', { name: 'xhigh' })).toBeTruthy()
    fireEvent.click(screen.getByRole('option', { name: 'medium' }))
    expect(orchestration().roles[0]).toMatchObject({ effort: 'medium' })
  })

  it('offers the Codex efforts while Codex is still listing its models', () => {
    vi.mocked(orchestratorCodexModels).mockReturnValueOnce(new Promise(() => {}))
    withRoles([{ ...reviewer, effort: null }])
    render(<OrchestrationPage />)

    fireEvent.click(screen.getByRole('button', { name: 'Effort for reviewer' }))
    expect(screen.getByRole('option', { name: 'high' })).toBeTruthy()
  })

  it('offers the efforts Claude Code takes for a Claude role', () => {
    withRoles([
      {
        name: 'executor',
        agent: 'claude',
        model: 'claude-opus-5-5',
        effort: null,
        readOnly: false,
        timeoutSeconds: null,
      },
    ])
    render(<OrchestrationPage />)

    fireEvent.click(screen.getByRole('button', { name: 'Effort for executor' }))
    expect(screen.getByRole('option', { name: 'max' })).toBeTruthy()
    fireEvent.click(screen.getByRole('option', { name: 'high' }))

    expect(orchestration().roles[0]).toMatchObject({ agent: 'claude', effort: 'high' })
  })

  it('drops what only Codex has when a role moves to Claude', () => {
    withRoles([reviewer])
    render(<OrchestrationPage />)

    choose('Agent for reviewer', 'Claude Code')

    expect(orchestration().roles[0]).toMatchObject({
      agent: 'claude',
      model: null,
      effort: null,
      readOnly: false,
    })
  })

  it('does not save a rename that takes the name of another role', () => {
    const writer: OrchestrationRole = {
      name: 'writer',
      agent: 'claude',
      model: null,
      effort: null,
      readOnly: false,
      timeoutSeconds: null,
    }
    withRoles([writer, reviewer])
    render(<OrchestrationPage />)

    fireEvent.change(screen.getByRole('textbox', { name: 'Name of role writer' }), {
      target: { value: 'reviewer' },
    })

    // Saved, it would hand the reviewer's name to a writable Claude role.
    expect(orchestration().roles.map((role) => role.name)).toEqual(['writer', 'reviewer'])
    expect(screen.getByText(/Use a unique name/)).toBeTruthy()
  })

  it('saves how many workers run at the same time', () => {
    render(<OrchestrationPage />)

    fireEvent.click(screen.getByRole('button', { name: 'More workers at the same time' }))

    expect(orchestration().maxConcurrent).toBe(5)
  })

  // Codex plugins a worker starts without (#266).
  it('saves the Codex plugins workers start without, one id per line or comma', () => {
    render(<OrchestrationPage />)

    fireEvent.change(screen.getByRole('textbox', { name: 'Codex plugins off in workers' }), {
      target: { value: 'claude-mem@claude-mem-local, ecc@ecc\nponytail@ponytail' },
    })

    expect(orchestration().workerDisabledPlugins).toEqual([
      'claude-mem@claude-mem-local',
      'ecc@ecc',
      'ponytail@ponytail',
    ])
  })

  // A role's fallback while its provider is running out (#268).
  it('offers as fallback only the roles a role may run as', () => {
    const executor: OrchestrationRole = {
      name: 'executor',
      agent: 'claude',
      model: null,
      effort: null,
      readOnly: false,
      timeoutSeconds: null,
    }
    withRoles([reviewer, executor, { ...reviewer, name: 'reviewer-b' }])
    render(<OrchestrationPage />)

    // A read-only role cannot fall back to the writable executor.
    fireEvent.click(screen.getByRole('button', { name: 'Fallback for reviewer' }))
    expect(screen.queryByRole('option', { name: 'executor' })).toBeNull()
    fireEvent.click(screen.getByRole('option', { name: 'reviewer-b' }))
    expect(orchestration().roles[0]).toMatchObject({ name: 'reviewer', fallback: 'reviewer-b' })

    choose('Fallback for executor', 'reviewer')
    expect(orchestration().roles[1]).toMatchObject({ name: 'executor', fallback: 'reviewer' })
  })

  it('keeps a fallback pointing at a role that is renamed, and drops it when that role goes', () => {
    withRoles([
      { ...reviewer, fallback: 'reviewer-b' },
      { ...reviewer, name: 'reviewer-b' },
    ])
    render(<OrchestrationPage />)

    fireEvent.change(screen.getByRole('textbox', { name: 'Name of role reviewer-b' }), {
      target: { value: 'reviewer-c' },
    })
    expect(orchestration().roles[0].fallback).toBe('reviewer-c')

    fireEvent.click(screen.getByRole('button', { name: 'Remove reviewer-c' }))
    expect(orchestration().roles[0].fallback ?? null).toBeNull()
  })

  // A role row for one orchestrator (#276).
  it('gives a role one row per orchestrator under the same name', () => {
    withRoles([
      { ...reviewer, name: 'lead', fallback: 'reviewer' },
      reviewer,
      { ...reviewer, name: 'reviewer-b' },
    ])
    render(<OrchestrationPage />)

    choose('Orchestrator for reviewer', 'Codex')
    expect(orchestration().roles[1]).toMatchObject({ name: 'reviewer', orchestrator: 'codex' })

    // The same name for another orchestrator is a second row, not a clash, and a fallback that
    // names it stays where it was.
    fireEvent.change(screen.getByRole('textbox', { name: 'Name of role reviewer-b' }), {
      target: { value: 'reviewer' },
    })
    expect(orchestration().roles[2].name).toBe('reviewer')
    expect(orchestration().roles[2].orchestrator).toBeUndefined()
    // The fallback options list each name once.
    fireEvent.click(screen.getByRole('button', { name: 'Fallback for lead' }))
    expect(screen.getAllByRole('option', { name: 'reviewer' })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Fallback for lead' }))

    // That row cannot become a second Codex row of reviewer.
    fireEvent.click(screen.getByRole('button', { name: 'Orchestrator for reviewer' }))
    expect(screen.getByRole('option', { name: 'Codex' })).toBeDisabled()
    fireEvent.click(screen.getByRole('option', { name: 'Claude Code' }))
    expect(orchestration().roles[2]).toMatchObject({ name: 'reviewer', orchestrator: 'claude' })
    expect(orchestration().roles[0].fallback).toBe('reviewer')
  })
})
