import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { tabForTarget, VoicePage } from './VoicePage'

vi.mock('../VoiceDictationSection', () => ({
  VoiceDictationSection: () => <div>dictation-body</div>,
}))
vi.mock('../VoiceConversationSection', () => ({
  VoiceConversationSection: () => <div>conversation-body</div>,
}))
vi.mock('../NarrationBehaviorSection', () => ({
  NarrationBehaviorSection: () => <div>narration-behavior-body</div>,
}))
vi.mock('./NarrationPanel', () => ({ NarrationPanel: () => <div>narration-body</div> }))
vi.mock('./ProviderGrid', () => ({
  ProviderGrid: ({ onOpen }: { onOpen: (id: 'openai') => void }) => (
    <button onClick={() => onOpen('openai')}>open-openai</button>
  ),
}))
vi.mock('./ProviderDetail', () => ({
  ProviderDetail: ({ id, filter, onBack }: { id: string; filter?: string; onBack: () => void }) => (
    <button onClick={onBack}>{filter ? `detail-${id}-${filter}` : `detail-${id}`}</button>
  ),
}))
vi.mock('./VoiceInUseSummary', () => ({
  VoiceInUseSummary: ({ onOpenTab }: { onOpenTab: (tab: 'narration') => void }) => (
    <button onClick={() => onOpenTab('narration')}>in-use-summary</button>
  ),
}))
vi.mock('../../../../lib/i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../lib/i18n')>()),
  useT: () => (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
}))

afterEach(cleanup)

describe('VoicePage', () => {
  it('opens on dictation and switches tabs', () => {
    render(<VoicePage target={null} />)
    expect(screen.getByText('dictation-body')).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: 'prefs.voiceTabNarration' }))
    expect(screen.getByText('narration-body')).toBeTruthy()
    expect(screen.getByText('narration-behavior-body')).toBeTruthy()
    expect(screen.queryByText('dictation-body')).toBeNull()
  })

  it('introduces each tab in one line', () => {
    render(<VoicePage target={null} />)
    expect(screen.getByText(/^prefs\.voiceTabIntroDictation:\{"shortcut":".+"\}$/)).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: 'prefs.voiceTabConversation' }))
    expect(screen.getByText('prefs.voiceTabIntroConversation')).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: 'prefs.voiceTabNarration' }))
    expect(screen.getByText('prefs.voiceTabIntroNarration')).toBeTruthy()
  })

  it('opens the tab that holds a search target', () => {
    render(<VoicePage target="voice-conversation-voice" />)
    expect(screen.getByText('narration-body')).toBeTruthy()
  })

  it('opens a provider detail and goes back', () => {
    render(<VoicePage target={null} />)
    fireEvent.click(screen.getByText('open-openai'))
    expect(screen.queryByText('dictation-body')).toBeNull()
    fireEvent.click(screen.getByText('detail-openai'))
    expect(screen.getByText('dictation-body')).toBeTruthy()
  })

  it('shows the in-use summary instead of the generic description', () => {
    render(<VoicePage target={null} />)
    expect(screen.queryByText('prefs.categoryVoiceDesc')).toBeNull()
    fireEvent.click(screen.getByText('in-use-summary'))
    expect(screen.getByText('narration-body')).toBeTruthy()
    expect(screen.queryByText('dictation-body')).toBeNull()
  })

  it("Compare models opens Local models filtered to the tab's use", () => {
    render(<VoicePage target={null} />)
    fireEvent.click(screen.getByRole('button', { name: 'prefs.voiceCompareModels' }))
    fireEvent.click(screen.getByText('detail-local-stt'))
    expect(screen.getByText('dictation-body')).toBeTruthy()

    fireEvent.click(screen.getByRole('tab', { name: 'prefs.voiceTabConversation' }))
    fireEvent.click(screen.getByRole('button', { name: 'prefs.voiceCompareModels' }))
    fireEvent.click(screen.getByText('detail-local-stt'))
    expect(screen.getByText('conversation-body')).toBeTruthy()

    fireEvent.click(screen.getByRole('tab', { name: 'prefs.voiceTabNarration' }))
    fireEvent.click(screen.getByRole('button', { name: 'prefs.voiceCompareModels' }))
    expect(screen.queryByText('narration-body')).toBeNull()
    expect(screen.getByText('detail-local-tts')).toBeTruthy()
  })

  it('maps search targets to tabs', () => {
    expect(tabForTarget('dictation-mic')).toBe('dictation')
    expect(tabForTarget('voice-conversation')).toBe('conversation')
    expect(tabForTarget('voice-conversation-voice')).toBe('narration')
    expect(tabForTarget('voice-conversation-narration')).toBe('narration')
    expect(tabForTarget('voice-providers')).toBeNull()
  })
})
