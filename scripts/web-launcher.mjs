import { spawn } from 'node:child_process'

import { findFreePort } from './dev-instance.mjs'
import { CORE_PORT, probeCore } from './web-launcher-lib.mjs'

const WEB_UI_PORT = 1424

const startedAt = performance.now()
const children = new Set()
let ownsCore = false
let stopping = false

const elapsed = () => `${Math.round(performance.now() - startedAt)}ms`
const milestone = (message) => process.stdout.write(`[Alethe Web ${elapsed()}] ${message}\n`)

function launch(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    ...options,
  })
  children.add(child)
  child.once('exit', (code, signal) => {
    children.delete(child)
    if (!stopping && code !== 0) {
      process.stderr.write(`${command} exited unexpectedly (${signal ?? code})\n`)
      void shutdown(code ?? 1)
    }
  })
  return child
}

async function shutdown(exitCode = 0) {
  if (stopping) return
  stopping = true
  for (const child of children) child.kill('SIGTERM')
  if (ownsCore) milestone('Stopping the standalone Core owned by this launcher')
  setTimeout(() => process.exit(exitCode), 250).unref()
}

async function waitForCore(deadlineMs = 120_000) {
  const deadline = Date.now() + deadlineMs
  while (Date.now() < deadline) {
    const result = await probeCore({ timeoutMs: 750 })
    if (result.status === 'compatible') return result
    if (result.status === 'incompatible') throw new Error(result.reason)
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('Alethe Core did not become ready within 120 seconds')
}

async function main() {
  const initial = await probeCore()
  if (process.argv.includes('--diagnose')) {
    process.stdout.write(`${JSON.stringify(initial, null, 2)}\n`)
    process.exitCode = initial.status === 'compatible' ? 0 : 1
    return
  }

  if (initial.status === 'incompatible') throw new Error(initial.reason)
  if (initial.status === 'compatible') {
    milestone(
      `Compatible ${initial.runtime.mode} Core found on port ${CORE_PORT} (${initial.runtime.instanceId})`,
    )
  } else {
    milestone('No Core found; starting the standalone Core')
    ownsCore = true
    launch('cargo', ['run', '--manifest-path', 'src-tauri/Cargo.toml', '--bin', 'alethe-server'])
    const ready = await waitForCore()
    milestone(`Standalone Core ready (${ready.runtime.instanceId})`)
  }

  // 1424 was hardcoded and never checked. `strictPort` in `vite.config.ts` means Vite refuses to
  // drift to another port, so a taken 1424 killed the launcher instead of moving over — and the
  // URL was printed before Vite had bound anything, so it could name a port nothing was serving.
  const uiPort = await findFreePort(WEB_UI_PORT, 20)
  if (uiPort !== WEB_UI_PORT) {
    milestone(`Port ${WEB_UI_PORT} is taken; using ${uiPort} for the Web UI`)
  }
  milestone(`Starting the Web UI on http://127.0.0.1:${uiPort}`)
  launch('npx', ['vite', '--port', String(uiPort)])
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => void shutdown(0))
}

main().catch((error) => {
  process.stderr.write(`[Alethe Web] ${error instanceof Error ? error.message : String(error)}\n`)
  void shutdown(1)
})
