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

vi.mock('./terminals', () => ({
  ptyOf: (id: string) => {
    if (id !== 'session-1') throw new Error('unknown_session')
    return 'pty-1'
  },
  locateSession: (id: string) => {
    if (id !== 'session-1') throw new Error('unknown_session')
    return { ptyId: 'pty-1' }
  },
  liveSessionIdOf: (id: string) => (id === 'pty-1' ? 'session-1' : null),
}))
const { voiceConversationHooksEnabled } = await import('../voice/conversationHooks')
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
  ['voice.speak', (v) => v.onProgress(() => {})],
  ['voice.converse', (v) => v.setTargets(['session-1'])],
  ['voice.converse', (v) => v.hookedSessions()],
  ['voice.converse', (v) => v.setConversationHooks(true)],
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
    const voice = createPluginVoice(require, subscriptions, 'test')
    await expect(Promise.resolve().then(() => call(voice))).rejects.toThrow('capability_denied')
    expect(require).toHaveBeenCalledExactlyOnceWith(capability)
    expect(mocks.invoke).not.toHaveBeenCalled()
    expect(mocks.listen).not.toHaveBeenCalled()
    expect(subscriptions).toEqual([])
  })

  it('maps capture and transcription options to registered commands without accepting keys', async () => {
    const voice = createPluginVoice(() => {}, subscriptions, 'test')
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
    const voice = createPluginVoice(() => {}, subscriptions, 'test')
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
    const voice = createPluginVoice(() => {}, subscriptions, 'test')
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
    await expect(createPluginVoice(() => {}, subscriptions, 'test').startCapture()).rejects.toThrow(
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
    const voice = createPluginVoice(require, subscriptions, 'test')
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
    await expect(createPluginVoice(() => {}, subscriptions, 'test').providers()).rejects.toThrow(
      'keychain_unavailable',
    )
  })

  it('tracks all event listeners and suppresses callbacks after disposal', async () => {
    const voice = createPluginVoice(() => {}, subscriptions, 'test')
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
    createPluginVoice(() => {}, subscriptions, 'test').onStart(() => {})
    subscriptions[0].dispose()
    resolve(unlisten)
    await Promise.resolve()
    expect(unlisten).toHaveBeenCalledOnce()
  })

  it('reports a failed listener registration and removes its subscription', async () => {
    mocks.listen.mockRejectedValue(new Error('event_unavailable'))
    createPluginVoice(() => {}, subscriptions, 'test').onStart(() => {})
    await Promise.resolve()
    expect(mocks.log).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'error', category: 'TAURI' }),
    )
    expect(subscriptions).toEqual([])
  })
})

describe('plugin voice conversations', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.listen.mockResolvedValue(vi.fn())
  })

  it('maps opaque targets and hooked processes and clears targets on disposal', async () => {
    const subscriptions: Disposable[] = []
    const require = vi.fn()
    const voice = createPluginVoice(require, subscriptions, 'conversation-test')
    await voice.setTargets(['session-1'])
    expect(require.mock.calls).toEqual([['voice.converse'], ['agent.approve']])
    expect(mocks.invoke).toHaveBeenCalledWith('voice_set_targets', { ptyIds: ['pty-1'] })
    mocks.invoke.mockResolvedValueOnce(['pty-1', 'unrelated'])
    expect(await voice.hookedSessions()).toEqual(['session-1'])
    for (const disposable of subscriptions) disposable.dispose()
    await Promise.resolve()
    expect(mocks.invoke).toHaveBeenLastCalledWith('voice_set_targets', { ptyIds: [] })
  })

  it('requires permission approval before holding targets and refuses unknown sessions', async () => {
    const voice = createPluginVoice(
      (cap) => {
        if (cap === 'agent.approve') throw new Error('denied')
      },
      [],
      'test',
    )
    await expect(voice.setTargets(['session-1'])).rejects.toThrow('denied')
    expect(mocks.invoke).not.toHaveBeenCalled()
    const allowed = createPluginVoice(() => {}, [], 'test')
    await expect(allowed.setTargets(['unknown'])).rejects.toThrow('unknown_session')
    expect(mocks.invoke).not.toHaveBeenCalled()
    mocks.invoke.mockRejectedValueOnce(new Error('targets failed'))
    await expect(allowed.setTargets(['session-1'])).rejects.toThrow('targets failed')
  })

  it('keeps hooks on while any plugin requests them and releases its hold on disable', () => {
    const firstSubscriptions: Disposable[] = []
    const secondSubscriptions: Disposable[] = []
    const first = createPluginVoice(() => {}, firstSubscriptions, 'first')
    const second = createPluginVoice(() => {}, secondSubscriptions, 'second')
    try {
      first.setConversationHooks(true)
      first.setConversationHooks(true)
      second.setConversationHooks(true)
      expect(voiceConversationHooksEnabled()).toBe(true)
      first.setConversationHooks(false)
      expect(voiceConversationHooksEnabled()).toBe(true)
      secondSubscriptions[0].dispose()
      expect(voiceConversationHooksEnabled()).toBe(false)
      first.setConversationHooks(true)
      expect(voiceConversationHooksEnabled()).toBe(true)
    } finally {
      firstSubscriptions.forEach((d) => d.dispose())
      secondSubscriptions.forEach((d) => d.dispose())
    }
    expect(voiceConversationHooksEnabled()).toBe(false)
  })

  it('forwards progress offsets and suppresses events after disposal', async () => {
    const subscriptions: Disposable[] = []
    const voice = createPluginVoice(() => {}, subscriptions, 'test')
    const handler = vi.fn()
    const off = voice.onProgress(handler)
    await Promise.resolve()
    const [event, dispatch] = mocks.listen.mock.calls[0]
    expect(event).toBe('tts://progress')
    dispatch({ id: 12, charOffset: 40 })
    expect(handler).toHaveBeenCalledExactlyOnceWith({ id: 12, charOffset: 40 })
    off.dispose()
    dispatch({ id: 12, charOffset: 50 })
    expect(handler).toHaveBeenCalledTimes(1)
    expect(subscriptions).toEqual([])
  })
})
