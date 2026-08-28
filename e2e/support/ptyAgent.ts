/**
 * Thin bridge to the app's real e2e hook (`window.__ALETHE_E2E__`,
 * see `src/lib/e2eHooks.ts`) — called via WebDriver's STANDARD
 * `browser.execute()` (not `browser.tauri.execute()`).
 *
 * APPROACH CHANGE CONFIRMED LIVE IN THIS SESSION: `browser.tauri
 * .execute()` (the `@wdio/tauri-service`'s Tauri-specific bridge) never
 * works in this environment — every `tauri.core.invoke(...)` threw
 * "Tauri core.invoke not available after 5s timeout", reproduced in an
 * isolated and deterministic way. The obvious alternative (hitting the backend
 * directly via HTTP `fetch()` from Node, bypassing the webview) was
 * DELIBERATELY REJECTED: that would only test the backend, never the FRONTEND —
 * and it's exactly the frontend where real bugs have already shown up in this session
 * (Part 1: the validation gate lying; terminal sync
 * fixes). The standard `browser.execute()` WAS confirmed to work (it reaches
 * `window.location`, `window.__ALETHE_E2E__` etc. on the real page) — so
 * each helper here calls, via a literal function (WebdriverIO's standard
 * serialization, no manual string reconstruction), the function exposed by
 * the hook — which in turn calls the REAL function from `src/lib/api/*` that the
 * actual UI uses (the same `isTauriEnv()`/`canUseSharedCoreTransport()`
 * decision as always).
 */
type AletheE2EWindow = {
  __ALETHE_E2E__?: {
    pty: {
      spawn: (cwd: string, command?: string, cols?: number, rows?: number) => Promise<string>
      write: (id: string, data: string) => Promise<void>
      readScrollback: (id: string, maxBytes?: number) => Promise<string>
      exists: (id: string) => Promise<boolean>
      getSize: (id: string) => Promise<{ cols: number; rows: number }>
      resize: (id: string, cols: number, rows: number) => Promise<void>
      kill: (id: string) => Promise<void>
    }
  }
}

export const DEFAULT_PROFILE_ID = 'default'

export async function spawnPty(opts: {
  cwd: string
  command?: string
  cols?: number
  rows?: number
  profileId?: string
}): Promise<string> {
  const result = await invokeTauri<{ id: string }>('spawn_pty', {
    cwd: opts.cwd,
    command: opts.command,
    cols: opts.cols ?? 80,
    rows: opts.rows ?? 24,
    profileId: opts.profileId ?? DEFAULT_PROFILE_ID,
  })
  return result.id
}

export async function writePtyData(
  id: string,
  data: string,
  profileId = DEFAULT_PROFILE_ID,
): Promise<void> {
  await invokeTauri('write_pty', { id, data, profileId })
}

/** Sends a command line (adds the right Enter for the OS). */
export async function sendPtyLine(
  id: string,
  line: string,
  profileId = DEFAULT_PROFILE_ID,
): Promise<void> {
  await writePtyData(id, `${line}\r`, profileId)
}

export async function readPtyScrollback(
  id: string,
  maxBytesOrProfile?: number | string,
  profileId?: string,
): Promise<string> {
  const maxBytes = typeof maxBytesOrProfile === 'number' ? maxBytesOrProfile : 65536
  const profile =
    typeof maxBytesOrProfile === 'string' ? maxBytesOrProfile : (profileId ?? DEFAULT_PROFILE_ID)
  const result = await invokeTauri<string>('attach_pty', { id, maxBytes, profileId: profile })
  return result ?? ''
}

export async function ptyStillExists(id: string, profileId = DEFAULT_PROFILE_ID): Promise<boolean> {
  return invokeTauri<boolean>('pty_exists', { id, profileId })
}

export async function invokeTauri<T = unknown>(
  cmd: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  await browser.waitUntil(
    async () => {
      return browser.execute(() => {
        const tauri = window as unknown as {
          __TAURI_INTERNALS__?: { invoke: unknown }
          __TAURI__?: { core?: { invoke: unknown } }
        }
        return Boolean(tauri.__TAURI_INTERNALS__?.invoke ?? tauri.__TAURI__?.core?.invoke)
      })
    },
    { timeout: 15_000, interval: 300, timeoutMsg: 'Tauri invoke was not ready within 15s' },
  )
  const result = await browser.execute(
    (command, invokeArgs) => {
      const tauri = window as unknown as {
        __TAURI_INTERNALS__?: { invoke: (c: string, a?: unknown) => Promise<unknown> }
        __TAURI__?: { core?: { invoke: (c: string, a?: unknown) => Promise<unknown> } }
      }
      const invokeFn = tauri.__TAURI_INTERNALS__?.invoke ?? tauri.__TAURI__?.core?.invoke
      if (!invokeFn) throw new Error('Tauri invoke function not found on window')
      return invokeFn(command, invokeArgs)
    },
    cmd,
    args,
  )
  return result as unknown as T
}

export async function getPtyGridSize(
  id: string,
  profileId = DEFAULT_PROFILE_ID,
): Promise<{ cols: number; rows: number }> {
  return invokeTauri<{ cols: number; rows: number }>('get_pty_size', { id, profileId })
}

export async function resizePty(
  id: string,
  cols: number,
  rows: number,
  profileId = DEFAULT_PROFILE_ID,
): Promise<void> {
  await invokeTauri('resize_pty', { id, cols, rows, profileId })
}

export async function killPty(id: string, profileId = DEFAULT_PROFILE_ID): Promise<void> {
  await invokeTauri('kill_pty', { id, profileId }).catch(() => {})
}

/**
 * `write_pty` returns success as soon as the bytes reach the PTY — that does NOT
 * prove that the process on the other side (an agent CLI still starting up)
 * was ready to interpret that as a real prompt. This is
 * exactly the kind of shallow false positive that motivated this whole suite:
 * the call "works" (no error), but the text gets lost on a
 * loading screen, a splash, or gets misinterpreted by a
 * yes/no dialog still open. Waits for the scrollback to "settle" (stop changing for
 * `stableForMs` in a row) before considering the terminal ready to receive
 * real input — the same principle already used in the real app's resize
 * settle-check (`useXtermSession.ts`), applied here to the CLI's content.
 */
export async function waitForScrollbackStable(
  id: string,
  {
    timeoutMs = 30_000,
    stableForMs = 1200,
    pollMs = 500,
  }: { timeoutMs?: number; stableForMs?: number; pollMs?: number } = {},
): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let lastContent: string | null = null
  let stableSince = 0
  while (Date.now() < deadline) {
    const content = await readPtyScrollback(id).catch(() => '')
    if (content === lastContent && content.trim().length > 0) {
      if (stableSince === 0) stableSince = Date.now()
      if (Date.now() - stableSince >= stableForMs) return content
    } else {
      lastContent = content
      stableSince = 0
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
  throw new Error(`waitForScrollbackStable: PTY ${id} never settled within ${timeoutMs}ms`)
}

/** Trust/permission dialog patterns seen live in this session
 *  (Antigravity: "Do you trust the contents of this project?") — they block
 *  the CLI until someone answers. Deliberately broad heuristic (several
 *  agent CLIs have variations of this same type of prompt on their first
 *  run in a new folder). */
const TRUST_OR_PERMISSION_PATTERNS = [
  /do you trust/i,
  /trust the contents/i,
  /trust this (folder|project|directory)/i,
  /requires permission/i,
  /allow .* to (access|read|edit)/i,
]

/**
 * Waits for the agent CLI to finish starting up and, if it's stuck on a
 * trust/permission dialog, answers it automatically (Enter on the
 * default, usually "Yes") before returning control — only AFTER this
 * is it safe to send a real work prompt. Without this, the first
 * real prompt arrived too early on this kind of screen and was swallowed with
 * no error reported at all.
 */
export async function ensureAgentReady(
  id: string,
  opts: { timeoutMs?: number } = {},
): Promise<void> {
  let content = await waitForScrollbackStable(id, opts)
  if (TRUST_OR_PERMISSION_PATTERNS.some((pattern) => pattern.test(content))) {
    await sendPtyLine(id, '')
    content = await waitForScrollbackStable(id, opts)
    // Still stuck on a dialog after an Enter — tries an explicit "y"
    // (a common pattern when the default isn't the affirmative option).
    if (TRUST_OR_PERMISSION_PATTERNS.some((pattern) => pattern.test(content))) {
      await sendPtyLine(id, 'y')
      await waitForScrollbackStable(id, opts)
    }
  }
}

/**
 * Waits until `predicate()` resolves with a truthy value, or throws on
 * timeout. Used instead of fixed waits because how long a real agent
 * (OpenCode) takes to process a prompt varies a lot (CLI cold start, model
 * latency) — a fixed sleep would be either too slow in the common case or flaky in the
 * slow case.
 */
export async function waitUntil<T>(
  predicate: () => Promise<T | null | undefined | false>,
  { timeoutMs = 30_000, intervalMs = 1000 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown = null
  while (Date.now() < deadline) {
    try {
      const value = await predicate()
      if (value) return value
    } catch (err) {
      lastError = err
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new Error(
    `waitUntil: timeout after ${timeoutMs}ms${lastError ? ` (last error: ${String(lastError)})` : ''}`,
  )
}
