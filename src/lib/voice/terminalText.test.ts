import { describe, expect, it } from 'vitest'

import {
  chunkForSpeech,
  cleanTerminalLine,
  MAX_REPLY_CHARS,
  readableTerminalText,
  screenReply,
} from './terminalText'

describe('cleanTerminalLine', () => {
  it('drops frames, spinners, bullets and the prompt marker', () => {
    expect(cleanTerminalLine('│ ⏺ Fixed  the build │')).toBe('Fixed the build')
    expect(cleanTerminalLine('❯ fix the build')).toBe('fix the build')
    expect(cleanTerminalLine('⠋ Thinking')).toBe('Thinking')
  })
})

describe('readableTerminalText', () => {
  // A terminal wraps at its width, not at sentence ends.
  it('joins the lines of a paragraph and keeps paragraphs apart', () => {
    const raw = [
      'The build failed because',
      'the import was wrong.',
      '',
      '╭────╮',
      'Fixed now.',
    ].join('\n')
    expect(readableTerminalText(raw)).toBe(
      'The build failed because the import was wrong.\nFixed now.',
    )
  })

  it('is empty for a selection of frames only', () => {
    expect(readableTerminalText('──────\n│    │')).toBe('')
  })
})

describe('screenReply', () => {
  const before = ['opencode v1', '> old question', 'Old answer.'].join('\n')

  it('keeps what follows the prompt echo and was not on screen before', () => {
    const after = [
      before,
      '> fix the build',
      'Fixed the build: the import was wrong.',
      'Old answer.',
      'esc to interrupt',
      '12.3k tokens · 40% context left',
      '────────',
    ].join('\n')
    expect(screenReply(before, after, 'fix the build')).toBe(
      'Fixed the build: the import was wrong.',
    )
  })

  // OpenCode 1.18, recorded live: the reply repeats the prompt's last words, a status bar with
  // the time taken follows it, and the input box and footer sit below a run of empty rows.
  it('reads an OpenCode reply that repeats the prompt, without its status bar and footer', () => {
    const prompt =
      'Answer with exactly this sentence and nothing else: The build passes and all tests are green.'
    const opencodeBefore = [
      '  ┃  Ask anything... "Fix a TODO in the codebase"',
      '  ┃  Build · Big Pickle OpenCode',
      '  /work/oc-project                    1.18.18',
    ].join('\n')
    const opencodeAfter = [
      '  ┃',
      `  ┃  ${prompt}`,
      '  ┃',
      '',
      '     + Thought: 6.3s',
      '     + Thought: 814ms',
      '',
      '     The build passes and all tests are green.',
      '',
      '     ▣  Build · Big Pickle · 37.6s',
      ...Array.from({ length: 12 }, () => ''),
      '  ┃  Build · Big Pickle OpenCode',
      '  ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀',
      '   /work/oc-proj   11.7K (6%)ctrl+p',
      '   ect                     commands',
    ].join('\n')
    expect(screenReply(opencodeBefore, opencodeAfter, prompt)).toBe(
      'The build passes and all tests are green.',
    )
  })

  it('takes the end of a prompt that wraps over several rows as the end of its echo', () => {
    const prompt = 'please look at the failing integration tests and tell me why they fail now'
    const after = [
      '> please look at the failing integration tests and',
      '  tell me why they fail now',
      'They fail because the fixture database is missing.',
    ].join('\n')
    expect(screenReply('', after, prompt)).toBe(
      'They fail because the fixture database is missing.',
    )
  })

  // An alt-screen TUI redraws everything: there is no echo to anchor on, only what is new.
  it('falls back to the lines that are new when the prompt is not on screen', () => {
    expect(screenReply(before, 'opencode v1\nAll tests pass.', 'run the tests please')).toBe(
      'All tests pass.',
    )
  })

  it('keeps the end of a long reply, from a sentence start', () => {
    const long = Array.from({ length: 200 }, (_, index) => `Sentence ${index}.`).join(' ')
    const reply = screenReply('', `> go\n${long}`, 'go')
    expect(reply.length).toBeLessThanOrEqual(MAX_REPLY_CHARS)
    expect(reply).toMatch(/^Sentence \d+\./)
    expect(reply.endsWith('Sentence 199.')).toBe(true)
  })
})

describe('chunkForSpeech', () => {
  it('groups sentences up to the limit', () => {
    expect(chunkForSpeech('One. Two. Three.', 9)).toEqual(['One. Two.', 'Three.'])
  })

  it('cuts a sentence longer than the limit at spaces', () => {
    expect(chunkForSpeech('alpha beta gamma delta', 11)).toEqual(['alpha beta', 'gamma delta'])
  })

  it('returns nothing for blank text', () => {
    expect(chunkForSpeech('  \n ')).toEqual([])
  })
})
