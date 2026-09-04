#!/usr/bin/env node
/**
 * Runs the given commands one after another, stopping at the first failure.
 *
 * This exists because `npm` runs scripts through whatever `script-shell` is configured, and on
 * Windows that is often `powershell.exe` — Windows PowerShell 5.1, which has no `&&` operator. A
 * script written as `"tsc && vite build"` then dies on a parser error before `tsc` ever starts, so
 * `npm test` and `npm run build` fail on a machine where the code itself is fine. Chaining here
 * instead of in the shell makes the scripts behave the same under cmd, PowerShell 5.1, pwsh and sh.
 *
 * Usage: node scripts/run-seq.mjs "tsc" "vite build"
 */
import { spawnSync } from 'node:child_process'

const steps = process.argv.slice(2)

if (steps.length === 0) {
  console.error('run-seq: no commands given')
  process.exit(64)
}

for (const step of steps) {
  // Each step is a single command with no shell operators, so any shell can run it; the shell is
  // still needed to resolve `node_modules/.bin` entries, which npm has already put on PATH.
  const result = spawnSync(step, { stdio: 'inherit', shell: true })
  if (result.error) {
    console.error(`run-seq: could not start \`${step}\`: ${result.error.message}`)
    process.exit(1)
  }
  if (result.status !== 0) {
    // A step killed by a signal reports a null status; treat that as a failure too rather than
    // letting the chain continue as if it had passed.
    process.exit(result.status ?? 1)
  }
}
