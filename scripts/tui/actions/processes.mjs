/**
 * Starting and stopping the things the screen can launch.
 *
 * Each action returns a handle the caller can watch and stop. Nothing here knows the TUI exists, so
 * the same functions are what a test drives.
 */
import { spawn } from 'node:child_process'
import path from 'node:path'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..')

/** Everything the screen offers, in the order it is shown. */
export const COMMANDS = [
  {
    id: 'dev',
    label: 'dev',
    hint: 'tauri dev, com HMR',
    start: () => launch('dev', 'node', ['scripts/dev-instance.mjs']),
  },
  {
    id: 'debug',
    label: 'dev (debug)',
    hint: 'idem, com logs em debug',
    // Not merely an environment variable: this is the run whose decision records the flow panel
    // below is meant to read, so the filter is opened up and the console mirror lowered together.
    start: () =>
      launch('debug', 'node', ['scripts/dev-instance.mjs'], {
        ALETHE_LOG: 'debug',
        ALETHE_TRACE: 'debug',
      }),
  },
  {
    id: 'web',
    label: 'web',
    hint: 'core + UI no navegador',
    start: () => launch('web', 'node', ['scripts/web-launcher.mjs']),
  },
]

/**
 * Spawns a long-running child, capturing its output as lines.
 *
 * `shell: true` on Windows because these resolve through `node_modules/.bin`; the arguments are all
 * literals defined above, never anything typed into the screen.
 */
function launch(id, command, args, env = {}) {
  const child = spawn(command, args, {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  })

  const handle = {
    id,
    pid: child.pid ?? null,
    child,
    lines: [],
    exitCode: null,
    startedAt: Date.now(),
  }

  const absorb = (chunk) => {
    for (const line of String(chunk).split('\n')) {
      if (line.trim() === '') continue
      handle.lines.push(line.replace(/\r$/, ''))
    }
    // Bounded: a dev server left running all day would otherwise grow without limit, and only the
    // recent output is ever shown.
    if (handle.lines.length > 500) handle.lines.splice(0, handle.lines.length - 500)
  }
  child.stdout?.on('data', absorb)
  child.stderr?.on('data', absorb)
  child.on('exit', (code) => {
    handle.exitCode = code ?? 1
  })
  child.on('error', (cause) => {
    absorb(`[alethe] não foi possível iniciar: ${cause.message}`)
    handle.exitCode = 1
  })

  return handle
}

/**
 * Stops a handle, killing the whole tree.
 *
 * `npm run app` sits above `tauri`, which sits above `cargo` and the app itself — killing only the
 * top leaves orphans holding the port, which is the failure this project already spent an afternoon
 * on.
 */
export function stop(handle) {
  if (!handle || handle.exitCode !== null || handle.pid === null) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/F', '/T', '/PID', String(handle.pid)], { stdio: 'ignore' })
  } else {
    try {
      process.kill(-handle.pid, 'SIGTERM')
    } catch {
      try {
        handle.child.kill('SIGTERM')
      } catch {
        // Already gone; nothing to stop.
      }
    }
  }
}
