#!/usr/bin/env node
/**
 * Runs a command, showing its output live while also appending it to a log file.
 *
 * Replaces `mkdir -p logs && cmd 2>&1 | tee logs/backend.log`, which needed three things Windows
 * PowerShell does not provide the same way: `&&`, `mkdir -p`, and `tee`. The log directory is
 * created here, and both stdout and stderr are duplicated to the file, so the transcript matches
 * what the terminal showed.
 *
 * Usage: node scripts/run-tee.mjs <logFile> <command> [args...]
 */
import { spawn } from 'node:child_process'
import { createWriteStream, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const [logFile, command, ...args] = process.argv.slice(2)

if (!logFile || !command) {
  console.error('run-tee: usage: node scripts/run-tee.mjs <logFile> <command> [args...]')
  process.exit(64)
}

mkdirSync(dirname(logFile), { recursive: true })
const log = createWriteStream(logFile, { flags: 'w' })

const child = spawn(command, args, { stdio: ['inherit', 'pipe', 'pipe'], shell: true })
child.stdout.on('data', (chunk) => {
  process.stdout.write(chunk)
  log.write(chunk)
})
child.stderr.on('data', (chunk) => {
  process.stderr.write(chunk)
  log.write(chunk)
})

child.on('error', (error) => {
  console.error(`run-tee: could not start \`${command}\`: ${error.message}`)
  process.exit(1)
})
child.on('close', (code) => {
  log.end()
  process.exit(code ?? 1)
})
