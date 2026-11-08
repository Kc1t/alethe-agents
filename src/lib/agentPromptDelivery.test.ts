import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  type CodexPromptDeliveryIo,
  deliverCodexPrompt,
  looksLikeChoicePrompt,
  pasteAndSubmit,
  readLiveScreen,
  readRecentLines,
} from './agentPromptDelivery'

const COMPOSER = '› Ask Codex to do anything\n\n  ? for shortcuts'
const HOOKS_DIALOG =
  'Hooks need review\n› 1. Review hooks\n  2. Trust all and continue\n  enter confirm · esc skip'
const PROMPT = 'Read the complete handoff packet at "C:\\handoffs\\abc\\context.md".'

type FakeCodex = {
  io: CodexPromptDeliveryIo
  events: string[]
  setScreen: (screen: string) => void
}

function fakeCodex(initialScreen: string, onSubmit?: (fake: FakeCodex) => void): FakeCodex {
  let screen = initialScreen
  const events: string[] = []
  const fake: FakeCodex = {
    events,
    setScreen: (next) => {
      screen = next
    },
    io: {
      readScreenText: () => screen,
      paste: async (text) => {
        events.push(screen.includes('enter confirm') ? 'paste-into-dialog' : 'paste')
        screen = `${screen}\n› ${text}`
      },
      submit: async () => {
        events.push(screen.includes('enter confirm') ? 'enter-into-dialog' : 'enter')
        onSubmit?.(fake)
      },
      sleep: async (ms) => {
        vi.advanceTimersByTime(ms)
      },
      isCancelled: () => false,
    },
  }
  return fake
}

describe('deliverCodexPrompt', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('pastes and submits once the composer has settled', async () => {
    const codex = fakeCodex(COMPOSER, (fake) => fake.setScreen(`${COMPOSER}\n• Working`))

    await expect(deliverCodexPrompt(PROMPT, Date.now() + 60_000, codex.io)).resolves.toBe(true)
    expect(codex.events).toEqual(['paste', 'enter'])
  })

  it('waits for the person to close a startup dialog before typing or pressing Enter', async () => {
    const codex = fakeCodex(`${COMPOSER}\n${HOOKS_DIALOG}`, (fake) =>
      fake.setScreen(`${COMPOSER}\n• Working`),
    )
    setTimeout(() => codex.setScreen(COMPOSER), 20_000)

    await expect(deliverCodexPrompt(PROMPT, Date.now() + 60_000, codex.io)).resolves.toBe(true)
    expect(codex.events).toEqual(['paste', 'enter'])
  })

  it('holds the Enter while a dialog opens over the pasted prompt', async () => {
    const codex = fakeCodex(COMPOSER, (fake) => fake.setScreen(`${COMPOSER}\n• Working`))
    const paste = codex.io.paste
    codex.io.paste = async (text) => {
      await paste(text)
      codex.setScreen(`${COMPOSER}\n› ${text}\n${HOOKS_DIALOG}`)
      setTimeout(() => codex.setScreen(`${COMPOSER}\n› ${text}`), 10_000)
    }

    await expect(deliverCodexPrompt(PROMPT, Date.now() + 60_000, codex.io)).resolves.toBe(true)
    expect(codex.events).toEqual(['paste', 'enter'])
  })

  it('presses Enter again only while the screen stays the same', async () => {
    let submits = 0
    const codex = fakeCodex(COMPOSER, (fake) => {
      submits += 1
      if (submits === 2) fake.setScreen(`${COMPOSER}\n• Working`)
    })

    await expect(deliverCodexPrompt(PROMPT, Date.now() + 60_000, codex.io)).resolves.toBe(true)
    expect(codex.events).toEqual(['paste', 'enter', 'enter'])
  })

  it('gives up without typing when a dialog stays open until the deadline', async () => {
    const codex = fakeCodex(`${COMPOSER}\n${HOOKS_DIALOG}`)

    await expect(deliverCodexPrompt(PROMPT, Date.now() + 30_000, codex.io)).resolves.toBe(false)
    expect(codex.events).toEqual([])
  })
})

describe('safe agent prompt submission', () => {
  it('pastes before submitting once and arms completion immediately before Enter', async () => {
    const events: string[] = []
    await pasteAndSubmit('hello', {
      writeChunked: async (text) => {
        events.push('paste:' + text)
      },
      sleep: async () => {
        events.push('settle')
      },
      beforeEnter: () => {
        events.push('arm')
      },
      write: async (data) => {
        events.push(data)
      },
    })
    expect(events).toEqual(['paste:hello', 'settle', 'arm', '\r'])
  })

  it('never sends Enter if a prompt opens during the paste or the paste fails', async () => {
    const write = vi.fn(async () => {})
    await expect(
      pasteAndSubmit('hello', {
        writeChunked: async () => {},
        sleep: async () => {},
        beforeEnter: () => {
          throw new Error('prompt open')
        },
        write,
      }),
    ).rejects.toThrow('prompt open')
    expect(write).not.toHaveBeenCalled()
    await expect(
      pasteAndSubmit('hello', {
        writeChunked: async () => {
          throw new Error('write failed')
        },
        sleep: async () => {},
        write,
      }),
    ).rejects.toThrow('write failed')
    expect(write).not.toHaveBeenCalled()
  })

  it.each([
    '❯ 1. Yes, proceed',
    '│ 1) Allow once',
    'Allow once   Reject',
    'Hooks need review\n› 1. Review hooks\n  2. Trust all and continue\n  enter confirm · esc skip',
    'Press enter to continue',
    '❯ 1. PostgreSQL\n  2. SQLite\nEnter to select · Esc to cancel',
  ])('recognizes an approval or startup choice prompt: %s', (screen) => {
    expect(looksLikeChoicePrompt(screen)).toBe(true)
  })

  it('accepts a normal composer with shortcut hints', () => {
    expect(looksLikeChoicePrompt('› Ask Codex to do anything\n? for shortcuts')).toBe(false)
  })

  it('checks the live screen from its first row and joins soft-wrapped screen text', () => {
    const rows = ['old scrollback', '❯ 1. Yes', 'wrapped', ' continuation', '']
    const buffer = {
      baseY: 1,
      cursorY: 1,
      length: rows.length,
      getLine: (index: number) => ({
        translateToString: () => rows[index],
        isWrapped: index === 3,
      }),
    }
    expect(readLiveScreen(buffer, 4)).toContain('❯ 1. Yes')
    expect(readLiveScreen(buffer, 4)).not.toContain('old scrollback')
    expect(readRecentLines(buffer, 3)).toBe('wrapped continuation\n')
  })
})
