import { describe, expect, it } from 'vitest'
import {
  buildGitExplorerIndex,
  getGitEntryStatus,
  normalizeGitPath,
} from './fileExplorerGit'
import type { GitRepositoryStatus } from '../../lib/tauri'

describe('fileExplorerGit', () => {
  it('normalizes paths consistently across separators', () => {
    expect(normalizeGitPath('C:\\Users\\Project\\src')).toBe(
      normalizeGitPath('c:/users/project/src'),
    )
  })

  it('builds index and maps file and folder statuses correctly', () => {
    const mockStatus: GitRepositoryStatus = {
      repoRoot: 'C:\\Projects\\MyApp',
      branch: 'main',
      detached: false,
      ahead: 0,
      behind: 0,
      conflicts: [],
      staged: [
        { path: 'src/staged.ts', originalPath: null, status: 'A' },
      ],
      changes: [
        { path: 'scripts/build.js', originalPath: null, status: 'M' },
        { path: 'src/components/Button.tsx', originalPath: null, status: 'M' },
      ],
      untracked: [
        { path: 'docs/new-guide.md', originalPath: null, status: '?' },
      ],
    }

    const index = buildGitExplorerIndex(mockStatus)
    expect(index).not.toBeNull()

    // File statuses
    const stagedFile = getGitEntryStatus(index, 'C:\\Projects\\MyApp\\src\\staged.ts', false)
    expect(stagedFile).toEqual({
      kind: 'added',
      badge: 'A',
      labelKey: 'files.git.added',
    })

    const modifiedFile = getGitEntryStatus(index, 'C:\\Projects\\MyApp\\scripts\\build.js', false)
    expect(modifiedFile).toEqual({
      kind: 'modified',
      badge: 'M',
      labelKey: 'files.git.modified',
    })

    const untrackedFile = getGitEntryStatus(index, 'C:\\Projects\\MyApp\\docs\\new-guide.md', false)
    expect(untrackedFile).toEqual({
      kind: 'untracked',
      badge: 'U',
      labelKey: 'files.git.untracked',
    })

    const cleanFile = getGitEntryStatus(index, 'C:\\Projects\\MyApp\\src\\clean.ts', false)
    expect(cleanFile).toBeNull()

    // Folder statuses propagation
    const scriptsDir = getGitEntryStatus(index, 'C:\\Projects\\MyApp\\scripts', true)
    expect(scriptsDir).toEqual({
      kind: 'modified',
      labelKey: 'files.git.folderHasChanges',
    })

    const srcDir = getGitEntryStatus(index, 'C:\\Projects\\MyApp\\src', true)
    expect(srcDir).toEqual({
      kind: 'modified', // modified takes priority over added
      labelKey: 'files.git.folderHasChanges',
    })

    const componentsDir = getGitEntryStatus(index, 'C:\\Projects\\MyApp\\src\\components', true)
    expect(componentsDir).toEqual({
      kind: 'modified',
      labelKey: 'files.git.folderHasChanges',
    })

    const docsDir = getGitEntryStatus(index, 'C:\\Projects\\MyApp\\docs', true)
    expect(docsDir).toEqual({
      kind: 'untracked',
      labelKey: 'files.git.folderHasChanges',
    })

    const cleanDir = getGitEntryStatus(index, 'C:\\Projects\\MyApp\\other', true)
    expect(cleanDir).toBeNull()
  })

  it('handles conflict status with highest priority', () => {
    const mockStatus: GitRepositoryStatus = {
      repoRoot: '/repo',
      branch: 'main',
      detached: false,
      ahead: 0,
      behind: 0,
      conflicts: [
        { path: 'conflict.txt', originalPath: null, status: 'U' },
      ],
      staged: [],
      changes: [
        { path: 'conflict.txt', originalPath: null, status: 'M' },
      ],
      untracked: [],
    }

    const index = buildGitExplorerIndex(mockStatus)
    const fileStatus = getGitEntryStatus(index, '/repo/conflict.txt', false)
    expect(fileStatus).toEqual({
      kind: 'conflict',
      badge: '!',
      labelKey: 'files.git.conflict',
    })
  })
})
