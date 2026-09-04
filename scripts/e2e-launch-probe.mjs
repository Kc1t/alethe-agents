#!/usr/bin/env node
/**
 * Can the built app start at all, under the E2E isolation environment?
 *
 * The E2E suite fails in CI with `session not created: DevToolsActivePort file doesn't exist`. That
 * message comes from the WebView2 driver and means one thing: the process it launched went away
 * before opening its DevTools port. It says nothing about *why* — and the app's own stdout and
 * stderr never reach the CI log, because the driver owns the process.
 *
 * So the failure is unfalsifiable in the way this project has spent its whole effort removing: "the
 * driver could not attach" and "the app crashed on startup" produce the identical line.
 *
 * This probe separates them. It launches the same binary with the same isolation environment the
 * suite uses, captures everything it writes, waits, and reports one of three verdicts:
 *
 *   started   — still running after the grace period; the app is fine and the problem is the driver
 *   exited    — died on its own, with the exit code and its output, which names the real cause
 *   missing   — the binary is not there, so the build step did not produce what the suite expects
 *
 * Deliberately not part of the suite: it is a precondition check, and a precondition that fails
 * should be reported as itself rather than as a mysterious test failure.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')

/**
 * The binary and environment the E2E suite launches, mirrored from `e2e/support/launch.ts`.
 *
 * Mirrored rather than imported because that file is TypeScript and this probe has to run from a
 * plain `node` with no loader — the point is to work even when the suite's tooling does not.
 * `scripts/e2e-launch-probe.test.mjs` fails if the two ever drift, because a probe that isolates
 * differently from the suite proves nothing about the suite.
 */
function prepareIsolatedLaunch(dataDir) {
  return {
    applicationPath: join(
      ROOT,
      'src-tauri',
      'target-e2e',
      'debug',
      process.platform === 'win32' ? 'alethe.exe' : 'alethe',
    ),
    dataDir,
    env: {
      ALETHE_E2E: '1',
      ALETHE_APP_DATA_DIR: dataDir,
      ...(process.platform === 'win32'
        ? { APPDATA: dataDir, LOCALAPPDATA: dataDir }
        : { HOME: dataDir, XDG_DATA_HOME: join(dataDir, '.local', 'share') }),
    },
    cleanup: () => rmSync(dataDir, { recursive: true, force: true }),
  }
}

/** How long the app gets to stay alive before it counts as having started. */
const GRACE_MS = Number(process.env.ALETHE_PROBE_GRACE_MS ?? 20_000)

function report(verdict, detail) {
  process.stdout.write(`\n[e2e-probe] ${verdict}: ${detail}\n`)
}

const launch = prepareIsolatedLaunch(mkdtempSync(join(tmpdir(), 'alethe-probe-')))

if (!existsSync(launch.applicationPath)) {
  report('missing', `${launch.applicationPath} does not exist — the build step produced nothing`)
  launch.cleanup()
  process.exit(1)
}

process.stdout.write(`[e2e-probe] launching ${launch.applicationPath}\n`)
process.stdout.write(`[e2e-probe] data dir ${launch.dataDir}\n`)

const child = spawn(launch.applicationPath, [], {
  env: { ...process.env, ...launch.env },
  stdio: ['ignore', 'pipe', 'pipe'],
})

let output = ''
const absorb = (chunk) => {
  const text = String(chunk)
  output += text
  process.stdout.write(text)
}
child.stdout.on('data', absorb)
child.stderr.on('data', absorb)

let exited = null
child.on('exit', (code, signal) => {
  exited = { code, signal }
})
child.on('error', (cause) => {
  report('missing', `could not spawn: ${cause.message}`)
  launch.cleanup()
  process.exit(1)
})

await new Promise((resolve) => setTimeout(resolve, GRACE_MS))

// The decision log, if the app got far enough to write one. It is the only place a startup failure
// after the process is alive would be recorded.
const decisionLog = join(launch.dataDir, 'logs', 'alethe.jsonl')
if (existsSync(decisionLog)) {
  process.stdout.write('\n[e2e-probe] decision records written during startup:\n')
  process.stdout.write(readFileSync(decisionLog, 'utf8'))
}

if (exited === null) {
  report('started', `still running after ${GRACE_MS}ms — the app starts, the driver is the problem`)
  child.kill()
  rmSync(launch.dataDir, { recursive: true, force: true })
  process.exit(0)
}

report(
  'exited',
  `code=${exited.code} signal=${exited.signal} after less than ${GRACE_MS}ms${
    output.trim() === '' ? ' — and it wrote nothing at all' : ''
  }`,
)
rmSync(launch.dataDir, { recursive: true, force: true })
process.exit(1)
