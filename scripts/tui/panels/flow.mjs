import { Box, Text } from 'ink'
import React from 'react'

const h = React.createElement

/** Colour per verdict. Failure is the only one that shouts. */
const OUTCOME_COLOR = {
  failed: 'red',
  rejected: 'yellow',
  deferred: 'yellow',
  ok: 'green',
  skipped: 'gray',
}

function pad(value, width) {
  const text = String(value ?? '')
  return text.length >= width ? text.slice(0, width) : text + ' '.repeat(width - text.length)
}

/** The evidence fields, minus the bookkeeping every record carries. */
const BOOKKEEPING = new Set([
  'ts',
  'level',
  'target',
  'line',
  'file',
  'corr',
  'attempted',
  'outcome',
  'because',
  'rule',
])

function evidenceOf(record) {
  return Object.entries(record)
    .filter(([key]) => !BOOKKEEPING.has(key))
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join(' ')
}

function Step({ record }) {
  const outcome = record.outcome ?? ''
  const color = OUTCOME_COLOR[outcome] ?? 'gray'
  return h(
    Box,
    { flexDirection: 'column' },
    h(
      Box,
      null,
      h(Text, { color }, `  ${pad(outcome || '·', 9)}`),
      h(Text, { color: 'cyan' }, pad(record.target, 22)),
      h(Text, null, record.attempted ?? record.message ?? record.command ?? ''),
    ),
    record.rule
      ? h(
          Box,
          null,
          h(Text, { color: 'gray' }, `            rule: ${record.rule}`),
          record.because ? h(Text, { color: 'gray' }, `  → ${record.because}`) : null,
        )
      : null,
    evidenceOf(record)
      ? h(Text, { color: 'gray', dimColor: true }, `            ${evidenceOf(record)}`)
      : null,
  )
}

/**
 * One user gesture, as a timeline.
 *
 * Collapsed by default so the panel stays a list; a gesture that failed or is missing a step opens
 * on its own, because those are the ones the panel exists to surface.
 */
function Gesture({ gesture, expanded, selected }) {
  const incomplete = gesture.missing.length > 0
  const headline = gesture.uncorrelated ? '(sem correlação)' : gesture.corr
  const color = incomplete ? 'red' : (OUTCOME_COLOR[gesture.worstOutcome] ?? 'white')
  const duration = gesture.durationMs === null ? '' : `${(gesture.durationMs / 1000).toFixed(1)}s`
  const summary = incomplete
    ? '⚠ INCOMPLETO'
    : `${gesture.records.length} passo${gesture.records.length === 1 ? '' : 's'}`

  return h(
    Box,
    { flexDirection: 'column' },
    h(
      Box,
      null,
      // `▾`/`▸` rather than `▼`/`▶`: the latter pair reports different display widths
      // (one is East-Asian wide), which shifted every collapsed row one column right.
      h(Text, { inverse: selected }, expanded ? ' ▾ ' : ' ▸ '),
      h(Text, { color, bold: incomplete, inverse: selected }, pad(headline, 28)),
      h(Text, { color: 'gray' }, pad(duration, 7)),
      h(Text, { color }, summary),
    ),
    expanded ? gesture.records.map((record, index) => h(Step, { key: index, record })) : null,
    expanded
      ? gesture.missing.map((gap, index) =>
          h(Text, { key: `gap-${index}`, color: 'red' }, `  ✗ ${gap.missing}`),
        )
      : null,
  )
}

/**
 * The flow panel: the decision stream, grouped into gestures.
 *
 * This is not a tail. A tail leaves the reader to notice what is *missing*, and the failures worth
 * catching here are exactly the ones with a hole in the middle — a frame handed to a queue that no
 * socket ever wrote. Grouping by correlation id is what makes that hole visible.
 */
export function FlowPanel({ gestures, cursor, expanded, focused, filter, pinned, height }) {
  const rows = Math.max(3, height)
  const visible = gestures.slice(0, rows)

  return h(
    Box,
    {
      flexDirection: 'column',
      borderStyle: 'round',
      borderColor: focused ? 'cyan' : 'gray',
      paddingX: 1,
      flexGrow: 1,
    },
    h(
      Box,
      null,
      h(Text, { bold: true }, 'FLUXO'),
      pinned ? h(Text, { color: 'cyan' }, `  corr:${pinned}`) : null,
      filter ? h(Text, { color: 'yellow' }, `  /${filter}`) : null,
      h(Text, { color: 'gray' }, `  ${gestures.length} gesto${gestures.length === 1 ? '' : 's'}`),
    ),
    visible.length === 0
      ? h(
          Text,
          { color: 'gray' },
          'nada ainda — inicie `dev (debug)` e use o app; os registros aparecem aqui',
        )
      : visible.map((gesture, index) =>
          h(Gesture, {
            key: gesture.corr ?? `loose-${index}`,
            gesture,
            selected: index === cursor,
            expanded: expanded.has(gesture.corr ?? '') || (index === cursor && gesture.notable),
          }),
        ),
  )
}
