import { describe, expect, it } from 'vitest'

import {
  addMarkdownSidebarHistoryEntry,
  isMarkdownPath,
  MAX_MARKDOWN_SIDEBAR_HISTORY,
  parseMarkdownSidebarHistory,
} from './markdownSidebarHistory'

describe('markdown sidebar history', () => {
  it('accepts Markdown variants and rejects unrelated files', () => {
    expect(isMarkdownPath('README.md')).toBe(true)
    expect(isMarkdownPath('guide.MDX')).toBe(true)
    expect(isMarkdownPath('notes.markdown')).toBe(true)
    expect(isMarkdownPath('notes.txt')).toBe(false)
  })

  it('keeps the most recent unique 12 entries', () => {
    let tabs: { path: string; title: string }[] = []
    for (let index = 0; index < MAX_MARKDOWN_SIDEBAR_HISTORY + 2; index += 1) {
      tabs = addMarkdownSidebarHistoryEntry(tabs, {
        path: `C:\\docs\\${index}.md`,
        title: `${index}.md`,
      })
    }
    tabs = addMarkdownSidebarHistoryEntry(tabs, tabs[0])

    expect(tabs).toHaveLength(MAX_MARKDOWN_SIDEBAR_HISTORY)
    expect(tabs.at(-1)?.path).toBe('C:\\docs\\2.md')
    expect(tabs.filter((tab) => tab.path === 'C:\\docs\\2.md')).toHaveLength(1)
  })

  it('sanitizes malformed persisted data and restores a valid active path', () => {
    const history = parseMarkdownSidebarHistory(
      JSON.stringify({
        tabs: [
          { path: 'C:\\docs\\README.md', title: '' },
          { path: 'C:\\docs\\ignored.txt', title: 'ignored' },
          null,
        ],
        activePath: 'missing.md',
      }),
    )

    expect(history).toEqual({
      tabs: [{ path: 'C:\\docs\\README.md', title: 'README.md' }],
      activePath: 'C:\\docs\\README.md',
    })
  })
})
