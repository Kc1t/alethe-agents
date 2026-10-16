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
  { id: WHISPER, label: 'Whisper', capability: 'stt', price: '$0.0001' },
  { id: 'x/free-stt', label: 'Free STT', capability: 'stt' },
  {
    id: KOKORO,
    label: 'Kokoro',
    capability: 'tts',
    voices: ['af_bella', 'pf_dora', 'pm_alex', 'Zephyr'],
    price: '$0.00000062',
  },
])

const prefs = () => useProjectsStore.getState().preferences
const connect = (invalid = false) =>
  useProjectsStore.getState().setPreferences({
    voiceProviders: { openrouter: { configured: true, invalid } },
  })

/** The `<tr>` holding a model's toggle button. */
const rowOf = (name: string) =>
  screen.getByRole('button', { name: new RegExp(`^${name}$`) }).closest('tr') as HTMLElement
const cellOf = (row: HTMLElement, column: string) =>
  row.querySelector(`[data-column="${column}"]`) as HTMLElement
const expand = (name: string) =>
  fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${name}$`) }))
const assignButton = (use: string) =>
  screen.getByRole('button', { name: `prefs.voiceUseFor:{"use":"${use}"}` })

afterEach(cleanup)

beforeEach(() => {
  useProjectsStore.setState({ ...structuredClone(EMPTY_PROJECTS_FILE), hydrated: true })
})

describe('CloudModelsView', () => {
  it('shows the OpenRouter price per row, and "—" when the price is absent', () => {
    render(<CloudModelsView provider="openrouter" catalog={ROUTER} />)
    const priced = cellOf(rowOf('Whisper'), 'price')
    expect(priced.textContent).toBe('$0.0001')
    expect(within(priced).getByTitle('prefs.voicePriceHint').textContent).toBe('$0.0001')
    expect(cellOf(rowOf('Free STT'), 'price').textContent).toBe('—')
    expect(cellOf(rowOf('Kokoro'), 'price').textContent).toBe('$0.00000062')
    // The explanation is also visible as a note under the table.
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
    // af_bella → en-US, pf_dora/pm_alex → pt-BR; Zephyr encodes no language.
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
    // App language first, then multilingual voices, then the other languages.
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
    // The group heading names the language; items do not repeat it.
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
    // No model of this provider has a price, so the price note is not shown.
    expect(screen.queryByText('prefs.voicePriceHint')).toBeNull()
  })

  it('Use for Narration writes the provider, model and app-language voice, keeping the rate', () => {
    connect()
    useProjectsStore.getState().setPreferences({
      voiceTts: { provider: 'system', model: '', voice: 'Samantha', rate: 1.25 },
    })
    const sttBefore = structuredClone(prefs().voiceStt)
    render(<CloudModelsView provider="openrouter" catalog={ROUTER} />)
    expect(screen.getByText('prefs.voiceNotInUseShort')).toBeTruthy()
    expand('Kokoro')
    const button = assignButton('prefs.voiceTabNarration')
    expect(button.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(button)
    expect(prefs().voiceTts).toEqual({
      provider: 'openrouter',
      model: KOKORO,
      voice: 'af_bella',
      rate: 1.25,
    })
    expect(prefs().voiceStt).toEqual(sttBefore)
    const pressed = assignButton('prefs.voiceTabNarration')
    expect(pressed.getAttribute('aria-pressed')).toBe('true')
    expect((pressed as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('prefs.voiceInUseFor:{"uses":"prefs.voiceTabNarration"}')).toBeTruthy()
  })

  it('Use for Narration picks a Brazilian Portuguese voice when the app is in pt-BR', () => {
    connect()
    useProjectsStore.getState().setPreferences({ language: 'pt-BR' })
    render(<CloudModelsView provider="openrouter" catalog={ROUTER} />)
    expand('Kokoro')
    fireEvent.click(assignButton('prefs.voiceTabNarration'))
    expect(prefs().voiceTts).toMatchObject({
      provider: 'openrouter',
      model: KOKORO,
      voice: 'pf_dora',
    })
  })

  it('Use for Narration on ElevenLabs leaves the voice to the Narration tab', () => {
    useProjectsStore.getState().setPreferences({
      voiceProviders: { elevenlabs: { configured: true, invalid: false } },
      voiceTts: { provider: 'system', model: '', voice: 'Samantha', rate: 1 },
    })
    const eleven: VoiceProviderCatalog = {
      provider: 'elevenlabs',
      keyUrl: 'https://elevenlabs.io',
      models: [{ id: 'eleven_flash_v2_5', label: 'Flash v2.5', capability: 'tts' }],
      // Account voices are not in the bundled catalog.
      voices: [],
    }
    render(<CloudModelsView provider="elevenlabs" catalog={eleven} />)
    expect(cellOf(rowOf('Flash v2.5'), 'voices').textContent).toBe('—')
    expand('Flash v2.5')
    fireEvent.click(assignButton('prefs.voiceTabNarration'))
    expect(prefs().voiceTts).toEqual({
      provider: 'elevenlabs',
      model: 'eleven_flash_v2_5',
      voice: null,
      rate: 1,
    })
  })

  it('Use for Dictation writes only the dictation choice', () => {
    connect()
    const conversation = structuredClone(prefs().voiceStt.conversation)
    const tts = structuredClone(prefs().voiceTts)
    render(<CloudModelsView provider="openrouter" catalog={ROUTER} />)
    expand('Whisper')
    fireEvent.click(assignButton('prefs.voiceTabDictation'))
    expect(prefs().voiceStt.dictation).toEqual({
      provider: 'openrouter',
      model: WHISPER,
      locale: null,
    })
    expect(prefs().voiceStt.conversation).toEqual(conversation)
    expect(prefs().voiceTts).toEqual(tts)
    expect(screen.queryByRole('button', { name: /prefs\.voiceTabNarration/ })).toBeNull()
  })

  it('disables the Use buttons without a key, titled with the no-key warning', () => {
    const before = structuredClone(prefs().voiceStt)
    render(<CloudModelsView provider="openrouter" catalog={ROUTER} />)
    expand('Whisper')
    for (const use of ['prefs.voiceTabDictation', 'prefs.voiceTabConversation']) {
      const button = assignButton(use) as HTMLButtonElement
      expect(button.disabled).toBe(true)
      expect(button.title).toBe('prefs.voiceWarnNoKey')
      fireEvent.click(button)
    }
    expect(prefs().voiceStt).toEqual(before)
  })

  it('shows the status badge, where the provider is in use and the privacy line', () => {
    connect(true)
    useProjectsStore.getState().setPreferences({
      voiceStt: {
        ...prefs().voiceStt,
        dictation: { provider: 'openrouter', model: WHISPER, locale: null },
      },
    })
    render(<CloudModelsView provider="openrouter" catalog={ROUTER} />)
    expect(screen.getByText('prefs.voiceStatusInvalid')).toBeTruthy()
    expect(screen.getByText('prefs.voiceInUseFor:{"uses":"prefs.voiceTabDictation"}')).toBeTruthy()
    expect(
      screen.getByText('prefs.voiceCloudPrivacy:{"provider":"voice.provider.openrouter"}'),
    ).toBeTruthy()
    // The header sits above the key form.
    const header = screen.getByText('prefs.voiceStatusInvalid')
    const form = screen.getByText('key-form')
    expect(header.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // Per row: the expanded Whisper row is in use for Dictation only.
    expand('Whisper')
    expect(assignButton('prefs.voiceTabDictation').getAttribute('aria-pressed')).toBe('true')
    expect(assignButton('prefs.voiceTabConversation').getAttribute('aria-pressed')).toBe('false')
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
