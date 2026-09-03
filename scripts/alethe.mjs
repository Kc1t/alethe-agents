#!/usr/bin/env node
/**
 * `alethe` — the development screen.
 *
 * One full-screen application, driven by the keyboard. There are deliberately no subcommands: the
 * screen is the interface, and everything it can do is reachable from it.
 *
 * The parts worth knowing about live elsewhere on purpose. `tui/flow/parse.mjs` turns the decision
 * log into gestures and detects the steps that are missing — the only piece with a real chance of
 * being wrong, and the only one with tests. `tui/actions/*` start processes and read ports without
 * knowing a screen exists.
 */
import { execFile } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'

import { render } from 'ink'
import React from 'react'

import { App } from './tui/app.mjs'
import { defaultLogPath } from './tui/flow/reader.mjs'

const run = promisify(execFile)
const REPO_ROOT = path.resolve(import.meta.dirname, '..')

async function currentBranch() {
  try {
    const { stdout } = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: REPO_ROOT })
    return stdout.trim()
  } catch {
    // Not a git checkout, or git is absent. The screen works fine without the branch name.
    return null
  }
}

// The screen is keyboard-driven, which needs raw mode. Piped or redirected, ink would throw
// "Raw mode is not supported" from inside a hook, surfacing as a React error rather than as the
// plain fact that this is not a terminal.
if (!process.stdin.isTTY || !process.stdout.isTTY) {
  process.stderr.write('alethe: esta tela precisa de um terminal interativo (stdin/stdout TTY)\n')
  process.exit(1)
}

const logPath = defaultLogPath()
if (logPath === null) {
  process.stderr.write(
    'alethe: não foi possível resolver o diretório de dados local desta plataforma\n',
  )
  process.exit(1)
}

const branch = await currentBranch()

/**
 * The alternate screen buffer.
 *
 * `?1049h` switches to a second, empty buffer and `?1049l` switches back — so the screen owns the
 * whole terminal while it runs and the shell's scrollback is exactly as it was on exit, rather than
 * being left with a dead layout stamped into it. `?25l`/`?25h` hides the cursor, which otherwise
 * blinks in whatever cell was drawn last.
 *
 * Restored on every exit path, including a signal: leaving a terminal stuck in the alternate buffer
 * with no cursor is the kind of mess a tool has no business leaving behind.
 */
const enterFullScreen = () => process.stdout.write('[?1049h[?25l')
const leaveFullScreen = () => process.stdout.write('[?25h[?1049l')

enterFullScreen()
let restored = false
const restore = () => {
  if (restored) return
  restored = true
  leaveFullScreen()
}
process.on('exit', restore)
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    restore()
    process.exit(0)
  })
}

const app = render(React.createElement(App, { branch, logPath }))
try {
  await app.waitUntilExit()
} finally {
  restore()
}
