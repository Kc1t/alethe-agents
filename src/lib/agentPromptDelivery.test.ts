import { describe, expect, it } from 'vitest'

import {
  looksLikeChoicePrompt,
  pasteAndSubmit,
  readLiveScreen,
  SUBMIT_SETTLE_MS,
  TerminalPromptOpenError,
} from './agentPromptDelivery'

describe('pasteAndSubmit', () => {
  it('pastes, waits, then presses Enter exactly once', async () => {
    const calls: string[] = []
    await pasteAndSubmit('fix the build', {
      writeChunked: async (text) => void calls.push(`paste:${text}`),
      write: async (data) => void calls.push(`write:${JSON.stringify(data)}`),
      sleep: async (ms) => void calls.push(`sleep:${ms}`),
    })
    expect(calls).toEqual(['paste:fix the build', `sleep:${SUBMIT_SETTLE_MS}`, 'write:"\\r"'])
  })

  it('checks the screen after the settle and right before the Enter', async () => {
    const calls: string[] = []
    await pasteAndSubmit('fix the build', {
      writeChunked: async (text) => void calls.push(`paste:${text}`),
      write: async (data) => void calls.push(`write:${JSON.stringify(data)}`),
      sleep: async (ms) => void calls.push(`sleep:${ms}`),
      beforeEnter: () => void calls.push('check'),
    })
    expect(calls).toEqual([
      'paste:fix the build',
      `sleep:${SUBMIT_SETTLE_MS}`,
      'check',
      'write:"\\r"',
    ])
  })

  // A menu that opened between the paste and the Enter would take the Enter as its answer.
  it('sends no Enter when the pre-Enter check throws', async () => {
    const writes: string[] = []
    await expect(
      pasteAndSubmit('fix the build', {
        writeChunked: async () => undefined,
        write: async (data) => void writes.push(data),
        sleep: async () => undefined,
        beforeEnter: () => {
          throw new TerminalPromptOpenError()
        },
      }),
    ).rejects.toBeInstanceOf(TerminalPromptOpenError)
    expect(writes).toEqual([])
  })
})

describe('looksLikeChoicePrompt', () => {
  it('recognises a Bash permission dialog', () => {
    const screen = [
      '──────────────────────────────────────────────',
      ' Bash command',
      '',
      '   npm install express',
      '   Install express',
      '',
      ' Do you want to proceed?',
      ' ❯ 1. Yes',
      "   2. Yes, and don't ask again for npm install commands in /w",
      '   3. No, and tell Claude what to do differently (esc)',
    ].join('\n')
    expect(looksLikeChoicePrompt(screen)).toBe(true)
  })

  it('recognises an edit dialog whichever option is selected', () => {
    const screen = [
      ' Edit file',
      ' auth.ts',
      ' Do you want to make this edit to auth.ts?',
      '   1. Yes',
      ' ❯ 2. Yes, allow all edits during this session (shift+tab)',
      '   3. No, and tell Claude what to do differently (esc)',
    ].join('\n')
    expect(looksLikeChoicePrompt(screen)).toBe(true)
  })

  // Older Claude Code versions draw the dialog inside a box.
  it('recognises a dialog drawn inside a box', () => {
    const screen = [
      '╭──────────────────────────────╮',
      '│ Do you want to proceed?      │',
      '│ ❯ 1. Yes                     │',
      '│   2. No                      │',
      '╰──────────────────────────────╯',
    ].join('\n')
    expect(looksLikeChoicePrompt(screen)).toBe(true)
  })

  it('recognises the trust-folder menu', () => {
    const screen = [
      ' Do you trust the files in this folder?',
      '',
      ' /w',
      '',
      ' > 1. Yes, proceed',
      '   2. No, exit',
    ].join('\n')
    expect(looksLikeChoicePrompt(screen)).toBe(true)
  })

  it('ignores ordinary output and the empty prompt box', () => {
    expect(looksLikeChoicePrompt('⏺ I asked whether to merge: 1. Yes I fixed it')).toBe(false)
    expect(
      looksLikeChoicePrompt(['Next steps:', '1. Install deps', '2. Run tests'].join('\n')),
    ).toBe(false)
    const promptBox = [
      '╭──────────────────────────────────────────╮',
      '│ >                                        │',
      '╰──────────────────────────────────────────╯',
      '  ? for shortcuts',
    ].join('\n')
    expect(looksLikeChoicePrompt(promptBox)).toBe(false)
  })
})

describe('readLiveScreen', () => {
  const bufferOf = (lines: string[], baseY: number, cursorY: number) => ({
    baseY,
    cursorY,
    length: lines.length,
    getLine: (y: number) =>
      y >= 0 && y < lines.length ? { translateToString: () => lines[y] } : undefined,
  })
  const dialog = [
    ' Do you want to proceed?',
    ' ❯ 1. Yes',
    "   2. Yes, and don't ask again",
    '   3. No, and tell Claude what to do differently (esc)',
  ]

  // Claude Code draws inline from the top: in a fresh, tall pane the menu sits high up, above
  // a run of blank rows.
  it('reads the whole screen of a tall pane, not just its last rows', () => {
    const lines = Array.from({ length: 70 }, () => '')
    lines.splice(15, dialog.length, ...dialog)
    const screen = readLiveScreen(bufferOf(lines, 0, 20), 70)
    expect(looksLikeChoicePrompt(screen)).toBe(true)
  })

  it('reads the live screen below the scrollback, not old output above it', () => {
    const lines = [...dialog, ...Array.from({ length: 100 }, (_, i) => `line ${i}`)]
    const screen = readLiveScreen(bufferOf(lines, lines.length - 24, 23), 24)
    expect(screen.split('\n')).toHaveLength(24)
    expect(looksLikeChoicePrompt(screen)).toBe(false)
  })
})
