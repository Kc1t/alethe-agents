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
function clock(ms) {
  if (ms === null) return '        '
  const at = new Date(ms)
  const pad2 = (value) => String(value).padStart(2, '0')
  return `${pad2(at.getHours())}:${pad2(at.getMinutes())}:${pad2(at.getSeconds())}`
}

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
      // Wall-clock time, because "when did this happen?" is the first question asked of any entry
      // here and a duration alone cannot answer it.
      h(Text, { color: 'gray', dimColor: true }, `${clock(gesture.startedAt)}  `),
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
/** Rows one gesture will occupy, so the viewport can fit whole entries rather than clipping one. */
function gestureHeight(gesture, isExpanded) {
  if (!isExpanded) return 1
  const stepRows = gesture.records.reduce(
    (total, record) => total + 1 + (record.rule ? 1 : 0) + (evidenceOf(record) ? 1 : 0),
    0,
  )
  return 1 + stepRows + gesture.missing.length
}

export function FlowPanel({
  gestures,
  cursor,
  expanded,
  focused,
  filter,
  pinned,
  height,
  onlyProblems,
}) {
  const rows = Math.max(3, height)
  const isExpanded = (gesture, index) =>
    expanded.has(gesture.corr ?? '') || (index === cursor && gesture.notable)

  // A window that follows the cursor. Slicing from zero meant arrowing past the last visible row
  // moved a selection nobody could see — the list looked frozen while the cursor kept going.
  let start = 0
  let used = 0
  for (let index = 0; index <= cursor && index < gestures.length; index += 1) {
    used += gestureHeight(gestures[index], isExpanded(gestures[index], index))
    while (used > rows && start < index) {
      used -= gestureHeight(gestures[start], isExpanded(gestures[start], start))
      start += 1
    }
  }

  const visible = []
  let budget = rows
  for (let index = start; index < gestures.length; index += 1) {
    const cost = gestureHeight(gestures[index], isExpanded(gestures[index], index))
    if (visible.length > 0 && cost > budget) break
    visible.push({ gesture: gestures[index], index })
    budget -= cost
  }

  const failing = gestures.filter(
    (gesture) => gesture.missing.length > 0 || gesture.worstOutcome === 'failed',
  ).length
  const hiddenBefore = start
  const hiddenAfter = gestures.length - (start + visible.length)

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
      // The count that matters is not how many gestures there are, it is how many went wrong.
      failing > 0 ? h(Text, { color: 'red' }, `  ${failing} com problema`) : null,
      onlyProblems ? h(Text, { color: 'red' }, '  ⚠ só problemas') : null,
      pinned ? h(Text, { color: 'cyan' }, `  ⚲ ${pinned}`) : null,
      filter ? h(Text, { color: 'yellow' }, `  /${filter}`) : null,
      hiddenBefore > 0 ? h(Text, { color: 'gray', dimColor: true }, `  ↑${hiddenBefore}`) : null,
      hiddenAfter > 0 ? h(Text, { color: 'gray', dimColor: true }, `  ↓${hiddenAfter}`) : null,
    ),
    visible.length === 0
      ? h(
          Text,
          { color: 'gray', dimColor: true },
          'nada ainda — inicie dev (debug) e use o app, ou tecle d para o doctor',
        )
      : visible.map(({ gesture, index }) =>
          h(Gesture, {
            key: gesture.corr ?? `loose-${index}`,
            gesture,
            selected: index === cursor,
            expanded: isExpanded(gesture, index),
          }),
        ),
  )
}
