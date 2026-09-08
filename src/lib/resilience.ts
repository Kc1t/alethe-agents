import { currentCorrelation } from './correlation'

/**
 * The two ways a frontend call is allowed to fail quietly.
 *
 * The problem these replace is not a missing convention — `transport.ts` and `syncChat.ts` already
 * log every failure they see. The damage comes one frame up the stack, where a caller wraps those
 * well-logged calls in `.catch(() => [])`: the line the transport worked to emit is never
 * correlated with the empty list the user is looking at, and "the request failed" arrives on screen
 * as "there is nothing here". A user genuinely with nothing sees exactly the same thing, so the
 * wrong answer is not merely wrong — it is unfalsifiable.
 *
 * After a site has been reviewed it ends as one of these, never as a bare `.catch(() => …)`:
 *
 * - `orEmpty` — the failure matters. The fallback is still returned so the UI keeps working, but
 *   the failure is recorded against the gesture that caused it.
 * - `ignoreExpected` — the failure is routine and named. Nothing is recorded in normal operation;
 *   the value is that the code now says *which* expected failure it is, so the next reader does
 *   not have to guess whether anyone ever thought about it.
 */

/**
 * Awaits `promise`, returning `fallback` if it rejects — and saying so.
 *
 * `context` should name the call, not describe the error: `'sessions.list'`, not
 * `'could not load sessions'`. It is what makes the record greppable next to the Rust ones.
 */
export async function orEmpty<T>(promise: Promise<T>, context: string, fallback: T): Promise<T> {
  try {
    return await promise
  } catch (cause) {
    const corr = currentCorrelation()
    console.warn(
      `[fallback] ${context} failed; using the empty result${corr ? ` corr=${corr}` : ''}`,
      cause,
    )
    return fallback
  }
}

/** `orEmpty` for the very common "a list that becomes empty" case. */
export async function orEmptyList<T>(promise: Promise<T[]>, context: string): Promise<T[]> {
  return orEmpty(promise, context, [] as T[])
}

/** `orEmpty` for the "a value that becomes absent" case. */
export async function orNull<T>(promise: Promise<T | null>, context: string): Promise<T | null> {
  return orEmpty<T | null>(promise, context, null)
}

/**
 * Awaits `promise` and swallows a rejection that is expected here.
 *
 * `reason` names the expected failure — `'clipboard_denied'`, `'pty_already_gone'` — and exists to
 * document the decision in the code. Nothing is recorded unless verbose tracing is on, because the
 * whole point is that this failure is not news.
 */
export async function ignoreExpected(promise: Promise<unknown>, reason: string): Promise<void> {
  try {
    await promise
  } catch (cause) {
    console.debug(`[expected] ${reason}`, cause)
  }
}

/**
 * A `.catch` handler that returns a fallback and records the failure.
 *
 * Drop-in for `.catch(() => [])`, keeping the call shape while making the failure visible:
 * `.catch(withFallback('sessions.list', []))`.
 */
export function withFallback<T>(context: string, value: T) {
  return (cause: unknown): T => {
    const corr = currentCorrelation()
    console.warn(
      `[fallback] ${context} failed; using the empty result${corr ? ` corr=${corr}` : ''}`,
      cause,
    )
    return value
  }
}

/**
 * A `.catch` handler for a failure that is routine and named.
 *
 * Drop-in for `.catch(() => {})`: `.catch(expected('pty_already_gone'))`. Records nothing in normal
 * operation — the value is that the code now states *which* expected failure this is, so the next
 * reader does not have to work out whether anyone ever considered it.
 */
export function expected(reason: string) {
  return (cause: unknown): void => {
    console.debug(`[expected] ${reason}`, cause)
  }
}
