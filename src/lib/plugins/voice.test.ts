import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Disposable, PluginVoice } from './types'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(async () => undefined as unknown),
  listen: vi.fn(),
  openModal: vi.fn(),
  log: vi.fn(),
}))
vi.mock('../tauri', () => ({ pluginInvoke: mocks.invoke, pluginListen: mocks.listen }))
vi.mock('../auditLogger', () => ({ auditLogger: { log: mocks.log } }))
vi.mock('../../stores/uiStore', () => ({
  useUiStore: { getState: () => ({ openModal_: mocks.openModal }) },
}))

const { createPluginVoice } = await import('./voice')

const gatedCalls: [string, (voice: PluginVoice) => unknown][] = [
  ['voice.listen', (v) => v.inputDevices()],
  ['voice.listen', (v) => v.nativeLocales()],
  ['voice.listen', (v) => v.modelStates('en-US')],
  ['voice.listen', (v) => v.prepare({ modelId: 'local' })],
  ['voice.listen', (v) => v.startCapture()],
  ['voice.listen', (v) => v.captureLevel()],
  ['voice.listen', (v) => v.vadStatus()],
  ['voice.listen', (v) => v.prepareVad()],
  ['voice.listen', (v) => v.stopCapture()],
  ['voice.listen', (v) => v.stopAndTranscribe({ modelId: 'local' })],
  ['voice.listen', (v) => v.transcribePartial({ modelId: 'local' })],
  ['voice.speak', (v) => v.speak('hello')],
  ['voice.speak', (v) => v.prefetch('hello')],
  ['voice.speak', (v) => v.stop()],
  ['voice.speak', (v) => v.pause()],
  ['voice.speak', (v) => v.resume()],
  ['voice.speak', (v) => v.setMuted(true)],
  ['voice.speak', (v) => v.voices()],
  ['voice.speak', (v) => v.onStart(() => {})],
  ['voice.speak', (v) => v.onEnd(() => {})],
  ['voice.hud', (v) => v.hud.show({ kind: 'preset', preset: 'bottom-center' })],
  ['voice.hud', (v) => v.hud.hide()],
  ['voice.hud', (v) => v.hud.publish('{}')],
  ['voice.hud', (v) => v.hud.onAction(() => {})],
  ['voice.hud', (v) => v.hud.onMoved(() => {})],
  ['voice.hud', (v) => v.hud.setShortcut(null)],
  ['voice.hud', (v) => v.hud.onShortcut(() => {})],
]

describe('plugin voice', () => {
  let subscriptions: Disposable[]
  beforeEach(() => {
    vi.resetAllMocks()
    subscriptions = []
    mocks.listen.mockResolvedValue(vi.fn())
  })

  it.each(gatedCalls)('checks %s before reaching the backend (%#)', async (capability, call) => {
    const require = vi.fn(() => {
      throw new Error('capability_denied')
    })
    const voice = createPluginVoice(require, subscriptions)
    await expect(Promise.resolve().then(() => call(voice))).rejects.toThrow('capability_denied')
    expect(require).toHaveBeenCalledExactlyOnceWith(capability)
    expect(mocks.invoke).not.toHaveBeenCalled()
    expect(mocks.listen).not.toHaveBeenCalled()
    expect(subscriptions).toEqual([])
  })

  it('maps capture and transcription options to registered commands without accepting keys', async () => {
    const voice = createPluginVoice(() => {}, subscriptions)
    const opts = { provider: 'openai' as const, modelId: 'whisper-1', locale: 'en-US' }
    const result = 'hello world'
    mocks.invoke.mockResolvedValue(result)
    await voice.inputDevices()
    await voice.nativeLocales()
    await voice.modelStates('en-US')
    await voice.prepare(opts)
    await voice.startCapture('mic')
    await voice.captureLevel()
    await voice.vadStatus()
    await voice.prepareVad()
    await voice.stopCapture()
    expect(
      await voice.stopAndTranscribe({
        ...opts,
        fallbackLocale: 'en-US',
        usage: 'dictation',
        apiKey: 'ignored',
      } as typeof opts),
    ).toBe(result)
    await voice.transcribePartial(opts)
    expect(mocks.invoke.mock.calls).toEqual([
      ['speech_list_input_devices'],
      ['speech_native_locales'],
      ['speech_model_states', { locale: 'en-US' }],
      ['speech_prepare', opts],
      ['speech_start_capture', { deviceId: 'mic' }],
      ['speech_capture_level'],
      ['speech_vad_status'],
      ['speech_prepare_vad'],
      ['speech_stop_capture'],
      ['speech_stop_and_transcribe', { ...opts, fallbackLocale: 'en-US', usage: 'dictation' }],
      ['speech_transcribe_partial', { modelId: 'whisper-1', locale: 'en-US' }],
    ])
  })

  it('maps speech options and playback controls without forwarding extra fields', async () => {
    const voice = createPluginVoice(() => {}, subscriptions)
    mocks.invoke.mockResolvedValue(42)
    const opts = { provider: 'server' as const, model: 'model', voice: 'v', rate: 1, server: 's' }
    expect(await voice.speak('hello', opts)).toBe(42)
    await voice.prefetch('hello', opts)
    await voice.stop()
    await voice.pause()
    await voice.resume()
    await voice.setMuted(true)
    await voice.voices(opts)
    expect(mocks.invoke.mock.calls).toEqual([
      ['tts_speak', { text: 'hello', ...opts }],
      ['tts_prefetch', { text: 'hello', provider: 'server', model: 'model', voice: 'v', rate: 1 }],
      ['tts_stop'],
      ['tts_pause'],
      ['tts_resume'],
      ['tts_set_muted', { muted: true }],
      ['tts_voices', { provider: 'server', model: 'model', server: 's' }],
    ])
  })

  it('relays HUD placement, serialized state and the shared shortcut', async () => {
    const voice = createPluginVoice(() => {}, subscriptions)
    const placement = { kind: 'preset' as const, preset: 'bottom-center' as const }
    await voice.hud.show(placement)
    await voice.hud.hide()
    await voice.hud.publish('{"mode":"idle"}')
    await voice.hud.setShortcut('Ctrl+E')
    await voice.hud.setShortcut(null)
    expect(mocks.invoke.mock.calls).toEqual([
      ['voice_hud_show', { placement }],
      ['voice_hud_hide'],
      ['voice_hud_publish', { state: '{"mode":"idle"}' }],
      ['voice_shortcut_set', { accelerator: 'Ctrl+E' }],
      ['voice_shortcut_set', { accelerator: null }],
    ])
  })

  it('propagates command failures to the caller', async () => {
    mocks.invoke.mockRejectedValue(new Error('microphone_unavailable'))
    await expect(createPluginVoice(() => {}, subscriptions).startCapture()).rejects.toThrow(
      'microphone_unavailable',
    )
  })

  it('lists catalog entries and boolean key status without a capability or secret fields', async () => {
    mocks.invoke
      .mockResolvedValueOnce([
        {
          provider: 'openai',
          keyUrl: 'https://example.com',
          models: [],
          voices: [],
          key: 'never expose',
        },
      ])
      .mockResolvedValueOnce(true)
    const require = vi.fn()
    const voice = createPluginVoice(require, subscriptions)
    expect(await voice.providers()).toEqual([
      { provider: 'openai', keyUrl: 'https://example.com', models: [], voices: [], hasKey: true },
    ])
    expect(mocks.invoke.mock.calls).toEqual([
      ['voice_provider_catalog'],
      ['voice_provider_key_status', { provider: 'openai' }],
    ])
    voice.openSettings()
    expect(mocks.openModal).toHaveBeenCalledExactlyOnceWith('preferences', { category: 'voice' })
    expect(require).not.toHaveBeenCalled()
  })

  it('rejects provider discovery when key status cannot be read', async () => {
    mocks.invoke
      .mockResolvedValueOnce([{ provider: 'openai', keyUrl: '', models: [], voices: [] }])
      .mockRejectedValueOnce(new Error('keychain_unavailable'))
    await expect(createPluginVoice(() => {}, subscriptions).providers()).rejects.toThrow(
      'keychain_unavailable',
    )
  })

  it('tracks all event listeners and suppresses callbacks after disposal', async () => {
    const voice = createPluginVoice(() => {}, subscriptions)
    const handler = vi.fn()
    const unlisten = vi.fn()
    mocks.listen.mockResolvedValue(unlisten)
    const listeners = [
      voice.onStart(handler),
      voice.onEnd(handler),
      voice.hud.onAction(handler),
      voice.hud.onMoved(handler),
      voice.hud.onShortcut(handler),
    ]
    await Promise.resolve()
    expect(mocks.listen.mock.calls.map(([event]) => event)).toEqual([
      'tts://start',
      'tts://end',
      'voice-hud://action',
      'voice-hud://moved',
      'voice://shortcut',
    ])
    expect(subscriptions).toEqual(listeners)
    const emit = mocks.listen.mock.calls[0][1]
    emit({ id: 42 })
    for (const listener of [...subscriptions].reverse()) listener.dispose()
    emit({ id: 43 })
    listeners[0].dispose()
    expect(handler).toHaveBeenCalledExactlyOnceWith({ id: 42 })
    expect(unlisten).toHaveBeenCalledTimes(5)
    expect(subscriptions).toEqual([])
  })

  it('unlistens when registration resolves after deactivation', async () => {
    const unlisten = vi.fn()
    let resolve!: (stop: () => void) => void
    mocks.listen.mockReturnValue(
      new Promise<() => void>((done) => {
        resolve = done
      }),
    )
    createPluginVoice(() => {}, subscriptions).onStart(() => {})
    subscriptions[0].dispose()
    resolve(unlisten)
    await Promise.resolve()
    expect(unlisten).toHaveBeenCalledOnce()
  })

  it('reports a failed listener registration and removes its subscription', async () => {
    mocks.listen.mockRejectedValue(new Error('event_unavailable'))
    createPluginVoice(() => {}, subscriptions).onStart(() => {})
    await Promise.resolve()
    expect(mocks.log).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'error', category: 'TAURI' }),
    )
    expect(subscriptions).toEqual([])
  })
})
