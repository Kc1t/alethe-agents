import { beforeEach, describe, expect, it, vi } from 'vitest'

import { CaptureGate, openCapture, transcribeCapture } from './capture'
import type { SttEngineArgs } from './engine'

const tauri = vi.hoisted(() => ({
  speechPrepare: vi.fn(),
  speechStartCapture: vi.fn(),
  speechStopAndTranscribe: vi.fn(),
  speechStopCapture: vi.fn(),
}))
const forgetProviderKey = vi.hoisted(() => vi.fn())

vi.mock('../tauri', () => tauri)
vi.mock('../voice/cloudErrors', () => ({
  forgetProviderKey,
  cloudFailureMessage: () => null,
}))

const engine = (overrides: Partial<SttEngineArgs> = {}): SttEngineArgs => ({
  provider: 'local',
  modelId: 'parakeet',
  locale: null,
  needsLocale: false,
  fallbackLocale: null,
  ...overrides,
})

beforeEach(() => {
  for (const fn of Object.values(tauri)) fn.mockReset()
  tauri.speechPrepare.mockResolvedValue(true)
  tauri.speechStartCapture.mockResolvedValue(undefined)
  tauri.speechStopCapture.mockResolvedValue(undefined)
  forgetProviderKey.mockReset()
})

describe('openCapture', () => {
  it('asks for a language before anything else on Apple', async () => {
    const block = await openCapture(engine({ provider: 'apple', needsLocale: true }), null)
    expect(block).toBe('speech.nativeLocaleRequired')
    expect(tauri.speechPrepare).not.toHaveBeenCalled()
    expect(tauri.speechStartCapture).not.toHaveBeenCalled()
  })

  it('opens a local engine without preparing it unless asked to', async () => {
    expect(await openCapture(engine(), 'mic')).toBeNull()
    expect(tauri.speechPrepare).not.toHaveBeenCalled()
    expect(tauri.speechStartCapture).toHaveBeenCalledWith('mic')

    tauri.speechPrepare.mockResolvedValue(false)
    expect(await openCapture(engine(), null, { prepareLocal: true })).toBe(
      'voice.conv.modelMissing',
    )
  })

  it('forgets a cloud key the provider no longer has, but not on a failed check', async () => {
    tauri.speechPrepare.mockResolvedValue(false)
    expect(await openCapture(engine({ provider: 'openai' }), null)).toBe('voice.cloud.noKey')
    expect(forgetProviderKey).toHaveBeenCalledWith('openai')

    forgetProviderKey.mockReset()
    tauri.speechPrepare.mockRejectedValue(new Error('keychain'))
    expect(await openCapture(engine({ provider: 'openai' }), null)).toBe('voice.cloud.noKey')
    expect(forgetProviderKey).not.toHaveBeenCalled()
    expect(tauri.speechStartCapture).not.toHaveBeenCalled()
  })

  it('closes a mic that opened after the caller went away', async () => {
    let gone = false
    tauri.speechStartCapture.mockImplementation(async () => {
      gone = true
    })
    expect(await openCapture(engine(), null, { cancelled: () => gone })).toBe('cancelled')
    expect(tauri.speechStopCapture).toHaveBeenCalledTimes(1)
  })
})

describe('transcribeCapture', () => {
  it('trims the transcript and passes the use', async () => {
    tauri.speechStopAndTranscribe.mockResolvedValue('  hello  ')
    expect(await transcribeCapture(engine(), 'dictation')).toBe('hello')
    expect(tauri.speechStopAndTranscribe).toHaveBeenCalledWith('parakeet', null, {
      provider: 'local',
      fallbackLocale: null,
      usage: 'dictation',
    })
  })

  it('drops the native stream when transcription fails', async () => {
    tauri.speechStopAndTranscribe.mockRejectedValue('speech_too_short')
    await expect(transcribeCapture(engine(), 'conversation')).rejects.toBe('speech_too_short')
    expect(tauri.speechStopCapture).toHaveBeenCalledTimes(1)
  })
})

describe('CaptureGate', () => {
  it('runs a stop that landed while the mic was opening, once', async () => {
    const gate = new CaptureGate()
    let open: (value: boolean) => void = () => undefined
    const onStop = vi.fn(() => gate.takeStop())
    const started = gate.start(
      () =>
        new Promise<boolean>((resolve) => {
          open = resolve
        }),
      onStop,
    )
    expect(gate.active).toBe(true)
    expect(gate.takeStop()).toBe(false)
    expect(gate.takeStop()).toBe(false)
    open(true)
    await started
    expect(onStop).toHaveBeenCalledTimes(1)
    expect(onStop.mock.results[0].value).toBe(true)
    expect(gate.active).toBe(false)
  })

  it('ignores a second start while one is opening or recording', async () => {
    const gate = new CaptureGate()
    const open = vi.fn().mockResolvedValue(true)
    await gate.start(open, () => undefined)
    await gate.start(open, () => undefined)
    expect(open).toHaveBeenCalledTimes(1)
    expect(gate.isRecording).toBe(true)
    expect(gate.abandon()).toBe(true)
    expect(gate.abandon()).toBe(false)
  })

  it('does not stop a capture that never opened', async () => {
    const gate = new CaptureGate()
    const onStop = vi.fn()
    let open: (value: boolean) => void = () => undefined
    const started = gate.start(
      () =>
        new Promise<boolean>((resolve) => {
          open = resolve
        }),
      onStop,
    )
    gate.takeStop()
    open(false)
    await started
    expect(onStop).not.toHaveBeenCalled()
    expect(gate.active).toBe(false)
  })

  it('resets and rethrows when opening fails', async () => {
    const gate = new CaptureGate()
    await expect(gate.start(() => Promise.reject(new Error('no mic')), vi.fn())).rejects.toThrow(
      'no mic',
    )
    expect(gate.active).toBe(false)
  })
})
