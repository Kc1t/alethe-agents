import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import { Box, render } from 'ink'
import React from 'react'

import { COMMANDS } from '../actions/processes.mjs'
import { CommandsPanel, commandsPanelHeight } from './commands.mjs'

/** Renders the rail inside a box of `height` rows, the way the app constrains it. */
function draw(height, props = {}) {
  const stdout = new PassThrough()
  stdout.columns = 90
  let output = ''
  stdout.on('data', (chunk) => {
    output += String(chunk)
  })
  const instance = render(
    React.createElement(
      Box,
      { height, width: 90 },
      React.createElement(CommandsPanel, {
        commands: COMMANDS,
        cursor: 0,
        running: new Map(),
        focused: true,
        ...props,
      }),
    ),
    { stdout, patchConsole: false },
  )
  instance.unmount()
  return output.replace(/\[[0-9;]*m/g, '')
}

/** The command label a rendered row carries, or null for a row that carries none. */
function labelOf(row) {
  const inner = row.replace(/[│╭╮╰╯─]/g, '').trim()
  const withoutCursor = inner.replace(/^▌\s*/, '').trim()
  const withoutDot = withoutCursor.replace(/\s*[●○]$/, '').trim()
  return withoutDot === '' ? null : withoutDot
}

test('every command gets its own line at the height the app gives the panel', () => {
  // A Box too small for its children does not clip a row cleanly — it draws them on top of each
  // other, and a command then looks like it simply is not there. Caught by eye, so it gets a test:
  // `dev (debug)` and `web` had merged into one unreadable line.
  const height = commandsPanelHeight(COMMANDS)
  const labels = draw(height).split('\n').map(labelOf)
  for (const command of COMMANDS) {
    const matches = labels.filter((label) => label === command.label)
    assert.equal(matches.length, 1, `"${command.label}" occupies exactly one line`)
  }
})

test('one row less is enough to merge two commands, which is why the height is not guessed', () => {
  // Proof the guard above has teeth. At one row under what the panel needs, ink draws rows on top
  // of each other: `dev (debug)` and `web` become `web (debug)`. That is exactly what the layout
  // produced while it computed the height itself, and why `commandsPanelHeight` is now the single
  // place that decides it.
  const labels = draw(commandsPanelHeight(COMMANDS) - 1)
    .split('\n')
    .map(labelOf)
    .filter(Boolean)
  const present = COMMANDS.filter((command) => labels.includes(command.label))
  assert.ok(
    present.length < COMMANDS.length,
    'a panel one row short loses at least one command, so the test above is meaningful',
  )
})
