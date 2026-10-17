import { useState } from 'react'

import { intlLocale, type TFunction, useT } from '../../../../lib/i18n'
import type { MessageKey } from '../../../../lib/i18n/messages/en'
import type { VoiceCatalogModel, VoiceProviderCatalog } from '../../../../lib/tauri'
import type { CloudVoiceProviderId } from '../../../../lib/types'
import {
  defaultVoice,
  describeVoice,
  languageName,
  sortVoicesForLocale,
  voiceDisplayName,
  type VoiceLike,
} from '../../../../lib/voice/voiceLanguages'
import { withSttChoice, withTtsChoice } from '../../../../lib/voice/voicePreferences'
import { useProjectsStore } from '../../../../stores/projectsStore'
import controls from '../../controls.module.css'
import { CloudKeyForm } from './CloudKeyForm'
import styles from './CloudModelsView.module.css'
import { ModelTable, type TableColumn, type TableRow, type TableSection } from './ModelTable'
import { cloudUsesOf, USE_LABEL, type VoiceTabUse } from './modelUses'
import { cloudStatus, PROVIDER_META } from './providerMeta'

type Kind = VoiceCatalogModel['capability']

const COLUMNS: TableColumn[] = ['languages', 'voices', 'price']
const SEARCH_ABOVE = 6

const STATUS_KEY = {
  connected: 'prefs.voiceStatusConnected',
  disconnected: 'prefs.voiceStatusDisconnected',
  invalid: 'prefs.voiceStatusInvalid',
} as const

const SECTIONS: { id: Kind; title: MessageKey; hint: MessageKey }[] = [
  { id: 'stt', title: 'prefs.voiceSectionSttTitle', hint: 'prefs.voiceSectionSttHint' },
  { id: 'tts', title: 'prefs.voiceSectionTtsTitle', hint: 'prefs.voiceSectionTtsHint' },
]

const USES_BY_KIND: Record<Kind, VoiceTabUse[]> = {
  stt: ['dictation', 'conversation'],
  tts: ['narration'],
}

const joinUses = (uses: VoiceTabUse[], t: TFunction) =>
  uses.map((use) => t(USE_LABEL[use])).join(', ')

/** Languages the voice ids encode; "—" when none does (multilingual voices only). */
function languagesCell(voices: VoiceLike[], t: TFunction, locale: string): string | undefined {
  const langs = new Set(
    voices
      .map((voice) => describeVoice(voice.id, voice.language).lang)
      .filter((lang) => lang !== 'multi'),
  )
  if (langs.size === 0) return undefined
  if (langs.size === 1) return languageName([...langs][0], locale)
  return t('prefs.voiceModelLanguagesMany', { count: langs.size })
}

/** Voices by language, languages in the order their first voice sorts for the app locale. */
function voiceGroups(voices: VoiceLike[], locale: string): [string, VoiceLike[]][] {
  const groups = new Map<string, VoiceLike[]>()
  for (const voice of sortVoicesForLocale(voices, locale)) {
    const { lang } = describeVoice(voice.id, voice.language)
    groups.set(lang, [...(groups.get(lang) ?? []), voice])
  }
  return [...groups]
}

/** A cloud provider's account header, key form and model comparison table. */
export function CloudModelsView({
  provider,
  catalog,
}: {
  provider: CloudVoiceProviderId
  catalog: VoiceProviderCatalog
}) {
  const t = useT()
  const language = useProjectsStore((s) => s.preferences.language)
  const voiceStt = useProjectsStore((s) => s.preferences.voiceStt)
  const voiceTts = useProjectsStore((s) => s.preferences.voiceTts)
  const flag = useProjectsStore((s) => s.preferences.voiceProviders[provider])
  const setPreferences = useProjectsStore((s) => s.setPreferences)
  const [query, setQuery] = useState('')
  const locale = intlLocale(language)
  const status = cloudStatus(flag)
  const hasKey = flag?.configured === true
  const name = t(PROVIDER_META[provider].name)
  const providerUses = cloudUsesOf({ voiceStt, voiceTts }, provider)

  /** The model's own voices (OpenRouter), else the provider's curated voices for speech models. */
  const voicesOf = (model: VoiceCatalogModel): VoiceLike[] => {
    if (model.voices && model.voices.length > 0) return model.voices.map((id) => ({ id }))
    if (model.capability !== 'tts') return []
    return catalog.voices.map((voice) => ({ id: voice.id, name: voice.label }))
  }

  /**
   * Narration gets the app-language default when the model's voices are known here; otherwise
   * (ElevenLabs account voices) the voice stays empty and the Narration tab fills it once listed.
   */
  const assign = (use: VoiceTabUse, model: VoiceCatalogModel) => {
    if (use === 'narration') {
      const voice = defaultVoice(voicesOf(model), locale)?.id ?? null
      setPreferences(withTtsChoice({ voiceTts }, { provider, model: model.id, voice }))
    } else {
      setPreferences(withSttChoice({ voiceStt }, use, { provider, model: model.id, locale: null }))
    }
  }

  const rowFor = (model: VoiceCatalogModel): TableRow => {
    const voices = voicesOf(model)
    const uses = cloudUsesOf({ voiceStt, voiceTts }, provider, model.id)
    return {
      id: model.id,
      name: model.label,
      cells: {
        languages: languagesCell(voices, t, locale),
        voices: voices.length > 0 ? voices.length : undefined,
        price: model.price ? (
          <span title={t('prefs.voicePriceHint')}>
            {model.price}{' '}
            <span className={styles.priceUnit}>{t('prefs.voicePricePerMillion')}</span>
          </span>
        ) : undefined,
      },
      details: (
        <div className={styles.details}>
          <p className={styles.text}>
            <span className={styles.label}>{t('prefs.voiceUsedIn')}</span>
            {uses.length > 0 ? joinUses(uses, t) : t('prefs.voiceNotInUseShort')}
          </p>
          <div className={styles.uses}>
            {USES_BY_KIND[model.capability].map((use) => {
              const active = uses.includes(use)
              return (
                <button
                  key={use}
                  type="button"
                  className={`${controls.btn} ${controls.btnSm}`}
                  aria-pressed={active}
                  disabled={!hasKey || active}
                  title={hasKey ? undefined : t('prefs.voiceWarnNoKey')}
                  onClick={() => assign(use, model)}
                >
                  {t('prefs.voiceUseFor', { use: t(USE_LABEL[use]) })}
                </button>
              )
            })}
          </div>
          {voiceGroups(voices, locale).map(([lang, group]) => {
            const label = lang === 'multi' ? t('prefs.voiceLangMulti') : languageName(lang, locale)
            return (
              <div key={lang} role="group" aria-label={label} className={styles.voiceGroup}>
                <span className={styles.label}>{label}</span>
                <ul className={styles.voiceList}>
                  {group.map((voice) => (
                    <li key={voice.id}>{voiceDisplayName(voice, t)}</li>
                  ))}
                </ul>
              </div>
            )
          })}
        </div>
      ),
    }
  }

  const needle = query.trim().toLowerCase()
  const shown = catalog.models.filter((model) =>
    `${model.label} ${model.id}`.toLowerCase().includes(needle),
  )
  const sections: TableSection[] = SECTIONS.map((section) => ({
    id: section.id,
    title: t(section.title),
    hint: t(section.hint),
    rows: shown.filter((model) => model.capability === section.id).map(rowFor),
  })).filter((section) => section.rows.length > 0)
  const priced = shown.some((model) => model.price)

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <div className={styles.headerRow}>
          <span className={styles.badge} data-status={status}>
            <span className={styles.dot} aria-hidden="true" />
            {t(STATUS_KEY[status])}
          </span>
          <span className={styles.inUse}>
            {providerUses.length > 0
              ? t('prefs.voiceInUseFor', { uses: joinUses(providerUses, t) })
              : t('prefs.voiceNotInUseShort')}
          </span>
        </div>
        <p className={styles.privacy}>{t('prefs.voiceCloudPrivacy', { provider: name })}</p>
      </div>
      <CloudKeyForm provider={provider} keyUrl={catalog.keyUrl} />
      <h3 className={styles.subTitle}>{t('prefs.voiceDetailModels')}</h3>
      <ModelTable
        sections={sections}
        columns={COLUMNS}
        empty={sections.length === 0 && needle ? t('prefs.voiceNoModelsMatch') : undefined}
        search={
          catalog.models.length > SEARCH_ABOVE
            ? { value: query, onChange: setQuery, placeholder: t('prefs.voiceSearchModels') }
            : undefined
        }
      />
      {priced ? <p className={styles.priceNote}>{t('prefs.voicePriceHint')}</p> : null}
    </div>
  )
}
