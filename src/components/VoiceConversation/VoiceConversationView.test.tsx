import { cleanup, fireEvent, render, screen } from '@testing-library/react'
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
  tabId: 'a',
  tabActive: true,
  label: 'Billing · Claude',
  cwd: '/w',
  sessionId: null,
}
const other = {
  ...target,
  ptyId: 'pty-2',
  projectId: 'q',
  terminalId: 't2',
  tabId: 'b',
  tabActive: false,
  label: 'Web · Main',
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

  // The HUD window stays open after a turn; an empty view left it a blank gray rectangle.
  it('never renders blank in the HUD window, even idle with only the last narration', () => {
    render(
      <VoiceConversationView
        embedded
        state={{ ...INITIAL_VOICE_CONVERSATION, narration: 'All done.' }}
        targets={[target]}
        current={target}
        hint="Hold Ctrl+Shift+Space and speak"
        approvalChannel="both"
        destructiveNeedsHud
        rate={1}
        onAction={() => undefined}
      />,
    )
    expect(screen.getByText('voice.conv.phase.idle')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'voice.conv.target' })).toBeTruthy()
    expect(screen.getByText('All done.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'voice.conv.mute' })).toBeTruthy()
    expect(screen.getByText('Hold Ctrl+Shift+Space and speak')).toBeTruthy()
  })

  it('renders in the HUD window with nothing at all to say', () => {
    const { container } = render(
      <VoiceConversationView
        embedded
        state={INITIAL_VOICE_CONVERSATION}
        targets={[]}
        hint="hint"
        approvalChannel="both"
        destructiveNeedsHud
        rate={1}
        onAction={() => undefined}
      />,
    )
    expect(container.firstChild).not.toBeNull()
    expect(screen.getByText('voice.conv.phase.idle')).toBeTruthy()
  })

  // The last narration stays in the store after the turn; the in-app panel must not stay with it.
  it('hides the in-app panel while idle with only the last narration', () => {
    const { container } = render(
      <VoiceConversationView
        state={{ ...INITIAL_VOICE_CONVERSATION, narration: 'All done.' }}
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

  describe('narration controls', () => {
    const renderControls = (
      patch: Partial<typeof INITIAL_VOICE_CONVERSATION> = {},
      onAction = vi.fn(),
    ) => {
      render(
        <VoiceConversationView
          state={{ ...INITIAL_VOICE_CONVERSATION, turn: 'working', target, ...patch }}
          targets={[target]}
          hint=""
          approvalChannel="both"
          destructiveNeedsHud
          rate={1}
          onAction={onAction}
        />,
      )
      return onAction
    }
    const icon = (name: string, className: string) =>
      screen.getByRole('button', { name }).querySelector(`svg.${className}`)

    it('offers mute, pause and stop while narration plays', () => {
      const onAction = renderControls({ narrationActive: true })
      expect(icon('voice.conv.mute', 'lucide-volume2')).toBeTruthy()
      expect(icon('voice.conv.pause', 'lucide-pause')).toBeTruthy()
      expect(icon('voice.conv.stopSpeaking', 'lucide-square')).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: 'voice.conv.mute' }))
      fireEvent.click(screen.getByRole('button', { name: 'voice.conv.pause' }))
      fireEvent.click(screen.getByRole('button', { name: 'voice.conv.stopSpeaking' }))
      expect(onAction.mock.calls.map(([action]) => action)).toEqual([
        { kind: 'toggle-mute' },
        { kind: 'toggle-pause' },
        { kind: 'stop-speaking' },
      ])
    })

    // A pause with nothing to hold would stay on with no narration to resume.
    it('disables pause while nothing is narrated, but never resume', () => {
      const onAction = renderControls({ narrationActive: false })
      const pause = screen.getByRole('button', { name: 'voice.conv.pause' }) as HTMLButtonElement
      expect(pause.disabled).toBe(true)
      fireEvent.click(pause)
      expect(onAction).not.toHaveBeenCalled()
      cleanup()
      renderControls({ narrationActive: false, narrationPaused: true })
      const resume = screen.getByRole('button', { name: 'voice.conv.resume' }) as HTMLButtonElement
      expect(resume.disabled).toBe(false)
    })

    it('offers unmute and resume while muted and paused', () => {
      const onAction = renderControls({ muted: true, narrationPaused: true, narrationActive: true })
      expect(icon('voice.conv.unmute', 'lucide-volume-x')).toBeTruthy()
      expect(icon('voice.conv.resume', 'lucide-play')).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: 'voice.conv.unmute' }))
      fireEvent.click(screen.getByRole('button', { name: 'voice.conv.resume' }))
      expect(onAction.mock.calls.map(([action]) => action)).toEqual([
        { kind: 'toggle-mute' },
        { kind: 'toggle-pause' },
      ])
    })
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

  describe('spoken-word highlight', () => {
    const renderNarration = (
      narration: string,
      narrationSpokenOffset: number | null,
      reducedMotion = false,
    ) =>
      render(
        <VoiceConversationView
          embedded
          state={{ ...INITIAL_VOICE_CONVERSATION, narration, narrationSpokenOffset }}
          targets={[]}
          hint=""
          approvalChannel="both"
          destructiveNeedsHud
          rate={1}
          reducedMotion={reducedMotion}
          onAction={() => undefined}
        />,
      )
    const part = (name: string) => document.querySelector(`[data-part="${name}"]`)

    it('shows what was spoken, the word being spoken and what is still to come', () => {
      renderNarration('Run the tests now.', 9)
      expect(part('spoken')?.textContent).toBe('Run the ')
      expect(part('current')?.textContent).toBe('tests')
      expect(part('upcoming')?.textContent).toBe(' now.')
      expect(document.querySelector('[data-highlight="true"]')?.textContent).toBe(
        'Run the tests now.',
      )
    })

    it('shows plain text when nothing is being spoken', () => {
      renderNarration('All done.', null)
      expect(screen.getByText('All done.')).toBeTruthy()
      expect(part('current')).toBeNull()
      expect(document.querySelector('[data-highlight="true"]')).toBeNull()
    })

    it('marks it all spoken once the item finished', () => {
      renderNarration('All done.', 9)
      expect(part('spoken')?.textContent).toBe('All done.')
      expect(part('current')).toBeNull()
    })

    // The app's own reduced-motion preference; the OS one is a media query in the stylesheet.
    it('drops the transitions under reduced motion', () => {
      renderNarration('Run the tests now.', 9, true)
      expect(document.querySelector('[data-highlight="true"]')?.getAttribute('data-motion')).toBe(
        'reduced',
      )
    })

    it('scrolls the narration box to keep the word being spoken in view', () => {
      const { rerender } = renderNarration('one two three four five six', 0)
      const box = document.querySelector('[data-highlight="true"]') as HTMLElement
      Object.defineProperty(box, 'clientHeight', { configurable: true, value: 40 })
      const proto = HTMLElement.prototype
      const offsetTop = Object.getOwnPropertyDescriptor(proto, 'offsetTop')
      const offsetHeight = Object.getOwnPropertyDescriptor(proto, 'offsetHeight')
      Object.defineProperty(proto, 'offsetTop', { configurable: true, get: () => 100 })
      Object.defineProperty(proto, 'offsetHeight', { configurable: true, get: () => 20 })
      try {
        rerender(
          <VoiceConversationView
            embedded
            state={{
              ...INITIAL_VOICE_CONVERSATION,
              narration: 'one two three four five six',
              narrationSpokenOffset: 24,
            }}
            targets={[]}
            hint=""
            approvalChannel="both"
            destructiveNeedsHud
            rate={1}
            onAction={() => undefined}
          />,
        )
        // The word sits at 100..120 in a 40 px box: scrolled so its bottom is the box's bottom.
        expect(box.scrollTop).toBe(80)
      } finally {
        if (offsetTop) Object.defineProperty(proto, 'offsetTop', offsetTop)
        if (offsetHeight) Object.defineProperty(proto, 'offsetHeight', offsetHeight)
      }
    })
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

  describe('target picker', () => {
    const renderPicker = ({
      targets = [target],
      current = target as typeof target | null,
      pinnedPtyId = null as string | null,
      restartable = [] as (typeof target)[],
      onAction = vi.fn(),
    } = {}) => {
      render(
        <VoiceConversationView
          state={{
            ...INITIAL_VOICE_CONVERSATION,
            notice: { key: 'voice.conv.heardNothing' },
            pinnedPtyId,
          }}
          targets={targets}
          restartable={restartable}
          current={current}
          hint=""
          approvalChannel="both"
          destructiveNeedsHud
          rate={1}
          onAction={onAction}
        />,
      )
      return onAction
    }
    const trigger = () => screen.getByRole('button', { name: 'voice.conv.target' })

    it('is a picker even with a single session, showing the one voice talks to', () => {
      renderPicker()
      expect(trigger().textContent).toBe('Billing · Claude')
    })

    it('shows the follow option when there is no session at all', () => {
      renderPicker({ targets: [], current: null })
      expect(trigger().textContent).toBe('voice.conv.followActive')
    })

    it('offers following the active pane first, then every session', () => {
      const onAction = renderPicker({ targets: [target, other] })
      fireEvent.click(trigger())
      const options = screen.getAllByRole('option')
      expect(options.map((option) => option.textContent)).toEqual([
        'voice.conv.followActive',
        'Billing · Claude',
        'Web · Main',
      ])
      // Following: the follow option is the selected one, even though the trigger names the pane.
      expect(options[0].getAttribute('aria-selected')).toBe('true')
      fireEvent.click(options[2])
      expect(onAction).toHaveBeenCalledWith({ kind: 'pin', ptyId: 'pty-2' })
    })

    it('unpins with the follow option', () => {
      const onAction = renderPicker({
        targets: [target, other],
        current: other,
        pinnedPtyId: 'pty-2',
      })
      expect(trigger().textContent).toBe('Web · Main')
      fireEvent.click(trigger())
      expect(screen.getAllByRole('option')[2].getAttribute('aria-selected')).toBe('true')
      fireEvent.click(screen.getByRole('option', { name: 'voice.conv.followActive' }))
      expect(onAction).toHaveBeenCalledWith({ kind: 'pin', ptyId: null })
    })

    // A Claude started while voice was off has no voice hooks: it shows, but only to restart it.
    it('lists a session without voice hooks disabled, with why and a restart', () => {
      const stale = { ...other, ptyId: 'pty-9', label: 'Old · Claude' }
      const onAction = renderPicker({ targets: [target], restartable: [stale] })
      fireEvent.click(trigger())
      const options = screen.getAllByRole('option')
      expect(options.map((option) => option.textContent)).toEqual([
        'voice.conv.followActive',
        'Billing · Claude',
        'Old · Claudevoice.conv.needsRestart',
        'voice.conv.restartSession',
      ])
      const session = options[2] as HTMLButtonElement
      expect(session.disabled).toBe(true)
      fireEvent.click(session)
      expect(onAction).not.toHaveBeenCalled()
      fireEvent.click(options[3])
      expect(onAction).toHaveBeenCalledWith({ kind: 'restart-session', ptyId: 'pty-9' })
      expect(onAction).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'pin' }))
    })

    // The HUD window takes no keyboard input, so a search box would be dead weight.
    it('has no search box', () => {
      renderPicker({ targets: [target, other] })
      fireEvent.click(trigger())
      expect(screen.queryByRole('textbox')).toBeNull()
    })
  })
})
