#!/usr/bin/env node
// Runs `tauri dev` isolated per checkout, so a second `npm run app` started
// from another worktree (this repo's own multi-agent worktrees, or any other
// clone) never collides with an instance already running elsewhere.
//
// Two things are scoped per checkout path:
// - The Tauri app identifier: the single-instance guard (see `lib.rs`) is
//   keyed by identifier, not by port or data root — two dev instances with
//   the SAME identifier get treated as "one already running" and the second
//   one is silently focused/closed, however free the ports are.
// - The Vite dev port: `tauri.conf.json`'s `devUrl` must point at whatever
//   port Vite actually bound, so both are derived together here instead of
//   Vite guessing a fallback port on its own.
//
// The mapping from checkout path to identifier/port is a stable hash, so the
// same worktree always reopens onto its own previous data and window — this
// is deliberately NOT random per launch.

import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { realpath } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const BASE_PORT = 1422
const PORT_SCAN_RANGE = 200

function isPortFree(port) {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.listen({ host: '127.0.0.1', port }, () => {
      server.close(() => resolve(true))
    })
  })
}

async function findFreePort(preferred) {
  for (let port = preferred; port < preferred + PORT_SCAN_RANGE; port += 1) {
    if (await isPortFree(port)) return port
  }
  throw new Error(`No free port found near ${preferred}`)
}

async function checkoutFingerprint() {
  const canonical = await realpath(REPO_ROOT).catch(() => REPO_ROOT)
  const normalized = process.platform === 'win32' ? canonical.toLowerCase() : canonical
  return createHash('sha256').update(normalized).digest('hex').slice(0, 8)
}

/**
 * A fresh worktree under `.alethe/worktrees/<name>` gets its own `target/` by
 * default, so opening one means recompiling every dependency from scratch —
 * minutes of Rust build time and gigabytes on disk, per worktree. Every
 * worktree spawned by the same Alethe checkout shares the same Cargo.lock,
 * so they can safely share one `target/` sitting next to `worktrees/`
 * instead: Cargo fingerprints artifacts by source hash, so switching branches
 * just recompiles what actually changed, and Cargo's own lock on the target
 * dir makes two builds running at once (two worktrees dev'ing in parallel)
 * queue safely rather than race.
 *
 * Returns `null` for a checkout that isn't one of these managed worktrees
 * (e.g. a plain manual clone) — those keep Cargo's normal per-checkout
 * `target/`, since there's no sibling `worktrees/` directory to share.
 */
async function sharedCargoTargetDir() {
  const canonical = await realpath(REPO_ROOT).catch(() => REPO_ROOT)
  const segments = canonical.split(path.sep)
  const worktreesIndex = segments.lastIndexOf('.alethe')
  if (worktreesIndex === -1 || segments[worktreesIndex + 1] !== 'worktrees') return null
  return path.join(...segments.slice(0, worktreesIndex + 1), 'cargo-target')
}

async function main() {
  // An explicit override always wins — useful for CI or a deliberately fixed
  // dev setup — and skips the hash derivation entirely.
  const explicitIdentifier = process.env.ALETHE_APP_IDENTIFIER?.trim()
  const explicitPort = process.env.ALETHE_DEV_PORT?.trim()

  const fingerprint = await checkoutFingerprint()
  const identifier = explicitIdentifier || `com.kc1t.alethe.dev.${fingerprint}`
  // Spreads each checkout's preferred port across the scan range instead of
  // every worktree starting its search at the same 1422 and piling up on
  // whichever one wins the race.
  const preferredPort = explicitPort
    ? Number(explicitPort)
    : BASE_PORT + (parseInt(fingerprint.slice(0, 4), 16) % PORT_SCAN_RANGE)
  const port = explicitPort ? preferredPort : await findFreePort(preferredPort)

  const worktreeName = path.basename(REPO_ROOT)
  const configOverride = JSON.stringify({
    productName: `Alethe Dev (${worktreeName})`,
    identifier,
    build: { devUrl: `http://localhost:${port}` },
  })

  const cargoTargetDir = process.env.CARGO_TARGET_DIR || (await sharedCargoTargetDir())

  console.log(`[dev-instance] checkout: ${REPO_ROOT}`)
  console.log(`[dev-instance] identifier: ${identifier}`)
  console.log(`[dev-instance] dev port: ${port}`)
  if (cargoTargetDir) console.log(`[dev-instance] shared cargo target: ${cargoTargetDir}`)

  const child = spawn('tauri', ['dev', '--config', configOverride], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ALETHE_DEV_PORT: String(port),
      ALETHE_APP_IDENTIFIER: identifier,
      VITE_ALETHE_APP_IDENTIFIER: identifier,
      ...(cargoTargetDir ? { CARGO_TARGET_DIR: cargoTargetDir } : {}),
    },
  })

  child.on('exit', (code) => process.exit(code ?? 0))
}

// Only runs when executed directly (`npm run app`), never on import — lets
// the derivation helpers above be unit-tested without launching `tauri dev`.
if (path.resolve(process.argv[1] ?? '') === path.resolve(import.meta.dirname, 'dev-instance.mjs')) {
  main().catch((error) => {
    console.error('[dev-instance] failed to start:', error)
    process.exit(1)
  })
}
