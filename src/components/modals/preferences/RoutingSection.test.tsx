import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

import {
  DEFAULT_ROUTING_SETTINGS,
  EMPTY_PROJECTS_FILE,
  type OrchestrationRole,
  type RoutingRule,
  type RoutingSettings,
} from '../../../lib/types'
import { useProjectsStore } from '../../../stores/projectsStore'
import { RoutingSection } from './RoutingSection'

const reviewer: OrchestrationRole = {
  name: 'reviewer',
  agent: 'codex',
  model: null,
  effort: null,
  readOnly: true,
  timeoutSeconds: null,
}

const rule = (patch: Partial<RoutingRule> = {}): RoutingRule => ({
  id: 'rule-1',
  enabled: true,
  kinds: [],
  efforts: [],
  gates: [],
  role: 'reviewer',
  ...patch,
})

const orchestration = () => useProjectsStore.getState().preferences.orchestration

function setup(roles: OrchestrationRole[], routing: Partial<RoutingSettings> = {}) {
  useProjectsStore.setState({ ...structuredClone(EMPTY_PROJECTS_FILE), hydrated: true })
  const { preferences, setPreferences } = useProjectsStore.getState()
  setPreferences({
    orchestration: {
      ...preferences.orchestration,
      roles,
      routing: { ...DEFAULT_ROUTING_SETTINGS, ...routing },
    },
  })
}

function openAdvanced() {
  fireEvent.click(screen.getByRole('button', { name: /Advanced rules/ }))
}

beforeEach(() => setup([reviewer]))

// The Routing section of the Orchestration category: preset picker plus the rule editor.
describe('RoutingSection', () => {
  it('applies a preset to roles, rules and preset id at once, keeping unknown roles', () => {
    setup([{ ...reviewer, name: 'mine' }], { rules: [rule()] })
    render(<RoutingSection />)

    fireEvent.click(screen.getByRole('button', { name: /Economy/ }))

    const next = orchestration()
    expect(next.routing.preset).toBe('economy')
    expect(next.roles.map((role) => role.name)).toEqual(['scout', 'handyman', 'builder', 'mine'])
    expect(next.routing.rules).toHaveLength(4)
    expect(next.routing.rules.every((entry) => entry.id.length > 0)).toBe(true)
  })

  it('turns the preset into custom when a rule is edited by hand', () => {
    setup([reviewer], { preset: 'balanced', rules: [rule()] })
    render(<RoutingSection />)
    openAdvanced()

    fireEvent.click(screen.getByRole('switch', { name: 'Enable rule 1' }))

    expect(orchestration().routing.preset).toBe('custom')
    expect(orchestration().routing.rules[0]).toMatchObject({ id: 'rule-1', enabled: false })
  })

  it('warns when a rule names a role that does not exist', () => {
    setup([reviewer], { rules: [rule({ role: 'ghost' })] })
    render(<RoutingSection />)
    openAdvanced()

    expect(screen.getByText(/No role is named "ghost"/)).toBeTruthy()
  })

  it('moves rules up and down, since the first match wins', () => {
    setup([reviewer], { rules: [rule(), rule({ id: 'rule-2' })] })
    render(<RoutingSection />)
    openAdvanced()

    fireEvent.click(screen.getByRole('button', { name: 'Move rule 2 up' }))

    expect(orchestration().routing.rules.map((entry) => entry.id)).toEqual(['rule-2', 'rule-1'])
    expect(orchestration().routing.preset).toBe('custom')
  })

  it('adds a rule pointing at the first role', () => {
    render(<RoutingSection />)
    openAdvanced()

    fireEvent.click(screen.getByRole('button', { name: 'Add rule' }))

    expect(orchestration().routing.rules).toHaveLength(1)
    expect(orchestration().routing.rules[0]).toMatchObject({
      enabled: true,
      kinds: [],
      efforts: [],
      gates: [],
      role: 'reviewer',
    })
    expect(orchestration().routing.rules[0].id).toHaveLength(8)
  })

  it('saves the critical threshold within its range', () => {
    render(<RoutingSection />)

    fireEvent.change(screen.getByRole('spinbutton', { name: /Critical threshold/ }), {
      target: { value: '65' },
    })
    expect(orchestration().routing.criticalThreshold).toBe(65)
    // Global controls are not a rule edit: the preset stays put.
    expect(orchestration().routing.preset).toBe('balanced')

    fireEvent.change(screen.getByRole('spinbutton', { name: /Critical threshold/ }), {
      target: { value: '5' },
    })
    expect(orchestration().routing.criticalThreshold).toBe(65)
  })
})
