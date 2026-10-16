import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  estimateSpeechMs,
  Narrator,
  newAssistantTexts,
  resumeFrom,
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

describe('resumeFrom', () => {
  const text = 'First one. Second one! Third?'

  it('goes back to the start of the sentence the share of the text falls in', () => {
    expect(resumeFrom(text, 0)).toBe(text)
    expect(resumeFrom(text, 0.3)).toBe(text)
    // 0.6 of 29 characters falls inside "Second one!".
    expect(resumeFrom(text, 0.6)).toBe('Second one! Third?')
    expect(resumeFrom(text, 0.95)).toBe('Third?')
  })

  it('keeps the last sentence when the share runs past the end', () => {
    expect(resumeFrom(text, 1)).toBe('Third?')
    expect(resumeFrom(text, 7)).toBe('Third?')
  })

  it('does not split file names, and splits CJK sentences', () => {
    expect(resumeFrom('Editing auth.ts now. Done.', 0.5)).toBe('Editing auth.ts now. Done.')
    expect(resumeFrom('好的。完成了！', 0.9)).toBe('完成了！')
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

  describe('pause and resume', () => {
    /** Each utterance lasts until `end()`, `stop` or `skip`; `restarts` picks the system-voice mode. */
    const makeHeld = (restarts: boolean) => {
      const started: Array<{ text: string; shown: string }> = []
      let finish: (() => void) | null = null
      const release = () => {
        const done = finish
        finish = null
        done?.()
      }
      const deps = {
        speak: vi.fn((text: string, shown?: string) => {
          started.push({ text, shown: shown ?? text })
          return new Promise<void>((resolve) => (finish = resolve))
        }),
        stop: vi.fn(release),
        skip: vi.fn(release),
        pauseSpeech: vi.fn(),
        resumeSpeech: vi.fn(),
        restartsOnPause: () => restarts,
        progress: vi.fn(() => 0),
        onPausedChange: vi.fn(),
        onActiveChange: vi.fn(),
        t,
        verbosity: () => 'normal' as const,
        fillAfterMs: () => 8000,
      }
      const held = new Narrator(deps)
      held.beginTurn()
      const end = async () => {
        release()
        await vi.advanceTimersByTimeAsync(0)
      }
      const texts = () => started.map((item) => item.text)
      return { held, deps, started, texts, end }
    }

    it('holds a player utterance where it is and queues new text until resumed', async () => {
      const { held, deps, texts, end } = makeHeld(false)
      held.onAssistantText(['One. Two.'])
      await vi.advanceTimersByTimeAsync(0)
      held.pause()
      expect(deps.pauseSpeech).toHaveBeenCalledTimes(1)
      expect(deps.stop).not.toHaveBeenCalled()
      expect(deps.onPausedChange).toHaveBeenLastCalledWith(true)
      held.onAssistantText(['Three.'])
      await vi.advanceTimersByTimeAsync(5000)
      expect(texts()).toEqual(['One. Two.'])
      held.resume()
      expect(deps.resumeSpeech).toHaveBeenCalledTimes(1)
      expect(deps.onPausedChange).toHaveBeenLastCalledWith(false)
      await end()
      expect(texts()).toEqual(['One. Two.', 'Three.'])
      held.dispose()
    })

    it('starts nothing new when a held utterance ends while paused', async () => {
      const { held, texts, end } = makeHeld(false)
      held.onAssistantText(['One.', 'Two.'])
      await vi.advanceTimersByTimeAsync(0)
      held.pause()
      await end()
      expect(texts()).toEqual(['One.'])
      held.resume()
      await vi.advanceTimersByTimeAsync(0)
      expect(texts()).toEqual(['One.', 'Two.'])
      held.dispose()
    })

    it('speaks a system-voice item whole when nothing pauses it', async () => {
      const { held, started, texts, end } = makeHeld(true)
      held.onAssistantText(['First one. Second one! Third?', 'Next.'])
      await vi.advanceTimersByTimeAsync(0)
      expect(texts()).toEqual(['First one. Second one! Third?'])
      expect(started[0].shown).toBe('First one. Second one! Third?')
      await end()
      expect(texts()).toEqual(['First one. Second one! Third?', 'Next.'])
      held.dispose()
    })

    it('stops the system voice on pause and resumes from the sentence it had reached', async () => {
      const { held, deps, started, texts, end } = makeHeld(true)
      held.onAssistantText(['First one. Second one! Third?'])
      await vi.advanceTimersByTimeAsync(0)
      deps.progress.mockReturnValue(0.6)
      held.pause()
      expect(deps.stop).toHaveBeenCalledTimes(1)
      expect(deps.pauseSpeech).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(0)
      held.onAssistantText(['Later.'])
      await vi.advanceTimersByTimeAsync(5000)
      expect(texts()).toEqual(['First one. Second one! Third?'])
      held.resume()
      await vi.advanceTimersByTimeAsync(0)
      expect(texts()).toEqual(['First one. Second one! Third?', 'Second one! Third?'])
      // The panel keeps showing the whole item.
      expect(started[1].shown).toBe('First one. Second one! Third?')
      await end()
      expect(texts()).toEqual(['First one. Second one! Third?', 'Second one! Third?', 'Later.'])
      held.dispose()
    })

    it('says the system-voice item again from the sentence reached, without stopping the engine', async () => {
      const { held, deps, texts } = makeHeld(true)
      held.onAssistantText(['A one. B two.'])
      await vi.advanceTimersByTimeAsync(0)
      deps.progress.mockReturnValue(0.8)
      held.restartSentence()
      await vi.advanceTimersByTimeAsync(0)
      expect(deps.skip).toHaveBeenCalledTimes(1)
      expect(deps.stop).not.toHaveBeenCalled()
      expect(texts()).toEqual(['A one. B two.', 'B two.'])
      held.dispose()
    })

    it('does nothing on a restart when the engine cannot skip', async () => {
      const started: string[] = []
      const stop = vi.fn()
      const bare = new Narrator({
        speak: (text) => {
          started.push(text)
          return new Promise<void>(() => undefined)
        },
        stop,
        restartsOnPause: () => true,
        t,
        verbosity: () => 'normal',
        fillAfterMs: () => 8000,
      })
      bare.beginTurn()
      bare.onAssistantText(['A one. B two.'])
      await vi.advanceTimersByTimeAsync(0)
      bare.restartSentence()
      await vi.advanceTimersByTimeAsync(0)
      expect(started).toEqual(['A one. B two.'])
      expect(stop).not.toHaveBeenCalled()
      bare.dispose()
    })

    it('leaves a player utterance alone when asked to restart a sentence', async () => {
      const { held, deps, texts } = makeHeld(false)
      held.onAssistantText(['A one. B two.'])
      await vi.advanceTimersByTimeAsync(0)
      held.restartSentence()
      await vi.advanceTimersByTimeAsync(0)
      expect(deps.skip).not.toHaveBeenCalled()
      expect(texts()).toEqual(['A one. B two.'])
      held.dispose()
    })

    it('does not end the turn while narration is paused', async () => {
      const { held, texts, end } = makeHeld(false)
      held.onAssistantText(['One.'])
      await vi.advanceTimersByTimeAsync(0)
      held.pause()
      let ended = false
      void held.onStop('Final.').then(() => (ended = true))
      await end()
      expect(ended).toBe(false)
      held.resume()
      await vi.advanceTimersByTimeAsync(0)
      expect(texts()).toEqual(['One.', 'Final.'])
      await end()
      expect(ended).toBe(true)
      held.dispose()
    })

    it('does not pause when nothing is speaking or queued', async () => {
      const { held, deps, texts } = makeHeld(false)
      held.pause()
      expect(held.isPaused()).toBe(false)
      expect(deps.onPausedChange).not.toHaveBeenCalled()
      expect(deps.pauseSpeech).not.toHaveBeenCalled()
      held.onAssistantText(['Later.'])
      await vi.advanceTimersByTimeAsync(0)
      expect(texts()).toEqual(['Later.'])
      held.dispose()
    })

    it('reports when it has something to narrate and when it is done', async () => {
      const { held, deps, end } = makeHeld(false)
      held.onAssistantText(['One.'])
      await vi.advanceTimersByTimeAsync(0)
      expect(deps.onActiveChange).toHaveBeenLastCalledWith(true)
      await end()
      expect(deps.onActiveChange).toHaveBeenLastCalledWith(false)
      held.dispose()
    })

    // Nothing is left to resume: a pause kept on would hold the next turn (and the Test buttons).
    it('lets go of the pause when the held utterance ends with nothing queued', async () => {
      const { held, deps, end } = makeHeld(false)
      held.onAssistantText(['One.'])
      await vi.advanceTimersByTimeAsync(0)
      held.pause()
      let ended = false
      void held.onStop('One.').then(() => (ended = true))
      await end()
      expect(held.isPaused()).toBe(false)
      expect(deps.onPausedChange).toHaveBeenLastCalledWith(false)
      expect(deps.resumeSpeech).toHaveBeenCalledTimes(1)
      expect(ended).toBe(true)
      held.dispose()
    })

    it('a barge-in drops the queue and the pause', async () => {
      const { held, deps, texts } = makeHeld(false)
      held.onAssistantText(['One.'])
      await vi.advanceTimersByTimeAsync(0)
      held.pause()
      held.onAssistantText(['Two.'])
      held.stop()
      expect(deps.onPausedChange).toHaveBeenLastCalledWith(false)
      await vi.advanceTimersByTimeAsync(0)
      held.onAssistantText(['Three.'])
      await vi.advanceTimersByTimeAsync(0)
      expect(texts()).toEqual(['One.', 'Three.'])
      held.dispose()
    })
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
