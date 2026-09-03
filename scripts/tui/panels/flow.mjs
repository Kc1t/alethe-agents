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

/** A short glyph per verdict, so the column stays narrow and scannable. */
const OUTCOME_MARK = {
  failed: '✗',
  rejected: '!',
  deferred: '·',
  ok: '✓',
  skipped: '–',
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

/**
 * A name for a gesture that carried no correlation id.
 *
 * "(sem correlação)" is technically true and tells the reader nothing — the seven doctor checks
 * appeared under it as one anonymous blob. The subsystem the records came from is what someone
 * actually wants to read in the list.
 */
function looseLabel(records) {
  const counts = new Map()
  for (const record of records) {
    counts.set(record.target, (counts.get(record.target) ?? 0) + 1)
  }
  const [top] = [...counts.entries()].sort((a, b) => b[1] - a[1])
  if (!top) return 'sem correlação'
  return counts.size === 1 ? top[0] : `${top[0]} +${counts.size - 1}`
}

function Step({ record }) {
  const outcome = record.outcome ?? ''
  const color = OUTCOME_COLOR[outcome] ?? 'gray'
  const quiet = outcome === 'ok' || outcome === 'skipped'
  const evidence = evidenceOf(record)
  return h(
    Box,
    { flexDirection: 'column' },
    h(
      Box,
      null,
      h(Text, { color, dimColor: quiet }, `    ${OUTCOME_MARK[outcome] ?? '·'} `),
      h(Text, { color: 'cyan', dimColor: true }, pad(record.target, 20)),
      h(Text, null, record.attempted ?? record.message ?? record.command ?? ''),
      record.because ? h(Text, { color: 'gray' }, `  ${record.because}`) : null,
    ),
    record.rule ? h(Text, { color: 'gray', dimColor: true }, `      ${record.rule}`) : null,
    evidence ? h(Text, { color: 'gray', dimColor: true }, `      ${evidence}`) : null,
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
  const headline = gesture.uncorrelated ? looseLabel(gesture.records) : gesture.corr
  const color = incomplete ? 'red' : (OUTCOME_COLOR[gesture.worstOutcome] ?? 'white')
  const duration = gesture.durationMs === null ? '' : `${(gesture.durationMs / 1000).toFixed(1)}s`
  const summary = incomplete
    ? 'incompleto'
    : `${gesture.records.length} passo${gesture.records.length === 1 ? '' : 's'}`

  return h(
    Box,
    { flexDirection: 'column' },
    h(
      Box,
      null,
      // A thin bar plus bold text, rather than an inverted block. Inverting a padded 30-column
      // string painted a solid slab across the panel, pulling the eye away from the verdict it was
      // supposed to be pointing at.
      h(Text, { color: 'cyan' }, selected ? '▌' : ' '),
      h(Text, { color: 'gray', dimColor: true }, expanded ? '▾ ' : '▸ '),
      h(Text, { color, bold: selected || incomplete }, pad(headline, 30)),
      h(Text, { color: 'gray', dimColor: true }, pad(duration, 7)),
      h(Text, { color, dimColor: !incomplete }, summary),
    ),
    expanded ? gesture.records.map((record, index) => h(Step, { key: index, record })) : null,
    expanded
      ? gesture.missing.map((gap, index) =>
          h(Text, { key: `gap-${index}`, color: 'red' }, `    ✗ ${gap.missing}`),
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
      overflow: 'hidden',
    },
    h(
      Box,
      null,
      h(Text, { bold: focused, color: focused ? 'cyan' : 'white' }, 'FLUXO'),
      h(Text, { color: 'gray', dimColor: true }, `  ${gestures.length}`),
      pinned ? h(Text, { color: 'cyan' }, `  ⚲ ${pinned}`) : null,
      filter ? h(Text, { color: 'yellow' }, `  /${filter}`) : null,
    ),
    visible.length === 0
      ? h(
          Text,
          { color: 'gray', dimColor: true },
          'nada ainda — inicie dev (debug) e use o app, ou tecle d para o doctor',
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
