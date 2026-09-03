import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import { render } from 'ink'
import React from 'react'

import { gesturesFrom } from '../flow/parse.mjs'
import { FlowPanel } from './flow.mjs'

/** Renders a panel to a string, so what the screen actually shows can be asserted on. */
function draw(element) {
  const stdout = new PassThrough()
  stdout.columns = 100
  let output = ''
  stdout.on('data', (chunk) => {
    output += String(chunk)
  })
  const instance = render(element, { stdout, patchConsole: false })
  instance.unmount()
  // Strip ANSI so assertions read as plain text.
  return output.replace(/\[[0-9;]*m/g, '')
}

const panel = (gestures, overrides = {}) =>
  draw(
    React.createElement(FlowPanel, {
      gestures,
      cursor: 0,
      expanded: new Set(),
      focused: true,
      filter: '',
      pinned: null,
      height: 20,
      ...overrides,
    }),
  )

test('an empty flow explains itself instead of showing a blank box', () => {
  const output = panel([])
  assert.match(output, /FLUXO/)
  assert.match(output, /nada ainda/)
})

test('a gesture whose frame died on the queue is drawn as incomplete, and opened', () => {
  // The whole reason this panel is not a tail: the interesting failure is a MISSING record, and
  // scrolling a log can never show one.
  const gestures = gesturesFrom(
    [
      JSON.stringify({ ts: 10, corr: 'g_1', target: 'alethe.ipc', command: 'sync_send' }),
      JSON.stringify({
        ts: 20,
        corr: 'g_1',
        target: 'sync.rendezvous',
        attempted: 'enqueue',
        outcome: 'deferred',
        because: 'queued_for_connection_task',
        rule: 'rendezvous.send.local_queue',
        kind: 'chat',
      }),
    ].join('\n'),
  )
  const output = panel(gestures)
  assert.match(output, /g_1/)
  assert.match(output, /INCOMPLETO/)
  // A notable gesture opens on its own, so the reason is readable without a keystroke.
  assert.match(output, /sem `transmit`/)
  assert.match(output, /rendezvous\.send\.local_queue/)
  // Evidence is shown, and bookkeeping fields are not repeated as evidence.
  assert.match(output, /kind=chat/)
  assert.doesNotMatch(output, /ts=20/)
})

test('a complete gesture stays collapsed and is not flagged', () => {
  const gestures = gesturesFrom(
    [
      JSON.stringify({
        ts: 10,
        corr: 'g_2',
        target: 'sync.rendezvous',
        attempted: 'enqueue',
        outcome: 'deferred',
      }),
      JSON.stringify({
        ts: 30,
        corr: 'g_2',
        target: 'sync.rendezvous',
        attempted: 'transmit',
        outcome: 'ok',
      }),
    ].join('\n'),
  )
  const output = panel(gestures)
  assert.match(output, /g_2/)
  assert.doesNotMatch(output, /INCOMPLETO/)
  assert.match(output, /2 passos/)
})

test('a pinned correlation and an active filter are visible in the header', () => {
  const output = panel([], { pinned: 'g_7', filter: 'taskkill' })
  assert.match(output, /corr:g_7/)
  assert.match(output, /\/taskkill/)
})
