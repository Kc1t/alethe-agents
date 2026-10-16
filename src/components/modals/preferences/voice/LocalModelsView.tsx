import { ExternalLink } from 'lucide-react'
import { type ReactNode, useState } from 'react'

import { getLocale, intlLocale, type TFunction, useT } from '../../../../lib/i18n'
import type { MessageKey } from '../../../../lib/i18n/messages/en'
import {
  etaSeconds,
  formatByteSize,
  formatDuration,
  formatRate,
} from '../../../../lib/speech/downloadStats'
import {
  DOWNLOAD_BUSY,
  openInBrowser,
  type SpeechModelManifest,
  speechModelStates,
} from '../../../../lib/tauri'
import { hubErrorKey } from '../../../../lib/voice/hubModels'
import {
  isRecommended,
  languagesLabel,
  languagesList,
  modelInfoFor,
  type ModelUse,
} from '../../../../lib/voice/modelInfo'
import { withSttChoice, withTtsChoice } from '../../../../lib/voice/voicePreferences'
import { useProjectsStore } from '../../../../stores/projectsStore'
import controls from '../../controls.module.css'
import { ModelDownloadProgress } from '../ModelDownloadProgress'
import { HubDetails } from './HubDetails'
import { HubSearchControls } from './HubSearchControls'
import styles from './LocalModelsView.module.css'
import { LocalVoiceSelect } from './LocalVoiceSelect'
import { ModelTable, type TableColumn, type TableRow, type TableSection } from './ModelTable'
import { clearLocalModelUses, USE_LABEL, usesOf, type VoiceTabUse } from './modelUses'
import { TierDots } from './TierDots'
import { useHubSearch } from './useHubSearch'
import { type RowStatus, useModelDownloads } from './useModelDownloads'

type Filter = 'stt' | 'tts' | 'all'
type Mode = 'installed' | 'search'

const COLUMNS: TableColumn[] = ['languages', 'speed', 'accuracy', 'size', 'status']
const SEARCH_COLUMNS: TableColumn[] = [
  'languages',
  'speed',
  'accuracy',
  'voices',
  'size',
  'likes',
  'status',
]

const USES_BY_KIND: Record<ModelUse, VoiceTabUse[]> = {
  stt: ['dictation', 'conversation'],
  tts: ['narration'],
}

/** A voice's accuracy tier rates how natural it sounds. */
const ACCURACY_LABEL: Record<ModelUse, MessageKey> = {
  stt: 'prefs.voiceColAccuracy',
  tts: 'prefs.voiceColQuality',
}

const SECTIONS: { id: ModelUse; title: MessageKey; hint: MessageKey }[] = [
  { id: 'stt', title: 'prefs.voiceSectionSttTitle', hint: 'prefs.voiceSectionSttHint' },
  { id: 'tts', title: 'prefs.voiceSectionTtsTitle', hint: 'prefs.voiceSectionTtsHint' },
]

/** Backend errors arrive raw; only a few are meaningful to the user. */
function errorKey(message: string): MessageKey {
  const hub = hubErrorKey(message)
  if (hub) return hub
  if (message.includes(DOWNLOAD_BUSY)) return 'prefs.voiceDownloadBusy'
  if (/No space left|os error (28|112)\b/i.test(message)) return 'prefs.voiceDiskFull'
  return 'prefs.voiceDownloadFailed'
}

function modelUse(model: SpeechModelManifest): ModelUse {
  return modelInfoFor(model.id)?.use ?? model.capability ?? 'stt'
}

const joinUses = (uses: VoiceTabUse[], t: TFunction) =>
  uses.map((use) => t(USE_LABEL[use])).join(', ')

function statusText(status: RowStatus, uses: VoiceTabUse[], t: TFunction, locale: string): string {
  switch (status.kind) {
    case 'not-downloaded':
      return t('prefs.voiceModelStatusNotDownloaded')
    case 'downloading': {
      const percent = Math.round((status.progress?.fraction ?? 0) * 100)
      if (!status.bytesPerSecond) return t('prefs.voiceModelStatusDownloading', { percent })
      const speed = formatRate(status.bytesPerSecond, locale)
      const { progress } = status
      const eta =
        progress && progress.total > 0
          ? etaSeconds(progress.total - progress.downloaded, status.bytesPerSecond)
          : null
      return eta === null
        ? t('prefs.voiceModelStatusDownloadingRate', { percent, speed })
        : t('prefs.voiceModelStatusDownloadingEta', {
            percent,
            speed,
            eta: formatDuration(eta, locale),
          })
    }
    case 'verifying':
      return t('prefs.voiceModelStatusVerifying')
    case 'unpacking':
      return t('prefs.voiceModelStatusUnpacking')
    case 'paused':
      return t('prefs.voiceModelStatusPaused', {
        done: formatByteSize(status.downloaded, locale),
        total: formatByteSize(status.total, locale),
      })
    case 'ready':
      return uses.length > 0
        ? t('prefs.voiceModelStatusInUse', { uses: joinUses(uses, t) })
        : t('prefs.voiceModelStatusReady')
    case 'error':
      if (status.action === 'remove') return t('prefs.voiceRemoveFailed')
      if (status.action === 'cancel') return t('prefs.voiceCancelFailed')
      return t('prefs.voiceModelStatusError', { message: t(errorKey(status.message)) })
  }
}

/** Every downloadable local model, compared side by side and managed in place. */
export function LocalModelsView({
  initialFilter,
  initialMode,
}: {
  initialFilter?: Filter
  initialMode?: Mode
}) {
  const t = useT()
  const locale = intlLocale(getLocale())
  const voiceStt = useProjectsStore((s) => s.preferences.voiceStt)
  const voiceTts = useProjectsStore((s) => s.preferences.voiceTts)
  const setPreferences = useProjectsStore((s) => s.setPreferences)
  const { models, loadFailed, retry, activeId, statusOf, download, pause, cancel, remove } =
    useModelDownloads()
  const [filter, setFilter] = useState<Filter>(initialFilter ?? 'all')
  const [mode, setMode] = useState<Mode>(initialMode ?? 'installed')
  const [query, setQuery] = useState('')
  const [language, setLanguage] = useState<string | null>(null)
  const [sort, setSort] = useState<'likes' | 'recent'>('likes')
  const search = useHubSearch({
    use: filter === 'all' ? null : filter,
    query,
    language,
    sort,
    enabled: mode === 'search',
  })

  const assign = (use: VoiceTabUse, modelId: string) => {
    if (use === 'narration') {
      setPreferences(
        withTtsChoice({ voiceTts }, { provider: 'local', model: modelId, voice: null }),
      )
    } else {
      setPreferences(
        withSttChoice({ voiceStt }, use, { provider: 'local', model: modelId, locale: null }),
      )
    }
  }

  /**
   * Removes the files; once they are gone, the uses that ran this model move to the first other
   * downloaded model of the same kind, or back to their defaults.
   */
  const removeModel = async (id: string) => {
    await remove(id)
    const before = useProjectsStore.getState().preferences
    if (usesOf(before, id).length === 0) return
    const states = await speechModelStates().catch(() => null)
    if (!states || states.some((state) => state.id === id && state.status === 'ready')) return
    const removed = models.find((model) => model.id === id)
    const ready = new Set(states.filter((s) => s.status === 'ready').map((s) => s.id))
    const fallback = removed
      ? models.find(
          (model) =>
            model.id !== id &&
            model.kind === 'download' &&
            modelUse(model) === modelUse(removed) &&
            ready.has(model.id),
        )
      : undefined
    const current = useProjectsStore.getState()
    current.setPreferences(clearLocalModelUses(current.preferences, id, fallback?.id ?? null))
  }

  const button = (
    label: MessageKey,
    onClick: () => void,
    options: { disabled?: boolean; title?: string; danger?: boolean } = {},
  ) => (
    <button
      type="button"
      className={`${controls.btn} ${controls.btnSm} ${options.danger ? controls.btnSmDanger : ''}`}
      disabled={options.disabled}
      title={options.title}
      onClick={onClick}
    >
      {t(label)}
    </button>
  )

  /** Hugging Face folders on disk; one that is not ready can still be deleted. */
  const onDisk = new Set(
    models.filter((model) => model.source === 'huggingface').map((model) => model.id),
  )

  const actionFor = (id: string, status: RowStatus, inUse: boolean): ReactNode => {
    if (status.kind === 'error' && status.action === 'remove') {
      return button('prefs.voiceActionRemove', () => void removeModel(id), { danger: true })
    }
    if (status.kind === 'error' && status.action === 'cancel') {
      return button('prefs.voiceActionCancel', () => void cancel(id))
    }
    switch (status.kind) {
      case 'not-downloaded':
      case 'error': {
        const busy = activeId !== null && activeId !== id
        const primary = button(
          status.kind === 'error' ? 'prefs.voiceActionTryAgain' : 'prefs.voiceActionDownload',
          () => void download(id),
          { disabled: busy, title: busy ? t('prefs.voiceDownloadBusy') : undefined },
        )
        if (!onDisk.has(id)) return primary
        // Cancel deletes a folder that is not ready, e.g. a repo that no longer exists.
        return (
          <span className={styles.actions}>
            {primary}
            {button('prefs.voiceActionRemove', () => void cancel(id), { danger: true })}
          </span>
        )
      }
      case 'downloading':
      case 'verifying':
      case 'unpacking':
        return button('prefs.voiceActionPause', () => void pause(id), {
          disabled: status.kind !== 'downloading',
        })
      case 'paused': {
        const busy = activeId !== null && activeId !== id
        return (
          <span className={styles.actions}>
            {button('prefs.voiceActionResume', () => void download(id), {
              disabled: busy,
              title: busy ? t('prefs.voiceDownloadBusy') : undefined,
            })}
            {button('prefs.voiceActionCancel', () => void cancel(id))}
          </span>
        )
      }
      case 'ready':
        return button('prefs.voiceActionRemove', () => void removeModel(id), {
          danger: true,
          title: inUse ? t('prefs.voiceRemoveInUseHint') : undefined,
        })
    }
  }

  const rowFor = (model: SpeechModelManifest): TableRow => {
    const info = modelInfoFor(model.id)
    const status = statusOf(model.id)
    const ready = status.kind === 'ready'
    const uses = usesOf({ voiceStt, voiceTts }, model.id)
    const summary = info ? t(info.summary) : model.description
    const accuracyLabel = t(ACCURACY_LABEL[modelUse(model)])
    return {
      id: model.id,
      name: model.label,
      recommended: isRecommended(info, locale),
      badge: model.source === 'huggingface' ? t('prefs.voiceHubBadge') : undefined,
      cells: {
        languages: languagesLabel(info, t, locale),
        speed: (
          <TierDots
            tier={info?.speed}
            label={t('prefs.voiceColSpeed')}
            estimated={info?.estimated}
          />
        ),
        accuracy: (
          <TierDots tier={info?.accuracy} label={accuracyLabel} estimated={info?.estimated} />
        ),
        voices: info?.voiceCount ? String(info.voiceCount) : '—',
        size:
          model.hub && model.hub.totalBytes === null
            ? search.resolving.has(model.id)
              ? '…'
              : '—'
            : formatByteSize(model.sizeBytes, locale),
        likes: model.hub ? String(model.hub.likes) : '—',
        status: (
          <>
            <span title={status.kind === 'error' ? status.message : undefined}>
              {statusText(status, uses, t, locale)}
            </span>
            {!ready && uses.length > 0 ? (
              <small className={styles.note}>
                {t('prefs.voiceModelSelectedFor', { uses: joinUses(uses, t) })}
              </small>
            ) : null}
          </>
        ),
      },
      action: actionFor(model.id, status, uses.length > 0),
      details: (
        <div className={styles.details}>
          {summary ? <p className={styles.summary}>{summary}</p> : null}
          {info ? <p className={styles.text}>{t(info.details)}</p> : null}
          <p className={styles.text}>
            <span className={styles.label}>{t('prefs.voiceColLanguages')}</span>
            {languagesList(info, t, locale)}
          </p>
          {status.kind === 'downloading' && status.progress ? (
            <ModelDownloadProgress
              progress={status.progress}
              bytesPerSecond={status.bytesPerSecond}
            />
          ) : null}
          <p className={styles.text}>
            <span className={styles.label}>{t('prefs.voiceUsedIn')}</span>
            {uses.length > 0 ? joinUses(uses, t) : t('prefs.voiceNotInUseShort')}
          </p>
          <div className={styles.uses}>
            {USES_BY_KIND[modelUse(model)].map((use) => {
              const active = uses.includes(use)
              return (
                <button
                  key={use}
                  type="button"
                  className={`${controls.btn} ${controls.btnSm}`}
                  aria-pressed={active}
                  disabled={!ready || active}
                  onClick={() => assign(use, model.id)}
                >
                  {t('prefs.voiceUseFor', { use: t(USE_LABEL[use]) })}
                </button>
              )
            })}
          </div>
          {ready && uses.length > 0 ? (
            <p className={styles.hint}>{t('prefs.voiceRemoveInUseHint')}</p>
          ) : null}
          {model.hub ? (
            <HubDetails hub={model.hub} resolving={search.resolving.has(model.id)} />
          ) : info?.sourceUrl ? (
            <button
              type="button"
              className={styles.link}
              onClick={() => void openInBrowser(info.sourceUrl ?? '')}
            >
              {t('prefs.voiceSource')}
              <ExternalLink size={12} aria-hidden="true" />
            </button>
          ) : null}
          {ready && model.hub && voiceTts.provider === 'local' && voiceTts.model === model.id ? (
            <LocalVoiceSelect modelId={model.id} />
          ) : null}
        </div>
      ),
    }
  }

  // Only a first load that failed hides the table; a later failed refresh keeps the last list.
  const unavailable = loadFailed && models.length === 0
  const downloadable = models.filter((model) => model.kind === 'download')
  const source = mode === 'search' ? search.results : downloadable
  const sections: TableSection[] = SECTIONS.filter(
    (section) => filter === 'all' || filter === section.id,
  )
    .map((section) => ({
      id: section.id,
      title: t(section.title),
      hint: t(section.hint),
      columnLabels: { accuracy: t(ACCURACY_LABEL[section.id]) },
      rows: source.filter((model) => modelUse(model) === section.id).map(rowFor),
    }))
    .filter((section) => section.rows.length > 0)

  return (
    <div className={styles.root}>
      <p className={styles.intro}>{t('prefs.voiceLocalIntro')}</p>
      {unavailable ? (
        <div role="alert" className={styles.failure}>
          <p className={styles.intro}>{t('prefs.voiceLoadFailed')}</p>
          <button type="button" className={`${controls.btn} ${controls.btnSm}`} onClick={retry}>
            {t('prefs.voiceRetry')}
          </button>
        </div>
      ) : null}
      <div className={styles.modes} role="group" aria-label={t('prefs.voiceLocalModeSearch')}>
        {(['installed', 'search'] as const).map((value) => (
          <button
            key={value}
            type="button"
            className={`${controls.btn} ${controls.btnSm}`}
            aria-pressed={mode === value}
            onClick={() => setMode(value)}
          >
            {t(
              value === 'installed'
                ? 'prefs.voiceLocalModeInstalled'
                : 'prefs.voiceLocalModeSearch',
            )}
          </button>
        ))}
      </div>
      {mode === 'search' ? (
        <>
          <p className={styles.intro}>{t('prefs.voiceHubIntro')}</p>
          <HubSearchControls
            language={language}
            sort={sort}
            onLanguage={setLanguage}
            onSort={setSort}
          />
          {search.status === 'error' && search.error ? (
            <div role="alert" className={styles.failure}>
              <p className={styles.intro}>{t(search.error)}</p>
              <button
                type="button"
                className={`${controls.btn} ${controls.btnSm}`}
                onClick={search.retry}
              >
                {t('prefs.voiceRetry')}
              </button>
            </div>
          ) : null}
        </>
      ) : null}
      <ModelTable
        sections={sections}
        columns={mode === 'search' ? SEARCH_COLUMNS : COLUMNS}
        onExpand={mode === 'search' ? search.resolve : undefined}
        search={
          mode === 'search'
            ? {
                value: query,
                onChange: setQuery,
                placeholder: t('prefs.voiceHubSearchPlaceholder'),
              }
            : undefined
        }
        empty={
          mode === 'search'
            ? search.status === 'loading' && search.results.length === 0
              ? t('prefs.voiceHubLoading')
              : search.status === 'ready' && search.results.length === 0
                ? t('prefs.voiceHubEmpty')
                : undefined
            : models.length === 0 && !unavailable
              ? t('prefs.voiceModelsLoading')
              : undefined
        }
        filter={{
          label: t('prefs.voiceFilterUsesLabel'),
          value: filter,
          options: [
            { value: 'all', label: t('prefs.voiceFilterAllUses') },
            { value: 'stt', label: t('prefs.voiceModelKindStt') },
            { value: 'tts', label: t('prefs.voiceModelKindTts') },
          ],
          onChange: (value) => setFilter(value as Filter),
        }}
      />
      {mode === 'search' && search.hasMore ? (
        <button
          type="button"
          className={controls.btn}
          disabled={search.status === 'loading'}
          onClick={search.loadMore}
        >
          {t('prefs.voiceHubLoadMore')}
        </button>
      ) : null}
    </div>
  )
}
