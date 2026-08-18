import { describe, expect, it } from 'vitest'

import { DEFAULT_PREFERENCES, EMPTY_PROJECTS_FILE } from '../lib/types'
import { migrate, normalizePreferences } from './projectsStore.migrations'

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
})

describe('projects file migration', () => {
  it('defaults provider-backed usage polling to off for fresh data', () => {
    expect(DEFAULT_PREFERENCES).toMatchObject({
      topbarShowClaudeUsage: false,
      topbarShowCodexUsage: false,
      topbarShowAntigravityUsage: false,
    })
  })

  it('turns legacy automatic provider polling off during the v8 migration', () => {
    const migrated = migrate({
      ...EMPTY_PROJECTS_FILE,
      version: 7,
      preferences: {
        ...DEFAULT_PREFERENCES,
        topbarShowClaudeUsage: true,
        topbarShowCodexUsage: true,
        topbarShowAntigravityUsage: true,
      },
    })

    expect(migrated.preferences).toMatchObject({
      topbarShowClaudeUsage: false,
      topbarShowCodexUsage: false,
      topbarShowAntigravityUsage: false,
    })
  })

  it('preserves choices explicitly saved in v8 data', () => {
    const migrated = migrate({
      ...EMPTY_PROJECTS_FILE,
      version: 8,
      preferences: {
        ...DEFAULT_PREFERENCES,
        topbarShowClaudeUsage: true,
        topbarShowCodexUsage: false,
        topbarShowAntigravityUsage: true,
      },
    })

    expect(migrated.preferences).toMatchObject({
      topbarShowClaudeUsage: true,
      topbarShowCodexUsage: false,
      topbarShowAntigravityUsage: true,
    })
  })

  it('adds isolated layout histories when migrating v6 data', () => {
    const migrated = migrate({
      ...EMPTY_PROJECTS_FILE,
      version: 6,
      projects: [{ id: 'project', gridLayoutHistory: undefined }],
      groups: [{ id: 'group', gridLayoutHistory: undefined }],
      preferences: { ...DEFAULT_PREFERENCES, workspaceGridLayoutHistory: undefined },
    })

    expect(migrated.version).toBe(8)
    expect(migrated.projects[0].gridLayoutHistory).toEqual([])
    expect(migrated.groups[0].gridLayoutHistory).toEqual([])
    expect(migrated.preferences.workspaceGridLayoutHistory).toEqual([])
  })
})
