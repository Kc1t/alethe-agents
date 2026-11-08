import { useUiStore } from '../../stores/uiStore'
import { auditLogger } from '../auditLogger'
import { pluginInvoke } from '../tauri'
import { holdVoiceConversationHooks } from '../voice/conversationHooks'
import { trackedListen } from './listen'
import { liveSessionIdOf, locateSession } from './terminals'
import type { Disposable, PluginVoice, VoiceProviderCatalog } from './types'

export function createPluginVoice(
  require: (capability: string) => void,
  subscriptions: Disposable[],
  owner: string,
): PluginVoice {
  const listenTo = <T>(event: string, handler: (payload: T) => void): Disposable =>
    trackedListen(subscriptions, event, handler)
  let targeted = false
  let hooksHeld = false

  return {
    inputDevices: () => {
      require('voice.listen')
      return pluginInvoke('speech_list_input_devices')
    },
    nativeLocales: () => {
      require('voice.listen')
      return pluginInvoke('speech_native_locales')
    },
    modelStates: (locale) => {
      require('voice.listen')
      return pluginInvoke('speech_model_states', { locale })
    },
    prepare: ({ provider, modelId, locale }) => {
      require('voice.listen')
      return pluginInvoke('speech_prepare', { provider, modelId, locale })
    },
    startCapture: (deviceId) => {
      require('voice.listen')
      return pluginInvoke('speech_start_capture', { deviceId })
    },
    captureLevel: () => {
      require('voice.listen')
      return pluginInvoke('speech_capture_level')
    },
    vadStatus: () => {
      require('voice.listen')
      return pluginInvoke('speech_vad_status')
    },
    prepareVad: () => {
      require('voice.listen')
      return pluginInvoke('speech_prepare_vad')
    },
    stopCapture: () => {
      require('voice.listen')
      return pluginInvoke('speech_stop_capture')
    },
    stopAndTranscribe: ({ provider, modelId, locale, fallbackLocale, usage }) => {
      require('voice.listen')
      return pluginInvoke('speech_stop_and_transcribe', {
        provider,
        modelId,
        locale,
        fallbackLocale,
        usage,
      })
    },
    transcribePartial: ({ modelId, locale }) => {
      require('voice.listen')
      return pluginInvoke('speech_transcribe_partial', { modelId, locale })
    },
    speak: (text, { provider, model, voice, rate, server } = {}) => {
      require('voice.speak')
      return pluginInvoke('tts_speak', { text, provider, model, voice, rate, server })
    },
    prefetch: (text, { provider, model, voice, rate } = {}) => {
      require('voice.speak')
      return pluginInvoke('tts_prefetch', { text, provider, model, voice, rate })
    },
    stop: () => {
      require('voice.speak')
      return pluginInvoke('tts_stop')
    },
    pause: () => {
      require('voice.speak')
      return pluginInvoke('tts_pause')
    },
    resume: () => {
      require('voice.speak')
      return pluginInvoke('tts_resume')
    },
    setMuted: (muted) => {
      require('voice.speak')
      return pluginInvoke('tts_set_muted', { muted })
    },
    voices: ({ provider, model, server } = {}) => {
      require('voice.speak')
      return pluginInvoke('tts_voices', { provider, model, server })
    },
    onStart: (handler) => {
      require('voice.speak')
      return listenTo('tts://start', handler)
    },
    onEnd: (handler) => {
      require('voice.speak')
      return listenTo('tts://end', handler)
    },
    onProgress: (handler) => {
      require('voice.speak')
      return listenTo('tts://progress', handler)
    },
    setTargets: async (sessionIds) => {
      require('voice.converse')
      require('agent.approve')
      const ptyIds = sessionIds.map((sessionId) => locateSession(sessionId).ptyId)
      if (!targeted && ptyIds.length > 0) {
        targeted = true
        // held permission prompts go back to the terminal once the plugin is gone
        subscriptions.push({
          dispose: () =>
            void pluginInvoke('voice_set_targets', { ptyIds: [] }).catch((error) =>
              auditLogger.log({
                level: 'error',
                category: 'TAURI',
                message: 'Plugin voice targets not cleared: ' + String(error),
              }),
            ),
        })
      }
      await pluginInvoke('voice_set_targets', { ptyIds })
    },
    hookedSessions: async () => {
      require('voice.converse')
      const ptyIds = await pluginInvoke<string[]>('agent_voice_hooked_ptys')
      return ptyIds.flatMap((ptyId) => liveSessionIdOf(ptyId) ?? [])
    },
    setConversationHooks: (enabled) => {
      require('voice.converse')
      holdVoiceConversationHooks(owner, enabled)
      if (!enabled || hooksHeld) return
      hooksHeld = true
      subscriptions.push({ dispose: () => holdVoiceConversationHooks(owner, false) })
    },
    hud: {
      show: (placement) => {
        require('voice.hud')
        return pluginInvoke('voice_hud_show', { placement })
      },
      hide: () => {
        require('voice.hud')
        return pluginInvoke('voice_hud_hide')
      },
      publish: (state) => {
        require('voice.hud')
        return pluginInvoke('voice_hud_publish', { state })
      },
      onAction: (handler) => {
        require('voice.hud')
        return listenTo('voice-hud://action', handler)
      },
      onMoved: (handler) => {
        require('voice.hud')
        return listenTo('voice-hud://moved', handler)
      },
      setShortcut: (accelerator) => {
        require('voice.hud')
        return pluginInvoke('voice_shortcut_set', { accelerator })
      },
      onShortcut: (handler) => {
        require('voice.hud')
        return listenTo('voice://shortcut', handler)
      },
    },
    providers: async () => {
      const catalog =
        await pluginInvoke<Omit<VoiceProviderCatalog, 'hasKey'>[]>('voice_provider_catalog')
      return Promise.all(
        catalog.map(async ({ provider, keyUrl, models, voices }) => ({
          provider,
          keyUrl,
          models: models.map(({ id, label, capability }) => ({ id, label, capability })),
          voices: voices.map(({ id, label }) => ({ id, label })),
          hasKey: await pluginInvoke<boolean>('voice_provider_key_status', { provider }),
        })),
      )
    },
    openSettings: () => useUiStore.getState().openModal_('preferences', { category: 'voice' }),
  }
}
