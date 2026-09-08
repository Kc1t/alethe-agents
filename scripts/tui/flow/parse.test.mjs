import assert from 'node:assert/strict'
import test from 'node:test'

import {
  filterGestures,
  gesturesFrom,
  groupByCorrelation,
  missingPairs,
  parseLine,
  parseLines,
  worstOutcome,
} from './parse.mjs'

const record = (fields) => ({ ts: 1000, target: 'sync.rendezvous', ...fields })
const line = (fields) => JSON.stringify(record(fields))

test('parseLine ignores blank and unreadable lines', () => {
  assert.equal(parseLine(''), null)
  assert.equal(parseLine('   '), null)
  // The file is appended to while it is read, so the last line can be half-written.
  assert.equal(parseLine('{"target":"sync.chat","attem'), null)
  assert.equal(parseLine('not json at all'), null)
})

test('parseLine rejects JSON that is not a record', () => {
  assert.equal(parseLine('42'), null)
  assert.equal(parseLine('null'), null)
  assert.equal(parseLine('["target"]'), null)
  // No target means it did not come from the decision stream.
  assert.equal(parseLine('{"level":"warn"}'), null)
})

test('parseLines keeps the readable lines and drops the rest', () => {
  const text = [line({ attempted: 'a' }), 'garbage', '', line({ attempted: 'b' })].join('\n')
  assert.deepEqual(
    parseLines(text).map((entry) => entry.attempted),
    ['a', 'b'],
  )
})

test('worstOutcome ranks failure above everything else', () => {
  assert.equal(worstOutcome([record({ outcome: 'ok' }), record({ outcome: 'failed' })]), 'failed')
  assert.equal(
    worstOutcome([record({ outcome: 'ok' }), record({ outcome: 'deferred' })]),
    'deferred',
  )
  assert.equal(
    worstOutcome([record({ outcome: 'rejected' }), record({ outcome: 'ok' })]),
    'rejected',
  )
  assert.equal(worstOutcome([record({ outcome: 'skipped' })]), 'skipped')
  // A note carries no outcome at all; it must not be mistaken for a verdict.
  assert.equal(worstOutcome([record({ message: 'hello' })]), null)
})

test('an enqueue with no transmit is reported as a missing pair', () => {
  // The case this whole panel exists for: `send_at` returns success after a LOCAL enqueue, and the
  // socket write happens later. The enqueue alone is the evidence the frame never left.
  const gaps = missingPairs([record({ attempted: 'enqueue', outcome: 'deferred' })])
  assert.equal(gaps.length, 1)
  assert.equal(gaps[0].unclosed, 1)
  assert.match(gaps[0].missing, /fila local/)
})

test('an enqueue followed by a transmit is complete', () => {
  const gaps = missingPairs([
    record({ attempted: 'enqueue', outcome: 'deferred' }),
    record({ attempted: 'transmit', outcome: 'ok' }),
  ])
  assert.deepEqual(gaps, [])
})

test('two enqueues with one transmit is still a lost frame', () => {
  // A presence check would call this complete; counting is what catches it.
  const gaps = missingPairs([
    record({ attempted: 'enqueue' }),
    record({ attempted: 'enqueue' }),
    record({ attempted: 'transmit' }),
  ])
  assert.equal(gaps.length, 1)
  assert.equal(gaps[0].unclosed, 1)
})

test('a transmit belonging to another subsystem does not close the pair', () => {
  const gaps = missingPairs([
    record({ attempted: 'enqueue' }),
    { ts: 1000, target: 'sync.chat', attempted: 'transmit' },
  ])
  assert.equal(gaps.length, 1)
})

test('groups records by correlation id, newest gesture first', () => {
  const gestures = groupByCorrelation([
    record({ ts: 100, corr: 'old', attempted: 'enqueue' }),
    record({ ts: 100, corr: 'old', attempted: 'transmit' }),
    record({ ts: 900, corr: 'new', attempted: 'enqueue' }),
    record({ ts: 950, corr: 'new', attempted: 'transmit' }),
  ])
  assert.deepEqual(
    gestures.map((gesture) => gesture.corr),
    ['new', 'old'],
  )
  assert.equal(gestures[0].durationMs, 50)
  assert.equal(gestures[0].records.length, 2)
})

test('records with no correlation are kept, not dropped', () => {
  // They are real decisions that happened outside a correlated gesture — a background poller, a
  // startup step. Dropping them would rebuild exactly the blind spot this work removed.
  const gestures = groupByCorrelation([
    record({ attempted: 'connect', outcome: 'failed' }),
    record({ corr: 'g_1', attempted: 'enqueue' }),
  ])
  const loose = gestures.find((gesture) => gesture.uncorrelated)
  assert.ok(loose, 'uncorrelated records have a home')
  assert.equal(loose.records.length, 1)
  assert.equal(loose.corr, null)
})

test('a gesture is notable when a step failed or a pair is missing', () => {
  const [failed] = groupByCorrelation([record({ corr: 'a', attempted: 'x', outcome: 'failed' })])
  assert.equal(failed.notable, true)

  const [incomplete] = groupByCorrelation([
    record({ corr: 'b', attempted: 'enqueue', outcome: 'deferred' }),
  ])
  assert.equal(incomplete.notable, true, 'a missing transmit is notable even though nothing failed')

  const [clean] = groupByCorrelation([
    record({ corr: 'c', attempted: 'enqueue', outcome: 'deferred' }),
    record({ corr: 'c', attempted: 'transmit', outcome: 'ok' }),
  ])
  assert.equal(clean.notable, false)
})

test('gesturesFrom reads raw log text end to end', () => {
  const text = [
    JSON.stringify({ ts: 10, target: 'alethe.ipc', corr: 'g_1', command: 'sync_send' }),
    'a torn line',
    JSON.stringify({
      ts: 20,
      target: 'sync.rendezvous',
      corr: 'g_1',
      attempted: 'enqueue',
      outcome: 'deferred',
      because: 'queued_for_connection_task',
      rule: 'rendezvous.send.local_queue',
    }),
  ].join('\n')
  const [gesture] = gesturesFrom(text)
  assert.equal(gesture.corr, 'g_1')
  assert.equal(gesture.records.length, 2)
  assert.equal(gesture.missing.length, 1)
  assert.equal(gesture.durationMs, 10)
})

test('filtering searches the fields someone would actually type', () => {
  const gestures = gesturesFrom(
    [
      JSON.stringify({
        ts: 1,
        corr: 'g_chat',
        target: 'sync.chat',
        attempted: 'ingest_frame',
        because: 'conversation_mismatch',
        rule: 'chat.ingest.conversation_must_match',
      }),
      JSON.stringify({ ts: 2, corr: 'g_pty', target: 'pty.kill', attempted: 'taskkill_tree' }),
    ].join('\n'),
  )
  assert.equal(filterGestures(gestures, '').length, 2)
  assert.deepEqual(
    filterGestures(gestures, 'taskkill').map((gesture) => gesture.corr),
    ['g_pty'],
  )
  assert.deepEqual(
    filterGestures(gestures, 'conversation_must_match').map((gesture) => gesture.corr),
    ['g_chat'],
  )
  // The correlation id itself is searchable, which is how `c` (pin a corr) is implemented.
  assert.deepEqual(
    filterGestures(gestures, 'g_chat').map((gesture) => gesture.corr),
    ['g_chat'],
  )
  assert.equal(filterGestures(gestures, 'nothing matches this').length, 0)
})
