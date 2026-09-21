import { readFileSync } from 'node:fs'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { en } from './lib/i18n/messages/en'
import { ptBR } from './lib/i18n/messages/pt-BR'

const source =
  readFileSync('src-tauri/remote/locales.js', 'utf8').replace(
    'export const messages',
    'const messages',
  ) +
  readFileSync('src-tauri/remote/app.js', 'utf8').replace(
    "import { messages } from './locales.js'",
    '',
  )
const settle = async () => {
  for (let i = 0; i < 15; i++) await Promise.resolve()
}
const response = (data: unknown, status = 200) => ({
  status,
  ok: status < 400,
  json: async () => data,
})
const snapshot = (
  messages: { role: string; text: string; questionSetId?: string; questions?: unknown[] }[] = [],
  revision = 1,
) => ({
  supported: true,
  agent: 'codex',
  messages,
  revision,
})

function harness() {
  return new Function(`${source.replace('void boot()', '')}
    state = { projects: [{ name: 'Project', chats: [
      { ptyId: 'codex', name: 'Codex chat', agent: 'codex' },
      { ptyId: 'claude', name: 'Claude chat', agent: 'claude' },
      { ptyId: 'shell', name: 'Shell', agent: 'shell' },
    ] }] };
    connectionState = 'live';
    return { openChat, loadTranscript, setChatView, stopTranscriptPolling, renderHome,
      chatSession, setConnectionState, renderTranscript, renderMarkdown, messages,
      setReadOnly: (value) => { readOnly = value },
      setTranscript: (value) => { transcript = value; renderTranscript() },
      updateChatFeedback,
    };
  `)()
}

describe('remote mobile conversations', () => {
  let ui: ReturnType<typeof harness>
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
    sessionStorage.clear()
    document.body.innerHTML = '<main id="app"></main>'
    fetchMock = vi.fn(async () => response(snapshot()))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('matchMedia', () => ({ matches: true }))
    ui = harness()
  })

  afterEach(() => {
    ui.stopTranscriptPolling()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  const type = (text: string) => {
    const input = document.querySelector<HTMLTextAreaElement>('#message')!
    input.value = text
    input.dispatchEvent(new Event('input'))
    return input
  }
  const send = () =>
    document.querySelector('#composer')!.dispatchEvent(new Event('submit', { cancelable: true }))

  it.each(['codex', 'claude'])(
    'opens %s in chat with loading, then a helpful empty state',
    async (agent) => {
      ui.openChat(agent)
      expect(document.querySelector('#messages')).toHaveAttribute('aria-busy', 'true')
      expect(document.querySelector('.chat-skeleton')).not.toBeNull()
      await settle()
      expect(document.querySelector('.messages-empty')).toHaveTextContent('Start a conversation')
      expect(document.querySelector('.send-button')).toBeDisabled()
      expect(document.querySelector('#messages')).toHaveAttribute('aria-busy', 'false')
    },
  )

  it('shows the outgoing message immediately, prevents duplicate sends, and reconciles a reply', async () => {
    ui.openChat('codex')
    await settle()
    let accept!: (value: unknown) => void
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          accept = resolve
        }),
    )
    type('Review the changes')
    send()
    send()
    expect(fetchMock.mock.calls.filter(([path]) => path.endsWith('/api/message'))).toHaveLength(1)
    expect(document.querySelector('.msg-pending')).toHaveTextContent('Review the changes')
    expect(document.querySelector('.send-button')).toBeDisabled()
    accept(response({ ok: true }))
    await settle()
    expect(document.querySelector('#chat-feedback')).toHaveTextContent('Waiting for Codex')
    expect(document.querySelector('#message')).toHaveValue('')
    fetchMock.mockResolvedValueOnce(
      response(
        snapshot(
          [
            { role: 'user', text: 'Review the changes' },
            { role: 'assistant', text: '## Review\n- First finding\n- Second finding' },
          ],
          2,
        ),
      ),
    )
    await ui.loadTranscript('codex')
    expect(document.querySelector('.msg-pending')).toBeNull()
    expect(document.querySelectorAll('.msg[data-role="user"]')).toHaveLength(1)
    expect(document.querySelectorAll('.msg-body li')).toHaveLength(2)
    expect(document.querySelector('#chat-feedback')).toHaveTextContent('Conversation up to date')
  })

  it('preserves the draft after rate limiting and allows a deliberate retry', async () => {
    ui.openChat('claude')
    await settle()
    type('Explain this code')
    fetchMock.mockResolvedValueOnce(response({ error: 'Too many messages' }, 429))
    send()
    await settle()
    expect(document.querySelector('#message')).toHaveValue('Explain this code')
    expect(document.querySelector('#composer-error')).toHaveTextContent('Too many messages')
    expect(document.querySelector('.send-button')).not.toBeDisabled()
    expect(document.querySelector('.msg-pending')).toBeNull()
    send()
    await settle()
    expect(document.querySelector('#message')).toHaveValue('')
  })

  it('keeps existing responses and expanded tools when refresh fails or adds messages', async () => {
    const initial = [
      { role: 'assistant', text: 'Saved response' },
      { role: 'tool', text: 'Read: file.ts' },
    ]
    fetchMock.mockResolvedValueOnce(response(snapshot(initial)))
    ui.openChat('codex')
    await settle()
    document.querySelector<HTMLDetailsElement>('.msg-step')!.open = true
    fetchMock.mockRejectedValueOnce(new Error('Connection interrupted'))
    await ui.loadTranscript('codex')
    expect(document.querySelector('#messages')).toHaveTextContent('Saved response')
    expect(document.querySelector('[data-retry]')).not.toHaveAttribute('hidden')
    fetchMock.mockResolvedValueOnce(
      response(snapshot([...initial, { role: 'assistant', text: 'Next response' }], 2)),
    )
    await ui.loadTranscript('codex')
    expect(document.querySelector('.msg-step')).toHaveAttribute('open')
    expect(document.querySelector('#messages')).toHaveTextContent('Next response')
    expect(document.querySelector('[data-retry]')).toHaveAttribute('hidden')
  })

  it('keeps drafts per agent across view changes, navigation, and an in-flight send', async () => {
    ui.openChat('codex')
    await settle()
    type('Codex draft')
    ui.setChatView('terminal')
    expect(document.querySelector('#message')).toHaveValue('Codex draft')
    ui.setChatView('messages')
    await settle()
    let accept!: (value: unknown) => void
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          accept = resolve
        }),
    )
    send()
    ui.openChat('claude')
    await settle()
    type('Claude draft')
    accept(response({ ok: true }))
    await settle()
    expect(document.querySelector('#message')).toHaveValue('Claude draft')
    ui.openChat('codex')
    expect(document.querySelector('#message')).toHaveValue('')
  })

  it('ignores old transcript requests and does not overlap refreshes', async () => {
    let resolveOld!: (value: unknown) => void
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve
        }),
    )
    ui.openChat('codex')
    await ui.loadTranscript('codex')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    ui.openChat('claude')
    await settle()
    resolveOld(response(snapshot([{ role: 'assistant', text: 'Wrong conversation' }])))
    await settle()
    expect(document.querySelector('#messages')).not.toHaveTextContent('Wrong conversation')
  })

  it('times out a stalled history request and recovers through the retry button', async () => {
    fetchMock.mockResolvedValue(response({ supported: true, error: 'Connection unavailable' }))
    fetchMock.mockImplementationOnce(
      (_path, options) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          )
        }),
    )
    ui.openChat('codex')
    type('Keep my draft while loading')
    expect(document.querySelector('.send-button')).toBeDisabled()
    await vi.advanceTimersByTimeAsync(12_000)
    expect(document.querySelector('[data-retry]')).not.toHaveAttribute('hidden')
    expect(document.querySelector('#messages')).toHaveAttribute('aria-busy', 'false')
    fetchMock.mockResolvedValue(response(snapshot()))
    document.querySelector<HTMLButtonElement>('[data-retry]')!.click()
    await settle()
    expect(document.querySelector('.messages-empty')).not.toBeNull()
    expect(document.querySelector('#message')).toHaveValue('Keep my draft while loading')
    expect(document.querySelector('.send-button')).not.toBeDisabled()
  })

  it('keeps the draft and reports uncertain delivery when sending times out', async () => {
    ui.openChat('claude')
    await settle()
    fetchMock.mockImplementationOnce(
      (_path, options) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          )
        }),
    )
    type('Check the project')
    send()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(document.querySelector('#composer-error')).toHaveTextContent(
      'Delivery could not be confirmed',
    )
    expect(document.querySelector('#message')).toHaveValue('Check the project')
    expect(document.querySelector('.send-button')).not.toBeDisabled()
    expect(document.querySelector('.msg-pending')).toBeNull()
  })

  it('does not confuse a repeated prompt with an older completed exchange', async () => {
    const old = [
      { role: 'user', text: 'Continue' },
      { role: 'assistant', text: 'Earlier answer' },
    ]
    fetchMock.mockResolvedValueOnce(response(snapshot(old)))
    ui.openChat('codex')
    await settle()
    type('Continue')
    fetchMock.mockResolvedValueOnce(response({ ok: true }))
    fetchMock.mockResolvedValueOnce(response(snapshot(old, 2)))
    send()
    await settle()
    expect(document.querySelector('.msg-pending')).toHaveTextContent('Continue')
    fetchMock.mockResolvedValueOnce(
      response(
        snapshot(
          [...old, { role: 'user', text: 'Continue' }, { role: 'assistant', text: 'New answer' }],
          3,
        ),
      ),
    )
    await ui.loadTranscript('codex')
    expect(document.querySelector('.msg-pending')).toBeNull()
    expect(document.querySelector('#messages')).toHaveTextContent('New answer')
  })

  it('leaves mobile Enter and IME composition alone, and blocks sending while disconnected', async () => {
    ui.openChat('codex')
    await settle()
    const input = type('Multiline message')
    const enter = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true })
    input.dispatchEvent(enter)
    expect(enter.defaultPrevented).toBe(false)
    vi.stubGlobal('matchMedia', () => ({ matches: false }))
    const composing = new KeyboardEvent('keydown', {
      key: 'Enter',
      isComposing: true,
      cancelable: true,
    })
    input.dispatchEvent(composing)
    expect(composing.defaultPrevented).toBe(false)
    ui.setConnectionState('reconnecting')
    send()
    expect(document.querySelector('.send-button')).toBeDisabled()
    expect(document.querySelector('#message')).toHaveValue('Multiline message')
    expect(fetchMock.mock.calls.filter(([path]) => path.endsWith('/api/message'))).toHaveLength(0)
  })

  it.each([
    ['codex', false],
    ['claude', true],
  ])('renders and answers structured %s questions from the phone', async (agent, multiSelect) => {
    fetchMock.mockResolvedValueOnce(
      response(
        snapshot([
          {
            role: 'question',
            text: 'Scope: Which areas should change?',
            questionSetId: `${agent}-question-1`,
            questions: [
              {
                id: 'scope',
                header: 'Scope',
                question: 'Which areas should change?',
                multiSelect,
                options: [
                  { label: 'Remote UI', description: 'Improve the mobile experience' },
                  { label: 'Backend', description: 'Handle interactive input' },
                ],
              },
            ],
          },
        ]),
      ),
    )
    ui.openChat(agent)
    await settle()
    expect(document.querySelector('.question-card')).toHaveTextContent('Which areas should change?')
    const options = document.querySelectorAll<HTMLInputElement>('.question-option input')
    options[1].click()
    if (multiSelect) options[0].click()
    fetchMock.mockResolvedValueOnce(response({}, 204))
    fetchMock.mockResolvedValueOnce(response({ unchanged: true }))
    document
      .querySelector('[data-question-form]')!
      .dispatchEvent(new Event('submit', { cancelable: true }))
    await settle()
    const call = fetchMock.mock.calls.find(([path]) => path.endsWith('/api/question-answer'))!
    expect(JSON.parse(call[1].body)).toEqual({
      ptyId: agent,
      questionSetId: `${agent}-question-1`,
      selections: [multiSelect ? [0, 1] : [1]],
      customAnswers: [null],
    })
    expect(document.querySelector('.question-resolved')).toHaveTextContent('already been answered')
    expect(document.querySelector('#chat-feedback')).toHaveTextContent(`Waiting for`)
  })

  it('supports a free-form answer for questions without losing structured validation', async () => {
    fetchMock.mockResolvedValueOnce(
      response(
        snapshot([
          {
            role: 'question',
            text: 'Approach: How should this work?',
            questionSetId: 'codex-question-custom',
            questions: [
              {
                id: 'approach',
                header: 'Approach',
                question: 'How should this work?',
                multiSelect: false,
                options: [{ label: 'Default', description: 'Use the suggested approach' }],
              },
            ],
          },
        ]),
      ),
    )
    ui.openChat('codex')
    await settle()
    document.querySelector<HTMLInputElement>('[data-custom-toggle]')!.click()
    const custom = document.querySelector<HTMLInputElement>('[data-custom-input]')!
    custom.value = 'Keep the existing API and change the UI'
    custom.dispatchEvent(new Event('input'))
    fetchMock.mockResolvedValueOnce(response({}, 204))
    fetchMock.mockResolvedValueOnce(response({ unchanged: true }))
    document
      .querySelector('[data-question-form]')!
      .dispatchEvent(new Event('submit', { cancelable: true }))
    await settle()
    const call = fetchMock.mock.calls.find(([path]) => path.endsWith('/api/question-answer'))!
    expect(JSON.parse(call[1].body)).toEqual({
      ptyId: 'codex',
      questionSetId: 'codex-question-custom',
      selections: [[]],
      customAnswers: ['Keep the existing API and change the UI'],
    })
  })

  it('restores unsent drafts after the mobile page reloads and clears them after delivery', async () => {
    ui.openChat('claude')
    await settle()
    type('Draft that must survive a reload')
    ui.stopTranscriptPolling()
    document.body.innerHTML = '<main id="app"></main>'
    ui = harness()
    ui.openChat('claude')
    await settle()
    expect(document.querySelector('#message')).toHaveValue('Draft that must survive a reload')
    fetchMock.mockResolvedValueOnce(response({}, 204))
    send()
    await settle()
    ui.stopTranscriptPolling()
    document.body.innerHTML = '<main id="app"></main>'
    ui = harness()
    ui.openChat('claude')
    expect(document.querySelector('#message')).toHaveValue('')
  })

  it('surfaces conversations that need attention in the mobile workspace list', async () => {
    fetchMock.mockResolvedValueOnce(
      response(
        snapshot([
          {
            role: 'question',
            text: 'Scope: Choose a scope',
            questionSetId: 'codex-question-attention',
            questions: [
              {
                id: 'scope',
                header: 'Scope',
                question: 'Choose a scope',
                multiSelect: false,
                options: [{ label: 'Focused', description: '' }],
              },
            ],
          },
        ]),
      ),
    )
    ui.openChat('codex')
    await settle()
    ui.renderHome()
    expect(document.querySelector('[data-chat="codex"] .terminal-status')).toHaveTextContent(
      'Needs answer',
    )
  })

  it('supports read-only devices, shell fallback, and a terminal hint after a long wait', async () => {
    ui.setReadOnly(true)
    ui.openChat('claude')
    await settle()
    expect(document.querySelector('#composer')).toBeNull()
    expect(document.querySelector('.read-only-notice')).not.toBeNull()
    ui.chatSession().waitingSince = Date.now() - 21_000
    ui.updateChatFeedback()
    expect(document.querySelector('[data-open-terminal]')).not.toHaveAttribute('hidden')
    ui.openChat('shell')
    expect(document.querySelector('#terminal-host')).not.toBeNull()
  })

  it('detects an active desktop turn and lets the phone stop Codex or Claude', async () => {
    fetchMock.mockResolvedValueOnce(
      response(snapshot([{ role: 'user', text: 'Run the full validation' }])),
    )
    ui.openChat('codex')
    await settle()
    const stop = document.querySelector<HTMLButtonElement>('[data-interrupt]')!
    expect(stop).not.toHaveAttribute('hidden')
    fetchMock.mockResolvedValueOnce(response({}, 204))
    stop.click()
    await settle()
    const call = fetchMock.mock.calls.find(([path]) => path.endsWith('/api/agent-control'))!
    expect(JSON.parse(call[1].body)).toEqual({ ptyId: 'codex', action: 'interrupt' })
    expect(document.querySelector('#chat-feedback')).toHaveTextContent('Stop requested')
    expect(stop).toHaveAttribute('hidden')
  })

  it('copies the original response text and reports clipboard failures', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    fetchMock.mockResolvedValueOnce(
      response(snapshot([{ role: 'assistant', text: '## Result\nUse the exact source text.' }])),
    )
    ui.openChat('codex')
    await settle()
    const copy = document.querySelector<HTMLButtonElement>('[data-copy-message]')!
    copy.click()
    await settle()
    expect(writeText).toHaveBeenCalledWith('## Result\nUse the exact source text.')
    expect(copy).toHaveTextContent('Copied')
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    })
    copy.click()
    await settle()
    expect(copy).toHaveTextContent('Copy failed')
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
  })

  it('renders agent text as safe markup and registers all new remote strings in both locales', () => {
    const html = ui.renderMarkdown(
      '## Title\n<img src=x onerror=alert(1)>\n\n```js\n<script>alert(1)</script>\n```',
    )
    document.querySelector('#app')!.innerHTML = html
    expect(document.querySelector('img, script')).toBeNull()
    expect(document.querySelector('h3')).toHaveTextContent('Title')
    for (const key of [
      'chat.loading',
      'chat.loadFailed',
      'chat.loadTimeout',
      'chat.sent',
      'chat.synced',
      'chat.waiting',
      'chat.waitingLong',
      'chat.reconnecting',
      'chat.emptyTitle',
      'chat.emptyHint',
      'chat.agentPlaceholder',
      'chat.mobileHint',
      'chat.viewLabel',
      'chat.sendUncertain',
      'chat.interrupt',
      'chat.interruptSent',
      'chat.interruptError',
      'chat.copy',
      'chat.copied',
      'chat.copyFailed',
      'question.title',
      'question.multiple',
      'question.submit',
      'question.answered',
      'question.readOnly',
      'question.sendError',
      'question.sendUncertain',
      'question.other',
      'question.otherPlaceholder',
      'home.status.working',
      'home.status.question',
      'home.status.draft',
      'home.status.ended',
    ] as const) {
      expect(ui.messages.en[key]).toBe(en[key])
      expect(ui.messages['pt-BR'][key]).toBe(ptBR[key])
    }
  })
})
