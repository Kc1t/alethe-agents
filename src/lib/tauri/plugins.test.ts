import { describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({
  Channel: class {
    constructor(readonly onmessage: (message: unknown) => void) {}
  },
  invoke: vi.fn(),
}))

const { withChannels } = await import('./plugins')

describe('withChannels', () => {
  it('turns a function argument into a channel that delivers to it', () => {
    const onChunk = vi.fn()
    const args = withChannels({ text: 'hi', count: 2, onChunk })
    expect(args.text).toBe('hi')
    expect(args.count).toBe(2)
    expect(args.onChunk).not.toBe(onChunk)
    ;(args.onChunk as { onmessage: (message: unknown) => void }).onmessage('chunk')
    expect(onChunk).toHaveBeenCalledWith('chunk')
  })
})
