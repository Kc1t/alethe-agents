import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { formatByteSize, formatDuration, formatRate } from '../../../../lib/speech/downloadStats'
import type { HubModelInfo, SpeechModelManifest } from '../../../../lib/tauri'
import { EMPTY_PROJECTS_FILE } from '../../../../lib/types'
import { rememberHubModels } from '../../../../lib/voice/modelInfo'
import { useProjectsStore } from '../../../../stores/projectsStore'
import { LocalModelsView } from './LocalModelsView'
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

afterEach(cleanup)

beforeEach(() => {
  useProjectsStore.setState({ ...structuredClone(EMPTY_PROJECTS_FILE), hydrated: true })
  for (const fn of Object.values(actions)) fn.mockReset().mockResolvedValue(undefined)
  tauri.openInBrowser.mockClear()
  tauri.speechModelStates.mockReset().mockResolvedValue([])
  tauri.ttsVoices.mockReset().mockResolvedValue([])
})

describe('LocalModelsView', () => {
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
    expect(within(row).getAllByText('—')).toHaveLength(3)
    expect(row.textContent).toContain('prefs.voiceModelStatusNotDownloaded')
    const stt = screen.getByRole('rowgroup', { name: 'prefs.voiceSectionSttTitle' })
    expect(within(stt).queryByRole('button', { name: /^X/ })).toBeNull()
    fireEvent.click(toggle)
    expect(screen.getByText('A community voice')).toBeTruthy()
    expect(
      screen.queryByRole('button', { name: 'prefs.voiceUseFor:{"use":"prefs.voiceTabNarration"}' }),
    ).toBeNull()
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
    cleanup()
    mockHook([manifest(PIPER, 'tts')], {})
    render(<LocalModelsView initialMode="search" />)
    expect(
      within(rowOf('Piper · Edresson')).queryByRole('button', { name: 'prefs.voiceActionRemove' }),
    ).toBeNull()
  })

  it('a downloaded Hugging Face model shows in Installed with a badge', () => {
    mockHook([manifest(PIPER, 'tts'), edressonManifest], { [EDRESSON]: { kind: 'ready' } })
    render(<LocalModelsView />)
    expect(within(rowOf('Piper · Edresson')).getByText('prefs.voiceHubBadge')).toBeTruthy()
  })
})
