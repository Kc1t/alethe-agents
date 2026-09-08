import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import { render } from 'ink'
import React from 'react'

import { Header } from './header.mjs'

function draw(props) {
  const stdout = new PassThrough()
  stdout.columns = props.width
  let output = ''
  stdout.on('data', (chunk) => {
    output += String(chunk)
  })
  const instance = render(React.createElement(Header, props), { stdout, patchConsole: false })
  instance.unmount()
  return output.replace(/\[[0-9;]*m/g, '')
}

test('a wide terminal gets the centred wordmark', () => {
  const output = draw({ width: 100, branch: 'main', subtitle: '2 no fluxo' })
  const rows = output.split('\n')
  const logoRow = rows.find((row) => row.includes('█'))
  assert.ok(logoRow, 'the wordmark is drawn')
  // Centred: the padding before it is about half the space left over.
  const indent = logoRow.length - logoRow.trimStart().length
  const drawn = logoRow.trim().length
  assert.ok(Math.abs(indent - (100 - drawn) / 2) <= 1, `wordmark is centred (indent ${indent})`)
  assert.match(output, /main/)
  assert.match(output, /2 no fluxo/)
})

test('a narrow terminal falls back to plain text rather than wrapping into rubble', () => {
  const output = draw({ width: 30, branch: 'main', subtitle: '' })
  assert.doesNotMatch(output, /█/)
  assert.match(output, /alethe/)
})

test('no branch and no subtitle still renders a header', () => {
  const output = draw({ width: 100, branch: null, subtitle: '' })
  assert.ok(output.includes('█'), 'the wordmark does not depend on having context to show')
})
