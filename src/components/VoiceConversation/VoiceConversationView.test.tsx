import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { INITIAL_VOICE_CONVERSATION } from '../../stores/voiceConversationStore'
import { VoiceConversationView } from './VoiceConversationView'

vi.mock('../../lib/i18n', () => ({
  useT: () => (key: string, params?: { rate?: number }) =>
    params?.rate === undefined ? key : `${key}:${params.rate}`,
}))
vi.mock('../VoiceSpectrum', () => ({ VoiceSpectrum: () => null }))

const target = {
  ptyId: 'pty-1',
  projectId: 'p',
  terminalId: 't',
  label: 'Billing · Claude',
  cwd: '/w',
  sessionId: null,
}

describe('VoiceConversationView', () => {
  it('renders nothing while idle with nothing to say', () => {
    const { container } = render(
      <VoiceConversationView
        state={INITIAL_VOICE_CONVERSATION}
        targets={[]}
        hint=""
        approvalChannel="both"
        destructiveNeedsHud
        rate={1}
        onAction={() => undefined}
      />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('renders transcript and narration as text, never as HTML', () => {
    render(
      <VoiceConversationView
        state={{
          ...INITIAL_VOICE_CONVERSATION,
          turn: 'working',
          target,
          narration: '<img src=x onerror=alert(1)>',
        }}
        targets={[target]}
        hint=""
        approvalChannel="both"
        destructiveNeedsHud
        rate={1}
        onAction={() => undefined}
      />,
    )
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeTruthy()
    expect(document.querySelector('img')).toBeNull()
  })

  it('answers the permission card and offers the terminal', () => {
    const onAction = vi.fn()
    render(
      <VoiceConversationView
        state={{
          ...INITIAL_VOICE_CONVERSATION,
          turn: 'awaiting-permission',
          target,
          permission: { requestId: 'r', tool: 'Bash', subject: 'rm -rf dist', destructive: true },
        }}
        targets={[target]}
        hint=""
        approvalChannel="both"
        destructiveNeedsHud
        rate={1}
        onAction={onAction}
      />,
    )
    expect(screen.getByText('voice.conv.permissionDestructive')).toBeTruthy()
    fireEvent.click(screen.getByText('voice.conv.allow'))
    fireEvent.click(screen.getByText('voice.conv.answerInTerminal'))
    // Bound to the card that was clicked, so a late click cannot answer the next one.
    expect(onAction).toHaveBeenNthCalledWith(1, {
      kind: 'answer',
      answer: { kind: 'allow' },
      requestId: 'r',
    })
    expect(onAction).toHaveBeenNthCalledWith(2, {
      kind: 'answer',
      answer: { kind: 'defer' },
      requestId: 'r',
    })
  })

  it('hides the panel buttons for a safe request in voice-only mode', () => {
    render(
      <VoiceConversationView
        state={{
          ...INITIAL_VOICE_CONVERSATION,
          turn: 'awaiting-permission',
          target,
          permission: { requestId: 'r', tool: 'Bash', subject: 'npm test', destructive: false },
        }}
        targets={[target]}
        hint=""
        approvalChannel="voice"
        destructiveNeedsHud
        rate={1}
        onAction={() => undefined}
      />,
    )
    expect(screen.queryByText('voice.conv.allow')).toBeNull()
    expect(screen.getByText('voice.conv.answerInTerminal')).toBeTruthy()
  })

  describe('speed control', () => {
    const renderRate = (rate: number, onAction = vi.fn()) => {
      render(
        <VoiceConversationView
          state={{ ...INITIAL_VOICE_CONVERSATION, turn: 'working', target }}
          targets={[target]}
          hint=""
          approvalChannel="both"
          destructiveNeedsHud
          rate={rate}
          onAction={onAction}
        />,
      )
      return onAction
    }

    it('shows the four steps and presses the current one', () => {
      renderRate(1.25)
      const group = screen.getByRole('group', { name: 'voice.conv.rate' })
      expect(group.querySelectorAll('button')).toHaveLength(4)
      expect(screen.getByText('voice.conv.rateValue:1.25').getAttribute('aria-pressed')).toBe(
        'true',
      )
      expect(screen.getByText('voice.conv.rateValue:2').getAttribute('aria-pressed')).toBe('false')
    })

    it('presses none for a rate off the steps', () => {
      renderRate(1.2)
      expect(document.querySelectorAll('[aria-pressed="true"]')).toHaveLength(0)
    })

    it('reports the chosen rate', () => {
      const onAction = renderRate(1)
      fireEvent.click(screen.getByText('voice.conv.rateValue:2'))
      expect(onAction).toHaveBeenCalledWith({ kind: 'rate', rate: 2 })
    })
  })
})
