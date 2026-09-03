/**
 * Who holds a port, and killing them safely.
 *
 * Knowing that `1594` is taken is not useful; knowing it is held by a `node.exe` started from
 * `.alethe/worktrees/cl-AnpyBE` is. The process name alone cannot tell two dev servers apart, so
 * this reads the full command line — that is what makes the decision to kill an informed one
 * instead of a guess.
 *
 * Nothing here knows the TUI exists.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { isPortFree } from '../../dev-instance.mjs'

const run = promisify(execFile)

/** The ports this project uses, and what each one is for. */
export const KNOWN_PORTS = [
  { port: 1422, label: 'vite (dev padrão)' },
  { port: 1423, label: 'alethe core' },
  { port: 1424, label: 'vite (web)' },
]

/** Process names a dev port is plausibly held by. Anything else is refused without `force`. */
const KILLABLE = ['node', 'vite', 'alethe', 'cargo', 'esbuild']

/** PIDs listening on `port`, from `netstat`. */
async function listenersOn(port) {
  const pids = new Set()
  try {
    // No `-p TCP`: on Windows that filters to IPv4 only, and IPv6 listeners are reported under the
    // separate `TCPv6` protocol. Passing it made this tool blind to exactly the case that caused
    // the port bug in the first place — verified live, with a listener on `[::1]:1594` that
    // `netstat -ano -p TCP` did not list at all.
    const { stdout } = await run('netstat', ['-ano'])
    for (const line of stdout.split('\n')) {
      if (!line.includes('LISTENING')) continue
      // Matches `127.0.0.1:1594` and `[::1]:1594` alike.
      const match = line.match(/^\s*TCPv?6?\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)/i)
      if (match && Number(match[2]) === port) pids.add(Number(match[3]))
    }
  } catch {
    // No netstat (or a locked-down machine): the caller still gets the free/taken answer below.
    return []
  }
  return [...pids]
}

/** Name and command line for `pid`, or `null` when it cannot be read. */
async function describe(pid) {
  try {
    const { stdout } = await run('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | Select-Object -Property Name,CommandLine | ConvertTo-Json -Compress`,
    ])
    const parsed = JSON.parse(stdout.trim() || 'null')
    if (!parsed) return null
    return { name: parsed.Name ?? null, commandLine: parsed.CommandLine ?? null }
  } catch {
    return null
  }
}

/** Everything worth showing about one port. */
export async function inspectPort(port) {
  const free = await isPortFree(port)
  const pids = free ? [] : await listenersOn(port)
  const holders = []
  for (const pid of pids) {
    const info = await describe(pid)
    holders.push({ pid, name: info?.name ?? null, commandLine: info?.commandLine ?? null })
  }
  return { port, free, holders }
}

/** The project's ports, plus any extra the caller cares about. */
export async function inspectPorts(extra = []) {
  const ports = [...KNOWN_PORTS.map((entry) => entry.port), ...extra]
  const unique = [...new Set(ports)].sort((a, b) => a - b)
  const label = new Map(KNOWN_PORTS.map((entry) => [entry.port, entry.label]))
  const results = []
  for (const port of unique) {
    const result = await inspectPort(port)
    results.push({ ...result, label: label.get(port) ?? null })
  }
  return results
}

/** Whether a holder looks like a dev-server process this project is allowed to kill. */
export function isKillable(holder) {
  const name = (holder.name ?? '').toLowerCase()
  return KILLABLE.some((allowed) => name.startsWith(allowed))
}

/**
 * Kills the process tree rooted at `pid`.
 *
 * The tree, not the PID: `npm run app` sits above `tauri`, which sits above `cargo` and the app
 * itself, and killing only the top leaves the port held by an orphan. Refuses anything that does
 * not look like a dev-server process unless `force` is set, because a wrong PID here ends a
 * process the user cared about.
 */
export async function killTree(pid, { force = false } = {}) {
  const info = await describe(pid)
  if (!force && !isKillable({ name: info?.name ?? null })) {
    return {
      pid,
      killed: false,
      reason: `recusado: ${info?.name ?? 'processo desconhecido'} não parece um servidor de desenvolvimento`,
    }
  }
  try {
    await run('taskkill', ['/F', '/T', '/PID', String(pid)])
    return { pid, killed: true, reason: null }
  } catch (cause) {
    // taskkill exits non-zero when the pid is already gone, which is a success for our purposes.
    const text = String(cause?.stderr ?? cause?.message ?? cause)
    if (/not found|não foi encontrado/i.test(text)) {
      return { pid, killed: true, reason: 'o processo já havia saído' }
    }
    return { pid, killed: false, reason: text.trim() }
  }
}
