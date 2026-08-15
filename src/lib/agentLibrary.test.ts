import { describe, expect, it } from 'vitest'

import { AGENT_LIBRARY } from './agentLibrary'

const GENERATED_MARKER = '<!-- gerado pelo Alethe (biblioteca) — seguro deletar -->'
const ALLOWED_CATEGORIES = ['orquestra', 'front', 'back', 'qa', 'docs', 'economia']
const ALLOWED_COSTS = ['barato', 'medio', 'caro']

function frontmatter(content: string): string | undefined {
  return content.match(/^---\n([\s\S]*?)\n---(?:\n|$)/)?.[1]
}

function frontmatterValue(block: string, field: string): string | undefined {
  return block.match(new RegExp(`^${field}:\\s*(.+)$`, 'm'))?.[1]?.trim()
}

describe('AGENT_LIBRARY', () => {
  it.each(AGENT_LIBRARY)('keeps $name template metadata consistent', (template) => {
    const block = frontmatter(template.content)

    expect(block).toBeDefined()
    expect(frontmatterValue(block!, 'name')).toBe(template.name)
    expect(frontmatterValue(block!, 'description')).toBeTruthy()
    expect(frontmatterValue(block!, 'model')).toBeTruthy()
    expect(template.content.trimEnd().endsWith(GENERATED_MARKER)).toBe(true)
    expect(template.summary.trim()).not.toBe('')
    expect(ALLOWED_CATEGORIES).toContain(template.category)
    expect(ALLOWED_COSTS).toContain(template.cost)
  })

  it('uses unique filesystem-safe names', () => {
    const names = AGENT_LIBRARY.map((template) => template.name)

    expect(new Set(names).size).toBe(names.length)
    for (const name of names) expect(name).toMatch(/^[a-z0-9-]+$/)
  })
})
