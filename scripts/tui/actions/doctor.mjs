/**
 * Asks a running Alethe to diagnose itself.
 *
 * The checks live in Rust (`src-tauri/src/self_test.rs`) because they need the credential store,
 * the profile's data root and the relay identity — none of which this process has. So the screen
 * does not reimplement them: it asks whichever runtime is up, over the same Core API the Web client
 * uses.
 *
 * That also means the honest answer when nothing is running is "no runtime to ask", not a green
 * report assembled from what a script happened to be able to see. A doctor that quietly narrows its
 * own scope is the failure mode this whole project has been removing.
 */
import { CORE_URL } from '../../web-launcher-lib.mjs'

/**
 * A short-lived local session token.
 *
 * The Core authenticates every route except health, runtime and this one, so the diagnosis is not
 * readable by anything that merely reached the port — the report names device ids and the relay
 * endpoint, which is not something to hand out for free.
 */
async function sessionToken(signal) {
  const response = await fetch(`${CORE_URL}/api/session`, { signal })
  if (!response.ok) throw new Error(`sessão recusada (${response.status})`)
  const body = await response.json()
  const token = body?.token
  if (typeof token !== 'string' || token === '') throw new Error('a sessão veio sem token')
  return token
}

/** Runs the checks against a live runtime. Never throws for a failing check — only for no runtime. */
export async function runDoctor({ timeoutMs = 30_000 } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const token = await sessionToken(controller.signal)
    const response = await fetch(`${CORE_URL}/api/self-test`, {
      signal: controller.signal,
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!response.ok) {
      return { reachable: true, checks: [], error: `o core respondeu ${response.status}` }
    }
    return { reachable: true, checks: await response.json(), error: null }
  } catch (cause) {
    // Distinguishes "nothing is listening" from "it answered badly": the first means start the app,
    // the second means something is wrong with the app that is running.
    return {
      reachable: false,
      checks: [],
      error:
        cause?.name === 'AbortError'
          ? 'o core não respondeu dentro do prazo'
          : `nenhum Alethe respondendo em ${CORE_URL} — inicie \`dev\` ou \`web\` primeiro`,
    }
  } finally {
    clearTimeout(timer)
  }
}

/** Condenses a report into the one line the screen shows. */
export function summarize(report) {
  if (!report.reachable) return report.error
  if (report.error) return report.error
  const failed = report.checks.filter((check) => check.outcome === 'failed')
  const skipped = report.checks.filter((check) => check.outcome === 'skipped')
  if (failed.length === 0) {
    return `doctor: ${report.checks.length} checagens, nenhuma falha`
  }
  // The first failure is the one that matters: the checks run in dependency order, so everything
  // after it is either caused by it or was skipped because of it.
  const first = failed[0]
  const tail = skipped.length > 0 ? ` (+${skipped.length} não executadas)` : ''
  return `doctor: ${first.title} — ${first.because}${tail}`
}
