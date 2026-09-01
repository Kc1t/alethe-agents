#!/usr/bin/env node
// Runs `tauri dev` isolated per checkout, so a second `npm run app` started
// from another worktree (this repo's own multi-agent worktrees, or any other
// clone) never collides with an instance already running elsewhere.
//
// Two things are scoped per checkout path:
// - The Tauri app identifier, but ONLY for the worktrees this repo manages
//   under `.alethe/worktrees/`. The single-instance guard (see `lib.rs`) is
//   keyed by identifier, not by port or data root — two dev instances with
//   the SAME identifier get treated as "one already running" and the second
//   one is silently focused/closed, however free the ports are. The primary
//   checkout deliberately keeps the plain identifier: Tauri derives the data
//   root from it, so suffixing it there would move an existing install onto
//   an empty data root and strand the profile and chat history.
// - The Vite dev port, for every checkout: `tauri.conf.json`'s `devUrl` must
//   point at whatever port Vite actually bound, so both are derived together
//   here instead of Vite guessing a fallback port on its own. The port is
//   just a socket, so scoping it strands nothing.
//
// The mapping from checkout path to identifier/port is a stable hash, so the
// same worktree always reopens onto its own previous data and window — this
// is deliberately NOT random per launch.

import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtemp, realpath, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const BASE_PORT = 1422
const PORT_SCAN_RANGE = 200
// Kept in sync with the identifier `npm run web` pins explicitly, so both
// entry points resolve to the same Tauri data root for the same checkout.
const BASE_IDENTIFIER = 'com.kc1t.alethe.dev'

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
 * Locates the `.alethe/` directory when this checkout is one of the worktrees
 * this repo manages under `.alethe/worktrees/<name>`, or `null` for anything
 * else (the primary checkout, or a plain manual clone).
 */
async function managedWorktreeAletheDir() {
  const canonical = await realpath(REPO_ROOT).catch(() => REPO_ROOT)
  const segments = canonical.split(path.sep)
  const aletheIndex = segments.lastIndexOf('.alethe')
  if (aletheIndex === -1 || segments[aletheIndex + 1] !== 'worktrees') return null
  return path.join(...segments.slice(0, aletheIndex + 1))
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
  const aletheDir = await managedWorktreeAletheDir()
  return aletheDir === null ? null : path.join(aletheDir, 'cargo-target')
}

async function main() {
  // An explicit override always wins — useful for CI or a deliberately fixed
  // dev setup — and skips the hash derivation entirely.
  const explicitIdentifier = process.env.ALETHE_APP_IDENTIFIER?.trim()
  const explicitPort = process.env.ALETHE_DEV_PORT?.trim()

  const fingerprint = await checkoutFingerprint()
  // Only the spawned worktrees get a per-checkout identifier. The primary
  // checkout keeps the plain `com.kc1t.alethe.dev` one, because Tauri derives
  // the app's data root from the identifier: suffixing it there silently moved
  // an existing install onto a brand new, empty data root, stranding the
  // profile, contacts and chat history in the old one and dropping the app
  // back into first-run onboarding (observed live). It also split `npm run
  // app` away from `npm run web`, which pins the plain identifier explicitly.
  // Worktrees have no such history to strand — they are created empty — so
  // they still get isolation, which is what this whole mechanism was for.
  const isManagedWorktree = (await managedWorktreeAletheDir()) !== null
  const identifier =
    explicitIdentifier ||
    (isManagedWorktree ? `com.kc1t.alethe.dev.${fingerprint}` : BASE_IDENTIFIER)
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

  // `--config` also accepts a path to a JSON file, not just an inline JSON
  // string — used here instead of passing the string directly, because on
  // Windows `spawn(..., { shell: true })` routes through cmd.exe, which
  // mangles the embedded double quotes of an inline JSON argument (observed
  // live: `{"productName":...}` arrived as `{productName:...}`, invalid
  // JSON). A file path has no such quoting problem.
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'alethe-dev-config-'))
  const configPath = path.join(configDir, 'tauri.dev-instance.conf.json')
  await writeFile(configPath, configOverride, 'utf8')

  const child = spawn('tauri', ['dev', '--config', configPath], {
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
