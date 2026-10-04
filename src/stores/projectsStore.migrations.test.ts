import { describe, expect, it } from 'vitest'

import { DEFAULT_ORCHESTRATOR_POLICY, DEFAULT_PREFERENCES, EMPTY_PROJECTS_FILE } from '../lib/types'
import {
  migrate,
  normalizePreferences,
  normalizeTodos,
  readPreferences,
  takeMigrationDegraded,
} from './projectsStore.migrations'

describe('preference normalization', () => {
  it('preserves persisted sidebar visibility and widths', () => {
    const preferences = normalizePreferences({
      ...DEFAULT_PREFERENCES,
      leftSidebarVisible: false,
      rightSidebarVisible: true,
      leftSidebarWidth: 337,
      rightSidebarWidth: 391,
    })

    expect(preferences).toMatchObject({
      leftSidebarVisible: false,
      rightSidebarVisible: true,
      leftSidebarWidth: 337,
      rightSidebarWidth: 391,
    })
  })

  it('disables legacy automatic parking preferences', () => {
    const preferences = normalizePreferences({
      ...DEFAULT_PREFERENCES,
      resourcePolicy: {
        ...DEFAULT_PREFERENCES.resourcePolicy,
        mode: 'smart-lru',
        automaticParkingOptIn: true,
      },
    })

    expect(preferences.resourcePolicy).toMatchObject({
      mode: 'manual',
      automaticParkingOptIn: false,
    })
  })

  it('keeps Discord Rich Presence opt-in while preserving an existing choice', () => {
    expect(normalizePreferences(undefined).discordRichPresenceEnabled).toBe(false)
    expect(
      normalizePreferences({
        ...DEFAULT_PREFERENCES,
        discordRichPresenceEnabled: true,
      }).discordRichPresenceEnabled,
    ).toBe(true)
    expect(
      normalizePreferences({
        ...DEFAULT_PREFERENCES,
        discordRichPresenceEnabled: false,
      }).discordRichPresenceEnabled,
    ).toBe(false)
  })

  it('defaults motion to animated and preserves a reduced-motion choice', () => {
    expect(normalizePreferences(undefined).motionPreference).toBe('animated')
    expect(
      normalizePreferences({
        ...DEFAULT_PREFERENCES,
        motionPreference: 'reduced',
      }).motionPreference,
    ).toBe('reduced')
    expect(
      normalizePreferences({
        ...DEFAULT_PREFERENCES,
        motionPreference: 'unsupported' as 'reduced',
      }).motionPreference,
    ).toBe('animated')
  })

  it('clamps Pomodoro durations to a sane range and falls back on invalid input', () => {
    expect(
      normalizePreferences({
        ...DEFAULT_PREFERENCES,
        pomodoroWorkMinutes: 0,
        pomodoroShortBreakMinutes: 999,
        pomodoroLongBreakMinutes: Number.NaN,
      }),
    ).toMatchObject({
      pomodoroWorkMinutes: 1,
      pomodoroShortBreakMinutes: 120,
      pomodoroLongBreakMinutes: DEFAULT_PREFERENCES.pomodoroLongBreakMinutes,
    })
  })

  it('discards a running Pomodoro session that already ended', () => {
    const preferences = normalizePreferences({
      ...DEFAULT_PREFERENCES,
      pomodoroSession: {
        phase: 'work',
        status: 'running',
        endsAt: Date.now() - 60_000,
        remainingMsAtPause: null,
        cyclesCompleted: 1,
        focusTodoId: null,
      },
    })

    expect(preferences.pomodoroSession).toMatchObject({ status: 'finished', endsAt: null })
  })
})

describe('agent defaults normalization', () => {
  it('starts older installs with no model, no effort and the stock worker limit', () => {
    const {
      agentDefaults: _dropped,
      orchestratorMaxWorkers: _limit,
      ...older
    } = {
      ...DEFAULT_PREFERENCES,
      agentDefaults: undefined,
      orchestratorMaxWorkers: undefined,
    }

    expect(normalizePreferences(older)).toMatchObject({
      agentDefaults: { providers: {}, planner: {}, worker: {} },
      orchestratorMaxWorkers: 4,
    })
  })

  it('keeps valid choices and drops what a provider cannot be launched with', () => {
    const preferences = normalizePreferences({
      ...DEFAULT_PREFERENCES,
      agentDefaults: {
        providers: {
          claude: { model: ' opus ', effort: 'high' },
          codex: { model: 'gpt 5', effort: 'extreme' },
          kimi: { model: 'k2' },
        },
        planner: { claude: { effort: 'xhigh' } },
        worker: { opencode: { model: 'anthropic/claude-sonnet-5-5', effort: 'high' } },
      },
    })

    expect(preferences.agentDefaults).toEqual({
      providers: { claude: { model: 'opus', effort: 'high' } },
      planner: { claude: { effort: 'xhigh' } },
      worker: { opencode: { model: 'anthropic/claude-sonnet-5-5' } },
    })
  })

  it('gives older installs the stock worker rules', () => {
    const { orchestratorPolicy: _rules, ...older } = {
      ...DEFAULT_PREFERENCES,
      orchestratorPolicy: undefined,
    }

    expect(normalizePreferences(older).orchestratorPolicy).toEqual(DEFAULT_ORCHESTRATOR_POLICY)
  })

  it('clamps the worker limit to what the orchestrator accepts', () => {
    expect(
      normalizePreferences({ ...DEFAULT_PREFERENCES, orchestratorMaxWorkers: 99 })
        .orchestratorMaxWorkers,
    ).toBe(16)
    expect(
      normalizePreferences({ ...DEFAULT_PREFERENCES, orchestratorMaxWorkers: 0 })
        .orchestratorMaxWorkers,
    ).toBe(1)
    expect(
      normalizePreferences({
        ...DEFAULT_PREFERENCES,
        orchestratorMaxWorkers: 'many' as unknown as number,
      }).orchestratorMaxWorkers,
    ).toBe(4)
  })
})

describe('todos normalization', () => {
  it('backfills PR fields when present and drops them when absent', () => {
    const todos = normalizeTodos([
      {
        id: 'a',
        title: 'Review PR',
        completed: false,
        prUrl: 'https://x',
        prNumber: 12,
        prRepo: 'o/r',
      },
      { id: 'b', title: 'Plain task', completed: false },
    ])

    expect(todos.find((t) => t.id === 'a')).toMatchObject({
      prUrl: 'https://x',
      prNumber: 12,
      prRepo: 'o/r',
    })
    expect(todos.find((t) => t.id === 'b')).not.toHaveProperty('prUrl')
  })
})

describe('projects file migration', () => {
  it('adds isolated layout histories when migrating v6 data', () => {
    const migrated = migrate({
      ...EMPTY_PROJECTS_FILE,
      version: 6,
      projects: [{ id: 'project', gridLayoutHistory: undefined }],
      groups: [{ id: 'group', gridLayoutHistory: undefined }],
      preferences: { ...DEFAULT_PREFERENCES, workspaceGridLayoutHistory: undefined },
    })

    expect(migrated.version).toBe(9)
    expect(migrated.projects[0].gridLayoutHistory).toEqual([])
    expect(migrated.groups[0].gridLayoutHistory).toEqual([])
    expect(migrated.preferences.workspaceGridLayoutHistory).toEqual([])
  })

  it('carries forward remote sharing when migrating v7 data to v8', () => {
    const migrated = migrate({
      ...EMPTY_PROJECTS_FILE,
      version: 7,
      projects: [
        {
          id: 'project',
          terminals: [
            { id: 'excluded', remoteExcluded: true },
            { id: 'shared', remoteExcluded: false },
            { id: 'untouched' },
          ],
        },
      ],
    })

    expect(migrated.version).toBe(9)
    const terminals = migrated.projects[0].terminals
    expect(terminals.find((t) => t.id === 'excluded')?.remoteShared).toBe(false)
    expect(terminals.find((t) => t.id === 'shared')?.remoteShared).toBe(true)
    expect(terminals.find((t) => t.id === 'untouched')?.remoteShared).toBe(true)
  })

  it('leaves an explicit remoteShared value untouched when migrating to v8', () => {
    const migrated = migrate({
      ...EMPTY_PROJECTS_FILE,
      version: 7,
      projects: [
        {
          id: 'project',
          terminals: [{ id: 'terminal', remoteExcluded: true, remoteShared: true }],
        },
      ],
    })

    expect(migrated.projects[0].terminals[0].remoteShared).toBe(true)
  })
})

describe('a workspace whose settings cannot be read', () => {
  // Values of the wrong shape, as a hand-edited file or a newer version could leave them.
  const hostile: unknown[] = [
    null,
    42,
    'text',
    [],
    [null],
    { routing: 7 },
    { routing: { tiers: 'x' } },
    { routing: { tiers: { light: [null, 3, 'x', {}] } } },
    { routing: { tiers: { light: { primary: null, fallback: 5 } } } },
    { routing: { preset: {}, watchPercent: 'NaN', tiers: null } },
  ]

  it('reads every orchestration setting without throwing, whatever was saved', () => {
    for (const value of hostile) {
      const preferences = normalizePreferences({
        ...DEFAULT_PREFERENCES,
        orchestratorPolicy: value,
        orchestrationTabOrder: value,
        agentDefaults: value,
        orchestratorMaxWorkers: value,
      } as never)
      expect(preferences.orchestratorPolicy.routing.tiers.light.length).toBeGreaterThan(0)
      expect(preferences.orchestrationTabOrder).toHaveLength(4)
    }
  })

  it('stands in for what it cannot read without sending the person back to onboarding', () => {
    // A number where a text field is trimmed makes the plain normalizer throw.
    const broken = {
      ...DEFAULT_PREFERENCES,
      displayName: 12,
      onboardingDone: true,
      accountCreated: true,
      language: 'pt-BR',
    } as never
    expect(() => normalizePreferences(broken)).toThrow()
    takeMigrationDegraded()

    const preferences = readPreferences(broken)

    expect(preferences.displayName).toBe(DEFAULT_PREFERENCES.displayName)
    expect(preferences.onboardingDone).toBe(true)
    expect(preferences.accountCreated).toBe(true)
    expect(preferences.language).toBe('pt-BR')
    // And says so, because what it returned is not what was saved.
    expect(takeMigrationDegraded()).toBe(true)
    expect(takeMigrationDegraded()).toBe(false)
  })

  it('reports nothing when every setting reads as saved', () => {
    takeMigrationDegraded()
    readPreferences({ ...DEFAULT_PREFERENCES, onboardingDone: true } as never)
    expect(takeMigrationDegraded()).toBe(false)
  })

  it('still loads the projects saved beside them', () => {
    const migrated = migrate({
      ...structuredClone(EMPTY_PROJECTS_FILE),
      projects: [
        {
          id: 'p1',
          name: 'Kept',
          groupId: null,
          terminals: [],
          layoutMode: 'grid',
          collapsed: false,
          createdAt: 1,
        },
      ],
      ungroupedOrder: ['p1'],
      preferences: { ...DEFAULT_PREFERENCES, displayName: 12 },
    } as never)

    expect(migrated.projects.map((project) => project.name)).toEqual(['Kept'])
    expect(migrated.preferences.displayName).toBe(DEFAULT_PREFERENCES.displayName)
  })
})
