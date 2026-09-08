// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const transport = vi.hoisted(() => ({
  canUseSharedCoreTransport: vi.fn(async () => true),
  isTauriEnv: vi.fn(() => false),
  webApiFetch: vi.fn(),
}))

vi.mock('./transport', () => transport)

import { findCliLauncher } from './misc'

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  transport.isTauriEnv.mockReturnValue(false)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('findCliLauncher', () => {
  it('retries transient Web transport failures before reporting the result', async () => {
    transport.webApiFetch
      .mockRejectedValueOnce(new Error('core restarting'))
      .mockRejectedValueOnce(new Error('core unavailable'))
      .mockResolvedValueOnce('/home/user/.opencode/bin/opencode')

    const result = findCliLauncher('opencode')
    await vi.advanceTimersByTimeAsync(750)

    await expect(result).resolves.toBe('/home/user/.opencode/bin/opencode')
    expect(transport.webApiFetch).toHaveBeenCalledTimes(3)
  })

  it('uses a successful null response as the only not-installed result', async () => {
    transport.webApiFetch.mockResolvedValueOnce(null)

    await expect(findCliLauncher('missing-agent')).resolves.toBeNull()
    expect(transport.webApiFetch).toHaveBeenCalledOnce()
  })

  it('preserves the transport error after bounded retries', async () => {
    const unavailable = new Error('core unavailable')
    transport.webApiFetch.mockRejectedValue(unavailable)

    const result = findCliLauncher('opencode')
    const rejection = expect(result).rejects.toBe(unavailable)
    await vi.advanceTimersByTimeAsync(750)

    await rejection
    expect(transport.webApiFetch).toHaveBeenCalledTimes(3)
  })
})
