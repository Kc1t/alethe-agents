import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { CORRELATION_ARG } from './correlation.constants'

describe('the correlation argument key', () => {
  it('matches the name the Rust side reads', () => {
    // The frontend attaches this key and Rust looks it up by exact name. If the two ever drift,
    // nothing errors: every record simply loses its correlation, and the failure looks like
    // "correlation does not work" rather than "these two strings disagree".
    const rust = readFileSync('src-tauri/src/obs_ipc.rs', 'utf8')
    const match = rust.match(/pub const CORRELATION_ARG: &str = "([^"]+)"/)
    expect(match?.[1]).toBe(CORRELATION_ARG)
  })
})
