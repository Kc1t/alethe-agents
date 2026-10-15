import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  estimateSpeechMs,
  Narrator,
  newAssistantTexts,
  speakableText,
  statusFill,
  type Translate,
} from './narrator'

const t: Translate = (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key)

describe('speakableText', () => {
  it('strips markdown and replaces code blocks', () => {
    const text =
      '## Done\n\nI fixed **auth** in `login.ts`.\n\n```ts\nconst a = 1\n```\nSee [the docs](https://x.y).'
    expect(speakableText(text, t)).toBe(
      'Done I fixed auth in login.ts. voice.narration.codeBlock See the docs.',
    )
  })

  it('shortens long lists and drops tables', () => {
    const list = Array.from({ length: 8 }, (_, i) => `- item ${i + 1}`).join('\n')
    expect(speakableText(list, t)).toBe(
      'item 1 item 2 item 3 voice.narration.moreItems:{"count":5}',
    )
    expect(speakableText('| a | b |\n|---|---|\n| 1 | 2 |', t)).toBe('voice.narration.table')
  })

  it('replaces bare URLs', () => {
    expect(speakableText('Open https://example.com/x now', t)).toBe('Open voice.narration.link now')
  })
})

describe('statusFill', () => {
  it('describes what the running tool is doing', () => {
    expect(statusFill({ tool_name: 'Bash', tool_input: { command: 'npm test' } }, t)).toBe(
      'voice.narration.runningTests',
    )
    expect(
      statusFill(
        { tool_name: 'Bash', tool_input: { command: 'cargo build', description: 'Build the app' } },
        t,
      ),
    ).toBe('voice.narration.runningCommand:{"what":"Build the app"}')
    expect(statusFill({ tool_name: 'Bash', tool_input: { command: 'ls' } }, t)).toBe(
      'voice.narration.runningShell',
    )
    expect(statusFill({ tool_name: 'Edit', tool_input: { file_path: '/a/b/auth.ts' } }, t)).toBe(
      'voice.narration.editing:{"file":"auth.ts"}',
    )
    expect(statusFill({ tool_name: 'Grep', tool_input: {} }, t)).toBe('voice.narration.searching')
    expect(statusFill({ tool_name: 'Mystery' }, t)).toBe(
      'voice.narration.working:{"tool":"Mystery"}',
    )
  })
})

describe('newAssistantTexts', () => {
  const event = (role: 'user' | 'assistant' | 'tool', text: string) => ({ role, text })

  it('returns assistant text past the cursor and moves the cursor to the end', () => {
    const snapshot = {
      firstIndex: 10,
      messages: [
        event('assistant', 'old'),
        event('user', 'go'),
        event('tool', 'Bash: x'),
        event('assistant', 'new'),
      ],
    }
    expect(newAssistantTexts(snapshot, 11)).toEqual({ texts: ['new'], cursor: 14 })
  })

  // The same prompt asked twice: the cursor, not the prompt text, decides what is new.
  it('never returns events from before the cursor, even when the tail moved', () => {
    const snapshot = { firstIndex: 50, messages: [event('assistant', 'repeat answer')] }
    expect(newAssistantTexts(snapshot, 51)).toEqual({ texts: [], cursor: 51 })
  })
})

describe('estimateSpeechMs', () => {
  it('grows with the text and shrinks with the rate', () => {
    expect(estimateSpeechMs('hello', 1)).toBeLessThan(
      estimateSpeechMs('hello there, how are you', 1),
    )
    expect(estimateSpeechMs('hello there', 2)).toBeLessThan(estimateSpeechMs('hello there', 1))
  })
})

describe('Narrator', () => {
  let spoken: string[]
  let verbosity: 'silent' | 'final' | 'normal' | 'detailed'
  let narrator: Narrator

  beforeEach(() => {
    vi.useFakeTimers()
    spoken = []
    verbosity = 'normal'
    narrator = new Narrator({
      speak: async (text) => void spoken.push(text),
      stop: vi.fn(),
      t,
      verbosity: () => verbosity,
      fillAfterMs: () => 8000,
      now: () => Date.now(),
    })
    narrator.beginTurn()
  })

  afterEach(() => {
    narrator.dispose()
    vi.useRealTimers()
  })

  it('speaks assistant text in order', async () => {
    narrator.onAssistantText(['First.', 'Second.'])
    await vi.runOnlyPendingTimersAsync()
    expect(spoken).toEqual(['First.', 'Second.'])
  })

  it('speaks a status after a silence while a tool runs', async () => {
    narrator.onToolStart({ tool_name: 'Bash', tool_input: { command: 'npm test' } })
    await vi.advanceTimersByTimeAsync(7000)
    expect(spoken).toEqual([])
    await vi.advanceTimersByTimeAsync(2000)
    expect(spoken).toEqual(['voice.narration.runningTests'])
  })

  it('stays quiet about tools once the tool ended', async () => {
    narrator.onToolStart({ tool_name: 'Bash', tool_input: { command: 'npm test' } })
    narrator.onToolEnd()
    await vi.advanceTimersByTimeAsync(20000)
    expect(spoken).toEqual([])
  })

  it('speaks only the final answer in final mode', async () => {
    verbosity = 'final'
    narrator.onAssistantText(['Thinking out loud.'])
    narrator.onToolStart({ tool_name: 'Grep' })
    await vi.advanceTimersByTimeAsync(20000)
    const done = narrator.onStop('All done.')
    await vi.runOnlyPendingTimersAsync()
    await done
    expect(spoken).toEqual(['All done.'])
  })

  it('does not repeat the final answer the transcript already delivered', async () => {
    narrator.onAssistantText(['All done.'])
    const done = narrator.onStop('All done.')
    await vi.runOnlyPendingTimersAsync()
    await done
    expect(spoken).toEqual(['All done.'])
  })

  it('says nothing in silent mode but still announces permission questions', async () => {
    verbosity = 'silent'
    narrator.onAssistantText(['Hidden.'])
    narrator.announce('Allow npm install?')
    const done = narrator.onStop('Hidden too.')
    await vi.runOnlyPendingTimersAsync()
    await done
    expect(spoken).toEqual(['Allow npm install?'])
  })

  it('also speaks every tool start in detailed mode', async () => {
    verbosity = 'detailed'
    narrator.onToolStart({ tool_name: 'Read', tool_input: { file_path: '/x/README.md' } })
    await vi.runOnlyPendingTimersAsync()
    expect(spoken).toEqual(['voice.narration.reading:{"file":"README.md"}'])
  })

  describe('barge-in', () => {
    const makeSlow = () => {
      const started: string[] = []
      const stop = vi.fn()
      const slow = new Narrator({
        speak: (text) => {
          started.push(text)
          return new Promise<void>((resolve) => setTimeout(resolve, 1000))
        },
        stop,
        t,
        verbosity: () => 'normal',
        fillAfterMs: () => 8000,
      })
      slow.beginTurn()
      return { slow, started, stop }
    }

    it('drops what is queued when the person starts talking', async () => {
      const { slow, started, stop } = makeSlow()
      slow.onAssistantText(['One.', 'Two.', 'Three.'])
      slow.stop()
      expect(stop).toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(5000)
      expect(started).toEqual(['One.'])
      slow.dispose()
    })

    it('says nothing about the running tool after a barge-in', async () => {
      narrator.onToolStart({ tool_name: 'Bash', tool_input: { command: 'cargo build' } })
      await vi.advanceTimersByTimeAsync(1000)
      narrator.stop()
      await vi.advanceTimersByTimeAsync(20000)
      expect(spoken).toEqual([])
    })

    it('ends a turn with no tool, queue or fill left behind', async () => {
      narrator.dispose()
      const { slow, started } = makeSlow()
      slow.onToolStart({ tool_name: 'Bash', tool_input: { command: 'cargo build' } })
      slow.onAssistantText(['One.', 'Two.'])
      slow.endTurn()
      await vi.advanceTimersByTimeAsync(20000)
      expect(started).toEqual(['One.'])
      expect(vi.getTimerCount()).toBe(0)
      slow.dispose()
    })

    it('still speaks an announcement made while the stopped utterance is pending', async () => {
      const { slow, started } = makeSlow()
      slow.onAssistantText(['One.', 'Two.', 'Three.'])
      slow.stop()
      slow.announce('Allow?')
      await vi.advanceTimersByTimeAsync(5000)
      expect(started).toEqual(['One.', 'Allow?'])
      slow.dispose()
    })
  })
})
