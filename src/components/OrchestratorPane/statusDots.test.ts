import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const css = readFileSync(
  resolve('src/components/OrchestratorPane/OrchestratorPane.module.css'),
  'utf8',
)

function dotColor(selector: string): string | undefined {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return css.match(new RegExp(`${escaped} \\.dot \\{\\s*background: ([^;]+);`))?.[1]
}

describe('worker status dots', () => {
  // #270: a finished worker looked like a running one, while the legend says finished is stopped.
  it('show a finished worker in the finished colour, not the running one', () => {
    for (const block of ['.worker', '.railRow']) {
      expect(dotColor(`${block}[data-status='done']`)).toBe('var(--status-stopped)')
    }
    expect(dotColor(".railRow[data-status='running']")).toBe('var(--status-working)')
  })
})
