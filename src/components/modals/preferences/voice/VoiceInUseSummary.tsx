import { TriangleAlert } from 'lucide-react'
import { useEffect, useId, useState } from 'react'

import { intlLocale, useT } from '../../../../lib/i18n'
import {
  APPLE_SPEECH_MODEL_ID,
  speechModelStates,
  voiceProviderCatalog,
} from '../../../../lib/tauri'
import { languageName } from '../../../../lib/voice/modelInfo'
import { isCloudProvider } from '../../../../lib/voice/providers'
import { useProjectsStore } from '../../../../stores/projectsStore'
import { useVoiceServersStore } from '../../../../stores/voiceServersStore'
import { inUseWarnings } from './inUseWarnings'
import { USE_LABEL, type VoiceTabUse } from './modelUses'
import { PROVIDER_META } from './providerMeta'
import type { VoiceTab } from './UsageTabs'
import { useModelDownloads } from './useModelDownloads'
import styles from './VoiceInUseSummary.module.css'

const USES: VoiceTabUse[] = ['dictation', 'conversation', 'narration']

const catalogKey = (provider: string, model: string) => `${provider}\u0000${model}`

/** Labels of the curated cloud models; the bundled catalog, so no network request. */
function useCloudModelLabels(): Map<string, string> {
  const [labels, setLabels] = useState<Map<string, string>>(() => new Map())
  useEffect(() => {
    let cancelled = false
    void voiceProviderCatalog()
      .then((catalog) => {
        if (cancelled) return
        setLabels(
          new Map(
            catalog.flatMap((entry) =>
              entry.models.map((model) => [catalogKey(entry.provider, model.id), model.label]),
            ),
          ),
        )
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])
  return labels
}

/** Apple's status for each chosen language, read once per distinct language. */
function useAppleStatuses(locales: (string | null)[]): Record<string, string> {
  const [statuses, setStatuses] = useState<Record<string, string>>({})
  const key = [...new Set(locales.filter((locale): locale is string => !!locale))]
    .sort()
    .join('\u0000')
  useEffect(() => {
    if (!key) return
    let cancelled = false
    for (const locale of key.split('\u0000')) {
      void speechModelStates(locale)
        .then((states) => {
          const apple = states.find((state) => state.id === APPLE_SPEECH_MODEL_ID)
          if (!cancelled && apple) {
            setStatuses((all) => ({ ...all, [locale]: apple.status }))
          }
        })
        .catch(() => undefined)
    }
    return () => {
      cancelled = true
    }
  }, [key])
  return statuses
}

/** One row per voice use: who runs it, with what, where, and why it would not work. */
export function VoiceInUseSummary({ onOpenTab }: { onOpenTab: (tab: VoiceTab) => void }) {
  const t = useT()
  const titleId = useId()
  const voiceStt = useProjectsStore((s) => s.preferences.voiceStt)
  const voiceTts = useProjectsStore((s) => s.preferences.voiceTts)
  const voiceProviders = useProjectsStore((s) => s.preferences.voiceProviders)
  const language = useProjectsStore((s) => s.preferences.language)
  const servers = useVoiceServersStore((s) => s.servers)
  const serversLoaded = useVoiceServersStore((s) => s.loaded)
  const serversFailed = useVoiceServersStore((s) => s.failed)
  const refreshServers = useVoiceServersStore((s) => s.refresh)
  useEffect(() => {
    if (!serversLoaded) void refreshServers()
  }, [serversLoaded, refreshServers])
  // One downloads hook for all rows: it subscribes to progress events and may poll.
  const downloads = useModelDownloads()
  const cloudLabels = useCloudModelLabels()
  const appleStatuses = useAppleStatuses(
    (['dictation', 'conversation'] as const).map((use) =>
      voiceStt[use].provider === 'apple' ? voiceStt[use].locale : null,
    ),
  )
  const warnings = inUseWarnings(
    { voiceStt, voiceTts, voiceProviders },
    downloads,
    (locale) => appleStatuses[locale],
    serversLoaded && !serversFailed ? servers : null,
  )
  const appLocale = intlLocale(language)

  const detailOf = (provider: string, model: string, locale: string | null): string | null => {
    if (provider === 'local') {
      return downloads.models.find((entry) => entry.id === model)?.label ?? model
    }
    if (provider === 'apple') {
      return locale ? languageName(locale.replace(/_/g, '-'), appLocale) : null
    }
    if (provider === 'server') {
      return servers.find((server) => server.id === voiceTts.server)?.name ?? null
    }
    if (isCloudProvider(provider) && model) {
      return cloudLabels.get(catalogKey(provider, model)) ?? model
    }
    return null
  }

  const rows = USES.map((use) => {
    const choice =
      use === 'narration'
        ? { provider: voiceTts.provider, model: voiceTts.model, locale: null }
        : voiceStt[use]
    const name = t(PROVIDER_META[choice.provider].name)
    const detail = detailOf(choice.provider, choice.model, choice.locale)
    return {
      use,
      value: detail ? `${name} · ${detail}` : name,
      cloud: isCloudProvider(choice.provider),
      warning: warnings[use],
    }
  })

  return (
    <section className={styles.root} aria-labelledby={titleId}>
      <h2 id={titleId} className={styles.title}>
        {t('prefs.voiceInUseTitle')}
      </h2>
      <ul className={styles.list}>
        {rows.map((row) => (
          <li key={row.use}>
            <button type="button" className={styles.row} onClick={() => onOpenTab(row.use)}>
              <span className={styles.use}>{t(USE_LABEL[row.use])}</span>
              <span className={styles.value}>{row.value}</span>
              {row.warning ? (
                <span className={styles.warning}>
                  <TriangleAlert size={12} aria-hidden="true" />
                  {t(row.warning)}
                </span>
              ) : null}
              <span className={styles.marker}>
                {t(row.cloud ? 'prefs.voiceBadgeCloud' : 'prefs.voiceBadgeDevice')}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
