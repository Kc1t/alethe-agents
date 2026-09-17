import { describe, expect, it } from 'vitest'

import {
  DEFAULT_PREFERENCES,
  DEFAULT_TERMINAL_FONT_FAMILY,
  EMPTY_PROJECTS_FILE,
} from '../lib/types'
import { migrate, normalizePreferences, normalizeTodos } from './projectsStore.migrations'

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

  it('backfills the shell and terminal font of a file saved before they existed', () => {
    const preferences = normalizePreferences({})

    expect(preferences.shellPath).toBeNull()
    expect(preferences.terminalFontFamily).toBe(DEFAULT_TERMINAL_FONT_FAMILY)
  })

  it('keeps a configured shell and trims it', () => {
    const preferences = normalizePreferences({
      ...DEFAULT_PREFERENCES,
      shellPath: '  C:\\Program Files\\PowerShell\\7\\pwsh.exe  ',
      terminalFontFamily: '  CaskaydiaCove Nerd Font  ',
    })

    expect(preferences.shellPath).toBe('C:\\Program Files\\PowerShell\\7\\pwsh.exe')
    expect(preferences.terminalFontFamily).toBe('CaskaydiaCove Nerd Font')
  })

  it('falls back when the shell or the font was cleared to a blank string', () => {
    const preferences = normalizePreferences({
      ...DEFAULT_PREFERENCES,
      shellPath: '   ',
      terminalFontFamily: '',
    })

    expect(preferences.shellPath).toBeNull()
    expect(preferences.terminalFontFamily).toBe(DEFAULT_TERMINAL_FONT_FAMILY)
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

    expect(migrated.version).toBe(7)
    expect(migrated.projects[0].gridLayoutHistory).toEqual([])
    expect(migrated.groups[0].gridLayoutHistory).toEqual([])
    expect(migrated.preferences.workspaceGridLayoutHistory).toEqual([])
  })
})
