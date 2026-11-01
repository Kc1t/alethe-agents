import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { type CodexPromptDeliveryIo, deliverCodexPrompt } from './agentPromptDelivery'

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
