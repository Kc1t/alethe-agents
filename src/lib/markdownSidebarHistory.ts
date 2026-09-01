import { basename } from './paths'
import { readScopedStorage, writeScopedStorage } from './storageNamespace'

export const MAX_MARKDOWN_SIDEBAR_HISTORY = 12
const STORAGE_KEY = 'markdown-sidebar-history-v1'
const MARKDOWN_PATH_PATTERN = /\.(md|markdown|mdx)$/i

export type MarkdownSidebarHistoryEntry = {
  path: string
  title: string
}

export type MarkdownSidebarHistory = {
  tabs: MarkdownSidebarHistoryEntry[]
  activePath: string | null
}

export function isMarkdownPath(path: string): boolean {
  return MARKDOWN_PATH_PATTERN.test(path.trim())
}

export function addMarkdownSidebarHistoryEntry(
  tabs: MarkdownSidebarHistoryEntry[],
  entry: MarkdownSidebarHistoryEntry,
): MarkdownSidebarHistoryEntry[] {
  const normalized = normalizeEntry(entry)
  if (!normalized) return tabs
  return [...tabs.filter((tab) => tab.path !== normalized.path), normalized].slice(
    -MAX_MARKDOWN_SIDEBAR_HISTORY,
  )
}

export function parseMarkdownSidebarHistory(raw: string | null): MarkdownSidebarHistory {
  if (!raw) return { tabs: [], activePath: null }
  try {
    const value = JSON.parse(raw) as { tabs?: unknown; activePath?: unknown }
    const source = Array.isArray(value.tabs) ? value.tabs : []
    let tabs: MarkdownSidebarHistoryEntry[] = []
    for (const candidate of source) {
      if (!candidate || typeof candidate !== 'object') continue
      const entry = candidate as { path?: unknown; title?: unknown }
      if (typeof entry.path !== 'string' || typeof entry.title !== 'string') continue
      tabs = addMarkdownSidebarHistoryEntry(tabs, { path: entry.path, title: entry.title })
    }
    const requestedActivePath = typeof value.activePath === 'string' ? value.activePath.trim() : ''
    const activePath = tabs.some((tab) => tab.path === requestedActivePath)
      ? requestedActivePath
      : (tabs[tabs.length - 1]?.path ?? null)
    return { tabs, activePath }
  } catch {
    return { tabs: [], activePath: null }
  }
}

export function readMarkdownSidebarHistory(): MarkdownSidebarHistory {
  return parseMarkdownSidebarHistory(readScopedStorage(STORAGE_KEY, true))
}

export function writeMarkdownSidebarHistory(
  tabs: MarkdownSidebarHistoryEntry[],
  activePath: string | null,
): void {
  try {
    writeScopedStorage(STORAGE_KEY, JSON.stringify({ tabs, activePath }))
  } catch (error) {
    console.warn('[markdown-sidebar] could not persist history:', error)
  }
}

function normalizeEntry(entry: MarkdownSidebarHistoryEntry): MarkdownSidebarHistoryEntry | null {
  const path = entry.path.trim()
  if (!path || !isMarkdownPath(path)) return null
  return {
    path,
    title: entry.title.trim() || basename(path) || path,
  }
}
