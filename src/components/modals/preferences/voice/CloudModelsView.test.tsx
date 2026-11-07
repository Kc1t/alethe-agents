import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { VoiceProviderCatalog } from '../../../../lib/tauri'
import { EMPTY_PROJECTS_FILE } from '../../../../lib/types'
import { useProjectsStore } from '../../../../stores/projectsStore'
import { CloudModelsView } from './CloudModelsView'

vi.mock('../../../../lib/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../lib/tauri')>()),
  saveProjectsFile: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../../../lib/i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../lib/i18n')>()),
  useT: () => (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
}))
vi.mock('./CloudKeyForm', () => ({ CloudKeyForm: () => <div>key-form</div> }))

const WHISPER = 'openai/whisper-1'
const KOKORO = 'hexgrad/kokoro-82m'

const router = (models: VoiceProviderCatalog['models']): VoiceProviderCatalog => ({
  provider: 'openrouter',
  keyUrl: 'https://openrouter.ai/keys',
  models,
  voices: [],
})

const ROUTER = router([
  { id: WHISPER, label: 'Whisper', capability: 'stt', price: '$100' },
  { id: 'x/free-stt', label: 'Free STT', capability: 'stt' },
  {
    id: KOKORO,
    label: 'Kokoro',
    capability: 'tts',
    voices: ['af_bella', 'pf_dora', 'pm_alex', 'Zephyr'],
    price: '$0.50 / $6',
  },
])

const rowOf = (name: string) =>
  screen.getByRole('button', { name: new RegExp(`^${name}$`) }).closest('tr') as HTMLElement
const cellOf = (row: HTMLElement, column: string) =>
  row.querySelector(`[data-column="${column}"]`) as HTMLElement
const expand = (name: string) =>
  fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${name}$`) }))

afterEach(cleanup)

beforeEach(() => {
  useProjectsStore.setState({ ...structuredClone(EMPTY_PROJECTS_FILE), hydrated: true })
})

describe('CloudModelsView', () => {
  it('shows the OpenRouter price per million per row, and "—" when the price is absent', () => {
    render(<CloudModelsView provider="openrouter" catalog={ROUTER} />)
    const priced = cellOf(rowOf('Whisper'), 'price')
    expect(priced.textContent).toBe('$100 prefs.voicePricePerMillion')
    expect(within(priced).getByTitle('prefs.voicePriceHint').textContent).toBe(
      '$100 prefs.voicePricePerMillion',
    )
    expect(cellOf(rowOf('Free STT'), 'price').textContent).toBe('—')
    expect(cellOf(rowOf('Kokoro'), 'price').textContent).toBe(
      '$0.50 / $6 prefs.voicePricePerMillion',
    )
    const note = screen.getByText('prefs.voicePriceHint', { selector: 'p' })
    const table = screen.getByRole('table')
    expect(table.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('splits models into speech-to-text and text-to-speech sections', () => {
    render(<CloudModelsView provider="openrouter" catalog={ROUTER} />)
    const stt = screen.getByRole('rowgroup', { name: 'prefs.voiceSectionSttTitle' })
    const tts = screen.getByRole('rowgroup', { name: 'prefs.voiceSectionTtsTitle' })
    expect(within(stt).getByText('Whisper')).toBeTruthy()
    expect(within(stt).getByText('Free STT')).toBeTruthy()
    expect(within(stt).queryByText('Kokoro')).toBeNull()
    expect(within(tts).getByText('Kokoro')).toBeTruthy()
  })

  it('counts voices and the languages their ids encode', () => {
    render(<CloudModelsView provider="openrouter" catalog={ROUTER} />)
    const kokoro = rowOf('Kokoro')
    expect(cellOf(kokoro, 'voices').textContent).toBe('4')
    expect(cellOf(kokoro, 'languages').textContent).toBe(
      'prefs.voiceModelLanguagesMany:{"count":2}',
    )
    const whisper = rowOf('Whisper')
    expect(cellOf(whisper, 'voices').textContent).toBe('—')
    expect(cellOf(whisper, 'languages').textContent).toBe('—')
  })

  it('lists the voices of an expanded OpenRouter TTS row grouped by language', () => {
    render(<CloudModelsView provider="openrouter" catalog={ROUTER} />)
    expand('Kokoro')
    const groups = screen.getAllByRole('group')
    expect(groups.map((group) => group.getAttribute('aria-label'))).toEqual([
      'English (United States)',
      'prefs.voiceLangMulti',
      'Portuguese (Brazil)',
    ])
    const [english, multi, portuguese] = groups
    expect(english.textContent).toContain('Bella (prefs.voiceGenderFemale)')
    expect(english.textContent).not.toContain('Dora')
    expect(multi.textContent).toContain('Zephyr')
    expect(
      within(portuguese)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['Dora (prefs.voiceGenderFemale)', 'Alex (prefs.voiceGenderMale)'])
    expect(english.textContent).not.toContain('·')
  })

  it('lists the provider voices for a curated TTS model without its own voices', () => {
    const openai: VoiceProviderCatalog = {
      provider: 'openai',
      keyUrl: 'https://platform.openai.com',
      models: [{ id: 'gpt-4o-mini-tts', label: 'Mini TTS', capability: 'tts' }],
      voices: [
        { id: 'nova', label: 'Nova' },
        { id: 'alloy', label: 'Alloy' },
      ],
    }
    render(<CloudModelsView provider="openai" catalog={openai} />)
    const row = rowOf('Mini TTS')
    expect(cellOf(row, 'voices').textContent).toBe('2')
    expect(cellOf(row, 'languages').textContent).toBe('—')
    expect(cellOf(row, 'price').textContent).toBe('—')
    expect(screen.queryByRole('columnheader', { name: 'prefs.voiceColSpeed' })).toBeNull()
    expand('Mini TTS')
    const [multi] = screen.getAllByRole('group')
    expect(multi.getAttribute('aria-label')).toBe('prefs.voiceLangMulti')
    expect(
      within(multi)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['Nova', 'Alloy'])
    expect(screen.queryByText('prefs.voicePriceHint')).toBeNull()
  })

  it('shows a disconnected badge without a saved key', () => {
    render(<CloudModelsView provider="openrouter" catalog={ROUTER} />)
    expect(screen.getByText('prefs.voiceStatusDisconnected')).toBeTruthy()
  })

  it('offers a search above six models and filters rows by name or id', () => {
    const many = router(
      Array.from({ length: 7 }, (_, i) => ({
        id: `vendor/model-${i}`,
        label: `Model ${i}`,
        capability: 'stt' as const,
      })),
    )
    render(<CloudModelsView provider="openrouter" catalog={many} />)
    const search = screen.getByRole('searchbox', { name: 'prefs.voiceSearchModels' })
    fireEvent.change(search, { target: { value: 'model-3' } })
    expect(screen.getByText('Model 3')).toBeTruthy()
    expect(screen.queryByText('Model 4')).toBeNull()
    fireEvent.change(search, { target: { value: 'MODEL 5' } })
    expect(screen.getByText('Model 5')).toBeTruthy()
    expect(screen.queryByText('Model 3')).toBeNull()
    expect(screen.queryByRole('cell', { name: 'prefs.voiceNoModelsMatch' })).toBeNull()
    fireEvent.change(search, { target: { value: 'nothing like it' } })
    expect(screen.getByRole('cell', { name: 'prefs.voiceNoModelsMatch' })).toBeTruthy()
  })

  it('has no search with six models or fewer', () => {
    render(<CloudModelsView provider="openrouter" catalog={ROUTER} />)
    expect(screen.queryByRole('searchbox')).toBeNull()
  })
})
