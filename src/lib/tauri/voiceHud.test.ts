import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invoke, listen } = vi.hoisted(() => ({
  invoke: vi.fn<(...args: unknown[]) => Promise<unknown>>(() => Promise.resolve()),
  listen: vi.fn(() => Promise.resolve(() => undefined)),
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('@tauri-apps/api/event', () => ({ listen }))

import { speechCaptureLevel } from './speech'
import { onVoiceHudState, voiceHudAction, voiceHudMoved, voiceHudSnapshot } from './voiceHud'

describe('voice HUD window wrappers', () => {
  beforeEach(() => {
    invoke.mockClear()
    listen.mockClear()
  })

  it('reads the last published state and reports moves and actions to the main window', async () => {
    await voiceHudSnapshot()
    await voiceHudMoved()
    await voiceHudAction('{"kind":"dismiss"}')
    expect(invoke.mock.calls).toEqual([
      ['voice_hud_snapshot'],
      ['voice_hud_moved'],
      ['voice_hud_action', { action: '{"kind":"dismiss"}' }],
    ])
  })

  it('reads the microphone level and propagates backend failures', async () => {
    invoke.mockResolvedValueOnce(0.25)
    await expect(speechCaptureLevel()).resolves.toBe(0.25)
    expect(invoke).toHaveBeenLastCalledWith('speech_capture_level')
    const error = new Error('capture unavailable')
    invoke.mockRejectedValueOnce(error)
    await expect(speechCaptureLevel()).rejects.toBe(error)
    invoke.mockRejectedValueOnce(error)
    await expect(voiceHudSnapshot()).rejects.toBe(error)
    invoke.mockRejectedValueOnce(error)
    await expect(voiceHudAction('{"kind":"dismiss"}')).rejects.toBe(error)
    invoke.mockRejectedValueOnce(error)
    await expect(voiceHudMoved()).rejects.toBe(error)
  })

  it('hands each published state string to the handler', async () => {
    const handler = vi.fn()
    await onVoiceHudState(handler)
    const [[event, relay]] = listen.mock.calls as unknown as [
      [string, (e: { payload: string }) => void],
    ]
    expect(event).toBe('voice-hud://state')
    relay({ payload: '{"rate":1}' })
    expect(handler).toHaveBeenCalledWith('{"rate":1}')
  })
})
