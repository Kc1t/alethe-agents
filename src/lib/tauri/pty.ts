// Compatibility entry point for older direct imports.
//
// PTY transport, profile ownership, and browser/Tauri routing live in the
// shared API module so no caller can bypass the active ownership contract.
import { invoke } from '@tauri-apps/api/core'

export * from '../api/pty'

// TODO: not yet mirrored into `lib/api/pty` (no web/HTTP equivalent wired up
// yet) — desktop-only for now, matches the pre-migration behavior.
export async function clearPtyScrollback(id: string): Promise<void> {
  await invoke('clear_pty_scrollback', { id })
}
