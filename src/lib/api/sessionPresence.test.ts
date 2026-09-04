import { afterEach, describe, expect, it, vi } from 'vitest'

import { resolveResumeId } from './sessionPresence'
import * as transport from './transport'

const invokeMock = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

afterEach(() => {
  vi.restoreAllMocks()
  invokeMock.mockReset()
})

function inTauri() {
  vi.spyOn(transport, 'isTauriEnv').mockReturnValue(true)
}

describe('resolveResumeId', () => {
  it('drops an id whose session does not exist', async () => {
    // The reported bug: Alethe saved the id it asked Claude to use, the first launch stopped at the
    // trust prompt so no conversation file was written, and the next launch resumed an id the CLI
    // had never heard of — `No conversation found with session ID: …`.
    inTauri()
    invokeMock.mockResolvedValue('absent')
    expect(await resolveResumeId('claude', 'D:/proj', 'ce626fd7')).toBeUndefined()
  })

  it('keeps an id whose session is on disk', async () => {
    inTauri()
    invokeMock.mockResolvedValue('present')
    expect(await resolveResumeId('claude', 'D:/proj', 'abc')).toBe('abc')
  })

  it('keeps the id when the agent cannot be checked', async () => {
    // `unknown` must never behave like `absent`: OpenCode's storage is not read here, and
    // discarding its ids would trade a visible error for silent loss of the session.
    inTauri()
    invokeMock.mockResolvedValue('unknown')
    expect(await resolveResumeId('opencode', 'D:/proj', 'abc')).toBe('abc')
  })

  it('keeps the id when the check itself fails', async () => {
    // The goal is to avoid resuming a session known to be gone — not to refuse to resume whenever
    // the checker has a problem of its own.
    inTauri()
    invokeMock.mockRejectedValue(new Error('backend down'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await resolveResumeId('claude', 'D:/proj', 'abc')).toBe('abc')
  })

  it('has nothing to resolve without a stored id', async () => {
    expect(await resolveResumeId('claude', 'D:/proj', null)).toBeUndefined()
    expect(await resolveResumeId('claude', 'D:/proj', '')).toBeUndefined()
    expect(invokeMock).not.toHaveBeenCalled()
  })
})
