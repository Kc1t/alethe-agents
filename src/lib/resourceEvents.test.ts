import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { MEMORY_RELIEF_EVENTS } from './tauri/window'

// The resource manager reacted to memory pressure by emitting an event per level. Nothing listened
// to any of them, and the most severe one was emitted as `resource::drop-caches` — a name no
// listener could ever match. The app measured itself running out of RAM and did nothing about it.
const MANAGER = 'src-tauri/src/resource_manager.rs'
const LISTENERS = 'src/lib/tauri/window.ts'

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8')

function emittedEvents(source: string): string[] {
  return [...source.matchAll(/emit\(\s*"([^"]+)"/g)]
    .map((match) => match[1]!)
    .filter((name) => name.startsWith('resource'))
}

describe('resource events reach a listener', () => {
  it('every emitted name uses the resource:// scheme', () => {
    for (const name of emittedEvents(read(MANAGER))) {
      expect(name, `${name} is malformed and can never be matched`).toMatch(/^resource:\/\//)
    }
  })

  it('every memory relief level is listened to', () => {
    const emitted = new Set(emittedEvents(read(MANAGER)))
    for (const [level, name] of Object.entries(MEMORY_RELIEF_EVENTS)) {
      expect(emitted, `no emit for the ${level} relief level`).toContain(name)
    }
  })

  it('every relief event the manager emits is handled, not just some', () => {
    const listened = new Set<string>(Object.values(MEMORY_RELIEF_EVENTS))
    const source = read(LISTENERS)
    // Metrics is a pure telemetry feed with no relief action attached to it.
    const relief = emittedEvents(read(MANAGER)).filter((name) => name !== 'resource://metrics')
    for (const name of relief) {
      expect(
        listened.has(name) || source.includes(`'${name}'`),
        `${name} is emitted but nothing on the frontend reacts to it`,
      ).toBe(true)
    }
  })
})
