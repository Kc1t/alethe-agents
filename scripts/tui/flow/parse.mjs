/**
 * Turns `alethe.jsonl` into gestures.
 *
 * The log is a flat stream of decision records, one JSON object per line. On its own that is a
 * tail: readable, but it still leaves the reader to notice what is *missing*. The whole point of
 * giving every record a correlation id was that a single user action becomes one sequence, and the
 * interesting failures are the ones with a hole in the middle — a frame handed to a queue that no
 * socket ever wrote.
 *
 * So this groups records by `corr` and then checks each gesture against a small table of steps that
 * come in pairs. An opener with no closer is reported explicitly, because the absence of a record
 * is exactly the evidence that is impossible to see by scrolling.
 *
 * Deliberately free of any UI: this is the part with a real chance of being wrong, and keeping it
 * as a pure function over lines is what makes it testable without starting a screen.
 */

/** Severity order, worst last. Mirrors `Outcome` in `src-tauri/src/obs.rs`. */
const OUTCOME_RANK = { skipped: 0, ok: 1, deferred: 2, rejected: 3, failed: 4 }

/**
 * Steps that only make sense in pairs. An `opens` record whose gesture has no matching `closes`
 * means the work stopped between them.
 *
 * `sync.rendezvous` is the case this was built for: `send_at` hands a frame to a local channel and
 * returns success, and the socket write happens later in the connection task. Those two records
 * sharing a correlation id is the proof the frame left the machine; the enqueue alone is the proof
 * it did not.
 */
export const PAIRED_STEPS = [
  {
    target: 'sync.rendezvous',
    opens: 'enqueue',
    closes: 'transmit',
    missing: 'sem `transmit`: o frame morreu na fila local, nada foi escrito no socket',
  },
]

/**
 * Parses one line. Returns `null` for anything that is not a usable record, which includes blank
 * lines and partial writes — the file is appended to live, so the last line can be half-written
 * when it is read.
 */
export function parseLine(line) {
  const trimmed = line.trim()
  if (trimmed === '') return null
  let record
  try {
    record = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return null
  if (typeof record.target !== 'string') return null
  return record
}

/** Parses a whole chunk of the file, skipping what cannot be read. */
export function parseLines(text) {
  return text
    .split('\n')
    .map(parseLine)
    .filter((record) => record !== null)
}

/** The worst outcome among a gesture's records, which decides its colour and whether it opens. */
export function worstOutcome(records) {
  let worst = null
  for (const record of records) {
    const rank = OUTCOME_RANK[record.outcome]
    if (rank === undefined) continue
    if (worst === null || rank > OUTCOME_RANK[worst]) worst = record.outcome
  }
  return worst
}

/** Openers in `records` that never got their closing step. */
export function missingPairs(records) {
  const gaps = []
  for (const rule of PAIRED_STEPS) {
    const opened = records.filter(
      (record) => record.target === rule.target && record.attempted === rule.opens,
    )
    if (opened.length === 0) continue
    const closed = records.filter(
      (record) => record.target === rule.target && record.attempted === rule.closes,
    )
    // Counting rather than merely checking presence: two sends in one gesture with one transmit is
    // still a lost frame, and a presence check would call that complete.
    const unclosed = opened.length - closed.length
    if (unclosed > 0) {
      gaps.push({ ...rule, unclosed })
    }
  }
  return gaps
}

/**
 * Groups records into gestures, newest first.
 *
 * Records with no `corr` are not dropped — they are real decisions that simply happened outside a
 * correlated gesture (a background poller, a startup step), and dropping them would rebuild the
 * blind spot this whole effort removed. They are grouped under a single synthetic gesture instead.
 */
export function groupByCorrelation(records) {
  const byCorrelation = new Map()
  for (const record of records) {
    const key = typeof record.corr === 'string' && record.corr !== '' ? record.corr : null
    const bucket = byCorrelation.get(key)
    if (bucket) bucket.push(record)
    else byCorrelation.set(key, [record])
  }

  const gestures = []
  for (const [corr, items] of byCorrelation) {
    const times = items.map((record) => record.ts).filter((ts) => typeof ts === 'number')
    const startedAt = times.length > 0 ? Math.min(...times) : null
    const endedAt = times.length > 0 ? Math.max(...times) : null
    const gaps = missingPairs(items)
    const worst = worstOutcome(items)
    gestures.push({
      corr,
      /** True for the bucket holding everything that carried no correlation id. */
      uncorrelated: corr === null,
      records: items,
      startedAt,
      endedAt,
      durationMs: startedAt !== null && endedAt !== null ? endedAt - startedAt : null,
      worstOutcome: worst,
      missing: gaps,
      /** A gesture opens expanded when something went wrong or a step is missing. */
      notable: gaps.length > 0 || worst === 'failed',
    })
  }

  // Newest first: the reason to open this panel is almost always what just happened.
  gestures.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
  return gestures
}

/** Reads a chunk of log text straight into gestures. */
export function gesturesFrom(text) {
  return groupByCorrelation(parseLines(text))
}

/**
 * Keeps only gestures matching `query`, searched across the fields someone would actually type:
 * the correlation id, and each record's target, attempted step, verdict and rule.
 */
export function filterGestures(gestures, query) {
  const needle = query.trim().toLowerCase()
  if (needle === '') return gestures
  return gestures.filter((gesture) => {
    if (gesture.corr !== null && gesture.corr.toLowerCase().includes(needle)) return true
    return gesture.records.some((record) =>
      [record.target, record.attempted, record.because, record.rule, record.message]
        .filter((value) => typeof value === 'string')
        .some((value) => value.toLowerCase().includes(needle)),
    )
  })
}
