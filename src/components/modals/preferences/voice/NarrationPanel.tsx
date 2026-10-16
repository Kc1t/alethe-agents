import { useEffect, useId, useMemo, useRef, useState } from 'react'

import { intlLocale, useT } from '../../../../lib/i18n'
import { ttsSpeak, type TtsVoice, ttsVoices } from '../../../../lib/tauri'
import type { TtsChoice } from '../../../../lib/types'
import { CLOUD_VOICE_PROVIDERS, DEFAULT_TTS_CHOICE } from '../../../../lib/voice/providers'
import {
  defaultVoice,
  isMultilingual,
  sortVoicesForLocale,
  voiceOption,
} from '../../../../lib/voice/voiceLanguages'
import { withTtsChoice } from '../../../../lib/voice/voicePreferences'
import { useProjectsStore } from '../../../../stores/projectsStore'
import { Dropdown } from '../../../ui/Dropdown'
import controls from '../../controls.module.css'
import { CloudUseCard } from './CloudUseCard'
import { localStateWarning } from './inUseWarnings'
import { ModelDropdown } from './ModelDropdown'
import { ModelSummaryLine } from './ModelSummaryLine'
import styles from './NarrationPanel.module.css'
import { ProviderGroup } from './ProviderGroup'
import { PROVIDER_META, type VoiceProviderId } from './providerMeta'
import { ProviderUseCard } from './ProviderUseCard'
import { useSpeechInventory } from './useSpeechInventory'
import { useVoiceCatalog } from './useVoiceCatalog'

export const NARRATION_RATES = [1, 1.25, 1.5, 2]

/** Voice lists longer than this get a search box. */
const VOICE_SEARCH_THRESHOLD = 8

function voiceListKey(provider: string, model: string): string {
  return `${provider}\u0000${model}`
}

export function NarrationPanel({
  onOpenProvider,
}: {
  onOpenProvider: (id: VoiceProviderId) => void
}) {
  const t = useT()
  const choice = useProjectsStore((s) => s.preferences.voiceTts)
  const narrationPaused = useVoiceConversationStore((s) => s.narrationPaused)
  const language = useProjectsStore((s) => s.preferences.language)
  const setPreferences = useProjectsStore((s) => s.setPreferences)
  const { models, states } = useSpeechInventory()
  const { catalog } = useVoiceCatalog()
  const appLocale = intlLocale(language)
  const [fetched, setFetched] = useState<{ key: string; list: TtsVoice[] } | null>(null)
  // The provider/model whose loaded voice list was last checked against the saved voice.
  const checkedKey = useRef<string | null>(null)
  // The provider/model just picked; once its voice list loads, a default voice is filled in.
  const wantsDefault = useRef<string | null>(null)

  // OpenRouter's live catalog already names each model's voices; other providers are asked.
  const catalogVoices = useMemo(() => {
    if (choice.provider !== 'openrouter') return null
    const ids = catalog
      .find((entry) => entry.provider === 'openrouter')
      ?.models.find((model) => model.capability === 'tts' && model.id === choice.model)?.voices
    return ids && ids.length > 0 ? ids.map((id) => ({ id, name: id, language: '' })) : null
  }, [catalog, choice.provider, choice.model])
  const fromCatalog = catalogVoices !== null
  const voicesKey = voiceListKey(choice.provider, choice.model)

  useEffect(() => {
    if (fromCatalog) return
    let cancelled = false
    const key = voiceListKey(choice.provider, choice.model)
    void ttsVoices(choice.provider, choice.model || undefined)
      .then((list) => {
        if (!cancelled) setFetched({ key, list })
      })
      .catch(() => {
        if (!cancelled) setFetched({ key, list: [] })
      })
    return () => {
      cancelled = true
    }
  }, [choice.provider, choice.model, listModel, fromCatalog])

  // null while the list for the current provider/model is still loading.
  const voices = catalogVoices ?? (fetched?.key === voicesKey ? fetched.list : null)
  const sortedVoices = useMemo(
    () => sortVoicesForLocale(voices ?? [], appLocale),
    [voices, appLocale],
  )

  const patch = (next: Partial<TtsChoice>) =>
    setPreferences(withTtsChoice({ voiceTts: choice }, next))

  // Once per loaded list, the app-language default replaces: a saved voice the list lacks; no
  // voice right after picking a provider or model; no voice on ElevenLabs, whose voices belong to
  // the account so the backend has no default. Elsewhere a null voice is the provider default
  // (OpenAI, Gemini, OpenRouter, single-speaker local models) and is kept; the system voice too.
  useEffect(() => {
    if (voices === null || checkedKey.current === voicesKey) return
    checkedKey.current = voicesKey
    // A pending pick for another provider/model stays pending: a render can still carry the
    // previous list when that list's reply lands in the same batch as the pick.
    const picked = wantsDefault.current === voicesKey
    if (picked) wantsDefault.current = null
    const fillsNull = picked || choice.provider === 'elevenlabs'
    if (choice.voice ? voices.some((voice) => voice.id === choice.voice) : !fillsNull) return
    const next = defaultVoice(voices, appLocale)
    if (next) setPreferences(withTtsChoice({ voiceTts: choice }, { voice: next.id }))
  }, [voices, voicesKey, choice, appLocale, setPreferences])

  const pick = (provider: TtsChoice['provider'], model: string) => {
    if (provider === choice.provider && model === choice.model) return
    wantsDefault.current = provider === 'system' ? null : voiceListKey(provider, model)
    patch({ provider, model, voice: provider === choice.provider ? choice.voice : null })
  }

  const readyLocal = models.filter(
    (model) =>
      model.kind === 'download' &&
      model.capability === 'tts' &&
      states[model.id]?.status === 'ready',
  )
  const selectedVoice = choice.voice
    ? (sortedVoices.find((voice) => voice.id === choice.voice) ?? { id: choice.voice })
    : null
  const multilingual = selectedVoice !== null && isMultilingual(selectedVoice)
  const localSelected = choice.provider === 'local'
  const localName = t('voice.provider.local')
  // A removed or cancelled local voice; quiet until the inventory loads.
  const localWarning =
    localSelected && models.length > 0 ? localStateWarning(states[choice.model]?.status) : null

  return (
    <div className={styles.root} data-setting-id="voice-conversation-voice" tabIndex={-1}>
      <div className={styles.groups} role="radiogroup" aria-label={t('prefs.voiceTabNarration')}>
        <ProviderGroup title={t('prefs.voiceGroupLocal')}>
          <ProviderUseCard
            icon={PROVIDER_META.local.icon}
            title={localName}
            description={t(PROVIDER_META.local.description)}
            status={
              localWarning ? 'notReady' : readyLocal.length > 0 ? 'connected' : 'disconnected'
            }
            selected={localSelected}
            disabled={readyLocal.length === 0}
            summary={localSelected ? <ModelSummaryLine modelId={choice.model} /> : undefined}
            note={localWarning ? t(localWarning) : undefined}
            onSelect={() => {
              if (!localSelected && readyLocal.length > 0) pick('local', readyLocal[0].id)
            }}
            footer={
              <>
                {readyLocal.length > 0 ? (
                  <ModelDropdown
                    provider={localName}
                    models={readyLocal}
                    value={localSelected ? (localWarning ? '' : choice.model) : readyLocal[0].id}
                    onChange={(id) => pick('local', id)}
                  />
                ) : null}
                {readyLocal.length === 0 || localWarning ? (
                  <button
                    type="button"
                    className={controls.btn}
                    onClick={() => onOpenProvider('local', 'tts')}
                  >
                    {t('prefs.voiceActionManageModels')}
                  </button>
                ) : null}
              </>
            }
          />
          <ProviderUseCard
            icon={PROVIDER_META.system.icon}
            title={t('voice.provider.system')}
            description={t(PROVIDER_META.system.description)}
            status="connected"
            selected={choice.provider === 'system'}
            onSelect={() => {
              if (choice.provider === 'system') return
              wantsDefault.current = null
              patch({ ...DEFAULT_TTS_CHOICE, rate: choice.rate, voice: null })
            }}
          />
        </ProviderGroup>
        <ProviderGroup title={t('prefs.voiceGroupCloud')}>
          {CLOUD_VOICE_PROVIDERS.map((provider) => {
            const entry = catalog.find((item) => item.provider === provider)
            const ttsModels = entry?.models.filter((model) => model.capability === 'tts') ?? []
            if (ttsModels.length === 0) return null
            return (
              <CloudUseCard
                key={provider}
                provider={provider}
                models={ttsModels}
                selected={choice.provider === provider}
                model={choice.model}
                onPick={(id) => pick(provider, id)}
                onOpenProvider={onOpenProvider}
                note={t('prefs.voiceCloudSendsText', {
                  provider: t(PROVIDER_META[provider].name),
                })}
              />
            )
          })}
        </ProviderGroup>
      </div>

      <div className={styles.controls}>
        <label className={styles.field}>
          <span>{t('prefs.voiceConvVoice')}</span>
          <Dropdown
            value={choice.voice ?? ''}
            ariaLabel={t('prefs.voiceConvVoice')}
            searchable={sortedVoices.length > VOICE_SEARCH_THRESHOLD}
            searchPlaceholder={t('prefs.voiceSearchVoices')}
            options={[
              { value: '', label: t('prefs.voiceDefaultVoice') },
              ...sortedVoices.map((voice) => voiceOption(voice, appLocale, t)),
            ]}
            onChange={(value) => {
              wantsDefault.current = null
              patch({ voice: value || null })
            }}
          />
          {multilingual ? (
            <small className={styles.hint}>{t('prefs.voiceLangMultiHint')}</small>
          ) : null}
        </label>
        <div className={styles.field}>
          <span>{t('prefs.voiceConvRate')}</span>
          <div className={styles.rates} role="radiogroup" aria-label={t('prefs.voiceConvRate')}>
            {NARRATION_RATES.map((rate) => (
              <button
                key={rate}
                type="button"
                role="radio"
                aria-checked={choice.rate === rate}
                className={choice.rate === rate ? styles.rateActive : styles.rate}
                onClick={() => patch({ rate })}
              >
                {t('prefs.voiceConvRateValue', { rate })}
              </button>
            ))}
          </div>
        </div>
        <button
          type="button"
          className={controls.btn}
          disabled={narrationPaused}
          title={narrationPaused ? t('prefs.voiceTestPausedHint') : undefined}
          onClick={() => void ttsSpeak(t('prefs.voiceTestSentence'), choice)}
        >
          {t('prefs.voiceTest')}
        </button>
        {/* The paused conversation holds the player: a test would play nothing. */}
        {narrationPaused ? (
          <small className={styles.hint}>{t('prefs.voiceTestPausedHint')}</small>
        ) : null}
      </div>
    </div>
  )
}
