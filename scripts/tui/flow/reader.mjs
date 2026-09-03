/**
 * Follows `alethe.jsonl` while the app writes it.
 *
 * Reads only what has been appended since the last poll, so a session that has been running for
 * hours does not re-read a 30 MB file every second. If the file shrinks — a rotation, or a fresh
 * profile — it starts over rather than reading from an offset that no longer means anything.
 *
 * Locating the file has to work before the app has ever run: the whole point of the flow panel is
 * to be watching when the interesting launch happens, so an absent file is a normal state, not an
 * error.
 */
import { open, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const FILE_NAME = 'alethe.jsonl'
const DEFAULT_IDENTIFIER = 'com.kc1t.alethe.dev'

/**
 * Where the desktop app writes its log, derived the same way the Rust side derives it
 * (`app_local_data_dir()/logs`). Honours `ALETHE_APP_IDENTIFIER` so a worktree with its own
 * identifier is followed correctly rather than silently showing the primary checkout's stream.
 */
export function defaultLogPath(env = process.env) {
  const identifier = env.ALETHE_APP_IDENTIFIER?.trim() || DEFAULT_IDENTIFIER
  const base =
    process.platform === 'win32'
      ? env.LOCALAPPDATA
      : process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library', 'Application Support')
        : env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share')
  if (!base) return null
  return path.join(base, identifier, 'logs', FILE_NAME)
}

/** Follows one file, handing new text to `onText` on each poll. */
export function followFile(filePath, onText, { intervalMs = 700 } = {}) {
  let offset = 0
  let stopped = false
  let primed = false

  const tick = async () => {
    if (stopped) return
    let size
    try {
      size = (await stat(filePath)).size
    } catch {
      // Not there yet. The app may simply not have started — that is the state this panel is most
      // often opened in, so it is not reported as a failure.
      offset = 0
      primed = false
      return
    }
    // A shrunk file was rotated or replaced; an old offset would slice mid-record.
    if (size < offset) offset = 0
    if (!primed) {
      // First sight of the file: show the tail rather than replaying the whole history, which for a
      // long-lived profile is tens of megabytes of decisions from days ago.
      offset = Math.max(0, size - 256 * 1024)
      primed = true
    }
    if (size === offset) return

    const handle = await open(filePath, 'r').catch(() => null)
    if (!handle) return
    try {
      const length = size - offset
      const buffer = Buffer.alloc(length)
      await handle.read(buffer, 0, length, offset)
      offset = size
      onText(buffer.toString('utf8'))
    } finally {
      await handle.close().catch(() => {
        // The handle is going away with the process anyway; a failure to close changes nothing.
      })
    }
  }

  const timer = setInterval(() => {
    void tick()
  }, intervalMs)
  void tick()

  return () => {
    stopped = true
    clearInterval(timer)
  }
}
