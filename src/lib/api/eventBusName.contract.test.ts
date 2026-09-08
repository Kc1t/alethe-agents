import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { EVENT_BUS_EVENT } from './misc'

describe('event bus name contract', () => {
  it('matches the event name the backend actually emits', () => {
    // These two literals live in different languages and nothing links them at build time. When
    // they drifted apart, `listenEventBus` subscribed to a name nobody emitted: the scheduler
    // store stopped reacting to every event it was written for — spawn requests, task updates,
    // planning changes — with no error anywhere, because a listener that never fires looks exactly
    // like a system where nothing is happening.
    const source = readFileSync('src-tauri/src/event_bus.rs', 'utf8')
    const emitted = /app\.emit\(\s*"([^"]+)"/.exec(source)

    expect(emitted, 'event_bus.rs should emit a named Tauri event').not.toBeNull()
    expect(emitted?.[1]).toBe(EVENT_BUS_EVENT)
  })
})
