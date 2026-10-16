import { useEffect, useState } from 'react'

import { useT } from '../../../../lib/i18n'
import {
  APPLE_SPEECH_MODEL_ID,
  listenerCleanup,
  type NativeLocale,
  onSpeechDownloadProgress,
  speechDownloadModel,
  type SpeechDownloadProgress,
  speechNativeLocales,
} from '../../../../lib/tauri'
import type { SttChoice, VoiceUse } from '../../../../lib/types'
import { CLOUD_VOICE_PROVIDERS } from '../../../../lib/voice/providers'
import { withSttChoice } from '../../../../lib/voice/voicePreferences'
import { useProjectsStore } from '../../../../stores/projectsStore'
import { Dropdown } from '../../../ui/Dropdown'
import controls from '../../controls.module.css'
import { ModelDownloadProgress } from '../ModelDownloadProgress'
import { CloudUseCard } from './CloudUseCard'
import { localStateWarning } from './inUseWarnings'
import { ModelDropdown } from './ModelDropdown'
import { ModelSummaryLine } from './ModelSummaryLine'
import { ProviderGroup } from './ProviderGroup'
import { PROVIDER_META, type VoiceProviderId } from './providerMeta'
import { ProviderUseCard } from './ProviderUseCard'
import styles from './SttProviderChoices.module.css'
import { useSpeechInventory } from './useSpeechInventory'
import { useVoiceCatalog } from './useVoiceCatalog'

export function SttProviderChoices({
  use,
  onOpenProvider,
}: {
  use: VoiceUse
  onOpenProvider: (id: VoiceProviderId, filter?: 'stt' | 'tts') => void
}) {
  const t = useT()
  const voiceStt = useProjectsStore((s) => s.preferences.voiceStt)
  const setPreferences = useProjectsStore((s) => s.setPreferences)
  const current = voiceStt[use]
  const { models, states, refresh } = useSpeechInventory(
    current.provider === 'apple' ? current.locale : null,
  )
  const { catalog } = useVoiceCatalog()
  const [locales, setLocales] = useState<NativeLocale[] | null>(null)
  const appleAvailable = models.some((model) => model.id === APPLE_SPEECH_MODEL_ID)
  const [install, setInstall] = useState<SpeechDownloadProgress | null>(null)
  const [installing, setInstalling] = useState(false)

  useEffect(
    () =>
      listenerCleanup(
        onSpeechDownloadProgress((progress) => {
          if (progress.modelId !== APPLE_SPEECH_MODEL_ID) return
          setInstall(progress)
        }),
      ),
    [],
  )

  const installLocale = async (locale: string) => {
    setInstalling(true)
    try {
      await speechDownloadModel(APPLE_SPEECH_MODEL_ID, locale)
      setLocales(await speechNativeLocales())
    } catch {
      // The refreshed state below shows whether the language is still missing.
    } finally {
      setInstalling(false)
      setInstall(null)
      await refresh().catch(() => undefined)
    }
  }

  const noLocales = locales !== null && locales.length === 0
  const appleStatus = states[APPLE_SPEECH_MODEL_ID]?.status
  const appleNote = noLocales
    ? t('prefs.dictationNativeNoLocales')
    : appleStatus === 'needs-locale'
      ? t('prefs.dictationNativeNeedsLocale')
      : appleStatus === 'denied'
        ? t('prefs.dictationNativeDenied')
        : appleStatus === 'unavailable'
          ? t('prefs.dictationNativeUnavailable')
          : appleStatus === 'ready'
            ? t('prefs.dictationNativeReady')
            : undefined

  useEffect(() => {
    if (!appleAvailable) return
    let cancelled = false
    void speechNativeLocales()
      .then((list) => {
        if (!cancelled) setLocales(list)
      })
      .catch(() => {
        if (!cancelled) setLocales([])
      })
    return () => {
      cancelled = true
    }
  }, [appleAvailable])

  const choose = (choice: SttChoice) => setPreferences(withSttChoice({ voiceStt }, use, choice))

  const readyLocal = models.filter(
    (model) =>
      model.kind === 'download' &&
      (model.capability ?? 'stt') === 'stt' &&
      states[model.id]?.status === 'ready',
  )
  const localSelected = current.provider === 'local'
  const localName = t('voice.provider.local')
  // Stay quiet until the inventory loads; before that every model reads as missing.
  const localWarning =
    localSelected && models.length > 0 ? localStateWarning(states[current.model]?.status) : null
  const appleSelected = current.provider === 'apple'

  return (
    <div
      className={styles.groups}
      role="radiogroup"
      aria-label={t(use === 'dictation' ? 'prefs.voiceTabDictation' : 'prefs.voiceTabConversation')}
    >
      <ProviderGroup title={t('prefs.voiceGroupLocal')}>
        <ProviderUseCard
          icon={PROVIDER_META.local.icon}
          title={localName}
          description={t(PROVIDER_META.local.description)}
          status={localWarning ? 'notReady' : readyLocal.length > 0 ? 'connected' : 'disconnected'}
          selected={localSelected}
          disabled={readyLocal.length === 0}
          summary={localSelected ? <ModelSummaryLine modelId={current.model} /> : undefined}
          note={localWarning ? t(localWarning) : undefined}
          onSelect={() => {
            if (localSelected || readyLocal.length === 0) return
            choose({ provider: 'local', model: readyLocal[0].id, locale: null })
          }}
          footer={
            <>
              {readyLocal.length > 0 ? (
                <ModelDropdown
                  provider={localName}
                  models={readyLocal}
                  value={localSelected ? (localWarning ? '' : current.model) : readyLocal[0].id}
                  onChange={(id) => choose({ provider: 'local', model: id, locale: null })}
                />
              ) : null}
              {readyLocal.length === 0 || localWarning ? (
                <button
                  type="button"
                  className={controls.btn}
                  onClick={() => onOpenProvider('local', 'stt')}
                >
                  {t('prefs.voiceActionManageModels')}
                </button>
              ) : null}
            </>
          }
        />
        {appleAvailable ? (
          <ProviderUseCard
            icon={PROVIDER_META.apple.icon}
            title={t('voice.provider.apple')}
            description={t(PROVIDER_META.apple.description)}
            status={appleStatus === 'ready' ? 'connected' : 'disconnected'}
            selected={appleSelected}
            note={appleNote}
            onSelect={() => {
              if (appleSelected) return
              choose({ provider: 'apple', model: APPLE_SPEECH_MODEL_ID, locale: null })
            }}
            footer={
              <>
                {appleSelected && !noLocales ? (
                  <Dropdown
                    value={current.locale ?? ''}
                    ariaLabel={t('prefs.dictationNativeLocale')}
                    onChange={(value) =>
                      choose({
                        provider: 'apple',
                        model: APPLE_SPEECH_MODEL_ID,
                        locale: value || null,
                      })
                    }
                    options={[
                      { value: '', label: t('prefs.dictationNativeLocaleChoose') },
                      ...(locales ?? []).map((locale) => ({
                        value: locale.id,
                        label: t(
                          locale.installed
                            ? 'prefs.dictationNativeLocaleInstalled'
                            : 'prefs.dictationNativeLocaleNeedsInstall',
                          { name: locale.name },
                        ),
                      })),
                    ]}
                  />
                ) : null}
                {appleSelected && current.locale && appleStatus === 'not-installed' ? (
                  <button
                    type="button"
                    className={controls.btn}
                    disabled={installing}
                    onClick={() => void installLocale(current.locale as string)}
                  >
                    {t('prefs.dictationNativeInstall')}
                  </button>
                ) : null}
                {install ? (
                  <ModelDownloadProgress
                    variant="install"
                    progress={install}
                    bytesPerSecond={null}
                  />
                ) : null}
              </>
            }
          />
        ) : null}
      </ProviderGroup>
      <ProviderGroup title={t('prefs.voiceGroupCloud')}>
        {CLOUD_VOICE_PROVIDERS.map((provider) => {
          const entry = catalog.find((item) => item.provider === provider)
          const sttModels = entry?.models.filter((model) => model.capability === 'stt') ?? []
          if (sttModels.length === 0) return null
          return (
            <CloudUseCard
              key={provider}
              provider={provider}
              models={sttModels}
              selected={current.provider === provider}
              model={current.model}
              onPick={(id) => choose({ provider, model: id, locale: null })}
              onOpenProvider={onOpenProvider}
              note={t('prefs.voiceCloudSendsAudio', { provider: t(PROVIDER_META[provider].name) })}
            />
          )
        })}
      </ProviderGroup>
    </div>
  )
}
