/**
 * Correlation ids: the key that makes the frontend and the backend one timeline.
 *
 * A user gesture — sending a message, spawning an agent — fans out into console lines here and
 * decision records in Rust. Without a shared key those are two piles of lines in two files written
 * by two processes with two clocks, and lining them up means guessing from timestamps. With one,
 * `grep '"corr":"g_l8x2f_4"' alethe.jsonl` returns the whole story of a single click, in order.
 *
 * The id is minted at the gesture, not at the call, so everything the gesture causes — including
 * work that happens several awaits later — carries the same id.
 */

let counter = 0
let current: string | null = null

/** Mints a new correlation id. Short and sortable rather than random, so a raw log stays readable. */
export function newCorrelationId(label = 'g'): string {
  counter += 1
  return `${label}_${Date.now().toString(36)}_${counter}`
}

/** The correlation id in effect right now, if any. */
export function currentCorrelation(): string | null {
  return current
}

/**
 * Runs `body` with a correlation id in effect, and returns what it returns.
 *
 * The id stays in effect for the synchronous part of `body` and for anything it awaits, because it
 * is restored only after the returned promise settles. That is a deliberately simple model: with a
 * single UI thread and gestures that do not interleave, it is enough, and it avoids pulling in
 * async context tracking the browser does not offer.
 */
export async function withCorrelation<T>(
  label: string,
  body: (corr: string) => Promise<T> | T,
): Promise<T> {
  const previous = current
  const corr = newCorrelationId(label)
  current = corr
  try {
    return await body(corr)
  } finally {
    current = previous
  }
}

/** For tests and for the rare caller that needs to pin an id it received from elsewhere. */
export function setCurrentCorrelation(corr: string | null): void {
  current = corr
}
