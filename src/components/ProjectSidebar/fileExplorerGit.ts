import { normalizeCwd } from '../../lib/paths'
import type { GitRepositoryStatus } from '../../lib/tauri'

export type GitItemKind =
  | 'conflict'
  | 'modified'
  | 'staged-modified'
  | 'added'
  | 'untracked'
  | 'deleted'
  | 'renamed'

export interface GitItemBadge {
  kind: GitItemKind
  badge: string
  labelKey:
    | 'files.git.modified'
    | 'files.git.stagedModified'
    | 'files.git.untracked'
    | 'files.git.added'
    | 'files.git.deleted'
    | 'files.git.renamed'
    | 'files.git.conflict'
}

export interface GitFolderBadge {
  kind: GitItemKind
  labelKey: 'files.git.folderHasChanges'
}

export interface GitExplorerIndex {
  repoRootNorm: string
  files: Map<string, GitItemBadge>
  folders: Map<string, GitFolderBadge>
}

const KIND_PRIORITY: Record<GitItemKind, number> = {
  conflict: 100,
  modified: 80,
  'staged-modified': 70,
  added: 60,
  untracked: 50,
  renamed: 40,
  deleted: 30,
}

export function normalizeGitPath(path: string): string {
  return normalizeCwd(path).replace(/\\/g, '/').toLowerCase()
}

export function buildGitExplorerIndex(status: GitRepositoryStatus | null): GitExplorerIndex | null {
  if (!status || !status.repoRoot) return null

  const repoRootNorm = normalizeGitPath(status.repoRoot)
  const files = new Map<string, GitItemBadge>()
  const folders = new Map<string, GitFolderBadge>()

  const registerFile = (relPath: string, badge: GitItemBadge) => {
    const key = relPath.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase()
    const existing = files.get(key)
    if (!existing || KIND_PRIORITY[badge.kind] > KIND_PRIORITY[existing.kind]) {
      files.set(key, badge)
    }

    // Propagate status to parent folders
    const parts = key.split('/')
    for (let i = 1; i < parts.length; i++) {
      const folderKey = parts.slice(0, i).join('/')
      const existingFolder = folders.get(folderKey)
      if (!existingFolder || KIND_PRIORITY[badge.kind] > KIND_PRIORITY[existingFolder.kind]) {
        folders.set(folderKey, {
          kind: badge.kind,
          labelKey: 'files.git.folderHasChanges',
        })
      }
    }
  }

  // Conflicts take highest priority
  for (const item of status.conflicts ?? []) {
    registerFile(item.path, {
      kind: 'conflict',
      badge: '!',
      labelKey: 'files.git.conflict',
    })
  }

  // Staged changes
  for (const item of status.staged ?? []) {
    const code = (item.status.trim()[0] ?? '').toUpperCase()
    if (code === 'A') {
      registerFile(item.path, {
        kind: 'added',
        badge: 'A',
        labelKey: 'files.git.added',
      })
    } else if (code === 'D') {
      registerFile(item.path, {
        kind: 'deleted',
        badge: 'D',
        labelKey: 'files.git.deleted',
      })
    } else if (code === 'R' || code === 'C') {
      registerFile(item.path, {
        kind: 'renamed',
        badge: 'R',
        labelKey: 'files.git.renamed',
      })
    } else {
      registerFile(item.path, {
        kind: 'staged-modified',
        badge: 'M',
        labelKey: 'files.git.stagedModified',
      })
    }
  }

  // Unstaged changes (modified takes visual priority over staged-modified)
  for (const item of status.changes ?? []) {
    const code = (item.status.trim()[0] ?? '').toUpperCase()
    if (code === 'D') {
      registerFile(item.path, {
        kind: 'deleted',
        badge: 'D',
        labelKey: 'files.git.deleted',
      })
    } else if (code === 'R' || code === 'C') {
      registerFile(item.path, {
        kind: 'renamed',
        badge: 'R',
        labelKey: 'files.git.renamed',
      })
    } else {
      registerFile(item.path, {
        kind: 'modified',
        badge: 'M',
        labelKey: 'files.git.modified',
      })
    }
  }

  // Untracked files
  for (const item of status.untracked ?? []) {
    registerFile(item.path, {
      kind: 'untracked',
      badge: 'U',
      labelKey: 'files.git.untracked',
    })
  }

  return { repoRootNorm, files, folders }
}

export function getGitEntryStatus(
  index: GitExplorerIndex | null,
  absolutePath: string,
  isDir: boolean,
): GitItemBadge | GitFolderBadge | null {
  if (!index) return null

  const normPath = normalizeGitPath(absolutePath)
  if (!normPath.startsWith(index.repoRootNorm)) return null

  if (normPath === index.repoRootNorm) {
    if (isDir) {
      return index.folders.get('') ?? null
    }
    return null
  }

  const separator = normPath[index.repoRootNorm.length]
  if (separator !== '/') return null

  const relPath = normPath.slice(index.repoRootNorm.length + 1)
  if (isDir) {
    return index.folders.get(relPath) ?? null
  }
  return index.files.get(relPath) ?? null
}
