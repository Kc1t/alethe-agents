import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { formatByteSize, formatDuration, formatRate } from '../../../../lib/speech/downloadStats'
import type { HubModelInfo, SpeechModelManifest } from '../../../../lib/tauri'
import { EMPTY_PROJECTS_FILE } from '../../../../lib/types'
import { rememberHubModels } from '../../../../lib/voice/modelInfo'
import { DEFAULT_STT_CHOICE } from '../../../../lib/voice/providers'
import { useProjectsStore } from '../../../../stores/projectsStore'
import { LocalModelsView } from './LocalModelsView'
import { usesOf } from './modelUses'
import { useHubSearch } from './useHubSearch'
import { type RowStatus, useModelDownloads } from './useModelDownloads'

vi.mock('./useModelDownloads')
vi.mock('./useHubSearch')
const tauri = vi.hoisted(() => ({
  openInBrowser: vi.fn().mockResolvedValue(undefined),
  speechModelStates: vi.fn().mockResolvedValue([]),
  ttsVoices: vi.fn().mockResolvedValue([]),
}))
vi.mock('../../../../lib/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../lib/tauri')>()),
  ...tauri,
  saveProjectsFile: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../../../lib/i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../lib/i18n')>()),
  useT: () => (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
  getLocale: () => 'en',
  intlLocale: () => 'en',
}))

const PARAKEET = 'parakeet-tdt-0.6b-v3-int8'
const WHISPER = 'whisper-base-int8'
const PIPER = 'piper-pt-br-faber-medium'
const AMY = 'piper-en-us-amy-low'

const manifest = (
  id: string,
  capability: 'stt' | 'tts' | undefined,
  extra: Partial<SpeechModelManifest> = {},
): SpeechModelManifest => ({
  id,
  label: id,
  description: '',
  language: 'multilingual',
  sampleRate: 16000,
  sizeBytes: 100_000_000,
  recommended: false,
  kind: 'download',
  capability,
  ...extra,
})

type Downloads = ReturnType<typeof useModelDownloads>

const actions = {
  refresh: vi.fn<Downloads['refresh']>(),
  retry: vi.fn<Downloads['retry']>(),
  download: vi.fn<Downloads['download']>(),
  pause: vi.fn<Downloads['pause']>(),
  cancel: vi.fn<Downloads['cancel']>(),
  remove: vi.fn<Downloads['remove']>(),
}

function mockHook(
  models: SpeechModelManifest[],
  statuses: Record<string, RowStatus>,
  activeId: string | null = null,
) {
  vi.mocked(useModelDownloads).mockReturnValue({
    models,
    activeId,
    loadFailed: false,
    statusOf: (id: string) => statuses[id] ?? { kind: 'not-downloaded' },
    ...actions,
  } satisfies Downloads)
}

/** The `<tr>` holding a model's toggle button. */
function rowOf(name: string): HTMLElement {
  const toggle = screen.getByRole('button', { name: new RegExp(name.replace(/[.]/g, '\\.')) })
  return toggle.closest('tr') as HTMLElement
}

const hubInfo = (repo: string, extra: Partial<HubModelInfo> = {}): HubModelInfo => ({
  repo,
  commit: 'c'.repeat(40),
  family: 'vits',
  languages: ['pt-BR'],
  languageCount: null,
  multilingual: false,
  speed: 3,
  accuracy: 2,
  voiceCount: 1,
  license: 'mit',
  lastModified: '2023-11-29T12:36:17.000Z',
  likes: 6,
  fileCount: 360,
  totalBytes: 80_000_000,
  ...extra,
})

function mockSearch(
  results: SpeechModelManifest[],
  extra: Partial<ReturnType<typeof useHubSearch>> = {},
) {
  // The real hook fills the model-info registry; the mock has to do the same.
  rememberHubModels(results)
  vi.mocked(useHubSearch).mockReturnValue({
    results,
    status: 'ready',
    error: null,
    hasMore: false,
    resolving: new Set(),
    loadMore: vi.fn(),
    retry: vi.fn(),
    resolve: vi.fn(),
    ...extra,
  })
}

const EDRESSON = 'hf:csukuangfj/vits-piper-pt_BR-edresson-low'
const edressonManifest = manifest(EDRESSON, 'tts', {
  label: 'Piper · Edresson (pt-BR, low)',
  source: 'huggingface',
  hub: hubInfo('csukuangfj/vits-piper-pt_BR-edresson-low'),
  sizeBytes: 80_000_000,
})

const prefs = () => useProjectsStore.getState().preferences

afterEach(cleanup)

beforeEach(() => {
  useProjectsStore.setState({ ...structuredClone(EMPTY_PROJECTS_FILE), hydrated: true })
  for (const fn of Object.values(actions)) fn.mockReset().mockResolvedValue(undefined)
  tauri.openInBrowser.mockClear()
  tauri.speechModelStates.mockReset().mockResolvedValue([])
  tauri.ttsVoices.mockReset().mockResolvedValue([])
})

describe('usesOf', () => {
  it('lists the uses that run the local model', () => {
    const base = structuredClone(EMPTY_PROJECTS_FILE.preferences)
    expect(usesOf(base, PARAKEET)).toEqual(['dictation', 'conversation'])
    expect(usesOf(base, PIPER)).toEqual([])
    const narrating = {
      voiceStt: {
        ...base.voiceStt,
        conversation: { provider: 'openai' as const, model: PARAKEET, locale: null },
      },
      voiceTts: { provider: 'local' as const, model: PIPER, voice: null, rate: 1 },
    }
    expect(usesOf(narrating, PARAKEET)).toEqual(['dictation'])
    expect(usesOf(narrating, PIPER)).toEqual(['narration'])
  })
})

describe('LocalModelsView', () => {
  it('shows tiers, languages and in-use status for a known model', () => {
    useProjectsStore.getState().setPreferences({
      voiceStt: {
        dictation: { provider: 'local', model: PARAKEET, locale: null },
        conversation: { provider: 'apple', model: 'apple-speech', locale: null },
      },
    })
    mockHook([manifest(PARAKEET, 'stt')], { [PARAKEET]: { kind: 'ready' } })
    render(<LocalModelsView />)
    const row = rowOf(PARAKEET)
    expect(row.textContent).toContain(
      'prefs.voiceModelStatusInUse:{"uses":"prefs.voiceTabDictation"}',
    )
    expect(
      within(row).getByLabelText('prefs.voiceTierLabel:{"label":"prefs.voiceColSpeed","tier":2}'),
    ).toBeTruthy()
    expect(
      within(row).getByLabelText(
        'prefs.voiceTierLabel:{"label":"prefs.voiceColAccuracy","tier":3}',
      ),
    ).toBeTruthy()
    expect(row.textContent).toContain(
      'prefs.voiceModelLanguagesManyWith:{"count":25,"language":"English"}',
    )
    expect(row.textContent).toContain(formatByteSize(100_000_000, 'en'))
    expect(within(row).getByText('prefs.voiceRecommended')).toBeTruthy()
    expect(within(row).getByRole('button', { name: 'prefs.voiceActionRemove' })).toBeTruthy()
  })

  it('renders an unknown catalog id with dashes and its capability section', () => {
    mockHook(
      [
        manifest(PARAKEET, 'stt'),
        manifest('someone/x', 'tts', { label: 'X', description: 'A community voice' }),
      ],
      {},
    )
    render(<LocalModelsView />)
    const tts = screen.getByRole('rowgroup', { name: 'prefs.voiceSectionTtsTitle' })
    const toggle = within(tts).getByRole('button', { name: /^X/ })
    const row = toggle.closest('tr') as HTMLElement
    // Languages, speed and accuracy are unknown for a model outside the curated catalog.
    expect(within(row).getAllByText('—')).toHaveLength(3)
    expect(row.textContent).toContain('prefs.voiceModelStatusNotDownloaded')
    const stt = screen.getByRole('rowgroup', { name: 'prefs.voiceSectionSttTitle' })
    expect(within(stt).queryByRole('button', { name: /^X/ })).toBeNull()
    fireEvent.click(toggle)
    expect(screen.getByText('A community voice')).toBeTruthy()
    expect(
      screen.getByRole('button', { name: 'prefs.voiceUseFor:{"use":"prefs.voiceTabNarration"}' }),
    ).toBeTruthy()
  })

  it('shows Pause while downloading and disables it while verifying or unpacking', () => {
    const progress = {
      modelId: WHISPER,
      phase: 'downloading',
      downloaded: 40_000_000,
      total: 100_000_000,
      fraction: 0.4,
      file: 'model.onnx',
      fileIndex: 1,
      fileCount: 2,
    }
    mockHook(
      [manifest(WHISPER, 'stt')],
      { [WHISPER]: { kind: 'downloading', progress, bytesPerSecond: null } },
      WHISPER,
    )
    const { rerender } = render(<LocalModelsView />)
    const pause = within(rowOf(WHISPER)).getByRole('button', { name: 'prefs.voiceActionPause' })
    expect((pause as HTMLButtonElement).disabled).toBe(false)
    expect(rowOf(WHISPER).textContent).toContain('prefs.voiceModelStatusDownloading:{"percent":40}')
    fireEvent.click(pause)
    expect(actions.pause).toHaveBeenCalledWith(WHISPER)

    for (const kind of ['verifying', 'unpacking'] as const) {
      mockHook([manifest(WHISPER, 'stt')], { [WHISPER]: { kind } }, WHISPER)
      rerender(<LocalModelsView />)
      const row = rowOf(WHISPER)
      const button = within(row).getByRole('button', { name: 'prefs.voiceActionPause' })
      expect((button as HTMLButtonElement).disabled).toBe(true)
      expect(row.textContent).toContain(
        kind === 'verifying'
          ? 'prefs.voiceModelStatusVerifying'
          : 'prefs.voiceModelStatusUnpacking',
      )
    }
  })

  it('shows Resume and Cancel for a paused model with its byte counts', () => {
    mockHook([manifest(WHISPER, 'stt')], {
      [WHISPER]: { kind: 'paused', downloaded: 40_000_000, total: 100_000_000 },
    })
    render(<LocalModelsView />)
    const row = rowOf(WHISPER)
    expect(row.textContent).toContain(
      `prefs.voiceModelStatusPaused:${JSON.stringify({
        done: formatByteSize(40_000_000, 'en'),
        total: formatByteSize(100_000_000, 'en'),
      })}`,
    )
    expect(within(row).queryByRole('button', { name: 'prefs.voiceActionDownload' })).toBeNull()
    fireEvent.click(within(row).getByRole('button', { name: 'prefs.voiceActionResume' }))
    expect(actions.download).toHaveBeenCalledWith(WHISPER)
    fireEvent.click(within(row).getByRole('button', { name: 'prefs.voiceActionCancel' }))
    expect(actions.cancel).toHaveBeenCalledWith(WHISPER)
  })

  it('disables Download on other rows while one model downloads', () => {
    mockHook(
      [manifest(WHISPER, 'stt'), manifest(PARAKEET, 'stt')],
      { [WHISPER]: { kind: 'downloading', progress: null, bytesPerSecond: null } },
      WHISPER,
    )
    const { rerender } = render(<LocalModelsView />)
    const busy = within(rowOf(PARAKEET)).getByRole('button', {
      name: 'prefs.voiceActionDownload',
    }) as HTMLButtonElement
    expect(busy.disabled).toBe(true)
    expect(busy.title).toBe('prefs.voiceDownloadBusy')

    mockHook([manifest(WHISPER, 'stt'), manifest(PARAKEET, 'stt')], {})
    rerender(<LocalModelsView />)
    const free = within(rowOf(PARAKEET)).getByRole('button', {
      name: 'prefs.voiceActionDownload',
    }) as HTMLButtonElement
    expect(free.disabled).toBe(false)
    expect(free.title).toBe('')
    fireEvent.click(free)
    expect(actions.download).toHaveBeenCalledWith(PARAKEET)
  })

  it('Use for Dictation writes only the dictation choice', () => {
    const before = structuredClone(prefs())
    mockHook([manifest(WHISPER, 'stt')], { [WHISPER]: { kind: 'ready' } })
    render(<LocalModelsView />)
    fireEvent.click(screen.getByRole('button', { name: new RegExp(WHISPER) }))
    fireEvent.click(
      screen.getByRole('button', { name: 'prefs.voiceUseFor:{"use":"prefs.voiceTabDictation"}' }),
    )
    expect(prefs().voiceStt.dictation).toEqual({ provider: 'local', model: WHISPER, locale: null })
    expect(prefs().voiceStt.conversation).toEqual(before.voiceStt.conversation)
    expect(prefs().voiceTts).toEqual(before.voiceTts)
    expect(rowOf(WHISPER).textContent).toContain(
      'prefs.voiceModelStatusInUse:{"uses":"prefs.voiceTabDictation"}',
    )
  })

  it('Use for Narration writes the local voice, and use buttons wait for the download', () => {
    mockHook([manifest(PIPER, 'tts'), manifest(WHISPER, 'stt')], { [PIPER]: { kind: 'ready' } })
    render(<LocalModelsView />)
    fireEvent.click(screen.getByRole('button', { name: new RegExp(WHISPER) }))
    for (const use of ['prefs.voiceTabDictation', 'prefs.voiceTabConversation']) {
      const button = screen.getByRole('button', {
        name: `prefs.voiceUseFor:{"use":"${use}"}`,
      }) as HTMLButtonElement
      expect(button.disabled).toBe(true)
    }
    fireEvent.click(screen.getByRole('button', { name: new RegExp(WHISPER) }))
    fireEvent.click(screen.getByRole('button', { name: new RegExp(PIPER) }))
    fireEvent.click(
      screen.getByRole('button', { name: 'prefs.voiceUseFor:{"use":"prefs.voiceTabNarration"}' }),
    )
    expect(prefs().voiceTts).toMatchObject({ provider: 'local', model: PIPER, voice: null })
    fireEvent.click(screen.getByRole('button', { name: 'prefs.voiceSource' }))
    expect(tauri.openInBrowser).toHaveBeenCalledWith(
      'https://github.com/k2-fsa/sherpa-onnx/releases/tag/tts-models',
    )
  })

  it('translates download errors and offers to try again', () => {
    const cases: [string, string][] = [
      ['speech_download_busy', 'prefs.voiceDownloadBusy'],
      ['write failed: No space left on device (os error 28)', 'prefs.voiceDiskFull'],
      ['There is not enough space on the disk. (os error 112)', 'prefs.voiceDiskFull'],
      ['checksum mismatch', 'prefs.voiceDownloadFailed'],
      ['unexpected os error 280', 'prefs.voiceDownloadFailed'],
    ]
    for (const [message, key] of cases) {
      mockHook([manifest(WHISPER, 'stt')], {
        [WHISPER]: { kind: 'error', message, action: 'download' },
      })
      render(<LocalModelsView />)
      const row = rowOf(WHISPER)
      expect(row.textContent).toContain(`prefs.voiceModelStatusError:{"message":"${key}"}`)
      expect(row.textContent).not.toContain(message)
      fireEvent.click(within(row).getByRole('button', { name: 'prefs.voiceActionTryAgain' }))
      cleanup()
    }
    expect(actions.download).toHaveBeenCalledTimes(cases.length)
  })

  it('filters sections by use', () => {
    mockHook(
      [
        manifest(WHISPER, 'stt'),
        manifest(PIPER, 'tts'),
        manifest('apple-speech', 'stt', { kind: 'native' }),
      ],
      {},
    )
    const { unmount } = render(<LocalModelsView />)
    expect(screen.getByRole('rowgroup', { name: 'prefs.voiceSectionSttTitle' })).toBeTruthy()
    expect(screen.getByRole('rowgroup', { name: 'prefs.voiceSectionTtsTitle' })).toBeTruthy()
    // Built-in engines (kind "native") are not downloadable models.
    expect(screen.queryByRole('button', { name: /apple-speech/ })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'prefs.voiceModelKindTts' }))
    expect(screen.queryByRole('rowgroup', { name: 'prefs.voiceSectionSttTitle' })).toBeNull()
    expect(screen.getByRole('button', { name: new RegExp(PIPER) })).toBeTruthy()
    expect(screen.queryByRole('button', { name: new RegExp(WHISPER) })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'prefs.voiceFilterAllUses' }))
    expect(screen.getByRole('button', { name: new RegExp(WHISPER) })).toBeTruthy()
    unmount()

    render(<LocalModelsView initialFilter="stt" />)
    expect(screen.queryByRole('rowgroup', { name: 'prefs.voiceSectionTtsTitle' })).toBeNull()
    expect(screen.getByRole('button', { name: new RegExp(WHISPER) })).toBeTruthy()
  })

  it('lists where an expanded model is used and marks those uses as pressed', () => {
    useProjectsStore.getState().setPreferences({
      voiceStt: {
        dictation: { provider: 'local', model: WHISPER, locale: null },
        conversation: { provider: 'apple', model: 'apple-speech', locale: null },
      },
    })
    mockHook([manifest(WHISPER, 'stt')], { [WHISPER]: { kind: 'ready' } })
    render(<LocalModelsView />)
    fireEvent.click(screen.getByRole('button', { name: new RegExp(WHISPER) }))
    const usedIn = screen.getByText('prefs.voiceUsedIn').parentElement as HTMLElement
    expect(usedIn.textContent).toContain('prefs.voiceTabDictation')
    expect(usedIn.textContent).not.toContain('prefs.voiceTabConversation')
    const dictation = screen.getByRole('button', {
      name: 'prefs.voiceUseFor:{"use":"prefs.voiceTabDictation"}',
    }) as HTMLButtonElement
    expect(dictation.getAttribute('aria-pressed')).toBe('true')
    expect(dictation.disabled).toBe(true)
    const conversation = screen.getByRole('button', {
      name: 'prefs.voiceUseFor:{"use":"prefs.voiceTabConversation"}',
    }) as HTMLButtonElement
    expect(conversation.getAttribute('aria-pressed')).toBe('false')
    expect(conversation.disabled).toBe(false)
  })

  it('notes a selected model that is not downloaded, and says when a model is unused', () => {
    // The default preferences select Parakeet for Dictation and Conversation.
    mockHook([manifest(PARAKEET, 'stt'), manifest(WHISPER, 'stt')], {})
    render(<LocalModelsView />)
    const row = rowOf(PARAKEET)
    expect(row.textContent).toContain('prefs.voiceModelStatusNotDownloaded')
    expect(row.textContent).toContain(
      'prefs.voiceModelSelectedFor:{"uses":"prefs.voiceTabDictation, prefs.voiceTabConversation"}',
    )
    expect(rowOf(WHISPER).textContent).not.toContain('prefs.voiceModelSelectedFor')
    fireEvent.click(screen.getByRole('button', { name: new RegExp(PARAKEET) }))
    const usedIn = screen.getByText('prefs.voiceUsedIn').parentElement as HTMLElement
    expect(usedIn.textContent).toContain('prefs.voiceTabDictation, prefs.voiceTabConversation')
    fireEvent.click(screen.getByRole('button', { name: new RegExp(PARAKEET) }))
    fireEvent.click(screen.getByRole('button', { name: new RegExp(WHISPER) }))
    const unused = screen.getByText('prefs.voiceUsedIn').parentElement as HTMLElement
    expect(unused.textContent).toContain('prefs.voiceNotInUseShort')
  })

  it('lists every language of an expanded model', () => {
    mockHook([manifest(PARAKEET, 'stt')], {})
    render(<LocalModelsView />)
    fireEvent.click(screen.getByRole('button', { name: new RegExp(PARAKEET) }))
    const languages = screen.getAllByText('prefs.voiceColLanguages')
    const line = languages[languages.length - 1].parentElement as HTMLElement
    expect(line.textContent).toContain('Bulgarian')
    expect(line.textContent).toContain('Ukrainian')
    expect(line.textContent?.split(', ')).toHaveLength(25)
  })

  it('recommends the voice in the app language and calls voice accuracy Quality', () => {
    mockHook([manifest(PIPER, 'tts'), manifest(AMY, 'tts')], {})
    const { unmount } = render(<LocalModelsView initialFilter="tts" />)
    expect(within(rowOf(AMY)).getByText('prefs.voiceRecommended')).toBeTruthy()
    expect(within(rowOf(PIPER)).queryByText('prefs.voiceRecommended')).toBeNull()
    expect(screen.getByRole('columnheader', { name: 'prefs.voiceColQuality' })).toBeTruthy()
    expect(
      within(rowOf(AMY)).getByLabelText(
        'prefs.voiceTierLabel:{"label":"prefs.voiceColQuality","tier":1}',
      ),
    ).toBeTruthy()
    unmount()
    mockHook([manifest(WHISPER, 'stt'), manifest(AMY, 'tts')], {})
    render(<LocalModelsView />)
    expect(screen.getByRole('columnheader', { name: 'prefs.voiceColAccuracy' })).toBeTruthy()
  })

  it('says which removal or cancel failed and offers that action again', () => {
    mockHook([manifest(WHISPER, 'stt'), manifest(PARAKEET, 'stt')], {
      [WHISPER]: { kind: 'error', message: 'access denied (os error 5)', action: 'remove' },
      [PARAKEET]: { kind: 'error', message: 'lock poisoned', action: 'cancel' },
    })
    render(<LocalModelsView />)
    const whisper = rowOf(WHISPER)
    expect(whisper.textContent).toContain('prefs.voiceRemoveFailed')
    expect(whisper.textContent).not.toContain('access denied')
    expect(within(whisper).getByTitle('access denied (os error 5)')).toBeTruthy()
    expect(within(whisper).queryByRole('button', { name: 'prefs.voiceActionTryAgain' })).toBeNull()
    fireEvent.click(within(whisper).getByRole('button', { name: 'prefs.voiceActionRemove' }))
    expect(actions.remove).toHaveBeenCalledWith(WHISPER)
    expect(actions.download).not.toHaveBeenCalled()

    const parakeet = rowOf(PARAKEET)
    expect(parakeet.textContent).toContain('prefs.voiceCancelFailed')
    expect(within(parakeet).getByTitle('lock poisoned')).toBeTruthy()
    fireEvent.click(within(parakeet).getByRole('button', { name: 'prefs.voiceActionCancel' }))
    expect(actions.cancel).toHaveBeenCalledWith(PARAKEET)
    expect(actions.download).not.toHaveBeenCalled()
  })

  it('removing the model in use falls back to another downloaded model', async () => {
    // The default preferences run Parakeet for Dictation and Conversation.
    mockHook([manifest(PARAKEET, 'stt'), manifest(WHISPER, 'stt')], {
      [PARAKEET]: { kind: 'ready' },
      [WHISPER]: { kind: 'ready' },
    })
    tauri.speechModelStates.mockResolvedValueOnce([
      { id: PARAKEET, status: 'not-downloaded' },
      { id: WHISPER, status: 'ready' },
    ])
    render(<LocalModelsView />)
    fireEvent.click(
      within(rowOf(PARAKEET)).getByRole('button', { name: 'prefs.voiceActionRemove' }),
    )
    await waitFor(() =>
      expect(prefs().voiceStt.dictation).toEqual({
        provider: 'local',
        model: WHISPER,
        locale: null,
      }),
    )
    expect(prefs().voiceStt.conversation).toEqual({
      provider: 'local',
      model: WHISPER,
      locale: null,
    })
  })

  it('shows the time left next to the download speed when known', () => {
    const progress = {
      modelId: WHISPER,
      phase: 'downloading',
      downloaded: 40_000_000,
      total: 100_000_000,
      fraction: 0.4,
      file: 'model.onnx',
      fileIndex: 1,
      fileCount: 2,
    }
    mockHook(
      [manifest(WHISPER, 'stt')],
      { [WHISPER]: { kind: 'downloading', progress, bytesPerSecond: 2_000_000 } },
      WHISPER,
    )
    render(<LocalModelsView />)
    expect(rowOf(WHISPER).textContent).toContain(
      `prefs.voiceModelStatusDownloadingEta:${JSON.stringify({
        percent: 40,
        speed: formatRate(2_000_000, 'en'),
        eta: formatDuration(30, 'en'),
      })}`,
    )
  })

  it('shows the download speed through its own message', () => {
    const progress = {
      modelId: WHISPER,
      phase: 'downloading',
      downloaded: 40_000_000,
      total: 100_000_000,
      fraction: 0.4,
      file: 'model.onnx',
      fileIndex: 1,
      fileCount: 2,
    }
    // No total yet, so no time left: speed only.
    mockHook(
      [manifest(WHISPER, 'stt')],
      {
        [WHISPER]: {
          kind: 'downloading',
          progress: { ...progress, total: 0 },
          bytesPerSecond: 2_000_000,
        },
      },
      WHISPER,
    )
    render(<LocalModelsView />)
    expect(rowOf(WHISPER).textContent).toContain(
      `prefs.voiceModelStatusDownloadingRate:${JSON.stringify({
        percent: 40,
        speed: formatRate(2_000_000, 'en'),
      })}`,
    )
  })

  it('warns before removing an in-use model and falls back to the defaults afterwards', async () => {
    useProjectsStore.getState().setPreferences({
      voiceStt: {
        dictation: { provider: 'local', model: WHISPER, locale: null },
        conversation: { provider: 'apple', model: 'apple-speech', locale: null },
      },
      voiceTts: { provider: 'local', model: PIPER, voice: null, rate: 1.5 },
    })
    mockHook([manifest(WHISPER, 'stt'), manifest(PIPER, 'tts')], {
      [WHISPER]: { kind: 'ready' },
      [PIPER]: { kind: 'ready' },
    })
    render(<LocalModelsView />)
    const remove = within(rowOf(WHISPER)).getByRole('button', {
      name: 'prefs.voiceActionRemove',
    }) as HTMLButtonElement
    expect(remove.title).toBe('prefs.voiceRemoveInUseHint')
    fireEvent.click(screen.getByRole('button', { name: new RegExp(WHISPER) }))
    expect(screen.getByText('prefs.voiceRemoveInUseHint')).toBeTruthy()

    // A removal that did not happen keeps the choice.
    tauri.speechModelStates.mockResolvedValueOnce([{ id: WHISPER, status: 'ready' }])
    fireEvent.click(remove)
    await waitFor(() => expect(tauri.speechModelStates).toHaveBeenCalledTimes(1))
    await Promise.resolve()
    expect(prefs().voiceStt.dictation.model).toBe(WHISPER)

    tauri.speechModelStates.mockResolvedValueOnce([{ id: WHISPER, status: 'not-downloaded' }])
    fireEvent.click(remove)
    await waitFor(() => expect(prefs().voiceStt.dictation).toEqual(DEFAULT_STT_CHOICE))
    expect(actions.remove).toHaveBeenCalledWith(WHISPER)
    expect(prefs().voiceStt.conversation.provider).toBe('apple')
    expect(prefs().voiceTts.model).toBe(PIPER)

    tauri.speechModelStates.mockResolvedValueOnce([])
    fireEvent.click(within(rowOf(PIPER)).getByRole('button', { name: 'prefs.voiceActionRemove' }))
    await waitFor(() =>
      expect(prefs().voiceTts).toEqual({
        provider: 'system',
        model: '',
        voice: null,
        rate: 1.5,
        server: null,
      }),
    )
  })

  it('shows a loading row until the catalog arrives', () => {
    mockHook([], {})
    render(<LocalModelsView />)
    expect(screen.getByRole('cell', { name: 'prefs.voiceModelsLoading' })).toBeTruthy()
  })

  it('offers to try again instead of loading forever when the list fails', () => {
    mockHook([], {})
    vi.mocked(useModelDownloads).mockReturnValue({
      ...vi.mocked(useModelDownloads)(),
      loadFailed: true,
    })
    render(<LocalModelsView />)
    expect(screen.queryByText('prefs.voiceModelsLoading')).toBeNull()
    expect(screen.getByRole('alert').textContent).toContain('prefs.voiceLoadFailed')
    fireEvent.click(screen.getByRole('button', { name: 'prefs.voiceRetry' }))
    expect(actions.retry).toHaveBeenCalledTimes(1)
  })
})

describe('Hugging Face search mode', () => {
  beforeEach(() => {
    mockHook([manifest(PIPER, 'tts')], {})
    mockSearch([edressonManifest])
  })

  it('switches to search and lists results with likes and the estimate marker', () => {
    render(<LocalModelsView />)
    fireEvent.click(screen.getByRole('button', { name: 'prefs.voiceLocalModeSearch' }))
    const row = rowOf('Piper · Edresson')
    expect(within(row).getByText('6')).toBeTruthy()
    // Edresson has no curated override, so both tiers carry the estimate marker.
    expect(within(row).getAllByTitle('prefs.voiceTierEstimated').length).toBe(2)
    expect(within(row).getByRole('button', { name: 'prefs.voiceActionDownload' })).toBeTruthy()
  })

  it('downloads a result through the shared download hook', () => {
    render(<LocalModelsView initialMode="search" />)
    fireEvent.click(
      within(rowOf('Piper · Edresson')).getByRole('button', { name: 'prefs.voiceActionDownload' }),
    )
    expect(actions.download).toHaveBeenCalledWith(EDRESSON)
  })

  it('shows the size as pending while the files are checked', () => {
    mockSearch(
      [
        {
          ...edressonManifest,
          sizeBytes: 0,
          hub: hubInfo('csukuangfj/vits-piper-pt_BR-edresson-low', {
            commit: null,
            totalBytes: null,
          }),
        },
      ],
      { resolving: new Set([EDRESSON]) },
    )
    render(<LocalModelsView initialMode="search" />)
    expect(within(rowOf('Piper · Edresson')).getByText('…')).toBeTruthy()
  })

  it('details show license, files and the Hugging Face link', () => {
    render(<LocalModelsView initialMode="search" />)
    fireEvent.click(screen.getByRole('button', { name: /Piper · Edresson/ }))
    expect(screen.getByText('mit')).toBeTruthy()
    expect(screen.getByText(/prefs.voiceHubFiles/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /prefs.voiceHubOpen/ }))
    expect(tauri.openInBrowser).toHaveBeenCalledWith(
      'https://huggingface.co/csukuangfj/vits-piper-pt_BR-edresson-low',
    )
  })

  it('installed_mode_works_while_search_fails', () => {
    mockSearch([], { status: 'error', error: 'prefs.voiceHubOffline' })
    render(<LocalModelsView initialMode="search" />)
    expect(screen.getByRole('alert').textContent).toContain('prefs.voiceHubOffline')
    fireEvent.click(screen.getByRole('button', { name: 'prefs.voiceLocalModeInstalled' }))
    expect(rowOf(PIPER)).toBeTruthy()
  })

  it('expanding a result checks its files right away', () => {
    const resolve = vi.fn()
    mockSearch([edressonManifest], { resolve })
    render(<LocalModelsView initialMode="search" />)
    fireEvent.click(screen.getByRole('button', { name: /Piper · Edresson/ }))
    expect(resolve).toHaveBeenCalledWith(EDRESSON)
    // Collapsing does not ask again.
    fireEvent.click(screen.getByRole('button', { name: /Piper · Edresson/ }))
    expect(resolve).toHaveBeenCalledTimes(1)
  })

  it('a Hugging Face row that is not downloaded or failed offers Remove, which cancels', () => {
    mockHook([manifest(PIPER, 'tts'), edressonManifest], {
      [EDRESSON]: { kind: 'error', message: 'hub_unknown_repo' },
    })
    render(<LocalModelsView />)
    const remove = within(rowOf('Piper · Edresson')).getByRole('button', {
      name: 'prefs.voiceActionRemove',
    })
    fireEvent.click(remove)
    expect(actions.cancel).toHaveBeenCalledWith(EDRESSON)
    expect(actions.remove).not.toHaveBeenCalled()
    expect(
      within(rowOf('Piper · Edresson')).getByRole('button', { name: 'prefs.voiceActionTryAgain' }),
    ).toBeTruthy()
  })

  it('a not-downloaded Hugging Face row offers Remove; a catalog row does not', () => {
    mockHook([manifest(PIPER, 'tts'), edressonManifest], {})
    render(<LocalModelsView />)
    fireEvent.click(
      within(rowOf('Piper · Edresson')).getByRole('button', { name: 'prefs.voiceActionRemove' }),
    )
    expect(actions.cancel).toHaveBeenCalledWith(EDRESSON)
    expect(
      within(rowOf(PIPER)).queryByRole('button', { name: 'prefs.voiceActionRemove' }),
    ).toBeNull()
    // A search result with nothing on disk has nothing to remove.
    cleanup()
    mockHook([manifest(PIPER, 'tts')], {})
    render(<LocalModelsView initialMode="search" />)
    expect(
      within(rowOf('Piper · Edresson')).queryByRole('button', { name: 'prefs.voiceActionRemove' }),
    ).toBeNull()
  })

  it('the voice picker shows only for the model that narrates', async () => {
    tauri.ttsVoices.mockResolvedValue([
      { id: '0', name: 'A', language: 'pt-BR' },
      { id: '1', name: 'B', language: 'pt-BR' },
    ])
    mockHook([manifest(PIPER, 'tts'), edressonManifest], { [EDRESSON]: { kind: 'ready' } })
    render(<LocalModelsView />)
    fireEvent.click(screen.getByRole('button', { name: /Piper · Edresson/ }))
    expect(screen.queryByText('prefs.voiceConvVoice')).toBeNull()
    expect(tauri.ttsVoices).not.toHaveBeenCalled()
    cleanup()
    useProjectsStore.getState().setPreferences({
      voiceTts: { provider: 'local', model: EDRESSON, voice: null, rate: 1 },
    })
    render(<LocalModelsView />)
    fireEvent.click(screen.getByRole('button', { name: /Piper · Edresson/ }))
    expect(await screen.findByText('prefs.voiceConvVoice')).toBeTruthy()
    expect(tauri.ttsVoices).toHaveBeenCalledWith('local', EDRESSON)
  })

  it('a downloaded Hugging Face model shows in Installed with a badge', () => {
    mockHook([manifest(PIPER, 'tts'), edressonManifest], { [EDRESSON]: { kind: 'ready' } })
    render(<LocalModelsView />)
    expect(within(rowOf('Piper · Edresson')).getByText('prefs.voiceHubBadge')).toBeTruthy()
  })
})
