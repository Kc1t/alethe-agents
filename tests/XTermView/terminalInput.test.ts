import assert from 'node:assert/strict'
import test from 'node:test'

import {
  formatDroppedPaths,
  getTerminalScrollbackRows,
  getWheelScrollLines,
  normalizePastedText,
  shouldScrollHostScrollback,
} from '../../src/components/XTermView/terminalInput.ts'

test('normalizePastedText converts clipboard newlines to PTY carriage returns', () => {
  assert.equal(normalizePastedText('one\r\ntwo\nthree\r'), 'one\rtwo\rthree\r')
})

test('getWheelScrollLines always scrolls at least one line for pixel wheel events', () => {
  assert.equal(getWheelScrollLines({ deltaMode: 0, deltaY: 1 }, 18), 1)
  assert.equal(getWheelScrollLines({ deltaMode: 0, deltaY: -1 }, 18), -1)
})

test('getWheelScrollLines preserves larger wheel intent across delta modes', () => {
  assert.equal(getWheelScrollLines({ deltaMode: 0, deltaY: 40 }, 20), 2)
  assert.equal(getWheelScrollLines({ deltaMode: 1, deltaY: 3 }, 20), 3)
  assert.equal(getWheelScrollLines({ deltaMode: 2, deltaY: -1 }, 20), -10)
})

test('getTerminalScrollbackRows keeps enough rows for long agent chats', () => {
  assert.ok(getTerminalScrollbackRows() >= 10_000)
})

test('shouldScrollHostScrollback scrolls the host buffer in a plain shell', () => {
  assert.equal(shouldScrollHostScrollback('normal', false), true)
})

test('shouldScrollHostScrollback forwards the wheel to TUIs in the alternate buffer', () => {
  // claude/codex run in the alternate screen (no host scrollback) — let the app scroll itself.
  assert.equal(shouldScrollHostScrollback('alternate', false), false)
})

test('shouldScrollHostScrollback lets Shift+wheel force host scrollback even in the alternate buffer', () => {
  assert.equal(shouldScrollHostScrollback('alternate', true), true)
  assert.equal(shouldScrollHostScrollback('normal', true), true)
})

test('formatDroppedPaths leaves space-free paths unquoted with a trailing space', () => {
  assert.equal(formatDroppedPaths(['C:\\a\\b.txt']), 'C:\\a\\b.txt ')
})

test('formatDroppedPaths quotes paths containing whitespace', () => {
  assert.equal(formatDroppedPaths(['C:\\meu path\\f.txt']), '"C:\\meu path\\f.txt" ')
})

test('formatDroppedPaths joins multiple paths, quoting only those with spaces', () => {
  assert.equal(
    formatDroppedPaths(['C:\\a.txt', 'C:\\my dir\\b.txt']),
    'C:\\a.txt "C:\\my dir\\b.txt" ',
  )
})

test('formatDroppedPaths returns empty string when no valid paths', () => {
  assert.equal(formatDroppedPaths([]), '')
  assert.equal(formatDroppedPaths(['', '']), '')
})
