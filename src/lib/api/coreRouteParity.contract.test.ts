import { readdirSync,readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

function walk(directory: string, extension: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory()
      ? walk(path, extension)
      : entry.name.endsWith(extension)
        ? [path]
        : []
  })
}

function collapseTemplateExpressions(value: string): string {
  let output = ''
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== '$' || value[index + 1] !== '{') {
      output += value[index]
      continue
    }
    let depth = 1
    index += 2
    while (index < value.length && depth > 0) {
      if (value[index] === '{') depth += 1
      if (value[index] === '}') depth -= 1
      index += 1
    }
    index -= 1
    output += ':param'
  }
  return output
}

function normalizePath(value: string): string {
  const collapsed = collapseTemplateExpressions(value)
  const queryStart = collapsed.indexOf('?')
  const withoutQuery = queryStart >= 0 ? collapsed.slice(0, queryStart) : collapsed
  const queryExpression = withoutQuery.indexOf(':param')
  const path =
    queryExpression > 0 && withoutQuery[queryExpression - 1] !== '/'
      ? withoutQuery.slice(0, queryExpression)
      : withoutQuery
  return path.replace(/\{[^}]+\}|:[A-Za-z_][A-Za-z0-9_]*/g, ':param').replace(/\/$/, '')
}

function frontendCoreCalls(): string[] {
  const calls = new Set<string>()
  for (const file of walk('src/lib/api', '.ts').filter((path) => !path.endsWith('.test.ts'))) {
    const source = readFileSync(file, 'utf8')
    const pattern = /webApiFetch(?:<[^;]*?>)?\(\s*([`'"])(\/api\/[\s\S]*?)\1/g
    for (const match of source.matchAll(pattern)) calls.add(normalizePath(match[2]))
  }
  return [...calls].sort()
}

function backendCoreRoutes(): string[] {
  const routes = new Set<string>(['/api/health', '/api/runtime', '/api/session'])
  for (const file of walk('src-tauri/src/server_main', '.rs')) {
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(/\.route\(\s*"([^"]+)"/g)) {
      routes.add(normalizePath(match[1]))
    }
  }
  return [...routes].sort()
}

describe('shared Core route parity', () => {
  it('pairs every frontend Web operation with an Axum route', () => {
    const routes = new Set(backendCoreRoutes())
    const missing = frontendCoreCalls().filter((path) => !routes.has(path))
    expect(missing, `Missing Core routes:\n${missing.join('\n')}`).toEqual([])
  })

  it('keeps a substantial versioned shared contract instead of silent stubs', () => {
    expect(frontendCoreCalls().length).toBeGreaterThan(150)
    expect(backendCoreRoutes().length).toBeGreaterThan(170)
  })
})
